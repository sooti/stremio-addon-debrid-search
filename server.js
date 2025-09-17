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

app.use(swStats.getMiddleware({
    name: addonInterface.manifest.name,
    version: addonInterface.manifest.version,
}));

const rateLimiter = rateLimit({
    windowMs: 120 * 120 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => requestIp.getClientIp(req)
});
app.use(rateLimiter);

// **START: CORRECTED RESOLVER ROUTE**
// This route now correctly matches the URL structure and passes the right parameters.
app.get('/resolve/:debridProvider/:debridApiKey/:url', async (req, res) => {
    const { debridProvider, debridApiKey, url } = req.params;
    const clientIp = requestIp.getClientIp(req);
    const cacheKey = `${debridProvider}:${url}`;

    try {
        let finalUrl;
        if (RESOLVED_URL_CACHE.has(cacheKey)) {
            finalUrl = RESOLVED_URL_CACHE.get(cacheKey);
            console.log(`[CACHE] Using cached URL for key: ${cacheKey}`);
        } else {
            console.log(`[RESOLVER] Cache miss. Resolving URL for ${debridProvider}: ${decodeURIComponent(url)}`);
            // This now passes the parameters in the correct order to the stream provider.
            finalUrl = await streamProvider.resolveUrl(debridProvider, debridApiKey, url, clientIp);

            if (finalUrl) {
                RESOLVED_URL_CACHE.set(cacheKey, finalUrl);
                setTimeout(() => RESOLVED_URL_CACHE.delete(cacheKey), 2 * 60 * 60 * 1000);
            }
        }

        if (finalUrl) {
            console.log("[RESOLVER] Redirecting to final stream URL.");
            res.redirect(302, finalUrl);
        } else {
            res.status(404).send('Could not resolve link');
        }
    } catch (error) {
        console.error("[RESOLVER] A critical error occurred:", error.message);
        res.status(500).send("Error resolving stream.");
    }
});
// **END: CORRECTED RESOLVER ROUTE**


app.use((req, res, next) => serverless(req, res, next));

const port = process.env.PORT || 6907;
app.listen(port, () => {
    console.log(`Started addon at: http://127.0.0.1:${port}`);
});
