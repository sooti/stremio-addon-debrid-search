const CACHE_LIMIT = parseInt(process.env.SCRAPER_CACHE_LIMIT, 10) || 10000;
const DEFAULT_TTL_MS = (parseInt(process.env.SCRAPER_CACHE_TTL_MIN, 10) || 10) * 60 * 1000;

// Use Map for O(1) lookups - already optimal
const cache = new Map();

// Track access times for better LRU eviction
const accessTimes = new Map();

// Performance optimization: pre-compile cache key components
function getCacheKey(scraperName, query, config) {
    // Fast path: use cached key if query hasn't changed
    const normalizedQuery = (query || '').toLowerCase().trim();
    const lang = (config?.Languages && config.Languages.length) ? config.Languages[0] : 'none';

    // Build key with minimal string operations
    let key = `${scraperName}:${normalizedQuery}:${lang}`;

    // Add scraper-specific config flags
    if (scraperName === '1337x') {
        const strict = config?.TORRENT_1337X_STRICT_MATCH || false;
        key += `:${strict}`;
    }

    return key;
}

export function get(scraperName, query, config) {
    const key = getCacheKey(scraperName, query, config);
    const entry = cache.get(key);
    const now = Date.now();

    if (entry && now < entry.expires) {
        // Update access time for LRU tracking
        accessTimes.set(key, now);
        console.log(`[SCRAPER CACHE] HIT for ${key} (${entry.data.length} items, ${Math.round((entry.expires - now) / 1000)}s remaining)`);
        return entry.data;
    }

    if (entry) {
        // Expired entry - clean up
        cache.delete(key);
        accessTimes.delete(key);
    }

    console.log(`[SCRAPER CACHE] MISS for ${key}`);
    return null;
}

export function set(scraperName, query, config, data) {
    if (!data || data.length === 0) {
        // Do not cache empty results to allow for retries
        return;
    }

    const key = getCacheKey(scraperName, query, config);
    const now = Date.now();

    // LRU eviction: if at limit, remove least recently used entry
    if (cache.size >= CACHE_LIMIT && !cache.has(key)) {
        let oldestKey = null;
        let oldestTime = Infinity;

        // Find least recently used entry
        for (const [k, time] of accessTimes) {
            if (time < oldestTime) {
                oldestTime = time;
                oldestKey = k;
            }
        }

        if (oldestKey) {
            cache.delete(oldestKey);
            accessTimes.delete(oldestKey);
            console.log(`[SCRAPER CACHE] Evicted LRU entry ${oldestKey} (unused for ${Math.round((now - oldestTime) / 1000)}s)`);
        }
    }

    const entry = {
        data: data,
        expires: now + DEFAULT_TTL_MS
    };

    cache.set(key, entry);
    accessTimes.set(key, now);
    console.log(`[SCRAPER CACHE] SET for ${key} with ${data.length} items. Cache size: ${cache.size}`);
}

export function clear() {
    const size = cache.size;
    cache.clear();
    accessTimes.clear();
    console.log(`[SCRAPER CACHE] Cleared ${size} cached entries.`);
    return size;
}

// Periodic cleanup of expired entries (run every 5 minutes)
let cleanupInterval = null;

export function startPeriodicCleanup() {
    if (cleanupInterval) return;

    cleanupInterval = setInterval(() => {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entry] of cache) {
            if (now >= entry.expires) {
                cache.delete(key);
                accessTimes.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[SCRAPER CACHE] Periodic cleanup removed ${cleaned} expired entries. Cache size: ${cache.size}`);
        }
    }, 5 * 60 * 1000); // Run every 5 minutes
}

export function stopPeriodicCleanup() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

// Auto-start periodic cleanup
startPeriodicCleanup();

export default { get, set, clear, startPeriodicCleanup, stopPeriodicCleanup };
