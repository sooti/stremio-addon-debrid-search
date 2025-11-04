// This file has been removed as part of the refactoring to use only SQLite cache
// All caching is now handled through the SQLite cache in sqlite-cache.js

export function get(scraperName, query, config) {
    console.log(`[SCRAPER CACHE] In-memory cache removed, using SQLite only for ${scraperName}:${query}`);
    return null;
}

export function set(scraperName, query, config, data) {
    console.log(`[SCRAPER CACHE] In-memory cache removed, using SQLite only for ${scraperName}:${query}`);
    // Data should be stored in SQLite instead
}

export function clear() {
    console.log('[SCRAPER CACHE] In-memory cache cleared (removed)');
    return 0;
}

export function startPeriodicCleanup() {
    console.log('[SCRAPER CACHE] In-memory periodic cleanup not started (removed)');
}

export function stopPeriodicCleanup() {
    console.log('[SCRAPER CACHE] In-memory periodic cleanup not stopped (removed)');
}

export default { get, set, clear, startPeriodicCleanup, stopPeriodicCleanup };
