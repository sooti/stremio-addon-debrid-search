/**
 * Provider-specific stream fetching logic
 * Each provider has its own search and formatting logic
 */

import DebridLink from '../../debrid-link.js';
import RealDebrid from '../../real-debrid.js';
import AllDebrid from '../../all-debrid.js';
import Premiumize from '../../premiumize.js';
import OffCloud from '../../offcloud.js';
import TorBox from '../../torbox.js';
import DebriderApp from '../../debrider.app.js';
import { filterYear, filterSeason, filterEpisode, matchesSeriesTitle, hasEpisodeMarker } from '../../util/filter-torrents.js';
import { getCachedTorrents } from '../caching/cache-manager.js';
import { sortTorrents } from '../utils/sorting.js';
import { toStream } from '../formatters/stream-formatter.js';
import { toDebriderStream } from '../formatters/debrider-formatter.js';

/**
 * Fetch movie streams from a single debrid provider
 *
 * @param {string} debridProvider - Provider name
 * @param {string} apiKey - API key for the provider
 * @param {string} type - Content type ('movie')
 * @param {string} id - Content ID (IMDB ID)
 * @param {Object} config - User configuration
 * @param {Object} cinemetaDetails - Movie metadata from Cinemeta
 * @param {string} searchKey - Search query string
 * @returns {Promise<Array>} - Array of stream objects
 */
export async function getMovieStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey) {
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
    const allResults = await getCachedTorrents(debridProvider, type, id, config, (isBackgroundRefresh = false) => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh));
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
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
      return toStream(item, type, providerConfig);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, (isBackgroundRefresh = false) => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh));
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
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
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
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => OffCloud.searchOffcloudTorrents(apiKey, type, id, config));
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

/**
 * Fetch series streams from a single debrid provider
 *
 * @param {string} debridProvider - Provider name
 * @param {string} apiKey - API key for the provider
 * @param {string} type - Content type ('series')
 * @param {string} id - Content ID (IMDB:season:episode)
 * @param {Object} config - User configuration
 * @param {Object} cinemetaDetails - Series metadata from Cinemeta
 * @param {string} searchKey - Search query string
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {Promise<Array>} - Array of stream objects
 */
export async function getSeriesStreamsFromProvider(debridProvider, apiKey, type, id, config, cinemetaDetails, searchKey, season, episode) {
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
    const allResults = await getCachedTorrents(debridProvider, type, id, config, (isBackgroundRefresh = false) => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh));
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
      return toStream(item, type, providerConfig);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, (isBackgroundRefresh = false) => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config, config.clientIp, isBackgroundRefresh));
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      // Skip cached items with invalid URLs containing 'undefined'
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) {
        if (item.url.includes('/undefined') || item.url.endsWith('undefined')) {
          console.log(`[CACHE] Skipping cached item with invalid URL: ${item.title || item.name}`);
          return null;
        }
        return item;
      }
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
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => OffCloud.searchOffcloudTorrents(apiKey, type, id, config));
    if (torrents && torrents.length) {
      const bypass = torrents.filter(t => t.bypassFiltering === true);
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
