/**
 * Smart seeking handler for partial/incomplete video files
 * Handles range requests intelligently based on download progress
 */

import SABnzbd from '../../lib/sabnzbd.js';

/**
 * Calculate download progress as byte position
 * @param {number} percentComplete - Download percentage (0-100)
 * @param {number} totalSize - Total file size in bytes
 * @returns {number} Downloaded bytes
 */
export function calculateDownloadedBytes(percentComplete, totalSize) {
    return Math.floor((percentComplete / 100) * totalSize);
}

/**
 * Check if a range request can be satisfied based on download progress
 * @param {number} requestedStart - Requested start byte position
 * @param {number} requestedEnd - Requested end byte position
 * @param {number} downloadedBytes - Currently downloaded bytes
 * @param {number} totalSize - Total file size
 * @returns {object} Validation result with status and info
 */
export function validateRangeRequest(requestedStart, requestedEnd, downloadedBytes, totalSize) {
    // If download is complete, all ranges are valid
    if (downloadedBytes >= totalSize) {
        return {
            valid: true,
            status: 'complete',
            message: 'Download complete, all ranges available'
        };
    }

    // Check if requested range is within downloaded portion
    const bufferZone = 5 * 1024 * 1024; // 5MB safety buffer to avoid edge cases
    const safeDownloadedBytes = Math.max(0, downloadedBytes - bufferZone);

    if (requestedStart < safeDownloadedBytes) {
        return {
            valid: true,
            status: 'available',
            message: 'Range is within downloaded portion',
            downloadedBytes,
            downloadPercent: ((downloadedBytes / totalSize) * 100).toFixed(1)
        };
    }

    // Range not yet downloaded
    const bytesNeeded = requestedStart - downloadedBytes;
    const percentNeeded = ((requestedStart / totalSize) * 100).toFixed(1);
    const currentPercent = ((downloadedBytes / totalSize) * 100).toFixed(1);

    return {
        valid: false,
        status: 'buffering',
        message: `Position not yet downloaded (at ${currentPercent}%, need ${percentNeeded}%)`,
        bytesNeeded,
        downloadedBytes,
        currentPercent: parseFloat(currentPercent),
        neededPercent: parseFloat(percentNeeded),
        estimatedWaitSeconds: null // Will be calculated if download speed is known
    };
}

/**
 * Calculate estimated time until a position is downloaded
 * @param {number} bytesNeeded - Bytes needed to reach position
 * @param {number} downloadSpeedBps - Download speed in bytes per second
 * @returns {number} Estimated seconds until position is available
 */
export function estimateWaitTime(bytesNeeded, downloadSpeedBps) {
    if (!downloadSpeedBps || downloadSpeedBps <= 0) {
        return null;
    }

    return Math.ceil(bytesNeeded / downloadSpeedBps);
}

/**
 * Get download speed from SABnzbd
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID
 * @returns {Promise<number|null>} Download speed in bytes per second
 */
export async function getDownloadSpeed(sabnzbdUrl, apiKey, nzoId) {
    try {
        const status = await SABnzbd.getDownloadStatus(sabnzbdUrl, apiKey, nzoId);

        if (status.downloadSpeed) {
            // Convert from MB/s or KB/s to bytes/s
            // SABnzbd returns speed as "10.5 MB/s" or "500 KB/s"
            const speedMatch = status.downloadSpeed.match(/([\d.]+)\s*(MB|KB|GB)?\/s/i);
            if (speedMatch) {
                const value = parseFloat(speedMatch[1]);
                const unit = speedMatch[2] ? speedMatch[2].toUpperCase() : 'MB';

                const multipliers = {
                    'KB': 1024,
                    'MB': 1024 * 1024,
                    'GB': 1024 * 1024 * 1024
                };

                return value * (multipliers[unit] || 1024 * 1024);
            }
        }

        return null;
    } catch (error) {
        console.error('[SEEK-HANDLER] Error getting download speed:', error.message);
        return null;
    }
}

/**
 * Smart seek handler that validates range requests and provides feedback
 * @param {object} req - Express request object
 * @param {object} streamInfo - Stream info from tracking
 * @param {number} fileSize - Total file size in bytes
 * @returns {Promise<object>} Seek validation result
 */
export async function handleSeekRequest(req, streamInfo, fileSize) {
    // Parse range header
    const rangeHeader = req.headers.range;
    if (!rangeHeader) {
        return {
            valid: true,
            status: 'no-range',
            message: 'No range request'
        };
    }

    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!rangeMatch) {
        return {
            valid: false,
            status: 'invalid-range',
            message: 'Invalid range header format'
        };
    }

    const requestedStart = parseInt(rangeMatch[1]);
    const requestedEnd = rangeMatch[2] ? parseInt(rangeMatch[2]) : fileSize - 1;

    console.log(`[SEEK-HANDLER] Range request: ${requestedStart}-${requestedEnd} (${(requestedStart / fileSize * 100).toFixed(1)}% - ${(requestedEnd / fileSize * 100).toFixed(1)}%)`);

    // Get current download progress
    let downloadedBytes = fileSize; // Assume complete unless we can check
    let downloadPercent = 100;

    // If we have SABnzbd info, get real download progress
    if (streamInfo.config && streamInfo.config.sabnzbdUrl && !streamInfo.isPersonal) {
        try {
            const nzoId = streamInfo.nzoId || Array.from(streamInfo.config.sabnzbdUrl).find(id =>
                streamInfo.videoFilePath?.includes(id)
            );

            if (nzoId) {
                const status = await SABnzbd.getDownloadStatus(
                    streamInfo.config.sabnzbdUrl,
                    streamInfo.config.sabnzbdApiKey,
                    nzoId
                );

                downloadPercent = status.percentComplete || 100;
                downloadedBytes = calculateDownloadedBytes(downloadPercent, fileSize);

                console.log(`[SEEK-HANDLER] Download progress: ${downloadPercent.toFixed(1)}% (${(downloadedBytes / (1024 * 1024)).toFixed(1)}MB / ${(fileSize / (1024 * 1024)).toFixed(1)}MB)`);
            }
        } catch (error) {
            console.error('[SEEK-HANDLER] Error checking download progress:', error.message);
        }
    }

    // Validate range request
    const validation = validateRangeRequest(requestedStart, requestedEnd, downloadedBytes, fileSize);

    // If not valid, try to estimate wait time
    if (!validation.valid && validation.bytesNeeded) {
        const speed = await getDownloadSpeed(
            streamInfo.config?.sabnzbdUrl,
            streamInfo.config?.sabnzbdApiKey,
            streamInfo.nzoId
        );

        if (speed) {
            validation.estimatedWaitSeconds = estimateWaitTime(validation.bytesNeeded, speed);
            validation.downloadSpeedMbps = (speed / (1024 * 1024)).toFixed(1);
        }
    }

    return validation;
}

/**
 * Enhanced monitoring that detects seeks and optimizes download
 * @param {object} streamInfo - Stream info from tracking
 * @param {number} lastPosition - Last requested byte position
 * @param {number} currentPosition - Current requested byte position
 * @param {number} fileSize - Total file size
 * @returns {object} Seek detection result
 */
export function detectSeek(streamInfo, lastPosition, currentPosition, fileSize) {
    // Detect forward seeks (jumps ahead more than 5% of file)
    const seekThreshold = fileSize * 0.05; // 5% of file
    const positionDelta = currentPosition - lastPosition;

    if (positionDelta > seekThreshold) {
        const lastPercent = ((lastPosition / fileSize) * 100).toFixed(1);
        const currentPercent = ((currentPosition / fileSize) * 100).toFixed(1);

        console.log(`[SEEK-HANDLER] 🎯 SEEK DETECTED: ${lastPercent}% → ${currentPercent}% (jumped ${(positionDelta / (1024 * 1024)).toFixed(1)}MB)`);

        return {
            detected: true,
            type: 'forward',
            fromPercent: parseFloat(lastPercent),
            toPercent: parseFloat(currentPercent),
            deltaBytes: positionDelta,
            deltaMB: (positionDelta / (1024 * 1024)).toFixed(1)
        };
    }

    // Detect backward seeks (jumps back more than 1% of file)
    if (positionDelta < -(fileSize * 0.01)) {
        const lastPercent = ((lastPosition / fileSize) * 100).toFixed(1);
        const currentPercent = ((currentPosition / fileSize) * 100).toFixed(1);

        console.log(`[SEEK-HANDLER] ⏪ BACKWARD SEEK: ${lastPercent}% → ${currentPercent}%`);

        return {
            detected: true,
            type: 'backward',
            fromPercent: parseFloat(lastPercent),
            toPercent: parseFloat(currentPercent),
            deltaBytes: positionDelta
        };
    }

    return {
        detected: false,
        type: 'sequential'
    };
}

/**
 * Resume download aggressively when user seeks ahead
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID
 */
export async function resumeDownloadForSeek(sabnzbdUrl, apiKey, nzoId) {
    try {
        console.log('[SEEK-HANDLER] Resuming download aggressively for seek...');

        // Resume the download
        await SABnzbd.resumeDownload(sabnzbdUrl, apiKey, nzoId);

        // Move to top priority
        await SABnzbd.moveToTop(sabnzbdUrl, apiKey, nzoId);

        console.log('[SEEK-HANDLER] ✓ Download resumed and prioritized for seek');

        return true;
    } catch (error) {
        console.error('[SEEK-HANDLER] Error resuming download for seek:', error.message);
        return false;
    }
}

export default {
    calculateDownloadedBytes,
    validateRangeRequest,
    estimateWaitTime,
    getDownloadSpeed,
    handleSeekRequest,
    detectSeek,
    resumeDownloadForSeek
};
