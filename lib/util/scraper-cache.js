const CACHE_LIMIT = parseInt(process.env.SCRAPER_CACHE_LIMIT, 10) || 10000;
const DEFAULT_TTL_MS = (parseInt(process.env.SCRAPER_CACHE_TTL_MIN, 10) || 10) * 60 * 1000;

const cache = new Map();

function getCacheKey(scraperName, query, config) {
    // Normalize query and language for a more consistent cache key
    const normalizedQuery = (query || '').toLowerCase().trim();
    const lang = (config?.Languages && config.Languages.length) ? config.Languages[0] : 'none';
    return `${scraperName}:${normalizedQuery}:${lang}`;
}

export function get(scraperName, query, config) {
    const key = getCacheKey(scraperName, query, config);
    const entry = cache.get(key);

    if (entry && Date.now() < entry.expires) {
        console.log(`[SCRAPER CACHE] HIT for ${key}`);
        return entry.data;
    }

    if (entry) {
        cache.delete(key);
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

    if (cache.size >= CACHE_LIMIT && !cache.has(key)) {
        // Evict the oldest entry to make space
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
        console.log(`[SCRAPER CACHE] Evicted ${oldestKey} due to size limit.`);
    }

    const entry = {
        data: data,
        expires: Date.now() + DEFAULT_TTL_MS
    };

    cache.set(key, entry);
    console.log(`[SCRAPER CACHE] SET for ${key} with ${data.length} items. Cache size: ${cache.size}`);
}

export function clear() {
    const size = cache.size;
    cache.clear();
    console.log(`[SCRAPER CACHE] Cleared ${size} cached entries.`);
    return size;
}

export default { get, set, clear };
