import { get4KHDHubStreams, getStreamSrcStreams } from './http-streams.js';
import { getUHDMoviesStreams } from './uhdmovies.js';
import Cinemeta from './util/cinemeta.js';
import DebridLink from './debrid-link.js';
import RealDebrid from './real-debrid.js';
import RealDebridClient from 'real-debrid-api';
import AllDebrid from './all-debrid.js';
import Premiumize from './premiumize.js';
import OffCloud from './offcloud.js';
import TorBox from './torbox.js';
import DebriderApp from './debrider.app.js';
import Usenet from './usenet.js';
import HomeMedia from './home-media.js';
import * as MongoCache from './common/mongo-cache.js';
import { BadRequestError } from './util/error-codes.js';
import { FILE_TYPES } from './util/file-types.js';
import { filterSeason, filterEpisode, filterYear, matchesSeriesTitle, hasEpisodeMarker } from './util/filter-torrents.js';
import { getResolutionFromName, formatSize, getCodec, resolutionOrder, sizeToBytes } from './common/torrent-utils.js';
import PTT from './util/parse-torrent-title.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from './util/language-mapping.js';

const ADDON_HOST = process.env.ADDON_URL;

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
    (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:') || url.startsWith('/resolve/'));
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

const SCRAPER_CACHE_TTL_SERIES_MIN = process.env.SCRAPER_CACHE_TTL_SERIES_MIN || 60;
const SCRAPER_CACHE_TTL_MOVIE_MIN = process.env.SCRAPER_CACHE_TTL_MOVIE_MIN || 360;

// High-performance cache for search results
const SEARCH_FAST_CACHE = new Map();
const SEARCH_FAST_CACHE_MAX_SIZE = 500; // Smaller since search results are larger
const SEARCH_FAST_CACHE_TTL = 2 * 60 * 1000; // 2 minutes for search results (more volatile)

// Helper to manage search fast cache size
function manageSearchFastCacheSize() {
  if (SEARCH_FAST_CACHE.size > SEARCH_FAST_CACHE_MAX_SIZE) {
    // Remove oldest entries (FIFO)
    const firstKey = SEARCH_FAST_CACHE.keys().next().value;
    if (firstKey) {
      SEARCH_FAST_CACHE.delete(firstKey);
    }
  }
}

// Periodic cleanup of expired search fast cache entries
function initSearchFastCacheCleanup() {
  // Clean up expired entries every 1 minute
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of SEARCH_FAST_CACHE.entries()) {
      if (now >= value.expires) {
        SEARCH_FAST_CACHE.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[SEARCH FAST CACHE] Cleaned up ${cleaned} expired entries from search fast cache`);
    }
  }, 1 * 60 * 1000); // Every 1 minute
}

// Initialize cleanup when the module is loaded
initSearchFastCacheCleanup();

// Caches search results from debrid providers to speed up subsequent requests.
// When a search is performed for a movie or series, the results are stored in MongoDB.
// If the same item is requested again before the cache expires, the results are served from the cache,
// avoiding the need to re-run the search.
// The cache key is based on the provider, media type, ID, and selected languages.
// Movies are cached for 6 hours, and series for 1 hour.
async function getCachedTorrents(provider, type, id, config, searchFn) {
  if (!MongoCache.isEnabled()) {
    return searchFn();
  }

  const collection = await MongoCache.getCollection();
  if (!collection) {
    return searchFn();
  }

  const langKey = (config.Languages || []).join(',');
  const providerKey = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  const cacheKey = `${providerKey}-search:${type}:${id}:${langKey}`;
  
  // Check fast cache first for sub-millisecond response
  const fastCached = SEARCH_FAST_CACHE.get(cacheKey);
  if (fastCached && Date.now() < fastCached.expires) {
    console.log(`[SEARCH FAST CACHE] HIT: ${cacheKey}`);
    return fastCached.data;
  }
  
  // Use a more efficient find operation with projection to reduce data transfer
  const cached = await collection.findOne(
    { 
      _id: cacheKey,
      expiresAt: { $gte: new Date() } // Only return non-expired documents (leverage TTL index)
    },
    { projection: { data: 1, expiresAt: 1, createdAt: 1 } } // Only fetch required fields
  );

  if (cached) {
    // Update fast cache
    SEARCH_FAST_CACHE.set(cacheKey, {
      data: cached.data,
      expires: Date.now() + SEARCH_FAST_CACHE_TTL
    });
    manageSearchFastCacheSize();
    
    console.log(`[CACHE] HIT: ${cacheKey}`);
    return cached.data;
  }
  
  console.log(`[CACHE] MISS: ${cacheKey}`);

  const results = await searchFn();

  if (results && results.length > 0) {
    // Filter out personal cloud files and any items that are already fully-formed stream objects.
    // This prevents storing user-specific data and URLs in the shared cache.
    const cacheableData = results.filter(item => {
      if (!item) {
        return true; // Retain null/empty entries for cache consistency.
      }

      // Exclude personal cloud files.
      if (item.isPersonal) {
        return false;
      }

      // For HTTP streaming sources, we WANT to cache the HTTP URLs since they are the actual streaming links
      // For debrid services, we want to avoid caching resolver URLs that contain API keys
      const isHttpStreamingSource = provider === 'httpstreaming';
      if (!isHttpStreamingSource && typeof item.url === 'string' && item.url) {
        // Exclude items with resolver or direct URLs for non-HTTP streaming sources
        // Magnet links are not filtered.
        return !(item.url.startsWith('http') || item.url.startsWith('/resolve/'));
      }

      return true;
    });

    if (cacheableData.length > 0) {
      const ttlMinutes = type === 'series' ? SCRAPER_CACHE_TTL_SERIES_MIN : SCRAPER_CACHE_TTL_MOVIE_MIN;
      const now = new Date();
      const cacheDoc = {
        _id: cacheKey,
        data: cacheableData,
        createdAt: now,
        expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000)
      };
      try {
        // Use insertOne instead of updateOne for better performance during cache miss
        // This is more efficient when we know the document doesn't exist
        await collection.replaceOne(
          { _id: cacheKey }, 
          cacheDoc, 
          { upsert: true }
        );
        
        // Also update fast cache
        SEARCH_FAST_CACHE.set(cacheKey, {
          data: cacheableData,
          expires: Date.now() + SEARCH_FAST_CACHE_TTL
        });
        manageSearchFastCacheSize();
        
        console.log(`[CACHE] STORED: ${cacheKey} (TTL: ${ttlMinutes}m)`);
      } catch (e) {
        console.error(`[CACHE] FAILED to store ${cacheKey}:`, e.message);
      }
    }
  }

  return results;
}

// Helper to fetch movie streams from a single debrid service
async function getMovieStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey) {
  // Create a config copy with the correct API key for this specific provider
  const providerConfig = { ...config, DebridApiKey: apiKey };
  if (debridProvider == "DebridLink") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebridLink.searchTorrents(apiKey, searchKey, 0.1));
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterYear(t, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list.sort(sortTorrents).map(t => toStream(t, type, providerConfig)).filter(Boolean));
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config));
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
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config));
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
          getUsenetStreams(usenetConfig, type, id)
            .catch(err => {
              console.error('Error fetching from Usenet:', err);
              return [];
            })
        );
      } else if (service.provider === 'HomeMedia') {
        // Handle Home Media Server
        const homeMediaConfig = {
          HomeMediaUrl: service.homeMediaUrl,
          HomeMediaApiKey: service.apiKey,
          Languages: config.Languages
        };
        allStreamsPromises.push(
          getHomeMediaStreams(homeMediaConfig, type, id)
            .catch(err => {
              console.error('Error fetching from Home Media:', err);
              return [];
            })
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
          getMovieStreamsFromProvider('PersonalCloud', service.apiKey, type, id, personalCloudConfig, cinemetaDetails, searchKey)
            .catch(err => {
              console.error('Error fetching from Personal Cloud:', err);
              return [];
            })
        );
      } else if (service.provider === 'httpstreaming') {
        // Fetch streams based on user's selected HTTP streaming sources with caching
        const use4KHDHub = service.http4khdhub !== false;  // Default to true if not specified
        const useUHDMovies = service.httpUHDMovies !== false;  // Default to true if not specified
        const useStremsrc = service.httpStremsrc !== false;  // Default to true if not specified

        if (use4KHDHub) {
          allStreamsPromises.push(
            getCachedTorrents('httpstreaming', type, `${id}-4khdhub`, config, () => 
              get4KHDHubStreams(id, type, null, null, config)
            ).catch(err => {
              console.error('Error fetching from 4KHDHub:', err);
              return [];
            })
          );
        }

        if (useUHDMovies) {
          allStreamsPromises.push(
            getCachedTorrents('httpstreaming', type, `${id}-uhdmovies`, config, () => 
              getUHDMoviesStreams(id, id, type, null, null, config)
            ).catch(err => {
              console.error('Error fetching from UHDMovies:', err);
              return [];
            })
          );
        }

        if (useStremsrc) {
          allStreamsPromises.push(
            getCachedTorrents('httpstreaming', type, `${id}-stremsrc`, config, () => 
              getStreamSrcStreams(id, type, null, null, config)
            ).catch(err => {
              console.error('Error fetching from stremsrc:', err);
              return [];
            })
          );
        }

      } else {
        // Handle regular debrid service
        allStreamsPromises.push(
          getMovieStreamsFromProvider(service.provider, service.apiKey, type, id, config, cinemetaDetails, searchKey)
            .catch(err => {
              console.error(`Error fetching from ${service.provider}:`, err);
              return [];
            })
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
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config));
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
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config));
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
          getUsenetStreams(usenetConfig, type, id)
            .catch(err => {
              console.error('Error fetching from Usenet:', err);
              return [];
            })
        );
      } else if (service.provider === 'HomeMedia') {
        // Handle Home Media Server
        const homeMediaConfig = {
          HomeMediaUrl: service.homeMediaUrl,
          HomeMediaApiKey: service.apiKey,
          Languages: config.Languages
        };
        allStreamsPromises.push(
          getHomeMediaStreams(homeMediaConfig, type, id)
            .catch(err => {
              console.error('Error fetching from Home Media:', err);
              return [];
            })
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
          getMovieStreamsFromProvider('PersonalCloud', service.apiKey, type, id, personalCloudConfig, cinemetaDetails, searchKey)
            .catch(err => {
              console.error('Error fetching from Personal Cloud:', err);
              return [];
            })
        );
      } else if (service.provider === 'httpstreaming') {
        // Fetch streams based on user's selected HTTP streaming sources with caching
        const use4KHDHub = service.http4khdhub !== false;  // Default to true if not specified
        const useUHDMovies = service.httpUHDMovies !== false;  // Default to true if not specified
        const useStremsrc = service.httpStremsrc !== false;  // Default to true if not specified

        if (use4KHDHub) {
          allStreamsPromises.push(
            getCachedTorrents('httpstreaming', type, `${imdbId}-4khdhub-${season}:${episode}`, config, () => 
              get4KHDHubStreams(imdbId, type, season, episode, config)
            ).catch(err => {
              console.error('Error fetching from 4KHDHub:', err);
              return [];
            })
          );
        }

        if (useUHDMovies) {
          allStreamsPromises.push(
            getCachedTorrents('httpstreaming', type, `${imdbId}-uhdmovies-${season}:${episode}`, config, () => 
              getUHDMoviesStreams(imdbId, imdbId, type, season, episode, config)
            ).catch(err => {
              console.error('Error fetching from UHDMovies:', err);
              return [];
            })
          );
        }

        if (useStremsrc) {
          allStreamsPromises.push(
            getCachedTorrents('httpstreaming', type, `${imdbId}-stremsrc-${season}:${episode}`, config, () => 
              getStreamSrcStreams(imdbId, type, season, episode, config)
            ).catch(err => {
              console.error('Error fetching from stremsrc:', err);
              return [];
            })
          );
        }

      } else {
        // Handle regular debrid service
        allStreamsPromises.push(
          getSeriesStreamsFromProvider(service.provider, service.apiKey, type, id, config, cinemetaDetails, searchKey, season, episode)
            .catch(err => {
              console.error(`Error fetching from ${service.provider}:`, err);
              return [];
            })
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

  return flatStreams;
}

async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp, config = {}) {
  const provider = debridProvider.toLowerCase();

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
        const maxRetries = 10;
        const retryInterval = 5000;
        let episodeHint = null;
        if (hostUrl.includes('||HINT||')) {
          try {
            const parts = hostUrl.split('||HINT||');
            hostUrl = parts[0];
            episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
          } catch (_) { episodeHint = null; }
        }
        const RD = new RealDebridClient(debridApiKey);
        let torrentId = null;
        try {
          const addResponse = await RD.torrents.addMagnet(hostUrl);
          if (!addResponse?.data?.id) throw new Error("Failed to add magnet.");
          torrentId = addResponse.data.id;
          await RD.torrents.selectFiles(torrentId, 'all');

          let torrentInfo = null;
          for (let i = 0; i < maxRetries; i++) {
            torrentInfo = await RD.torrents.info(torrentId);
            const status = torrentInfo?.data?.status;
            if (status === 'downloaded' || status === 'finished') break;
            if (['magnet_error','error','virus','dead'].includes(status)) throw new Error(`Torrent failed: ${status}`);
            if (i === maxRetries - 1) throw new Error(`Torrent not ready after ${Math.ceil((maxRetries*retryInterval)/1000)}s`);
            await new Promise(r => setTimeout(r, retryInterval));
          }
          if (!torrentInfo?.data?.links?.length) throw new Error("No streamable links found.");
          const files = torrentInfo.data.files || [];
          const links = torrentInfo.data.links || [];
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
          const fileIndexInAll = files.findIndex(f => String(f.id) === String(chosen.id));
          if (fileIndexInAll === -1) throw new Error("Chosen file index not found.");
          const directUrl = links[fileIndexInAll];
          if (!directUrl || directUrl === 'undefined') throw new Error("Direct URL not found.");
          const unrestrictedUrl = await RealDebrid.unrestrictUrl(debridApiKey, directUrl, clientIp);
          if (!unrestrictedUrl) throw new Error("Unrestrict failed.");
          return unrestrictedUrl;
        } catch (error) {
          console.error(`[RESOLVER] RD magnet error: ${error.message}`);
          if (torrentId) { try { await RD.torrents.delete(torrentId); } catch (_) {} }
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
        _size: result.size || 0,  // Preserve size for filtering
        behaviorHints: {
          bingeGroup: isInCloud ? `usenet-personal|${matchingFile.name}` : `usenet|${result.id}`
        },
        // Add sort priority - personal files first
        _isPersonal: isInCloud
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
          _size: file.size || 0,  // Preserve size for filtering
          behaviorHints: {
            bingeGroup: `usenet-personal|${file.name}`
          },
          _isPersonal: true
        };
      });

    console.log(`[USENET] Created ${personalOnlyStreams.length} personal-only streams`);

    // Sort: personal files first (both matched and personal-only)
    const personalStreams = [...personalOnlyStreams, ...newznabStreams.filter(s => s._isPersonal)];
    const regularStreams = newznabStreams.filter(s => !s._isPersonal);

    // Clean up internal flags
    [...personalStreams, ...regularStreams].forEach(s => delete s._isPersonal);

    // Combine: personal files at top, then regular Newznab results
    const allStreams = [...personalStreams, ...regularStreams];

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

export default { getMovieStreams, getSeriesStreams, resolveUrl, STREAM_NAME_MAP };
