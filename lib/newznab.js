import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import crypto from 'crypto';
import * as MongoCache from './common/mongo-cache.js';
import { obfuscateSensitive } from './common/torrent-utils.js';

const LOG_PREFIX = 'NEWZNAB';

// Cache TTL for NZB file contents (in minutes)
const NZB_CACHE_TTL_MIN = 1440; // 24 hours

/**
 * Newznab API integration for Usenet NZB search
 * Implements the Newznab API specification for searching indexers
 */

/**
 * Search Newznab indexer for content
 * @param {string} serverUrl - Newznab server URL (e.g., https://indexer.example.com)
 * @param {string} apiKey - Newznab API key
 * @param {string} query - Search query
 * @param {object} options - Additional search options
 * @returns {Promise<Array>} - Array of NZB results
 */
async function search(serverUrl, apiKey, query, options = {}) {
  try {
    const {
      category = '', // Newznab category IDs (e.g., 5000 for TV, 2000 for Movies)
      limit = 50,
      offset = 0,
      type = 'movie' // 'movie' or 'series'
    } = options;

    // Clean server URL
    const baseUrl = serverUrl.replace(/\/$/, '');

    // Build API URL
    const params = new URLSearchParams({
      t: 'search',
      apikey: apiKey,
      q: query,
      limit: String(limit),
      offset: String(offset)
    });

    if (category) {
      params.append('cat', category);
    }

    const searchUrl = `${baseUrl}/api?${params.toString()}`;

    console.log(`[${LOG_PREFIX}] Search URL: ${searchUrl.replace(apiKey, '***')}`);
    console.log(`[${LOG_PREFIX}] Searching for: "${query}" (category: ${category || 'all'})`);

    // Retry logic for timeout errors
    let response;
    let lastError;
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await axios.get(searchUrl, {
          timeout: 45000, // Increased to 45 seconds
          headers: {
            'User-Agent': 'Sootio/1.0'
          }
        });
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error;
        if (error.code === 'ECONNABORTED' && attempt < maxRetries) {
          console.log(`[${LOG_PREFIX}] Request timeout, retrying (${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
        } else {
          throw error; // Re-throw if not timeout or last attempt
        }
      }
    }

    if (!response) {
      throw lastError;
    }

    if (!response.data) {
      console.error(`[${LOG_PREFIX}] Empty response from Newznab`);
      return [];
    }

    console.log(`[${LOG_PREFIX}] Response received, length: ${response.data?.length || 0} bytes`);

    // Parse XML response
    const parsed = await parseStringPromise(response.data, {
      explicitArray: false,
      mergeAttrs: true
    });

    if (!parsed) {
      console.error(`[${LOG_PREFIX}] Failed to parse XML response`);
      return [];
    }

    if (!parsed.rss) {
      console.error(`[${LOG_PREFIX}] No RSS element in response`);
      console.error(`[${LOG_PREFIX}] Response structure:`, Object.keys(parsed));
      return [];
    }

    if (!parsed.rss.channel) {
      console.error(`[${LOG_PREFIX}] No channel element in RSS`);
      return [];
    }

    if (!parsed.rss.channel.item) {
      console.log(`[${LOG_PREFIX}] No results found for query: ${query}`);
      // Check for error message
      if (parsed.rss.channel.description) {
        console.log(`[${LOG_PREFIX}] Newznab message: ${parsed.rss.channel.description}`);
      }
      return [];
    }

    // Normalize to array
    const items = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item
      : [parsed.rss.channel.item];

    // Transform to standard format
    const results = items.map(item => {
      const attrs = item['newznab:attr'];
      const attributes = {};

      // Parse newznab attributes
      if (attrs) {
        const attrArray = Array.isArray(attrs) ? attrs : [attrs];
        attrArray.forEach(attr => {
          if (attr.name && attr.value !== undefined) {
            attributes[attr.name] = attr.value;
          }
        });
      }

      return {
        id: item.guid || item.link,
        title: item.title || 'Unknown',
        name: item.title || 'Unknown',
        size: parseInt(attributes.size || item.size || 0),
        publishDate: item.pubDate || new Date().toISOString(),
        category: attributes.category || '',
        downloadUrl: item.link || item.enclosure?.url || '',
        nzbUrl: item.link || item.enclosure?.url || '',
        indexer: baseUrl,
        // Additional metadata
        grabs: parseInt(attributes.grabs || 0),
        files: parseInt(attributes.files || 1),
        poster: attributes.poster || '',
        group: attributes.group || '',
        imdbId: attributes.imdb || attributes.imdbid || '',
        tvdbId: attributes.tvdbid || '',
        season: attributes.season || null,
        episode: attributes.episode || null,
        attributes: attributes
      };
    });

    console.log(`[${LOG_PREFIX}] Found ${results.length} results`);
    return results;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Search error:`, error.message);
    if (error.response) {
      console.error(`[${LOG_PREFIX}] Response status: ${error.response.status}`);
      if (error.response.status === 401 || error.response.status === 403) {
        console.error(`[${LOG_PREFIX}] Authentication failed - check your API key`);
      }
      if (error.response.data) {
        console.error(`[${LOG_PREFIX}] Response data:`, typeof error.response.data === 'string'
          ? error.response.data.substring(0, 500)
          : error.response.data);
      }
    } else if (error.code === 'ECONNREFUSED') {
      console.error(`[${LOG_PREFIX}] Connection refused - check if Newznab server is running`);
    } else if (error.code === 'ETIMEDOUT') {
      console.error(`[${LOG_PREFIX}] Connection timeout - check your Newznab URL`);
    }
    return [];
  }
}

/**
 * Get NZB file content from URL
 * @param {string} nzbUrl - URL to the NZB file
 * @param {string} apiKey - Newznab API key
 * @returns {Promise<string>} - NZB file content as string
 */
async function getNzbContent(nzbUrl, apiKey) {
  try {
    // Create cache key from URL hash
    const urlHash = crypto.createHash('sha256').update(nzbUrl).digest('hex').substring(0, 16);
    const cacheKey = `usenet-nzb:${urlHash}`;
    let nzbContent = null;

    // Check cache first
    if (MongoCache.isEnabled()) {
      const collection = await MongoCache.getCollection();
      if (collection) {
        const cached = await collection.findOne({ _id: cacheKey });
        if (cached) {
          const now = Date.now();
          const createdAt = cached.createdAt ? cached.createdAt.getTime() : 0;
          const expiresAt = createdAt + NZB_CACHE_TTL_MIN * 60 * 1000;

          if (now < expiresAt) {
            console.log(`[${LOG_PREFIX}] Cache HIT for NZB: ${cacheKey}`);
            return cached.data;
          } else {
            console.log(`[${LOG_PREFIX}] Cache EXPIRED for NZB: ${cacheKey}`);
          }
        } else {
          console.log(`[${LOG_PREFIX}] Cache MISS for NZB: ${cacheKey}`);
        }
      }
    }

    // Fetch from URL if not in cache
    console.log(`[${LOG_PREFIX}] Fetching NZB from: ${obfuscateSensitive(nzbUrl, apiKey)}`);

    const response = await axios.get(nzbUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      },
      responseType: 'text'
    });

    if (!response.data) {
      throw new Error('Empty NZB response');
    }

    nzbContent = response.data;
    console.log(`[${LOG_PREFIX}] Successfully fetched NZB (${nzbContent.length} bytes)`);

    // Cache the NZB content
    if (MongoCache.isEnabled()) {
      const collection = await MongoCache.getCollection();
      if (collection) {
        const cacheDoc = {
          _id: cacheKey,
          data: nzbContent,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + NZB_CACHE_TTL_MIN * 60 * 1000)
        };
        try {
          await collection.updateOne({ _id: cacheKey }, { $set: cacheDoc }, { upsert: true });
          console.log(`[${LOG_PREFIX}] Cached NZB content: ${cacheKey}`);
        } catch (e) {
          console.error(`[${LOG_PREFIX}] Failed to cache NZB: ${e.message}`);
        }
      }
    }

    return nzbContent;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error fetching NZB:`, error.message);
    throw error;
  }
}

/**
 * Test Newznab connection and API key
 * @param {string} serverUrl - Newznab server URL
 * @param {string} apiKey - Newznab API key
 * @returns {Promise<boolean>} - True if connection is successful
 */
async function testConnection(serverUrl, apiKey) {
  try {
    const baseUrl = serverUrl.replace(/\/$/, '');
    const testUrl = `${baseUrl}/api?t=caps&apikey=${apiKey}`;

    const response = await axios.get(testUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    return response.status === 200;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Connection test failed:`, error.message);
    return false;
  }
}

export default {
  search,
  getNzbContent,
  testConnection
};
