/**
 * Usenet stream cleanup functionality
 * Handles cleanup of inactive streams and auto-cleaning of old files
 */

import SABnzbd from '../../lib/sabnzbd.js';
import {
    ACTIVE_USENET_STREAMS,
    USENET_CONFIGS,
    STREAM_CLEANUP_INTERVAL,
    STREAM_INACTIVE_TIMEOUT,
    STREAM_MONITOR_INTERVAL
} from './stream-tracker.js';
import {
    updateWatchedVideos,
    startStorageMonitoring,
    stopStorageMonitoring
} from './storage-cleanup.js';

// Store interval IDs for cleanup
let cleanupIntervalId = null;
let autoCleanIntervalId = null;
let autoCleanTimeoutId = null;
let monitorIntervalId = null;
let orphanedCheckTimeoutId = null;

/**
 * Delete file from file server
 * @param {string} fileServerUrl - File server URL
 * @param {string} filePath - File path to delete
 * @returns {boolean} True if deleted successfully
 */
export async function deleteFileFromServer(fileServerUrl, filePath) {
    try {
        const axios = (await import('axios')).default;
        const url = `${fileServerUrl.replace(/\/$/, '')}/${filePath}`;
        await axios.delete(url, { timeout: 10000 });
        console.log(`[USENET-CLEANUP] Deleted file from server: ${filePath}`);
        return true;
    } catch (error) {
        console.error(`[USENET-CLEANUP] Failed to delete file from server: ${error.message}`);
        return false;
    }
}

/**
 * Cleanup inactive Usenet streams
 * Removes downloads from SABnzbd if no stream has accessed them recently
 * Also deletes files from file server if deleteOnStreamStop is enabled
 */
export async function cleanupInactiveStreams() {
    const now = Date.now();
    console.log('[USENET-CLEANUP] Checking for inactive streams...');

    // Update watched videos tracking for storage-based cleanup
    updateWatchedVideos();

    for (const [streamKey, streamInfo] of ACTIVE_USENET_STREAMS.entries()) {
        const inactiveTime = now - streamInfo.lastAccess;

        if (inactiveTime > STREAM_INACTIVE_TIMEOUT) {
            const inactiveMinutes = Math.round(inactiveTime / 1000 / 60);
            console.log(`[USENET-CLEANUP] Stream inactive for ${inactiveMinutes} minutes: ${streamKey}`);

            // Check if we should delete the file from the file server
            const shouldDeleteFile = streamInfo.usenetConfig?.deleteOnStreamStop;

            // Handle personal files differently (they don't have NZO IDs)
            if (streamInfo.isPersonal) {
                console.log(`[USENET-CLEANUP] Personal file stream inactive: ${streamKey}`);

                if (shouldDeleteFile && streamInfo.videoFilePath && streamInfo.usenetConfig?.fileServerUrl) {
                    console.log(`[USENET-CLEANUP] deleteOnStreamStop enabled, deleting personal file from server`);
                    await deleteFileFromServer(streamInfo.usenetConfig.fileServerUrl, streamInfo.videoFilePath);
                }

                ACTIVE_USENET_STREAMS.delete(streamKey);
                continue;
            }

            // Handle regular Usenet downloads (with NZO IDs)
            const nzoId = streamKey;
            const status = await SABnzbd.getDownloadStatus(
                streamInfo.config.sabnzbdUrl,
                streamInfo.config.sabnzbdApiKey,
                nzoId
            );

            // User stopped watching - delete the download if incomplete
            if (status.status === 'downloading' || status.status === 'Downloading' || status.status === 'Paused') {
                console.log(`[USENET-CLEANUP] User stopped streaming incomplete download: ${nzoId} (${status.percentComplete?.toFixed(1)}%)`);

                // Only delete if deleteOnStreamStop is enabled
                if (shouldDeleteFile) {
                    console.log(`[USENET-CLEANUP] deleteOnStreamStop enabled, deleting incomplete download and files`);

                    // Delete download from SABnzbd
                    const deleted = await SABnzbd.deleteItem(
                        streamInfo.config.sabnzbdUrl,
                        streamInfo.config.sabnzbdApiKey,
                        nzoId,
                        true // Delete files
                    );

                    if (deleted) {
                        console.log(`[USENET-CLEANUP] ✓ Deleted incomplete download and files: ${nzoId}`);
                    }

                    // Also delete from file server if configured
                    if (streamInfo.videoFilePath && streamInfo.usenetConfig?.fileServerUrl) {
                        console.log(`[USENET-CLEANUP] Deleting incomplete file from file server: ${streamInfo.videoFilePath}`);
                        await deleteFileFromServer(streamInfo.usenetConfig.fileServerUrl, streamInfo.videoFilePath);
                    }
                } else {
                    console.log(`[USENET-CLEANUP] deleteOnStreamStop disabled, keeping incomplete download`);
                }

                ACTIVE_USENET_STREAMS.delete(nzoId);
            } else if (status.status === 'completed') {
                console.log(`[USENET-CLEANUP] Download completed: ${nzoId}`);
                // DO NOT delete completed files - they become "personal" files for instant playback
                // They will be cleaned up by autoCleanOldFiles after the configured age (default 7 days)
                console.log(`[USENET-CLEANUP] Keeping completed file (will auto-clean after ${streamInfo.usenetConfig?.autoCleanAgeDays || 7} days if enabled)`);

                // Remove from tracking
                ACTIVE_USENET_STREAMS.delete(nzoId);
            } else {
                // Not found or failed, remove from tracking
                ACTIVE_USENET_STREAMS.delete(nzoId);
            }
        }
    }
}

/**
 * Auto-clean old files from file server based on age
 * Uses globally stored configs, works even without active streams
 */
export async function autoCleanOldFiles() {
    console.log('[USENET-AUTO-CLEAN] Checking for old files to clean...');

    // Also check active streams for any additional configs
    for (const [streamKey, streamInfo] of ACTIVE_USENET_STREAMS.entries()) {
        const config = streamInfo.usenetConfig;
        if (config?.fileServerUrl && config?.autoCleanOldFiles) {
            USENET_CONFIGS.set(config.fileServerUrl, config);
        }
    }

    if (USENET_CONFIGS.size === 0) {
        console.log('[USENET-AUTO-CLEAN] No Usenet configs with auto-clean enabled');
        return;
    }

    console.log(`[USENET-AUTO-CLEAN] Found ${USENET_CONFIGS.size} file server(s) with auto-clean enabled`);

    for (const [fileServerUrl, config] of USENET_CONFIGS.entries()) {
        try {
            const ageDays = config.autoCleanAgeDays || 7;
            const ageThresholdMs = ageDays * 24 * 60 * 60 * 1000;
            const now = Date.now();

            console.log(`[USENET-AUTO-CLEAN] Checking files on ${fileServerUrl} (age threshold: ${ageDays} days)`);

            // Get list of files from file server
            const axios = (await import('axios')).default;
            const headers = {};
            // Use fileServerPassword from config if available, otherwise use env variable
            const apiKey = config?.fileServerPassword || process.env.USENET_FILE_SERVER_API_KEY;
            if (apiKey) {
                headers['X-API-Key'] = apiKey;
            }
            const response = await axios.get(`${fileServerUrl.replace(/\/$/, '')}/api/list`, {
                timeout: 10000,
                headers: headers
            });

            if (!response.data?.files) {
                console.log(`[USENET-AUTO-CLEAN] No files found on ${fileServerUrl}`);
                continue;
            }

            const files = response.data.files;
            let deletedCount = 0;

            for (const file of files) {
                // Only delete COMPLETED files (not incomplete/in-progress downloads)
                if (!file.isComplete) {
                    continue; // Skip incomplete files
                }

                const fileAgeMs = now - (file.modified * 1000); // Convert to milliseconds

                if (fileAgeMs > ageThresholdMs) {
                    const ageDaysActual = Math.round(fileAgeMs / (24 * 60 * 60 * 1000));
                    console.log(`[USENET-AUTO-CLEAN] Completed file is ${ageDaysActual} days old, deleting: ${file.path}`);

                    const deleted = await deleteFileFromServer(fileServerUrl, file.path);
                    if (deleted) {
                        deletedCount++;
                    }
                }
            }

            if (deletedCount > 0) {
                console.log(`[USENET-AUTO-CLEAN] Deleted ${deletedCount} old files from ${fileServerUrl}`);
            } else {
                console.log(`[USENET-AUTO-CLEAN] No old files to delete from ${fileServerUrl}`);
            }

        } catch (error) {
            console.error(`[USENET-AUTO-CLEAN] Error cleaning files from ${fileServerUrl}:`, error.message);
        }
    }
}

/**
 * Monitor active streams and manage SABnzbd pause/resume
 * - Resume downloads when playback is getting close to download position
 * - Resume downloads when user stops streaming
 */
export async function monitorStreamDownloads() {
    const totalStreams = ACTIVE_USENET_STREAMS.size;
    const nonPersonalStreams = Array.from(ACTIVE_USENET_STREAMS.values()).filter(s => !s.isPersonal).length;

    if (totalStreams === 0) {
        console.log('[USENET-MONITOR] No active streams to monitor');
        return;
    }

    console.log(`[USENET-MONITOR] Checking ${nonPersonalStreams} stream(s) (${totalStreams} total, ${totalStreams - nonPersonalStreams} personal)...`);

    for (const [nzoId, streamInfo] of ACTIVE_USENET_STREAMS.entries()) {
        // Skip personal files (no download to monitor)
        if (streamInfo.isPersonal) {
            continue;
        }

        try {
            // Get current download status
            const status = await SABnzbd.getDownloadStatus(
                streamInfo.config.sabnzbdUrl,
                streamInfo.config.sabnzbdApiKey,
                nzoId
            );

            // Skip if not paused or not downloading
            if (status.status !== 'Paused' && status.status !== 'downloading') {
                console.log(`[USENET-MONITOR] Skipping ${nzoId}: status is "${status.status}" (not Paused/downloading)`);
                continue;
            }

            // Calculate playback percentage
            const playbackPercent = streamInfo.fileSize > 0
                ? (streamInfo.lastPlaybackPosition / streamInfo.fileSize) * 100
                : 0;

            const downloadPercent = status.percentComplete || streamInfo.lastDownloadPercent;

            console.log(`[USENET-MONITOR] ${nzoId}: Playback ${playbackPercent.toFixed(1)}% | Download ${downloadPercent.toFixed(1)}%`);

            // Resume if paused and playback is within 15% of download position
            const bufferPercent = 15;
            if (streamInfo.paused && playbackPercent > downloadPercent - bufferPercent) {
                console.log(`[USENET-MONITOR] ⚠️ Playback catching up to download! Resuming to maintain buffer...`);
                await SABnzbd.resumeDownload(
                    streamInfo.config.sabnzbdUrl,
                    streamInfo.config.sabnzbdApiKey,
                    nzoId
                );
                streamInfo.paused = false;
            }

            // Update last known download percent
            streamInfo.lastDownloadPercent = downloadPercent;

        } catch (error) {
            console.error(`[USENET-MONITOR] Error monitoring ${nzoId}:`, error.message);
        }
    }
}

/**
 * Check for orphaned paused downloads on startup
 * Resume any paused downloads that aren't actively being streamed
 * This handles server restarts while downloads were paused
 */
export async function checkOrphanedPausedDownloads() {
    console.log('[USENET-STARTUP] Checking for orphaned paused downloads...');

    // Get all active configs from environment or stored configs
    const configsToCheck = new Set();

    // Add any configs from USENET_CONFIGS
    for (const config of USENET_CONFIGS.values()) {
        if (config.sabnzbdUrl && config.sabnzbdApiKey) {
            configsToCheck.add(JSON.stringify({
                url: config.sabnzbdUrl,
                key: config.sabnzbdApiKey
            }));
        }
    }

    if (configsToCheck.size === 0) {
        console.log('[USENET-STARTUP] No SABnzbd configs to check');
        return;
    }

    for (const configStr of configsToCheck) {
        const config = JSON.parse(configStr);

        try {
            // Get SABnzbd queue
            const queue = await SABnzbd.getQueue(config.url, config.key);

            if (!queue?.slots || queue.slots.length === 0) {
                continue;
            }

            // Check each download
            for (const slot of queue.slots) {
                if (slot.status === 'Paused') {
                    const nzoId = slot.nzo_id;

                    // Check if this download is being actively streamed
                    const isActiveStream = ACTIVE_USENET_STREAMS.has(nzoId);

                    if (!isActiveStream) {
                        console.log(`[USENET-STARTUP] Found orphaned paused download: ${slot.filename} (${nzoId})`);
                        console.log(`[USENET-STARTUP] Resuming orphaned download...`);

                        await SABnzbd.resumeDownload(config.url, config.key, nzoId);
                    } else {
                        console.log(`[USENET-STARTUP] Paused download is actively streaming, keeping paused: ${slot.filename}`);
                    }
                }
            }
        } catch (error) {
            console.error(`[USENET-STARTUP] Error checking SABnzbd queue:`, error.message);
        }
    }
}

/**
 * Start cleanup intervals
 */
export function startCleanupIntervals() {
    // Schedule cleanup every 2 minutes
    cleanupIntervalId = setInterval(() => {
        cleanupInactiveStreams().catch(err => {
            console.error('[USENET-CLEANUP] Error during cleanup:', err.message);
        });
    }, STREAM_CLEANUP_INTERVAL);

    // Schedule auto-clean every hour
    const AUTO_CLEAN_INTERVAL = 60 * 60 * 1000; // 1 hour
    autoCleanIntervalId = setInterval(() => {
        autoCleanOldFiles().catch(err => {
            console.error('[USENET-AUTO-CLEAN] Error during auto-clean:', err.message);
        });
    }, AUTO_CLEAN_INTERVAL);

    // Run auto-clean on startup after 5 minutes
    autoCleanTimeoutId = setTimeout(() => {
        autoCleanOldFiles().catch(err => {
            console.error('[USENET-AUTO-CLEAN] Error during startup auto-clean:', err.message);
        });
    }, 5 * 60 * 1000);

    // Schedule monitoring every 30 seconds
    monitorIntervalId = setInterval(() => {
        monitorStreamDownloads().catch(err => {
            console.error('[USENET-MONITOR] Error during monitoring:', err.message);
        });
    }, STREAM_MONITOR_INTERVAL);

    // Run orphaned download check on startup after 10 seconds
    orphanedCheckTimeoutId = setTimeout(() => {
        checkOrphanedPausedDownloads().catch(err => {
            console.error('[USENET-STARTUP] Error checking orphaned downloads:', err.message);
        });
    }, 10 * 1000);

    // Start storage-based cleanup monitoring
    startStorageMonitoring();

    console.log('[USENET-CLEANUP] Cleanup intervals started (with storage monitoring)');
}

/**
 * Stop cleanup intervals (for graceful shutdown)
 */
export function stopCleanupIntervals() {
    if (cleanupIntervalId) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
    }
    if (autoCleanIntervalId) {
        clearInterval(autoCleanIntervalId);
        autoCleanIntervalId = null;
    }
    if (autoCleanTimeoutId) {
        clearTimeout(autoCleanTimeoutId);
        autoCleanTimeoutId = null;
    }
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        monitorIntervalId = null;
    }
    if (orphanedCheckTimeoutId) {
        clearTimeout(orphanedCheckTimeoutId);
        orphanedCheckTimeoutId = null;
    }

    // Stop storage monitoring
    stopStorageMonitoring();

    console.log('[USENET-CLEANUP] Cleanup intervals stopped (with storage monitoring)');
}

export default {
    deleteFileFromServer,
    cleanupInactiveStreams,
    autoCleanOldFiles,
    monitorStreamDownloads,
    checkOrphanedPausedDownloads,
    startCleanupIntervals,
    stopCleanupIntervals
};
