/**
 * Smart storage-based cleanup for Usenet files
 * Deletes watched videos when storage is low, prioritizing oldest watched content
 */

import SABnzbd from '../../lib/sabnzbd.js';
import { deleteFileFromServer } from './cleanup.js';
import { USENET_CONFIGS, getActiveStreams } from './stream-tracker.js';

// Storage thresholds
const LOW_STORAGE_PERCENT = 20; // Trigger cleanup when < 20% free
const CRITICAL_STORAGE_PERCENT = 10; // Aggressive cleanup when < 10% free
const TARGET_STORAGE_PERCENT = 30; // Clean until we have 30% free
const WATCHED_THRESHOLD = 90; // Consider videos with >= 90% completion as "watched"

// Cleanup intervals
const STORAGE_CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes
let storageCheckIntervalId = null;

// Track watched videos across sessions
const WATCHED_VIDEOS = new Map(); // filePath -> { completionPercent, lastWatched, size }

/**
 * Update watched video tracking from active streams
 */
export function updateWatchedVideos() {
    const activeStreams = getActiveStreams();

    for (const [streamKey, streamInfo] of activeStreams.entries()) {
        if (streamInfo.completionPercentage >= WATCHED_THRESHOLD && streamInfo.videoFilePath) {
            WATCHED_VIDEOS.set(streamInfo.videoFilePath, {
                completionPercent: streamInfo.completionPercentage,
                lastWatched: Date.now(),
                size: streamInfo.fileSize || 0,
                fileServerUrl: streamInfo.usenetConfig?.fileServerUrl
            });
        }
    }
}

/**
 * Get disk space information from SABnzbd
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @returns {Promise<object>} Disk space info with percentages
 */
export async function getDiskSpaceInfo(sabnzbdUrl, apiKey) {
    try {
        const diskSpace = await SABnzbd.getDiskSpace(sabnzbdUrl, apiKey);

        if (!diskSpace) {
            return null;
        }

        // Calculate percentage free (estimate total from available)
        // Assuming available space represents the free space directly
        const completeBytes = diskSpace.completeDir.availableBytes;
        const incompleteBytes = diskSpace.incompleteDir.availableBytes;

        return {
            completeDir: {
                availableBytes: completeBytes,
                available: diskSpace.completeDir.available,
                lowSpace: diskSpace.completeDir.lowSpace
            },
            incompleteDir: {
                availableBytes: incompleteBytes,
                available: diskSpace.incompleteDir.available,
                lowSpace: diskSpace.incompleteDir.lowSpace
            },
            // Use the lower of the two as the critical indicator
            minAvailableBytes: Math.min(completeBytes, incompleteBytes),
            minAvailable: completeBytes < incompleteBytes ? diskSpace.completeDir.available : diskSpace.incompleteDir.available,
            needsCleanup: diskSpace.completeDir.lowSpace || diskSpace.incompleteDir.lowSpace
        };
    } catch (error) {
        console.error('[STORAGE-CLEANUP] Error getting disk space:', error.message);
        return null;
    }
}

/**
 * Get files from file server with sorting options
 * @param {string} fileServerUrl - File server URL
 * @param {string} apiKey - File server API key (optional)
 * @returns {Promise<Array>} Array of file objects with metadata
 */
async function getFileServerFiles(fileServerUrl, apiKey) {
    try {
        const axios = (await import('axios')).default;
        const headers = {};

        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }

        const response = await axios.get(`${fileServerUrl.replace(/\/$/, '')}/api/list`, {
            timeout: 15000,
            headers: headers
        });

        if (!response.data?.files) {
            return [];
        }

        return response.data.files;
    } catch (error) {
        console.error('[STORAGE-CLEANUP] Error fetching file server files:', error.message);
        return [];
    }
}

/**
 * Calculate storage cleanup priority for a file
 * Higher score = delete first
 * @param {object} file - File object from file server
 * @param {object} watchedInfo - Watched video info (if available)
 * @returns {number} Priority score
 */
function calculateCleanupPriority(file, watchedInfo) {
    let score = 0;

    // Priority 1: Watched videos (highest priority for deletion)
    if (watchedInfo && watchedInfo.completionPercent >= WATCHED_THRESHOLD) {
        score += 1000;

        // Age factor (older watched videos = higher priority)
        const ageHours = (Date.now() - watchedInfo.lastWatched) / (1000 * 60 * 60);
        score += ageHours; // 1 point per hour old
    }

    // Priority 2: Old completed files (not watched, but old)
    if (file.isComplete && file.modified) {
        const ageMs = Date.now() - (file.modified * 1000);
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays > 7) {
            score += 100 + (ageDays * 10); // Old files get points
        }
    }

    // Priority 3: Incomplete files that are very old (abandoned downloads)
    if (!file.isComplete && file.modified) {
        const ageMs = Date.now() - (file.modified * 1000);
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays > 3) {
            score += 50 + (ageDays * 5); // Old incomplete files
        }
    }

    return score;
}

/**
 * Smart storage-based cleanup
 * Deletes watched videos and old files when storage is low
 * @param {boolean} aggressive - If true, use critical thresholds
 */
export async function smartStorageCleanup(aggressive = false) {
    console.log('[STORAGE-CLEANUP] Starting smart storage-based cleanup...');

    // Update watched videos from active streams first
    updateWatchedVideos();

    if (USENET_CONFIGS.size === 0) {
        console.log('[STORAGE-CLEANUP] No Usenet configs found');
        return { cleaned: false, reason: 'No configs' };
    }

    let totalDeleted = 0;
    let totalBytesFreed = 0;

    for (const [fileServerUrl, config] of USENET_CONFIGS.entries()) {
        try {
            // Check disk space
            const diskSpace = await getDiskSpaceInfo(config.sabnzbdUrl, config.sabnzbdApiKey);

            if (!diskSpace) {
                console.log('[STORAGE-CLEANUP] Could not retrieve disk space info');
                continue;
            }

            console.log(`[STORAGE-CLEANUP] Disk space: ${diskSpace.minAvailable} available`);

            // Determine if cleanup is needed
            const needsCleanup = diskSpace.needsCleanup;
            const isCritical = diskSpace.minAvailableBytes < 5 * 1024 * 1024 * 1024; // < 5GB is critical

            if (!needsCleanup && !aggressive) {
                console.log('[STORAGE-CLEANUP] Storage levels healthy, no cleanup needed');
                continue;
            }

            if (needsCleanup) {
                console.log(`[STORAGE-CLEANUP] ⚠️  Low storage detected! ${diskSpace.minAvailable} available`);
            }

            if (isCritical) {
                console.log('[STORAGE-CLEANUP] 🚨 CRITICAL storage levels! Aggressive cleanup enabled');
            }

            // Get all files from file server
            const files = await getFileServerFiles(fileServerUrl, config.fileServerPassword);

            if (files.length === 0) {
                console.log('[STORAGE-CLEANUP] No files found on file server');
                continue;
            }

            console.log(`[STORAGE-CLEANUP] Found ${files.length} files to analyze`);

            // Calculate cleanup priority for each file
            const filesWithPriority = files.map(file => {
                const watchedInfo = WATCHED_VIDEOS.get(file.path);
                const priority = calculateCleanupPriority(file, watchedInfo);

                return {
                    ...file,
                    priority,
                    watchedInfo,
                    isWatched: watchedInfo && watchedInfo.completionPercent >= WATCHED_THRESHOLD
                };
            });

            // Sort by priority (highest first = delete first)
            filesWithPriority.sort((a, b) => b.priority - a.priority);

            // Calculate how much space we need to free
            const targetBytes = isCritical ?
                20 * 1024 * 1024 * 1024 : // Free 20GB when critical
                10 * 1024 * 1024 * 1024;  // Free 10GB when low

            let bytesFreed = 0;
            let filesDeleted = 0;

            console.log(`[STORAGE-CLEANUP] Target: Free ${(targetBytes / (1024 * 1024 * 1024)).toFixed(1)}GB of space`);

            // Delete files in priority order until we reach target
            for (const file of filesWithPriority) {
                // Stop if we've freed enough space
                if (bytesFreed >= targetBytes && !isCritical) {
                    console.log(`[STORAGE-CLEANUP] Target reached: Freed ${(bytesFreed / (1024 * 1024 * 1024)).toFixed(2)}GB`);
                    break;
                }

                // Skip incomplete files unless critical or they're abandoned
                if (!file.isComplete && !isCritical && file.priority < 50) {
                    continue;
                }

                // Delete the file
                console.log(`[STORAGE-CLEANUP] Deleting: ${file.path}`);
                console.log(`[STORAGE-CLEANUP]   - Size: ${(file.size / (1024 * 1024)).toFixed(1)}MB`);
                console.log(`[STORAGE-CLEANUP]   - Priority: ${file.priority.toFixed(1)}`);
                console.log(`[STORAGE-CLEANUP]   - Watched: ${file.isWatched ? 'Yes' : 'No'}`);

                const deleted = await deleteFileFromServer(fileServerUrl, file.path);

                if (deleted) {
                    filesDeleted++;
                    bytesFreed += file.size;
                    totalDeleted++;
                    totalBytesFreed += file.size;

                    // Remove from watched tracking
                    WATCHED_VIDEOS.delete(file.path);
                }

                // Small delay to avoid overwhelming the file server
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            console.log(`[STORAGE-CLEANUP] Cleanup complete for ${fileServerUrl}:`);
            console.log(`[STORAGE-CLEANUP]   - Files deleted: ${filesDeleted}`);
            console.log(`[STORAGE-CLEANUP]   - Space freed: ${(bytesFreed / (1024 * 1024 * 1024)).toFixed(2)}GB`);

        } catch (error) {
            console.error(`[STORAGE-CLEANUP] Error during cleanup for ${fileServerUrl}:`, error.message);
        }
    }

    return {
        cleaned: totalDeleted > 0,
        filesDeleted: totalDeleted,
        bytesFreed: totalBytesFreed,
        bytesFreedGB: (totalBytesFreed / (1024 * 1024 * 1024)).toFixed(2)
    };
}

/**
 * Check storage before starting a new download
 * Returns true if download can proceed, false if storage too low
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {number} estimatedSizeBytes - Estimated download size (optional)
 */
export async function checkStorageBeforeDownload(sabnzbdUrl, apiKey, estimatedSizeBytes = 0) {
    try {
        const diskSpace = await getDiskSpaceInfo(sabnzbdUrl, apiKey);

        if (!diskSpace) {
            console.log('[STORAGE-CLEANUP] Cannot verify disk space, allowing download');
            return true;
        }

        const minAvailable = diskSpace.minAvailableBytes;
        const critical = minAvailable < 2 * 1024 * 1024 * 1024; // < 2GB critical

        console.log(`[STORAGE-CLEANUP] Pre-download check: ${diskSpace.minAvailable} available`);

        if (critical) {
            console.log('[STORAGE-CLEANUP] 🚨 CRITICAL storage! Running aggressive cleanup...');

            // Try aggressive cleanup
            const result = await smartStorageCleanup(true);

            if (result.cleaned && result.bytesFreed > 1024 * 1024 * 1024) { // Freed at least 1GB
                console.log(`[STORAGE-CLEANUP] ✓ Freed ${result.bytesFreedGB}GB, download can proceed`);
                return true;
            }

            console.log('[STORAGE-CLEANUP] ✗ Insufficient storage even after cleanup');
            return false;
        }

        if (diskSpace.needsCleanup) {
            console.log('[STORAGE-CLEANUP] Low storage, running cleanup in background...');
            // Run cleanup async, don't block download
            smartStorageCleanup(false).catch(err => {
                console.error('[STORAGE-CLEANUP] Background cleanup error:', err.message);
            });
        }

        return true;
    } catch (error) {
        console.error('[STORAGE-CLEANUP] Error checking storage:', error.message);
        return true; // Allow download on error
    }
}

/**
 * Start storage monitoring intervals
 */
export function startStorageMonitoring() {
    // Check storage every 5 minutes
    storageCheckIntervalId = setInterval(() => {
        smartStorageCleanup(false).catch(err => {
            console.error('[STORAGE-CLEANUP] Error during scheduled cleanup:', err.message);
        });
    }, STORAGE_CHECK_INTERVAL);

    console.log('[STORAGE-CLEANUP] Storage monitoring started (checking every 5 minutes)');
}

/**
 * Stop storage monitoring intervals
 */
export function stopStorageMonitoring() {
    if (storageCheckIntervalId) {
        clearInterval(storageCheckIntervalId);
        storageCheckIntervalId = null;
    }
    console.log('[STORAGE-CLEANUP] Storage monitoring stopped');
}

export default {
    updateWatchedVideos,
    getDiskSpaceInfo,
    smartStorageCleanup,
    checkStorageBeforeDownload,
    startStorageMonitoring,
    stopStorageMonitoring,
    WATCHED_VIDEOS
};
