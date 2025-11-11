/**
 * URL cache management with memory leak prevention
 * MEMORY LEAK FIX: Add size limits and proper cleanup for URL caches
 */

import { setCacheWithTimer, getCacheValue, evictOldestCacheEntry } from './cache-helpers.js';

// Using in-memory cache with SQLite for persistence
const RESOLVED_URL_CACHE = new Map();
const RESOLVED_URL_CACHE_MAX_SIZE = 500; // Reduced from 2000 to prevent memory issues

const PENDING_RESOLVES = new Map();
const PENDING_RESOLVES_MAX_SIZE = 100; // Reduced from 1000 to prevent memory issues

/**
 * Set a resolved URL in the cache
 * @param {string} cacheKey - Cache key
 * @param {string} value - Resolved URL
 * @param {number} ttlMs - Time to live in milliseconds
 */
async function setResolvedUrl(cacheKey, value, ttlMs) {
    return setCacheWithTimer(RESOLVED_URL_CACHE, cacheKey, value, ttlMs, RESOLVED_URL_CACHE_MAX_SIZE);
}

/**
 * Get a resolved URL from the cache
 * @param {string} cacheKey - Cache key
 * @returns {string|null} Resolved URL or null
 */
async function getResolvedUrl(cacheKey) {
    return getCacheValue(RESOLVED_URL_CACHE, cacheKey);
}

/**
 * Check if a resolve is pending
 * @param {string} cacheKey - Cache key
 * @returns {boolean} True if pending
 */
function hasPendingResolve(cacheKey) {
    return PENDING_RESOLVES.has(cacheKey);
}

/**
 * Get a pending resolve promise
 * @param {string} cacheKey - Cache key
 * @returns {Promise|null} Pending promise or null
 */
function getPendingResolve(cacheKey) {
    return PENDING_RESOLVES.get(cacheKey);
}

/**
 * Set a pending resolve promise
 * @param {string} cacheKey - Cache key
 * @param {Promise} promise - Pending promise
 */
function setPendingResolve(cacheKey, promise) {
    // MEMORY LEAK FIX: Limit pending requests to prevent unbounded growth
    if (PENDING_RESOLVES.size >= PENDING_RESOLVES_MAX_SIZE) {
        const oldestKey = PENDING_RESOLVES.keys().next().value;
        PENDING_RESOLVES.delete(oldestKey);
        console.log(`[RESOLVER] Evicted oldest pending request (size: ${PENDING_RESOLVES.size})`);
    }

    PENDING_RESOLVES.set(cacheKey, promise);
}

/**
 * Delete a pending resolve
 * @param {string} cacheKey - Cache key
 */
function deletePendingResolve(cacheKey) {
    PENDING_RESOLVES.delete(cacheKey);
}

/**
 * Get cache statistics
 */
function getCacheStats() {
    return {
        resolvedUrls: RESOLVED_URL_CACHE.size,
        maxResolvedUrls: RESOLVED_URL_CACHE_MAX_SIZE,
        pendingResolves: PENDING_RESOLVES.size,
        maxPendingResolves: PENDING_RESOLVES_MAX_SIZE
    };
}

/**
 * Clear all caches
 */
function clearAllCaches() {
    RESOLVED_URL_CACHE.clear();
    PENDING_RESOLVES.clear();
    console.log('[CACHE] All URL caches cleared');
}

export {
    RESOLVED_URL_CACHE,
    RESOLVED_URL_CACHE_MAX_SIZE,
    PENDING_RESOLVES,
    PENDING_RESOLVES_MAX_SIZE,
    setResolvedUrl,
    getResolvedUrl,
    hasPendingResolve,
    getPendingResolve,
    setPendingResolve,
    deletePendingResolve,
    getCacheStats,
    clearAllCaches
};
