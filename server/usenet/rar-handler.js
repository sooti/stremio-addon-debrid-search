/**
 * RAR archive handler for Usenet downloads
 * Ensures first RAR file is complete before streaming starts
 */

import SABnzbd from '../../lib/sabnzbd.js';
import fs from 'fs';
import path from 'path';

/**
 * Check if download contains RAR files
 * @param {Array} files - Array of file objects from SABnzbd
 * @returns {object|null} First RAR file info or null
 */
export function detectRarArchive(files) {
    if (!files || !Array.isArray(files)) {
        return null;
    }

    // Look for the first RAR file (.rar or .r00 or .part01.rar)
    const rarPatterns = [
        /\.part0*1\.rar$/i,     // .part01.rar, .part001.rar
        /\.rar$/i,               // .rar (single or first of multi-part)
        /\.r0+$/i                // .r00
    ];

    for (const file of files) {
        const filename = file.filename || file.name || '';

        for (const pattern of rarPatterns) {
            if (pattern.test(filename)) {
                console.log(`[RAR-HANDLER] Detected first RAR file: ${filename}`);
                return {
                    filename: filename,
                    bytes: file.bytes || 0,
                    totalBytes: file.mb ? parseFloat(file.mb) * 1024 * 1024 : 0,
                    nzfId: file.nzf_id || null
                };
            }
        }
    }

    return null;
}

/**
 * Check if first RAR file is complete by checking filesystem
 * @param {string} downloadPath - Path to incomplete download folder
 * @param {string} rarFilename - RAR filename to check
 * @returns {Promise<boolean>} True if RAR file exists and seems complete
 */
export async function isFirstRarComplete(downloadPath, rarFilename) {
    try {
        if (!downloadPath || !rarFilename) {
            return false;
        }

        const rarPath = path.join(downloadPath, rarFilename);

        if (!fs.existsSync(rarPath)) {
            console.log(`[RAR-HANDLER] First RAR not found yet: ${rarPath}`);
            return false;
        }

        const stats = fs.statSync(rarPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        // Check if file is at least 1MB (sanity check)
        if (stats.size < 1024 * 1024) {
            console.log(`[RAR-HANDLER] First RAR too small (${fileSizeMB}MB), still downloading...`);
            return false;
        }

        console.log(`[RAR-HANDLER] First RAR file exists: ${rarFilename} (${fileSizeMB}MB)`);
        return true;

    } catch (error) {
        console.error(`[RAR-HANDLER] Error checking RAR file: ${error.message}`);
        return false;
    }
}

/**
 * Wait for first RAR file to complete before starting stream
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID
 * @param {string} downloadPath - Path to incomplete folder
 * @param {number} maxWaitSeconds - Maximum time to wait (default: 120 seconds)
 * @returns {Promise<boolean>} True if RAR is ready, false if timeout or no RAR
 */
export async function waitForFirstRar(sabnzbdUrl, apiKey, nzoId, downloadPath, maxWaitSeconds = 120) {
    console.log('[RAR-HANDLER] Checking for RAR archive...');

    const startTime = Date.now();
    const maxWaitMs = maxWaitSeconds * 1000;
    const checkInterval = 2000; // Check every 2 seconds

    let firstRarInfo = null;
    let lastProgress = -1;

    while (Date.now() - startTime < maxWaitMs) {
        try {
            // Get download status
            const status = await SABnzbd.getDownloadStatus(sabnzbdUrl, apiKey, nzoId);

            if (!status || status.status === 'failed') {
                console.log('[RAR-HANDLER] Download failed or not found');
                return false;
            }

            // If download is complete, RAR is ready
            if (status.status === 'completed') {
                console.log('[RAR-HANDLER] Download completed, RAR ready');
                return true;
            }

            // Detect first RAR file if not already detected
            if (!firstRarInfo && status.files) {
                firstRarInfo = detectRarArchive(status.files);

                if (!firstRarInfo) {
                    console.log('[RAR-HANDLER] No RAR archive detected, direct video file');
                    return true; // Not a RAR, proceed immediately
                }

                console.log(`[RAR-HANDLER] Waiting for first RAR: ${firstRarInfo.filename}`);
            }

            // If we have RAR info, check if it's complete
            if (firstRarInfo) {
                // Use the actual download path from status if available
                const actualPath = status.incompletePath || downloadPath;

                const rarComplete = await isFirstRarComplete(actualPath, firstRarInfo.filename);

                if (rarComplete) {
                    console.log('[RAR-HANDLER] ✓ First RAR file complete, streaming can begin');
                    return true;
                }

                // Log progress
                const progress = status.percentComplete || 0;
                if (progress !== lastProgress) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`[RAR-HANDLER] Waiting for first RAR... Overall: ${progress.toFixed(1)}% (${elapsed}s elapsed)`);
                    lastProgress = progress;
                }
            }

            // Wait before next check
            await new Promise(resolve => setTimeout(resolve, checkInterval));

        } catch (error) {
            console.error(`[RAR-HANDLER] Error checking RAR status: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
    }

    // Timeout
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[RAR-HANDLER] ⚠️  Timeout waiting for first RAR (${elapsed}s)`);

    // If we detected a RAR but it's not ready, return false
    if (firstRarInfo) {
        return false;
    }

    // If no RAR detected at all, assume it's a direct file and allow streaming
    return true;
}

/**
 * Check if download has RAR files based on SABnzbd status
 * @param {object} status - Download status from SABnzbd
 * @returns {boolean} True if RAR archive detected
 */
export function hasRarFiles(status) {
    if (!status || !status.files) {
        return false;
    }

    const rarInfo = detectRarArchive(status.files);
    return rarInfo !== null;
}

/**
 * Calculate minimum download percentage needed for RAR streaming
 * For RAR files, we need at least the first RAR file (usually 5-15% of total)
 * @param {object} status - Download status
 * @param {object} firstRarInfo - First RAR file info
 * @returns {number} Minimum percentage needed
 */
export function calculateRarStreamingThreshold(status, firstRarInfo) {
    if (!firstRarInfo || !status.bytesTotal) {
        return 5; // Default 5% for direct files
    }

    // Calculate what percentage the first RAR represents
    const firstRarBytes = firstRarInfo.totalBytes || 0;
    const totalBytes = status.bytesTotal || 0;

    if (firstRarBytes > 0 && totalBytes > 0) {
        const percentage = (firstRarBytes / totalBytes) * 100;
        // Add 2% buffer for safety
        const threshold = Math.min(percentage + 2, 20); // Cap at 20%
        console.log(`[RAR-HANDLER] First RAR is ${percentage.toFixed(1)}% of total, threshold: ${threshold.toFixed(1)}%`);
        return threshold;
    }

    return 10; // Default 10% if we can't calculate
}

export default {
    detectRarArchive,
    isFirstRarComplete,
    waitForFirstRar,
    hasRarFiles,
    calculateRarStreamingThreshold
};
