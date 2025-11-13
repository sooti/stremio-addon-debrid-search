#!/usr/bin/env node

// Ensure data directory exists before other imports
const pathModule = await import('path');
const { fileURLToPath } = await import('url');
const { dirname } = await import('path');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = pathModule.join(__dirname, 'data');
const fsModule = await import('fs');

if (!fsModule.existsSync(dataDir)) {
    console.log(`[SERVER] Creating data directory: ${dataDir}`);
    fsModule.mkdirSync(dataDir, { recursive: true });
    console.log(`[SERVER] Created data directory: ${dataDir}`);
} else {
    console.log(`[SERVER] Data directory already exists: ${dataDir}`);
}

import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { overrideConsole } from './lib/util/logger.js';
import { memoryMonitor } from './lib/util/memory-monitor.js';
import serverless from './serverless.js';
import requestIp from 'request-ip';
import rateLimit from 'express-rate-limit';
import swStats from 'swagger-stats';
import addonInterface from "./addon.js";
import streamProvider from './lib/stream-provider.js';
import * as sqliteCache from './lib/util/sqlite-cache.js';
import * as sqliteHashCache from './lib/util/sqlite-hash-cache.js';
import http from 'http';
import https from 'https';

import Usenet from './lib/usenet.js';
import { resolveHttpStreamUrl } from './lib/http-streams.js';
import { resolveUHDMoviesUrl } from './lib/uhdmovies.js';
import searchCoordinator from './lib/util/search-coordinator.js';
import * as scraperPerformance from './lib/util/scraper-performance.js';

// Using SQLite for local caching
console.log('[CACHE] Using SQLite for local caching');

// Override console to respect LOG_LEVEL environment variable
overrideConsole();
// Import compression if available, otherwise provide a no-op middleware
let compression = null;
try {
  compression = (await import('compression')).default;
} catch (e) {
  console.warn('Compression middleware not available, using no-op middleware');
  compression = () => (req, res, next) => next(); // No-op if compression not available
}
import Newznab from './lib/newznab.js';
import SABnzbd from './lib/sabnzbd.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { obfuscateSensitive } from './lib/common/torrent-utils.js';
import { getManifest } from './lib/util/manifest.js';
import landingTemplate from './lib/util/landingTemplate.js';



// Function to check memory usage and clear caches if needed
function checkMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    const rssInMB = memoryUsage.rss / 1024 / 1024;
    const heapUsedInMB = memoryUsage.heapUsed / 1024 / 1024;
    
    // If we're using more than 700MB RSS or 400MB heap, log a warning and consider cleanup
    if (rssInMB > 700 || heapUsedInMB > 400) {
        console.warn(`[MEMORY] High memory usage - RSS: ${rssInMB.toFixed(2)}MB, Heap: ${heapUsedInMB.toFixed(2)}MB`);
        return true; // Indicate high memory usage
    }
    return false; // Memory usage is OK
}

// MEMORY LEAK FIX: Add size limits and proper cleanup for URL caches
// Using in-memory cache with SQLite for persistence
const RESOLVED_URL_CACHE = new Map();
const RESOLVED_URL_CACHE_MAX_SIZE = 500; // Reduced from 2000 to prevent memory issues
const CACHE_TIMERS = new Map(); // Track setTimeout IDs for proper cleanup
const PENDING_RESOLVES = new Map();
const PENDING_RESOLVES_MAX_SIZE = 100; // Reduced from 1000 to prevent memory issues

// Helper function to evict oldest cache entry (LRU-style FIFO eviction)
function evictOldestCacheEntry() {
    if (RESOLVED_URL_CACHE.size >= RESOLVED_URL_CACHE_MAX_SIZE) {
        const firstKey = RESOLVED_URL_CACHE.keys().next().value;
        RESOLVED_URL_CACHE.delete(firstKey);

        // Clear associated timer to prevent memory leak
        const timerId = CACHE_TIMERS.get(firstKey);
        if (timerId) {
            clearTimeout(timerId);
            CACHE_TIMERS.delete(firstKey);
        }

        console.log(`[CACHE] Evicted oldest entry (cache size: ${RESOLVED_URL_CACHE.size})`);
    }
}

// Helper function to set cache with proper timer tracking
async function setCacheWithTimer(cacheKey, value, ttlMs) {
    // Evict old entries if needed
    evictOldestCacheEntry();

    // Clear existing timer if re-caching
    const existingTimer = CACHE_TIMERS.get(cacheKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    // Set cache value in local memory
    RESOLVED_URL_CACHE.set(cacheKey, value);

    // Set new timer and track it
    const timerId = setTimeout(() => {
        RESOLVED_URL_CACHE.delete(cacheKey);
        CACHE_TIMERS.delete(cacheKey);
    }, ttlMs);

    CACHE_TIMERS.set(cacheKey, timerId);
}

// Helper function to get cached value from local cache
async function getCacheValue(cacheKey) {
    if (RESOLVED_URL_CACHE.has(cacheKey)) {
        const value = RESOLVED_URL_CACHE.get(cacheKey);
        console.log(`[CACHE] Cache hit for key: ${cacheKey.substring(0, 8)}...`);
        return value;
    }

    return null;
}



const app = express();

app.get('/', (req, res) => {
    res.redirect('/configure');
});
app.get('/configure', (req, res) => {
    const manifest = getManifest({}, true);
    res.send(landingTemplate(manifest, {}));  // Pass an empty config object to avoid undefined error
});

app.get('/manifest-no-catalogs.json', (req, res) => {
    const manifest = getManifest({}, true);
    res.json(manifest);
});

app.use((req, res, next) => {
    if (['/', '/configure', '/manifest-no-catalogs.json'].includes(req.path) || req.path.startsWith('/resolve/') || req.path.startsWith('/usenet/') || req.path.startsWith('/admin/')) {
        return next();
    }
    serverless(req, res);
});

// Track active Usenet streams: nzoId -> { lastAccess, streamCount, config, videoFilePath, usenetConfig }
const ACTIVE_USENET_STREAMS = new Map();

/**
 * Stream error video from Python server (proxy through Node)
 * TVs and some video players don't follow 302 redirects, so we proxy instead
 * @param {string} errorText - The error message to display
 * @param {object} res - Express response object
 * @param {string} fileServerUrl - Python file server URL
 */
async function redirectToErrorVideo(errorText, res, fileServerUrl) {
    console.log(`[ERROR-VIDEO] Streaming error video: "${errorText}"`);

    try {
        const axios = (await import('axios')).default;

        // URL-encode the error message
        const encodedMessage = encodeURIComponent(errorText);

        // Construct error video URL on Python server
        const errorUrl = `${fileServerUrl.replace(/\/$/, '')}/error?message=${encodedMessage}`;

        console.log(`[ERROR-VIDEO] Fetching from: ${errorUrl}`);

        // Fetch the error video from Python server
        const response = await axios({
            method: 'GET',
            url: errorUrl,
            responseType: 'stream',
            timeout: 30000
        });

        // Copy headers from Python server
        res.status(200);
        res.set('Content-Type', response.headers['content-type'] || 'video/mp4');
        if (response.headers['content-length']) {
            res.set('Content-Length', response.headers['content-length']);
        }
        res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

        // Pipe the video stream to the client
        // Note: pipe() automatically ends the response when the source stream ends
        response.data.pipe(res);

        // Log when streaming completes
        response.data.on('end', () => {
            console.log(`[ERROR-VIDEO] ✓ Finished streaming error video`);
        });

        // Handle errors during streaming
        response.data.on('error', (err) => {
            console.error(`[ERROR-VIDEO] Stream error: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).end();
            }
        });

    } catch (error) {
        console.error(`[ERROR-VIDEO] Failed to fetch error video: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).send(`Error: ${errorText}`);
        }
    }
}

// Note: Proxy requests removed - we now use direct 302 redirects to Python file server
// This eliminates proxy overhead and allows proper client disconnect detection

// Store Usenet configs globally (so auto-clean works even without active streams)
const USENET_CONFIGS = new Map(); // fileServerUrl -> config
// Track pending Usenet submissions to prevent race conditions
const PENDING_USENET_SUBMISSIONS = new Map(); // title -> Promise

// Cleanup interval for inactive streams (check every 2 minutes)
const STREAM_CLEANUP_INTERVAL = 2 * 60 * 1000;
// Delete downloads after 10 minutes of inactivity
// This is aggressive to save bandwidth and disk space
// If user was just paused/buffering, they can restart the stream
const STREAM_INACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity


// Performance: Set up connection pooling and reuse
app.set('trust proxy', true); // Trust proxy headers if behind reverse proxy
app.set('etag', false); // Disable etag generation for static performance

app.use(cors());

// Performance: Add compression for API responses
app.use(compression({
    level: 6, // Balanced compression level
    threshold: 1024 // Only compress responses larger than 1KB
}));

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

    // Additional performance optimizations for HTTP server
    server.timeout = parseInt(process.env.HTTP_TIMEOUT || "120000", 10); // 2 minutes default
    server.maxHeadersCount = parseInt(process.env.HTTP_MAX_HEADERS_COUNT || "50", 10); // Reduce memory usage from headers

    // Performance: Optimize socket handling for multi-user support
    // Increased default from 200 to 500 for better scalability
    // Each user typically uses 1-2 concurrent connections
    server.maxConnections = parseInt(process.env.HTTP_MAX_CONNECTIONS || "500", 10);

    console.log(`[SERVER] HTTP Configuration: maxConnections=${server.maxConnections}, keepAliveTimeout=${server.keepAliveTimeout}ms, timeout=${server.timeout}ms`);
} catch (_) {}

// Graceful shutdown - properly close all connections
let isShuttingDown = false;
for (const sig of ["SIGINT","SIGTERM"]) {
    process.on(sig, async () => {
        if (isShuttingDown) return; // Prevent multiple shutdown attempts
        isShuttingDown = true;

        console.log(`[SERVER] Received ${sig}. Shutting down gracefully...`);

        // Clear all intervals and timeouts
        try {
            if (cleanupIntervalId) clearInterval(cleanupIntervalId);
            if (autoCleanIntervalId) clearInterval(autoCleanIntervalId);
            if (autoCleanTimeoutId) clearTimeout(autoCleanTimeoutId);
            if (monitorIntervalId) clearInterval(monitorIntervalId);



            // MEMORY LEAK FIX: Clear all pending cache timers
            for (const timerId of CACHE_TIMERS.values()) {
                clearTimeout(timerId);
            }
            CACHE_TIMERS.clear();
            console.log('[SERVER] All intervals, timeouts, and cache timers cleared');
        } catch (error) {
            console.error(`[SERVER] Error clearing intervals: ${error.message}`);
        }

        // Close SQLite connections
        try {
            await Promise.all([
                sqliteCache.closeSqlite(),
                sqliteHashCache.closeConnection()
            ]);
            console.log('[SERVER] All SQLite connections closed');
        } catch (error) {
            console.error(`[SERVER] Error closing SQLite connections: ${error.message}`);
        }

        // MEMORY LEAK FIX: Shutdown additional modules with cleanup intervals
        try {
            searchCoordinator.shutdown();
            scraperPerformance.shutdown();
            Usenet.shutdown();
            console.log('[SERVER] All module cleanup intervals stopped');
        } catch (error) {
            console.error(`[SERVER] Error shutting down modules: ${error.message}`);
        }

        // Close HTTP server
        server.close(() => {
            console.log('[SERVER] HTTP server closed');
            process.exit(0);
        });

        // Force exit after 10 seconds if graceful shutdown fails
        setTimeout(() => {
            console.error('[SERVER] Forced shutdown after timeout');
            process.exit(1);
        }, 10000).unref();
    });
}
app.use(rateLimiter);

// VVVV REVERTED: The resolver now performs a simple redirect VVVV
app.get('/resolve/:debridProvider/:debridApiKey/:url', async (req, res) => {
    const { debridProvider, debridApiKey, url } = req.params;

    // Validate required parameters
    if (!url || url === 'undefined') {
        console.error('[RESOLVER] Missing or invalid URL parameter');
        return res.status(400).send('Missing or invalid URL parameter');
    }

    const decodedUrl = decodeURIComponent(url);
    const clientIp = requestIp.getClientIp(req);

    // Extract config from query if provided (for NZB resolution)
    const configParam = req.query.config;
    let config = {};
    if (configParam) {
        try {
            // Safe parsing with memory and size limits
            const decodedConfigParam = decodeURIComponent(configParam);
            // Check size before parsing to prevent memory issues
            if (decodedConfigParam.length > 100000) { // 100KB limit
                console.log('[RESOLVER] Config parameter too large, rejecting');
                return res.status(400).send('Config parameter too large');
            }
            config = JSON.parse(decodedConfigParam);
        } catch (e) {
            console.log('[RESOLVER] Failed to parse config from query', e.message);
        }
    }

    // Use provider + hash of URL as cache key to avoid storing decoded URLs with API keys
    const cacheKeyHash = crypto.createHash('md5').update(decodedUrl).digest('hex');
    const cacheKey = `${debridProvider}:${cacheKeyHash}`;

    try {
        let finalUrl;

        const cachedValue = await getCacheValue(cacheKey);
        if (cachedValue) {
            finalUrl = cachedValue;
            console.log(`[CACHE] Using cached URL for key: ${debridProvider}:${cacheKeyHash.substring(0, 8)}...`);
        } else if (PENDING_RESOLVES.has(cacheKey)) {
            console.log(`[RESOLVER] Joining in-flight resolve for key: ${debridProvider}:${cacheKeyHash.substring(0, 8)}...`);
            finalUrl = await PENDING_RESOLVES.get(cacheKey);
        } else {
            console.log(`[RESOLVER] Cache miss. Resolving URL for ${debridProvider}`);
            const resolvePromise = streamProvider.resolveUrl(debridProvider, debridApiKey, null, decodedUrl, clientIp, config);

            // Set a configurable timeout for performance tuning - increase for NZB downloads
            const isNzb = decodedUrl.startsWith('nzb:');
            const timeoutMs = isNzb ? 600000 : parseInt(process.env.RESOLVE_TIMEOUT || '20000', 10); // 10 min for NZB, 20s otherwise
            const timedResolve = Promise.race([
                resolvePromise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Resolve timeout')), timeoutMs)
                )
            ]);

            // MEMORY LEAK FIX: Limit pending requests to prevent unbounded growth
            if (PENDING_RESOLVES.size >= PENDING_RESOLVES_MAX_SIZE) {
                const oldestKey = PENDING_RESOLVES.keys().next().value;
                const oldestPromise = PENDING_RESOLVES.get(oldestKey);
                // Cancel the oldest pending request if possible
                PENDING_RESOLVES.delete(oldestKey);
                console.log(`[RESOLVER] Evicted oldest pending request (size: ${PENDING_RESOLVES.size})`);
            }

            // Track the pending request
            const pendingRequest = timedResolve.catch(err => {
                console.error(`[RESOLVER] Pending resolve failed: ${err.message}`);
                return null;
            }).finally(() => {
                PENDING_RESOLVES.delete(cacheKey);
            });
            PENDING_RESOLVES.set(cacheKey, pendingRequest);

            finalUrl = await pendingRequest;

            if (finalUrl) {
                // MEMORY LEAK FIX: Use new cache function with proper timer tracking
                // Make cache TTL configurable for better performance tuning
                const cacheTtlMs = parseInt(process.env.RESOLVE_CACHE_TTL_MS || '900000', 10); // 15 min default (reduced from 2 hours)
                await setCacheWithTimer(cacheKey, finalUrl, cacheTtlMs);
            }
        }

        if (finalUrl) {
            // Sanitize finalUrl before logging - it may contain API keys or auth tokens
            const sanitizedUrl = obfuscateSensitive(finalUrl, debridApiKey);
            console.log("[RESOLVER] Redirecting to final stream URL:", sanitizedUrl);
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

// HTTP Streaming resolver endpoint (for 4KHDHub, UHDMovies, etc.)
// This endpoint provides lazy resolution - decrypts URLs only when user selects a stream
app.get('/resolve/httpstreaming/:url', async (req, res) => {
    const { url } = req.params;
    const decodedUrl = decodeURIComponent(url);

    // Use hash of URL as cache key
    const cacheKeyHash = crypto.createHash('md5').update(decodedUrl).digest('hex');
    const cacheKey = `httpstreaming:${cacheKeyHash}`;

    try {
        let finalUrl;

        const cachedValue = await getCacheValue(cacheKey);
        if (cachedValue) {
            finalUrl = cachedValue;
            console.log(`[HTTP-RESOLVER] Using cached URL for key: ${cacheKeyHash.substring(0, 8)}...`);
        } else if (PENDING_RESOLVES.has(cacheKey)) {
            console.log(`[HTTP-RESOLVER] Joining in-flight resolve for key: ${cacheKeyHash.substring(0, 8)}...`);
            finalUrl = await PENDING_RESOLVES.get(cacheKey);
        } else {
            console.log(`[HTTP-RESOLVER] Cache miss. Resolving HTTP stream URL...`);

            // Determine which resolver to use based on URL pattern
            let resolvePromise;
            if (decodedUrl.includes('driveleech') || decodedUrl.includes('driveseed') ||
                decodedUrl.includes('tech.unblockedgames.world') ||
                decodedUrl.includes('tech.creativeexpressionsblog.com') ||
                decodedUrl.includes('tech.examzculture.in')) {
                // UHDMovies SID/driveleech URL
                console.log(`[HTTP-RESOLVER] Detected UHDMovies URL, using UHDMovies resolver`);
                resolvePromise = resolveUHDMoviesUrl(decodedUrl);
            } else {
                // 4KHDHub/other HTTP streaming URLs
                console.log(`[HTTP-RESOLVER] Detected 4KHDHub URL, using HTTP stream resolver`);
                resolvePromise = resolveHttpStreamUrl(decodedUrl);
            }

            // Set timeout for HTTP stream resolution
            const timeoutMs = parseInt(process.env.HTTP_RESOLVE_TIMEOUT || '15000', 10); // 15s default
            const timedResolve = Promise.race([
                resolvePromise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('HTTP resolve timeout')), timeoutMs)
                )
            ]);

            // MEMORY LEAK FIX: Limit pending requests to prevent unbounded growth
            if (PENDING_RESOLVES.size >= PENDING_RESOLVES_MAX_SIZE) {
                const oldestKey = PENDING_RESOLVES.keys().next().value;
                const oldestPromise = PENDING_RESOLVES.get(oldestKey);
                // Cancel the oldest pending request if possible
                PENDING_RESOLVES.delete(oldestKey);
                console.log(`[HTTP-RESOLVER] Evicted oldest pending request (size: ${PENDING_RESOLVES.size})`);
            }

            // Track the pending request
            const pendingRequest = timedResolve.catch(err => {
                console.error(`[HTTP-RESOLVER] Pending resolve failed: ${err.message}`);
                return null;
            }).finally(() => {
                PENDING_RESOLVES.delete(cacheKey);
            });
            PENDING_RESOLVES.set(cacheKey, pendingRequest);

            finalUrl = await pendingRequest;

            if (finalUrl) {
                // MEMORY LEAK FIX: Use new cache function with proper timer tracking
                // Cache TTL for HTTP streams
                const cacheTtlMs = parseInt(process.env.HTTP_RESOLVE_CACHE_TTL_MS || '600000', 10); // 10 min default (reduced from 1 hour)
                await setCacheWithTimer(cacheKey, finalUrl, cacheTtlMs);
            }
        }

        if (finalUrl) {
            console.log("[HTTP-RESOLVER] Redirecting to final stream URL:", finalUrl.substring(0, 100) + '...');
            res.redirect(302, finalUrl);
        } else {
            res.status(404).send('Could not resolve HTTP stream link');
        }
    } catch (error) {
        console.error("[HTTP-RESOLVER] Error occurred:", error.message);
        res.status(500).send("Error resolving HTTP stream.");
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



// Endpoint to clear SQLite search cache (stream results)
app.get('/admin/clear-search-cache', checkAdminAuth, async (req, res) => {
    const result = await sqliteCache.clearSearchCache();
    res.json(result);
});

// Endpoint to clear SQLite torrent hash cache (optionally for specific service)
app.get('/admin/clear-torrent-cache', checkAdminAuth, async (req, res) => {
    const service = req.query.service; // Optional: ?service=realdebrid or ?service=alldebrid
    const result = await sqliteCache.clearTorrentCache(service);
    res.json(result);
});

// Endpoint to clear ALL SQLite cache (search results + torrent metadata)
app.get('/admin/clear-all-cache', checkAdminAuth, async (req, res) => {
    const result = await sqliteCache.clearAllCache();

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

// Schedule cleanup every 15 minutes
const cleanupIntervalId = setInterval(() => {
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

// Schedule auto-clean every hour
const AUTO_CLEAN_INTERVAL = 60 * 60 * 1000; // 1 hour
const autoCleanIntervalId = setInterval(() => {
    autoCleanOldFiles().catch(err => {
        console.error('[USENET-AUTO-CLEAN] Error during auto-clean:', err.message);
    });
}, AUTO_CLEAN_INTERVAL);

// Run auto-clean on startup after 5 minutes
const autoCleanTimeoutId = setTimeout(() => {
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
const monitorIntervalId = setInterval(() => {
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
// Find video file via file server API (uses rar2fs mounted directory)
async function findVideoFileViaAPI(fileServerUrl, releaseName, options = {}, fileServerPassword = null) {
    try {
        const axios = (await import('axios')).default;
        console.log(`[USENET] Querying file server for release: ${releaseName}`);

        const headers = {};
        const apiKey = fileServerPassword || process.env.USENET_FILE_SERVER_API_KEY;
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }
        const response = await axios.get(`${fileServerUrl.replace(/\/$/, '')}/api/list`, {
            timeout: 5000,
            validateStatus: (status) => status === 200,
            headers: headers
        });

        if (!response.data?.files || !Array.isArray(response.data.files)) {
            console.log('[USENET] No files returned from file server');
            return null;
        }

        console.log(`[USENET] File server returned ${response.data.files.length} total video files`);

        // Filter files that match the release name (normalize the folder path)
        const normalizedRelease = releaseName.toLowerCase();
        let matchingFiles = response.data.files.filter(file => {
            if (!file || !file.path) {
                console.log(`[USENET] Warning: Invalid file entry in response`);
                return false;
            }
            const filePath = file.path.toLowerCase();
            const fileName = file.name ? file.name.toLowerCase() : '';

            // Match if path contains release name OR filename contains release name
            // This helps find files in nested subdirectories
            const pathMatch = filePath.includes(normalizedRelease);
            const nameMatch = fileName.includes(normalizedRelease);

            return pathMatch || nameMatch;
        });

        console.log(`[USENET] Found ${matchingFiles.length} files matching release "${releaseName}"`);

        // Debug: show paths of all matching files
        if (matchingFiles.length > 0) {
            console.log(`[USENET] Matching file paths:`, matchingFiles.slice(0, 5).map(f => f.path));
            console.log(`[USENET] First match:`, JSON.stringify(matchingFiles[0]));
        } else {
            // Show what we got from API to debug why nothing matched
            console.log(`[USENET] No matches found. Sample of files from API (first 3):`);
            response.data.files.slice(0, 3).forEach(f => {
                console.log(`  - Path: "${f.path}" | Name: "${f.name}"`);
            });
            console.log(`[USENET] Looking for release: "${normalizedRelease}"`);
        }

        if (matchingFiles.length === 0) {
            return null;
        }

        // Exclude sample files, extras, and featurettes
        matchingFiles = matchingFiles.filter(f => {
            if (!f || !f.name) return false;
            const nameLower = f.name.toLowerCase();
            const pathLower = f.path ? f.path.toLowerCase() : '';

            // Exclude common non-main-feature files
            const excludeKeywords = ['sample', 'extra', 'featurette', 'deleted', 'trailer', 'bonus'];
            const shouldExclude = excludeKeywords.some(keyword =>
                nameLower.includes(keyword) || pathLower.includes(keyword)
            );

            if (shouldExclude) {
                console.log(`[USENET] Excluding: ${f.name} (contains ${excludeKeywords.find(k => nameLower.includes(k) || pathLower.includes(k))})`);
            }

            return !shouldExclude;
        });

        if (matchingFiles.length === 0) {
            console.log(`[USENET] No files left after filtering non-main-feature files`);
            return null;
        }

        console.log(`[USENET] ${matchingFiles.length} files after filtering (showing sizes):`);
        matchingFiles.slice(0, 5).forEach(f => {
            console.log(`  - ${f.name}: ${(f.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
        });

        // For series, try to match season/episode
        if (options.season && options.episode) {
            const PTT = (await import('./lib/util/parse-torrent-title.js')).default;
            const matchedFile = matchingFiles.find(file => {
                const parsed = PTT.parse(file.name);
                return parsed.season === Number(options.season) && parsed.episode === Number(options.episode);
            });
            if (matchedFile) {
                console.log(`[USENET] Matched S${options.season}E${options.episode}: ${matchedFile.name}`);
                return {
                    name: matchedFile.name,
                    path: matchedFile.path, // Use full path with folder
                    size: matchedFile.size
                };
            }
        }

        // Return largest file
        matchingFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
        const largestFile = matchingFiles[0];

        if (!largestFile || !largestFile.name) {
            console.log(`[USENET] Error: largest file is invalid`);
            return null;
        }

        console.log(`[USENET] Selected largest file: ${largestFile.name} (${(largestFile.size / 1024 / 1024 / 1024).toFixed(2)} GB`);

        // Use full path with folder so rar2fs can find the extracted file
        return {
            name: largestFile.name,
            path: largestFile.path, // Use full path, not flatPath
            size: largestFile.size
        };

    } catch (error) {
        console.error('[USENET] Error querying file server:', error.message);
        return null;
    }
}

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

        // Search in directory recursively
        const files = fs.readdirSync(baseDir, { withFileTypes: true, recursive: true });

        // Filter video files and exclude samples
        // Note: with recursive: true, dirent.name contains the relative path from baseDir
        let videoFiles = files
            .filter(f => f.isFile())
            .map(f => {
                // f.path is the parent directory, f.name is the filename (or relative path with recursive)
                // Join them correctly to get the full path
                const fullPath = path.join(f.path || baseDir, f.name);
                return fullPath;
            })
            .filter(p => videoExtensions.includes(path.extname(p).toLowerCase()))
            .filter(p => !path.basename(p).toLowerCase().includes('sample')); // Exclude sample files

        console.log(`[USENET] Found ${videoFiles.length} video files in ${baseDir}`);
        if (videoFiles.length > 0) {
            console.log('[USENET] Video files:', videoFiles.map(f => path.basename(f)).join(', '));
        }

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

        // Safe parsing with memory and size limits
        const decodedConfigJson = decodeURIComponent(configJson);
        // Check size before parsing to prevent memory issues
        if (decodedConfigJson.length > 100000) { // 100KB limit
            return res.status(400).json({ ready: false, error: 'Config parameter too large' });
        }
        const config = JSON.parse(decodedConfigJson);

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

// Universal Usenet streaming endpoint - dynamically resolves file location
// This endpoint queries the file server API to find the current file path
// Works even when files move from incomplete/ to personal/ during completion
app.get('/usenet/universal/:releaseName/:type/:id', async (req, res) => {
    const { releaseName, type, id } = req.params;

    try {
        const configJson = req.query.config;
        if (!configJson) {
            return res.status(400).send('Missing configuration');
        }

        const decodedConfigJson = decodeURIComponent(configJson);
        if (decodedConfigJson.length > 100000) {
            return res.status(400).send('Config parameter too large');
        }
        const config = JSON.parse(decodedConfigJson);

        if (!config.fileServerUrl) {
            return res.status(400).send('File server not configured');
        }

        const decodedReleaseName = decodeURIComponent(releaseName);
        console.log(`[USENET-UNIVERSAL] Stream request for: ${decodedReleaseName}`);

        // Query file server API to find current file location
        const { findVideoFileViaAPI } = await import('./server/usenet/video-finder.js');
        const fileInfo = await findVideoFileViaAPI(
            config.fileServerUrl,
            decodedReleaseName,
            type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {},
            config.fileServerPassword
        );

        if (!fileInfo) {
            return res.status(404).send('Video file not found');
        }

        console.log(`[USENET-UNIVERSAL] Resolved to: ${fileInfo.path}`);

        // Track this stream
        const streamKey = `universal:${decodedReleaseName}`;
        if (!ACTIVE_USENET_STREAMS.has(streamKey)) {
            ACTIVE_USENET_STREAMS.set(streamKey, {
                lastAccess: Date.now(),
                streamCount: 1,
                activeConnections: 0,
                maxBytePosition: 0,
                fileSize: fileInfo.size || 0,
                completionPercentage: 0,
                config: {
                    sabnzbdUrl: config.sabnzbdUrl,
                    sabnzbdApiKey: config.sabnzbdApiKey
                },
                videoFilePath: fileInfo.path,
                usenetConfig: config,
                releaseName: decodedReleaseName,
                isUniversal: true
            });
        }

        const streamInfo = ACTIVE_USENET_STREAMS.get(streamKey);
        streamInfo.lastAccess = Date.now();
        streamInfo.activeConnections++;

        // Store config for auto-clean
        if (config.fileServerUrl && config.autoCleanOldFiles) {
            USENET_CONFIGS.set(config.fileServerUrl, config);
        }

        // Track range requests for completion calculation
        if (req.headers.range) {
            const rangeMatch = req.headers.range.match(/bytes=(\d+)-(\d*)/);
            if (rangeMatch) {
                const startByte = parseInt(rangeMatch[1]);
                if (startByte > streamInfo.maxBytePosition) {
                    streamInfo.maxBytePosition = startByte;
                }
            }
        }

        // Handle connection close
        req.on('close', () => {
            streamInfo.activeConnections--;
            console.log(`[USENET-UNIVERSAL] Connection closed for ${streamKey}, active: ${streamInfo.activeConnections}`);

            if (streamInfo.activeConnections === 0 && streamInfo.usenetConfig?.deleteOnStreamStop) {
                const completionThreshold = 90;
                if (streamInfo.completionPercentage >= completionThreshold) {
                    console.log(`[USENET-UNIVERSAL] Stream finished (${streamInfo.completionPercentage}%), scheduling delete`);
                    setTimeout(async () => {
                        if (streamInfo.activeConnections === 0) {
                            console.log(`[USENET-UNIVERSAL] Deleting finished file: ${fileInfo.path}`);
                            await deleteFileFromServer(streamInfo.usenetConfig.fileServerUrl, fileInfo.path);
                            ACTIVE_USENET_STREAMS.delete(streamKey);
                        }
                    }, 30000);
                }
            }
        });

        // Proxy to file server
        const fileServerUrl = config.fileServerUrl.replace(/\/$/, '');
        const proxyUrl = `${fileServerUrl}/${fileInfo.path}`;
        console.log(`[USENET-UNIVERSAL] Proxying to: ${proxyUrl}`);

        const axios = (await import('axios')).default;
        const headers = {};
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const apiKey = config.fileServerPassword || process.env.USENET_FILE_SERVER_API_KEY;
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }

        const response = await axios.get(proxyUrl, {
            headers,
            responseType: 'stream',
            validateStatus: (status) => status < 500,
            timeout: 60000
        });

        // Forward response
        res.status(response.status);
        Object.keys(response.headers).forEach(key => {
            res.setHeader(key, response.headers[key]);
        });

        // Update file size and completion
        if (response.headers['content-range']) {
            const rangeMatch = response.headers['content-range'].match(/bytes \d+-\d+\/(\d+)/);
            if (rangeMatch) {
                streamInfo.fileSize = parseInt(rangeMatch[1]);
            }
        } else if (response.headers['content-length']) {
            streamInfo.fileSize = parseInt(response.headers['content-length']);
        }

        if (streamInfo.fileSize > 0) {
            streamInfo.completionPercentage = Math.round((streamInfo.maxBytePosition / streamInfo.fileSize) * 100);
        }

        response.data.pipe(res);

    } catch (error) {
        console.error('[USENET-UNIVERSAL] Error:', error.message);
        if (!res.headersSent) {
            return res.status(500).send('Error streaming file');
        }
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

        // Safe parsing with memory and size limits
        const decodedConfigJson = decodeURIComponent(configJson);
        // Check size before parsing to prevent memory issues
        if (decodedConfigJson.length > 100000) { // 100KB limit
            return res.status(400).send('Config parameter too large');
        }
        const config = JSON.parse(decodedConfigJson);

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

        // Add API key for file server authentication
        const apiKey = config.fileServerPassword || process.env.USENET_FILE_SERVER_API_KEY;
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
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

        // Safe parsing with memory and size limits
        const decodedConfigJson = decodeURIComponent(configJson);
        // Check size before parsing to prevent memory issues
        if (decodedConfigJson.length > 100000) { // 100KB limit
            return res.status(400).send('Config parameter too large');
        }
        const config = JSON.parse(decodedConfigJson);

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

        // Before submitting NZB, check if file already exists on file server
        if (!nzoId && config.fileServerUrl) {
            console.log('[USENET] Checking file server for existing file before submitting NZB...');
            const { findVideoFileViaAPI } = await import('./server/usenet/video-finder.js');
            const existingFile = await findVideoFileViaAPI(
                config.fileServerUrl,
                decodedTitle,
                type === 'series' ? { season: id.split(':')[1], episode: id.split(':')[2] } : {},
                config.fileServerPassword
            );

            if (existingFile) {
                console.log(`[USENET] ✓ File already exists on file server: ${existingFile.path}`);
                console.log(`[USENET] Streaming directly from file server (no download needed)`);

                // Redirect to personal file endpoint
                const encodedPath = existingFile.path.split('/').map(encodeURIComponent).join('/');
                const configParam = encodeURIComponent(configJson);
                return res.redirect(307, `/usenet/personal/${encodedPath}?config=${configParam}`);
            }
        }

        // Submit NZB to SABnzbd if not already downloading and file not on server
        if (!nzoId) {
            // Check for pending submission to prevent race conditions
            if (PENDING_USENET_SUBMISSIONS.has(decodedTitle)) {
                console.log('[USENET] Another request is already submitting this NZB, waiting...');
                try {
                    const pendingResult = await PENDING_USENET_SUBMISSIONS.get(decodedTitle);
                    nzoId = pendingResult.nzoId;
                    console.log('[USENET] Using NZO ID from concurrent submission:', nzoId);
                } catch (error) {
                    console.log('[USENET] Pending submission failed, will try again:', error.message);
                    // Continue to submit below if the other request failed
                }
            }

            if (!nzoId) {
                // Delete ALL incomplete downloads BEFORE submitting new one to free up bandwidth immediately
                console.log('[USENET] Deleting all incomplete downloads to free bandwidth for new stream...');
                const deletedCount = await SABnzbd.deleteAllExcept(
                    config.sabnzbdUrl,
                    config.sabnzbdApiKey,
                    null, // No exception - delete everything incomplete
                    true  // Delete files
                );
                if (deletedCount > 0) {
                    console.log(`[USENET] ✓ Deleted ${deletedCount} incomplete download(s) to free bandwidth`);
                }

                console.log('[USENET] Submitting NZB to SABnzbd...');

                // Create submission promise and store it
                const submissionPromise = Usenet.submitNzb(
                    config.sabnzbdUrl,
                    config.sabnzbdApiKey,
                    config.newznabUrl,
                    config.newznabApiKey,
                    decodedNzbUrl,
                    decodedTitle
                );
                PENDING_USENET_SUBMISSIONS.set(decodedTitle, submissionPromise);

                try {
                    const submitResult = await submissionPromise;
                    nzoId = submitResult.nzoId;
                } finally {
                    // Clean up pending submission after 5 seconds
                    setTimeout(() => {
                        PENDING_USENET_SUBMISSIONS.delete(decodedTitle);
                    }, 5000);
                }

                // Add to memory cache immediately to prevent race conditions
                Usenet.activeDownloads.set(nzoId, {
                    nzoId: nzoId,
                    name: decodedTitle,
                    startTime: Date.now(),
                    status: 'downloading'
                });

                console.log(`[USENET] ✓ New download started, all bandwidth dedicated to: ${decodedTitle}`);
            }

            // Don't delete completed folders - they become personal files for instant playback
            // Auto-clean will handle old files based on user settings
            console.log(`[USENET] Keeping all completed folders (personal files)`);

        }

        // Immediately redirect to universal endpoint which will handle file resolution dynamically
        // This allows streaming to start as soon as the file is available, and continues
        // working even when SABnzbd moves files from incomplete/ to complete/
        console.log('[USENET] Redirecting to universal streaming endpoint...');

        const encodedTitle = encodeURIComponent(decodedTitle);
        const configParam = encodeURIComponent(configJson);
        const universalUrl = `/usenet/universal/${encodedTitle}/${type}/${id}?config=${configParam}`;

        console.log(`[USENET] ✓ Stream URL: ${universalUrl}`);
        return res.redirect(307, universalUrl);

    } catch (error) {
        console.error('[USENET] Streaming error:', error.message);
        if (error.stack) console.error(error.stack);
        res.status(500).send(`Error: ${error.message}`);
    }
});

app.use((req, res, next) => {
    if (['/', '/configure', '/manifest-no-catalogs.json'].includes(req.path) || req.path.startsWith('/resolve/') || req.path.startsWith('/usenet/') || req.path.startsWith('/admin/')) {
        return next();
    }
    serverless(req, res, next);
});

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 7000;  // Consistent port definition

let server = null;

// Check if we're running directly (not being imported by cluster)
// For standalone mode, start the server directly
if (import.meta.url === `file://${__filename}`) {
    // Start memory monitoring before server starts
    memoryMonitor.startMonitoring();
    
    server = app.listen(PORT, HOST, () => {
        console.log('HTTP server listening on port: ' + server.address().port);
    });
    
    // Handle graceful shutdown for standalone mode
    process.on('SIGINT', () => {
        console.log('\nShutting down standalone server...');
        memoryMonitor.stopMonitoring(); // Stop memory monitoring
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        memoryMonitor.stopMonitoring(); // Stop memory monitoring
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
}

// Export for cluster usage
export { app, server, PORT, HOST };

if (sqliteCache?.isEnabled()) {
    sqliteCache.initSqlite().then(() => {
        console.log('[CACHE] SQLite cache initialized');
    }).catch(err => {
        console.error('[CACHE] SQLite init failed:', err?.message || err);
    });
}

if (sqliteHashCache?.isEnabled()) {
    sqliteHashCache.initCleanup().then(() => {
        console.log('[HASH-CACHE] SQLite hash cache cleanup initialized');
    }).catch(err => {
        console.error('[HASH-CACHE] SQLite hash cache init failed:', err?.message || err);
    });
}