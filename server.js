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
import mongoCache from './lib/common/mongo-cache.js';

const RESOLVED_URL_CACHE = new Map();
const PENDING_RESOLVES = new Map();

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
