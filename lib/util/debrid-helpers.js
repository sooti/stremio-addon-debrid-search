/**
 * Universal Debrid Service Helpers
 *
 * Common utility functions used across all debrid services.
 * Consolidates duplicated code for caching, formatting, and processing.
 */

import * as mongoCache from '../common/mongo-cache.js';
import { setMaxListeners } from 'events';

// ---------------------------------------------------------------------------------
// Abort Controller Management
// ---------------------------------------------------------------------------------

let globalAbortController = null;

export function createAbortController() {
  if (globalAbortController) globalAbortController.abort();
  globalAbortController = new AbortController();

  // Increase max listeners to prevent warnings when multiple scrapers use the same signal
  // Default is 10, but with multiple languages and many scrapers we can have 50+ listeners
  setMaxListeners(100, globalAbortController.signal);

  return globalAbortController;
}

// ---------------------------------------------------------------------------------
// MongoDB Cache Helpers
// ---------------------------------------------------------------------------------

/**
 * Add a hash to MongoDB cache (deferred, non-blocking)
 */
export function addHashToMongo(hash, fileName = null, size = null, data = null, service = null) {
  try {
    if (!hash || !service || !mongoCache?.isEnabled()) return;
    const payload = {
      service: String(service).toLowerCase(),
      hash: String(hash).toLowerCase(),
      fileName,
      size,
      data
    };
    setImmediate(() => {
      mongoCache.upsertCachedMagnet(payload).catch(() => {});
    });
  } catch (_) {}
}

/**
 * Bulk upsert hashes to MongoDB (deferred, non-blocking)
 */
export function deferMongoUpserts(payloads = []) {
  try {
    if (!mongoCache?.isEnabled() || !Array.isArray(payloads) || payloads.length === 0) {
      return;
    }
    setImmediate(() => {
      mongoCache.upsertCachedMagnets(payloads).catch(err => {
        console.error(`[MONGO] Background bulk upsert failed: ${err.message}`);
      });
    });
  } catch (err) {
    console.error(`[MONGO] Error deferring mongo upserts: ${err.message}`);
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
  addHashToMongo,
  deferMongoUpserts,
  uniqueUpserts,
  norm,
  getQualityCategory,
  makeReleaseKey,
  filterFilesByKeywords,
  formatCachedResult,
  formatExternalResult,
  combineAndMarkResults,
  delay
};
