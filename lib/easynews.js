import axios from 'axios';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';

const LOG_PREFIX = 'EN+';

/**
 * Easynews integration for direct Usenet video downloads
 * Based on easynews-plus-plus implementation
 */

// Cache for search results
const searchCache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

/**
 * Create HTTP Basic Auth header
 */
function createBasicAuth(username, password) {
  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Sanitize title for comparison
 */
function sanitizeTitle(title) {
  return title
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replaceAll('&', 'and')
    .replace(/[\.\-_:\s]+/g, ' ')
    .replace(/[\[\]\(\){}]/g, ' ')
    .replace(/[^\w\sÀ-ÿ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Check if file is a valid video
 */
function isValidVideo(file, userConfig = {}) {
  const duration = file['14'] || '';
  const title = file['10'] || '';
  const size = file.rawSize || 0;

  // Skip very short videos
  if (duration.match(/^\d+s/) || duration.match('^[0-5]m')) {
    console.log(`[${LOG_PREFIX}] Skipping short video: ${title} (${duration})`);
    return false;
  }

  // Skip password protected or virus infected
  if (file.passwd || file.virus) {
    console.log(`[${LOG_PREFIX}] Skipping protected/infected: ${title}`);
    return false;
  }

  // Skip non-video files
  if (file.type?.toUpperCase() !== 'VIDEO') {
    return false;
  }

  // Skip files smaller than 20MB (absolute minimum)
  if (size < 20 * 1024 * 1024) {
    console.log(`[${LOG_PREFIX}] Skipping tiny file: ${title} (${Math.round(size / 1024 / 1024)}MB)`);
    return false;
  }

  // Apply user-defined size filters
  // Note: config values are in GB to match stream-provider.js convention
  const minSizeGB = userConfig.minSize !== undefined ? userConfig.minSize : 0; // Default 0 GB minimum
  const maxSizeGB = userConfig.maxSize !== undefined ? userConfig.maxSize : 200; // Default 200 GB maximum
  const sizeGB = size / 1024 / 1024 / 1024;

  if (minSizeGB > 0 && sizeGB < minSizeGB) {
    console.log(`[${LOG_PREFIX}] File too small: ${title} (${sizeGB.toFixed(2)}GB < ${minSizeGB}GB)`);
    return false;
  }

  if (maxSizeGB > 0 && sizeGB > maxSizeGB) {
    console.log(`[${LOG_PREFIX}] File too large: ${title} (${sizeGB.toFixed(2)}GB > ${maxSizeGB}GB)`);
    return false;
  }

  // Filter out junk/incomplete releases
  const lowerTitle = title.toLowerCase();
  const junkPatterns = [
    /\b(sample|trailer|promo)\b/i,
    /^(kaka|exvid|failed)-/i, // Common junk prefixes
    /-cd[12]$/i, // Multi-CD releases (usually incomplete)
    /\bpart[12]\b/i, // Part files (usually incomplete)
  ];

  for (const pattern of junkPatterns) {
    if (pattern.test(lowerTitle)) {
      console.log(`[${LOG_PREFIX}] Filtering junk release: ${title}`);
      return false;
    }
  }

  return true;
}

/**
 * Extract quality from title or resolution
 */
function extractQuality(title, fullres) {
  const parsed = PTT.parse(title);

  if (parsed.resolution) {
    if (parsed.resolution === '2160p' || parsed.resolution.includes('4k') || parsed.resolution.includes('4K')) {
      return '4K';
    }
    return parsed.resolution;
  }

  // Check title for quality indicators
  const qualityPatterns = [
    { pattern: /\b2160p\b/i, quality: '4K' },
    { pattern: /\b4k\b/i, quality: '4K' },
    { pattern: /\buhd\b/i, quality: '4K' },
    { pattern: /\b1080p\b/i, quality: '1080p' },
    { pattern: /\b720p\b/i, quality: '720p' },
    { pattern: /\b480p\b/i, quality: '480p' },
  ];

  for (const { pattern, quality } of qualityPatterns) {
    if (pattern.test(title)) {
      return quality;
    }
  }

  // Fallback to fullres field
  if (fullres) {
    if (fullres.includes('2160') || fullres.includes('4K')) return '4K';
    if (fullres.includes('1080')) return '1080p';
    if (fullres.includes('720')) return '720p';
    if (fullres.includes('480')) return '480p';
  }

  return null;
}

/**
 * Search Easynews for content
 */
async function search(username, password, query, options = {}) {
  const {
    maxResults = 250,
    pageNr = 1,
    sort1 = 'dsize',
    sort1Direction = '-',
    sort2 = 'relevance',
    sort2Direction = '-',
    sort3 = 'dtime',
    sort3Direction = '-',
  } = options;

  // Check cache
  const cacheKey = JSON.stringify({ username, query, pageNr, maxResults, sort1, sort2, sort3 });
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[${LOG_PREFIX}] Cache hit for query: "${query}"`);
    return cached.data;
  }

  const searchParams = {
    st: 'adv',
    sb: '1',
    fex: 'm4v,3gp,mov,divx,xvid,wmv,avi,mpg,mpeg,mp4,mkv,avc,flv,webm',
    'fty[]': 'VIDEO',
    spamf: '1',
    u: '1',
    gx: '1',
    pno: pageNr.toString(),
    sS: '3',
    s1: sort1,
    s1d: sort1Direction,
    s2: sort2,
    s2d: sort2Direction,
    s3: sort3,
    s3d: sort3Direction,
    pby: maxResults.toString(),
    safeO: '0',
    gps: query,
  };

  const searchUrl = 'https://members.easynews.com/2.0/search/solr-search/advanced';

  try {
    console.log(`[${LOG_PREFIX}] Searching for: "${query}"`);

    const response = await axios.get(searchUrl, {
      params: searchParams,
      headers: {
        'Authorization': createBasicAuth(username, password),
        'User-Agent': 'Sootio/1.0'
      },
      timeout: 20000
    });

    if (!response.data) {
      console.error(`[${LOG_PREFIX}] Empty response from Easynews`);
      return null;
    }

    console.log(`[${LOG_PREFIX}] Found ${response.data.data?.length || 0} results out of ${response.data.results || 0} total`);

    // Cache the response
    searchCache.set(cacheKey, { data: response.data, timestamp: Date.now() });

    return response.data;
  } catch (error) {
    if (error.response?.status === 401) {
      console.error(`[${LOG_PREFIX}] Authentication failed - Invalid credentials`);
      throw new Error('Easynews authentication failed: Invalid username or password');
    }
    console.error(`[${LOG_PREFIX}] Search error: ${error.message}`);
    throw error;
  }
}

/**
 * Build query string for media content
 */
function buildSearchQuery(meta, type, season = null, episode = null) {
  const name = meta.name || meta.title;
  const year = meta.year;

  if (type === 'series' && season && episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `${name} S${s}E${e}`;
  }

  if (year) {
    return `${name} ${year}`;
  }

  return name;
}

/**
 * Create stream URL for Easynews file
 */
function createStreamUrl(searchResponse, file, username, password) {
  const postHash = file['0'] || '';
  const postTitle = file['10'] || '';
  const ext = file['11'] || '';
  const dlFarm = searchResponse.dlFarm;
  const dlPort = searchResponse.dlPort;
  const downURL = searchResponse.downURL || 'https://members.easynews.com';

  // Create stream path
  const streamPath = `${postHash}${ext}/${postTitle}${ext}`;

  // Direct URL with embedded credentials (works for most players)
  const url = `${downURL.replace('https://', `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@`)}/${dlFarm}/${dlPort}/${streamPath}`;

  return url;
}

/**
 * Format Easynews file as stream result
 */
function formatResult(searchResponse, file, username, password) {
  const title = file['10'] || 'Unknown';
  const size = file.rawSize || 0;
  const fullres = file.fullres || '';
  const quality = extractQuality(title, fullres);
  const languages = file.alangs || [];
  const postHash = file['0'] || '';
  const ext = file['11'] || '';
  const dlFarm = searchResponse.dlFarm;
  const dlPort = searchResponse.dlPort;
  const downURL = searchResponse.downURL || 'https://members.easynews.com';

  // Parse title for additional info
  const parsed = PTT.parse(title);

  // Build info object with all parsed data
  const info = parsed || { title };
  if (quality) {
    info.quality = quality;
  }

  // Create resolve URL instead of direct URL
  // Encode stream data as base64 for the resolve endpoint
  const streamData = {
    username,
    password,
    dlFarm,
    dlPort,
    postHash,
    ext,
    postTitle: title,
    downURL
  };

  const encodedData = Buffer.from(JSON.stringify(streamData)).toString('base64');
  const ADDON_HOST = process.env.ADDON_URL || 'http://localhost:55771';
  const url = `${ADDON_HOST}/resolve/easynews/${encodeURIComponent(encodedData)}`;

  return {
    name: title,
    info,
    size,
    seeders: 999, // Easynews is always available
    url,
    source: 'easynews',
    hash: postHash,
    tracker: 'Easynews',
    isCached: true, // Easynews files are always cached/available
    languages,
  };
}

/**
 * Search Easynews for streams
 * Main entry point matching the pattern of other debrid services
 */
async function searchEasynewsStreams(username, password, type, id, userConfig = {}) {
  try {
    console.log(`[${LOG_PREFIX}] Starting search for ${type} ${id}`);

    // Parse IMDb ID and extract season/episode if present
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    // Get metadata from Cinemeta
    const meta = await Cinemeta.getMeta(type, imdbId);
    if (!meta) {
      console.error(`[${LOG_PREFIX}] Failed to get metadata for ${type} ${imdbId}`);
      return [];
    }

    // Build search query
    const query = buildSearchQuery(meta, type, season, episode);
    console.log(`[${LOG_PREFIX}] Search query: "${query}"`);

    // Search Easynews
    const searchResponse = await search(username, password, query, {
      maxResults: 100,
      sort1: 'dsize', // Sort by size first
      sort2: 'relevance',
      sort3: 'dtime'
    });

    if (!searchResponse || !searchResponse.data || searchResponse.data.length === 0) {
      console.log(`[${LOG_PREFIX}] No results found for query: "${query}"`);
      return [];
    }

    // Filter and format results
    const validFiles = searchResponse.data.filter(file => isValidVideo(file, userConfig));
    console.log(`[${LOG_PREFIX}] ${validFiles.length} valid videos out of ${searchResponse.data.length} results`);

    const formattedResults = validFiles.map(file => formatResult(searchResponse, file, username, password));

    console.log(`[${LOG_PREFIX}] Returning ${formattedResults.length} streams`);
    return formattedResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error searching Easynews: ${error.message}`);
    return [];
  }
}

/**
 * Resolve Easynews stream URL
 *
 * Note: As of the /resolve/easynews/ endpoint implementation, Easynews now uses
 * lazy resolution. The stream URLs returned by formatResult() point to the
 * /resolve/easynews/:encodedData endpoint, which constructs the actual Easynews
 * download URL only when the user selects a stream.
 *
 * This function is kept for API compatibility but is no longer actively used.
 * Resolution now happens via the Express endpoint in server.js.
 */
async function resolveStreamUrl(username, password, encodedUrl, clientIp) {
  // Resolution now handled by /resolve/easynews/ endpoint in server.js
  console.log(`[${LOG_PREFIX}] URL resolution delegated to /resolve/easynews/ endpoint`);
  return encodedUrl;
}

export default {
  searchEasynewsStreams,
  resolveStreamUrl,
  search,
};
