/**
 * Search coordinator to manage and coordinate searches across multiple debrid services
 * to avoid duplicate work when multiple services run simultaneously.
 *
 * Optimizations:
 * - Deduplicates simultaneous searches for the same content
 * - Shares scraper results across services (no need to scrape twice)
 * - Timeout protection to prevent hanging
 */

class SearchCoordinator {
  constructor() {
    // Store ongoing searches to avoid duplicate work
    this.ongoingSearches = new Map();
    // Store scraper results to share across services
    this.scraperCache = new Map();
    this.scraperCacheTTL = 60000; // 1 minute cache for scraper results
    this.searchTimeout = 30000; // 30 seconds timeout
  }

  /**
   * Execute a coordinated search to avoid duplicate work
   * @param {string} serviceName - Name of the service (e.g., 'realdebrid', 'torbox', etc.)
   * @param {Function} searchFunction - Function that performs the actual search
   * @param {string} type - Content type ('movie' or 'series')
   * @param {string} id - Content ID (e.g., 'tt1234567:s01:e01')
   * @param {Object} userConfig - User configuration
   * @returns {Promise<any>} Search results
   */
  async executeSearch(serviceName, searchFunction, type, id, userConfig) {
    const searchKey = `${type}:${id}:${JSON.stringify(userConfig)}`;
    const serviceKey = `${serviceName}:${searchKey}`;

    // Check if this specific service search is already in progress
    if (this.ongoingSearches.has(serviceKey)) {
      // Wait for the existing search to complete
      try {
        return await this.ongoingSearches.get(serviceKey);
      } catch (error) {
        // If the existing search failed, remove it and start a new one
        this.ongoingSearches.delete(serviceKey);
        throw error;
      }
    }

    // Check scraper cache - can reuse scraper results across services
    const scraperCacheKey = searchKey;
    const cachedScrapers = this.scraperCache.get(scraperCacheKey);
    if (cachedScrapers && Date.now() < cachedScrapers.expires) {
      console.log(`[SEARCH COORD] Reusing cached scraper results for ${searchKey}`);
      // Still execute the search function but with cached scraper data
      // The search function handles service-specific cache checking
    }

    const searchPromise = this._executeWithTimeout(searchFunction, serviceKey, scraperCacheKey);

    // Store the promise to prevent duplicate searches for the same service
    this.ongoingSearches.set(serviceKey, searchPromise);

    try {
      const results = await searchPromise;
      return results;
    } finally {
      // Clean up the ongoing search after completion or failure
      this.ongoingSearches.delete(serviceKey);
    }
  }

  /**
   * Cache scraper results so multiple services don't scrape the same content
   */
  cacheScraperResults(searchKey, results) {
    this.scraperCache.set(searchKey, {
      results,
      expires: Date.now() + this.scraperCacheTTL
    });
  }

  /**
   * Get cached scraper results
   */
  getCachedScraperResults(searchKey) {
    const cached = this.scraperCache.get(searchKey);
    if (cached && Date.now() < cached.expires) {
      return cached.results;
    }
    return null;
  }

  _executeWithTimeout(searchFunction, serviceKey) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.ongoingSearches.delete(serviceKey);
        reject(new Error(`Search timeout for ${serviceKey} after ${this.searchTimeout}ms`));
      }, this.searchTimeout);

      searchFunction()
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
}

// Create a singleton instance
const searchCoordinator = new SearchCoordinator();

export default searchCoordinator;