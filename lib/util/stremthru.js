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
// Note: OffCloud is excluded because it requires user/password authentication
const SERVICE_NAME_MAP = {
  'realdebrid': 'realdebrid',
  'alldebrid': 'alldebrid',
  'real-debrid': 'realdebrid',
  'all-debrid': 'alldebrid',
  'torbox': 'torbox',
  'premiumize': 'premiumize',
  'debridlink': 'debridlink',
  'debriderapp': 'debridlink' // Debrider.app uses same protocol as DebridLink
};

/**
 * Check instant availability for multiple info hashes via StremThru Store API
 * @param {string[]} hashes - Array of info hashes to check
 * @param {string} service - Debrid service name (realdebrid, alldebrid, etc.)
 * @param {string} apiToken - Debrid service API token
 * @param {string} clientIp - Client IP address (optional, for Real-Debrid authentication)
 * @returns {Promise<Set<string>>} - Set of cached hashes
 */
export async function checkInstantAvailability(hashes, service, apiToken, clientIp = null, sid = null) {
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
          let batchUrl = `${apiUrl}?magnet=${batchMagnets}`;
          // Add sid parameter if available for episode-specific filtering (like Torz does)
          if (sid) {
            batchUrl += `&sid=${encodeURIComponent(sid)}`;
          }
          
          const headers = {
            'X-StremThru-Store-Name': stremthruService, // Specify the store name in header
            'X-StremThru-Store-Authorization': `Bearer ${apiToken}`, // Use the API key
            'Content-Type': 'application/json',
            'User-Agent': 'Sootio/1.0'
          };

          // Add client IP headers if available (required for Real-Debrid authentication)
          if (clientIp) {
            headers['X-Forwarded-For'] = clientIp;
            headers['X-Real-IP'] = clientIp;
          }

          const response = await axios.get( // Use GET request as per Python example
            batchUrl,
            {
              headers,
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

            // Filter items that are cached (status: 'downloaded' || 'cached')
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
          } else if (status === 403) {
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: API returned 403 (access forbidden or service not supported)`);
          } else if (status === 500 || status === 503) {
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: API temporarily unavailable (status ${status})`);
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
 * Check instant availability for multiple info hashes via StremThru Store API and return both hashes and file details
 * @param {string[]} hashes - Array of info hashes to check
 * @param {string} service - Debrid service name (realdebrid, alldebrid, etc.)
 * @param {string} apiToken - Debrid service API token
 * @param {string} clientIp - Client IP address (optional, for Real-Debrid authentication)
 * @param {string} sid - Stremio ID in format imdbid:season:episode (e.g. tt4574334:3:7) for series episode filtering
 * @returns {Promise<{hashes: Set<string>, files: Object}>} - Object containing cached hashes and file details
 */
export async function checkInstantAvailabilityWithDetails(hashes, service, apiToken, clientIp = null, sid = null) {
  if (!config.STREMTHRU_ENABLED || !config.STREMTHRU_URL) {
    return { hashes: new Set(), files: {} };
  }

  if (!hashes || hashes.length === 0) {
    return { hashes: new Set(), files: {} };
  }

  if (!apiToken) {
    console.warn(`[${LOG_PREFIX}] No API token provided for ${service}`);
    return { hashes: new Set(), files: {} };
  }

  try {
    // Normalize service name
    const stremthruService = SERVICE_NAME_MAP[service.toLowerCase()] || service.toLowerCase();

    const startTime = Date.now();
    console.log(`[${LOG_PREFIX}] Checking ${hashes.length} hashes for ${service} via StremThru Store API with file details`);

    const cachedHashes = new Set();
    const fileDetails = {};

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
          
          const headers = {
            'X-StremThru-Store-Name': stremthruService, // Specify the store name in header
            'X-StremThru-Store-Authorization': `Bearer ${apiToken}`, // Use the API key
            'Content-Type': 'application/json',
            'User-Agent': 'Sootio/1.0'
          };

          // Add client IP headers if available (required for Real-Debrid authentication)
          if (clientIp) {
            headers['X-Forwarded-For'] = clientIp;
            headers['X-Real-IP'] = clientIp;
          }

          const response = await axios.get( // Use GET request as per Python example
            batchUrl,
            {
              headers,
              timeout: 10000 // 10s timeout for API request
            }
          );

          // Response format: { data: { items: [...] } } - as per Go implementation
          if (response.data?.data?.items) {
            const items = response.data.data.items;
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Found ${items.length} results`);

            // Process cached items to extract both hash and file details
            for (const item of items) {
              if (item.status === 'downloaded' || item.status === 'cached') {
                const hash = item.hash.toLowerCase();
                cachedHashes.add(hash);
                
                // Store file details if available
                if (item.files && Array.isArray(item.files)) {
                  fileDetails[hash] = item.files.map(file => ({
                    path: file.path || file.name || '',
                    name: file.name || file.path || '',
                    size: file.size || 0,
                    selected: file.selected,
                    // Include any other available properties for better matching
                    id: file.id,
                    idx: file.idx,
                    link: file.link
                  }));
                }
              }
            }

            const cachedCount = items.filter(item => item.status === 'downloaded' || item.status === 'cached').length;
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: ${cachedCount}/${items.length} are cached`);

            // Return the cached hashes for this batch and the file details
            return { hashes: items.filter(item => item.status === 'downloaded' || item.status === 'cached').map(item => item.hash.toLowerCase()), files: {} };
          } else if (response.data?.items) {
            // Alternative response format
            const items = response.data.items;
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Found ${items.length} results (alt format)`);

            // Process cached items to extract both hash and file details
            for (const item of items) {
              if (item.status === 'downloaded' || item.status === 'cached') {
                const hash = item.hash.toLowerCase();
                cachedHashes.add(hash);
                
                // Store file details if available
                if (item.files && Array.isArray(item.files)) {
                  fileDetails[hash] = item.files.map(file => ({
                    path: file.path || file.name || '',
                    name: file.name || file.path || '',
                    size: file.size || 0,
                    selected: file.selected,
                    // Include any other available properties for better matching
                    id: file.id,
                    idx: file.idx,
                    link: file.link
                  }));
                }
              }
            }

            const cachedCount = items.filter(item => item.status === 'downloaded' || item.status === 'cached').length;
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: ${cachedCount}/${items.length} are cached (alt format)`);

            // Return the cached hashes for this batch and the file details
            return { hashes: items.filter(item => item.status === 'downloaded' || item.status === 'cached').map(item => item.hash.toLowerCase()), files: {} };
          }

          console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: No items in response`);
          return { hashes: [], files: {} };
        } catch (error) {
          const status = error.response?.status;
          const message = error.message;

          // Log the error but don't fail the entire operation
          if (status === 404) {
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: API returned 404 (service may not support this endpoint)`);
          } else if (status === 403) {
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: API returned 403 (access forbidden or service not supported)`);
          } else if (status === 500 || status === 503) {
            console.log(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: API temporarily unavailable (status ${status})`);
          } else if (error.code === 'ECONNABORTED') {
            console.warn(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Request timeout`);
          } else {
            console.error(`[${LOG_PREFIX}] Batch ${index + 1}/${batches.length}: Error - ${message} (status: ${status})`);
          }

          return { hashes: [], files: {} };
        }
      })
    );

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

    return { hashes: cachedHashes, files: fileDetails };

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error checking instant availability with details: ${error.message}`);
    return { hashes: new Set(), files: {} };
  }
}

/**
 * Check if StremThru is enabled and configured
 * @returns {boolean}
 */
export function isEnabled() {
  return config.STREMTHRU_ENABLED && Boolean(config.STREMTHRU_URL);
}

/**
 * Get torrents by StremId using the Torz approach (if endpoint available)
 * @param {string} type - Content type (movie, series) 
 * @param {string} id - StremId (e.g. tt4574334, tt4574334:3:7)
 * @param {string} debridService - Debrid service name (e.g. 'realdebrid', 'alldebrid')
 * @param {string} debridToken - Debrid API token
 * @param {boolean} cachedOnly - Only return cached results
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function getTorrentsByStremId(type, id, debridService, debridToken, cachedOnly = true) {
  if (!config.STREMTHRU_ENABLED || !config.STREMTHRU_URL) {
    return [];
  }

  try {
    // Create the user token object as per Torz format
    // Map service names to Torz service codes
    const serviceCodeMap = {
      'realdebrid': 'rd',
      'alldebrid': 'ad',
      'torbox': 'tb',
      'premiumize': 'pm',
      'offcloud': 'oc',
      'debridlink': 'dl'
    };
    const serviceCode = serviceCodeMap[debridService.toLowerCase()] || debridService.toLowerCase();

    const tokenObj = {
      stores: [{
        c: serviceCode,
        t: debridToken
      }],
      cached: cachedOnly
    };
    
    // Encode as base64 URL-safe (similar to how Torz does it)
    // In Node.js environments, we use Buffer
    const jsonString = JSON.stringify(tokenObj);
    
    // Node.js base64 encoding
    const base64Str = Buffer.from(jsonString, 'utf8').toString('base64');
    
    const token = base64Str
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, ''); // Remove trailing equals signs

    const baseUrl = config.STREMTHRU_URL.replace(/\/$/, '');
    const response = await axios.get(`${baseUrl}/stremio/torz/${token}/stream/${type}/${id}.json`, {
      headers: {
        'User-Agent': 'Sootio/1.0',
        'Accept': 'application/json'
      },
      timeout: 15000 // Slightly longer timeout for comprehensive results
    });

    // Extract torrents from streams
    const streams = response.data?.streams || [];
    const torrents = streams.map(stream => {
      // Extract infohash from behaviorHints.bingeGroup (format: "torz:HASH")
      // or from stream.infoHash if available
      let infoHash = stream.infoHash;
      if (!infoHash && stream.behaviorHints?.bingeGroup) {
        const bingeGroup = stream.behaviorHints.bingeGroup;
        // Remove "torz:" prefix if present
        infoHash = bingeGroup.startsWith('torz:') ? bingeGroup.substring(5) : bingeGroup;
      }

      // Use filename from behaviorHints instead of description (which has emojis and formatting)
      const title = stream.behaviorHints?.filename || stream.name || 'Unknown';

      return {
        Title: title,
        InfoHash: infoHash,
        Size: stream.behaviorHints?.videoSize || stream._size || 0,
        Seeders: 0, // Torz doesn't return seeders in stream format
        Tracker: 'Torz-' + (debridService || 'unknown'),
        name: title,
        url: stream.url
      };
    }).filter(t => t.InfoHash); // Only return torrents with valid infohash

    console.log(`[${LOG_PREFIX}] Retrieved ${torrents.length} torrents from Torz API for ${type}/${id}`);
    return torrents;
  } catch (error) {
    const status = error?.response?.status;

    // Handle known error codes gracefully
    if (status === 404) {
      console.log(`[${LOG_PREFIX}] Torz endpoint not available at ${config.STREMTHRU_URL}, using fallback methods`);
      return [];
    } else if (status === 403) {
      console.log(`[${LOG_PREFIX}] Torz API access forbidden for ${debridService} (may not be supported or invalid credentials)`);
      return [];
    } else if (status === 500 || status === 503) {
      console.log(`[${LOG_PREFIX}] Torz API temporarily unavailable for ${debridService} (status ${status}), using fallback methods`);
      return [];
    }

    console.error(`[${LOG_PREFIX}] Error fetching torrents from Torz API: ${error.message}`);
    return [];
  }
}

/**
 * Get comprehensive torrents using both Store API and Torz-style API
 * @param {string} type - Content type (series, movie)
 * @param {string} mediaId - Media ID (e.g. tt4574334:3:7)
 * @param {string} debridService - Debrid service name
 * @param {string} debridToken - Debrid API token
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} - Combined array of torrent results
 */
export async function getCombinedTorrents(type, mediaId, debridService, debridToken, config = {}) {
  const results = [];
  
  try {
    // Get results from the Torz-style API (direct by stremId)
    const torzResults = await getTorrentsByStremId(type, mediaId, debridService, debridToken, true);
    results.push(...torzResults);
    
    console.log(`[${LOG_PREFIX}] Combined torrent fetch: ${torzResults.length} from Torz-style API`);
    
    return results;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error in combined torrent fetch:`, error);
    // Still return any results we got before the error
    return results;
  }
}

export default {
  checkInstantAvailability,
  checkInstantAvailabilityWithDetails,
  getTorrentsByStremId,
  getCombinedTorrents,
  isEnabled
};
