/**
 * CRITICAL: Main /usenet/stream route handler logic
 * Broken down from the massive ~1226 line route handler into modular functions
 *
 * This module orchestrates the entire Usenet streaming workflow:
 * 1. Parse and validate parameters
 * 2. Check disk space
 * 3. Submit NZB to SABnzbd (or find existing download)
 * 4. Wait for video file extraction
 * 5. Handle streaming (either redirect to file server or direct stream)
 */

import fs from 'fs';
import path from 'path';
import SABnzbd from '../../lib/sabnzbd.js';
import Usenet from '../../lib/usenet.js';
import { findVideoFile, findVideoFileViaAPI } from './video-finder.js';
import { redirectToErrorVideo } from '../utils/error-video.js';
import { parseConfigParam, validateUsenetConfig } from '../utils/validation.js';
import {
    ACTIVE_USENET_STREAMS,
    USENET_CONFIGS,
    setStreamInfo,
    getStreamInfo,
    hasStream
} from './stream-tracker.js';

/**
 * Parse and validate request parameters
 * ~50 lines of logic extracted
 */
export function parseRequestParams(req) {
    const { nzbUrl, title, type, id } = req.params;
    const configJson = req.query.config;

    if (!configJson) {
        throw new Error('Missing configuration');
    }

    const config = parseConfigParam(configJson);

    if (!validateUsenetConfig(config)) {
        throw new Error('Usenet not configured');
    }

    const decodedNzbUrl = decodeURIComponent(nzbUrl);
    const decodedTitle = decodeURIComponent(title);

    return {
        nzbUrl: decodedNzbUrl,
        title: decodedTitle,
        type,
        id,
        config
    };
}

/**
 * Check disk space and return error if critically low
 * ~20 lines of logic extracted
 */
export async function checkDiskSpace(config) {
    const diskSpace = await SABnzbd.getDiskSpace(config.sabnzbdUrl, config.sabnzbdApiKey);

    if (diskSpace) {
        if (diskSpace.incompleteDir.lowSpace) {
            console.log(`[USENET] WARNING: Low disk space in incomplete dir: ${diskSpace.incompleteDir.available}`);
        }
        if (diskSpace.completeDir.lowSpace) {
            console.log(`[USENET] WARNING: Low disk space in complete dir: ${diskSpace.completeDir.available}`);
        }

        // Return error if critically low (less than 2GB)
        const criticalThreshold = 2 * 1024 * 1024 * 1024;
        if (diskSpace.incompleteDir.availableBytes < criticalThreshold) {
            return {
                error: true,
                code: 507,
                message: `⚠️ Insufficient storage space!\n\n` +
                    `Available: ${diskSpace.incompleteDir.available}\n` +
                    `Please free up space on your SABnzbd incomplete directory.`
            };
        }
    }

    return { error: false };
}

/**
 * Find or create download in SABnzbd
 * ~150 lines of logic extracted
 */
export async function findOrCreateDownload(config, decodedTitle, decodedNzbUrl) {
    let nzoId = null;

    // Check if already downloading in our memory cache
    for (const [downloadId, info] of Usenet.activeDownloads.entries()) {
        if (info.name === decodedTitle) {
            nzoId = downloadId;
            console.log('[USENET] Found existing download in memory:', nzoId);
            break;
        }
    }

    // Check SABnzbd queue and history for existing downloads
    if (!nzoId) {
        const existing = await SABnzbd.findDownloadByName(config.sabnzbdUrl, config.sabnzbdApiKey, decodedTitle);
        if (existing) {
            nzoId = existing.nzoId;
            console.log(`[USENET] Found existing download in ${existing.location}: ${nzoId} (${existing.status})`);

            // If it's completed, verify the files actually exist
            if (existing.status === 'completed') {
                const status = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);
                if (status.path && !fs.existsSync(status.path)) {
                    console.log(`[USENET] ⚠️  Completed download folder missing: ${status.path}`);
                    console.log(`[USENET] Deleting stale history entry and re-downloading...`);

                    // Delete from history
                    await SABnzbd.deleteItem(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId, false);
                    nzoId = null; // Reset so we re-download below
                }
            }

            if (nzoId) {
                // Add to our memory cache
                Usenet.activeDownloads.set(nzoId, {
                    nzoId: nzoId,
                    name: decodedTitle,
                    startTime: Date.now(),
                    status: existing.status
                });

                // Only delete other INCOMPLETE downloads if this is still downloading
                // Don't delete anything if this is already completed
                if (existing.status === 'downloading' || existing.status === 'Downloading' || existing.status === 'Paused') {
                    console.log('[USENET] Deleting other incomplete downloads to prioritize existing stream...');
                    const deletedCount = await SABnzbd.deleteAllExcept(
                        config.sabnzbdUrl,
                        config.sabnzbdApiKey,
                        nzoId,
                        true // Delete files
                    );
                    if (deletedCount > 0) {
                        console.log(`[USENET] ✓ Deleted ${deletedCount} other download(s)`);
                    }
                } else {
                    console.log('[USENET] Existing download is completed, keeping all other downloads');
                }
            }
        }
    }

    // Submit NZB to SABnzbd if not already downloading
    if (!nzoId) {
        console.log('[USENET] Submitting NZB to SABnzbd...');
        const submitResult = await Usenet.submitNzb(
            config.sabnzbdUrl,
            config.sabnzbdApiKey,
            config.newznabUrl,
            config.newznabApiKey,
            decodedNzbUrl,
            decodedTitle
        );
        nzoId = submitResult.nzoId;

        // Add to memory cache immediately to prevent race conditions
        Usenet.activeDownloads.set(nzoId, {
            nzoId: nzoId,
            name: decodedTitle,
            startTime: Date.now(),
            status: 'downloading'
        });

        // Delete all other downloads to free up bandwidth for this new stream
        console.log('[USENET] Deleting all other downloads to prioritize new stream...');
        const deletedCount = await SABnzbd.deleteAllExcept(
            config.sabnzbdUrl,
            config.sabnzbdApiKey,
            nzoId,
            true // Delete files
        );
        if (deletedCount > 0) {
            console.log(`[USENET] ✓ Deleted ${deletedCount} other download(s) to prioritize this stream`);
        }

        console.log(`[USENET] Keeping all completed folders (personal files)`);
    }

    return nzoId;
}

/**
 * Wait for download to start (reach 5% minimum)
 * ~50 lines of logic extracted
 */
export async function waitForDownloadStart(config, nzoId) {
    let status = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);

    // Only wait if download hasn't reached 5% yet
    if ((status.percentComplete || 0) < 5 && status.status !== 'completed') {
        console.log('[USENET] Waiting for download to start...');
        try {
            status = await Usenet.waitForStreamingReady(
                config.sabnzbdUrl,
                config.sabnzbdApiKey,
                nzoId,
                5, // 5% minimum - ensure enough data for initial streaming
                60000 // 1 minute max wait for download to start
            );
        } catch (error) {
            console.log(`[USENET] Download failed or timed out: ${error.message}`);

            // Delete the failed download
            try {
                await SABnzbd.deleteItem(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId, true);
                console.log(`[USENET] Deleted failed download: ${nzoId}`);
            } catch (deleteError) {
                console.log(`[USENET] Could not delete failed download: ${deleteError.message}`);
            }

            // Return error details
            let errorMessage = 'Download failed or timed out';
            if (error.message.includes('Aborted')) {
                errorMessage = 'Download failed - file incomplete or missing from Usenet servers';
            } else if (error.message.includes('Timeout')) {
                errorMessage = 'Download timed out - file may be missing or too slow';
            }

            throw new Error(errorMessage);
        }
    } else {
        console.log(`[USENET] Download already at ${status.percentComplete?.toFixed(1)}%, skipping wait`);
    }

    return status;
}

/**
 * Check for 7z archives (not supported)
 * ~30 lines of logic extracted
 */
export async function check7zArchives(fileServerUrl, actualFolderName, fileServerPassword) {
    if (!fileServerUrl) {
        return { has7z: false };
    }

    try {
        const axios = (await import('axios')).default;
        const headers = {};
        const apiKey = fileServerPassword || process.env.USENET_FILE_SERVER_API_KEY;
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }

        const checkUrl = `${fileServerUrl.replace(/\/$/, '')}/api/check-archives?folder=${encodeURIComponent(actualFolderName)}`;
        console.log(`[USENET] Checking for 7z archives: ${checkUrl}`);

        const checkResult = await axios.get(checkUrl, {
            timeout: 5000,
            headers: headers,
            validateStatus: (status) => status === 200 || status === 404 || status === 400
        });

        console.log(`[USENET] Archive check result:`, JSON.stringify(checkResult.data));

        if (checkResult.status === 200 && checkResult.data?.has7z) {
            return { has7z: true };
        }

        return { has7z: false, found: checkResult.data?.found };
    } catch (e) {
        console.log(`[USENET] Could not check for 7z archives: ${e.message}`);
        return { has7z: false, error: true };
    }
}

/**
 * Delete download and show error video (for 7z archives)
 */
export async function deleteDownloadAndShowError(config, nzoId, errorMessage, res, fileServerUrl) {
    console.log(`[USENET] Deleting download: ${nzoId}`);

    // Delete the download
    await SABnzbd.deleteItem(
        config.sabnzbdUrl,
        config.sabnzbdApiKey,
        nzoId,
        true // Delete files
    );

    // Redirect to error video on Python server
    if (fileServerUrl) {
        return redirectToErrorVideo(errorMessage, res, fileServerUrl);
    } else {
        throw new Error(errorMessage);
    }
}

export default {
    parseRequestParams,
    checkDiskSpace,
    findOrCreateDownload,
    waitForDownloadStart,
    check7zArchives,
    deleteDownloadAndShowError
};
