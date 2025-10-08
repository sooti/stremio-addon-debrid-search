#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import serverless from './serverless.js';
import requestIp from 'request-ip';
import rateLimit from 'express-rate-limit';
import swStats from 'swagger-stats';
import addonInterface from "./addon.js";
import streamProvider from './lib/stream-provider.js';
import * as mongoCache from './lib/common/mongo-cache.js';
import http from 'http';
import https from 'https';
import * as scraperCache from './lib/util/scraper-cache.js';
import Usenet from './lib/usenet.js';
import Newznab from './lib/newznab.js';
import SABnzbd from './lib/sabnzbd.js';
import fs from 'fs';
import path from 'path';

const RESOLVED_URL_CACHE = new Map();
const PENDING_RESOLVES = new Map();

// Track active Usenet streams: nzoId -> { lastAccess, streamCount, config, videoFilePath, usenetConfig }
const ACTIVE_USENET_STREAMS = new Map();

// Store Usenet configs globally (so auto-clean works even without active streams)
const USENET_CONFIGS = new Map(); // fileServerUrl -> config

// Cleanup interval for inactive streams (check every 2 minutes)
const STREAM_CLEANUP_INTERVAL = 2 * 60 * 1000;
// Delete downloads after 10 minutes of inactivity
// This is aggressive to save bandwidth and disk space
// If user was just paused/buffering, they can restart the stream
const STREAM_INACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity

const app = express();
app.enable('trust proxy');
app.use(cors());

// Swagger stats middleware (unchanged)
app.use(swStats.getMiddleware({
    name: addonInterface.manifest.name,
    version: addonInterface.manifest.version,
}));

// Rate limiter middleware (unchanged)
const rateLimiter = rateLimit({
    windowMs: 120 * 120 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => requestIp.getClientIp(req)
});

// Tune server timeouts for high traffic and keep-alive performance
try {
    server.keepAliveTimeout = parseInt(process.env.HTTP_KEEPALIVE_TIMEOUT || "65000", 10);
    server.headersTimeout = parseInt(process.env.HTTP_HEADERS_TIMEOUT || "72000", 10);
} catch (_) {}

// Graceful shutdown
for (const sig of ["SIGINT","SIGTERM"]) {
    process.on(sig, () => {
        console.log(`[SERVER] Received ${sig}. Shutting down...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000).unref();
    });
}
app.use(rateLimiter);

// VVVV REVERTED: The resolver now performs a simple redirect VVVV
app.get('/resolve/:debridProvider/:debridApiKey/:url', async (req, res) => {
    const { debridProvider, debridApiKey, url } = req.params;
    const decodedUrl = decodeURIComponent(url);
    const clientIp = requestIp.getClientIp(req);
    const cacheKey = `${debridProvider}:${decodedUrl}`;

    try {
        let finalUrl;

        if (RESOLVED_URL_CACHE.has(cacheKey)) {
            finalUrl = RESOLVED_URL_CACHE.get(cacheKey);
            console.log(`[CACHE] Using cached URL for key: ${cacheKey}`);
        } else if (PENDING_RESOLVES.has(cacheKey)) {
            console.log(`[RESOLVER] Joining in-flight resolve for key: ${cacheKey}`);
            finalUrl = await PENDING_RESOLVES.get(cacheKey);
        } else {
            console.log(`[RESOLVER] Cache miss. Resolving URL for ${debridProvider}: ${decodedUrl}`);
            const p = streamProvider.resolveUrl(debridProvider, debridApiKey, null, decodedUrl, clientIp);
            const timed = Promise.race([ p, new Promise((_, rej) => setTimeout(() => rej(new Error('Resolve timeout')), 20000)) ]);
            PENDING_RESOLVES.set(cacheKey, timed.finally(() => PENDING_RESOLVES.delete(cacheKey)));
            finalUrl = await timed;

            if (finalUrl) {
                RESOLVED_URL_CACHE.set(cacheKey, finalUrl);
                setTimeout(() => RESOLVED_URL_CACHE.delete(cacheKey), 2 * 60 * 60 * 1000);
            }
        }

        if (finalUrl) {
            console.log("[RESOLVER] Redirecting to final stream URL:", finalUrl);
            // Issue a 302 redirect to the final URL.
            res.redirect(302, finalUrl);
        } else {
            res.status(404).send('Could not resolve link');
        }
    } catch (error) {
        console.error("[RESOLVER] A critical error occurred:", error.message);
        res.status(500).send("Error resolving stream.");
    }
});

// Middleware to check admin token
function checkAdminAuth(req, res, next) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
        return res.status(503).json({
            success: false,
            message: 'Admin endpoints disabled. Set ADMIN_TOKEN environment variable to enable.'
        });
    }

    const providedToken = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
    if (providedToken !== adminToken) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized. Invalid or missing admin token.'
        });
    }

    next();
}

// Endpoint to manually clear in-memory scraper cache
app.get('/admin/clear-scraper-cache', checkAdminAuth, (req, res) => {
    const cleared = scraperCache.clear();
    res.json({
        success: true,
        message: `In-memory scraper cache cleared successfully`,
        entriesCleared: cleared
    });
});

// Endpoint to clear MongoDB search cache (stream results)
app.get('/admin/clear-search-cache', checkAdminAuth, async (req, res) => {
    const result = await mongoCache.clearSearchCache();
    res.json(result);
});

// Endpoint to clear MongoDB torrent hash cache (optionally for specific service)
app.get('/admin/clear-torrent-cache', checkAdminAuth, async (req, res) => {
    const service = req.query.service; // Optional: ?service=realdebrid or ?service=alldebrid
    const result = await mongoCache.clearTorrentCache(service);
    res.json(result);
});

// Endpoint to clear ALL MongoDB cache (search results + torrent metadata)
app.get('/admin/clear-all-cache', checkAdminAuth, async (req, res) => {
    const result = await mongoCache.clearAllCache();
    res.json(result);
});

// Endpoint to view active Usenet streams
app.get('/admin/usenet-streams', checkAdminAuth, (req, res) => {
    const streams = [];
    const now = Date.now();

    for (const [streamKey, streamInfo] of ACTIVE_USENET_STREAMS.entries()) {
        const inactiveTime = Math.round((now - streamInfo.lastAccess) / 1000 / 60); // minutes
        streams.push({
            streamKey,
            isPersonal: streamInfo.isPersonal || false,
            activeConnections: streamInfo.activeConnections || 0,
            completionPercentage: streamInfo.completionPercentage || 0,
            totalRequests: streamInfo.streamCount,
            lastAccessMinutesAgo: inactiveTime,
            willCleanupIn: Math.max(0, Math.round((STREAM_INACTIVE_TIMEOUT - (now - streamInfo.lastAccess)) / 1000 / 60)),
            deleteOnStop: streamInfo.usenetConfig?.deleteOnStreamStop || false
        });
    }

    res.json({
        success: true,
        activeStreams: streams.length,
        streams: streams,
        cleanupInterval: `${STREAM_CLEANUP_INTERVAL / 1000 / 60} minutes`,
        inactiveTimeout: `${STREAM_INACTIVE_TIMEOUT / 1000 / 60} minutes`
    });
});

// Endpoint to manually trigger stream cleanup
app.post('/admin/cleanup-streams', checkAdminAuth, async (req, res) => {
    try {
        await cleanupInactiveStreams();
        res.json({
            success: true,
            message: 'Stream cleanup completed'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Delete file from file server
 */
async function deleteFileFromServer(fileServerUrl, filePath) {
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
async function cleanupInactiveStreams() {
    const now = Date.now();
    console.log('[USENET-CLEANUP] Checking for inactive streams...');

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
                console.log(`[USENET-CLEANUP] User stopped streaming, deleting incomplete download: ${nzoId} (${status.percentComplete?.toFixed(1)}%)`);

                // Delete download from SABnzbd
                const deleted = await SABnzbd.deleteItem(
                    streamInfo.config.sabnzbdUrl,
                    streamInfo.config.sabnzbdApiKey,
                    nzoId,
                    true // Delete files
                );

                if (deleted) {
                    console.log(`[USENET-CLEANUP] ✓ Deleted download and files: ${nzoId}`);
                }

                // Also delete from file server if configured
                if (shouldDeleteFile && streamInfo.videoFilePath && streamInfo.usenetConfig?.fileServerUrl) {
                    console.log(`[USENET-CLEANUP] Deleting file from file server: ${streamInfo.videoFilePath}`);
                    await deleteFileFromServer(streamInfo.usenetConfig.fileServerUrl, streamInfo.videoFilePath);
                }

                ACTIVE_USENET_STREAMS.delete(nzoId);
            } else if (status.status === 'completed') {
                console.log(`[USENET-CLEANUP] Download completed: ${nzoId}`);

                // Delete file from file server if configured
                if (shouldDeleteFile && streamInfo.videoFilePath && streamInfo.usenetConfig?.fileServerUrl) {
                    console.log(`[USENET-CLEANUP] deleteOnStreamStop enabled, deleting file from server`);
                    await deleteFileFromServer(streamInfo.usenetConfig.fileServerUrl, streamInfo.videoFilePath);
                }

                // Remove from tracking
                ACTIVE_USENET_STREAMS.delete(nzoId);
            } else {
                // Not found or failed, remove from tracking
                ACTIVE_USENET_STREAMS.delete(nzoId);
            }
        }
    }
}

// Schedule cleanup every 15 minutes
setInterval(() => {
    cleanupInactiveStreams().catch(err => {
        console.error('[USENET-CLEANUP] Error during cleanup:', err.message);
    });
}, STREAM_CLEANUP_INTERVAL);

/**
 * Auto-clean old files from file server based on age
 * Uses globally stored configs, works even without active streams
 */
async function autoCleanOldFiles() {
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
            const response = await axios.get(`${fileServerUrl.replace(/\/$/, '')}/api/list`, { timeout: 10000 });

            if (!response.data?.files) {
                console.log(`[USENET-AUTO-CLEAN] No files found on ${fileServerUrl}`);
                continue;
            }

            const files = response.data.files;
            let deletedCount = 0;

            for (const file of files) {
                const fileAgeMs = now - (file.modified * 1000); // Convert to milliseconds

                if (fileAgeMs > ageThresholdMs) {
                    const ageDaysActual = Math.round(fileAgeMs / (24 * 60 * 60 * 1000));
                    console.log(`[USENET-AUTO-CLEAN] File is ${ageDaysActual} days old, deleting: ${file.path}`);

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

// Schedule auto-clean every hour
const AUTO_CLEAN_INTERVAL = 60 * 60 * 1000; // 1 hour
setInterval(() => {
    autoCleanOldFiles().catch(err => {
        console.error('[USENET-AUTO-CLEAN] Error during auto-clean:', err.message);
    });
}, AUTO_CLEAN_INTERVAL);

// Run auto-clean on startup after 5 minutes
setTimeout(() => {
    autoCleanOldFiles().catch(err => {
        console.error('[USENET-AUTO-CLEAN] Error during startup auto-clean:', err.message);
    });
}, 5 * 60 * 1000);

/**
 * Monitor active streams and manage SABnzbd pause/resume
 * - Resume downloads when playback is getting close to download position
 * - Resume downloads when user stops streaming
 */
async function monitorStreamDownloads() {
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

// Schedule monitoring every 30 seconds
const STREAM_MONITOR_INTERVAL = 30 * 1000; // 30 seconds
setInterval(() => {
    monitorStreamDownloads().catch(err => {
        console.error('[USENET-MONITOR] Error during monitoring:', err.message);
    });
}, STREAM_MONITOR_INTERVAL);

/**
 * Check for orphaned paused downloads on startup
 * Resume any paused downloads that aren't actively being streamed
 * This handles server restarts while downloads were paused
 */
async function checkOrphanedPausedDownloads() {
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

// Run orphaned download check on startup after 10 seconds
setTimeout(() => {
    checkOrphanedPausedDownloads().catch(err => {
        console.error('[USENET-STARTUP] Error checking orphaned downloads:', err.message);
    });
}, 10 * 1000);

// Helper function to find video file in directory (including incomplete)
async function findVideoFile(baseDir, fileName, options = {}) {
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg'];

    try {
        if (!fs.existsSync(baseDir)) {
            return null;
        }

        // Check if baseDir is directly a file
        const stat = fs.statSync(baseDir);
        if (stat.isFile()) {
            const ext = path.extname(baseDir).toLowerCase();
            if (videoExtensions.includes(ext)) {
                return baseDir;
            }
        }

        // Search in directory
        const files = fs.readdirSync(baseDir, { withFileTypes: true, recursive: true });

        // Filter video files and exclude samples
        let videoFiles = files
            .filter(f => f.isFile())
            .map(f => path.join(baseDir, f.name))
            .filter(p => videoExtensions.includes(path.extname(p).toLowerCase()))
            .filter(p => !path.basename(p).toLowerCase().includes('sample')); // Exclude sample files

        if (videoFiles.length === 0) {
            return null;
        }

        // For series, try to match season/episode
        if (options.season && options.episode) {
            const PTT = (await import('./lib/util/parse-torrent-title.js')).default;
            const matchedFile = videoFiles.find(file => {
                const parsed = PTT.parse(path.basename(file));
                return parsed.season === Number(options.season) && parsed.episode === Number(options.episode);
            });
            if (matchedFile) return matchedFile;
        }

        // Return largest file
        const filesWithSize = videoFiles.map(f => ({ path: f, size: fs.statSync(f).size }));
        filesWithSize.sort((a, b) => b.size - a.size);
        return filesWithSize[0]?.path || null;

    } catch (error) {
        console.error('[USENET] Error finding video file:', error.message);
        return null;
    }
}

// Usenet video readiness polling endpoint
app.get('/usenet/poll/:nzbUrl/:title/:type/:id', async (req, res) => {
    const { nzbUrl, title, type, id } = req.params;

    try {
        const configJson = req.query.config;
        if (!configJson) {
            return res.status(400).json({ ready: false, error: 'Missing configuration' });
        }

        const config = JSON.parse(decodeURIComponent(configJson));

        if (!config.newznabUrl || !config.newznabApiKey || !config.sabnzbdUrl || !config.sabnzbdApiKey) {
            return res.status(400).json({ ready: false, error: 'Usenet not configured' });
        }

        const decodedNzbUrl = decodeURIComponent(nzbUrl);
        const decodedTitle = decodeURIComponent(title);

        // Check if already downloading
        let nzoId = null;
        for (const [downloadId, info] of Usenet.activeDownloads.entries()) {
            if (info.name === decodedTitle) {
                nzoId = downloadId;
                break;
            }
        }

        if (!nzoId) {
            return res.json({ ready: false, progress: 0, message: 'Download not started' });
        }

        // Get current status
        const status = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);

        if (status.status === 'error' || status.status === 'failed') {
            return res.json({ ready: false, error: status.error || status.failMessage || 'Download failed' });
        }

        // Try to find video file
        let videoFilePath = null;
        const sabnzbdConfig = await SABnzbd.getConfig(config.sabnzbdUrl, config.sabnzbdApiKey);
        let searchPath = null;

        if (status.status === 'downloading' && sabnzbdConfig?.incompleteDir) {
            searchPath = path.join(sabnzbdConfig.incompleteDir, decodedTitle);
        } else if (status.status === 'completed' && status.path) {
            searchPath = status.path;
        } else if (status.incompletePath) {
            searchPath = status.incompletePath;
        }

        if (searchPath && fs.existsSync(searchPath)) {
            videoFilePath = await findVideoFile(
                searchPath,
                decodedTitle,
                type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {}
            );
        }

        // Return status
        if (videoFilePath && fs.existsSync(videoFilePath)) {
            return res.json({
                ready: true,
                progress: status.percentComplete || 0,
                status: status.status,
                message: 'Video file ready for streaming'
            });
        } else {
            return res.json({
                ready: false,
                progress: status.percentComplete || 0,
                status: status.status,
                message: `Extracting files... ${status.percentComplete?.toFixed(1) || 0}% downloaded`
            });
        }

    } catch (error) {
        console.error('[USENET] Polling error:', error.message);
        return res.json({ ready: false, error: error.message });
    }
});

// Personal file streaming endpoint (files already on server)
// PROXY through Node.js to track when stream stops
app.get('/usenet/personal/*', async (req, res) => {
    try {
        const configJson = req.query.config;
        if (!configJson) {
            return res.status(400).send('Missing configuration');
        }

        const config = JSON.parse(decodeURIComponent(configJson));

        // Extract the file path from the URL (everything after /usenet/personal/)
        const filePath = req.params[0];
        const decodedFilePath = decodeURIComponent(filePath);

        console.log(`[USENET-PERSONAL] Stream request for personal file: ${decodedFilePath}`);

        // Track this access for cleanup purposes
        const fileKey = `personal:${decodedFilePath}`;
        if (!ACTIVE_USENET_STREAMS.has(fileKey)) {
            ACTIVE_USENET_STREAMS.set(fileKey, {
                lastAccess: Date.now(),
                streamCount: 1,
                activeConnections: 0,
                maxBytePosition: 0,
                fileSize: 0,
                completionPercentage: 0,
                config: {
                    sabnzbdUrl: config.sabnzbdUrl,
                    sabnzbdApiKey: config.sabnzbdApiKey
                },
                videoFilePath: decodedFilePath,
                usenetConfig: config,
                isPersonal: true
            });
            console.log(`[USENET-PERSONAL] Tracking new personal stream: ${fileKey}`);
        }

        const streamInfo = ACTIVE_USENET_STREAMS.get(fileKey);
        streamInfo.lastAccess = Date.now();
        streamInfo.activeConnections++;

        // Store config globally for auto-clean (even when no active streams)
        if (config.fileServerUrl && config.autoCleanOldFiles) {
            USENET_CONFIGS.set(config.fileServerUrl, config);
            console.log(`[USENET-PERSONAL] Stored config for auto-clean: ${config.fileServerUrl}`);
        }

        // Track range requests to calculate completion
        if (req.headers.range) {
            const rangeMatch = req.headers.range.match(/bytes=(\d+)-(\d*)/);
            if (rangeMatch) {
                const startByte = parseInt(rangeMatch[1]);
                if (startByte > streamInfo.maxBytePosition) {
                    streamInfo.maxBytePosition = startByte;
                }
            }
        }

        // Track connection close to detect when stream stops
        req.on('close', () => {
            streamInfo.activeConnections--;
            console.log(`[USENET-PERSONAL] Connection closed for ${fileKey}, active connections: ${streamInfo.activeConnections}, completion: ${streamInfo.completionPercentage}%`);

            // If no more active connections and deleteOnStreamStop is enabled
            if (streamInfo.activeConnections === 0 && streamInfo.usenetConfig?.deleteOnStreamStop) {
                // Only delete if user watched at least 90% of the file (they finished it)
                const completionThreshold = 90;

                if (streamInfo.completionPercentage >= completionThreshold) {
                    console.log(`[USENET-PERSONAL] Stream finished (${streamInfo.completionPercentage}% watched), scheduling delete for: ${fileKey}`);
                    // Wait 30 seconds before deleting (in case user is seeking or reloading)
                    setTimeout(async () => {
                        if (streamInfo.activeConnections === 0) {
                            console.log(`[USENET-PERSONAL] Deleting finished file: ${decodedFilePath}`);
                            await deleteFileFromServer(streamInfo.usenetConfig.fileServerUrl, decodedFilePath);
                            ACTIVE_USENET_STREAMS.delete(fileKey);
                        }
                    }, 30000);
                } else {
                    console.log(`[USENET-PERSONAL] Stream stopped but not finished (${streamInfo.completionPercentage}% < ${completionThreshold}%), keeping file`);
                    // Don't delete, but clean up tracking after 1 hour if no reconnection
                    setTimeout(() => {
                        if (streamInfo.activeConnections === 0) {
                            console.log(`[USENET-PERSONAL] Removing tracking for unfinished stream: ${fileKey}`);
                            ACTIVE_USENET_STREAMS.delete(fileKey);
                        }
                    }, 60 * 60 * 1000); // 1 hour
                }
            }
        });

        // PROXY the request to file server (don't redirect)
        const fileServerUrl = config.fileServerUrl.replace(/\/$/, '');
        const proxyUrl = `${fileServerUrl}/${filePath}`;

        console.log(`[USENET-PERSONAL] Proxying to file server: ${proxyUrl}`);

        // Forward the request to file server with range headers
        const axios = (await import('axios')).default;
        const headers = {};
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await axios.get(proxyUrl, {
            headers,
            responseType: 'stream',
            validateStatus: (status) => status < 500
        });

        // Forward response headers
        res.status(response.status);
        Object.keys(response.headers).forEach(key => {
            res.setHeader(key, response.headers[key]);
        });

        // Extract file size from Content-Range or Content-Length
        if (response.headers['content-range']) {
            const rangeMatch = response.headers['content-range'].match(/bytes \d+-\d+\/(\d+)/);
            if (rangeMatch) {
                streamInfo.fileSize = parseInt(rangeMatch[1]);
            }
        } else if (response.headers['content-length']) {
            streamInfo.fileSize = parseInt(response.headers['content-length']);
        }

        // Calculate completion percentage
        if (streamInfo.fileSize > 0) {
            streamInfo.completionPercentage = Math.round((streamInfo.maxBytePosition / streamInfo.fileSize) * 100);
        }

        // Pipe the response
        response.data.pipe(res);

    } catch (error) {
        console.error('[USENET-PERSONAL] Error:', error.message);
        if (!res.headersSent) {
            return res.status(500).send('Error streaming personal file');
        }
    }
});

// Usenet progressive streaming endpoint with range request support
app.get('/usenet/stream/:nzbUrl/:title/:type/:id', async (req, res) => {
    const { nzbUrl, title, type, id } = req.params;

    try {
        const configJson = req.query.config;
        if (!configJson) {
            return res.status(400).send('Missing configuration');
        }

        const config = JSON.parse(decodeURIComponent(configJson));

        if (!config.newznabUrl || !config.newznabApiKey || !config.sabnzbdUrl || !config.sabnzbdApiKey) {
            return res.status(400).send('Usenet not configured');
        }

        const decodedNzbUrl = decodeURIComponent(nzbUrl);
        const decodedTitle = decodeURIComponent(title);

        console.log('[USENET] Stream request for:', decodedTitle);

        // Check disk space first
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
                return res.status(507).send(
                    `⚠️ Insufficient storage space!\n\n` +
                    `Available: ${diskSpace.incompleteDir.available}\n` +
                    `Please free up space on your SABnzbd incomplete directory.`
                );
            }
        }

        // Check if already downloading in our memory cache
        let nzoId = null;
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

                // Add to our memory cache
                Usenet.activeDownloads.set(nzoId, {
                    nzoId: nzoId,
                    name: decodedTitle,
                    startTime: Date.now(),
                    status: existing.status
                });

                // Delete all other downloads to prioritize this existing stream
                console.log('[USENET] Deleting all other downloads to prioritize existing stream...');
                const deletedCount = await SABnzbd.deleteAllExcept(
                    config.sabnzbdUrl,
                    config.sabnzbdApiKey,
                    nzoId,
                    true // Delete files
                );
                if (deletedCount > 0) {
                    console.log(`[USENET] ✓ Deleted ${deletedCount} other download(s)`);
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
        }

        // Wait for download to start (just 3% to ensure it's actually downloading)
        console.log('[USENET] Waiting for download to start...');
        let status = await Usenet.waitForStreamingReady(
            config.sabnzbdUrl,
            config.sabnzbdApiKey,
            nzoId,
            3, // 3% minimum - just ensure download has started
            60000 // 1 minute max wait for download to start
        );

        let videoFilePath = null;

        // Get SABnzbd config to find the incomplete directory
        const sabnzbdConfig = await SABnzbd.getConfig(config.sabnzbdUrl, config.sabnzbdApiKey);
        console.log('[USENET] SABnzbd directories:', {
            downloadDir: sabnzbdConfig?.downloadDir,
            incompleteDir: sabnzbdConfig?.incompleteDir
        });

        let searchPath = null;

        // Wait for video file to be extracted - poll more frequently for faster streaming
        const maxWaitForFile = 120000; // 2 minutes max
        const fileCheckInterval = 1000; // Check every 1 second (faster detection)
        const fileCheckStart = Date.now();

        while (Date.now() - fileCheckStart < maxWaitForFile) {
            // Try to find video file in incomplete folder first (for progressive streaming)
            if (status.status === 'downloading') {
                // Build path to incomplete download folder
                if (sabnzbdConfig?.incompleteDir) {
                    searchPath = path.join(sabnzbdConfig.incompleteDir, decodedTitle);
                } else if (status.incompletePath) {
                    searchPath = status.incompletePath;
                }

                // Log what we're checking
                console.log(`[USENET] Checking for video file in: ${searchPath}`);

                // Check for _UNPACK_ folder in the MAIN download directory (not incomplete)
                // SABnzbd extracts files to _UNPACK_ folder in the complete directory during download
                let unpackPath = null;
                if (sabnzbdConfig?.downloadDir) {
                    try {
                        console.log(`[USENET] Searching for _UNPACK_ folder in main download dir: ${sabnzbdConfig.downloadDir}`);
                        const mainDirContents = fs.readdirSync(sabnzbdConfig.downloadDir);

                        // Find _UNPACK_ folder that matches this download
                        const unpackFolder = mainDirContents.find(f => {
                            if (!f.startsWith('_UNPACK_')) return false;
                            // Try to match the download name (first few parts)
                            const nameParts = decodedTitle.split('.').slice(0, 3).join('.');
                            return f.includes(nameParts) || f.replace('_UNPACK_', '').startsWith(nameParts);
                        });

                        if (unpackFolder) {
                            unpackPath = path.join(sabnzbdConfig.downloadDir, unpackFolder);
                            console.log(`[USENET] Found _UNPACK_ folder in main download dir: ${unpackPath}`);
                        } else {
                            console.log(`[USENET] No _UNPACK_ folder found yet in main download dir`);
                        }
                    } catch (e) {
                        console.log(`[USENET] Could not list main download directory: ${e.message}`);
                    }
                }

                // Try the _UNPACK_ folder first (this is where SABnzbd extracts during download)
                if (unpackPath && fs.existsSync(unpackPath)) {
                    console.log(`[USENET] Checking _UNPACK_ folder for video file...`);
                    videoFilePath = await findVideoFile(
                        unpackPath,
                        decodedTitle,
                        type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {}
                    );
                    if (videoFilePath) {
                        console.log('[USENET] Found video file in _UNPACK_ folder:', videoFilePath);
                        break; // Exit the waiting loop
                    }
                }

                // Try the regular download folder
                if (searchPath && fs.existsSync(searchPath)) {
                    // List what's in the directory
                    let files = [];
                    try {
                        files = fs.readdirSync(searchPath);
                        console.log(`[USENET] Files in download directory (${files.length}):`, files.slice(0, 5).join(', '));
                    } catch (e) {
                        console.log(`[USENET] Could not list directory: ${e.message}`);
                    }

                    videoFilePath = await findVideoFile(
                        searchPath,
                        decodedTitle,
                        type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {}
                    );
                    if (videoFilePath) {
                        console.log('[USENET] Found video file in download folder:', videoFilePath);
                        break; // Exit the waiting loop
                    } else {
                        // Check for 7z files - NOT supported for streaming
                        // Match .7z or .7z.001, .7z.002, etc. (split archives)
                        const has7zFiles = files.some(f => {
                            const lower = f.toLowerCase();
                            return lower.endsWith('.7z') || lower.match(/\.7z\.\d+$/);
                        });
                        if (has7zFiles) {
                            console.log('[USENET] ❌ 7z archive detected - not supported for streaming');
                            console.log('[USENET] Found 7z files:', files.filter(f => {
                                const lower = f.toLowerCase();
                                return lower.endsWith('.7z') || lower.match(/\.7z\.\d+$/);
                            }).slice(0, 3).join(', '));

                            // Delete the download immediately
                            await SABnzbd.deleteItem(
                                config.sabnzbdUrl,
                                config.sabnzbdApiKey,
                                nzoId,
                                true // Delete files
                            );
                            console.log('[USENET] ✓ Deleted 7z download from SABnzbd');

                            return res.status(400).send(
                                `❌ 7z archives are not supported for streaming.\n\n` +
                                `This release uses 7z compression which cannot be streamed.\n` +
                                `SABnzbd's Direct Unpack does not support 7z files.\n\n` +
                                `The download has been stopped and deleted.\n\n` +
                                `Please select a different release that uses RAR or is uncompressed.`
                            );
                        }

                        // Check if we see RAR files (indicates files are still being extracted)
                        const hasRarFiles = files.some(f =>
                            f.toLowerCase().endsWith('.rar') ||
                            f.toLowerCase().match(/\.r\d+$/) ||
                            f.toLowerCase().endsWith('.zip')
                        );
                        if (hasRarFiles && !unpackPath) {
                            console.log('[USENET] ⚠️ RAR/ZIP archives detected but no _UNPACK_ folder found');
                            console.log('[USENET] Direct Unpack may be disabled in SABnzbd');
                        } else {
                            console.log('[USENET] No video file found yet, extraction may still be in progress');
                        }
                    }
                } else {
                    console.log(`[USENET] Path does not exist yet: ${searchPath}`);
                }
            }

            // If complete, get from complete folder
            if (status.status === 'completed' && status.path) {
                console.log('[USENET] Download completed, looking in complete folder:', status.path);
                videoFilePath = await findVideoFile(
                    status.path,
                    decodedTitle,
                    type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {}
                );
                if (videoFilePath) {
                    break; // Exit the waiting loop
                }
            }

            // File not found yet, wait and refresh status
            console.log(`[USENET] Video file not extracted yet, waiting... Progress: ${status.percentComplete?.toFixed(1) || 0}%`);
            await new Promise(resolve => setTimeout(resolve, fileCheckInterval));
            status = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);

            // Check for failures
            if (status.status === 'error' || status.status === 'failed') {
                return res.status(500).send(`Download failed: ${status.error || status.failMessage || 'Unknown error'}`);
            }
        }

        if (!videoFilePath || !fs.existsSync(videoFilePath)) {
            // File still not ready after waiting
            console.log('[USENET] Video file not found after waiting.');
            console.log('[USENET] Status:', status.status, 'Progress:', status.percentComplete + '%');
            console.log('[USENET] Searched path:', searchPath);

            // Check if we found RAR files but no video file at high completion percentage
            let directUnpackWarning = '';
            if (searchPath && fs.existsSync(searchPath)) {
                try {
                    const files = fs.readdirSync(searchPath);

                    // Check for 7z files - NOT supported
                    // Match .7z or .7z.001, .7z.002, etc. (split archives)
                    const has7zFiles = files.some(f => {
                        const lower = f.toLowerCase();
                        return lower.endsWith('.7z') || lower.match(/\.7z\.\d+$/);
                    });
                    if (has7zFiles) {
                        console.log('[USENET] ❌ 7z archive detected - not supported for streaming');
                        console.log('[USENET] Found 7z files:', files.filter(f => {
                            const lower = f.toLowerCase();
                            return lower.endsWith('.7z') || lower.match(/\.7z\.\d+$/);
                        }).slice(0, 3).join(', '));

                        // Delete the download immediately
                        await SABnzbd.deleteItem(
                            config.sabnzbdUrl,
                            config.sabnzbdApiKey,
                            nzoId,
                            true // Delete files
                        );
                        console.log('[USENET] ✓ Deleted 7z download from SABnzbd');

                        return res.status(400).send(
                            `❌ 7z archives are not supported for streaming.\n\n` +
                            `This release uses 7z compression which cannot be streamed.\n` +
                            `SABnzbd's Direct Unpack does not support 7z files.\n\n` +
                            `The download has been stopped and deleted.\n\n` +
                            `Please select a different release that uses RAR or is uncompressed.`
                        );
                    }

                    const hasRarFiles = files.some(f =>
                        f.toLowerCase().endsWith('.rar') ||
                        f.toLowerCase().match(/\.r\d+$/)
                    );
                    if (hasRarFiles && status.percentComplete > 50) {
                        directUnpackWarning = '\n\n⚠️ RAR archives detected. If you have NOT enabled "Direct Unpack" in SABnzbd, ' +
                            'streaming will only work after 100% download.\n\n' +
                            'To enable progressive streaming:\n' +
                            '1. Open SABnzbd Web UI\n' +
                            '2. Go to Config → Switches\n' +
                            '3. Enable "Direct Unpack"\n' +
                            '4. Save and retry';
                    }
                } catch (e) {
                    // Ignore errors
                }
            }

            return res.status(202).send(
                `Download in progress: ${status.percentComplete?.toFixed(1) || 0}%. ` +
                `Video file not yet extracted. SABnzbd is still extracting the files. Please try again in a moment.` +
                directUnpackWarning
            );
        }

        console.log('[USENET] Streaming from:', videoFilePath);

        // Check if external file server is configured - if so, skip range checks and redirect immediately
        const fileServerUrl = config.fileServerUrl || process.env.USENET_FILE_SERVER_URL;
        const usingFileServer = !!fileServerUrl;

        // Check if user is trying to resume from middle (Range request)
        // Skip this check if using file server - let file server handle ranges
        const rangeHeader = req.headers.range;
        if (!usingFileServer && rangeHeader && status.status === 'downloading') {
            const rangeMatch = rangeHeader.match(/bytes=(\d+)-/);
            if (rangeMatch) {
                const requestedByte = parseInt(rangeMatch[1]);

                // Get video file size (either from file if exists, or estimate from download)
                let videoFileSize = 0;
                if (fs.existsSync(videoFilePath)) {
                    videoFileSize = fs.statSync(videoFilePath).size;
                } else if (status.bytesTotal && status.bytesTotal > 0) {
                    // Estimate video size (usually slightly smaller than download size due to compression)
                    videoFileSize = status.bytesTotal * 0.9;
                }

                if (videoFileSize > 0 && requestedByte > 0) {
                    const requestedPercent = Math.min((requestedByte / videoFileSize) * 100, 100);
                    let downloadPercent = status.percentComplete || 0;

                    console.log(`[USENET] User resuming from ${requestedPercent.toFixed(1)}%, download at ${downloadPercent.toFixed(1)}%`);

                    // If user is trying to seek ahead of download, wait for download to catch up
                    if (requestedPercent > downloadPercent + 5) { // +5% buffer for safety
                        const targetPercent = Math.min(requestedPercent + 10, 100); // Wait for 10% extra buffer, max 100%
                        console.log(`[USENET] ⏳ User requesting ${requestedPercent.toFixed(1)}% (byte ${requestedByte}), download at ${downloadPercent.toFixed(1)}%, waiting for ${targetPercent.toFixed(1)}%...`);

                        // Wait in loop until download catches up
                        const maxWaitTime = 5 * 60 * 1000; // Max 5 minutes
                        const startWaitTime = Date.now();

                        while (downloadPercent < targetPercent) {
                            // Check if we've waited too long
                            if (Date.now() - startWaitTime > maxWaitTime) {
                                return res.status(408).send(
                                    `Download not progressing fast enough to reach your playback position.\n\n` +
                                    `Your position: ${requestedPercent.toFixed(1)}%\n` +
                                    `Download progress: ${downloadPercent.toFixed(1)}%\n\n` +
                                    `Please try starting from the beginning or wait for more of the file to download.`
                                );
                            }

                            // Wait 2 seconds before checking again
                            await new Promise(resolve => setTimeout(resolve, 2000));

                            // Refresh download status
                            status = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);
                            downloadPercent = status.percentComplete || 0;

                            console.log(`[USENET] ⏳ Waiting for download: ${downloadPercent.toFixed(1)}% / ${targetPercent.toFixed(1)}%`);

                            // Check for download failures
                            if (status.status === 'error' || status.status === 'failed') {
                                return res.status(500).send(`Download failed: ${status.error || status.failMessage || 'Unknown error'}`);
                            }

                            // If download completed, break out and stream
                            if (status.status === 'completed') {
                                console.log('[USENET] Download completed while waiting');
                                break;
                            }
                        }

                        console.log(`[USENET] ✓ Download reached ${downloadPercent.toFixed(1)}%, proceeding with stream`);
                    }
                }
            }
        }

        // Only pause if download is at 99% or higher and has no missing blocks
        // This prevents pausing too early and ensures repairs can complete
        let downloadPaused = false;
        if (status.percentComplete >= 99) {
            // Check for missing blocks - if any files have missing blocks, don't pause
            let hasMissingBlocks = false;
            if (status.files && Array.isArray(status.files)) {
                for (const file of status.files) {
                    // SABnzbd files have 'bytes' (downloaded) and 'bytes_left' properties
                    // If bytes_left > 0, there are still blocks to download
                    if (file.bytes_left && parseInt(file.bytes_left) > 0) {
                        hasMissingBlocks = true;
                        console.log(`[USENET] ⚠️ File "${file.filename}" has ${file.bytes_left} bytes left to download`);
                        break;
                    }
                    // Also check 'mb' and 'mb_left' as SABnzbd uses both
                    if (file.mb_left && parseFloat(file.mb_left) > 0) {
                        hasMissingBlocks = true;
                        console.log(`[USENET] ⚠️ File "${file.filename}" has ${file.mb_left} MB left to download`);
                        break;
                    }
                }
            }

            if (hasMissingBlocks) {
                console.log('[USENET] ⚠️ NOT pausing download - missing blocks detected, letting SABnzbd finish for repair');
            } else {
                console.log('[USENET] Pausing SABnzbd download to protect streaming files (99%+ complete, no missing blocks)...');
                await SABnzbd.pauseDownload(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);
                downloadPaused = true;
            }
        } else {
            console.log(`[USENET] NOT pausing download yet - only at ${status.percentComplete?.toFixed(1)}%, will pause at 99%`);
        }

        // Redirect to external file server if configured
        if (usingFileServer) {
            // Redirect to external file server instead of streaming through Node.js
            // Try to make path relative to either downloadDir or incompleteDir
            let relativePath = videoFilePath;

            // Try downloadDir first (complete directory)
            if (sabnzbdConfig?.downloadDir && videoFilePath.startsWith(sabnzbdConfig.downloadDir)) {
                relativePath = videoFilePath.replace(sabnzbdConfig.downloadDir, '').replace(/^\//, '');
                console.log(`[USENET] File in complete directory, relative path: ${relativePath}`);
            }
            // Try incompleteDir if file is there instead
            else if (sabnzbdConfig?.incompleteDir && videoFilePath.startsWith(sabnzbdConfig.incompleteDir)) {
                relativePath = videoFilePath.replace(sabnzbdConfig.incompleteDir, '').replace(/^\//, '');
                console.log(`[USENET] File in incomplete directory, relative path: ${relativePath}`);
            }
            // If neither matched, just use the basename or try to extract a relative path
            else {
                // Extract just the folder and filename (last 2 path segments)
                const pathParts = videoFilePath.split('/').filter(p => p);
                if (pathParts.length >= 2) {
                    relativePath = pathParts.slice(-2).join('/');
                } else {
                    relativePath = pathParts[pathParts.length - 1] || videoFilePath;
                }
                console.log(`[USENET] ⚠️ File path not under SABnzbd directories, using extracted path: ${relativePath}`);
                console.log(`[USENET] Full path: ${videoFilePath}`);
                console.log(`[USENET] downloadDir: ${sabnzbdConfig?.downloadDir}`);
                console.log(`[USENET] incompleteDir: ${sabnzbdConfig?.incompleteDir}`);
            }

            // Encode each path segment separately for proper URL encoding
            const pathSegments = relativePath.split('/').map(segment => encodeURIComponent(segment));
            const encodedPath = pathSegments.join('/');

            const externalUrl = `${fileServerUrl.replace(/\/$/, '')}/${encodedPath}`;
            console.log(`[USENET] Redirecting to external file server: ${externalUrl}`);
            console.log(`[USENET] File exists check: ${fs.existsSync(videoFilePath)}`);

            // Test connectivity to file server (HEAD request to check if reachable)
            try {
                const testUrl = new URL(fileServerUrl);
                const httpModule = testUrl.protocol === 'https:' ? https : http;

                const testReq = httpModule.request({
                    hostname: testUrl.hostname,
                    port: testUrl.port || (testUrl.protocol === 'https:' ? 443 : 80),
                    path: '/',
                    method: 'HEAD',
                    timeout: 2000
                }, (testRes) => {
                    console.log(`[USENET] File server is reachable (status: ${testRes.statusCode})`);
                }).on('error', (err) => {
                    console.error(`[USENET] ⚠️ WARNING: File server is NOT reachable at ${fileServerUrl}: ${err.message}`);
                    console.error(`[USENET] Make sure the Python file server is running!`);
                }).on('timeout', () => {
                    console.error(`[USENET] ⚠️ WARNING: File server connection timeout at ${fileServerUrl}`);
                });
                testReq.end();
            } catch (err) {
                console.error(`[USENET] ⚠️ WARNING: Invalid file server URL: ${err.message}`);
            }

            // Store config globally for auto-clean
            if (config.fileServerUrl && config.autoCleanOldFiles) {
                USENET_CONFIGS.set(config.fileServerUrl, config);
            }

            // Track stream access before redirecting
            if (!ACTIVE_USENET_STREAMS.has(nzoId)) {
                const currentFileSize = fs.statSync(videoFilePath).size;
                const isBeingExtracted = videoFilePath.includes('_UNPACK_');

                // Estimate final file size - use SABnzbd total if extracting, otherwise actual size
                let estimatedFileSize = currentFileSize;
                if (isBeingExtracted && status.percentComplete && status.percentComplete > 0) {
                    // Estimate based on: currentSize / percentExtracted
                    // Assume extraction progress roughly matches download progress
                    const estimateFromProgress = currentFileSize / (status.percentComplete / 100);

                    // Also try using bytesTotal if available
                    let estimateFromTotal = currentFileSize;
                    if (status.bytesTotal && status.bytesTotal > currentFileSize) {
                        estimateFromTotal = status.bytesTotal * 0.9;
                    }

                    // Use the larger of the two estimates (more conservative)
                    estimatedFileSize = Math.max(estimateFromProgress, estimateFromTotal, currentFileSize);

                    console.log(`[USENET] File extracting - Current: ${(currentFileSize / 1024 / 1024).toFixed(1)} MB, Progress: ${status.percentComplete.toFixed(1)}%, Estimated final: ${(estimatedFileSize / 1024 / 1024).toFixed(1)} MB (from progress: ${(estimateFromProgress / 1024 / 1024).toFixed(1)} MB, from total: ${(estimateFromTotal / 1024 / 1024).toFixed(1)} MB)`);
                }

                let initialPosition = 0;

                // Check if user is starting from a specific position (range request)
                if (req.headers.range) {
                    const rangeMatch = req.headers.range.match(/bytes=(\d+)-/);
                    if (rangeMatch) {
                        initialPosition = parseInt(rangeMatch[1]);
                        const seekPercent = estimatedFileSize > 0
                            ? (initialPosition / estimatedFileSize * 100).toFixed(1)
                            : '?';
                        console.log(`[USENET] 🎯 User starting at ${seekPercent}% (byte ${initialPosition.toLocaleString()}), download at ${status.percentComplete?.toFixed(1)}%`);
                    }
                }

                ACTIVE_USENET_STREAMS.set(nzoId, {
                    lastAccess: Date.now(),
                    streamCount: 1,
                    paused: downloadPaused, // True only if we actually paused SABnzbd
                    config: {
                        sabnzbdUrl: config.sabnzbdUrl,
                        sabnzbdApiKey: config.sabnzbdApiKey
                    },
                    videoFilePath: relativePath, // Relative path for deletion
                    usenetConfig: config, // Full config with cleanup options
                    fileSize: estimatedFileSize,
                    lastPlaybackPosition: initialPosition,
                    lastDownloadPercent: status.percentComplete || 0
                });
            } else {
                const streamInfo = ACTIVE_USENET_STREAMS.get(nzoId);
                streamInfo.lastAccess = Date.now();
                streamInfo.streamCount++;

                // Update file size estimate if file is still extracting and we have better info
                const currentFileSize = fs.statSync(videoFilePath).size;
                const isBeingExtracted = videoFilePath.includes('_UNPACK_');
                if (isBeingExtracted && status.percentComplete && status.percentComplete > 0) {
                    // Estimate based on current progress
                    const estimateFromProgress = currentFileSize / (status.percentComplete / 100);

                    let estimateFromTotal = currentFileSize;
                    if (status.bytesTotal && status.bytesTotal > currentFileSize) {
                        estimateFromTotal = status.bytesTotal * 0.9;
                    }

                    const newEstimate = Math.max(estimateFromProgress, estimateFromTotal, currentFileSize, streamInfo.fileSize);

                    // Log extraction progress
                    const extractedPercent = streamInfo.fileSize > 0 ? (currentFileSize / streamInfo.fileSize * 100) : 0;
                    console.log(`[USENET] File extraction: ${(currentFileSize / 1024 / 1024).toFixed(1)} MB extracted (${extractedPercent.toFixed(1)}%), download at ${status.percentComplete.toFixed(1)}%, estimated final: ${(newEstimate / 1024 / 1024).toFixed(1)} MB`);

                    streamInfo.fileSize = newEstimate;
                } else if (!isBeingExtracted && currentFileSize > streamInfo.fileSize) {
                    // File finished extracting, use actual size
                    streamInfo.fileSize = currentFileSize;
                }

                // Update playback position from range header if present
                if (req.headers.range) {
                    const rangeMatch = req.headers.range.match(/bytes=(\d+)-/);
                    if (rangeMatch) {
                        const bytePosition = parseInt(rangeMatch[1]);
                        streamInfo.lastPlaybackPosition = bytePosition;

                        // Log seek position with actual vs estimated size
                        const seekPercent = streamInfo.fileSize > 0
                            ? (bytePosition / streamInfo.fileSize * 100).toFixed(1)
                            : '?';

                        // Check if seeking beyond extracted range (with 5MB safety buffer)
                        // For MKV files, also check if extraction is far enough for seeking to work
                        const safetyBuffer = 5 * 1024 * 1024; // 5 MB
                        const maxSafePosition = Math.max(0, currentFileSize - safetyBuffer);

                        // MKV files need index at end - require at least 80% extraction for reliable seeking
                        const isMKV = videoFilePath.toLowerCase().endsWith('.mkv');
                        const extractionPercent = streamInfo.fileSize > 0 ? (currentFileSize / streamInfo.fileSize * 100) : 0;
                        const mkvSeekThreshold = 80; // Need 80% extracted for MKV seeking

                        if (isMKV && bytePosition > 0 && extractionPercent < mkvSeekThreshold) {
                            console.log(`[USENET] ⚠️ MKV file only ${extractionPercent.toFixed(1)}% extracted - seeking may not work until ${mkvSeekThreshold}% (MKV index usually at end of file)`);
                            return res.status(416).send(
                                `⚠️ Seeking not yet available for this MKV file.\n\n` +
                                `MKV files store their seeking index at the end of the file.\n` +
                                `Extraction progress: ${extractionPercent.toFixed(1)}%\n` +
                                `Seeking available at: ${mkvSeekThreshold}%\n` +
                                `Download progress: ${status.percentComplete?.toFixed(1)}%\n\n` +
                                `Please start from the beginning or wait for more extraction.\n` +
                                `The video will play normally from the start.`
                            );
                        }

                        if (bytePosition >= maxSafePosition) {
                            const extractedPercent = streamInfo.fileSize > 0 ? (currentFileSize / streamInfo.fileSize * 100) : 0;
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
                                    console.log(`[USENET] ✓ Extraction caught up! Proceeding with seek to ${seekPercent}%`);
                                    // Update currentFileSize for the redirect
                                    streamInfo.fileSize = Math.max(streamInfo.fileSize, newFileSize);
                                    break;
                                }

                                // Check if download failed
                                if (newStatus.status === 'failed' || newStatus.status === 'error') {
                                    return res.status(500).send(`Download failed: ${newStatus.error || 'Unknown error'}`);
                                }
                            }

                            // If we timed out, send error
                            const finalFileSize = fs.statSync(videoFilePath).size;
                            if (finalFileSize < targetSize) {
                                return res.status(416).send(
                                    `Cannot seek to ${seekPercent}% yet. File extraction is still in progress.\n\n` +
                                    `Requested position: ${(bytePosition / 1024 / 1024).toFixed(1)} MB\n` +
                                    `Extracted so far: ${(finalFileSize / 1024 / 1024).toFixed(1)} MB\n` +
                                    `Download progress: ${status.percentComplete?.toFixed(1)}%\n\n` +
                                    `Please try seeking to a lower position or wait for more of the file to extract.`
                                );
                            }
                        } else {
                            console.log(`[USENET] 🎯 User seeking to ${seekPercent}% (byte ${bytePosition.toLocaleString()}), file has ${(currentFileSize / 1024 / 1024).toFixed(1)} MB extracted, download at ${status.percentComplete?.toFixed(1)}%`);
                        }
                    }
                }
            }

            return res.redirect(302, externalUrl);
        }

        // Store config globally for auto-clean
        if (config.fileServerUrl && config.autoCleanOldFiles) {
            USENET_CONFIGS.set(config.fileServerUrl, config);
        }

        // Get file stats for direct streaming
        const stat = fs.statSync(videoFilePath);
        const isBeingExtracted = videoFilePath.includes('_UNPACK_');

        // Estimate final file size - use SABnzbd total if extracting, otherwise actual size
        let estimatedFileSize = stat.size;
        if (isBeingExtracted && status.percentComplete && status.percentComplete > 0) {
            // Estimate based on: currentSize / percentExtracted
            const estimateFromProgress = stat.size / (status.percentComplete / 100);

            // Also try using bytesTotal if available
            let estimateFromTotal = stat.size;
            if (status.bytesTotal && status.bytesTotal > stat.size) {
                estimateFromTotal = status.bytesTotal * 0.9;
            }

            // Use the larger of the two estimates (more conservative)
            estimatedFileSize = Math.max(estimateFromProgress, estimateFromTotal, stat.size);

            console.log(`[USENET] File extracting - Current: ${(stat.size / 1024 / 1024).toFixed(1)} MB, Progress: ${status.percentComplete.toFixed(1)}%, Estimated final: ${(estimatedFileSize / 1024 / 1024).toFixed(1)} MB (from progress: ${(estimateFromProgress / 1024 / 1024).toFixed(1)} MB, from total: ${(estimateFromTotal / 1024 / 1024).toFixed(1)} MB)`);
        }

        // Track this stream access
        if (!ACTIVE_USENET_STREAMS.has(nzoId)) {
            let initialPosition = 0;

            // Check if user is starting from a specific position (range request)
            if (req.headers.range) {
                const rangeMatch = req.headers.range.match(/bytes=(\d+)-/);
                if (rangeMatch) {
                    initialPosition = parseInt(rangeMatch[1]);
                    const seekPercent = estimatedFileSize > 0
                        ? (initialPosition / estimatedFileSize * 100).toFixed(1)
                        : '?';
                    console.log(`[USENET] 🎯 User starting at ${seekPercent}% (byte ${initialPosition.toLocaleString()}), download at ${status.percentComplete?.toFixed(1)}%`);
                }
            }

            ACTIVE_USENET_STREAMS.set(nzoId, {
                lastAccess: Date.now(),
                streamCount: 1,
                paused: downloadPaused, // True only if we actually paused SABnzbd
                config: {
                    sabnzbdUrl: config.sabnzbdUrl,
                    sabnzbdApiKey: config.sabnzbdApiKey
                },
                videoFilePath: null, // No file server, so no path needed for cleanup
                usenetConfig: config, // Full config with cleanup options
                fileSize: estimatedFileSize,
                lastPlaybackPosition: initialPosition,
                lastDownloadPercent: status.percentComplete || 0
            });
        } else {
            const streamInfo = ACTIVE_USENET_STREAMS.get(nzoId);
            streamInfo.lastAccess = Date.now();
            streamInfo.streamCount++;

            // Update file size estimate if file is still extracting and we have better info
            if (isBeingExtracted && status.percentComplete && status.percentComplete > 0) {
                // Estimate based on current progress
                const estimateFromProgress = stat.size / (status.percentComplete / 100);

                let estimateFromTotal = stat.size;
                if (status.bytesTotal && status.bytesTotal > stat.size) {
                    estimateFromTotal = status.bytesTotal * 0.9;
                }

                const newEstimate = Math.max(estimateFromProgress, estimateFromTotal, stat.size, streamInfo.fileSize);

                // Log extraction progress
                const extractedPercent = streamInfo.fileSize > 0 ? (stat.size / streamInfo.fileSize * 100) : 0;
                console.log(`[USENET] File extraction: ${(stat.size / 1024 / 1024).toFixed(1)} MB extracted (${extractedPercent.toFixed(1)}%), download at ${status.percentComplete.toFixed(1)}%, estimated final: ${(newEstimate / 1024 / 1024).toFixed(1)} MB`);

                streamInfo.fileSize = newEstimate;
            } else if (!isBeingExtracted && stat.size > streamInfo.fileSize) {
                // File finished extracting, use actual size
                streamInfo.fileSize = stat.size;
            }

            // Update playback position from range header if present
            if (req.headers.range) {
                const rangeMatch = req.headers.range.match(/bytes=(\d+)-/);
                if (rangeMatch) {
                    const bytePosition = parseInt(rangeMatch[1]);
                    streamInfo.lastPlaybackPosition = bytePosition;

                    // Log seek position with actual vs estimated size
                    const seekPercent = streamInfo.fileSize > 0
                        ? (bytePosition / streamInfo.fileSize * 100).toFixed(1)
                        : '?';

                    // Check if seeking beyond extracted range (with 5MB safety buffer)
                    // For MKV files, also check if extraction is far enough for seeking to work
                    const safetyBuffer = 5 * 1024 * 1024; // 5 MB
                    const maxSafePosition = Math.max(0, stat.size - safetyBuffer);

                    // MKV files need index at end - require at least 80% extraction for reliable seeking
                    const isMKV = videoFilePath.toLowerCase().endsWith('.mkv');
                    const extractionPercent = streamInfo.fileSize > 0 ? (stat.size / streamInfo.fileSize * 100) : 0;
                    const mkvSeekThreshold = 80; // Need 80% extracted for MKV seeking

                    if (isMKV && bytePosition > 0 && extractionPercent < mkvSeekThreshold) {
                        console.log(`[USENET] ⚠️ MKV file only ${extractionPercent.toFixed(1)}% extracted - seeking may not work until ${mkvSeekThreshold}% (MKV index usually at end of file)`);
                        return res.status(416).send(
                            `⚠️ Seeking not yet available for this MKV file.\n\n` +
                            `MKV files store their seeking index at the end of the file.\n` +
                            `Extraction progress: ${extractionPercent.toFixed(1)}%\n` +
                            `Seeking available at: ${mkvSeekThreshold}%\n` +
                            `Download progress: ${status.percentComplete?.toFixed(1)}%\n\n` +
                            `Please start from the beginning or wait for more extraction.\n` +
                            `The video will play normally from the start.`
                        );
                    }

                    if (isBeingExtracted && bytePosition >= maxSafePosition) {
                        const extractedPercent = streamInfo.fileSize > 0 ? (stat.size / streamInfo.fileSize * 100) : 0;
                        const targetSize = bytePosition + (10 * 1024 * 1024); // Need 10MB past seek point
                        const waitMessage = bytePosition >= stat.size
                            ? `Seeking beyond extracted range (${(bytePosition / 1024 / 1024).toFixed(1)} MB requested, only ${(stat.size / 1024 / 1024).toFixed(1)} MB extracted)`
                            : `Seeking too close to extraction edge (${(stat.size - bytePosition) / 1024 / 1024} MB buffer)`;

                        console.log(`[USENET] ⚠️ ${waitMessage}. Waiting for extraction to reach ${(targetSize / 1024 / 1024).toFixed(1)} MB...`);

                        // Wait for extraction to catch up
                        const maxWaitTime = 2 * 60 * 1000; // 2 minutes max
                        const startWait = Date.now();

                        while (Date.now() - startWait < maxWaitTime) {
                            await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds

                            // Re-check file size
                            const newFileStat = fs.statSync(videoFilePath);
                            const newStatus = await SABnzbd.getDownloadStatus(config.sabnzbdUrl, config.sabnzbdApiKey, nzoId);

                            console.log(`[USENET] ⏳ Extraction progress: ${(newFileStat.size / 1024 / 1024).toFixed(1)} MB (target: ${(targetSize / 1024 / 1024).toFixed(1)} MB), download: ${newStatus.percentComplete?.toFixed(1)}%`);

                            if (newFileStat.size >= targetSize) {
                                console.log(`[USENET] ✓ Extraction caught up! Proceeding with seek to ${seekPercent}%`);
                                // Update for streaming
                                streamInfo.fileSize = Math.max(streamInfo.fileSize, newFileStat.size);
                                break;
                            }

                            // Check if download failed
                            if (newStatus.status === 'failed' || newStatus.status === 'error') {
                                return res.status(500).send(`Download failed: ${newStatus.error || 'Unknown error'}`);
                            }
                        }

                        // If we timed out, send error
                        const finalFileStat = fs.statSync(videoFilePath);
                        if (finalFileStat.size < targetSize) {
                            return res.status(416).send(
                                `Cannot seek to ${seekPercent}% yet. File extraction is still in progress.\n\n` +
                                `Requested position: ${(bytePosition / 1024 / 1024).toFixed(1)} MB\n` +
                                `Extracted so far: ${(finalFileStat.size / 1024 / 1024).toFixed(1)} MB\n` +
                                `Download progress: ${status.percentComplete?.toFixed(1)}%\n\n` +
                                `Please try seeking to a lower position or wait for more of the file to extract.`
                            );
                        }
                    } else {
                        console.log(`[USENET] 🎯 User seeking to ${seekPercent}% (byte ${bytePosition.toLocaleString()}), file has ${(stat.size / 1024 / 1024).toFixed(1)} MB extracted, download at ${status.percentComplete?.toFixed(1)}%`);
                    }
                }
            }
        }

        // Handle range requests for seeking
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

                        // Check file size again
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

    } catch (error) {
        console.error('[USENET] Streaming error:', error.message);
        if (error.stack) console.error(error.stack);
        res.status(500).send(`Error: ${error.message}`);
    }
});

app.use((req, res, next) => serverless(req, res, next));

const port = process.env.PORT || 6907;
const server = app.listen(port, () => {
    console.log(`Started addon at: http://127.0.0.1:${port}`);

    if (mongoCache?.isEnabled()) {
        mongoCache.initMongo().then(() => {
            console.log('[CACHE] MongoDB cache initialized');
        }).catch(err => {
            console.error('[CACHE] MongoDB init failed:', err?.message || err);
        });
    } else {
        console.log('[CACHE] MongoDB cache disabled');
    }
});
