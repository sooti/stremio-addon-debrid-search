/**
 * Search coordinator to manage and coordinate searches across multiple debrid services
 * to avoid duplicate work when multiple services run simultaneously.
 */

class SearchCoordinator {
  constructor() {
    // Store ongoing searches to avoid duplicate work
    this.ongoingSearches = new Map();
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

    // Check if a search for the same content is already in progress in any service
    // This would be a more advanced deduplication where if one service already has results
    // we might be able to reuse them, but for now we'll just execute the service-specific search
    const searchPromise = this._executeWithTimeout(searchFunction, serviceKey);

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