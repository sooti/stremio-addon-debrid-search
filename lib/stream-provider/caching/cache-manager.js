/**
 * Cache management for torrent search results
 * Handles SQLite caching with TTL and Torz API integration
 */

import * as SqliteCache from '../../util/sqlite-cache.js';
import PTT from '../../util/parse-torrent-title.js';
import { SEARCH_CACHE_VERSION } from '../config/timeouts.js';
import { refreshCacheInBackground } from './background-refresh.js';

// Cache TTL configuration
const SCRAPER_CACHE_TTL_SERIES_MIN = process.env.SCRAPER_CACHE_TTL_SERIES_MIN || 43200; // 30 days in minutes
const SCRAPER_CACHE_TTL_MOVIE_MIN = process.env.SCRAPER_CACHE_TTL_MOVIE_MIN || 43200; // 30 days in minutes

/**
 * New caching flow that returns cached results immediately and refreshes in background.
 * This function checks SQLite for cached results first, returns them immediately,
 * and then runs a background task to refresh with fresh data.
 *
 * @param {string} provider - Debrid provider name (e.g., 'RealDebrid')
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Content ID (IMDB ID or IMDB:season:episode)
 * @param {Object} config - User configuration
 * @param {Function} searchFn - Function to execute the actual search
 * @returns {Promise<Array>} - Array of search results
 */
export async function getCachedTorrents(provider, type, id, config, searchFn) {
  if (!SqliteCache.isEnabled()) {
    return searchFn();
  }

  const langKey = (config.Languages || []).join(',');
  const providerKey = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  // For series, replace colons in id (like tt1234567:1:5) with underscores to maintain consistent cache key format
  const normalizedId = type === 'series' ? id.replace(/:/g, '_') : id;
  const cacheKey = `${providerKey}-search-${SEARCH_CACHE_VERSION}:${type}:${normalizedId}:${langKey}`;

  console.log(`[CACHE] Checking cache for ${provider} - ${type}:${id}`);

  // ONLY check Torz API for RealDebrid (fast, ~500ms)
  // For all other services, rely on SQLite cache + background refresh
  let torzResults = [];
  if (provider === 'RealDebrid' && config.IndexerScrapers?.includes('stremthru')) {
    try {
      const stremThru = await import('../../util/stremthru.js');
      const debridService = 'realdebrid';
      const apiKey = config.DebridApiKey || config.DebridServices?.find(s => s.provider === provider)?.apiKey;

      if (apiKey && stremThru.isEnabled()) {
        console.log(`[TORZ] Checking Torz API for RealDebrid - fresh confirmed cached results BEFORE SQLite cache...`);

        // Build stremId based on type
        let stremId, mediaType;
        if (type === 'series') {
          const [imdbId, season, episode] = id.split(':');
          if (season && episode) {
            stremId = `${imdbId}:${season}:${episode}`;
            mediaType = 'series';
          }
        } else if (type === 'movie') {
          stremId = id; // For movies, just use imdbId
          mediaType = 'movie';
        }

        if (stremId && mediaType) {
          const rawTorzResults = await stremThru.getCombinedTorrents(
            mediaType,
            stremId,
            debridService,
            apiKey,
            config
          );

          if (rawTorzResults && rawTorzResults.length > 0) {
            console.log(`[TORZ] API returned ${rawTorzResults.length} confirmed cached results`);
            // Convert Torz results to raw torrent format (remove url field, normalize field names)
            // This allows toStream() to generate proper /resolve/ URLs
            torzResults = rawTorzResults
              .filter(t => {
                // Filter out 0B results
                const size = t.Size || t.size || 0;
                return size > 0;
              })
              .map(t => {
                const torrentName = t.name || t.Title || 'Unknown';

                // Parse torrent title to extract season/episode info for series filtering
                const parsed = PTT.parse(torrentName) || {};

                const normalized = {
                  name: torrentName,
                  title: t.Title || t.name || 'Unknown',
                  hash: (t.InfoHash || t.hash || '').toLowerCase(),
                  infoHash: (t.InfoHash || t.hash || '').toLowerCase(),
                  size: t.Size || t.size || 0,
                  _size: t.Size || t.size || 0,
                  seeders: t.Seeders || 0,
                  tracker: t.Tracker || 'Torz',
                  isConfirmedCached: true,
                  isCached: true,
                  source: provider.toLowerCase(),
                  // Include parsed info for series episode filtering
                  info: {
                    season: parsed.season,
                    episode: parsed.episode,
                    seasons: parsed.seasons
                  }
                  // Explicitly NOT including url field so toStream() generates the proper resolve URL
                };
                return normalized;
              });

            const filteredCount = rawTorzResults.length - torzResults.length;
            if (filteredCount > 0) {
              console.log(`[TORZ] Filtered out ${filteredCount} results with 0B size`);
            }
            console.log(`[TORZ] Converted ${torzResults.length} Torz results to raw torrent format with parsed metadata`);
          } else {
            console.log(`[TORZ] API returned 0 results`);
          }
        }
      }
    } catch (torzError) {
      console.error(`[TORZ] Error checking Torz API: ${torzError.message}`);
      // Continue with cache check
    }
  }

  // Query SQLite for cached results matching the title/type/episode and debrid service
  const cached = await SqliteCache.getCachedRecord('search', cacheKey);
  let searchResults = [];
  let resultCount = 0;

  if (cached) {
    // Handle data structure from SQLite cache
    if (cached.data && typeof cached.data === 'object' && !Array.isArray(cached.data) && cached.data.data) {
      cached.data = cached.data.data;
    }

    if (Array.isArray(cached.data)) {
      searchResults = cached.data;
      resultCount = cached.data.length;
    } else if (cached.data && typeof cached.data === 'object' && Array.isArray(cached.data.data)) {
      searchResults = cached.data.data;
      resultCount = cached.data.resultCount || cached.data.data.length;
    } else {
      searchResults = cached.data || [];
      resultCount = searchResults.length;
    }

    const cacheAge = Date.now() - new Date(cached.updatedAt || cached.createdAt).getTime();
    const cacheAgeMinutes = Math.floor(cacheAge / 60000);
    console.log(`[CACHE] HIT: ${cacheKey} (${resultCount} non-personal results, age: ${cacheAgeMinutes}m)`);
  } else {
    console.log(`[CACHE] MISS: ${cacheKey} - no cached results found`);
  }

  // Combine Torz results with SQLite cache results
  // Deduplicate by hash (prefer Torz over SQLite cache)
  let combinedResults = [];
  const torzHashes = new Set(torzResults.map(r => (r.InfoHash || r.hash || '').toLowerCase()));

  // Add Torz results first (they are fresh and confirmed)
  combinedResults.push(...torzResults);

  // Add SQLite cache results that are not already in Torz results
  // For HTTP streaming: results don't have hash/infoHash, they use URLs instead
  // For debrid/torrent services: deduplicate by hash
  const uniqueCacheResults = searchResults.filter(r => {
    // For HTTP streaming services, always include cached results (no hash-based deduplication)
    if (provider === 'httpstreaming') {
      return true;
    }
    // For torrent/debrid services, require hash and deduplicate against Torz
    const hash = (r.hash || r.infoHash || '').toLowerCase();
    return hash && !torzHashes.has(hash);
  });
  combinedResults.push(...uniqueCacheResults);

  console.log(`[CACHE] Combined results: ${torzResults.length} from Torz + ${uniqueCacheResults.length} unique from SQLite = ${combinedResults.length} total`);

  // If SQLite/Torz has NO results for this service, always do a live check before returning
  // This ensures we don't return stale empty results and properly check all available sources
  // For RealDebrid: Torz is checked first, then falls back to live API if needed
  // For other services (TorBox, Easynews, HTTP streams): live API/scraper is called
  if (combinedResults.length === 0) {
    console.log(`[CACHE] No results found in cache/Torz - performing live check for ${provider}`);
    const freshResults = await searchFn();

    if (freshResults && freshResults.length > 0) {
      console.log(`[CACHE] Live check found ${freshResults.length} results, updating cache`);
      await storeCacheResults(null, cacheKey, freshResults, type, provider);
      return freshResults;
    } else {
      console.log(`[CACHE] Live check returned 0 results, caching empty result`);
      // Cache empty result with timestamp to avoid repeated live checks within TTL
      await storeCacheResults(null, cacheKey, [], type, provider);
      return [];
    }
  }

  // For HTTP streaming: return cached results immediately (no personal files to merge)
  // For debrid services: always fetch fresh to include personal files + merge with cache
  if (provider === 'httpstreaming' && combinedResults.length > 0) {
    console.log(`[CACHE] HTTP streaming cache HIT - returning ${combinedResults.length} cached results immediately for ${cacheKey}`);

    // Trigger background refresh to update cache (don't await)
    refreshCacheInBackground(provider, type, id, config, searchFn, cacheKey, combinedResults)
      .catch(err => console.error(`[CACHE] Background refresh error for ${cacheKey}:`, err.message));

    return combinedResults;
  }

  // For debrid services OR when cache is empty:
  // - Perform normal search which includes personal files and fresh scraping
  // - Personal files are always included (never cached)
  // - Return combined results (cached + personal files + any fresh results)
  if (cached && combinedResults.length > 0) {
    console.log(`[CACHE] Using ${combinedResults.length} cached results, will merge with personal files for ${cacheKey}`);
  } else {
    console.log(`[CACHE] No cached data found, performing fresh search for ${cacheKey}`);
  }
  const freshResults = await searchFn();

  if (freshResults && freshResults.length > 0) {
    console.log(`[CACHE] Storing fresh results for ${cacheKey}: ${freshResults.length} items`);
    await storeCacheResults(null, cacheKey, freshResults, type, provider);
  }

  return freshResults;
}

/**
 * Store search results in cache
 * Filters out personal files and already-resolved streams before caching
 *
 * @param {*} collection - Unused (legacy parameter)
 * @param {string} cacheKey - Cache key for storage
 * @param {Array} results - Search results to cache
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} provider - Provider name
 */
export async function storeCacheResults(collection, cacheKey, results, type, provider) {
  // Allow empty results to update cache timestamp
  if (!results) return;

  // Filter out personal cloud files and any items that are already fully-formed stream objects.
  const cacheableData = results.filter(item => {
    if (!item) return false; // Changed from true - null items shouldn't be cached
    if (item.isPersonal) return false;

    const isHttpStreamingSource = provider === 'httpstreaming';
    if (!isHttpStreamingSource && typeof item.url === 'string' && item.url) {
      return !(item.url.startsWith('http') || item.url.startsWith('/resolve/'));
    }

    return true;
  });

  // Allow storing empty cache to update timestamp (prevents repeated searches)
  // if (cacheableData.length === 0) return; // REMOVED - we want to update timestamp even with 0 results

  const ttlMinutes = type === 'series' ? SCRAPER_CACHE_TTL_SERIES_MIN : SCRAPER_CACHE_TTL_MOVIE_MIN;

  try {
    // Store search results using SQLite cache
    const success = await SqliteCache.upsertCachedMagnet({
      service: 'search',
      hash: cacheKey, // Use the full cache key as hash for lookup
      fileName: null,
      size: cacheableData.length, // Store result count
      data: {
        data: cacheableData, // Actual search results
        resultCount: cacheableData.length
      },
      releaseKey: `search-${type}` // Use releaseKey for categorization
    });

    if (success) {
      console.log(`[CACHE] STORED: ${cacheKey} (${cacheableData.length} results, TTL: ${ttlMinutes}m)`);
    } else {
      console.log(`[CACHE] FAILED to store ${cacheKey}: upsert failed`);
    }
  } catch (e) {
    console.error(`[CACHE] FAILED to store ${cacheKey}:`, e.message);
  }
}

/**
 * Verification functions for cached torrents
 * Logs torrents that need verification (actual verification happens on access)
 *
 * @param {string} apiKey - Debrid service API key
 * @param {string} provider - Provider name
 * @param {Array} cachedResults - Cached results to verify
 */
export async function verifyCachedTorrents(apiKey, provider, cachedResults) {
  if (!apiKey || !cachedResults || cachedResults.length === 0) return;

  console.log(`[VERIFICATION] Marking ${cachedResults.length} cached ${provider} torrents for verification (background process)`);

  // Instead of directly verifying here (which requires complex rate limiting setup),
  // we log that verification is needed. The actual verification typically happens
  // when torrents are accessed/resolved, leveraging the existing debrid service logic.
  try {
    const torrentsToVerify = cachedResults.filter(item => item.hash);
    console.log(`[VERIFICATION] ${provider}: ${torrentsToVerify.length} torrents have hashes for verification`);

    // In practice, when a cached torrent URL is resolved via the /resolve endpoint,
    // it will naturally verify availability in the debrid service
    // This can be enhanced later with more sophisticated verification as needed
  } catch (error) {
    console.error(`[VERIFICATION] Error noting ${provider} cached torrents for verification:`, error.message);
  }
}

/**
 * Refresh HTTP streaming links in background
 * Links are refreshed automatically when accessed via resolver endpoint
 *
 * @param {Array} cachedResults - Cached HTTP streaming results
 */
export async function refreshHttpStreamLinks(cachedResults) {
  if (!cachedResults || cachedResults.length === 0) return;

  console.log(`[VERIFICATION] Preparing to refresh ${cachedResults.length} HTTP stream links (background process)`);

  try {
    // HTTP streaming links are typically refreshed automatically when accessed
    // via the resolver endpoint, which fetches fresh URLs from the source
    const httpStreamingLinks = cachedResults.filter(item =>
      item.url && item.url.includes('/resolve/httpstreaming/')
    );

    console.log(`[VERIFICATION] ${httpStreamingLinks.length} HTTP streaming links will be refreshed on access`);
  } catch (error) {
    console.error('[VERIFICATION] Error noting HTTP stream links for refresh:', error.message);
  }
}
