import Newznab from './newznab.js';
import SABnzbd from './sabnzbd.js';
import Cinemeta from './util/cinemeta.js';
import PTT from './util/parse-torrent-title.js';
import { getResolutionFromName, formatSize } from './common/torrent-utils.js';
import * as MongoCache from './common/mongo-cache.js';

const LOG_PREFIX = 'USENET';

// Cache TTL for Usenet searches (in minutes)
const SEARCH_CACHE_TTL_MIN = 60; // 1 hour
const NZB_CACHE_TTL_MIN = 1440; // 24 hours

/**
 * Usenet service integration combining Newznab search and SABnzbd downloads
 */

// Active downloads cache: nzoId -> download info
const activeDownloads = new Map();

/**
 * Search for content on Newznab indexer
 * @param {string} newznabUrl - Newznab server URL
 * @param {string} newznabApiKey - Newznab API key
 * @param {string} type - Content type (movie or series)
 * @param {string} id - IMDB ID or series ID
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of search results
 */
async function searchUsenet(newznabUrl, newznabApiKey, type, id, config) {
  try {
    let query = '';
    let category = '';
    let cinemetaDetails = null;

    if (type === 'movie') {
      cinemetaDetails = await Cinemeta.getMeta(type, id);
      // Clean query - remove special characters that might cause issues
      query = cinemetaDetails.name
        .replace(/:/g, '') // Remove colons
        .replace(/[^\w\s-]/g, '') // Remove other special chars except spaces and hyphens
        .trim();
      category = '2000'; // Movies category
    } else if (type === 'series') {
      const [imdbId, season, episode] = id.split(':');
      cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
      const paddedSeason = String(season).padStart(2, '0');
      const paddedEpisode = String(episode).padStart(2, '0');

      // Clean series name
      const cleanName = cinemetaDetails.name
        .replace(/:/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim();

      query = `${cleanName} S${paddedSeason}E${paddedEpisode}`;
      category = '5000'; // TV category

      console.log(`[${LOG_PREFIX}] Series info: ${cinemetaDetails.name} - Season ${season} Episode ${episode}`);
    }

    console.log(`[${LOG_PREFIX}] Searching Usenet for: "${query}" (category: ${category})`);

    // Check cache first
    const cacheKey = `usenet-search:${newznabUrl}:${type}:${id}`;
    let results = null;

    if (MongoCache.isEnabled()) {
      const collection = await MongoCache.getCollection();
      if (collection) {
        const cached = await collection.findOne({ _id: cacheKey });
        if (cached) {
          const now = Date.now();
          const createdAt = cached.createdAt ? cached.createdAt.getTime() : 0;
          const expiresAt = createdAt + SEARCH_CACHE_TTL_MIN * 60 * 1000;

          if (now < expiresAt) {
            console.log(`[${LOG_PREFIX}] Cache HIT: ${cacheKey}`);
            results = cached.data;
          } else {
            console.log(`[${LOG_PREFIX}] Cache EXPIRED: ${cacheKey}`);
          }
        } else {
          console.log(`[${LOG_PREFIX}] Cache MISS: ${cacheKey}`);
        }
      }
    }

    // If not in cache, fetch from Newznab
    if (!results) {
      results = await Newznab.search(newznabUrl, newznabApiKey, query, {
        category,
        limit: 50,
        type
      });

      // Cache the results
      if (results && results.length > 0 && MongoCache.isEnabled()) {
        const collection = await MongoCache.getCollection();
        if (collection) {
          const cacheDoc = {
            _id: cacheKey,
            data: results,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + SEARCH_CACHE_TTL_MIN * 60 * 1000)
          };
          try {
            await collection.updateOne({ _id: cacheKey }, { $set: cacheDoc }, { upsert: true });
            console.log(`[${LOG_PREFIX}] Cached search results: ${cacheKey}`);
          } catch (e) {
            console.error(`[${LOG_PREFIX}] Failed to cache: ${e.message}`);
          }
        }
      }
    }

    // If no results and query had special chars, try alternative searches
    if (results.length === 0 && type === 'movie') {
      // Try without year if present
      const queryWithoutYear = query.replace(/\b(19|20)\d{2}\b/g, '').trim();
      if (queryWithoutYear !== query) {
        console.log(`[${LOG_PREFIX}] Retrying without year: "${queryWithoutYear}"`);
        results = await Newznab.search(newznabUrl, newznabApiKey, queryWithoutYear, {
          category,
          limit: 50,
          type
        });
      }
    }

    if (!results || results.length === 0) {
      console.log(`[${LOG_PREFIX}] No results found`);
      return [];
    }

    // Filter and sort results
    let filteredResults = results;

    // Apply year filter for movies
    if (type === 'movie' && cinemetaDetails && cinemetaDetails.year) {
      filteredResults = filteredResults.filter(item => {
        const parsed = PTT.parse(item.title);
        if (parsed.year) {
          // Allow +/- 1 year tolerance for remakes, re-releases, etc.
          return Math.abs(parsed.year - cinemetaDetails.year) <= 1;
        }
        // If no year in title, keep it (might be a good match)
        return true;
      });
    }

    // Sort by quality and size
    filteredResults.sort((a, b) => {
      const resA = getResolutionFromName(a.title);
      const resB = getResolutionFromName(b.title);
      const resolutionOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
      const rankA = resolutionOrder[resA] || 0;
      const rankB = resolutionOrder[resB] || 0;
      if (rankA !== rankB) return rankB - rankA;
      return b.size - a.size;
    });

    console.log(`[${LOG_PREFIX}] Filtered to ${filteredResults.length} results`);
    return filteredResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Search error:`, error.message);
    return [];
  }
}

/**
 * Submit NZB to SABnzbd and start download
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} sabnzbdApiKey - SABnzbd API key
 * @param {string} newznabUrl - Newznab server URL
 * @param {string} newznabApiKey - Newznab API key
 * @param {string} nzbUrl - URL to NZB file
 * @param {string} name - Name for the download
 * @returns {Promise<object>} - Download info with NZO ID
 */
async function submitNzb(sabnzbdUrl, sabnzbdApiKey, newznabUrl, newznabApiKey, nzbUrl, name) {
  try {
    console.log(`[${LOG_PREFIX}] Submitting NZB to SABnzbd: ${name}`);

    // Get NZB content from Newznab
    const nzbContent = await Newznab.getNzbContent(nzbUrl, newznabApiKey);

    // Add to SABnzbd
    const result = await SABnzbd.addNzb(sabnzbdUrl, sabnzbdApiKey, nzbContent, name);

    // Store in active downloads
    activeDownloads.set(result.nzoId, {
      nzoId: result.nzoId,
      name: name,
      startTime: Date.now(),
      status: 'downloading'
    });

    console.log(`[${LOG_PREFIX}] NZB submitted successfully: ${result.nzoId}`);
    return result;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error submitting NZB:`, error.message);
    throw error;
  }
}

/**
 * Get download progress for NZO
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} sabnzbdApiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to check
 * @returns {Promise<object>} - Download progress info
 */
async function getDownloadProgress(sabnzbdUrl, sabnzbdApiKey, nzoId) {
  try {
    const status = await SABnzbd.getDownloadStatus(sabnzbdUrl, sabnzbdApiKey, nzoId);

    // Update cache
    if (activeDownloads.has(nzoId)) {
      activeDownloads.set(nzoId, {
        ...activeDownloads.get(nzoId),
        ...status
      });
    }

    return status;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting download progress:`, error.message);
    return {
      status: 'error',
      error: error.message
    };
  }
}

/**
 * Wait until download has enough data to start streaming
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} sabnzbdApiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to monitor
 * @param {number} minPercentage - Minimum percentage before streaming (default: 10%)
 * @param {number} maxWaitTime - Maximum wait time in milliseconds (default: 5 minutes)
 * @returns {Promise<object>} - Download status when ready
 */
async function waitForStreamingReady(sabnzbdUrl, sabnzbdApiKey, nzoId, minPercentage = 10, maxWaitTime = 300000) {
  const startTime = Date.now();
  const pollInterval = 3000; // Check every 3 seconds

  console.log(`[${LOG_PREFIX}] Waiting for NZO ${nzoId} to reach ${minPercentage}% for streaming...`);

  while (Date.now() - startTime < maxWaitTime) {
    const status = await getDownloadProgress(sabnzbdUrl, sabnzbdApiKey, nzoId);

    if (status.status === 'error' || status.status === 'failed') {
      throw new Error(`Download failed: ${status.error || status.failMessage || 'Unknown error'}`);
    }

    if (status.status === 'completed') {
      console.log(`[${LOG_PREFIX}] Download completed: ${nzoId}`);
      return status;
    }

    if (status.status === 'downloading' && status.percentComplete >= minPercentage) {
      console.log(`[${LOG_PREFIX}] Download ready for streaming: ${status.percentComplete}%`);
      return status;
    }

    // Log progress every poll
    if (status.percentComplete > 0) {
      console.log(`[${LOG_PREFIX}] Download progress: ${status.percentComplete.toFixed(1)}% (waiting for ${minPercentage}%)`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Timeout waiting for download to reach ${minPercentage}%`);
}

/**
 * Get streamable file from completed download
 * @param {string} sabnzbdUrl - SABnzbd server URL
 * @param {string} sabnzbdApiKey - SABnzbd API key
 * @param {string} path - Path to completed download
 * @param {object} options - Options for file selection
 * @returns {Promise<string>} - Path to video file
 */
async function getStreamableFile(sabnzbdUrl, sabnzbdApiKey, path, options = {}) {
  try {
    const videoFiles = await SABnzbd.getVideoFiles(sabnzbdUrl, sabnzbdApiKey, path);

    if (videoFiles.length === 0) {
      throw new Error('No video files found in download');
    }

    // For series, try to match episode
    if (options.season && options.episode) {
      const s = Number(options.season);
      const e = Number(options.episode);

      const matchedFile = videoFiles.find(file => {
        const parsed = PTT.parse(file.name);
        return parsed.season === s && parsed.episode === e;
      });

      if (matchedFile) {
        return matchedFile.path;
      }
    }

    // Return largest file
    const largestFile = videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
    return largestFile.path;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting streamable file:`, error.message);
    throw error;
  }
}

/**
 * Clean up old downloads from cache
 * @param {number} maxAge - Maximum age in milliseconds (default: 24 hours)
 */
function cleanupOldDownloads(maxAge = 86400000) {
  const now = Date.now();
  for (const [nzoId, info] of activeDownloads.entries()) {
    if (now - info.startTime > maxAge) {
      console.log(`[${LOG_PREFIX}] Removing old download from cache: ${nzoId}`);
      activeDownloads.delete(nzoId);
    }
  }
}

// Run cleanup every hour
setInterval(() => cleanupOldDownloads(), 3600000);

export default {
  searchUsenet,
  submitNzb,
  getDownloadProgress,
  waitForStreamingReady,
  getStreamableFile,
  activeDownloads
};
