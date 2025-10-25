/**
 * Performance Optimization Utilities
 *
 * Collection of optimization patterns to make searches faster:
 * - Result streaming/progressive delivery
 * - Early termination when quota met
 * - Parse-torrent-title caching
 * - Parallel processing with limits
 */

import PTT from './parse-torrent-title.js';

// ---------------------------------------------------------------------------------
// Parse-Torrent-Title Caching
// ---------------------------------------------------------------------------------

const PTT_CACHE = new Map();
const PTT_CACHE_MAX_SIZE = 5000;
const PTT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Cached version of parse-torrent-title
 * Dramatically speeds up repeated parsing of the same titles
 */
export function parseTitleCached(title) {
  if (!title) return null;

  const key = title.toLowerCase().trim();
  const cached = PTT_CACHE.get(key);

  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }

  const parsed = PTT.parse(title);

  // Manage cache size (FIFO eviction)
  if (PTT_CACHE.size >= PTT_CACHE_MAX_SIZE) {
    const firstKey = PTT_CACHE.keys().next().value;
    PTT_CACHE.delete(firstKey);
  }

  PTT_CACHE.set(key, {
    data: parsed,
    expires: Date.now() + PTT_CACHE_TTL
  });

  return parsed;
}

/**
 * Clear the PTT cache
 */
export function clearPTTCache() {
  PTT_CACHE.clear();
}

// ---------------------------------------------------------------------------------
// Early Termination / Quota Checking
// ---------------------------------------------------------------------------------

/**
 * Check if we have enough quality results to stop searching
 * @param {Array} results - Current results
 * @param {Object} quotas - Quality quotas to satisfy
 * @returns {boolean} True if quotas are met
 */
export function hasMetQuotas(results, quotas = {}) {
  if (!quotas || Object.keys(quotas).length === 0) return false;

  const counts = {};
  for (const result of results) {
    const category = result.category || 'Other';
    counts[category] = (counts[category] || 0) + 1;
  }

  // Check if all quotas are met
  for (const [category, needed] of Object.entries(quotas)) {
    if ((counts[category] || 0) < needed) {
      return false;
    }
  }

  return true;
}

/**
 * Filter results to meet quality quotas without over-fetching
 * @param {Array} results - All results
 * @param {Object} quotas - Quality quotas per category
 * @returns {Array} Filtered results that meet quotas
 */
export function filterToQuotas(results, quotas = {}) {
  if (!quotas || Object.keys(quotas).length === 0) return results;

  const filtered = [];
  const counts = {};

  for (const result of results) {
    const category = result.category || 'Other';
    const quota = quotas[category] || Infinity;
    const current = counts[category] || 0;

    if (current < quota) {
      filtered.push(result);
      counts[category] = current + 1;
    }
  }

  return filtered;
}

// ---------------------------------------------------------------------------------
// Parallel Processing with Concurrency Control
// ---------------------------------------------------------------------------------

/**
 * Process items in parallel with concurrency limit
 * Faster than sequential, but won't overwhelm APIs
 *
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to apply to each item
 * @param {number} concurrency - Max concurrent operations
 * @returns {Promise<Array>} Results
 */
export async function parallelLimit(items, fn, concurrency = 10) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const promise = Promise.resolve().then(() => fn(item));
    results.push(promise);

    if (concurrency <= items.length) {
      const executing_promise = promise.then(() => {
        executing.splice(executing.indexOf(executing_promise), 1);
      });
      executing.push(executing_promise);

      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }

  return await Promise.all(results);
}

/**
 * Batch process items in chunks
 * Good for API calls that support batching
 *
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function that accepts a batch
 * @param {number} batchSize - Items per batch
 * @returns {Promise<Array>} Flattened results
 */
export async function batchProcess(items, fn, batchSize = 50) {
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await fn(batch);
    results.push(...(Array.isArray(batchResults) ? batchResults : [batchResults]));
  }

  return results;
}

// ---------------------------------------------------------------------------------
// Progressive Result Delivery
// ---------------------------------------------------------------------------------

/**
 * Create a progressive result stream
 * Returns results as they become available instead of waiting for all
 *
 * @param {Array<Promise>} promises - Array of promises to resolve
 * @param {Function} onResult - Callback for each result (result, index)
 * @param {Function} onError - Callback for errors (error, index)
 * @returns {Promise<Array>} All results
 */
export async function progressiveResolve(promises, onResult, onError) {
  const results = new Array(promises.length);
  let completed = 0;

  const wrappedPromises = promises.map((promise, index) =>
    Promise.resolve(promise)
      .then(result => {
        results[index] = result;
        completed++;
        if (onResult) {
          onResult(result, index, completed, promises.length);
        }
        return result;
      })
      .catch(error => {
        completed++;
        if (onError) {
          onError(error, index, completed, promises.length);
        }
        return null; // Don't fail entire operation
      })
  );

  await Promise.all(wrappedPromises);
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------------
// Deduplication Optimizations
// ---------------------------------------------------------------------------------

/**
 * Fast hash-based deduplication
 * Uses Set for O(1) lookups instead of array.filter
 *
 * @param {Array} items - Items to deduplicate
 * @param {Function} keyFn - Function to extract unique key
 * @returns {Array} Deduplicated items
 */
export function deduplicateFast(items, keyFn = item => item) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

/**
 * Deduplicate and keep best item per key (e.g., largest file size)
 *
 * @param {Array} items - Items to deduplicate
 * @param {Function} keyFn - Function to extract unique key
 * @param {Function} compareFn - Comparison function (a, b) => prefer a if > 0
 * @returns {Array} Deduplicated items with best kept
 */
export function deduplicateAndKeepBest(items, keyFn, compareFn) {
  const map = new Map();

  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key);

    if (!existing || compareFn(item, existing) > 0) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------------
// Timeout Utilities
// ---------------------------------------------------------------------------------

/**
 * Add timeout to any promise
 * @param {Promise} promise - Promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} errorMessage - Error message on timeout
 * @returns {Promise} Promise with timeout
 */
export function withTimeout(promise, ms, errorMessage = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

/**
 * Retry a promise with exponential backoff
 * @param {Function} fn - Function that returns a promise
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} initialDelay - Initial delay in ms
 * @param {number} maxDelay - Maximum delay in ms
 * @returns {Promise} Result or final error
 */
export async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 100, maxDelay = 5000) {
  let lastError;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (i < maxRetries) {
        const delay = Math.min(initialDelay * Math.pow(2, i), maxDelay);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------------
// Export All
// ---------------------------------------------------------------------------------

export default {
  parseTitleCached,
  clearPTTCache,
  hasMetQuotas,
  filterToQuotas,
  parallelLimit,
  batchProcess,
  progressiveResolve,
  deduplicateFast,
  deduplicateAndKeepBest,
  withTimeout,
  retryWithBackoff
};
