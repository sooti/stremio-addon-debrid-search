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

const RESOLVED_URL_CACHE = new Map();

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
    windowMs: 60 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => requestIp.getClientIp(req)
});
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
        } else {
            console.log(`[RESOLVER] Cache miss. Resolving URL for ${debridProvider}: ${decodedUrl}`);
            finalUrl = await streamProvider.resolveUrl(debridProvider, debridApiKey, null, decodedUrl, clientIp);

            if (finalUrl) {
                RESOLVED_URL_CACHE.set(cacheKey, finalUrl);
//                setTimeout(() => RESOLVED_URL_CACHE.delete(cacheKey), 2 * 60 * 60 * 1000);
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
app.listen(port, () => {
    console.log(`Started addon at: http://127.0.0.1:${port}`);
});
