/**
 * Range request handling for video seeking
 * Handles HTTP Range headers for seeking within video files
 * ~200+ lines of logic extracted from main stream handler
 */

import fs from 'fs';
import SABnzbd from '../../lib/sabnzbd.js';

/**
 * Wait for file extraction to catch up with seek position
 * Handles seeking beyond currently extracted range
 */
export async function waitForExtractionCatchup(params) {
    const {
        bytePosition,
        videoFilePath,
        streamInfo,
        nzoId,
        status,
        currentFileSize,
        res
    } = params;

    const targetSize = bytePosition + (10 * 1024 * 1024); // Need 10MB past seek point
    const waitMessage = bytePosition >= currentFileSize
        ? `Seeking beyond extracted range (${(bytePosition / 1024 / 1024).toFixed(1)} MB requested, only ${(currentFileSize / 1024 / 1024).toFixed(1)} MB extracted)`
        : `Seeking too close to extraction edge (${(currentFileSize - bytePosition) / 1024 / 1024} MB buffer)`;

    console.log(`[USENET] ⚠️ ${waitMessage}. Waiting for extraction to reach ${(targetSize / 1024 / 1024).toFixed(1)} MB...`);

    // Wait for extraction to catch up
    const maxWaitTime = 2 * 60 * 1000; // 2 minutes max
    const startWait = Date.now();

    while (Date.now() - startWait < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds

        // Re-check file size
        const newFileSize = fs.statSync(videoFilePath).size;
        const newStatus = await SABnzbd.getDownloadStatus(
            streamInfo.config.sabnzbdUrl,
            streamInfo.config.sabnzbdApiKey,
            nzoId
        );

        console.log(`[USENET] ⏳ Extraction progress: ${(newFileSize / 1024 / 1024).toFixed(1)} MB (target: ${(targetSize / 1024 / 1024).toFixed(1)} MB), download: ${newStatus.percentComplete?.toFixed(1)}%`);

        if (newFileSize >= targetSize) {
            const seekPercent = streamInfo.fileSize > 0
                ? (bytePosition / streamInfo.fileSize * 100).toFixed(1)
                : '?';
            console.log(`[USENET] ✓ Extraction caught up! Proceeding with seek to ${seekPercent}%`);
            // Update file size estimate
            streamInfo.fileSize = Math.max(streamInfo.fileSize, newFileSize);
            return { success: true };
        }

        // Check if download failed
        if (newStatus.status === 'failed' || newStatus.status === 'error') {
            throw new Error(`Download failed: ${newStatus.error || 'Unknown error'}`);
        }
    }

    // If we timed out, send error
    const finalFileSize = fs.statSync(videoFilePath).size;
    if (finalFileSize < targetSize) {
        const seekPercent = streamInfo.fileSize > 0
            ? (bytePosition / streamInfo.fileSize * 100).toFixed(1)
            : '?';
        return {
            success: false,
            status: 416,
            message: `Cannot seek to ${seekPercent}% yet. File extraction is still in progress.\n\n` +
                `Requested position: ${(bytePosition / 1024 / 1024).toFixed(1)} MB\n` +
                `Extracted so far: ${(finalFileSize / 1024 / 1024).toFixed(1)} MB\n` +
                `Download progress: ${status.percentComplete?.toFixed(1)}%\n\n` +
                `Please try seeking to a lower position or wait for more of the file to extract.`
        };
    }

    return { success: true };
}

/**
 * Check if MKV file has enough extraction for seeking
 * MKV files store index at end of file, need 80% extracted
 */
export function checkMKVSeekability(videoFilePath, bytePosition, currentFileSize, streamInfo, status) {
    const isMKV = videoFilePath.toLowerCase().endsWith('.mkv');
    const extractionPercent = streamInfo.fileSize > 0 ? (currentFileSize / streamInfo.fileSize * 100) : 0;
    const mkvSeekThreshold = 80; // Need 80% extracted for MKV seeking

    if (isMKV && bytePosition > 0 && extractionPercent < mkvSeekThreshold) {
        console.log(`[USENET] ⚠️ MKV file only ${extractionPercent.toFixed(1)}% extracted - seeking may not work until ${mkvSeekThreshold}% (MKV index usually at end of file)`);
        return {
            error: true,
            status: 416,
            message: `⚠️ Seeking not yet available for this MKV file.\n\n` +
                `MKV files store their seeking index at the end of the file.\n` +
                `Extraction progress: ${extractionPercent.toFixed(1)}%\n` +
                `Seeking available at: ${mkvSeekThreshold}%\n` +
                `Download progress: ${status.percentComplete?.toFixed(1)}%\n\n` +
                `Please start from the beginning or wait for more extraction.\n` +
                `The video will play normally from the start.`
        };
    }

    return { error: false };
}

/**
 * Handle range request for incomplete file being extracted
 * Waits for download to catch up if user is seeking ahead
 */
export async function handleRangeRequestForIncompleteFile(params) {
    const {
        rangeHeader,
        status,
        videoFilePath,
        config,
        nzoId,
        videoFileSize,
        res
    } = params;

    if (!rangeHeader || status.status !== 'downloading') {
        return { handled: false };
    }

    const rangeMatch = rangeHeader.match(/bytes=(\d+)-/);
    if (!rangeMatch) {
        return { handled: false };
    }

    const requestedByte = parseInt(rangeMatch[1]);

    // Get video file size
    let actualVideoFileSize = videoFileSize;
    if (fs.existsSync(videoFilePath)) {
        actualVideoFileSize = fs.statSync(videoFilePath).size;
    } else if (status.bytesTotal && status.bytesTotal > 0) {
        // Estimate video size
        actualVideoFileSize = status.bytesTotal * 0.9;
    }

    if (actualVideoFileSize > 0 && requestedByte > 0) {
        const requestedPercent = Math.min((requestedByte / actualVideoFileSize) * 100, 100);
        let downloadPercent = status.percentComplete || 0;

        console.log(`[USENET] User resuming from ${requestedPercent.toFixed(1)}%, download at ${downloadPercent.toFixed(1)}%`);

        // If user is trying to seek ahead of download, wait for download to catch up
        if (requestedPercent > downloadPercent + 5) { // +5% buffer for safety
            const targetPercent = Math.min(requestedPercent + 10, 100);
            console.log(`[USENET] ⏳ User requesting ${requestedPercent.toFixed(1)}% (byte ${requestedByte}), download at ${downloadPercent.toFixed(1)}%, waiting for ${targetPercent.toFixed(1)}%...`);

            // Wait in loop until download catches up
            const maxWaitTime = 5 * 60 * 1000; // Max 5 minutes
            const startWaitTime = Date.now();

            while (downloadPercent < targetPercent) {
                // Check if we've waited too long
                if (Date.now() - startWaitTime > maxWaitTime) {
                    return {
                        handled: true,
                        error: true,
                        status: 408,
                        message: `Download not progressing fast enough to reach your playback position.\n\n` +
                            `Your position: ${requestedPercent.toFixed(1)}%\n` +
                            `Download progress: ${downloadPercent.toFixed(1)}%\n\n` +
                            `Please try starting from the beginning or wait for more of the file to download.`
                    };
                }

                // Wait 2 seconds before checking again
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Refresh download status
                const newStatus = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);
                downloadPercent = newStatus.percentComplete || 0;

                console.log(`[USENET] ⏳ Waiting for download: ${downloadPercent.toFixed(1)}% / ${targetPercent.toFixed(1)}%`);

                // Check for download failures
                if (newStatus.status === 'error' || newStatus.status === 'failed') {
                    return {
                        handled: true,
                        error: true,
                        status: 500,
                        message: `Download failed: ${newStatus.error || newStatus.failMessage || 'Unknown error'}`
                    };
                }

                // If download completed, break out and stream
                if (newStatus.status === 'completed') {
                    console.log('[USENET] Download completed while waiting');
                    break;
                }
            }

            console.log(`[USENET] ✓ Download reached ${downloadPercent.toFixed(1)}%, proceeding with stream`);
        }
    }

    return { handled: false };
}

/**
 * Stream file with range support
 * Handles both range requests (partial content) and full file streaming
 */
export async function streamFileWithRange(params) {
    const {
        req,
        res,
        videoFilePath,
        stat,
        estimatedFileSize,
        isBeingExtracted,
        status,
        config,
        nzoId
    } = params;

    const range = req.headers.range;
    let fileSize = estimatedFileSize;

    console.log(`[USENET] File info - Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB, Being extracted: ${isBeingExtracted}`);

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

        // Clamp end to actual file size on disk
        end = Math.min(end, stat.size - 1);

        console.log(`[USENET] Range request: ${start}-${end}, File size: ${stat.size}`);

        // Check if requested range is beyond what's available
        if (start >= stat.size) {
            // Range not yet available - wait for it if file is still being extracted
            if (isBeingExtracted || status.status === 'downloading') {
                console.log(`[USENET] Range ${start}-${end} not yet available, file size: ${stat.size} bytes`);

                // Wait up to 60 seconds for the file to grow
                const maxWait = 60000;
                const startWait = Date.now();
                const pollInterval = 2000;

                while (Date.now() - startWait < maxWait) {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));

                    // Re-check file size again
                    const newStat = fs.statSync(videoFilePath);
                    console.log(`[USENET] Waiting for file to grow... Current size: ${(newStat.size / 1024 / 1024).toFixed(2)} MB`);

                    if (start < newStat.size) {
                        // Range is now available
                        const newEnd = Math.min(end, newStat.size - 1);
                        const chunksize = (newEnd - start) + 1;
                        const file = fs.createReadStream(videoFilePath, { start, end: newEnd });

                        const headers = {
                            'Content-Range': `bytes ${start}-${newEnd}/${newStat.size}`,
                            'Accept-Ranges': 'bytes',
                            'Content-Length': chunksize,
                            'Content-Type': 'video/mp4',
                            'Cache-Control': 'no-cache',
                        };

                        console.log(`[USENET] Range now available: ${start}-${newEnd}/${newStat.size}`);
                        res.writeHead(206, headers);
                        return file.pipe(res);
                    }
                }

                // Timeout waiting
                return res.status(416).send(
                    `Requested position not yet available. ` +
                    `File is still being extracted. Please try again in a moment.`
                );
            } else {
                return res.status(416).send('Requested range not available.');
            }
        }

        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoFilePath, { start, end });

        const headers = {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-cache',
        };

        res.writeHead(206, headers);
        file.pipe(res);

        // Log seek operation
        if (start > 0) {
            console.log(`[USENET] Serving range: ${start}-${end}/${stat.size} (${(start / stat.size * 100).toFixed(1)}% into file)`);
        }
    } else {
        // No range, stream from beginning
        const headers = {
            'Content-Length': stat.size,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
        };

        console.log(`[USENET] Streaming from beginning, file size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
        res.writeHead(200, headers);
        fs.createReadStream(videoFilePath).pipe(res);
    }

    // Monitor download progress in background
    if (status.status === 'downloading') {
        console.log(`[USENET] Streaming while downloading: ${status.percentComplete?.toFixed(1)}% complete`);
    }
}

export default {
    waitForExtractionCatchup,
    checkMKVSeekability,
    handleRangeRequestForIncompleteFile,
    streamFileWithRange
};
