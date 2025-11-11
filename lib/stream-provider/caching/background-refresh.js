/**
 * Background cache refresh functionality
 * Keeps cache fresh without blocking user requests
 */

import { storeCacheResults } from './cache-manager.js';

/**
 * Background task to refresh cache with new data
 * Runs asynchronously without blocking the main request
 *
 * @param {string} provider - Debrid provider name
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Content ID
 * @param {Object} config - User configuration
 * @param {Function} searchFn - Function to execute the search
 * @param {string} cacheKey - Cache key for storage
 * @param {Array} existingResults - Current cached results
 * @returns {Promise<void>}
 */
export async function refreshCacheInBackground(provider, type, id, config, searchFn, cacheKey, existingResults) {
  try {
    console.log(`[CACHE] Starting background refresh for ${cacheKey}`);

    // Get fresh results with the search function
    const freshResults = await searchFn();

    if (freshResults && freshResults.length > 0) {
      // Process fresh results and update cache with any that are not already cached
      const nonPersonalFresh = freshResults.filter(r => !r.isPersonal);

      if (nonPersonalFresh.length > 0) {
        // Group fresh results by hash for deduplication
        const freshByHash = new Map();
        nonPersonalFresh.forEach(item => {
          const hash = item.hash || item.infoHash || (item.name ? item.name.toLowerCase() : '');
          if (hash) {
            freshByHash.set(hash, item);
          }
        });

        // Get current cached hashes to compare
        const currentHashes = new Set(existingResults.map(r => r.hash || r.infoHash || (r.name ? r.name.toLowerCase() : '')));

        // Find new results not already cached
        const newResults = [];
        for (const [hash, item] of freshByHash) {
          if (!currentHashes.has(hash)) {
            newResults.push(item);
          }
        }

        if (newResults.length > 0) {
          console.log(`[CACHE] Background refresh found ${newResults.length} new results to cache for ${cacheKey}`);
          // Store new results in cache
          await storeCacheResults(null, cacheKey, newResults, type, provider);
        } else {
          console.log(`[CACHE] Background refresh: no new results to cache for ${cacheKey}`);
        }
      }
    }

    console.log(`[CACHE] Background refresh completed for ${cacheKey}`);
  } catch (err) {
    console.error(`[CACHE] Background refresh failed for ${cacheKey}:`, err.message);
  }
}
