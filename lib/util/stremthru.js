import axios from 'axios';
import * as config from '../config.js';
import * as sqliteCache from './sqlite-cache.js';
import { addHashToSqlite, deferSqliteUpserts, uniqueUpserts } from './debrid-helpers.js';

const LOG_PREFIX = 'STREMTHRU';

/**
 * StremThru/Torz integration for bulk availability checking with SQLite caching
 * 
 * Now we store StremThru results in SQLite so they persist and can be used for future lookups
 */

// Map our service names to StremThru service names
const SERVICE_NAME_MAP = {
  'realdebrid': 'realdebrid',
  'alldebrid': 'alldebrid',
  'real-debrid': 'realdebrid',
  'all-debrid': 'alldebrid'
};

/**
 * Check instant availability for multiple info hashes via StremThru Store API
 * @param {string[]} hashes - Array of info hashes to check
 * @param {string} service - Debrid service name (realdebrid, alldebrid, etc.)
 * @param {string} apiToken - Debrid service API token
 * @returns {Promise<Set<string>>} - Set of cached hashes
 */
export async function checkInstantAvailability(hashes, service, apiToken) {
  if (!config.STREMTHRU_ENABLED || !config.STREMTHRU_URL) {
    return new Set();
  }

  if (!hashes || hashes.length === 0) {
    return new Set();
  }

  if (!apiToken) {
    console.warn(`[${LOG_PREFIX}] No API token provided for ${service}`);
    return new Set();
  }

  try {
    // Normalize service name
    const stremthruService = SERVICE_NAME_MAP[service.toLowerCase()] || service.toLowerCase();

    const startTime = Date.now();
    console.log(`[${LOG_PREFIX}] Checking ${hashes.length} hashes for ${service} via StremThru Store API`);

    const cachedHashes = new Set();

    // StremThru Store API endpoint - use GET request with query params as per Python example
    const baseUrl = config.STREMTHRU_URL.replace(/\/$/, '');
    const apiUrl = `${baseUrl}/v0/store/magnets/check`;

    // Convert hashes to magnet links for the API (based on Python example)
    const magnets = hashes.map(hash => `magnet:?xt=urn:btih:${hash}`);

    // StremThru supports batches of up to 500 magnets
    const BATCH_SIZE = 500;
    const batches = [];
    for (let i = 0; i < magnets.length; i += BATCH_SIZE) {
      batches.push(magnets.slice(i, i + BATCH_SIZE));
    }

    console.log(`[${LOG_PREFIX}] Checking ${batches.length} batch(es) of magnets`);

    // Process all batches in parallel
    const batchResults = await Promise.all(
      batches.map(async (batch, index) => {
        try {
          // Build the URL with the magnet values as query parameters (as per Python example)
          const batchMagnets = batch.join(',');
          const batchUrl = `${apiUrl}?magnet=${batchMagnets}`;
          
          const response = await axios.get( // Use GET request as per Python example
            batchUrl,
            {
              headers: {
                'X-StremThru-Store-Name': stremthruService, // Specify the store name in header
                'X-StremThru-Store-Authorization': `Bearer ${apiToken}`, // Use the API key
                'Content-Type': 'application/json',
                'User-Agent': 'Sootio/1.0'
              },
              timeout: 10000 // 10s timeout for API request
            }
          );

          // Response format: { data: { items: [...] } } - as per Go implementation
          if (response.data?.data?.items) {
            const items = response.data.data.items;
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Found ${items.length} results`);

            // Filter items that are cached (status: 'downloaded' or 'cached')
            const cached = items.filter(item => item.status === 'downloaded' || item.status === 'cached');
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: ${cached.length}/${items.length} are cached`);

            return cached.map(item => item.hash.toLowerCase());
          } else if (response.data?.items) {
            // Alternative response format
            const items = response.data.items;
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Found ${items.length} results (alt format)`);

            // Filter items that are cached (status: 'downloaded' or 'cached')
            const cached = items.filter(item => item.status === 'downloaded' || item.status === 'cached');
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: ${cached.length}/${items.length} are cached (alt format)`);

            return cached.map(item => item.hash.toLowerCase());
          }

          console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: No items in response`);
          return [];
        } catch (error) {
          const status = error.response?.status;
          const message = error.message;

          // Log the error but don't fail the entire operation
          if (status === 404) {
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: API returned 404 (service may not support this endpoint)`);
          } else if (error.code === 'ECONNABORTED') {
            console.warn(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Request timeout`);
          } else {
            console.error(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Error - ${message} (status: ${status})`);
          }

          return [];
        }
      })
    );

    // Combine all results
    const allCachedHashes = batchResults.flat();
    allCachedHashes.forEach(hash => cachedHashes.add(hash.toLowerCase()));

    // Store StremThru results in SQLite cache
    if (sqliteCache?.isEnabled() && cachedHashes.size > 0) {
      try {
        const upserts = [];
        for (const hash of cachedHashes) {
          upserts.push({
            service: service.toLowerCase(),
            hash: hash.toLowerCase(),
            fileName: null, // StremThru doesn't provide file names immediately
            size: null,     // StremThru doesn't provide size immediately
            data: { source: 'stremthru', status: 'cached' },
            releaseKey: `stremthru-cache:${service}`
          });
        }
        // Save to SQLite immediately
        deferSqliteUpserts(uniqueUpserts(upserts));
      } catch (cacheError) {
        console.error(`[${LOG_PREFIX}] Error storing StremThru results in SQLite: ${cacheError.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[${LOG_PREFIX}] Found ${cachedHashes.size}/${hashes.length} cached hashes via StremThru for ${service} in ${elapsed}ms`);

    return cachedHashes;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error checking instant availability: ${error.message}`);
    return new Set();
  }
}

/**
 * Check if StremThru is enabled and configured
 * @returns {boolean}
 */
export function isEnabled() {
  return config.STREMTHRU_ENABLED && Boolean(config.STREMTHRU_URL);
}

export default {
  checkInstantAvailability,
  isEnabled
};
