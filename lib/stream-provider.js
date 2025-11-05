import { get4KHDHubStreams, getStreamSrcStreams } from './http-streams.js';
import { getUHDMoviesStreams } from './uhdmovies.js';
import Cinemeta from './util/cinemeta.js';
import DebridLink from './debrid-link.js';
import RealDebrid from './real-debrid.js';
import RealDebridClient from 'real-debrid-api';
import RdLimiter from './util/rd-rate-limit.js';
import AllDebrid from './all-debrid.js';
import Premiumize from './premiumize.js';
import OffCloud from './offcloud.js';
import TorBox from './torbox.js';
import DebriderApp from './debrider.app.js';
import Usenet from './usenet.js';
import HomeMedia from './home-media.js';
import * as SqliteCache from './util/sqlite-cache.js';
import { BadRequestError } from './util/error-codes.js';
import { FILE_TYPES } from './util/file-types.js';
import { filterSeason, filterEpisode, filterYear, matchesSeriesTitle, hasEpisodeMarker } from './util/filter-torrents.js';
import { getResolutionFromName, formatSize, getCodec, resolutionOrder, sizeToBytes } from './common/torrent-utils.js';
import PTT from './util/parse-torrent-title.js';
import { renderLanguageFlags, detectLanguagesFromTitle, filterStreamsByLanguage } from './util/language-mapping.js';

const ADDON_HOST = process.env.ADDON_URL;

// Service timeout configuration (in milliseconds)
// Prevents slow services from blocking fast ones
const SERVICE_TIMEOUT_MS = parseInt(process.env.SERVICE_TIMEOUT_MS) || 150000; // 150 seconds default
const HTTP_STREAMING_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS) || 10000; // 10 seconds for HTTP streams
const USENET_TIMEOUT_MS = parseInt(process.env.USENET_TIMEOUT_MS) || 20000; // 20 seconds for Usenet (slower)

// Cache version for search results - increment to invalidate all search caches
// This should be bumped when the format of cached results changes or when
// the underlying scrapers (4KHDHub, UHDMovies, etc.) are significantly updated
const SEARCH_CACHE_VERSION = 'v2';

// ---------------------------------------------------------------------------------
// Service Timeout Wrapper
// ---------------------------------------------------------------------------------
/**
 * Wraps a promise with a timeout to prevent slow services from blocking fast ones
 * @param {Promise} promise - The promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} serviceName - Name of the service (for logging)
 * @returns {Promise} - Promise that resolves/rejects with timeout
 */
function withTimeout(promise, timeoutMs, serviceName = 'service') {
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

// ---------------------------------------------------------------------------------
// In-Flight Request Deduplication
// ---------------------------------------------------------------------------------
// Track in-flight requests to prevent duplicate concurrent searches
// Key format: "provider:type:id:lang1,lang2"
const inFlightRequests = new Map();

/**
 * Get or create a request promise for deduplication
 * If an identical request is already in flight, return its promise
 * Otherwise, execute the request and cache the promise
 */
async function dedupedRequest(key, requestFn) {
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
 * Wrap HTTP streaming URLs with the resolver endpoint for lazy resolution
 * @param {Array} streams - Array of stream objects from HTTP sources
 * @returns {Array} - Streams with URLs wrapped in resolver endpoint
 */
function wrapHttpStreamsWithResolver(streams) {
  const base = ADDON_HOST || '';

  return streams.map(stream => {
    // Check if this stream needs lazy resolution
    if (stream.needsResolution && stream.url) {
      const encodedUrl = encodeURIComponent(stream.url);
      const resolverUrl = (base && base.startsWith('http'))
        ? `${base}/resolve/httpstreaming/${encodedUrl}`
        : stream.url; // Fallback to original if no base URL

      return {
        ...stream,
        url: resolverUrl,
        needsResolution: undefined // Remove the flag
      };
    }

    return stream;
  });
}

export const STREAM_NAME_MAP = {
  debridlink: "[DL+] Sootio",
  realdebrid: "[RD+] Sootio",
  alldebrid: "[AD+] Sootio",
  premiumize: "[PM+] Sootio",
  torbox: "[TB+] Sootio",
  offcloud: "[OC+] Sootio",
  debriderapp: "[DBA+] Sootio",
  personalcloud: "[PC+] Sootio",
  usenet: "[UN+] Sootio",
  homemedia: "[HM+] Sootio",
  httpstreaming: "[HS+] Sootio"
};

// DEPRECATED: Old LANG_FLAGS mapping - now using centralized language-mapping.js
// Kept for reference only - renderLangFlags is now imported from language-mapping.js

function isValidUrl(url) {
  return url &&
    typeof url === 'string' &&
    url !== 'undefined' &&
    url !== 'null' &&
    url.length > 0 &&
    (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:') || url.startsWith('/resolve/') || url.startsWith('/torbox/') || url.startsWith('realdebrid:') || url.startsWith('nzb:'));
}

function isVideo(filename) {
  if (!filename || typeof filename !== 'string') return false;
  const exts = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.mpg','.mpeg','.3gp','.ogv','.ts','.m2ts'];
  const i = filename.toLowerCase().lastIndexOf('.');
  if (i < 0) return false;
  return exts.includes(filename.toLowerCase().substring(i));
}

function sortTorrents(a, b) {
  const nameA = a.name || a.title || '';
  const nameB = b.name || b.title || '';
  const resA = getResolutionFromName(nameA);
  const resB = getResolutionFromName(nameB);
  const rankA = resolutionOrder[resA] || 0;
  const rankB = resolutionOrder[resB] || 0;
  if (rankA !== rankB) return rankB - rankA;
  const sizeA = a.size || 0;
  const sizeB = b.size || 0;
  return sizeB - sizeA;
}

function filterBySize(streams, minSizeGB, maxSizeGB) {
  // If both are at defaults (0 and 200), no filtering
  if (minSizeGB === 0 && maxSizeGB === 200) {
    return streams;
  }

  const minSizeBytes = minSizeGB * 1024 * 1024 * 1024;
  const maxSizeBytes = maxSizeGB * 1024 * 1024 * 1024;

  return streams.filter(stream => {
    // Extract size from the stream object
    // Size could be in the original details or we need to parse from title
    // It could be a number (bytes) or a formatted string (like "6.91GB")
    let size = stream.size || stream._size || 0;

    // If size is a string (like "6.91GB"), convert it to bytes
    if (typeof size === 'string') {
      size = sizeToBytes(size);
    }

    if (size === 0) {
      // If no size info, keep the stream (don't filter unknown sizes)
      return true;
    }

    return size >= minSizeBytes && size <= maxSizeBytes;
  });
}

const SCRAPER_CACHE_TTL_SERIES_MIN = process.env.SCRAPER_CACHE_TTL_SERIES_MIN || 43200; // 30 days in minutes
const SCRAPER_CACHE_TTL_MOVIE_MIN = process.env.SCRAPER_CACHE_TTL_MOVIE_MIN || 43200; // 30 days in minutes





/**
 * New caching flow that returns cached results immediately and refreshes in background.
 * This function checks SQLite for cached results first, returns them immediately,
 * and then runs a background task to refresh with fresh data.
 */
async function getCachedTorrents(provider, type, id, config, searchFn) {
  if (!SqliteCache.isEnabled()) {
    return searchFn();
  }

  const langKey = (config.Languages || []).join(',');
  const providerKey = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  // For series, replace colons in id (like tt1234567:1:5) with underscores to maintain consistent cache key format
  const normalizedId = type === 'series' ? id.replace(/:/g, '_') : id;
  const cacheKey = `${providerKey}-search-${SEARCH_CACHE_VERSION}:${type}:${normalizedId}:${langKey}`;

  console.log(`[CACHE] Checking cache for ${provider} - ${type}:${id}`);

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

  // Include any cached personal cloud files (using the existing user cloud lookup function)
  let combinedResults = [...searchResults];

  // Fetch personal files from the debrid service if applicable and combine with cached results
  if (cached) { // Only fetch personal files if there are cached results to return immediately
    try {
      let apiKey = config.DebridApiKey;
      if (Array.isArray(config.DebridServices)) {
        const service = config.DebridServices.find(s => s.provider === provider);
        if (service) apiKey = service.apiKey;
      }

      if (apiKey && provider === 'RealDebrid') {
        const RealDebrid = (await import('./real-debrid.js')).default;
        const Cinemeta = (await import('./util/cinemeta.js')).default;
        const imdbId = id.split(':')[0];
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        const searchKey = cinemetaDetails?.name || imdbId;
        const personalFiles = await RealDebrid.searchPersonalFiles(apiKey, searchKey);
        let filteredPersonalFiles = personalFiles;
        if (type === 'series' && id.includes(':')) {
          const [, season, episode] = id.split(':');
          if (season && episode) {
            const PTT = (await import('./util/parse-torrent-title.js')).default;
            const originalCount = personalFiles.length;
            filteredPersonalFiles = personalFiles.filter(file => {
              const parsed = PTT.parse(file.name || '');
              return parsed.season === parseInt(season, 10) && parsed.episode === parseInt(episode, 10);
            });
            if (filteredPersonalFiles.length < originalCount) {
              console.log(`[CACHE] Filtered personal files for S${season}E${episode}: ${originalCount} -> ${filteredPersonalFiles.length}`);
            }
          }
        }
        const formattedPersonal = filteredPersonalFiles.map(file => ({
          ...file,
          source: 'realdebrid',
          isPersonal: true,
          isCached: true
        }));
        combinedResults = [...searchResults, ...formattedPersonal];
        console.log(`[CACHE] Returning immediate results: ${searchResults.length || 0} cached + ${formattedPersonal.length} personal`);
      } else if (apiKey && provider === 'TorBox') {
        const TorBox = (await import('./torbox.js')).default;
        const Cinemeta = (await import('./util/cinemeta.js')).default;
        const imdbId = id.split(':')[0];
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        const searchKey = cinemetaDetails?.name || imdbId;
        const personalFiles = await TorBox.searchPersonalFiles(apiKey, searchKey);
        let filteredPersonalFiles = personalFiles;
        if (type === 'series' && id.includes(':')) {
          const [, season, episode] = id.split(':');
          if (season && episode) {
            const PTT = (await import('./util/parse-torrent-title.js')).default;
            const originalCount = personalFiles.length;
            filteredPersonalFiles = personalFiles.filter(file => {
              const parsed = PTT.parse(file.name || '');
              return parsed.season === parseInt(season, 10) && parsed.episode === parseInt(episode, 10);
            });
            if (filteredPersonalFiles.length < originalCount) {
              console.log(`[CACHE] Filtered personal files for S${season}E${episode}: ${originalCount} -> ${filteredPersonalFiles.length}`);
            }
          }
        }
        const formattedPersonal = filteredPersonalFiles.map(file => ({
          ...file,
          source: 'torbox',
          isPersonal: true,
          isCached: true
        }));
        combinedResults = [...searchResults, ...formattedPersonal];
        console.log(`[CACHE] Returning immediate results: ${searchResults.length || 0} cached + ${formattedPersonal.length} personal`);
      } else if (apiKey && provider === 'OffCloud') {
        const OffCloud = (await import('./offcloud.js')).default;
        const Cinemeta = (await import('./util/cinemeta.js')).default;
        const imdbId = id.split(':')[0];
        const [season, episode] = id.split(':').slice(1);
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        const searchKey = cinemetaDetails?.name || imdbId;
        const alternateTitles = cinemetaDetails.alternateTitles || [];
        const allSearchKeys = [searchKey, ...alternateTitles].filter(Boolean);
        const specificSearchKey = type === 'series'
            ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
            : `${searchKey} ${cinemetaDetails.year || ''}`.trim();
        const personalFiles = await OffCloud.searchPersonalFiles(apiKey, allSearchKeys, specificSearchKey, type, season, episode);
        const formattedPersonal = personalFiles.map(file => ({
          ...file,
          source: 'offcloud',
          isPersonal: true,
          isCached: true
        }));
        combinedResults = [...searchResults, ...formattedPersonal];
        console.log(`[CACHE] Returning immediate results: ${searchResults.length || 0} cached + ${formattedPersonal.length} personal`);
      } else if (apiKey && provider === 'AllDebrid') {
        const AllDebrid = (await import('./all-debrid.js')).default;
        const Cinemeta = (await import('./util/cinemeta.js')).default;
        const imdbId = id.split(':')[0];
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        const searchKey = cinemetaDetails?.name || imdbId;
        const personalFiles = await AllDebrid.searchPersonalFiles(apiKey, searchKey);
        let filteredPersonalFiles = personalFiles;
        if (type === 'series' && id.includes(':')) {
          const [, season, episode] = id.split(':');
          if (season && episode) {
            const PTT = (await import('./util/parse-torrent-title.js')).default;
            const originalCount = personalFiles.length;
            filteredPersonalFiles = personalFiles.filter(file => {
              const parsed = PTT.parse(file.name || '');
              return parsed.season === parseInt(season, 10) && parsed.episode === parseInt(episode, 10);
            });
            if (filteredPersonalFiles.length < originalCount) {
              console.log(`[CACHE] Filtered personal files for S${season}E${episode}: ${originalCount} -> ${filteredPersonalFiles.length}`);
            }
          }
        }
        const formattedPersonal = filteredPersonalFiles.map(file => ({
          ...file,
          source: 'alldebrid',
          isPersonal: true,
          isCached: true
        }));
        combinedResults = [...searchResults, ...formattedPersonal];
        console.log(`[CACHE] Returning immediate results: ${searchResults.length || 0} cached + ${formattedPersonal.length} personal`);
      } else if (apiKey && provider === 'DebriderApp') {
        const DebriderApp = (await import('./debrider.app.js')).default;
        const Cinemeta = (await import('./util/cinemeta.js')).default;
        const imdbId = id.split(':')[0];
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        const tasks = await DebriderApp.getTasks(apiKey);
        const personalFiles = DebriderApp.getPersonalStreams(tasks, type, id, cinemetaDetails);
        const formattedPersonal = personalFiles.map(file => ({
          ...file,
          source: 'debriderapp',
          isPersonal: true,
          isCached: true
        }));
        combinedResults = [...searchResults, ...formattedPersonal];
        console.log(`[CACHE] Returning immediate results: ${searchResults.length || 0} cached + ${formattedPersonal.length} personal`);
      } else {
        console.log(`[CACHE] Returning immediate results: ${searchResults.length || 0} cached`);
      }
    } catch (err) {
      console.error(`[CACHE] Error fetching personal files for immediate response: ${err.message}`);
      combinedResults = [...searchResults]; // Just return cached results
    }

    // If cache exists: immediately return cached results grouped per debrid service to the user
    if (searchResults.length > 0 || combinedResults.length > 0) {
      // Do not scrape or perform any debrid API checks yet - return immediately
      console.log(`[CACHE] Returning immediate response with ${combinedResults.length} cached results`);

      // Start a non-blocking background refresh task that:
      // - Scrapes new torrents using existing scrapers
      // - Checks each torrent hash against debrid caches (all supported services + http-streams)
      // - Compares with existing SQLite entries
      // - Inserts any new results not already cached
      // - Updates timestamps if entries are refreshed
      // Should be asynchronous and non-blocking
      setImmediate(async () => {
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
              const currentHashes = new Set(searchResults.map(r => r.hash || r.infoHash || (r.name ? r.name.toLowerCase() : '')));
              
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
      });

      // Return cached results immediately
      return combinedResults;
    }
  }

  // If there is no cached data in SQLite:
  // - Perform normal scraping and debrid cache checking
  // - Insert all resulting playable sources (including http-streams) into SQLite
  // - Return the results to the user normally
  console.log(`[CACHE] No cached data found, performing fresh search for ${cacheKey}`);
  const freshResults = await searchFn();
  
  if (freshResults && freshResults.length > 0) {
    console.log(`[CACHE] Storing fresh results for ${cacheKey}: ${freshResults.length} items`);
    await storeCacheResults(null, cacheKey, freshResults, type, provider);
  }
  
  return freshResults;
}

// Helper function to store cache results (DRY principle)
async function storeCacheResults(collection, cacheKey, results, type, provider) {
  if (!results || results.length === 0) return;

  // Filter out personal cloud files and any items that are already fully-formed stream objects.
  const cacheableData = results.filter(item => {
    if (!item) return true;
    if (item.isPersonal) return false;

    const isHttpStreamingSource = provider === 'httpstreaming';
    if (!isHttpStreamingSource && typeof item.url === 'string' && item.url) {
      return !(item.url.startsWith('http') || item.url.startsWith('/resolve/'));
    }

    return true;
  });

  if (cacheableData.length === 0) return;

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

// Background task to refresh cache with new data
async function refreshCacheInBackground(provider, type, id, config, searchFn, cacheKey, existingResults) {
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

// Helper to fetch movie streams from a single debrid service
async function getMovieStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey) {
  // Create a config copy with the correct API key for this specific provider
  const providerConfig = { ...config, DebridApiKey: apiKey };
  if (debridProvider == "DebridLink") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebridLink.searchTorrents(apiKey, searchKey, 0.1));
    if (torrents.background) return [];
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterYear(t, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list.sort(sortTorrents).map(t => toStream(t, type, providerConfig)).filter(Boolean));
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config, config.clientIp));
    if (allResults.background) return [];
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = hasEpisodeMarker(name, 1, 1); // Check for S01E01 to guess if it's a series
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, providerConfig);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config, config.clientIp));
    if (allResults.background) return [];
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = hasEpisodeMarker(name, 1, 1); // Check for S01E01 to guess if it's a series
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, providerConfig);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => Premiumize.search(apiKey, type, id, config));
    if (torrents.background) return [];
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => OffCloud.searchOffcloudTorrents(apiKey, type, id));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider == "TorBox") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => TorBox.searchTorboxTorrents(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider == "DebriderApp") {
    // Check if this service has Newznab configured for Personal Cloud NZB support
    let serviceConfig = config;
    if (Array.isArray(config.DebridServices)) {
      const service = config.DebridServices.find(s => s.provider === 'DebriderApp');
      if (service && (service.newznabUrl || service.newznabApiKey)) {
        // Use searchWithPersonalCloud to include NZB results
        serviceConfig = {
          ...config,
          newznabUrl: service.newznabUrl,
          newznabApiKey: service.newznabApiKey
        };
        console.log(`[DBA] Newznab configured, using searchWithPersonalCloud`);
        const baseUrl = 'https://debrider.app/api/v1';
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, serviceConfig, baseUrl));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      } else {
        // Regular search without Newznab
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      }
    } else {
      // Fallback to regular search
      const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
      if (torrents && torrents.length) {
        return torrents.sort(sortTorrents)
          .map(td => toDebriderStream(td, type, providerConfig))
          .filter(Boolean);
      }
    }
  } else if (debridProvider == "PersonalCloud") {
    const personalCloudConfig = {
      newznabUrl: config.PersonalCloudNewznabUrl,
      newznabApiKey: config.PersonalCloudNewznabApiKey,
      ...config
    };
    const baseUrl = config.PersonalCloudUrl || 'https://debrider.app/api/v1';
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, personalCloudConfig, baseUrl));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toDebriderStream(td, type, providerConfig))
        .filter(Boolean);
    }
  }
  return [];
}

async function getMovieStreams(config, type, id) {
  const cinemetaDetails = await Cinemeta.getMeta(type, id);

  // Handle Cinemeta failure gracefully
  if (!cinemetaDetails || !cinemetaDetails.name) {
    console.error(`[STREAM-PROVIDER] Failed to get metadata for ${type}:${id} - Cinemeta returned null or invalid data`);
    return [];
  }

  const searchKey = cinemetaDetails.name;

  const allStreamsPromises = [];

  // Support multiple debrid services
  if (config.DebridServices && Array.isArray(config.DebridServices) && config.DebridServices.length > 0) {
    config.DebridServices.forEach(service => {
      if (service.provider === 'Usenet') {
        // Handle Usenet service
        const usenetConfig = {
          NewznabUrl: service.newznabUrl,
          NewznabApiKey: service.apiKey,
          SabnzbdUrl: service.sabnzbdUrl,
          SabnzbdApiKey: service.sabnzbdApiKey,
          FileServerUrl: service.fileServerUrl || '',
          deleteOnStreamStop: service.deleteOnStreamStop || false,
          autoCleanOldFiles: service.autoCleanOldFiles || false,
          autoCleanAgeDays: service.autoCleanAgeDays || 7
        };
        allStreamsPromises.push(
          withTimeout(
            getUsenetStreams(usenetConfig, type, id),
            USENET_TIMEOUT_MS,
            'Usenet'
          )
        );
      } else if (service.provider === 'HomeMedia') {
        // Handle Home Media Server
        const homeMediaConfig = {
          HomeMediaUrl: service.homeMediaUrl,
          HomeMediaApiKey: service.apiKey,
          Languages: config.Languages
        };
        allStreamsPromises.push(
          withTimeout(
            getHomeMediaStreams(homeMediaConfig, type, id),
            SERVICE_TIMEOUT_MS,
            'HomeMedia'
          )
        );
      } else if (service.provider === 'PersonalCloud') {
        // Handle Personal Cloud
        const personalCloudConfig = {
          PersonalCloudUrl: service.baseUrl,
          PersonalCloudNewznabUrl: service.newznabUrl,
          PersonalCloudNewznabApiKey: service.newznabApiKey,
          Languages: config.Languages,
          ...config
        };
        allStreamsPromises.push(
          withTimeout(
            getMovieStreamsFromProvider('PersonalCloud', service.apiKey, type, id, personalCloudConfig, cinemetaDetails, searchKey),
            SERVICE_TIMEOUT_MS,
            'PersonalCloud'
          )
        );
      } else if (service.provider === 'httpstreaming') {
        // Fetch streams based on user's selected HTTP streaming sources with caching
        const use4KHDHub = service.http4khdhub !== false;  // Default to true if not specified
        const useUHDMovies = service.httpUHDMovies !== false;  // Default to true if not specified
        const useStremsrc = service.httpStremsrc !== false;  // Default to true if not specified

        if (use4KHDHub) {
          allStreamsPromises.push(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-4khdhub`, config, () =>
                get4KHDHubStreams(id, type, null, null, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams)),
              HTTP_STREAMING_TIMEOUT_MS,
              '4KHDHub'
            )
          );
        }

        if (useUHDMovies) {
          allStreamsPromises.push(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-uhdmovies`, config, () =>
                getUHDMoviesStreams(id, id, type, null, null, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams)),
              HTTP_STREAMING_TIMEOUT_MS,
              'UHDMovies'
            )
          );
        }

        if (useStremsrc) {
          allStreamsPromises.push(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${id}-stremsrc`, config, () =>
                getStreamSrcStreams(id, type, null, null, config)
              ),
              HTTP_STREAMING_TIMEOUT_MS,
              'StreamSrc'
            )
          );
        }

      } else {
        // Handle regular debrid service
        allStreamsPromises.push(
          getMovieStreamsFromProvider(service.provider, service.apiKey, type, id, config, cinemetaDetails, searchKey)
        );
      }
    });
  } else {
    // Backward compatibility: single service
    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;
    const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

    if (debridProvider) {
      allStreamsPromises.push(
        getMovieStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey)
      );
    }
  }

  if (allStreamsPromises.length === 0) {
    return Promise.reject(BadRequestError);
  }

  const allStreams = await Promise.all(allStreamsPromises);
  let flatStreams = allStreams.flat();

  // Apply size filter if configured
  const minSize = config.minSize !== undefined ? config.minSize : 0;
  const maxSize = config.maxSize !== undefined ? config.maxSize : 200;
  flatStreams = filterBySize(flatStreams, minSize, maxSize);

  // Apply language filter if configured
  if (config.Languages && config.Languages.length > 0) {
    flatStreams = filterStreamsByLanguage(flatStreams, config.Languages);
  }

  // Sort streams to have personal cloud results at the top, then by size
  flatStreams.sort((a, b) => {
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;
    return (b._size || 0) - (a._size || 0);
  });

  return flatStreams;
}

// Helper to fetch series streams from a single debrid service
async function getSeriesStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey, season, episode) {
  // Create a config copy with the correct API key for this specific provider
  const providerConfig = { ...config, DebridApiKey: apiKey };
  if (debridProvider == "DebridLink") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebridLink.searchTorrents(apiKey, searchKey, 0.1));
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterSeason(t, season, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list
            .sort(sortTorrents)
            .filter(td => filterEpisode(td, season, episode, cinemetaDetails))
            .map(td => toStream(td, type, providerConfig))
            .filter(Boolean)
          );
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config, config.clientIp));
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, providerConfig);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config, config.clientIp));
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, providerConfig);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => Premiumize.search(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents
        .sort(sortTorrents)
        .map(td => toStream(td, type, providerConfig, { season, episode }))
        .filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => OffCloud.searchOffcloudTorrents(apiKey, type, id));
    if (torrents && torrents.length) {
      const bypass = torrents.filter(t => t.bypassFiltering === true);
//      if (bypass.length > 0) {
//        return bypass.sort(sortTorrents).map(td => toStream(td, type, providerConfig)).filter(Boolean);
//      }
      const episodeRegex = new RegExp(`s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`, 'i');
      const realEpisodes = torrents
        .filter(t => matchesSeriesTitle(t, cinemetaDetails.name))
        .filter(t => episodeRegex.test(t.name || t.title || ''));
      return realEpisodes.sort(sortTorrents).map(td => toStream(td, type, providerConfig)).filter(Boolean);
    }
  } else if (debridProvider == "TorBox") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => TorBox.searchTorboxTorrents(apiKey, type, id, config));
    if (torrents && torrents.length) {
      // Results are already pre-filtered at the scraping layer for series/episode.
      return torrents
        .sort(sortTorrents)
        .map(td => toStream(td, type, providerConfig))
        .filter(Boolean);
    }
  } else if (debridProvider == "DebriderApp") {
    // Check if this service has Newznab configured for Personal Cloud NZB support
    let serviceConfig = config;
    if (Array.isArray(config.DebridServices)) {
      const service = config.DebridServices.find(s => s.provider === 'DebriderApp');
      if (service && (service.newznabUrl || service.newznabApiKey)) {
        // Use searchWithPersonalCloud to include NZB results
        serviceConfig = {
          ...config,
          newznabUrl: service.newznabUrl,
          newznabApiKey: service.newznabApiKey
        };
        console.log(`[DBA] Newznab configured, using searchWithPersonalCloud`);
        const baseUrl = 'https://debrider.app/api/v1';
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, serviceConfig, baseUrl));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      } else {
        // Regular search without Newznab
        const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
        if (torrents && torrents.length) {
          return torrents.sort(sortTorrents)
            .map(td => toDebriderStream(td, type, providerConfig))
            .filter(Boolean);
        }
      }
    } else {
      // Fallback to regular search
      const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
      if (torrents && torrents.length) {
        return torrents.sort(sortTorrents)
          .map(td => toDebriderStream(td, type, providerConfig))
          .filter(Boolean);
      }
    }
  } else if (debridProvider == "PersonalCloud") {
    const personalCloudConfig = {
      newznabUrl: config.PersonalCloudNewznabUrl,
      newznabApiKey: config.PersonalCloudNewznabApiKey,
      ...config
    };
    const baseUrl = config.PersonalCloudUrl || 'https://debrider.app/api/v1';
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.searchWithPersonalCloud(apiKey, type, id, personalCloudConfig, baseUrl));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toDebriderStream(td, type, providerConfig))
        .filter(Boolean);
    }
  }
  return [];
}

async function getSeriesStreams(config, type, id) {
  const [imdbId, season, episode] = id.split(":");
  const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

  // Handle Cinemeta failure gracefully
  if (!cinemetaDetails || !cinemetaDetails.name) {
    console.error(`[STREAM-PROVIDER] Failed to get metadata for ${type}:${imdbId} - Cinemeta returned null or invalid data`);
    return [];
  }

  const searchKey = cinemetaDetails.name;

  const allStreamsPromises = [];

  // Support multiple debrid services
  if (config.DebridServices && Array.isArray(config.DebridServices) && config.DebridServices.length > 0) {
    config.DebridServices.forEach(service => {
      if (service.provider === 'Usenet') {
        // Handle Usenet service
        const usenetConfig = {
          NewznabUrl: service.newznabUrl,
          NewznabApiKey: service.apiKey,
          SabnzbdUrl: service.sabnzbdUrl,
          SabnzbdApiKey: service.sabnzbdApiKey,
          FileServerUrl: service.fileServerUrl || '',
          deleteOnStreamStop: service.deleteOnStreamStop || false,
          autoCleanOldFiles: service.autoCleanOldFiles || false,
          autoCleanAgeDays: service.autoCleanAgeDays || 7
        };
        allStreamsPromises.push(
          withTimeout(
            getUsenetStreams(usenetConfig, type, id),
            USENET_TIMEOUT_MS,
            'Usenet'
          )
        );
      } else if (service.provider === 'HomeMedia') {
        // Handle Home Media Server
        const homeMediaConfig = {
          HomeMediaUrl: service.homeMediaUrl,
          HomeMediaApiKey: service.apiKey,
          Languages: config.Languages
        };
        allStreamsPromises.push(
          withTimeout(
            getHomeMediaStreams(homeMediaConfig, type, id),
            SERVICE_TIMEOUT_MS,
            'HomeMedia'
          )
        );
      } else if (service.provider === 'PersonalCloud') {
        // Handle Personal Cloud
        const personalCloudConfig = {
          PersonalCloudUrl: service.baseUrl,
          PersonalCloudNewznabUrl: service.newznabUrl,
          PersonalCloudNewznabApiKey: service.newznabApiKey,
          Languages: config.Languages,
          ...config
        };
        allStreamsPromises.push(
          withTimeout(
            getMovieStreamsFromProvider('PersonalCloud', service.apiKey, type, id, personalCloudConfig, cinemetaDetails, searchKey),
            SERVICE_TIMEOUT_MS,
            'PersonalCloud'
          )
        );
      } else if (service.provider === 'httpstreaming') {
        // Fetch streams based on user's selected HTTP streaming sources with caching
        const use4KHDHub = service.http4khdhub !== false;  // Default to true if not specified
        const useUHDMovies = service.httpUHDMovies !== false;  // Default to true if not specified
        const useStremsrc = service.httpStremsrc !== false;  // Default to true if not specified

        if (use4KHDHub) {
          allStreamsPromises.push(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-4khdhub-${season}:${episode}`, config, () =>
                get4KHDHubStreams(imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams)),
              HTTP_STREAMING_TIMEOUT_MS,
              '4KHDHub'
            )
          );
        }

        if (useUHDMovies) {
          allStreamsPromises.push(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-uhdmovies-${season}:${episode}`, config, () =>
                getUHDMoviesStreams(imdbId, imdbId, type, season, episode, config)
              ).then(streams => wrapHttpStreamsWithResolver(streams)),
              HTTP_STREAMING_TIMEOUT_MS,
              'UHDMovies'
            )
          );
        }

        if (useStremsrc) {
          allStreamsPromises.push(
            withTimeout(
              getCachedTorrents('httpstreaming', type, `${imdbId}-stremsrc-${season}:${episode}`, config, () =>
                getStreamSrcStreams(imdbId, type, season, episode, config)
              ),
              HTTP_STREAMING_TIMEOUT_MS,
              'StreamSrc'
            )
          );
        }

      } else {
        // Handle regular debrid service
        allStreamsPromises.push(
          getSeriesStreamsFromProvider(service.provider, service.apiKey, type, id, config, cinemetaDetails, searchKey, season, episode)
        );
      }
    });
  } else {
    // Backward compatibility: single service
    let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;
    const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

    if (debridProvider) {
      allStreamsPromises.push(
        getSeriesStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey, season, episode)
      );
    }
  }

  if (allStreamsPromises.length === 0) {
    return Promise.reject(BadRequestError);
  }

  const allStreams = await Promise.all(allStreamsPromises);
  let flatStreams = allStreams.flat();

  // Apply size filter if configured
  const minSize = config.minSize !== undefined ? config.minSize : 0;
  const maxSize = config.maxSize !== undefined ? config.maxSize : 200;
  flatStreams = filterBySize(flatStreams, minSize, maxSize);

  // Apply language filter if configured
  if (config.Languages && config.Languages.length > 0) {
    flatStreams = filterStreamsByLanguage(flatStreams, config.Languages);
  }

  // Sort streams to have personal cloud results at the top, then by size
  flatStreams.sort((a, b) => {
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;
    return (b._size || 0) - (a._size || 0);
  });

  return flatStreams;
}

async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp, config = {}) {
  const provider = debridProvider.toLowerCase();
  console.log(`[RESOLVER] resolveUrl called with provider: ${provider}, hostUrl: ${hostUrl.substring(0, 100)}${hostUrl.length > 100 ? '...' : ''}`);

  // Handle NZB URLs for DebriderApp/PersonalCloud
  if (hostUrl.startsWith('nzb:') && (provider === 'debriderapp' || provider === 'personalcloud')) {
    const nzbUrl = hostUrl.substring(4); // Remove 'nzb:' prefix
    const newznabApiKey = config.PersonalCloudNewznabApiKey || config.newznabApiKey || '';
    const baseUrl = config.PersonalCloudUrl || 'https://debrider.app/api/v1';

    console.log(`[RESOLVER] Processing NZB download for ${provider}...`);

    try {
      // Submit NZB to Personal Cloud
      const taskInfo = await DebriderApp.submitNzb(debridApiKey, nzbUrl, newznabApiKey, baseUrl);
      console.log(`[RESOLVER] NZB task created: ${taskInfo.taskId}`);

      // Wait for task to complete and get video file
      const completedTask = await DebriderApp.waitForTaskCompletion(debridApiKey, taskInfo.taskId, baseUrl, 300000);

      if (completedTask.videoFiles && completedTask.videoFiles.length > 0) {
        // Return the largest video file
        const largestVideo = completedTask.videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
        const videoUrl = largestVideo.download_link || largestVideo.url;
        console.log(`[RESOLVER] NZB download complete, returning video URL`);
        return videoUrl;
      } else {
        throw new Error('No video files found in completed task');
      }
    } catch (error) {
      console.error(`[RESOLVER] NZB processing error: ${error.message}`);
      return null;
    }
  }

  if (!isValidUrl(hostUrl)) {
    console.error(`[RESOLVER] Invalid URL provided: ${hostUrl}`);
    return null;
  }
  try {
    if (provider === "realdebrid") {
      if (hostUrl.startsWith('magnet:') || hostUrl.includes('||HINT||')) {
        const maxRetries = 20; // Increase retries to allow more time for links to become available
        const retryInterval = 3000; // Reduce delay to allow more attempts
        let episodeHint = null;
        if (hostUrl.includes('||HINT||')) {
          try {
            const parts = hostUrl.split('||HINT||');
            hostUrl = parts[0];
            episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
          } catch (_) { episodeHint = null; }
        }

        // Import rate limiter dynamically to avoid circular dependencies
        const RdLimiter = (await import('./util/rd-rate-limit.js')).default;
        const rdCall = (fn) => RdLimiter.schedule(fn, 'rd-call', debridApiKey);

        const RD = new RealDebridClient(debridApiKey);
        let torrentId = null;
        try {
          const addResponse = await rdCall(() => RD.torrents.addMagnet(hostUrl));
          if (!addResponse?.data?.id) throw new Error("Failed to add magnet.");
          torrentId = addResponse.data.id;
          await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));

          let torrentInfo = null;
          
          // First wait for the torrent to be processed and ready
          for (let i = 0; i < maxRetries; i++) {
            torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
            const status = torrentInfo?.data?.status;
            if (status === 'downloaded' || status === 'finished') break;
            if (['magnet_error','error','virus','dead'].includes(status)) throw new Error(`Torrent failed: ${status}`);
            if (i === maxRetries - 1) throw new Error(`Torrent not ready after ${Math.ceil((maxRetries*retryInterval)/1000)}s`);
            await new Promise(r => setTimeout(r, retryInterval));
          }
          
          // Now wait for links to become available (separate from download status)
          let links = torrentInfo?.data?.links || [];
          if (links.length === 0) {
            console.log(`[RESOLVER] Links not available yet, waiting for them to be generated...`);
            for (let i = 0; i < maxRetries; i++) {
              torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
              links = torrentInfo?.data?.links || [];
              if (links.length > 0) {
                console.log(`[RESOLVER] Links are now available: ${links.length} links found`);
                break;
              }
              if (i === maxRetries - 1) throw new Error("No streamable links found after waiting");
              await new Promise(r => setTimeout(r, retryInterval));
            }
          }
          
          if (!links.length) throw new Error("No streamable links found.");
          
          const files = torrentInfo.data.files || [];
          const videoFiles = files.filter(f => f.selected);
          if (videoFiles.length === 0) throw new Error("No valid video files.");
          
          let chosen = null;
          if (episodeHint) {
            if (episodeHint.fileId != null) chosen = videoFiles.find(f => f.id === episodeHint.fileId) || null;
            if (!chosen && episodeHint.filePath) chosen = videoFiles.find(f => f.path === episodeHint.filePath) || null;
            if (!chosen && episodeHint.season && episodeHint.episode) {
              const s = String(episodeHint.season).padStart(2, '0');
              const e = String(episodeHint.episode).padStart(2, '0');
              const patterns = [
                new RegExp('[sS][\\W_]*' + s + '[\\W_]*[eE][\\W_]*' + e, 'i'),
                new RegExp('\\b' + Number(episodeHint.season) + '[\\W_]*x[\\W_]*' + e + '\\b', 'i'),
                new RegExp('\\b[eE]p?\\.?\\s*' + Number(episodeHint.episode) + '\\b', 'i'),
                new RegExp('episode\\s*' + Number(episodeHint.episode), 'i')
              ];
              chosen = videoFiles.find(f => patterns.some(p => p.test(f.path))) || null;
            }
          }
          if (!chosen) chosen = videoFiles.reduce((a, b) => (a.bytes > b.bytes ? a : b));
          
          // Find the correct link for the chosen file - try multiple matching methods
          let directUrl = null;
          const chosenFileId = String(chosen.id);
          
          // Method 1: Try to find by file ID in the files array index
          const fileIndexInAll = files.findIndex(f => String(f.id) === chosenFileId);
          if (fileIndexInAll !== -1 && fileIndexInAll < links.length) {
            directUrl = links[fileIndexInAll];
          }
          
          // Method 2: If not found by index, try to match by the file's own links property (newer API format)
          if (!directUrl && chosen.links && Array.isArray(chosen.links) && chosen.links.length > 0) {
            directUrl = chosen.links[0];
          }
          
          // Method 3: If still not found, try to match by fileId as an index (old API format)
          if (!directUrl) {
            const fileIdAsIndex = parseInt(chosenFileId, 10);
            if (!isNaN(fileIdAsIndex) && fileIdAsIndex >= 0 && fileIdAsIndex < links.length) {
              directUrl = links[fileIdAsIndex];
            }
          }
          
          if (!directUrl || directUrl === 'undefined') {
            console.error(`[RESOLVER] RD magnet error: Direct URL not found for torrent ${torrentId}, file ${chosenFileId}, ${files.length} files, ${links.length} links`);
            throw new Error("Direct URL not found.");
          }
          
          const unrestrictedUrl = await RealDebrid.unrestrictUrl(debridApiKey, directUrl, clientIp);
          if (!unrestrictedUrl) throw new Error("Unrestrict failed.");
          return unrestrictedUrl;
        } catch (error) {
          const status = error?.response?.status || error?.status;
          console.error(`[RESOLVER] RD magnet error: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
          if (torrentId) { try { await rdCall(() => RD.torrents.delete(torrentId)); } catch (_) {} }
          return null;
        }
      } else {
        return RealDebrid.unrestrictUrl(debridApiKey, hostUrl, clientIp);
      }
    } else if (provider === "offcloud") {
      let inferredType = null;
      if (itemId && typeof itemId === 'string') {
        const parts = itemId.split(':');
        inferredType = parts.length > 1 ? 'series' : 'movie';
      }
      const resolvedUrl = await OffCloud.resolveStream(debridApiKey, hostUrl, inferredType, itemId);
      if (!resolvedUrl) throw new Error("OffCloud resolve returned empty.");
      return resolvedUrl;
    } else if (provider === "debridlink") {
      return hostUrl;
    } else if (provider === "premiumize") {
        if (hostUrl.startsWith('magnet:')) {
            let episodeHint = null;
            if (hostUrl.includes('||HINT||')) {
                try {
                    const parts = hostUrl.split('||HINT||');
                    hostUrl = parts[0];
                    episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
                } catch (_) { episodeHint = null; }
            }

            const directDownload = await Premiumize.getDirectDownloadLink(debridApiKey, hostUrl);
            if (!directDownload) {
                throw new Error("Failed to get direct download link from Premiumize.");
            }

            let videos = [];
            if (directDownload.content && Array.isArray(directDownload.content) && directDownload.content.length > 0) {
                // Multi-file torrent
                videos = directDownload.content
                    .filter(f => isVideo(f.path))
                    .map(f => ({ ...f, name: f.path })); // Normalize name for PTT
            } else if (directDownload.location && isVideo(directDownload.filename)) {
                // Single file torrent
                videos.push({
                    name: directDownload.filename,
                    size: directDownload.filesize,
                    stream_link: directDownload.stream_link || directDownload.location,
                    link: directDownload.location,
                });
            }

            if (videos.length === 0) {
                throw new Error("No video files found in direct download response.");
            }

            let chosenVideo = null;
            if (videos.length > 1 && episodeHint && episodeHint.season && episodeHint.episode) {
                const s = Number(episodeHint.season);
                const e = Number(episodeHint.episode);

                chosenVideo = videos.find(f => {
                    const pttInfo = PTT.parse(f.name);
                    return pttInfo.season === s && pttInfo.episode === e;
                });
            }

            if (!chosenVideo) {
                if (videos.length > 1) {
                    chosenVideo = videos.reduce((a, b) => (a.size > b.size ? a : b));
                } else {
                    chosenVideo = videos[0];
                }
            }

            const streamLink = chosenVideo.stream_link || chosenVideo.link;
            if (!streamLink) {
                throw new Error("No streamable link found for the chosen video file.");
            }

            return streamLink;
        }
        return hostUrl; // for non-magnet links
    } else if (provider === "alldebrid") {
      return AllDebrid.resolveStreamUrl(debridApiKey, hostUrl, clientIp);
    } else if (provider === "torbox") {
      return TorBox.unrestrictUrl(debridApiKey, itemId, hostUrl, clientIp);
    } else {
      throw new Error(`Unsupported debrid provider: ${debridProvider}`);
    }
  } catch (error) {
    console.error(`[RESOLVER] Critical error for ${debridProvider}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return null;
  }
}

function toStream(details, type, config, streamHint = {}) {
  let video = details;
  let icon = details.isPersonal ? '☁️' : '💾';
  let personalTag = details.isPersonal ? '[Cloud] ' : '';
  // Defer URL validity check until after we build the final streamUrl

  function shouldUseArchiveName(videoFileName, archiveName) {
    if (!videoFileName || !archiveName) return false;
    const meaningfulPatterns = [
      /s\d{2}e\d{2}/i,
      /1080p|720p|480p|2160p|4k/i,
      /bluray|web|hdtv|dvd|brrip/i,
      /x264|x265|h264|h265/i,
      /remaster|director|extended/i,
      /\d{4}/
    ];
    return !meaningfulPatterns.some(p => p.test(videoFileName));
  }

  let displayName = video.name || video.title || 'Unknown';
  // Detect languages from the display name and render flags
  const detectedLanguages = detectLanguagesFromTitle(displayName);
  const flagsSuffix = renderLanguageFlags(detectedLanguages);
  if (video.searchableName && shouldUseArchiveName(video.name, video.searchableName)) {
    const archiveName = video.searchableName.split(' ')[0] || video.name;
    displayName = archiveName;
  }

  let title = personalTag + displayName + flagsSuffix;
  if (type == 'series' && video.name && video.name !== displayName) title = title + '\n' + video.name;
  
  const pttInfo = PTT.parse(displayName);
  if (type === 'series' && streamHint.season && streamHint.episode && pttInfo.season && !pttInfo.episode) {
    const episodeInfo = `S${String(streamHint.season).padStart(2, '0')}E${String(streamHint.episode).padStart(2, '0')}`;
    title = `${personalTag}${displayName}\n${episodeInfo}${flagsSuffix}`;
  }

  const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
  title = title + '\n' + icon + ' ' + formatSize(video.size) + trackerInfo;

  let name = STREAM_NAME_MAP[details.source] || "[DS+] Sootio";
  const resolution = getResolutionFromName(video.name || video.title || '');
  // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
  let resolutionLabel;
  if (resolution === '2160p') {
      resolutionLabel = '4k';
  } else if (resolution === '1080p') {
      resolutionLabel = '1080p';
  } else if (resolution === '720p') {
      resolutionLabel = '720p';
  } else if (resolution === '480p') {
      resolutionLabel = '480p';
  } else {
      resolutionLabel = resolution; // fallback for other values
  }
  name = name + '\n' + (resolutionLabel || 'N/A');

  const base = ADDON_HOST || '';
  let streamUrl;
  let urlToEncode = video.url;

  if (details.source === 'premiumize' && type === 'series' && streamHint.season && streamHint.episode) {
    const hint = Buffer.from(JSON.stringify({ season: streamHint.season, episode: streamHint.episode })).toString('base64');
    urlToEncode += '||HINT||' + hint;
  }

  if (details.source === 'realdebrid') {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
    const encodedUrl = encodeURIComponent(urlToEncode);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/realdebrid/${encodedApiKey}/${encodedUrl}`
      : urlToEncode;
  } else if (details.source === 'offcloud' && urlToEncode.includes('offcloud.com/cloud/download/')) {
    streamUrl = urlToEncode;
  } else {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || config.DebridLinkApiKey || '');
    const encodedUrl = encodeURIComponent(urlToEncode);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/${details.source}/${encodedApiKey}/${encodedUrl}`
      : urlToEncode;
  }

  if (!isValidUrl(streamUrl)) return null;

  const streamObj = {
    name,
    title,
    url: streamUrl,
    isPersonal: details.isPersonal, // Keep track of personal files for sorting
    _size: video.size || 0,  // Preserve size for filtering
    behaviorHints: {
      bingeGroup: `${details.source}|${details.hash || details.id || 'unknown'}`
    }
  };
  if (details.bypassFiltering) streamObj.bypassFiltering = true;
  return streamObj;
}

function toDebriderStream(details, type, config) {
    const resolution = getResolutionFromName(details.fileName || details.name);
    // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
    let resolutionLabel;
    if (resolution === '2160p') {
        resolutionLabel = '4k';
    } else if (resolution === '1080p') {
        resolutionLabel = '1080p';
    } else if (resolution === '720p') {
        resolutionLabel = '720p';
    } else if (resolution === '480p') {
        resolutionLabel = '480p';
    } else {
        resolutionLabel = resolution; // fallback for other values
    }

    // Personal files get cloud icon, NZBs get download icon
    const icon = details.isPersonal ? '☁️' : (details.source === 'newznab' ? '📡' : '💾');
    const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
    // Detect languages from the title and render flags
    const detectedLanguages = detectLanguagesFromTitle(details.name || details.fileName || '');
    const flagsSuffix = renderLanguageFlags(detectedLanguages);

    let title = details.name;
    if (details.fileName) {
        title = `${details.name}/${details.fileName}`;
    }
    title = `${title}\n${icon} ${formatSize(details.size)}${trackerInfo}${flagsSuffix}`;

    // Use appropriate stream name map
    const sourceName = details.source === 'personalcloud' ? STREAM_NAME_MAP.personalcloud : STREAM_NAME_MAP.debriderapp;
    const name = `${sourceName}\n${resolutionLabel}`;

    // For NZB URLs, route through resolver endpoint with config
    let streamUrl = details.url;
    if (details.url.startsWith('nzb:')) {
        const base = ADDON_HOST || '';
        const provider = details.source === 'personalcloud' ? 'personalcloud' : 'debriderapp';
        const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
        const encodedUrl = encodeURIComponent(details.url);

        // Find the service config for this provider
        let serviceConfig = {};
        if (Array.isArray(config.DebridServices)) {
            const service = config.DebridServices.find(s =>
                (s.provider === 'DebriderApp' || s.provider === 'PersonalCloud')
            );
            if (service) {
                serviceConfig = {
                    PersonalCloudUrl: service.baseUrl || 'https://debrider.app/api/v1',
                    PersonalCloudNewznabApiKey: service.newznabApiKey || '',
                    newznabApiKey: service.newznabApiKey || ''
                };
            }
        }

        const configParam = encodeURIComponent(JSON.stringify(serviceConfig));
        streamUrl = (base && base.startsWith('http'))
            ? `${base}/resolve/${provider}/${encodedApiKey}/${encodedUrl}?config=${configParam}`
            : details.url;
    }

    return {
        name: name,
        title: title,
        url: streamUrl,
        isPersonal: details.isPersonal, // Keep track of personal files for sorting
        _size: details.size || 0,  // Preserve size for filtering
        behaviorHints: {
            directLink: !details.url.startsWith('nzb:'), // NZB links need processing
            bingeGroup: details.bingeGroup || `debriderapp|${details.infoHash || details.nzbTitle || 'unknown'}`
        }
    };
}

/**
 * Get streams from Usenet
 */
async function getUsenetStreams(config, type, id) {
  try {
    console.log('[USENET] getUsenetStreams called - Personal file check will ALWAYS run (never cached)');
    console.log('[USENET] Config FileServerUrl:', config.FileServerUrl);

    const results = await Usenet.searchUsenet(
      config.NewznabUrl,
      config.NewznabApiKey,
      type,
      id,
      config
    );

    if (!results || results.length === 0) {
      console.log('[USENET] No search results from Newznab');
      return [];
    }

    console.log(`[USENET] Got ${results.length} search results from Newznab (may be cached)`);

    // ALWAYS check file server for existing files (never cached)
    // Match personal files against the SEARCH QUERY, not individual Newznab results
    const personalFiles = []; // Array of file objects from server
    const personalFileNames = new Set(); // Set of file names for quick lookup
    console.log('[USENET] Running personal file check (UNCACHED)...');

    if (config.FileServerUrl) {
      try {
        const axios = (await import('axios')).default;
        const fileServerUrl = config.FileServerUrl.replace(/\/$/, '');
        console.log(`[USENET] Querying file server: ${fileServerUrl}/api/list`);

        // Simple GET without cache-busting that might cause issues
        const response = await axios.get(`${fileServerUrl}/api/list`, {
          timeout: 10000,
          validateStatus: (status) => status === 200
        });

        if (response.data?.files && Array.isArray(response.data.files)) {
          // Only use completed files for personal streams (isComplete: true)
          // Files in incomplete/ are for streaming via download+extraction
          const completedFiles = response.data.files.filter(f => f.isComplete === true);
          personalFiles.push(...completedFiles);
          completedFiles.forEach(file => {
            personalFileNames.add(file.name);
          });
          console.log(`[USENET] ✓ Found ${completedFiles.length} completed files on server (${response.data.files.length} total)`);
          if (completedFiles.length > 0) {
            console.log(`[USENET] Sample completed files:`, completedFiles.slice(0, 2).map(f => f.path).join(', '));
          }
        } else {
          console.log(`[USENET] ✓ No files on server`);
        }
      } catch (error) {
        console.error('[USENET] ✗ Personal file check FAILED:', error.code, error.message);
        if (error.response) {
          console.error('[USENET] Response status:', error.response.status);
        }
        // Continue without personal files if file server is unavailable
      }
    } else {
      console.log('[USENET] ⚠ FileServerUrl not configured');
    }

    // Get metadata for title matching
    let metadata = null;
    try {
      // For series, extract just the imdbId (before the colon)
      const imdbId = type === 'series' ? id.split(':')[0] : id;
      metadata = await Cinemeta.getMeta(type, imdbId);
    } catch (err) {
      console.log('[USENET] Could not fetch metadata for title matching:', err.message);
    }

    // Helper function to match file against search query
    const matchesSearch = (fileName, searchType, searchId, meta) => {
      if (searchType === 'series') {
        // Extract S01E05 from search ID (format: tt123:1:5)
        const [, season, episode] = searchId.split(':');
        const seasonEpPattern = new RegExp(`s0*${season}e0*${episode}`, 'i');

        // Check if episode pattern matches
        if (!seasonEpPattern.test(fileName)) {
          return false;
        }

        // If we have metadata, also verify the title matches
        if (meta && meta.name) {
          // Normalize both strings for comparison
          const normalizeStr = (str) => str.toLowerCase()
            .replace(/[^\w\s]/g, '') // Remove special chars
            .replace(/\s+/g, ''); // Remove spaces

          const normalizedTitle = normalizeStr(meta.name);
          const normalizedFileName = normalizeStr(fileName);

          // Check if the file name contains the show title
          if (!normalizedFileName.includes(normalizedTitle)) {
            console.log(`[USENET] ✗ File "${fileName}" has correct episode but wrong title (expected: "${meta.name}")`);
            return false;
          }
        }

        console.log(`[USENET] ✓ Personal file matches search: "${fileName}"`);
        return true;
      } else {
        // For movies, match by title and optionally year
        if (!meta || !meta.name) {
          return false;
        }

        const normalizeStr = (str) => str.toLowerCase()
          .replace(/[^\w\s]/g, '')
          .replace(/\s+/g, '');

        const normalizedTitle = normalizeStr(meta.name);
        const normalizedFileName = normalizeStr(fileName);

        // Check if filename contains the movie title
        if (!normalizedFileName.includes(normalizedTitle)) {
          return false;
        }

        // If we have a year, check if it matches too
        if (meta.year) {
          const yearPattern = new RegExp(`\\b${meta.year}\\b`);
          if (!yearPattern.test(fileName)) {
            console.log(`[USENET] ✗ File "${fileName}" has correct title but wrong year (expected: ${meta.year})`);
            return false;
          }
        }

        console.log(`[USENET] ✓ Personal file matches search: "${fileName}"`);
        return true;
      }
    };

    // Find personal files that match the search
    // Try matching against file.path first, then fall back to folderName if filename is a hash
    const matchedPersonalFiles = personalFiles.filter(file => {
      // First try the full path (includes folder name)
      if (matchesSearch(file.path, type, id, metadata)) {
        return true;
      }
      // If path doesn't match and we have a folderName, try that
      // This handles cases where the video file has a random hash name
      if (file.folderName && matchesSearch(file.folderName, type, id, metadata)) {
        console.log(`[USENET] ✓ Matched by folder name: "${file.folderName}" (file: ${file.name})`);
        return true;
      }
      return false;
    });

    console.log(`[USENET] Found ${matchedPersonalFiles.length} personal files matching search`);

    // Store result details with config for later retrieval
    const configData = {
      newznabUrl: config.NewznabUrl,
      newznabApiKey: config.NewznabApiKey,
      sabnzbdUrl: config.SabnzbdUrl,
      sabnzbdApiKey: config.SabnzbdApiKey,
      fileServerUrl: config.FileServerUrl || '',
      deleteOnStreamStop: config.deleteOnStreamStop || false,
      autoCleanOldFiles: config.autoCleanOldFiles || false,
      autoCleanAgeDays: config.autoCleanAgeDays || 7
    };

    const base = ADDON_HOST || '';

    // Helper to match Newznab result with personal file
    const findMatchingPersonalFile = (nzbTitle) => {
      const normalizeForMatch = (str) => {
        const withoutExt = str.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)$/i, '');
        return withoutExt.toLowerCase().replace(/[.\s_-]+/g, '');
      };
      const normalized = normalizeForMatch(nzbTitle);

      return matchedPersonalFiles.find(file => {
        const fileNorm = normalizeForMatch(file.name);
        return fileNorm === normalized || fileNorm.includes(normalized) || normalized.includes(fileNorm);
      });
    };

    // Apply filters to Newznab results (same as debrid services)
    let filteredResults = results;

    // For movies, filter by year
    if (type === 'movie' && metadata) {
      filteredResults = filteredResults.filter(result => filterYear(result, metadata));
      console.log(`[USENET] Filtered ${results.length} -> ${filteredResults.length} results by year`);
    }

    // For series, filter out results that don't have episode markers
    if (type === 'series') {
      const [, season, episode] = id.split(':');
      const initialCount = filteredResults.length;
      filteredResults = filteredResults.filter(result => {
        const name = result?.name || result?.title || '';
        // Check if name has ANY episode pattern (S##E##, 1x05, etc)
        const hasAnyEpisode = /[sS]\d+[eE]\d+|\b\d+x\d+\b|[eE]pisode\s*\d+/i.test(name);
        return hasAnyEpisode;
      });
      if (filteredResults.length < initialCount) {
        console.log(`[USENET] Filtered ${initialCount} -> ${filteredResults.length} results (removed non-series)`);
      }
    }

    // Convert Newznab results to stream objects
    const newznabStreams = filteredResults.slice(0, 50).map(result => {
      const resolution = getResolutionFromName(result.title);
      // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
      let resolutionLabel;
      if (resolution === '2160p') {
          resolutionLabel = '4k';
      } else if (resolution === '1080p') {
          resolutionLabel = '1080p';
      } else if (resolution === '720p') {
          resolutionLabel = '720p';
      } else if (resolution === '480p') {
          resolutionLabel = '480p';
      } else {
          resolutionLabel = resolution; // fallback for other values
      }
      const configParam = encodeURIComponent(JSON.stringify(configData));

      // Check if this Newznab result matches a personal file
      const matchingFile = findMatchingPersonalFile(result.title);
      const isInCloud = !!matchingFile;

      // Use personal file URL if it exists, otherwise use Newznab download URL
      let streamUrl;
      if (isInCloud) {
        // Stream from personal file (already on server)
        const encodedPath = matchingFile.path.split('/').map(encodeURIComponent).join('/');
        streamUrl = `${base}/usenet/personal/${encodedPath}?config=${configParam}`;
        console.log(`[USENET] ✓ Newznab result "${result.title}" matches personal file, using direct URL`);
      } else {
        // Download and stream from Newznab
        streamUrl = `${base}/usenet/stream/${encodeURIComponent(result.nzbUrl)}/${encodeURIComponent(result.title)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}?config=${configParam}`;
      }

      return {
        name: isInCloud ? `☁️ Personal\n${resolutionLabel || 'N/A'}` : `${STREAM_NAME_MAP.usenet}\n${resolutionLabel || 'N/A'}`,
        title: `${result.title}\n${isInCloud ? '☁️' : '📡'} ${formatSize(result.size)}`,
        url: streamUrl,
        isPersonal: isInCloud,
        _size: result.size || 0,  // Preserve size for filtering
        behaviorHints: {
          bingeGroup: isInCloud ? `usenet-personal|${matchingFile.name}` : `usenet|${result.id}`
        }
      };
    });

    // Create streams for personal files that DON'T match any Newznab result
    const personalOnlyStreams = matchedPersonalFiles
      .filter(file => {
        // Check if this file matches ANY Newznab result
        const normalizeForMatch = (str) => {
          const withoutExt = str.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)$/i, '');
          return withoutExt.toLowerCase().replace(/[.\s_-]+/g, '');
        };
        const fileNorm = normalizeForMatch(file.name);

        const hasMatch = results.some(result => {
          const resultNorm = normalizeForMatch(result.title);
          return fileNorm === resultNorm || fileNorm.includes(resultNorm) || resultNorm.includes(fileNorm);
        });
        return !hasMatch;
      })
      .map(file => {
        const resolution = getResolutionFromName(file.name);
        // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
        let resolutionLabel;
        if (resolution === '2160p') {
            resolutionLabel = '4k';
        } else if (resolution === '1080p') {
            resolutionLabel = '1080p';
        } else if (resolution === '720p') {
            resolutionLabel = '720p';
        } else if (resolution === '480p') {
            resolutionLabel = '480p';
        } else {
            resolutionLabel = resolution; // fallback for other values
        }

        // Use the file name as the release name, but if it's a hash (no recognizable info),
        // use the parent directory name (folderName) instead
        let releaseName = file.name.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg)$/i, '');

        // Check if filename looks like a hash (mostly alphanumeric, no spaces, < 20 chars)
        const looksLikeHash = /^[a-zA-Z0-9]{8,32}$/.test(releaseName);
        if (looksLikeHash && file.folderName) {
          console.log(`[USENET] Using folder name instead of hash filename: "${file.folderName}" (was: "${releaseName}")`);
          releaseName = file.folderName;
        }

        // Create a stream URL that goes through Node.js for tracking
        // Use a special "personal" marker in the URL
        const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
        const configParam = encodeURIComponent(JSON.stringify(configData));
        const personalStreamUrl = `${base}/usenet/personal/${encodedPath}?config=${configParam}`;

        console.log(`[USENET] ✓ Creating personal-only stream for: "${file.name}"`);

        return {
          name: `☁️ Personal\n${resolutionLabel || 'N/A'}`,
          title: `${releaseName}\n☁️ ${formatSize(file.size)} (On Server)`,
          url: personalStreamUrl,
          isPersonal: true,
          _size: file.size || 0,  // Preserve size for filtering
          behaviorHints: {
            bingeGroup: `usenet-personal|${file.name}`
          }
        };
      });

    console.log(`[USENET] Created ${personalOnlyStreams.length} personal-only streams`);

    // Combine: personal files at top, then regular Newznab results
    const allStreams = [...personalOnlyStreams, ...newznabStreams];

    return allStreams;

  } catch (error) {
    console.error('[USENET] Error getting streams:', error.message);
    return [];
  }
}

/**
 * Get streams from Home Media Server
 */
async function getHomeMediaStreams(config, type, id) {
  try {
    console.log('[HM+] getHomeMediaStreams called');
    console.log('[HM+] Config HomeMediaUrl:', config.HomeMediaUrl);

    const results = await HomeMedia.searchHomeMedia(
      config.HomeMediaUrl,
      config.HomeMediaApiKey,
      type,
      id,
      config
    );

    if (!results || results.length === 0) {
      console.log('[HM+] No files found on home media server');
      return [];
    }

    console.log(`[HM+] Got ${results.length} results from home media server`);

    const base = ADDON_HOST || '';

    // Convert Home Media results to stream objects
    const streams = results.map(result => {
      const resolution = result.resolution || getResolutionFromName(result.title);
      // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
      let resolutionLabel;
      if (resolution === '2160p') {
          resolutionLabel = '4k';
      } else if (resolution === '1080p') {
          resolutionLabel = '1080p';
      } else if (resolution === '720p') {
          resolutionLabel = '720p';
      } else if (resolution === '480p') {
          resolutionLabel = '480p';
      } else {
          resolutionLabel = resolution; // fallback for other values
      }

      // Generate stream URL
      const streamUrl = HomeMedia.getStreamUrl(
        config.HomeMediaUrl,
        config.HomeMediaApiKey,
        result.flatPath || result.fileName
      );

      console.log(`[HM+] ✓ Creating stream for: "${result.title}"`);

      return {
        name: `☁️ Personal\n${resolutionLabel || 'N/A'}`,
        title: `${result.title}\n☁️ ${formatSize(result.size)} (Home Media)`,
        url: streamUrl,
        _size: result.size || 0,  // Preserve size for filtering
        behaviorHints: {
          bingeGroup: `homemedia|${result.fileName}`
        }
      };
    });

    return streams;

  } catch (error) {
    console.error('[HM+] Error getting streams:', error.message);
    return [];
  }
}

// ---------------------------------------------------------------------------------
// Deduplicated wrappers for exported functions
// ---------------------------------------------------------------------------------

/**
 * Deduplicated movie streams function
 * Prevents duplicate concurrent requests for the same movie
 */
async function getMovieStreamsDeduped(config, type, id) {
  // Create deduplication key based on provider, type, id, and languages
  const provider = config.DebridProvider || 'unknown';
  const langs = (config.Languages || []).sort().join(',');
  const key = `${provider}:${type}:${id}:${langs}`;

  return dedupedRequest(key, () => getMovieStreams(config, type, id));
}

/**
 * Deduplicated series streams function
 * Prevents duplicate concurrent requests for the same episode
 */
async function getSeriesStreamsDeduped(config, type, id) {
  // Create deduplication key based on provider, type, id, and languages
  const provider = config.DebridProvider || 'unknown';
  const langs = (config.Languages || []).sort().join(',');
  const key = `${provider}:${type}:${id}:${langs}`;

  return dedupedRequest(key, () => getSeriesStreams(config, type, id));
}

// Verification functions for cached torrents and HTTP streams
async function verifyCachedTorrents(apiKey, provider, cachedResults) {
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

async function refreshHttpStreamLinks(cachedResults) {
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

export default {
  getMovieStreams: getMovieStreamsDeduped,
  getSeriesStreams: getSeriesStreamsDeduped,
  resolveUrl,
  STREAM_NAME_MAP
};
