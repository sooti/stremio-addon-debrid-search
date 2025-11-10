// lib/util/cinemeta.js
import fetch from 'node-fetch';

// In-memory cache for Cinemeta results with TTL
const cinemetaCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function getMeta(type, imdbId) {
    const cacheKey = `${type}:${imdbId}`;

    // Check cache first
    const cached = cinemetaCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Cinemeta] Cache hit for ${cacheKey}`);
        return cached.data;
    }

    try {
        const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);

        // Check if the request was successful
        if (!response.ok) {
            console.error(`[Cinemeta] Received a ${response.status} response for ${type}:${imdbId}`);
            // Return null or a fallback object if meta is not found
            return null;
        }

        const body = await response.json();
        const meta = body && body.meta;

        // Cache the result
        if (meta) {
            cinemetaCache.set(cacheKey, {
                data: meta,
                timestamp: Date.now()
            });
            console.log(`[Cinemeta] Cached result for ${cacheKey}`);
        }

        return meta;

    } catch (err) {
        console.error(`[Cinemeta] A network or parsing error occurred:`, err);
        // Throwing an error here is okay, but we can also return null
        return null;
    }
}

// Periodic cleanup of expired cache entries (runs every 10 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cinemetaCache.entries()) {
        if (now - value.timestamp >= CACHE_TTL) {
            cinemetaCache.delete(key);
        }
    }
}, 10 * 60 * 1000);

export default { getMeta };
