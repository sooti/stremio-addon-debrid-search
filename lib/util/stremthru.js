import axios from 'axios';
import * as config from '../config.js';

const LOG_PREFIX = 'STREMTHRU';

/**
 * StremThru/Torz integration - NOT SUITABLE FOR BULK AVAILABILITY CHECKING
 *
 * After investigation, StremThru/Torz is designed for Stremio addon streaming,
 * not for bulk hash checking during scraping. Key limitations:
 *
 * 1. Requires IMDB ID (tt number) to query - we only have hashes during scraping
 * 2. No batch endpoint for checking multiple hashes at once
 * 3. Uses Stremio addon protocol (stream endpoints), not REST API
 * 4. SDK (stremthru npm package) also wraps addon protocol, not a bulk check API
 *
 * CONCLUSION: Cannot be used for instant availability checking in our scraping workflow.
 * The MongoDB cache optimization already implemented is the correct approach.
 *
 * This module is kept as a placeholder and always returns empty results.
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

    // StremThru Store API endpoint
    const baseUrl = config.STREMTHRU_URL.replace(/\/$/, '');
    const apiUrl = `${baseUrl}/store/${stremthruService}/check`;

    // Convert hashes to magnet links for the API
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
          const response = await axios.post(
            apiUrl,
            { magnet: batch },
            {
              headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Sootio/1.0'
              },
              timeout: 10000 // 10s timeout for API request
            }
          );

          // Response format: { data: { items: [...] } }
          if (response.data?.items) {
            const items = response.data.items;
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Found ${items.length} results`);

            // Filter items that are cached (status: 'downloaded')
            const cached = items.filter(item => item.status === 'downloaded');
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: ${cached.length}/${items.length} are cached`);

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
