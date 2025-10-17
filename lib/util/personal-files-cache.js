/**
 * In-memory cache for RealDebrid personal files (torrents + downloads)
 * Reduces API calls by caching results for a configurable TTL
 */

const CACHE_TTL_MS = parseInt(process.env.RD_PERSONAL_CACHE_TTL_MINUTES || '5', 10) * 60 * 1000; // Default 5 minutes

class PersonalFilesCache {
  constructor() {
    this.cache = new Map(); // apiKey -> { torrents, downloads, timestamp }
  }

  /**
   * Get cached personal files if not expired
   * @param {string} apiKey - User's RD API key
   * @returns {Object|null} - { torrents: [], downloads: [] } or null if expired/missing
   */
  get(apiKey) {
    const entry = this.cache.get(apiKey);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > CACHE_TTL_MS) {
      this.cache.delete(apiKey);
      return null;
    }

    console.log(`[RD CACHE] Personal files cache HIT (age: ${Math.round(age / 1000)}s)`);
    return { torrents: entry.torrents, downloads: entry.downloads };
  }

  /**
   * Store personal files in cache
   * @param {string} apiKey - User's RD API key
   * @param {Array} torrents - User's torrents
   * @param {Array} downloads - User's downloads
   */
  set(apiKey, torrents, downloads) {
    this.cache.set(apiKey, {
      torrents,
      downloads,
      timestamp: Date.now()
    });
    console.log(`[RD CACHE] Personal files cached (${torrents.length} torrents, ${downloads.length} downloads)`);
  }

  /**
   * Clear cache for a specific user or all users
   * @param {string|null} apiKey - User's API key, or null to clear all
   */
  clear(apiKey = null) {
    if (apiKey) {
      this.cache.delete(apiKey);
      console.log(`[RD CACHE] Personal files cache cleared for user`);
    } else {
      this.cache.clear();
      console.log(`[RD CACHE] Personal files cache cleared for all users`);
    }
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      ttlMinutes: CACHE_TTL_MS / 60000
    };
  }
}

// Singleton instance
const personalFilesCache = new PersonalFilesCache();

export default personalFilesCache;
