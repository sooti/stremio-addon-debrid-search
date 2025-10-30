/**
 * Scraper Orchestration Module
 *
 * Centralized scraper selection and execution logic.
 * Determines which scrapers to use based on user config and .env settings.
 * Provides smart defaults when user hasn't selected specific scrapers.
 */

import * as config from '../config.js';
import * as scrapers from '../common/scrapers.js';

/**
 * Determines which scrapers to use based on user config and .env settings.
 * If user hasn't selected specific scrapers, uses smart defaults (1337x, Jackett if enabled, or top 2).
 * @param {Object} userConfig - User configuration from manifest
 * @param {string} logPrefix - Log prefix for console messages
 * @returns {Object} Object with scraper names as keys and boolean values
 */
export function getEnabledScrapers(userConfig = {}, logPrefix = 'SCRAPER') {
  const userScrapers = Array.isArray(userConfig.Scrapers) ? userConfig.Scrapers : [];
  const userIndexerScrapers = Array.isArray(userConfig.IndexerScrapers) ? userConfig.IndexerScrapers : [];

  // Map of scraper IDs to their config flags
  const scraperMap = {
    'jackett': config.JACKETT_ENABLED,
    '1337x': config.TORRENT_1337X_ENABLED,
    'torrent9': config.TORRENT9_ENABLED,
    'btdig': config.BTDIG_ENABLED,
    'snowfl': config.SNOWFL_ENABLED,
    'magnetdl': config.MAGNETDL_ENABLED,
    'wolfmax4k': config.WOLFMAX4K_ENABLED,
    'bludv': config.BLUDV_ENABLED,
    'bitmagnet': config.BITMAGNET_ENABLED,
    'zilean': config.ZILEAN_ENABLED,
    'torrentio': config.TORRENTIO_ENABLED,
    'comet': config.COMET_ENABLED,
    'stremthru': config.STREMTHRU_ENABLED
  };

  // If user has selected specific scrapers, use those (filtered by what's enabled in .env)
  if (userScrapers.length > 0 || userIndexerScrapers.length > 0) {
    const enabled = {};
    for (const scraper of userScrapers) {
      if (scraperMap[scraper]) {
        enabled[scraper] = true;
      }
    }
    for (const scraper of userIndexerScrapers) {
      if (scraperMap[scraper]) {
        enabled[scraper] = true;
      }
    }
    console.log(`[${logPrefix}] User selected scrapers: ${Object.keys(enabled).join(', ')}`);
    return enabled;
  }

  // Smart defaults: Use 1337x and Jackett if enabled, plus default indexer scrapers if enabled
  const enabledInEnv = Object.entries(scraperMap)
    .filter(([_, isEnabled]) => isEnabled)
    .map(([name, _]) => name);

  if (enabledInEnv.length === 0) {
    console.log(`[${logPrefix}] No scrapers enabled in .env`);
    return {};
  }

  // Check what indexer scrapers are enabled in env
  const defaultIndexerScrapers = [];
  if (config.ZILEAN_ENABLED) defaultIndexerScrapers.push('zilean');
  if (config.TORRENTIO_ENABLED) defaultIndexerScrapers.push('torrentio');
  if (config.COMET_ENABLED) defaultIndexerScrapers.push('comet');
  if (config.STREMTHRU_ENABLED) defaultIndexerScrapers.push('stremthru');

  // Priority order for regular torrent scrapers: 1337x, jackett, then others
  const priorityOrder = ['1337x', 'jackett', 'magnetdl', 'torrent9', 'snowfl', 'btdig', 'bitmagnet', 'wolfmax4k', 'bludv'];
  const enabledTorrentScrapers = enabledInEnv.filter(name => !['zilean', 'torrentio', 'comet', 'stremthru'].includes(name));
  const sortedTorrentScrapers = enabledTorrentScrapers.sort((a, b) => {
    const aIdx = priorityOrder.indexOf(a);
    const bIdx = priorityOrder.indexOf(b);
    const aPriority = aIdx === -1 ? 999 : aIdx;
    const bPriority = bIdx === -1 ? 999 : bIdx;
    return aPriority - bPriority;
  });

  // Take top 2 torrent scrapers
  const defaultScrapers = sortedTorrentScrapers.slice(0, 2);
  
  const enabled = {};
  for (const scraper of defaultScrapers) {
    enabled[scraper] = true;
  }

  // Only add indexer scrapers to default if no specific user selection of regular scrapers was made
  // This ensures that if the user selects any regular scrapers, indexer scrapers are not auto-added
  // unless they're also explicitly selected
  if (userScrapers.length === 0 && userIndexerScrapers.length === 0) {
    for (const scraper of defaultIndexerScrapers) {
      enabled[scraper] = true;
    }
  } else {
    // If user made any selections, only enable the ones they explicitly selected
    for (const scraper of userIndexerScrapers) {
      if (scraperMap[scraper]) {
        enabled[scraper] = true;
      }
    }
  }

  console.log(`[${logPrefix}] Using smart default scrapers: ${Object.keys(enabled).join(', ')} (top 2 from: ${enabledTorrentScrapers.join(', ')} + indexer scrapers: ${defaultIndexerScrapers.join(', ')})`);
  return enabled;
}

/**
 * Check if a scraper should be enabled based on user selection
 * @param {string} scraperName - Name of the scraper to check
 * @param {Object} enabledScrapers - Object with enabled scraper flags
 * @returns {boolean} True if scraper should be enabled
 */
export function shouldEnableScraper(scraperName, enabledScrapers) {
  return enabledScrapers[scraperName] === true;
}

/**
 * Orchestrate all scrapers based on user config and return promises.
 * This centralizes the scraper orchestration logic in one place.
 *
 * @param {Object} params - Scraper orchestration parameters
 * @param {string} params.type - Content type ('movie' or 'series')
 * @param {string} params.imdbId - IMDB ID
 * @param {string} params.searchKey - Search query for scrapers
 * @param {string} params.baseSearchKey - Base search query
 * @param {string|number} params.season - Season number (for series)
 * @param {string|number} params.episode - Episode number (for series)
 * @param {AbortSignal} params.signal - Abort signal for cancellation
 * @param {string} params.logPrefix - Log prefix (e.g., 'RD', 'AD', 'TB')
 * @param {Object} params.userConfig - User configuration
 * @param {Array<string>} params.selectedLanguages - Selected languages filter
 * @returns {Promise<Array>} Promise that resolves to array of scraper results
 */
export async function orchestrateScrapers({
  type,
  imdbId,
  searchKey,
  baseSearchKey,
  season,
  episode,
  signal,
  logPrefix,
  userConfig = {},
  selectedLanguages = []
}) {
  const enabledScrapers = getEnabledScrapers(userConfig, logPrefix);
  const scraperPromises = [];

  // Helper to add scraper promises for a given config
  const addScraperPromises = (cfg, key) => {
    // Indexer scrapers (check both .env and user selection)
    const userIndexerScrapers = Array.isArray(cfg.IndexerScrapers) ? cfg.IndexerScrapers : [];
    if (config.TORRENTIO_ENABLED && userIndexerScrapers.includes('torrentio')) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, logPrefix, cfg));
    if (config.ZILEAN_ENABLED && userIndexerScrapers.includes('zilean')) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, logPrefix, cfg));
    if (config.COMET_ENABLED && userIndexerScrapers.includes('comet')) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, logPrefix, cfg));
    if (config.STREMTHRU_ENABLED && userIndexerScrapers.includes('stremthru')) scraperPromises.push(scrapers.searchStremthru(type, imdbId, signal, season, episode, logPrefix, cfg));

    // Torrent scrapers (check user selection)
    if (shouldEnableScraper('bitmagnet', enabledScrapers)) scraperPromises.push(scrapers.searchBitmagnet(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('jackett', enabledScrapers)) scraperPromises.push(scrapers.searchJackett(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('torrent9', enabledScrapers)) scraperPromises.push(scrapers.searchTorrent9(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('1337x', enabledScrapers)) scraperPromises.push(scrapers.search1337x(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('btdig', enabledScrapers)) scraperPromises.push(scrapers.searchBtdig(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('snowfl', enabledScrapers)) scraperPromises.push(scrapers.searchSnowfl(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('magnetdl', enabledScrapers)) scraperPromises.push(scrapers.searchMagnetDL(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('wolfmax4k', enabledScrapers)) scraperPromises.push(scrapers.searchWolfmax4K(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('bludv', enabledScrapers)) scraperPromises.push(scrapers.searchBluDV(key, signal, logPrefix, cfg));
  };

  // Execute scrapers based on language selection
  if (selectedLanguages.length === 0) {
    const cfg = { ...userConfig, Languages: [] };
    const key = baseSearchKey;
    addScraperPromises(cfg, key);
  } else {
    for (const lang of selectedLanguages) {
      const cfg = { ...userConfig, Languages: [lang] };
      const key = baseSearchKey;
      addScraperPromises(cfg, key);
    }
  }

  return await Promise.all(scraperPromises);
}
