/**
 * RAR and 7z archive handler for Usenet downloads
 * Ensures first archive file is complete before streaming starts
 */

import SABnzbd from '../../lib/sabnzbd.js';
import fs from 'fs';
import path from 'path';

/**
 * Check if download contains RAR or 7z files
 * @param {Array} files - Array of file objects from SABnzbd
 * @returns {object|null} First archive file info or null
 */
export function detectArchive(files) {
    if (!files || !Array.isArray(files)) {
        return null;
    }

    // Look for the first archive file
    const archivePatterns = [
        // RAR patterns
        { pattern: /\.part0*1\.rar$/i, type: 'rar', desc: '.part01.rar' },
        { pattern: /\.rar$/i, type: 'rar', desc: '.rar' },
        { pattern: /\.r0+$/i, type: 'rar', desc: '.r00' },
        // 7z patterns
        { pattern: /\.7z\.0*1$/i, type: '7z', desc: '.7z.001' },
        { pattern: /\.7z$/i, type: '7z', desc: '.7z' },
        // ZIP patterns
        { pattern: /\.zip\.0*1$/i, type: 'zip', desc: '.zip.001' },
        { pattern: /\.zip$/i, type: 'zip', desc: '.zip' }
    ];

    for (const file of files) {
        const filename = file.filename || file.name || '';

        for (const { pattern, type, desc } of archivePatterns) {
            if (pattern.test(filename)) {
                console.log(`[ARCHIVE-HANDLER] Detected first ${type.toUpperCase()} file: ${filename}`);
                return {
                    filename: filename,
                    bytes: file.bytes || 0,
                    totalBytes: file.mb ? parseFloat(file.mb) * 1024 * 1024 : 0,
                    nzfId: file.nzf_id || null,
                    type: type
                };
            }
        }
    }

    return null;
}

/**
 * Check if first archive file is complete by checking filesystem
 * @param {string} downloadPath - Path to incomplete download folder
 * @param {string} archiveFilename - Archive filename to check
 * @returns {Promise<boolean>} True if archive file exists and seems complete
 */
export async function isFirstArchiveComplete(downloadPath, archiveFilename) {
    try {
        if (!downloadPath || !archiveFilename) {
            return false;
        }

        const archivePath = path.join(downloadPath, archiveFilename);

        if (!fs.existsSync(archivePath)) {
            console.log(`[ARCHIVE-HANDLER] First archive not found yet: ${archivePath}`);
            return false;
        }

        const stats = fs.statSync(archivePath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        // Check if file is at least 1MB (sanity check)
        if (stats.size < 1024 * 1024) {
            console.log(`[ARCHIVE-HANDLER] First archive too small (${fileSizeMB}MB), still downloading...`);
            return false;
        }

        console.log(`[ARCHIVE-HANDLER] First archive file exists: ${archiveFilename} (${fileSizeMB}MB)`);
        return true;

    } catch (error) {
        console.error(`[ARCHIVE-HANDLER] Error checking archive file: ${error.message}`);
        return false;
    }
}

/**
 * Wait for first archive file to complete before starting stream
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID
 * @param {string} downloadPath - Path to incomplete folder
 * @param {number} maxWaitSeconds - Maximum time to wait (default: 120 seconds)
 * @returns {Promise<boolean>} True if archive is ready, false if timeout or no archive
 */
export async function waitForFirstArchive(sabnzbdUrl, apiKey, nzoId, downloadPath, maxWaitSeconds = 120) {
    console.log('[ARCHIVE-HANDLER] Checking for archive files (RAR/7z/ZIP)...');

    const startTime = Date.now();
    const maxWaitMs = maxWaitSeconds * 1000;
    const checkInterval = 2000; // Check every 2 seconds

    let firstArchiveInfo = null;
    let lastProgress = -1;

    while (Date.now() - startTime < maxWaitMs) {
        try {
            // Get download status
            const status = await SABnzbd.getDownloadStatus(sabnzbdUrl, apiKey, nzoId);

            if (!status || status.status === 'failed') {
                console.log('[ARCHIVE-HANDLER] Download failed or not found');
                return false;
            }

            // If download is complete, archive is ready
            if (status.status === 'completed') {
                console.log('[ARCHIVE-HANDLER] Download completed, archive ready');
                return true;
            }

            // Detect first archive file if not already detected
            if (!firstArchiveInfo && status.files) {
                firstArchiveInfo = detectArchive(status.files);

                if (!firstArchiveInfo) {
                    console.log('[ARCHIVE-HANDLER] No archive detected, direct video file');
                    return true; // Not an archive, proceed immediately
                }

                console.log(`[ARCHIVE-HANDLER] Waiting for first ${firstArchiveInfo.type.toUpperCase()}: ${firstArchiveInfo.filename}`);
            }

            // If we have archive info, check if it's complete
            if (firstArchiveInfo) {
                // Use the actual download path from status if available
                const actualPath = status.incompletePath || downloadPath;

                const archiveComplete = await isFirstArchiveComplete(actualPath, firstArchiveInfo.filename);

                if (archiveComplete) {
                    console.log(`[ARCHIVE-HANDLER] ✓ First ${firstArchiveInfo.type.toUpperCase()} file complete, streaming can begin`);
                    return true;
                }

                // Log progress
                const progress = status.percentComplete || 0;
                if (progress !== lastProgress) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`[ARCHIVE-HANDLER] Waiting for first ${firstArchiveInfo.type.toUpperCase()}... Overall: ${progress.toFixed(1)}% (${elapsed}s elapsed)`);
                    lastProgress = progress;
                }
            }

            // Wait before next check
            await new Promise(resolve => setTimeout(resolve, checkInterval));

        } catch (error) {
            console.error(`[ARCHIVE-HANDLER] Error checking archive status: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
    }

    // Timeout
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ARCHIVE-HANDLER] ⚠️  Timeout waiting for first archive file (${elapsed}s)`);

    // If we detected an archive but it's not ready, return false
    if (firstArchiveInfo) {
        return false;
    }

    // If no archive detected at all, assume it's a direct file and allow streaming
    return true;
}

/**
 * Check if download has archive files based on SABnzbd status
 * @param {object} status - Download status from SABnzbd
 * @returns {boolean} True if archive detected
 */
export function hasArchiveFiles(status) {
    if (!status || !status.files) {
        return false;
    }

    const archiveInfo = detectArchive(status.files);
    return archiveInfo !== null;
}

/**
 * Calculate minimum download percentage needed for archive streaming
 * For archives, we need at least the first file (usually 5-15% of total)
 * @param {object} status - Download status
 * @param {object} firstArchiveInfo - First archive file info
 * @returns {number} Minimum percentage needed
 */
export function calculateArchiveStreamingThreshold(status, firstArchiveInfo) {
    if (!firstArchiveInfo || !status.bytesTotal) {
        return 5; // Default 5% for direct files
    }

    // Calculate what percentage the first archive file represents
    const firstArchiveBytes = firstArchiveInfo.totalBytes || 0;
    const totalBytes = status.bytesTotal || 0;

    if (firstArchiveBytes > 0 && totalBytes > 0) {
        const percentage = (firstArchiveBytes / totalBytes) * 100;
        // Add 2% buffer for safety
        const threshold = Math.min(percentage + 2, 20); // Cap at 20%
        console.log(`[ARCHIVE-HANDLER] First ${firstArchiveInfo.type.toUpperCase()} is ${percentage.toFixed(1)}% of total, threshold: ${threshold.toFixed(1)}%`);
        return threshold;
    }

    return 10; // Default 10% if we can't calculate
}

// Export with legacy names for backward compatibility
export const detectRarArchive = detectArchive;
export const isFirstRarComplete = isFirstArchiveComplete;
export const waitForFirstRar = waitForFirstArchive;
export const hasRarFiles = hasArchiveFiles;
export const calculateRarStreamingThreshold = calculateArchiveStreamingThreshold;

export default {
    detectArchive,
    isFirstArchiveComplete,
    waitForFirstArchive,
    hasArchiveFiles,
    calculateArchiveStreamingThreshold,
    // Legacy exports
    detectRarArchive,
    isFirstRarComplete,
    waitForFirstRar,
    hasRarFiles,
    calculateRarStreamingThreshold
};
