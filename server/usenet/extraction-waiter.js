/**
 * Wait for video file extraction from archives (RAR, 7z, etc.) or direct downloads
 * Handles polling for video file availability with timeout
 * ~200 lines of logic extracted from main stream handler
 */

import fs from 'fs';
import path from 'path';
import SABnzbd from '../../lib/sabnzbd.js';
import { findVideoFile, findVideoFileViaAPI } from './video-finder.js';

/**
 * Wait for video file to be extracted from download
 * @param {object} params - Parameters object
 * @returns {object} { videoFilePath, videoFileSize, status }
 */
export async function waitForFileExtraction(params) {
    const {
        config,
        status: initialStatus,
        nzoId,
        decodedTitle,
        type,
        id,
        sabnzbdConfig,
        res
    } = params;

    let status = initialStatus;
    let videoFilePath = null;
    let videoFileSize = 0;

    const fileServerUrl = config.fileServerUrl || process.env.USENET_FILE_SERVER_URL;

    // Extract actual folder name from status
    let actualFolderName = decodedTitle;
    if (status.incompletePath) {
        actualFolderName = path.basename(status.incompletePath);
        console.log(`[USENET] Using actual folder name from SABnzbd: ${actualFolderName}`);
    } else if (status.name) {
        actualFolderName = status.name;
        console.log(`[USENET] Using folder name from status: ${actualFolderName}`);
    }

    // Wait for video file to be extracted - poll more frequently for faster streaming
    const maxWaitForFile = 120000; // 2 minutes max
    const fileCheckInterval = 500; // Check every 0.5 seconds (optimized for faster streaming)
    const fileCheckStart = Date.now();
    let searchPath = null;

    while (Date.now() - fileCheckStart < maxWaitForFile) {
        // Try to find video file in incomplete folder first (for progressive streaming)
        if (status.status === 'downloading') {
            // Build path to incomplete download folder
            if (sabnzbdConfig?.incompleteDir) {
                searchPath = path.join(sabnzbdConfig.incompleteDir, decodedTitle);
            } else if (status.incompletePath) {
                searchPath = status.incompletePath;
            }

            console.log(`[USENET] Checking for video file in: ${searchPath}`);

            if (fileServerUrl) {
                const fileInfo = await findVideoFileViaAPI(
                    fileServerUrl,
                    decodedTitle,
                    type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {},
                    config.fileServerPassword
                );

                if (fileInfo) {
                    // Use the full path from the file server (no cleaning needed)
                    videoFilePath = `${fileServerUrl.replace(/\/$/, '')}/${fileInfo.path}`;
                    videoFileSize = fileInfo.size;
                    console.log('[USENET] Found video file via API:', videoFilePath);
                    break;
                } else {
                    console.log(`[USENET] Video file not found yet via API. Progress: ${status.percentComplete?.toFixed(1) || 0}%`);
                }
            } else if (searchPath && fs.existsSync(searchPath)) {
                // Fallback to direct filesystem search
                videoFilePath = await findVideoFile(
                    searchPath,
                    decodedTitle,
                    type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {}
                );
                if (videoFilePath) {
                    console.log('[USENET] Found video file in download folder:', videoFilePath);
                    break;
                }
            }

            if (!videoFilePath && !fileServerUrl && searchPath && fs.existsSync(searchPath)) {
                // Check for 7z files - NOT SUPPORTED
                let files = [];
                try {
                    files = fs.readdirSync(searchPath);
                } catch (e) {
                    console.log(`[USENET] Could not list directory: ${e.message}`);
                }

                const has7zFiles = files.some(f => {
                    const lower = f.toLowerCase();
                    return lower.endsWith('.7z') || lower.match(/\.7z\.\d+$/);
                });
                if (has7zFiles) {
                    console.log('[USENET] ⚠️ 7z archive detected - not supported (only RAR and direct video files)');
                }
            }
        }

        // If complete, get from complete folder
        if (status.status === 'completed' && status.path) {
            console.log('[USENET] Download completed, looking in complete folder:', status.path);

            const hasRarFiles = fs.existsSync(status.path) &&
                fs.readdirSync(status.path).some(f => f.toLowerCase().match(/\.(rar|r\d+)$/));

            if (hasRarFiles && fileServerUrl) {
                console.log('[USENET] Completed RAR archive detected, using file server API with rar2fs');
                const fileInfo = await findVideoFileViaAPI(
                    fileServerUrl,
                    decodedTitle,
                    type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {},
                    config.fileServerPassword
                );
                if (fileInfo) {
                    // Use the full path from the file server (no cleaning needed)
                    videoFilePath = `${fileServerUrl.replace(/\/$/, '')}/${fileInfo.path}`;
                    videoFileSize = fileInfo.size;
                    console.log('[USENET] Found video file via API (completed):', videoFilePath);
                    break;
                }
            } else {
                // Direct video file (no RAR)
                videoFilePath = await findVideoFile(
                    status.path,
                    decodedTitle,
                    type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {}
                );
                if (videoFilePath) {
                    console.log('[USENET] Found direct video file (completed):', videoFilePath);
                    break;
                }
            }
        }

        // File not found yet, wait and refresh status
        console.log(`[USENET] Video file not extracted yet, waiting... Progress: ${status.percentComplete?.toFixed(1) || 0}%`);
        await new Promise(resolve => setTimeout(resolve, fileCheckInterval));
        status = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);

        // Check for failures
        if (status.status === 'error' || status.status === 'failed') {
            const errorMsg = `Download failed: ${status.error || status.failMessage || 'Unknown error'}`;
            console.log(`[USENET] ${errorMsg}`);
            throw new Error(errorMsg);
        }

        // Handle 'notfound' status - download may have been removed from queue/history
        if (status.status === 'notfound') {
            console.log(`[USENET] Download ${nzoId} not found in SABnzbd queue or history`);
            console.log(`[USENET] This usually means the download completed and was removed from history`);
            console.log(`[USENET] Will try to find the file one more time before timing out...`);

            // Try one last time to find the file in complete folder via file server
            if (fileServerUrl) {
                const fileInfo = await findVideoFileViaAPI(
                    fileServerUrl,
                    decodedTitle,
                    type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {},
                    config.fileServerPassword
                );

                if (fileInfo) {
                    videoFilePath = `${fileServerUrl.replace(/\/$/, '')}/${fileInfo.path}`;
                    videoFileSize = fileInfo.size;
                    console.log('[USENET] ✓ Found video file via API after notfound status:', videoFilePath);
                    break;
                } else {
                    throw new Error(
                        `Download ${nzoId} not found in SABnzbd. ` +
                        `It may have been removed from history or failed. ` +
                        `Check SABnzbd history for details.`
                    );
                }
            } else {
                throw new Error(
                    `Download ${nzoId} not found in SABnzbd and file server not configured. ` +
                    `Cannot locate the video file.`
                );
            }
        }
    }

    // Check if file was found
    const isUrl = videoFilePath && (videoFilePath.startsWith('http://') || videoFilePath.startsWith('https://'));
    const fileExists = isUrl ? true : (videoFilePath && fs.existsSync(videoFilePath));

    if (!videoFilePath || !fileExists) {
        throw new Error(
            `Download in progress: ${status.percentComplete?.toFixed(1) || 0}%. ` +
            `Video file not yet available from archive. Please try again in a moment.`
        );
    }

    console.log('[USENET] Streaming from:', videoFilePath);

    return {
        videoFilePath,
        videoFileSize,
        status,
        searchPath
    };
}

export default waitForFileExtraction;
