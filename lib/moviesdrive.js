import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import * as SqliteCache from './util/sqlite-cache.js';
import { getResolutionFromName, formatSize } from './common/torrent-utils.js';
import Cinemeta from './util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from './util/language-mapping.js';
import debridProxyManager from './util/debrid-proxy.js';

// Function to encode URLs for streaming
function encodeUrlForStreaming(url) {
  if (!url) return url;

  // Don't re-encode already encoded URLs
  if (url.includes('%')) {
    return url;
  }

  try {
    const urlObj = new URL(url);
    return urlObj.toString();
  } catch (e) {
    return url
      .replace(/ /g, '%20')
      .replace(/#/g, '%23')
      .replace(/\[/g, '%5B')
      .replace(/\]/g, '%5D')
      .replace(/{/g, '%7B')
      .replace(/}/g, '%7D');
  }
}

// --- Proxy Configuration ---
const MOVIESDRIVE_PROXY_URL = process.env.MOVIESDRIVE_PROXY_URL;
if (MOVIESDRIVE_PROXY_URL) {
  console.log(`[MoviesDrive] Legacy proxy support enabled: ${MOVIESDRIVE_PROXY_URL}`);
} else {
  console.log('[MoviesDrive] No legacy proxy configured, checking debrid-proxy system');
}

// Check if httpstreams should use proxy via debrid-proxy system
const USE_HTTPSTREAMS_PROXY = debridProxyManager.shouldUseProxy('httpstreams');
if (USE_HTTPSTREAMS_PROXY) {
  console.log('[MoviesDrive] httpstreams proxy enabled via debrid-proxy system');
}

// --- Domain Management ---
let moviesDriveDomain = 'https://moviesdrive.lat'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = parseInt(process.env.MOVIESDRIVE_DOMAIN_CACHE_TTL) || 1 * 60 * 1000; // 1 minute default

async function getMoviesDriveDomain() {
  const now = Date.now();
  if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
    return moviesDriveDomain;
  }

  const DEFAULT_TIMEOUT = parseInt(process.env.MOVIESDRIVE_DOMAIN_TIMEOUT) || 10000;
  const MAX_RETRIES = parseInt(process.env.MOVIESDRIVE_DOMAIN_MAX_RETRIES) || 2;
  const RETRY_DELAY = parseInt(process.env.MOVIESDRIVE_DOMAIN_RETRY_DELAY) || 1000;

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[MoviesDrive] Fetching latest domain (attempt ${attempt + 1})...`);
      const response = await axios.get('https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json', { timeout: DEFAULT_TIMEOUT });
      if (response && response.data && response.data.MoviesDrive) {
        moviesDriveDomain = response.data.MoviesDrive;
        domainCacheTimestamp = Date.now();
        console.log(`[MoviesDrive] Updated domain to: ${moviesDriveDomain}`);
        return moviesDriveDomain;
      }
    } catch (error) {
      lastError = error;
      console.warn(`[MoviesDrive] Domain fetch attempt ${attempt + 1} failed:`, error.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  console.warn(`[MoviesDrive] All domain fetch attempts failed. Using fallback: ${moviesDriveDomain}`);
  return moviesDriveDomain;
}

// --- Axios Instance with Proxy Support ---
const createAxiosInstance = () => {
  const config = {
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    validateStatus: (status) => status < 500
  };

  // Add proxy configuration if MOVIESDRIVE_PROXY_URL is set (legacy)
  if (MOVIESDRIVE_PROXY_URL) {
    console.log(`[MoviesDrive] Using legacy proxy: ${MOVIESDRIVE_PROXY_URL}`);
  } else {
    // Use debrid-proxy system if httpstreams proxy is enabled
    const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
    if (proxyAgent) {
      config.httpAgent = proxyAgent;
      config.httpsAgent = proxyAgent;
      config.proxy = false; // Disable axios built-in proxy handling
      console.log('[MoviesDrive] Using debrid-proxy system for httpstreams');
    }
  }

  return axios.create(config);
};

const axiosInstance = createAxiosInstance();

// --- HTTP Request Handler ---
async function makeRequest(url, options = {}) {
  const DEFAULT_TIMEOUT = parseInt(process.env.MOVIESDRIVE_REQUEST_TIMEOUT) || 30000;
  const MAX_RETRIES = parseInt(process.env.MOVIESDRIVE_REQUEST_MAX_RETRIES) || 2;
  const RETRY_DELAY = parseInt(process.env.MOVIESDRIVE_REQUEST_RETRY_DELAY) || 1000;

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let response;

      if (MOVIESDRIVE_PROXY_URL && !url.includes('raw.githubusercontent.com')) {
        // Route through legacy proxy
        const proxiedUrl = `${MOVIESDRIVE_PROXY_URL}${encodeURIComponent(url)}`;
        console.log(`[MoviesDrive] Making legacy proxied request to: ${url} (attempt ${attempt + 1})`);
        response = await axiosInstance.get(proxiedUrl, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      } else if (USE_HTTPSTREAMS_PROXY) {
        // Using debrid-proxy system, no need to modify URL - agent handles it
        console.log(`[MoviesDrive] Making proxied request via debrid-proxy to: ${url} (attempt ${attempt + 1})`);
        response = await axiosInstance.get(url, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      } else {
        // Direct request without proxy
        console.log(`[MoviesDrive] Making direct request to: ${url} (attempt ${attempt + 1})`);
        response = await axiosInstance.get(url, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      }

      // Parse HTML if requested
      if (options.parseHTML && response.data) {
        const $ = cheerio.load(response.data);
        return {
          document: $,
          data: response.data,
          status: response.status,
          url: response.request?.res?.responseUrl || url
        };
      }

      return response;
    } catch (error) {
      lastError = error;
      console.error(`[MoviesDrive] Request failed (attempt ${attempt + 1}):`, error.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  throw lastError;
}

// --- Search Functions ---
async function searchMovies(query) {
  console.log(`[MoviesDrive] Searching for: "${query}"`);

  try {
    const domain = await getMoviesDriveDomain();
    // Use + for spaces instead of %20 (standard query format)
    const searchQuery = query.replace(/\s+/g, '+');
    const searchUrl = `${domain}/?s=${searchQuery}`;
    console.log(`[MoviesDrive] Search URL: ${searchUrl}`);

    const response = await makeRequest(searchUrl, { parseHTML: true });
    const $ = response.document;

    const results = [];

    // Find all movie/series links in search results
    // Look for links that go to movie/series pages (not search, feed, or category pages)
    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      const text = $(elem).text().trim();

      // Filter for actual content links (not navigation, search, feeds, etc.)
      if (href && text &&
          href.includes(domain) &&
          !href.includes('?s=') &&
          !href.includes('/feed/') &&
          !href.includes('/category/') &&
          !href.includes('/tag/') &&
          !href.includes('/search/') &&
          !href.includes('#') &&
          href.match(/\/[a-z0-9-]+\/?$/)) { // Must end with slug pattern

        // Extract title and year from URL or text
        const urlMatch = href.match(/\/([^/]+)\/?$/);
        if (urlMatch) {
          const slug = urlMatch[1];

          // Try to extract year from slug, text, or use null
          let year = null;
          const yearMatchSlug = slug.match(/[-_](\d{4})/);
          const yearMatchText = text.match(/\((\d{4})\)/);

          if (yearMatchSlug) {
            year = parseInt(yearMatchSlug[1]);
          } else if (yearMatchText) {
            year = parseInt(yearMatchText[1]);
          }

          results.push({
            title: text,
            url: href,
            slug: slug,
            year: year
          });
        }
      }
    });

    // Remove duplicates based on URL
    const uniqueResults = results.filter((result, index, self) =>
      index === self.findIndex((r) => r.url === result.url)
    );

    console.log(`[MoviesDrive] Found ${uniqueResults.length} unique results`);
    return uniqueResults;
  } catch (error) {
    console.error(`[MoviesDrive] Search failed:`, error.message);
    return [];
  }
}

// --- Media Comparison ---
function compareMedia(mediaInfo, searchResult) {
  // Normalize titles for comparison
  const normalizeTitle = (title) => {
    let normalized = title.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Normalize common number-to-word variations for better matching
    // e.g., "Fantastic 4" <-> "Fantastic Four"
    const numberWords = {
      '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five',
      '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten'
    };

    // Replace standalone numbers with their word equivalents
    Object.keys(numberWords).forEach(num => {
      const word = numberWords[num];
      // Replace number with word (e.g., " 4 " -> " four ")
      normalized = normalized.replace(new RegExp(`\\b${num}\\b`, 'g'), word);
      // Already handles word form, so no need to reverse
    });

    return normalized;
  };

  const mediaTitle = normalizeTitle(mediaInfo.title);
  const resultTitle = normalizeTitle(searchResult.title);

  // For TV shows, remove season/episode numbers from result for matching
  // e.g., "The Witcher Season 1" -> "the witcher"
  const resultTitleClean = resultTitle
    .replace(/\s+season\s+\d+/gi, '')
    .replace(/\s+s\d+/gi, '')
    .replace(/\s+complete/gi, '')
    .trim();

  // Check if titles match (more lenient for TV shows)
  const titleMatch = resultTitleClean.includes(mediaTitle) ||
                     mediaTitle.includes(resultTitleClean) ||
                     resultTitle.includes(mediaTitle) ||
                     mediaTitle.includes(resultTitle);

  // Check year if available (more lenient - within 2 years for TV shows)
  let yearMatch = true;
  if (mediaInfo.year && searchResult.year) {
    yearMatch = Math.abs(mediaInfo.year - searchResult.year) <= 2;
  }
  // If search result has no year, only rely on title matching
  // This helps with TV series that don't have years in their URLs

  return titleMatch && yearMatch;
}

// --- Score Results ---
function scoreResult(resultTitle, season, originalTitle) {
  let score = 0;
  const normalizedResult = resultTitle.toLowerCase();
  const normalizedOriginal = originalTitle.toLowerCase();

  // Exact title match
  if (normalizedResult.includes(normalizedOriginal)) {
    score += 50;
  }

  // Season match for TV shows
  if (season && normalizedResult.includes(`season ${season}`)) {
    score += 30;
  }

  // Prefer complete seasons over individual episodes
  if (normalizedResult.includes('complete') || normalizedResult.includes('full season')) {
    score += 20;
  }

  // Quality indicators
  if (normalizedResult.includes('2160p') || normalizedResult.includes('4k')) {
    score += 15;
  } else if (normalizedResult.includes('1080p')) {
    score += 10;
  } else if (normalizedResult.includes('720p')) {
    score += 5;
  }

  return score;
}

// --- Extract Download Links from Movie Page ---
async function extractMoviePageLinks(movieUrl) {
  console.log(`[MoviesDrive] Extracting links from movie page: ${movieUrl}`);

  try {
    const response = await makeRequest(movieUrl, { parseHTML: true });
    const $ = response.document;

    // Look for mdrive.today links
    const links = [];
    $('a[href*="mdrive.today"]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && href.includes('/archives/')) {
        const quality = $(elem).text().trim();
        links.push({
          url: href,
          quality: quality
        });
      }
    });

    console.log(`[MoviesDrive] Found ${links.length} mdrive.today links`);
    return links;
  } catch (error) {
    console.error(`[MoviesDrive] Failed to extract movie page links:`, error.message);
    return [];
  }
}

// --- Extract HubCloud Links from MDrive Page ---
async function extractMDriveLinks(mdriveUrl) {
  console.log(`[MoviesDrive] Extracting HubCloud links from: ${mdriveUrl}`);

  try {
    const response = await makeRequest(mdriveUrl, { parseHTML: true });
    const $ = response.document;

    const links = [];

    // Extract title and file info
    const title = $('h1.entry-title').text().trim() || $('title').text().trim();

    // Look for hubcloud links
    $('a[href*="hubcloud"]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && (href.includes('hubcloud.fit') || href.includes('hubcloud.one') || href.includes('hubcloud.club'))) {
        links.push({
          url: href,
          title: title
        });
      }
    });

    // Also look for gdflix links as alternative
    $('a[href*="gdflix"]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        links.push({
          url: href,
          title: title,
          type: 'gdflix'
        });
      }
    });

    console.log(`[MoviesDrive] Found ${links.length} hosting links`);
    return links;
  } catch (error) {
    console.error(`[MoviesDrive] Failed to extract MDrive links:`, error.message);
    return [];
  }
}

// --- Import HubCloud Extractor ---
import { extractHubCloudLinks } from './http-streams.js';

// --- Main Stream Function ---
async function getMoviesDriveStreams(imdbId, tmdbId, mediaType = 'movie', season = null, episode = null, config = {}) {
  console.log(`[MoviesDrive] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);

  // Create unique timer ID to prevent duplicates when concurrent requests for same content
  const requestId = Math.random().toString(36).substring(7);
  const cinemetaTimerId = `[MoviesDrive-${requestId}] Cinemeta lookup`;

  try {
    // Get Cinemeta info for search
    console.time(cinemetaTimerId);
    const cinemetaDetails = await Cinemeta.getMeta(mediaType, imdbId);
    try { console.timeEnd(cinemetaTimerId); } catch {}

    if (!cinemetaDetails) {
      throw new Error('Could not get Cinemeta details');
    }

    const mediaInfo = {
      title: cinemetaDetails.name,
      year: parseInt((cinemetaDetails.year || '').split('–')[0], 10)
    };

    if (!mediaInfo.title) {
      throw new Error('Could not extract title from Cinemeta');
    }

    console.log(`[MoviesDrive] Cinemeta Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);

    // Search for media
    let searchTitle = mediaInfo.title.replace(/:/g, '').replace(/\s*&\s*/g, ' and ');
    console.log(`[MoviesDrive] Search title: ${searchTitle}`);

    let searchResults = await searchMovies(searchTitle);

    // Try fallback search if no results
    if (searchResults.length === 0 || !searchResults.some(result => compareMedia(mediaInfo, result))) {
      console.log(`[MoviesDrive] Primary search failed. Trying fallback...`);
      let fallbackTitle = mediaInfo.title.split(':')[0].trim();
      if (fallbackTitle !== searchTitle) {
        searchResults = await searchMovies(fallbackTitle);
      }

      // Try second fallback: convert word numbers to digits
      // e.g., "Fantastic Four" -> "Fantastic 4"
      if (searchResults.length === 0 || !searchResults.some(result => compareMedia(mediaInfo, result))) {
        console.log(`[MoviesDrive] First fallback failed. Trying word-to-number conversion...`);
        const wordToNumber = {
          'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
          'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'
        };

        let numberTitle = fallbackTitle;
        Object.keys(wordToNumber).forEach(word => {
          const number = wordToNumber[word];
          // Replace word with number (case insensitive)
          numberTitle = numberTitle.replace(new RegExp(`\\b${word}\\b`, 'gi'), number);
        });

        if (numberTitle !== fallbackTitle) {
          console.log(`[MoviesDrive] Trying number-converted search: "${numberTitle}"`);
          searchResults = await searchMovies(numberTitle);
        }
      }
    }

    if (searchResults.length === 0) {
      console.log(`[MoviesDrive] No search results found`);
      return [];
    }

    // Find best match
    console.log(`[MoviesDrive] Search results:`, searchResults.map(r => `"${r.title}" (${r.year})`));
    const matchingResults = searchResults.filter(result => {
      const match = compareMedia(mediaInfo, result);
      console.log(`[MoviesDrive] Comparing "${mediaInfo.title}" (${mediaInfo.year}) with "${result.title}" (${result.year}): ${match ? 'MATCH' : 'NO MATCH'}`);
      return match;
    });

    if (matchingResults.length === 0) {
      console.log(`[MoviesDrive] No matching results found after comparison`);
      return [];
    }

    let matchingResult;
    if (matchingResults.length === 1) {
      matchingResult = matchingResults[0];
    } else {
      const scoredResults = matchingResults.map(result => ({
        ...result,
        score: scoreResult(result.title, mediaType === 'tv' ? season : null, mediaInfo.title)
      })).sort((a, b) => b.score - a.score);
      matchingResult = scoredResults[0];
      console.log(`[MoviesDrive] Best match: "${matchingResult.title}" (score: ${matchingResult.score})`);
    }

    // Extract movie page links
    const moviePageLinks = await extractMoviePageLinks(matchingResult.url);
    if (moviePageLinks.length === 0) {
      console.log(`[MoviesDrive] No download links found on movie page`);
      return [];
    }

    // Limit to first 5 quality variants to stay within timeout
    const limitedLinks = moviePageLinks.slice(0, 5);
    console.log(`[MoviesDrive] Processing ${limitedLinks.length} of ${moviePageLinks.length} quality variants (limited for performance)...`);

    const streamPromises = limitedLinks.map(async (link) => {
      try {
        const mdriveLinks = await extractMDriveLinks(link.url);

        // Process hubcloud links in parallel
        const hubcloudPromises = mdriveLinks
          .filter(mdriveLink => mdriveLink.type !== 'gdflix')
          .map(async (mdriveLink) => {
            try {
              const hubcloudStreams = await extractHubCloudLinks(mdriveLink.url, 'MoviesDrive');

              // Filter for ONLY PixelDrain and FSL servers
              const filteredStreams = hubcloudStreams.filter(stream => {
                const streamName = (stream.name || '').toLowerCase();
                const streamUrl = (stream.url || '').toLowerCase();

                const isPixelDrain = streamName.includes('pixelserver') ||
                                     streamName.includes('pixeldrain') ||
                                     streamUrl.includes('pixeldrain');
                const isFSL = streamName.includes('fsl server');

                const isExcluded = streamName.includes('10gbps') ||
                                  streamName.includes('s3 server') ||
                                  streamName.includes('buzzserver') ||
                                  streamName.includes('workers.dev') ||
                                  streamName.includes('hubcdn.fans');

                return !isExcluded && (isPixelDrain || isFSL);
              });

              // Format streams
              return filteredStreams.map(stream => {
                let rawTitle = stream.title || '';

                // Clean up title: remove all moviesdrives branding variations
                rawTitle = rawTitle
                  .replace(/\[\[moviesdrives?\.com\s*\]\]\s*/gi, '')  // Remove [[moviesdrives.com ]]
                  .replace(/^moviesdrives?\.co[-\s]*/gi, '')  // Remove Moviesdrives.co- at start
                  .replace(/[-\s]*\[moviesdrives?\.(?:co|com|eu|oc)\]\.mkv$/gi, '.mkv')  // Remove -[moviesdrives.co].mkv at end
                  .replace(/[-\s]*\[moviesdrives?\.(?:co|com|eu|oc)\]$/gi, '')  // Remove -[moviesdrives.co] at end
                  .replace(/[-\s]+moviesdrives?\.(?:co|com|eu|oc)\.mkv$/gi, '.mkv')  // Remove - moviesdrives.com.mkv at end
                  .replace(/[-\s]+moviesdrives?\.(?:co|com|eu|oc)$/gi, '')  // Remove - moviesdrives.com at end
                  .trim();

                // Extract resolution from cleaned title (must be done AFTER cleaning)
                const resolution = getResolutionFromName(rawTitle);

                let resolutionLabel = resolution === '2160p' ? '4k' : resolution;
                if (!['4k', '1080p', '720p', '480p'].includes(resolutionLabel)) {
                  resolutionLabel = 'other';
                }

                const languages = detectLanguagesFromTitle(rawTitle);
                const langFlags = renderLanguageFlags(languages);
                const size = stream.size || 'Unknown';

                // Convert PixelDrain URLs from /u/ID to /api/file/ID for direct download
                let finalUrl = stream.url;
                if (finalUrl && finalUrl.includes('pixeldrain')) {
                  const pixelMatch = finalUrl.match(/pixeldrain\.[^/]+\/u\/([a-zA-Z0-9]+)/);
                  if (pixelMatch) {
                    const fileId = pixelMatch[1];
                    finalUrl = `https://pixeldrain.dev/api/file/${fileId}`;
                    console.log(`[MoviesDrive] Converted PixelDrain URL: ${stream.url} -> ${finalUrl}`);
                  }
                }

                return {
                  name: `[HS+] Sootio\n${resolutionLabel}`,
                  title: `${rawTitle}${langFlags}\n💾 ${size} | MoviesDrive`,
                  url: finalUrl,
                  behaviorHints: {
                    bingeGroup: `moviesdrive-${imdbId}`,
                    notWebReady: true
                  }
                };
              });
            } catch (error) {
              console.error(`[MoviesDrive] HubCloud extraction failed:`, error.message);
              return [];
            }
          });

        const results = await Promise.all(hubcloudPromises);
        return results.flat();
      } catch (error) {
        console.error(`[MoviesDrive] MDrive link extraction failed:`, error.message);
        return [];
      }
    });

    const allStreamsNested = await Promise.all(streamPromises);
    const allStreams = allStreamsNested.flat();

    // Sort by resolution first (4K -> 1080p -> 720p -> 480p -> other), then by size within each resolution
    const parseSizeInBytes = (sizeStr) => {
      if (!sizeStr || sizeStr === 'Unknown') return 0;
      const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
      if (!match) return 0;

      const value = parseFloat(match[1]);
      const unit = match[2].toUpperCase();

      const multipliers = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
      return value * (multipliers[unit] || 0);
    };

    const resolutionOrder = { '4k': 1, '1080p': 2, '720p': 3, '480p': 4, 'other': 5 };

    allStreams.sort((a, b) => {
      // Extract resolution from name (format: "[HS+] Sootio\n{resolution}")
      const resA = a.name ? a.name.split('\n')[1] || 'other' : 'other';
      const resB = b.name ? b.name.split('\n')[1] || 'other' : 'other';

      const orderA = resolutionOrder[resA] || 5;
      const orderB = resolutionOrder[resB] || 5;

      // First sort by resolution
      if (orderA !== orderB) {
        return orderA - orderB;
      }

      // Within same resolution, sort by size (big to small)
      const sizeA = a.title ? a.title.match(/💾\s*([^|]+)/)?.[1]?.trim() : '';
      const sizeB = b.title ? b.title.match(/💾\s*([^|]+)/)?.[1]?.trim() : '';
      return parseSizeInBytes(sizeB) - parseSizeInBytes(sizeA); // Descending order (big to small)
    });

    console.log(`[MoviesDrive] Returning ${allStreams.length} streams (sorted by resolution, then size)`);

    // Debug: Log first stream object structure
    if (allStreams.length > 0) {
      console.log(`[MoviesDrive] Sample stream object:`, JSON.stringify(allStreams[0], null, 2));
    }

    return allStreams;

  } catch (error) {
    console.error(`[MoviesDrive] Error:`, error.message);
    return [];
  }
}

export { getMoviesDriveStreams };
