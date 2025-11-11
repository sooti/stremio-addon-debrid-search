// Cache version for scraper results - increment to invalidate all scraper caches
const SCRAPER_CACHE_VERSION = 'v1';

/**
 * Helper function to generate a cache key for scraper results
 * @param {string} scraperName - Name of the scraper
 * @param {string} query - Search query
 * @param {Object} config - Configuration object with Languages
 * @returns {string} Cache key
 */
export function generateScraperCacheKey(scraperName, query, config) {
  const langKey = (config?.Languages || []).join(',');
  const normalizedScraperName = String(scraperName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedQuery = String(query || '').toLowerCase().replace(/[^a-z0-9:-]/g, '');
  return `${normalizedScraperName}-scraper-${SCRAPER_CACHE_VERSION}:${normalizedQuery}:${langKey}`;
}
