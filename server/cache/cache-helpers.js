/**
 * Cache helper functions for managing URL caches with proper timer tracking
 * and memory leak prevention
 */

// Using in-memory cache with SQLite for persistence
const CACHE_TIMERS = new Map(); // Track setTimeout IDs for proper cleanup

/**
 * Helper function to set cache with proper timer tracking
 * @param {Map} cache - The cache map to use
 * @param {string} cacheKey - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttlMs - Time to live in milliseconds
 * @param {number} maxSize - Maximum cache size
 */
async function setCacheWithTimer(cache, cacheKey, value, ttlMs, maxSize) {
    // Evict old entries if needed
    evictOldestCacheEntry(cache, maxSize);

    // Clear existing timer if re-caching
    const existingTimer = CACHE_TIMERS.get(cacheKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    // Set cache value in local memory
    cache.set(cacheKey, value);

    // Set new timer and track it
    const timerId = setTimeout(() => {
        cache.delete(cacheKey);
        CACHE_TIMERS.delete(cacheKey);
    }, ttlMs);

    CACHE_TIMERS.set(cacheKey, timerId);
}

/**
 * Helper function to get cached value from local cache
 * @param {Map} cache - The cache map to use
 * @param {string} cacheKey - Cache key
 * @returns {any|null} Cached value or null
 */
async function getCacheValue(cache, cacheKey) {
    if (cache.has(cacheKey)) {
        const value = cache.get(cacheKey);
        console.log(`[CACHE] Cache hit for key: ${cacheKey.substring(0, 8)}...`);
        return value;
    }

    return null;
}

/**
 * Helper function to evict oldest cache entry (LRU-style FIFO eviction)
 * @param {Map} cache - The cache map to use
 * @param {number} maxSize - Maximum cache size
 */
function evictOldestCacheEntry(cache, maxSize) {
    if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);

        // Clear associated timer to prevent memory leak
        const timerId = CACHE_TIMERS.get(firstKey);
        if (timerId) {
            clearTimeout(timerId);
            CACHE_TIMERS.delete(firstKey);
        }

        console.log(`[CACHE] Evicted oldest entry (cache size: ${cache.size})`);
    }
}

/**
 * Clear all cache timers (for graceful shutdown)
 */
function clearAllCacheTimers() {
    for (const timerId of CACHE_TIMERS.values()) {
        clearTimeout(timerId);
    }
    CACHE_TIMERS.clear();
    console.log('[CACHE] All cache timers cleared');
}

/**
 * Get cache timer stats
 */
function getCacheTimerStats() {
    return {
        activeTimers: CACHE_TIMERS.size
    };
}

export {
    setCacheWithTimer,
    getCacheValue,
    evictOldestCacheEntry,
    clearAllCacheTimers,
    getCacheTimerStats,
    CACHE_TIMERS
};
