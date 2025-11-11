/**
 * In-flight request deduplication
 * Prevents duplicate concurrent searches for the same content
 */

// Track in-flight requests to prevent duplicate concurrent searches
// Key format: "provider:type:id:lang1,lang2"
const inFlightRequests = new Map();

/**
 * Get or create a request promise for deduplication
 * If an identical request is already in flight, return its promise
 * Otherwise, execute the request and cache the promise
 *
 * @param {string} key - Unique key for the request
 * @param {Function} requestFn - Function that executes the actual request
 * @returns {Promise} - The request promise (shared if already in flight)
 */
export async function dedupedRequest(key, requestFn) {
  // Check if this exact request is already in flight
  if (inFlightRequests.has(key)) {
    console.log(`[DEDUP] Reusing in-flight request: ${key}`);
    return inFlightRequests.get(key);
  }

  // Start new request
  const promise = requestFn().finally(() => {
    // Clean up after request completes (success or failure)
    inFlightRequests.delete(key);
  });

  // Cache the promise
  inFlightRequests.set(key, promise);
  return promise;
}

/**
 * Get the current size of the in-flight requests map
 * Useful for monitoring/debugging
 * @returns {number} - Number of in-flight requests
 */
export function getInFlightCount() {
  return inFlightRequests.size;
}

/**
 * Clear all in-flight requests
 * Useful for testing or cleanup
 */
export function clearInFlightRequests() {
  inFlightRequests.clear();
}
