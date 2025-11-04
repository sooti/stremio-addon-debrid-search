/**
 * Universal Debrid Service Helpers
 *
 * Common utility functions used across all debrid services.
 * Consolidates duplicated code for caching, formatting, and processing.
 */

import * as sqliteCache from './sqlite-cache.js';
import { setMaxListeners } from 'events';

// ---------------------------------------------------------------------------------
// Abort Controller Management
// ---------------------------------------------------------------------------------

/**
 * Create a new AbortController for each request.
 * Each request gets its own controller to prevent concurrent requests from canceling each other.
 *
 * @returns {AbortController} A new abort controller instance
 */
export function createAbortController() {
  const abortController = new AbortController();

  // Increase max listeners to prevent warnings when multiple scrapers use the same signal
  // Default is 10, but with multiple languages and many scrapers we can have 50+ listeners
  setMaxListeners(100, abortController.signal);

  return abortController;
}

// ---------------------------------------------------------------------------------
// SQLite Cache Helpers
// ---------------------------------------------------------------------------------

/**
 * Bounded queue for pending SQLite upserts to prevent memory leaks
 * When setImmediate() is used without bounds, callbacks can accumulate faster than
 * they execute, especially when SQLite is slow or under heavy load.
 */
const MAX_PENDING_UPSERTS = 200; // Maximum queue size before forced flush
const FLUSH_INTERVAL_MS = 2000;  // Flush every 2 seconds
let pendingUpserts = [];
let isFlushingUpserts = false;
let sqliteBackpressure = false;   // Set to true when SQLite is overloaded
let flushInterval = null;

/**
 * Initialize the periodic flush of pending upserts
 * (disabled when immediate saves are enabled)
 */
function initUpsertsFlush() {
  // Flush interval is not initialized when using immediate saves
  // All upserts are saved immediately instead of being queued
  return;
}

/**
 * Flush pending upserts to SQLite
 * (no-op when using immediate saves)
 */
async function flushPendingUpserts() {
  // No-op when using immediate saves - data is saved right away
  return;
}

/**
 * Stop the upserts flush interval (for cleanup)
 */
export function stopUpsertsFlush() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
    console.log('[SQLITE] Upserts flush interval stopped');
  }

  // Flush any remaining upserts
  if (pendingUpserts.length > 0) {
    console.log(`[SQLITE] Flushing ${pendingUpserts.length} remaining upserts before shutdown`);
    flushPendingUpserts().catch(() => {});
  }
}

// Initialize the flush interval when module is loaded
initUpsertsFlush();

/**
 * Add a hash to SQLite cache (immediate save)
 *
 * This version saves data immediately to SQLite instead of using the queue.
 * Use this when you need immediate persistence to the database.
 */
export function addHashToSqlite(hash, fileName = null, size = null, data = null, service = null) {
  try {
    if (!hash || !service || !sqliteCache?.isEnabled()) return;

    const payload = {
      service: String(service).toLowerCase(),
      hash: String(hash).toLowerCase(),
      fileName,
      size,
      data
    };

    // Save immediately instead of queuing
    setImmediate(() => {
      sqliteCache.upsertCachedMagnet(payload).catch(err => {
        console.error(`[SQLITE] Immediate upsert failed: ${err.message}`);
      });
    });
  } catch (err) {
    console.error(`[SQLITE] Error saving hash to SQLite: ${err.message}`);
  }
}

/**
 * Save hashes to SQLite (immediate, individual saves)
 *
 * This saves each record immediately to SQLite instead of batching.
 * This ensures immediate persistence to the database.
 */
export function deferSqliteUpserts(payloads = []) {
  try {
    if (!sqliteCache?.isEnabled() || !Array.isArray(payloads) || payloads.length === 0) {
      return;
    }

    // Save each payload individually for immediate persistence
    for (const payload of payloads) {
      setImmediate(() => {
        sqliteCache.upsertCachedMagnet(payload).catch(err => {
          console.error(`[SQLITE] Immediate upsert failed: ${err.message}`);
        });
      });
    }
  } catch (err) {
    console.error(`[SQLITE] Error saving hashes to SQLite: ${err.message}`);
  }
}

/**
 * Remove duplicate payloads by service+hash
 */
export function uniqueUpserts(payloads = []) {
  const seen = new Set();
  const out = [];
  for (const p of payloads) {
    const key = `${p.service || ''}:${(p.hash || '').toLowerCase()}`;
    if (!p.hash || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// String Normalization
// ---------------------------------------------------------------------------------

/**
 * Normalize string for comparison (remove quotes, extra spaces, lowercase)
 */
export function norm(s) {
  return (s || '').replace(/[''`]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
}

// ---------------------------------------------------------------------------------
// Quality Category Detection
// ---------------------------------------------------------------------------------

/**
 * Determine quality category from torrent name
 */
export function getQualityCategory(torrentName) {
  const name = (torrentName || '').toLowerCase();

  if (/(\s|\.)(aac|opus)\b/.test(name)) {
    return 'Audio-Focused';
  }

  if (/\bremux\b/.test(name)) {
    return 'Remux';
  }

  if (/\b(web-?rip|brrip|dlrip|bluray\s*rip)\b/.test(name)) {
    return 'BRRip/WEBRip';
  }

  if (/\b(blu-?ray|bdrip)\b/.test(name)) {
    return 'BluRay';
  }

  if (/\b(web-?\.?dl|web\b)/.test(name)) {
    return 'WEB/WEB-DL';
  }

  return 'Other';
}

// ---------------------------------------------------------------------------------
// Release Key Generation
// ---------------------------------------------------------------------------------

/**
 * Generate a consistent release key for caching
 */
export function makeReleaseKey(type, imdbId, season = null, episode = null) {
  if (type === 'series' && season != null && episode != null) {
    return `${imdbId}:s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
  }
  return imdbId;
}

// ---------------------------------------------------------------------------------
// File Filtering
// ---------------------------------------------------------------------------------

/**
 * Filter files by keywords in title
 */
export function filterFilesByKeywords(files, searchKey) {
  if (!searchKey || !Array.isArray(files)) return files;

  const keywords = searchKey.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return files;

  return files.filter(file => {
    const fileName = (file.name || file.path || '').toLowerCase();
    return keywords.some(keyword => fileName.includes(keyword));
  });
}

// ---------------------------------------------------------------------------------
// Result Formatting (Base Templates)
// ---------------------------------------------------------------------------------

/**
 * Format a cached result (base template)
 */
export function formatCachedResult(torrent, isCached, additionalFields = {}) {
  const episodeHint = torrent.episodeFileHint || null;

  return {
    name: torrent.Title || torrent.name || 'Unknown',
    title: torrent.Title || torrent.name || 'Unknown',
    size: torrent.Size || torrent.size || 0,
    seeders: torrent.Seeders || torrent.seeders || 0,
    infoHash: torrent.InfoHash || torrent.infoHash || torrent.hash || '',
    isCached: isCached,
    isPersonal: torrent.isPersonal || false,
    magnetLink: torrent.Link || torrent.magnetLink || torrent.link || '',
    episodeFileHint: episodeHint,
    ...additionalFields
  };
}

/**
 * Format an external search result (base template)
 */
export function formatExternalResult(result, additionalFields = {}) {
  return {
    name: result.Title || result.name || 'Unknown',
    title: result.Title || result.name || 'Unknown',
    size: result.Size || result.size || 0,
    seeders: result.Seeders || result.seeders || 0,
    infoHash: result.InfoHash || result.infoHash || result.hash || '',
    isCached: false,
    isPersonal: false,
    magnetLink: result.Link || result.magnetLink || result.link || '',
    ...additionalFields
  };
}

// ---------------------------------------------------------------------------------
// Result Combining
// ---------------------------------------------------------------------------------

/**
 * Combine personal files with external search results
 */
export function combineAndMarkResults(apiKey, personalFiles, externalSources, specificSearchKey) {
  const combined = [...personalFiles];

  // Flatten external sources (array of arrays from scrapers)
  const externalFlat = Array.isArray(externalSources)
    ? externalSources.flat().filter(Boolean)
    : [];

  combined.push(...externalFlat);

  return combined;
}

// ---------------------------------------------------------------------------------
// Delay Utility
// ---------------------------------------------------------------------------------

/**
 * Simple delay/sleep utility
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------
// Export all utilities
// ---------------------------------------------------------------------------------

export default {
  createAbortController,
  addHashToSqlite,
  deferSqliteUpserts,
  uniqueUpserts,
  norm,
  getQualityCategory,
  makeReleaseKey,
  filterFilesByKeywords,
  formatCachedResult,
  formatExternalResult,
  combineAndMarkResults,
  delay,
  stopUpsertsFlush
};
