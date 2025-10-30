/**
 * In-memory cache for RealDebrid personal files (torrents + downloads)
 * Reduces API calls by caching results for a configurable TTL
 */

const CACHE_TTL_MS = parseInt(process.env.RD_PERSONAL_CACHE_TTL_MINUTES || '5', 10) * 60 * 1000; // Default 5 minutes
const MAX_CACHE_SIZE = parseInt(process.env.RD_PERSONAL_CACHE_MAX_USERS || '1000', 10); // Max users to cache

class PersonalFilesCache {
  constructor() {
    this.cache = new Map(); // apiKey -> { torrents, downloads, timestamp }

    // Periodic cleanup of expired entries
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpired();
    }, CACHE_TTL_MS); // Run cleanup at TTL interval
  }

  /**
   * Cleanup expired cache entries
   */
  cleanupExpired() {
    const now = Date.now();
    let removedCount = 0;

    for (const [apiKey, entry] of this.cache.entries()) {
      if (now - entry.timestamp > CACHE_TTL_MS) {
        this.cache.delete(apiKey);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      console.log(`[RD CACHE] Cleaned up ${removedCount} expired personal file entries, ${this.cache.size} remaining`);
    }
  }

  /**
   * Evict oldest entry if cache is full (LRU)
   */
  evictOldestIfNeeded() {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      // Find oldest entry
      let oldestKey = null;
      let oldestTimestamp = Infinity;

      for (const [apiKey, entry] of this.cache.entries()) {
        if (entry.timestamp < oldestTimestamp) {
          oldestTimestamp = entry.timestamp;
          oldestKey = apiKey;
        }
      }

      if (oldestKey) {
        this.cache.delete(oldestKey);
        console.log(`[RD CACHE] Evicted oldest personal files entry, cache size: ${this.cache.size}/${MAX_CACHE_SIZE}`);
      }
    }
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
    // Evict oldest if needed before adding new entry
    this.evictOldestIfNeeded();

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
      ttlMinutes: CACHE_TTL_MS / 60000,
      maxSize: MAX_CACHE_SIZE
    };
  }

  /**
   * Shutdown and cleanup resources
   */
  shutdown() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      console.log('[RD CACHE] Personal files cache cleanup interval cleared');
    }
  }
}

// Singleton instance
const personalFilesCache = new PersonalFilesCache();

export default personalFilesCache;
