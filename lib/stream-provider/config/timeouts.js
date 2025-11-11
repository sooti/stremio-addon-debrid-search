/**
 * Service timeout configuration (in milliseconds)
 * Prevents slow services from blocking fast ones
 */

// Default timeout for debrid services (150 seconds)
export const SERVICE_TIMEOUT_MS = parseInt(process.env.SERVICE_TIMEOUT_MS) || 150000;

// Timeout for HTTP streaming services (10 seconds - faster response expected)
export const HTTP_STREAMING_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS) || 10000;

// Timeout for Usenet services (20 seconds - slower than HTTP but faster than torrents)
export const USENET_TIMEOUT_MS = parseInt(process.env.USENET_TIMEOUT_MS) || 20000;

// Cache version for search results - increment to invalidate all search caches
// This should be bumped when the format of cached results changes or when
// the underlying scrapers (4KHDHub, UHDMovies, etc.) are significantly updated
export const SEARCH_CACHE_VERSION = 'v2';

/**
 * Wraps a promise with a timeout to prevent slow services from blocking fast ones
 * @param {Promise} promise - The promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} serviceName - Name of the service (for logging)
 * @returns {Promise} - Promise that resolves/rejects with timeout
 */
export function withTimeout(promise, timeoutMs, serviceName = 'service') {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${serviceName} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).catch(err => {
    if (err.message.includes('timeout')) {
      console.warn(`[TIMEOUT] ${serviceName} exceeded ${timeoutMs}ms - returning empty results`);
    } else {
      console.error(`[ERROR] ${serviceName} failed:`, err.message);
    }
    return []; // Return empty array on timeout or error
  });
}
