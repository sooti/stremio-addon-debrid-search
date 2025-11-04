import axios from 'axios';
import * as cheerio from 'cheerio';
import { URLSearchParams, URL } from 'url';
import FormData from 'form-data';
import { CookieJar } from 'tough-cookie';
import * as SqliteCache from './util/sqlite-cache.js';
import { followRedirectToFilePage, extractFinalDownloadFromFilePage, resolveSidToRedirect, defaultTryInstantDownload, defaultTryResumeCloud } from './util/linkResolver.js';
import path from 'path';
import { fileURLToPath } from 'url';

import { getResolutionFromName, formatSize } from './common/torrent-utils.js';
import { STREAM_NAME_MAP } from './stream-provider.js';
import Cinemeta from './util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle, filterStreamsByLanguage } from './util/language-mapping.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic import for axios-cookiejar-support
let axiosCookieJarSupport = null;
const getAxiosCookieJarSupport = async () => {
  if (!axiosCookieJarSupport) {
    axiosCookieJarSupport = await import('axios-cookiejar-support');
  }
  return axiosCookieJarSupport;
};

// Function to encode URLs for streaming, being careful not to over-encode existing encoded URLs
function encodeUrlForStreaming(url) {
  if (!url) return url;
  
  // Don't re-encode already encoded URLs
  if (url.includes('%')) {
    // If it's already partially encoded, return as-is to avoid double encoding
    return url;
  }
  
  // For URLs with special characters that need encoding
  try {
    // Use URL constructor to handle the encoding properly 
    const urlObj = new URL(url);
    // The URL constructor already handles proper encoding
    return urlObj.toString();
  } catch (e) {
    // If URL is malformed, do selective encoding
    return url
      .replace(/ /g, '%20')  // Encode spaces
      .replace(/#/g, '%23')  // Encode hash (fragment identifier)
      .replace(/\[/g, '%5B') // Encode brackets
      .replace(/\]/g, '%5D')
      .replace(/{/g, '%7B') // Encode braces
      .replace(/}/g, '%7D');
  }
}

// DEPRECATED: Old language functions - now using centralized language-mapping.js
// Kept for reference only - functions are now imported from language-mapping.js

// --- Proxy Configuration ---
const UHDMOVIES_PROXY_URL = process.env.UHDMOVIES_PROXY_URL;
if (UHDMOVIES_PROXY_URL) {
  console.log(`[UHDMovies] Proxy support enabled: ${UHDMOVIES_PROXY_URL}`);
} else {
  console.log('[UHDMovies] No proxy configured, using direct connections');
}

// --- Domain Fetching ---
let uhdMoviesDomain = 'https://uhdmovies.rip'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = parseInt(process.env.UHDMOVIES_DOMAIN_CACHE_TTL) || 1 * 60 * 1000; // Configurable TTL in ms (default 1 minute)

async function getUHDMoviesDomain() {
  const now = Date.now();
  if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
    return uhdMoviesDomain;
  }

  // Default timeout configuration for domain fetching
  const DEFAULT_TIMEOUT = parseInt(process.env.UHDMOVIES_DOMAIN_TIMEOUT) || 10000; // 10 seconds default
  const MAX_RETRIES = parseInt(process.env.UHDMOVIES_DOMAIN_MAX_RETRIES) || 2; // 2 retries by default
  const RETRY_DELAY = parseInt(process.env.UHDMOVIES_DOMAIN_RETRY_DELAY) || 1000; // 1 second delay
  
  let lastError;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[UHDMovies] Fetching latest domain (attempt ${attempt + 1})...`);
      const response = await makeRequest('https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json', { timeout: DEFAULT_TIMEOUT });
      if (response && response.data && response.data.UHDMovies) {
        uhdMoviesDomain = response.data.UHDMovies;
        domainCacheTimestamp = Date.now();
        console.log(`[UHDMovies] Updated domain to: ${uhdMoviesDomain}`);
        return uhdMoviesDomain;
      } else {
        console.warn('[UHDMovies] Domain JSON fetched, but "UHDMovies" key was not found. Using fallback.');
        break; // Don't retry if the key is missing, just use fallback
      }
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        console.log(`[UHDMovies] Domain fetch attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY}ms... Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
    }
  }
  
  console.error(`[UHDMovies] Failed to fetch latest domain after ${MAX_RETRIES + 1} attempts, using fallback. Last error: ${lastError?.message}`);
  return uhdMoviesDomain;
}

// Constants

// --- Caching Configuration ---
// NOTE: UHDMovies results are cached via SQLite in stream-provider.js using getCachedTorrents()
// This provides:
// - Cache-first behavior: Returns cached results immediately to user
// - Background refresh: Always refreshes http-streams in background (URLs can expire)
// - Cross-worker sharing: All workers share the same SQLite cache
// - Consistent TTL: 360 minutes for movies, 60 minutes for series
console.log(`[UHDMovies] Caching is handled by SQLite via stream-provider.js`);

// Configure axios with headers to mimic a browser
// Configure axios instance with optional proxy support
const createAxiosInstance = () => {
  // Default timeout configuration
  const DEFAULT_TIMEOUT = parseInt(process.env.UHDMOVIES_REQUEST_TIMEOUT) || 60000; // 60 seconds default
  const MAX_RETRIES = parseInt(process.env.UHDMOVIES_REQUEST_MAX_RETRIES) || 2; // 2 retries by default
  const RETRY_DELAY = parseInt(process.env.UHDMOVIES_REQUEST_RETRY_DELAY) || 1000; // 1 second delay
  
  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0'
    },
    timeout: DEFAULT_TIMEOUT
  };

  // Add proxy configuration if UHDMOVIES_PROXY_URL is set
  if (UHDMOVIES_PROXY_URL) {
    console.log(`[UHDMovies] Using proxy: ${UHDMOVIES_PROXY_URL}`);
    // For proxy URLs that expect the destination URL as a parameter
    config.transformRequest = [(data, headers) => {
      return data;
    }];
  }

  return axios.create(config);
};

const axiosInstance = createAxiosInstance();

// Proxy wrapper function with retry mechanism
const makeRequest = async (url, options = {}) => {
  // Default timeout configuration
  const DEFAULT_TIMEOUT = parseInt(process.env.UHDMOVIES_REQUEST_TIMEOUT) || 60000; // 60 seconds default
  const MAX_RETRIES = parseInt(process.env.UHDMOVIES_REQUEST_MAX_RETRIES) || 2; // 2 retries by default
  const RETRY_DELAY = parseInt(process.env.UHDMOVIES_REQUEST_RETRY_DELAY) || 1000; // 1 second delay
  
  let lastError;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (UHDMOVIES_PROXY_URL) {
        // Route through proxy
        const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
        console.log(`[UHDMovies] Making proxied request to: ${url} (attempt ${attempt + 1})`);
        return await axiosInstance.get(proxiedUrl, { 
          ...options, 
          timeout: DEFAULT_TIMEOUT 
        });
      } else {
        // Direct request
        console.log(`[UHDMovies] Making direct request to: ${url} (attempt ${attempt + 1})`);
        return await axiosInstance.get(url, { 
          ...options, 
          timeout: DEFAULT_TIMEOUT 
        });
      }
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        console.log(`[UHDMovies] Request attempt ${attempt + 1} failed for ${url}, retrying in ${RETRY_DELAY}ms... Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
    }
  }
  
  // If we exhausted all retries, throw the last error
  throw lastError;
};

// Simple In-Memory Cache
const uhdMoviesCache = {
  search: {},
  movie: {},
  show: {}
};

// Function to search for movies
async function searchMovies(query) {
  try {
    const baseUrl = await getUHDMoviesDomain();
    console.log(`[UHDMovies] Searching for: ${query}`);
    const searchUrl = `${baseUrl}/search/${encodeURIComponent(query)}`;

    // Multiple search strategies to get more results
    const searchStrategies = [
      { query: query, name: 'primary' },
      { query: query.split(' ').slice(0, 3).join(' '), name: 'first-three-words' },
      { query: query.replace(/(20[0-9]{2}|19[0-9]{2})/, '').trim(), name: 'no-year' }, // Remove year pattern
      { query: query.replace(/:.*$/, '').trim(), name: 'no-subtitle' } // Remove after colon
    ];
    
    // Remove duplicate queries and filter empty ones
    const uniqueStrategies = [];
    const seenQueries = new Set();
    for (const strategy of searchStrategies) {
      const cleanQuery = strategy.query.trim().toLowerCase();
      if (cleanQuery && !seenQueries.has(cleanQuery)) {
        seenQueries.add(cleanQuery);
        uniqueStrategies.push(strategy);
      }
    }
    
    let allResults = [];
    for (const strategy of uniqueStrategies) {
      try {
        const strategySearchUrl = `${baseUrl}/search/${encodeURIComponent(strategy.query)}`;
        console.log(`[UHDMovies] Searching with ${strategy.name} query: "${strategy.query}"`);
        
        const response = await makeRequest(strategySearchUrl);
        const $ = cheerio.load(response.data);

        const strategyResults = [];

        // New logic for grid-based search results
        $('article.gridlove-post').each((index, element) => {
          const linkElement = $(element).find('a[href*="/download-"]');
          if (linkElement.length > 0) {
            const link = linkElement.first().attr('href');
            // Prefer the 'title' attribute, fallback to h1 text
            const title = linkElement.first().attr('title') || $(element).find('h1.sanket').text().trim();

            if (link && title && !strategyResults.some(item => item.link === link)) {
              strategyResults.push({
                title,
                link: link.startsWith('http') ? link : `${baseUrl}${link}`
              });
            }
          }
        });

        // Fallback for original list-based search if new logic fails
        if (strategyResults.length === 0) {
          console.log('[UHDMovies] Grid search logic found no results, trying original list-based logic...');
          $('a[href*="/download-"]').each((index, element) => {
            const link = $(element).attr('href');
            // Avoid duplicates by checking if link already exists in results
            if (link && !strategyResults.some(item => item.link === link)) {
              const title = $(element).text().trim();
              if (title) {
                strategyResults.push({
                  title,
                  link: link.startsWith('http') ? link : `${baseUrl}${link}`
                });
              }
            }
          });
        }

        console.log(`[UHDMovies] Found ${strategyResults.length} results with ${strategy.name} strategy`);
        allResults = allResults.concat(strategyResults);
        
        // If primary search was successful with good results, we might not need others
        if (strategy.name === 'primary' && strategyResults.length > 2) {
          break; // Early exit if primary search was successful
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (strategyError) {
        console.log(`[UHDMovies] Search strategy ${strategy.name} failed:`, strategyError.message);
        continue; // Continue with next strategy
      }
    }

    // Remove duplicate results based on link
    const uniqueResults = [];
    const seenLinks = new Set();
    for (const result of allResults) {
      if (!seenLinks.has(result.link)) {
        seenLinks.add(result.link);
        uniqueResults.push(result);
      }
    }

    console.log(`[UHDMovies] Total unique results from all strategies: ${uniqueResults.length}`);
    return uniqueResults;
  } catch (error) {
    console.error(`[UHDMovies] Error searching movies: ${error.message}`);
    return [];
  }
}

// Function to extract clean quality information from verbose text
function extractCleanQuality(fullQualityText) {
  if (!fullQualityText || fullQualityText === 'Unknown Quality') {
    return 'Unknown Quality';
  }

  const cleanedFullQualityText = fullQualityText.replace(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g, '').trim();
  const text = cleanedFullQualityText.toLowerCase();
  let quality = [];

  // Extract resolution
  if (text.includes('2160p') || text.includes('4k')) {
    quality.push('4K');
  } else if (text.includes('1080p')) {
    quality.push('1080p');
  } else if (text.includes('720p')) {
    quality.push('720p');
  } else if (text.includes('480p')) {
    quality.push('480p');
  }

  // Extract special features
  if (text.includes('hdr')) {
    quality.push('HDR');
  }
  if (text.includes('dolby vision') || text.includes('dovi') || /\bdv\b/.test(text)) {
    quality.push('DV');
  }
  if (text.includes('imax')) {
    quality.push('IMAX');
  }
  if (text.includes('bluray') || text.includes('blu-ray')) {
    quality.push('BluRay');
  }

  // If we found any quality indicators, join them
  if (quality.length > 0) {
    return quality.join(' | ');
  }

  // Fallback: try to extract a shorter version of the original text
  // Look for patterns like "Movie Name (Year) Resolution ..."
  const patterns = [
    /(\d{3,4}p.*?(?:x264|x265|hevc).*?)[[\(]/i,
    /(\d{3,4}p.*?)[[\(]/i,
    /((?:720p|1080p|2160p|4k).*?)$/i
  ];

  for (const pattern of patterns) {
    const match = cleanedFullQualityText.match(pattern);
    if (match && match[1].trim().length < 100) {
      return match[1].trim().replace(/x265/ig, 'HEVC');
    }
  }

  // Final fallback: truncate if too long
  if (cleanedFullQualityText.length > 80) {
    return cleanedFullQualityText.substring(0, 77).replace(/x265/ig, 'HEVC') + '...';
  }

  return cleanedFullQualityText.replace(/x265/ig, 'HEVC');
}

// Function to extract language information from quality header text
function extractLanguageInfoFromHeader(qualityHeaderText) {
  if (!qualityHeaderText || typeof qualityHeaderText !== 'string') {
    return [];
  }

  const text = qualityHeaderText.toLowerCase();
  const languages = [];

  // Common language indicators in torrent/stream titles
  const languagePatterns = [
    { pattern: /\b(hindi|हिंदी)\b/i, language: 'hindi' },
    { pattern: /\b(tamil|தமிழ்)\b/i, language: 'tamil' },
    { pattern: /\b(telugu|తెలుగు)\b/i, language: 'telugu' },
    { pattern: /\b(malayalam|മലയാളം)\b/i, language: 'malayalam' },
    { pattern: /\b(kannada|ಕನ್ನಡ)\b/i, language: 'kannada' },
    { pattern: /\b(bengali|বাংলা)\b/i, language: 'bengali' },
    { pattern: /\b(marathi|मराठी)\b/i, language: 'marathi' },
    { pattern: /\b(punjabi|ਪੰਜਾਬੀ)\b/i, language: 'punjabi' },
    { pattern: /\b(gujarati|ગુજરાતી)\b/i, language: 'gujarati' },
    { pattern: /\b(urdu|اُردُو)\b/i, language: 'urdu' },
    { pattern: /\b(english|eng|en)\b/i, language: 'english' },
    { pattern: /\b(spanish|español|esp)\b/i, language: 'spanish' },
    { pattern: /\b(french|français|fre|fr)\b/i, language: 'french' },
    { pattern: /\b(german|deutsch|ger|de)\b/i, language: 'german' },
    { pattern: /\b(italian|italiano|ita|it)\b/i, language: 'italian' },
    { pattern: /\b(portuguese|português|por|pt)\b/i, language: 'portuguese' },
    { pattern: /\b(chinese|中文|chi|zh)\b/i, language: 'chinese' },
    { pattern: /\b(japanese|日本語|jpn|ja)\b/i, language: 'japanese' },
    { pattern: /\b(korean|한국어|kor|ko)\b/i, language: 'korean' },
    { pattern: /\b(russian|русский|rus|ru)\b/i, language: 'russian' },
    { pattern: /\b(arabic|العربية|ara|ar)\b/i, language: 'arabic' },
    { pattern: /\b(dubbed|dub)\b/i, language: 'dubbed' },
    { pattern: /\b(subbed|subtitles|subs)\b/i, language: 'subbed' },
    { pattern: /\b(dual[-\s]audio)\b/i, language: 'dual audio' },
    { pattern: /\b(multi[-\s]audio)\b/i, language: 'multi audio' }
  ];

  // Check for language patterns in the text
  for (const { pattern, language } of languagePatterns) {
    if (pattern.test(text)) {
      languages.push(language);
    }
  }

  // Special handling for multi-language indicators
  if (/\b(multi|multi[-\s]lang|multi[-\s]language)\b/i.test(text)) {
    languages.push('multi');
  }

  // Remove duplicates and return
  return [...new Set(languages)];
}

// Function to extract download links for TV shows from a page
async function extractTvShowDownloadLinks(showPageUrl, season, episode) {
  try {
    console.log(`[UHDMovies] Extracting TV show links from: ${showPageUrl} for S${season}E${episode}`);
    const response = await makeRequest(showPageUrl);
    const $ = cheerio.load(response.data);

    const showTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // --- NEW LOGIC TO SCOPE SEARCH TO THE CORRECT SEASON ---
    let inTargetSeason = false;
    let qualityText = '';

    $('.entry-content').find('*').each((index, element) => {
      const $el = $(element);
      const text = $el.text().trim();
      const seasonMatch = text.match(/^SEASON\s+(\d+)/i);

      // Check if we are entering a new season block
      if (seasonMatch) {
        const currentSeasonNum = parseInt(seasonMatch[1], 10);
        if (currentSeasonNum == season) {
          inTargetSeason = true;
          console.log(`[UHDMovies] Entering Season ${season} block.`);
        } else if (inTargetSeason) {
          // We've hit the next season, so we stop.
          console.log(`[UHDMovies] Exiting Season ${season} block, now in Season ${currentSeasonNum}.`);
          inTargetSeason = false;
          return false; // Exit .each() loop
        }
      }

      if (inTargetSeason) {
        // This element is within the correct season's block.

        // Is this a quality header? (e.g., a <pre> or a <p> with <strong>)
        // It often contains resolution, release group, etc.
        const isQualityHeader = $el.is('pre, p:has(strong), p:has(b), h3, h4');
        if (isQualityHeader) {
          const headerText = $el.text().trim();
          // Filter out irrelevant headers. We can be more aggressive here.
          if (headerText.length > 5 && !/plot|download|screenshot|trailer|join|powered by|season/i.test(headerText) && !($el.find('a').length > 0)) {
            qualityText = headerText; // Store the most recent quality header
          }
        }

        // Is this a paragraph with episode links?
        if ($el.is('p') && $el.find('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"]').length > 0) {
          const linksParagraph = $el;
          const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');
          const targetEpisodeLink = linksParagraph.find('a').filter((i, el) => {
            return episodeRegex.test($(el).text().trim());
          }).first();

          if (targetEpisodeLink.length > 0) {
            const link = targetEpisodeLink.attr('href');
            if (link && !downloadLinks.some(item => item.link === link)) {
              const sizeMatch = qualityText.match(/[[\]\s]*([0-9.,]+\s*[KMGT]B)/i);
              const size = sizeMatch ? sizeMatch[1] : 'Unknown';

              const cleanQuality = extractCleanQuality(qualityText);
              const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();
              
              // Extract language information from quality header text
              const languageInfo = extractLanguageInfoFromHeader(qualityText);

              console.log(`[UHDMovies] Found match: Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
            }
          }
        }
        
        // --- ENHANCED: Check for maxbutton-gdrive-episode structure ---
        if ($el.is('p') && $el.find('a.maxbutton-gdrive-episode').length > 0) {
          const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');
          const targetEpisodeLink = $el.find('a.maxbutton-gdrive-episode').filter((i, el) => {
            const episodeText = $(el).find('.mb-text').text().trim();
            return episodeRegex.test(episodeText);
          }).first();

          if (targetEpisodeLink.length > 0) {
            const link = targetEpisodeLink.attr('href');
            if (link && !downloadLinks.some(item => item.link === link)) {
              const sizeMatch = qualityText.match(/[[\]\s]*([0-9.,]+\s*[KMGT]B)/i);
              const size = sizeMatch ? sizeMatch[1] : 'Unknown';

              const cleanQuality = extractCleanQuality(qualityText);
              const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();
              
              // Extract language information from quality header text
              const languageInfo = extractLanguageInfoFromHeader(qualityText);

              console.log(`[UHDMovies] Found match (maxbutton): Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
            }
          }
        }
      }
    });

    if (downloadLinks.length === 0) {
      console.log('[UHDMovies] Main extraction logic failed. Checking if requested season exists on page before fallback.');
      
      // Check if the requested season exists on the page at all
      let seasonExists = false;
      let actualSeasonsOnPage = new Set(); // Track what seasons actually have content
      
      // First pass: Look for actual episode content to see what seasons are available
      $('.entry-content').find('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"], a.maxbutton-gdrive-episode').each((index, element) => {
        const $el = $(element);
        const linkText = $el.text().trim();
        const episodeText = $el.find('.mb-text').text().trim() || linkText;
        
        // Look for season indicators in episode links
        const seasonMatches = [
          episodeText.match(/S(\d{1,2})/i), // S01, S02, etc.
          episodeText.match(/Season\s+(\d+)/i), // Season 1, Season 2, etc.
          episodeText.match(/S(\d{1,2})E(\d{1,3})/i) // S01E01 format
        ];
        
        for (const match of seasonMatches) {
          if (match && match[1]) {
            const foundSeason = parseInt(match[1], 10);
            actualSeasonsOnPage.add(foundSeason);
          }
        }
      });
      
      console.log(`[UHDMovies] Actual seasons found on page: ${Array.from(actualSeasonsOnPage).sort((a,b) => a-b).join(', ')}`);
      
      // Check if requested season is in the actual content
      if (actualSeasonsOnPage.has(season)) {
        seasonExists = true;
        console.log(`[UHDMovies] Season ${season} confirmed to exist in actual episode content`);
      } else {
        // Fallback: Check page descriptions/titles for season mentions
        $('.entry-content').find('*').each((index, element) => {
          const $el = $(element);
          const text = $el.text().trim();
          // Match various season formats: "SEASON 2", "Season 2", "(Season 1 – 2)", "Season 1-2", etc.
          const seasonMatches = [
            text.match(/^SEASON\s+(\d+)/i),
            text.match(/\bSeason\s+(\d+)/i),
            text.match(/\(Season\s+\d+\s*[–-]\s*(\d+)\)/i), // Matches "(Season 1 – 2)"
            text.match(/Season\s+\d+\s*[–-]\s*(\d+)/i), // Matches "Season 1-2"
            text.match(/\bS(\d+)/i) // Matches "S2", "S02", etc.
          ];
          
          for (const match of seasonMatches) {
            if (match) {
              const currentSeasonNum = parseInt(match[1], 10);
              if (currentSeasonNum == season) {
                seasonExists = true;
                console.log(`[UHDMovies] Season ${season} found in page description: "${text.substring(0, 100)}..."`);
                return false; // Exit .each() loop
              }
              // For range formats like "Season 1 – 2", check if requested season is in range
              if (match[0].includes('–') || match[0].includes('-')) {
                const rangeMatch = match[0].match(/Season\s+(\d+)\s*[–-]\s*(\d+)/i);
                if (rangeMatch) {
                  const startSeason = parseInt(rangeMatch[1], 10);
                  const endSeason = parseInt(rangeMatch[2], 10);
                  if (season >= startSeason && season <= endSeason) {
                    seasonExists = true;
                    console.log(`[UHDMovies] Season ${season} found in range ${startSeason}-${endSeason} in page description`);
                    return false; // Exit .each() loop
                  }
                }
              }
            }
          }
        });
      }
      
      if (!seasonExists) {
        console.log(`[UHDMovies] Season ${season} not found on page. Available seasons may not include the requested season.`);
        // Don't use fallback if the season doesn't exist to avoid wrong episodes
        return { title: showTitle, links: [], seasonNotFound: true };
      }
      
      console.log(`[UHDMovies] Season ${season} exists on page but episode extraction failed. Trying fallback method with season filtering.`);
      
      // --- ENHANCED FALLBACK LOGIC FOR NEW HTML STRUCTURE ---
      // Try the new maxbutton-gdrive-episode structure first
      $('.entry-content').find('a.maxbutton-gdrive-episode').each((i, el) => {
        const linkElement = $(el);
        const episodeText = linkElement.find('.mb-text').text().trim();
        const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');

        if (episodeRegex.test(episodeText)) {
          const link = linkElement.attr('href');
          if (link && !downloadLinks.some(item => item.link === link)) {
            let qualityText = 'Unknown Quality';
            
            // Look for quality info in the preceding paragraph or heading
            const parentP = linkElement.closest('p, div');
            const prevElement = parentP.prev();
            if (prevElement.length > 0) {
              const prevText = prevElement.text().trim();
              if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
                qualityText = prevText;
              }
            }

            // Check if this episode belongs to the correct season
            // Enhanced season check - look for various season formats
            const seasonCheckRegexes = [
              new RegExp(`\.S0*${season}[\.]`, 'i'),  // .S01.
              new RegExp(`S0*${season}[\.]`, 'i'),     // S01.
              new RegExp(`S0*${season}\b`, 'i'),       // S01 (word boundary)
              new RegExp(`Season\s+0*${season}\b`, 'i'), // Season 1
              new RegExp(`S0*${season}`, 'i')           // S01 anywhere
            ];
            
            const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
            if (!seasonMatch) {
              console.log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
              return; // Skip this episode as it's from a different season
            }

            const sizeMatch = qualityText.match(/[[\]]([0-9.,]+[KMGT]B[^`\]]*)[[\]]/i);
            const size = sizeMatch ? sizeMatch[1] : 'Unknown';
            const cleanQuality = extractCleanQuality(qualityText);
            const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();
            
            // Extract language information from quality header text
            const languageInfo = extractLanguageInfoFromHeader(qualityText);

            console.log(`[UHDMovies] Found match via enhanced fallback (maxbutton): Quality='${qualityText}', Link='${link}'`);
            downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
          }
        }
      });
      
      // If still no results, try the original fallback logic
      if (downloadLinks.length === 0) {
        console.log(`[UHDMovies] Enhanced fallback failed, trying original fallback logic.`);
        $('.entry-content').find('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"]').each((i, el) => {
          const linkElement = $(el);
          const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');

          if (episodeRegex.test(linkElement.text().trim())) {
            const link = linkElement.attr('href');
            if (link && !downloadLinks.some(item => item.link === link)) {
              let qualityText = 'Unknown Quality';
              const parentP = linkElement.closest('p, div');
              const prevElement = parentP.prev();
              if (prevElement.length > 0) {
                const prevText = prevElement.text().trim();
                if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
                  qualityText = prevText;
                }
              }

              // Check if this episode belongs to the correct season
              // Enhanced season check - look for various season formats
              const seasonCheckRegexes = [
                new RegExp(`\.S0*${season}[\.]`, 'i'),  // .S01.
                new RegExp(`S0*${season}[\.]`, 'i'),     // S01.
                new RegExp(`S0*${season}\b`, 'i'),       // S01 (word boundary)
                new RegExp(`Season\s+0*${season}\b`, 'i'), // Season 1
                new RegExp(`S0*${season}`, 'i')           // S01 anywhere
              ];
              
              const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
              if (!seasonMatch) {
                console.log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
                return; // Skip this episode as it's from a different season
              }

              const sizeMatch = qualityText.match(/[[\]]([0-9.,]+[KMGT]B[^`\]]*)[[\]]/i);
              const size = sizeMatch ? sizeMatch[1] : 'Unknown';
              const cleanQuality = extractCleanQuality(qualityText);
              const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();
              
              // Extract language information from quality header text
              const languageInfo = extractLanguageInfoFromHeader(qualityText);

              console.log(`[UHDMovies] Found match via original fallback: Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
            }
          }
        });
      }
    }

    if (downloadLinks.length > 0) {
      console.log(`[UHDMovies] Found ${downloadLinks.length} links for S${season}E${episode}.`);
    } else {
      console.log(`[UHDMovies] Could not find links for S${season}E${episode}. It's possible the logic needs adjustment or the links aren't on the page.`);
    }

    return { title: showTitle, links: downloadLinks };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting TV show download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}

// Function to extract download links from a movie page
async function extractDownloadLinks(moviePageUrl, targetYear = null) {
  try {
    console.log(`[UHDMovies] Extracting links from: ${moviePageUrl}`);
    const response = await makeRequest(moviePageUrl);
    const $ = cheerio.load(response.data);

    const movieTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // Find all download links (the new SID links) and their associated quality information
    $('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"]').each((index, element) => {
      const link = $(element).attr('href');

      if (link && !downloadLinks.some(item => item.link === link)) {
        let quality = 'Unknown Quality';
        let size = 'Unknown';

        // Method 1: Look for quality in the closest preceding paragraph or heading
        const prevElement = $(element).closest('p').prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 20 && !prevText.includes('Download')) {
            quality = prevText;
          }
        }

        // Method 2: Look for quality in parent's siblings
        if (quality === 'Unknown Quality') {
          const parentSiblings = $(element).parent().prevAll().first().text().trim();
          if (parentSiblings && parentSiblings.length > 20) {
            quality = parentSiblings;
          }
        }

        // Method 3: Look for bold/strong text above the link
        if (quality === 'Unknown Quality') {
          const strongText = $(element).closest('p').prevAll().find('strong, b').last().text().trim();
          if (strongText && strongText.length > 20) {
            quality = strongText;
          }
        }

        // Method 4: Look for the entire paragraph containing quality info
        if (quality === 'Unknown Quality') {
          let currentElement = $(element).parent();
          for (let i = 0; i < 5; i++) {
            currentElement = currentElement.prev();
            if (currentElement.length === 0) break;

            const text = currentElement.text().trim();
            if (text && text.length > 30 &&
              (text.includes('1080p') || text.includes('720p') || text.includes('2160p') ||
                text.includes('4K') || text.includes('HEVC') || text.includes('x264') || text.includes('x265'))) {
              quality = text;
              break;
            }
          }
        }

        // Year-based filtering for collections
        if (targetYear && quality !== 'Unknown Quality') {
          // Check for years in quality text
          const yearMatches = quality.match(/(\d{4})/g);
          let hasMatchingYear = false;

          if (yearMatches && yearMatches.length > 0) {
            for (const yearMatch of yearMatches) {
              const year = parseInt(yearMatch.replace(/[()]/g, ''));
              if (year === targetYear) {
                hasMatchingYear = true;
                break;
              }
            }
            if (!hasMatchingYear) {
              console.log(`[UHDMovies] Skipping link due to year mismatch. Target: ${targetYear}, Found: ${yearMatches.join(', ')} in "${quality}"`);
              return; // Skip this link
            }
          } else {
            // If no year in quality text, check filename and other indicators
            const linkText = $(element).text().trim();
            const parentText = $(element).parent().text().trim();
            const combinedText = `${quality} ${linkText} ${parentText}`;

            // Look for years in combined text
            const allYearMatches = combinedText.match(/(\d{4})/g);
            if (allYearMatches) {
              let foundTargetYear = false;
              for (const yearMatch of allYearMatches) {
                const year = parseInt(yearMatch.replace(/[()]/g, ''));
                if (year >= 1900 && year <= 2030) { // Valid movie year range
                  if (year === targetYear) {
                    foundTargetYear = true;
                    break;
                  }
                }
              }
              if (!foundTargetYear && allYearMatches.length > 0) {
                console.log(`[UHDMovies] Skipping link due to no matching year found. Target: ${targetYear}, Found years: ${allYearMatches.join(', ')} in combined text`);
                return; // Skip this link
              }
            }

            // Additional check: if quality contains movie names that don't match target year
            const lowerQuality = quality.toLowerCase();
            if (targetYear === 2015) {
              if (lowerQuality.includes('wasp') || lowerQuality.includes('quantumania')) {
                console.log(`[UHDMovies] Skipping link for 2015 target as it contains 'wasp' or 'quantumania': "${quality}"`);
                return; // Skip this link
              }
            }
          }
        }

        // Extract size from quality text if present
        const sizeMatch = quality.match(/[[\]]([0-9.,]+\s*[KMGT]B[^`\]]*)[[\]]/);
        if (sizeMatch) {
          size = sizeMatch[1];
        }

        // Clean up the quality information
        const cleanQuality = extractCleanQuality(quality);

        downloadLinks.push({
          quality: cleanQuality,
          size: size,
          link: link,
          rawQuality: quality.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim(),
          languageInfo: extractLanguageInfoFromHeader(quality)
        });
      }
    });

    return {
      title: movieTitle,
      links: downloadLinks
    };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}

function extractCodecs(rawQuality) {
  const codecs = [];
  const text = rawQuality.toLowerCase();

  if (text.includes('hevc') || text.includes('x265')) {
    codecs.push('H.265');
  } else if (text.includes('x264')) {
    codecs.push('H.264');
  }

  if (text.includes('10bit') || text.includes('10-bit')) {
    codecs.push('10-bit');
  }

  if (text.includes('atmos')) {
    codecs.push('Atmos');
  } else if (text.includes('dts-hd')) {
    codecs.push('DTS-HD');
  } else if (text.includes('dts')) {
    codecs.push('DTS');
  } else if (text.includes('ddp5.1') || text.includes('dd+ 5.1') || text.includes('eac3')) {
    codecs.push('EAC3');
  } else if (text.includes('ac3')) {
    codecs.push('AC3');
  }

  if (text.includes('dovi') || text.includes('dolby vision') || /\bdv\b/.test(text)) {
    codecs.push('DV');
  } else if (text.includes('hdr')) {
    codecs.push('HDR');
  }

  return codecs;
}

// Function to try Instant Download method
async function tryInstantDownload($, pageOrigin = null) {
  // Look for "Instant Download" text or btn-danger class (new pattern for DriveSeed)
  const allInstantLinks = $('a:contains("Instant Download"), a:contains("Instant"), a.btn-danger:contains("Download")');
  console.log(`[UHDMovies] tryInstantDownload: found ${allInstantLinks.length} matching anchor(s).`);
  
  // First try to find direct links that don't require API calls (like video-leech.pro)
  let directLink = $('a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"]').attr('href');
  if (directLink) {
    console.log(`[UHDMovies] Found video-leech.pro link, attempting to extract Google URL: ${directLink}`);
    // Process video-leech links to extract the actual Google URL
    try {
      // Make a request to follow redirect and get the final page content
      const response = await makeRequest(directLink, {
        maxRedirects: 5,  // Allow redirects to reach the final page
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      });

      // If the final URL contains ?url= parameter, extract it
      if (response && response.request && response.request.res && response.request.res.responseUrl) {
        const finalRedirectedUrl = response.request.res.responseUrl;
        if (finalRedirectedUrl.includes('video-seed.pro') && finalRedirectedUrl.includes('?url=')) {
          try {
            const urlObj = new URL(finalRedirectedUrl);
            const urlParam = urlObj.searchParams.get('url');
            if (urlParam && urlParam.includes('googleusercontent.com')) {
              console.log(`[UHDMovies] Extracted Google URL from redirected video-seed.pro parameter: ${urlParam}`);
              return urlParam;
            }
          } catch (urlParseError) {
            console.log(`[UHDMovies] URL parsing failed for redirected video-seed.pro: ${urlParseError.message}`);
          }
        }
      }

      // If we got HTML content, try to extract the Google URL from the page
      if (response && response.data) {
        const html = response.data;
        // Look for the download button with Google URL in the HTML
        const downloadButtonMatch = html.match(/id=["']downloadBtn["'][^>]*href=["']([^"']*)["']/i);
        if (downloadButtonMatch && downloadButtonMatch[1]) {
          const extractedUrl = downloadButtonMatch[1];
          if (extractedUrl.includes('googleusercontent.com')) {
            console.log(`[UHDMovies] Successfully extracted Google URL from video-seed page: ${extractedUrl}`);
            return extractedUrl;
          }
        }

        // Alternative: Look for any Google URL in the HTML
        const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
        if (googleUrlMatch) {
          console.log(`[UHDMovies] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
          return googleUrlMatch[0];
        }
      }
    } catch (resolveError) {
      console.log(`[UHDMovies] Video-leech resolution failed: ${resolveError.message}`);
      // Continue with normal processing
    }
  }
  
  // Check if the pageOrigin URL has a 'url' parameter (like VideoSeed)
  if (pageOrigin) {
    try {
      const urlObj = new URL(pageOrigin);
      const urlParam = urlObj.searchParams.get('url');
      if (urlParam) {
        // Check if it's a valid direct download link like in VideoSeed
        if (urlParam.includes('googleusercontent.com') || urlParam.includes('workers.dev') || urlParam.includes('video-leech.pro')) {
          console.log(`[UHDMovies] Found direct link in URL parameter: ${urlParam}`);
          return urlParam;
        }
      }
    } catch (error) {
      // URL parsing might fail, continue with normal processing
    }
  }
  
  const instantDownloadLink = allInstantLinks.attr('href');
  if (!instantDownloadLink) {
    console.log('[UHDMovies] tryInstantDownload: no href found on "Instant Download" element.');
    return null;
  }

  console.log('[UHDMovies] Found "Instant Download" link, attempting to extract final URL...');

  try {
    const urlParams = new URLSearchParams(new URL(instantDownloadLink).search);
    const keys = urlParams.get('url');

    if (keys) {
      const apiUrl = `${new URL(instantDownloadLink).origin}/api`;
      const formData = new FormData();
      formData.append('keys', keys);

      let apiResponse;
      if (UHDMOVIES_PROXY_URL) {
        const proxiedApiUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(apiUrl)}`;
        console.log(`[UHDMovies] Making proxied POST request for Instant Download API to: ${apiUrl}`);
        apiResponse = await axiosInstance.post(proxiedApiUrl, formData, {
          headers: {
            ...formData.getHeaders(),
            'x-token': new URL(instantDownloadLink).hostname
          }
        });
      } else {
        apiResponse = await axiosInstance.post(apiUrl, formData, {
          headers: {
            ...formData.getHeaders(),
            'x-token': new URL(instantDownloadLink).hostname
          }
        });
      }

      if (apiResponse.data && apiResponse.data.url) {
        let finalUrl = apiResponse.data.url;
        console.log(`[UHDMovies] tryInstantDownload: API responded with url: ${String(finalUrl).substring(0, 200)}...`);
        // Fix spaces in workers.dev URLs by encoding them properly
        if (finalUrl.includes('workers.dev')) {
          const urlParts = finalUrl.split('/');
          const filename = urlParts[urlParts.length - 1];
          const encodedFilename = filename.replace(/ /g, '%20');
          urlParts[urlParts.length - 1] = encodedFilename;
          finalUrl = urlParts.join('/');
        }
        console.log('[UHDMovies] Extracted final link from API:', finalUrl);
        return finalUrl;
      }
    }
    
    // If no API response, check if the original link itself might be direct
    if (instantDownloadLink.includes('workers.dev') || instantDownloadLink.includes('video-leech.pro')) {
      let finalUrl = instantDownloadLink;
      // Fix spaces in workers.dev URLs by encoding them properly
      if (finalUrl.includes('workers.dev')) {
        const urlParts = finalUrl.split('/');
        const filename = urlParts[urlParts.length - 1];
        const encodedFilename = filename.replace(/ /g, '%20');
        urlParts[urlParts.length - 1] = encodedFilename;
        finalUrl = urlParts.join('/');
      }
      
      // For video-leech.pro or video-seed.pro links, try to extract or resolve them to get the actual Google URL
      if (finalUrl.includes('video-leech.pro') || finalUrl.includes('cdn.video-leech.pro') || finalUrl.includes('video-seed.pro')) {
        try {
          console.log(`[UHDMovies] Processing video-leech/video-seed link: ${finalUrl}`);
          
          // First, check if it's already a video-seed.pro with url parameter
          if (finalUrl.includes('video-seed.pro') && finalUrl.includes('?url=')) {
            const urlObj = new URL(finalUrl);
            const urlParam = urlObj.searchParams.get('url');
            if (urlParam && urlParam.includes('googleusercontent.com')) {
              console.log(`[UHDMovies] Extracted Google URL from video-seed.pro parameter: ${urlParam}`);
              return urlParam;
            }
          }
          
          // For cdn.video-leech.pro and video-leech.pro - follow redirect to video-seed.pro to get the content
          if (finalUrl.includes('video-leech.pro') || finalUrl.includes('cdn.video-leech.pro')) {
            // Make a request to follow redirect and get the final page content
            const response = await makeRequest(finalUrl, { 
              maxRedirects: 5,  // Allow redirects to reach the final page
              headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              timeout: 15000
            });
            
            // If the final URL contains ?url= parameter, extract it
            if (response && response.request && response.request.res && response.request.res.responseUrl) {
              const finalRedirectedUrl = response.request.res.responseUrl;
              if (finalRedirectedUrl.includes('video-seed.pro') && finalRedirectedUrl.includes('?url=')) {
                try {
                  const urlObj = new URL(finalRedirectedUrl);
                  const urlParam = urlObj.searchParams.get('url');
                  if (urlParam && urlParam.includes('googleusercontent.com')) {
                    console.log(`[UHDMovies] Extracted Google URL from redirected video-seed.pro parameter: ${urlParam}`);
                    return urlParam;
                  }
                } catch (urlParseError) {
                  console.log(`[UHDMovies] URL parsing failed for redirected video-seed.pro: ${urlParseError.message}`);
                }
              }
            }
            
            // If we got HTML content, try to extract the Google URL from the page
            if (response && response.data) {
              const html = response.data;
              // Look for the download button with Google URL in the HTML
              const downloadButtonMatch = html.match(/id=["']downloadBtn["'][^>]*href=["']([^"']*)["']/i);
              if (downloadButtonMatch && downloadButtonMatch[1]) {
                const extractedUrl = downloadButtonMatch[1];
                if (extractedUrl.includes('googleusercontent.com')) {
                  console.log(`[UHDMovies] Successfully extracted Google URL from video-seed page: ${extractedUrl}`);
                  return extractedUrl;
                }
              }
              
              // Alternative: Look for any Google URL in the HTML
              const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
              if (googleUrlMatch) {
                console.log(`[UHDMovies] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
                return googleUrlMatch[0];
              }
            }
          }
          
        } catch (resolveError) {
          console.log(`[UHDMovies] Video-leech/video-seed resolution failed: ${resolveError.message}`);
          // If resolution fails, return the original URL for further validation
        }
      }
      
      console.log('[UHDMovies] Using direct link without resolution:', finalUrl);
      return finalUrl;
    }
    
    console.log('[UHDMovies] Could not find a valid final download link from Instant Download.');
    return null;
  } catch (error) {
    console.log(`[UHDMovies] Error processing "Instant Download": ${error.message}`);
    return null;
  }
}

// Function to try Resume Cloud method
async function tryResumeCloud($, pageOrigin = 'https://driveleech.net') {
  // Look for Resume Cloud buttons with text or specific classes (newer DriveSeed uses btn-warning)
  const resumeCloudButton = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download"), a:contains("Resume Worker Bot"), a:contains("Worker"), a.btn-warning:contains("Resume")');
  console.log(`[UHDMovies] tryResumeCloud: found ${resumeCloudButton.length} candidate button(s).`);

  if (resumeCloudButton.length === 0) {
    // Broaden search: any anchor containing 'Resume' and 'Cloud' text or btn-warning class
    const broadButtons = $('a').filter((_, el) => {
      const t = $(el).text().toLowerCase();
      const hasResumeOrCloud = t.includes('resume') || t.includes('cloud');
      const hasWarningClass = $(el).hasClass('btn-warning');
      return hasResumeOrCloud || hasWarningClass;
    });
    console.log(`[UHDMovies] tryResumeCloud: broadened scan found ${broadButtons.length} anchor(s).`);
    if (broadButtons.length > 0) {
      const href = broadButtons.first().attr('href');
      if (href) {
        // Fall through to processing as resumeLink below by simulating
        const fake$ = $.root();
      }
    }
    // Also check for direct links on current page as last resort - add zfile patterns
    const direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"], a[href*="/zfile/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"]').attr('href');
    if (direct) {
      let link = direct;
      if (link.includes('workers.dev')) {
        const parts = link.split('/');
        const fn = parts[parts.length - 1];
        parts[parts.length - 1] = fn.replace(/ /g, '%20');
        link = parts.join('/');
      }
      console.log(`[UHDMovies] tryResumeCloud: direct link found on page without explicit button: ${link}`);
      return link;
    }
    return null;
  }

  const resumeLink = resumeCloudButton.attr('href');
  if (!resumeLink) {
    console.log('[UHDMovies] tryResumeCloud: button has no href attribute.');
    return null;
  }

  // Check if it's already a direct download link (workers.dev)
  if (resumeLink.includes('workers.dev') || resumeLink.startsWith('http')) {
    let directLink = resumeLink;
    // Fix spaces in workers.dev URLs by encoding them properly
    if (directLink.includes('workers.dev')) {
      const urlParts = directLink.split('/');
      const filename = urlParts[urlParts.length - 1];
      const encodedFilename = filename.replace(/ /g, '%20');
      urlParts[urlParts.length - 1] = encodedFilename;
      directLink = urlParts.join('/');
    }
    console.log(`[UHDMovies] Found direct "Cloud Resume Download" link: ${directLink}`);
    return directLink;
  }

  // Otherwise, follow the link to get the final download
  try {
    const resumeUrl = new URL(resumeLink, pageOrigin).href;
    console.log(`[UHDMovies] Found 'Resume Cloud' page link. Following to: ${resumeUrl}`);

    // "Click" the link by making another request
    const finalPageResponse = await makeRequest(resumeUrl, { maxRedirects: 10 });
    const $$ = cheerio.load(finalPageResponse.data);

    // Look for direct download links - include zfile and video-leech.pro patterns
    let finalDownloadLink = $('a.btn-success[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (!finalDownloadLink) {
      // Look for zfile and video-leech.pro links which are common on newer sites
      finalDownloadLink = $('a[href*="/zfile/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"]').attr('href');
    }
    if (!finalDownloadLink) {
      const candidateCount = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').length;
      console.log(`[UHDMovies] tryResumeCloud: no primary selector matched, but found ${candidateCount} candidate link(s) on page.`);
      if (candidateCount > 0) {
        finalDownloadLink = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').first().attr('href');
      }
    }
    if (!finalDownloadLink) {
      // Last attempt: check for any download-like links on the page
      const allCandidateCount = $('a[href*="/zfile/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"], a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').length;
      console.log(`[UHDMovies] tryResumeCloud: extended pattern search found ${allCandidateCount} candidate link(s) on page.`);
      if (allCandidateCount > 0) {
        finalDownloadLink = $('a[href*="/zfile/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"], a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').first().attr('href');
      }
    }

    if (finalDownloadLink) {
      // Handle /zfile/ URLs - they require a POST request to generate the actual download link
      if (finalDownloadLink.includes('/zfile/')) {
        try {
          console.log(`[UHDMovies] Detected /zfile/ URL, generating cloud link via POST: ${finalDownloadLink}`);

          // Extract the key from the page HTML
          const keyMatch = finalPageResponse.data.match(/formData\.append\("key",\s*"([^"]+)"\)/);
          const key = keyMatch ? keyMatch[1] : '';

          if (!key) {
            console.log('[UHDMovies] Could not extract key from /zfile/ page, trying without key');
          }

          // Make POST request to generate cloud link
          const zfileUrl = new URL(finalDownloadLink, pageOrigin).href;
          const formData = new FormData();
          formData.append('action', 'cloud');
          if (key) {
            formData.append('key', key);
          }
          formData.append('action_token', '');

          const zfileResponse = await axiosInstance.post(zfileUrl, formData, {
            headers: {
              ...formData.getHeaders(),
              'x-token': new URL(zfileUrl).hostname
            }
          });

          if (zfileResponse.data && zfileResponse.data.url) {
            console.log(`[UHDMovies] Generated cloud link from /zfile/: ${zfileResponse.data.url}`);
            finalDownloadLink = zfileResponse.data.url;

            // The generated URL might be another /zfile/ URL with a token, follow it
            if (finalDownloadLink.includes('/zfile/') && finalDownloadLink.includes('token=')) {
              console.log(`[UHDMovies] Following tokenized /zfile/ URL: ${finalDownloadLink}`);
              const tokenResponse = await makeRequest(finalDownloadLink, { maxRedirects: 10 });
              const $token = cheerio.load(tokenResponse.data);

              // Look for gamerxyt or other download links
              const gamerxytLink = $token('a[href*="gamerxyt"], a[href*="hubcloud"], a:contains("Download")').filter((i, el) => {
                const href = $token(el).attr('href');
                return href && (href.includes('gamerxyt') || href.includes('hubcloud') || href.includes('worker'));
              }).first().attr('href');

              if (gamerxytLink) {
                console.log(`[UHDMovies] Found gamerxyt/download link: ${gamerxytLink}`);
                finalDownloadLink = new URL(gamerxytLink, zfileUrl).href;
              }
            }
          } else {
            console.log('[UHDMovies] /zfile/ POST did not return a URL');
          }
        } catch (zfileError) {
          console.log(`[UHDMovies] Error processing /zfile/ URL: ${zfileError.message}`);
        }
      }

      // Fix spaces in workers.dev URLs by encoding them properly
      if (finalDownloadLink.includes('workers.dev')) {
        // Split the URL at the last slash to separate the base URL from the filename
        const urlParts = finalDownloadLink.split('/');
        const filename = urlParts[urlParts.length - 1];
        // Encode spaces in the filename part only
        const encodedFilename = filename.replace(/ /g, '%20');
        urlParts[urlParts.length - 1] = encodedFilename;
        finalDownloadLink = urlParts.join('/');
      }
      console.log(`[UHDMovies] Extracted final Resume Cloud link: ${finalDownloadLink}`);
      return finalDownloadLink;
    } else {
      console.log('[UHDMovies] Could not find the final download link on the "Resume Cloud" page.');
      return null;
    }
  } catch (error) {
    console.log(`[UHDMovies] Error processing "Resume Cloud": ${error.message}`);
    return null;
  }
}

// Environment variable to control URL validation
const URL_VALIDATION_ENABLED = process.env.DISABLE_URL_VALIDATION !== 'true';
const VALIDATION_TIMEOUT = parseInt(process.env.UHDMOVIES_VALIDATION_TIMEOUT) || 8000; // Configurable timeout, default 8 seconds
console.log(`[UHDMovies] URL validation is ${URL_VALIDATION_ENABLED ? 'enabled' : 'disabled'}.`);
console.log(`[UHDMovies] URL validation timeout is set to ${VALIDATION_TIMEOUT}ms.`);

// Validate if a video URL is working (not 404 or broken)
async function validateVideoUrl(url, timeout = VALIDATION_TIMEOUT) {
  // Skip validation if disabled via environment variable
  if (!URL_VALIDATION_ENABLED) {
    console.log(`[UHDMovies] URL validation disabled, skipping validation for: ${url.substring(0, 100)}...`);
    return true;
  }

  // Skip validation for video-leech.pro links as they need post-processing first
  if (url.includes('video-leech.pro') || url.includes('cdn.video-leech.pro')) {
    console.log(`[UHDMovies] Skipping validation for video-leech link (requires post-processing): ${url.substring(0, 100)}...`);
    return true;
  }
  
  // Skip validation for known reliable hosting services
  const trustedHosts = [
    'video-downloads.googleusercontent.com',
    'pixeldrain.dev',
    'pixeldrain.com',
    'r2.dev',
    'workers.dev',
    'hubcdn.fans',
    'driveleech.net',
    'driveseed.org'
  ];
  
  const urlObj = new URL(url);
  const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));
  if (isTrustedHost) {
    console.log(`[UHDMovies] Skipping validation for trusted host: ${urlObj.hostname}`);
    return true;
  }

  try {
    console.log(`[UHDMovies] Validating URL: ${url.substring(0, 100)}...`);
    
    // Use proxy for URL validation if enabled
    let response;
    if (UHDMOVIES_PROXY_URL) {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making proxied HEAD request for validation to: ${url}`);
      response = await axiosInstance.head(proxiedUrl, {
        timeout,
        headers: {
          'Range': 'bytes=0-1' // Just request first byte to test
        }
      });
    } else {
      response = await axiosInstance.head(url, {
        timeout,
        headers: {
          'Range': 'bytes=0-1' // Just request first byte to test
        }
      });
    }

    // Check if status is OK (200-299), partial content (206), or redirects (300-399)
    // 206 Partial Content is valid for video streaming with range requests
    // 3xx redirects are also acceptable as they indicate the resource exists and redirects to it
    if (response.status >= 200 && response.status < 400) {
      console.log(`[UHDMovies] ✓ URL validation successful (${response.status})`);
      return true;
    } else {
      console.log(`[UHDMovies] ✗ URL validation failed with status: ${response.status}`);
      // Fall through to GET retry
    }
  } catch (error) {
    console.log(`[UHDMovies] ✗ URL validation HEAD failed: ${error.message}`);
  }

  // Fallback 1: Treat some known statuses/domains as acceptable without HEAD support
  try {
    const lower = url.toLowerCase();
    if (lower.includes('workers.dev') || lower.includes('driveleech.net/d/')) {
      console.log('[UHDMovies] URL appears to be a direct download on workers.dev or driveleech; attempting GET fallback.');
    }

    // Fallback 2: Try GET with small range
    let getResponse;
    if (UHDMOVIES_PROXY_URL) {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making proxied GET fallback request for validation to: ${url}`);
      getResponse = await axiosInstance.get(proxiedUrl, {
        timeout,
        responseType: 'stream',
        headers: { 'Range': 'bytes=0-1' }
      });
    } else {
      getResponse = await axiosInstance.get(url, {
        timeout,
        responseType: 'stream',
        headers: { 'Range': 'bytes=0-1' }
      });
    }

    if ((getResponse.status >= 200 && getResponse.status < 500) || getResponse.status === 206) {
      console.log(`[UHDMovies] ✓ GET fallback validation accepted (${getResponse.status}).`);
      return true;
    }
  } catch (err) {
    console.log(`[UHDMovies] ✗ GET fallback validation failed: ${err.message}`);
  }

  return false;
}

// Function to follow redirect links and get the final download URL with size info
async function getFinalLink(redirectUrl) {
  try {
    console.log(`[UHDMovies] Following redirect: ${redirectUrl}`);

    // Request the driveleech page
    let response = await makeRequest(redirectUrl, { maxRedirects: 10 });
    let $ = cheerio.load(response.data);

    // --- Check for JavaScript redirect ---
    const scriptContent = $('script').html();
    const redirectMatch = scriptContent && scriptContent.match(/window\.location\.replace\(\"([^\"]+)\"\)/);

    if (redirectMatch && redirectMatch[1]) {
      const newPath = redirectMatch[1];
      const newUrl = new URL(newPath, 'https://driveleech.net/').href;
      console.log(`[UHDMovies] Found JavaScript redirect. Following to: ${newUrl}`);
      response = await makeRequest(newUrl, { maxRedirects: 10 });
      $ = cheerio.load(response.data);
    }

    // Extract size and filename information from the page
    let sizeInfo = 'Unknown';
    let fileName = null;

    const sizeElement = $('li.list-group-item:contains("Size :")').text();
    if (sizeElement) {
      const sizeMatch = sizeElement.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
      if (sizeMatch) sizeInfo = sizeMatch[1];
    }

    const nameElement = $('li.list-group-item:contains("Name :")').text();
    if (nameElement) {
      fileName = nameElement.replace('Name :', '').trim();
    }

    // Try each download method in order until we find a working one
    const downloadMethods = [
      { name: 'Resume Cloud', func: (dom) => tryResumeCloud(dom, new URL(finalFilePageUrl).origin) },
      { name: 'Instant Download', func: (dom) => tryInstantDownload(dom, finalFilePageUrl) }
    ];

    for (const method of downloadMethods) {
      try {
        console.log(`[UHDMovies] Trying ${method.name}...`);
        const finalUrl = await method.func($);

        if (finalUrl) {
          // If it's a video-leech.pro link, it might be an intermediate link that needs resolution
          let resolvedUrl = finalUrl;
          if (finalUrl.includes('video-leech.pro') || finalUrl.includes('cdn.video-leech.pro')) {
            try {
              console.log(`[UHDMovies] Resolving intermediate link: ${finalUrl}`);
              // Make a request to resolve the link and extract the real URL
              const response = await makeRequest(finalUrl, { 
                maxRedirects: 5,
                followRedirect: false, // Don't follow redirects automatically, we'll handle them manually
                timeout: 10000
              });
              
              // Check if there's a redirect in the response headers
              if (response && response.headers) {
                const locationHeader = response.headers.location || response.headers.Location;
                if (locationHeader) {
                  console.log(`[UHDMovies] Found redirect location header: ${locationHeader}`);
                  resolvedUrl = locationHeader;
                }
              }
              
              // If no redirect header, check the response data for Google URL references
              if (resolvedUrl === finalUrl && response.data) {
                const body = response.data;
                // Look for Google video URL in the response body
                const googleUrlMatch = body.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
                if (googleUrlMatch) {
                  console.log(`[UHDMovies] Found Google URL in response body: ${googleUrlMatch[0]}`);
                  resolvedUrl = googleUrlMatch[0];
                } else {
                  // Look for any URL that might be in JSON or JavaScript
                  const potentialUrlMatch = body.match(/https?:\/\/[^\s"'\]<>\{\}\[\]]*googleusercontent[^\s"'\]<>\{\}\[\]]*/i);
                  if (potentialUrlMatch) {
                    console.log(`[UHDMovies] Found potential Google URL in response: ${potentialUrlMatch[0]}`);
                    resolvedUrl = potentialUrlMatch[0];
                  }
                }
              }
              
              // If the URL was resolved to something different, log the resolution
              if (resolvedUrl !== finalUrl) {
                console.log(`[UHDMovies] Link resolved from ${finalUrl} to ${resolvedUrl}`);
              }
            } catch (resolveError) {
              console.log(`[UHDMovies] Link resolution failed (using original): ${resolveError.message}`);
              // If resolution fails, use the original URL
            }
          }

          // Validate the URL before using it
          const isValid = await validateVideoUrl(resolvedUrl);
          if (isValid) {
            console.log(`[UHDMovies] ✓ Successfully resolved using ${method.name}`);
            return { url: resolvedUrl, size: sizeInfo, fileName: fileName };
          }
        } else {
          console.log(`[UHDMovies] ✗ ${method.name} failed to resolve URL, trying next method...`);
        }
      } catch (error) {
        console.log(`[UHDMovies] ✗ ${method.name} threw error: ${error.message}, trying next method...`);
      }
    }

    // Final fallback: scan current page for any plausible direct links
    const anyDirect = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (anyDirect) {
      let direct = anyDirect;
      if (direct.includes('workers.dev')) {
        const parts = direct.split('/');
        const fn = parts[parts.length - 1];
        parts[parts.length - 1] = fn.replace(/ /g, '%20');
        direct = parts.join('/');
      }
      const ok = await validateVideoUrl(direct);
      if (ok) {
        console.log('[UHDMovies] ✓ Final fallback found a direct link on page.');
        return { url: direct, size: sizeInfo, fileName: fileName };
      }
    }

    console.log('[UHDMovies] ✗ All download methods failed.');
    return null;

  } catch (error) {
    console.error(`[UHDMovies] Error in getFinalLink: ${error.message}`);
    return null;
  }
}

// Compare media to find matching result
function compareMedia(mediaInfo, searchResult) {
  // Number to word mapping for better title matching
  const numberToWord = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    '10': 'ten', '11': 'eleven', '12': 'twelve'
  };
  const wordToNumber = Object.fromEntries(Object.entries(numberToWord).map(([k, v]) => [v, k]));

  const normalizeString = (str) => {
    // First normalize to words with spaces, convert numbers to words, then remove all non-alpha
    const withSpaces = String(str || '').toLowerCase()
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = withSpaces.split(' ');
    const normalized = words.map(word => numberToWord[word] || word).join('');
    return normalized;
  };
  const normalizeForWordMatching = (str) => String(str || '').toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizeForTitleStartMatching = (str) => {
    const normalized = String(str || '').toLowerCase()
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(word => word.length > 0);

    // Normalize numbers to words for consistent matching
    return normalized.map(word => {
      // Convert number to word if it exists in our mapping
      if (numberToWord[word]) {
        return numberToWord[word];
      }
      // Convert word to number if it exists in our mapping, then back to word for consistency
      if (wordToNumber[word]) {
        return word; // Already a word, keep it
      }
      return word;
    });
  };

  const originalMediaTitleLower = mediaInfo.title.toLowerCase();
  const titleWithAnd = originalMediaTitleLower.replace(/\s*&\s*/g, ' and ');
  const normalizedMediaTitle = normalizeString(titleWithAnd);
  const normalizedResultTitle = normalizeString(searchResult.title);
  
  // Also create a word-based normalized version for better matching
  const wordNormalizedMediaTitle = normalizeForWordMatching(titleWithAnd);
  const wordNormalizedResultTitle = normalizeForWordMatching(searchResult.title);
  const mediaTitleWords = normalizeForTitleStartMatching(titleWithAnd);
  const resultTitleWords = normalizeForTitleStartMatching(searchResult.title);

  console.log(`[UHDMovies] Comparing: "${mediaInfo.title}" (${mediaInfo.year}) vs "${searchResult.title}"`);
  console.log(`[UHDMovies] Normalized: "${normalizedMediaTitle}" vs "${normalizedResultTitle}"`);
  console.log(`[UHDMovies] Word normalized: "${wordNormalizedMediaTitle}" vs "${wordNormalizedResultTitle}"`);
  console.log(`[UHDMovies] Title words: [${mediaTitleWords.join(', ')}] vs [${resultTitleWords.join(', ')}]`);

  // Check if titles match or result title contains media title
  let titleMatches = false;
  
  // Primary check: media title should appear as the starting portion of the result title
  // This is critical to fix the "FROM" vs "From Hero-King to Extraordinary Squire" issue
  if (mediaTitleWords.length > 0) {
    // Check if the result title starts with all the media title words in order
    if (resultTitleWords.length >= mediaTitleWords.length) {
      let startsWithTitle = true;
      for (let i = 0; i < mediaTitleWords.length; i++) {
        if (resultTitleWords[i] !== mediaTitleWords[i]) {
          startsWithTitle = false;
          break;
        }
      }
      
      if (startsWithTitle) {
        titleMatches = true;
      } else {
        // Alternative check: if the media title is a substring of the result title but starts at the beginning
        // For multi-word titles like "John Wick" should match "John Wick Chapter 2"
        // Also handles single word titles like "FROM" vs "FROM (2022)"
        // Check if the result text starts with the media words in order (after removing common prefixes)
        const resultTextLower = searchResult.title.toLowerCase();
        // Check if the media title appears at the beginning of the actual title part (after common prefixes)
        let cleanedResult = resultTextLower.replace(/^(download|watch|stream)\s+/i, '');
        // Normalize punctuation and convert numbers to words in cleaned result to match normalized media title
        const cleanedWords = cleanedResult
          .replace(/[^a-zA-Z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .split(' ')
          .map(word => numberToWord[word] || word);
        cleanedResult = cleanedWords.join(' ');

        // Look for media title at the start of the cleaned result
        const mediaTitleForPattern = mediaTitleWords.join(' ');
        if (cleanedResult.startsWith(mediaTitleForPattern + ' ') ||
            cleanedResult === mediaTitleForPattern) {
          titleMatches = true;
        }
        // For single words, also check if they appear as standalone words at the start
        else if (mediaTitleWords.length === 1) {
          const mediaWord = mediaTitleWords[0];
          if (cleanedResult.startsWith(mediaWord + ' ') ||
              cleanedResult === mediaWord) {
            titleMatches = true;
          }
        }
        // Check for franchise/sequel pattern: "Mission Impossible 7: Dead Reckoning" matching "Mission Impossible Dead Reckoning"
        // Extract the franchise name (first 2-3 words) and check if result contains it with optional number
        else if (mediaTitleWords.length >= 2) {
          // Try to match allowing for inserted sequel numbers/roman numerals
          const franchiseWords = mediaTitleWords.slice(0, 2); // e.g., "mission impossible"
          const franchisePattern = franchiseWords.join(' ');

          if (cleanedResult.startsWith(franchisePattern + ' ')) {
            // Check if remaining words after franchise also match (allowing for inserted numbers)
            const afterFranchise = cleanedResult.substring(franchisePattern.length + 1);
            const sequelNumPattern = /^(i{1,3}v?|i?v|i?x|xi{0,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+/i;
            const afterNumber = afterFranchise.replace(sequelNumPattern, '').trim();

            // Check if the remaining media title words appear after the number
            const remainingMediaWords = mediaTitleWords.slice(2);
            if (remainingMediaWords.length > 0) {
              const remainingPattern = remainingMediaWords.join(' ');
              if (afterNumber.startsWith(remainingPattern + ' ') ||
                  afterNumber.startsWith(remainingPattern) ||
                  afterNumber === remainingPattern) {
                titleMatches = true;
              }
            } else {
              // No remaining words to check, franchise match is enough
              titleMatches = true;
            }
          }
        }
      }
    } else {
      // If result is shorter than media title, all result words should appear in the media title
      if (resultTitleWords.length < 3) { // Too short to be a reliable match
          titleMatches = false;
      } else {
          let allResultWordsInMedia = true;
          for (const resultWord of resultTitleWords) {
            if (!mediaTitleWords.includes(resultWord)) {
              // Allow for year to be present in result but not in media title words
              if (/^(19|20)\d{2}$/.test(resultWord)) {
                continue;
              }
              allResultWordsInMedia = false;
              break;
            }
          }
          if (allResultWordsInMedia) {
            titleMatches = true;
          }
      }
    }
  }

  // If direct match fails, try checking for franchise/collection matches
  if (!titleMatches) {
    const mainTitle = normalizedMediaTitle.split('and')[0];
    const isCollection = normalizedResultTitle.includes('duology') ||
      normalizedResultTitle.includes('trilogy') ||
      normalizedResultTitle.includes('quadrilogy') ||
      normalizedResultTitle.includes('collection') ||
      normalizedResultTitle.includes('saga');

    if (isCollection && normalizedResultTitle.includes(mainTitle)) {
      console.log(`[UHDMovies] Found collection match: "${mainTitle}" in collection "${searchResult.title}"`);
      titleMatches = true;
    }
  }

  if (!titleMatches) {
    console.log(`[UHDMovies] Title mismatch: "${normalizedResultTitle}" does not contain "${normalizedMediaTitle}"`);
    return false;
  }

  // NEW: Negative keyword check for spinoffs
  const negativeKeywords = ['challenge', 'conversation', 'story', 'in conversation'];
  for (const keyword of negativeKeywords) {
    if (normalizedResultTitle.includes(keyword.replace(/\s/g, '')) && !originalMediaTitleLower.includes(keyword)) {
      console.log(`[UHDMovies] Rejecting spinoff due to keyword: "${keyword}"`);
      return false; // It's a spinoff, reject it.
    }
  }

  // Check year if both are available
  if (mediaInfo.year && searchResult.title) {
    const yearRegex = /\b(19[89]\d|20\d{2})\b/g; // Look for years 1980-2099
    const yearMatchesInResult = searchResult.title.match(yearRegex);
    const yearRangeMatch = searchResult.title.match(/(\d{4})\s*-\s*(\d{4})/);

    let hasMatchingYear = false;

    if (yearMatchesInResult) {
      console.log(`[UHDMovies] Found years in result: ${yearMatchesInResult.join(', ')}`);
      if (yearMatchesInResult.some(yearStr => Math.abs(parseInt(yearStr) - mediaInfo.year) <= 1)) {
        hasMatchingYear = true;
      }
    }

    if (!hasMatchingYear && yearRangeMatch) {
      console.log(`[UHDMovies] Found year range in result: ${yearRangeMatch[0]}`);
      const startYear = parseInt(yearRangeMatch[1]);
      const endYear = parseInt(yearRangeMatch[2]);
      if (mediaInfo.year >= startYear - 1 && mediaInfo.year <= endYear + 1) {
        hasMatchingYear = true;
      }
    }

    // If there are any years found in the title, one of them MUST match.
    if ((yearMatchesInResult || yearRangeMatch) && !hasMatchingYear) {
      console.log(`[UHDMovies] Year mismatch. Target: ${mediaInfo.year}, but no matching year found in result.`);
      return false;
    }
  }

  console.log(`[UHDMovies] Match successful!`);
  return true;
}

// Function to score search results based on quality keywords and season coverage
function scoreResult(title, requestedSeason = null, mediaTitle = null) {
  let score = 0;
  const lowerTitle = title.toLowerCase();
  
  // Exact or close title matching bonus
  if (mediaTitle) {
    const normalizedMediaTitle = mediaTitle.toLowerCase().replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalizedResultTitle = lowerTitle.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Check if the media title appears as a complete phrase in the result title
    if (normalizedResultTitle.includes(normalizedMediaTitle)) {
      // If the result title starts with the media title, it's likely the main title
      if (normalizedResultTitle.startsWith(normalizedMediaTitle)) {
        score += 50; // High bonus for exact match at start of title
      } else {
        score += 30; // Good bonus for containing the exact title
      }
    } else {
      // Check for partial word matches for cases where title has extra content
      const mediaWords = normalizedMediaTitle.split(' ');
      const resultWords = normalizedResultTitle.split(' ');
      
      let matchingWords = 0;
      for (const word of mediaWords) {
        if (resultWords.includes(word)) {
          matchingWords++;
        }
      }
      
      // If most words from media title are found in result, add score
      if (mediaWords.length > 0 && matchingWords >= Math.max(1, Math.floor(mediaWords.length * 0.7))) {
        score += 20 * (matchingWords / mediaWords.length);
      }
    }
  }

  // Quality scoring
  if (lowerTitle.includes('remux')) score += 10;
  if (lowerTitle.includes('bluray') || lowerTitle.includes('blu-ray')) score += 8;
  if (lowerTitle.includes('imax')) score += 6;
  if (lowerTitle.includes('4k') || lowerTitle.includes('2160p')) score += 5;
  if (lowerTitle.includes('dovi') || lowerTitle.includes('dolby vision') || /\bdv\b/.test(lowerTitle)) score += 4;
  if (lowerTitle.includes('hdr')) score += 3;
  if (lowerTitle.includes('1080p')) score += 2;
  if (lowerTitle.includes('hevc') || lowerTitle.includes('x265')) score += 1;

  // Season coverage scoring (for TV shows)
  if (requestedSeason !== null) {
    // Check for season range formats like "Season 1 – 2" or "Season 1-2"
    const seasonRangeMatch = lowerTitle.match(/season\s+(\d+)\s*[–-]\s*(\d+)/i);
    if (seasonRangeMatch) {
      const startSeason = parseInt(seasonRangeMatch[1], 10);
      const endSeason = parseInt(seasonRangeMatch[2], 10);
      if (requestedSeason >= startSeason && requestedSeason <= endSeason) {
        score += 50; // High bonus for season range that includes requested season
        console.log(`[UHDMovies] Season range bonus (+50): ${startSeason}-${endSeason} includes requested season ${requestedSeason}`);
      }
    }
    
    // Check for specific season mentions
    const specificSeasonMatch = lowerTitle.match(/season\s+(\d+)/i);
    if (specificSeasonMatch) {
      const mentionedSeason = parseInt(specificSeasonMatch[1], 10);
      if (mentionedSeason === requestedSeason) {
        score += 30; // Good bonus for exact season match
        console.log(`[UHDMovies] Exact season bonus (+30): Season ${mentionedSeason} matches requested season ${requestedSeason}`);
      } else if (mentionedSeason < requestedSeason) {
        score -= 20; // Penalty for older season when requesting newer season
        console.log(`[UHDMovies] Season penalty (-20): Season ${mentionedSeason} is older than requested season ${requestedSeason}`);
      }
    }
    
    // Check for "Season X Added" or similar indicators
    if (lowerTitle.includes('season') && lowerTitle.includes('added')) {
      const addedSeasonMatch = lowerTitle.match(/season\s+(\d+)\s+added/i);
      if (addedSeasonMatch) {
        const addedSeason = parseInt(addedSeasonMatch[1], 10);
        if (addedSeason === requestedSeason) {
          score += 40; // High bonus for newly added season
          console.log(`[UHDMovies] Added season bonus (+40): Season ${addedSeason} was recently added`);
        }
      }
    }
  }

  return score;
}

// Function to parse size string into MB
function parseSize(sizeString) {
  if (!sizeString || typeof sizeString !== 'string') {
    return 0;
  }

  const upperCaseSizeString = sizeString.toUpperCase();

  // Regex to find a number (integer or float) followed by GB, MB, or KB
  const match = upperCaseSizeString.match(/([0-9.,]+)\s*(GB|MB|KB)/);

  if (!match) {
    return 0;
  }

  const sizeValue = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(sizeValue)) {
    return 0;
  }

  const unit = match[2];

  if (unit === 'GB') {
    return sizeValue * 1024;
  } else if (unit === 'MB') {
    return sizeValue;
  } else if (unit === 'KB') {
    return sizeValue / 1024;
  }

  return 0;
}

// Helper function to extract cookies from jar for a specific URL
const getCookiesForUrl = async (jar, url) => {
  try {
    const cookies = await jar.getCookies(url);
    if (cookies && cookies.length > 0) {
      return cookies.map(cookie => cookie.toString()).join('; ');
    }
  } catch (error) {
    console.log(`[UHDMovies] Error extracting cookies for ${url}: ${error.message}`);
  }
  return null;
};

// Helper function to create a proxied session for SID resolution
const createProxiedSession = async (jar) => {
  const { wrapper } = await getAxiosCookieJarSupport();
  
  const sessionConfig = {
    jar,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  };

  const session = wrapper(axios.create(sessionConfig));

  // If proxy is enabled, wrap the session methods to use proxy
  if (UHDMOVIES_PROXY_URL) {
    console.log(`[UHDMovies] Creating SID session with proxy: ${UHDMOVIES_PROXY_URL}`);
    const originalGet = session.get.bind(session);
    const originalPost = session.post.bind(session);

    session.get = async (url, options = {}) => {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making proxied SID GET request to: ${url}`);
      
      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        console.log(`[UHDMovies] Adding cookies to proxied request: ${cookieString}`);
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }
      
      return originalGet(proxiedUrl, options);
    };

    session.post = async (url, data, options = {}) => {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making proxied SID POST request to: ${url}`);
      
      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        console.log(`[UHDMovies] Adding cookies to proxied request: ${cookieString}`);
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }
      
      return originalPost(proxiedUrl, data, options);
    };
  }

  return session;
};

// New function to resolve the tech.unblockedgames.world links
async function resolveSidToDriveleech(sidUrl) {
  console.log(`[UHDMovies] Resolving SID link: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const jar = new CookieJar();

  // Configure retry parameters
  const MAX_RETRIES = parseInt(process.env.UHDMOVIES_SID_MAX_RETRIES) || 3;
  const RETRY_DELAY = parseInt(process.env.UHDMOVIES_SID_RETRY_DELAY) || 2000; // 2 seconds default
  const REQUEST_TIMEOUT = parseInt(process.env.UHDMOVIES_SID_TIMEOUT) || 30000; // 30 seconds default

  // Create session with proxy support
  const session = await createProxiedSession(jar);

  // Wrapper function to add timeout to requests
  const requestWithTimeout = async (requestFn, timeout = REQUEST_TIMEOUT) => {
    return Promise.race([
      requestFn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout')), timeout)
      )
    ]);
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`  [SID] Attempt ${attempt + 1}/${MAX_RETRIES + 1}: Starting SID resolution for ${sidUrl}`);
      
      // Step 0: Get the _wp_http value
      console.log("  [SID] Step 0: Fetching initial page...");
      const responseStep0 = await requestWithTimeout(() => session.get(sidUrl));
      let $ = cheerio.load(responseStep0.data);
      const initialForm = $('#landing');
      const wp_http_step1 = initialForm.find('input[name="_wp_http"]').val();
      const action_url_step1 = initialForm.attr('action');

      if (!wp_http_step1 || !action_url_step1) {
        console.error("  [SID] Error: Could not find _wp_http in initial form.");
        if (attempt < MAX_RETRIES) {
          console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        return null;
      }

      // Step 1: POST to the first form's action URL
      console.log("  [SID] Step 1: Submitting initial form...");
      const step1Data = new URLSearchParams({ '_wp_http': wp_http_step1 });
      const responseStep1 = await requestWithTimeout(() => session.post(action_url_step1, step1Data, {
        headers: { 
          'Referer': sidUrl, 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }));

      // Step 2: Parse verification page for second form
      console.log("  [SID] Step 2: Parsing verification page...");
      $ = cheerio.load(responseStep1.data);
      const verificationForm = $('#landing');
      const action_url_step2 = verificationForm.attr('action');
      const wp_http2 = verificationForm.find('input[name="_wp_http2"]').val();
      const token = verificationForm.find('input[name="token"]').val();

      if (!action_url_step2) {
        console.error("  [SID] Error: Could not find verification form.");
        if (attempt < MAX_RETRIES) {
          console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        return null;
      }

      // Step 3: POST to the verification URL
      console.log("  [SID] Step 3: Submitting verification...");
      const step2Data = new URLSearchParams({ '_wp_http2': wp_http2, token: token });
      const responseStep2 = await requestWithTimeout(() => session.post(action_url_step2, step2Data, {
        headers: { 
          'Referer': responseStep1.request.res.responseUrl, 
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }));

      // Step 4: Find dynamic cookie and link from JavaScript
      console.log("  [SID] Step 4: Parsing final page for JS data...");
      let finalLinkPath = null;
      let cookieName = null;
      let cookieValue = null;

      const scriptContent = responseStep2.data;
      const cookieMatch = scriptContent.match(/s_343\('([^']+)',\s*'([^']+)'/);
      const linkMatch = scriptContent.match(/c\.setAttribute\(\"href\",\s*\"([^\"]+)\"\)/);

      if (cookieMatch) {
        cookieName = cookieMatch[1].trim();
        cookieValue = cookieMatch[2].trim();
      }
      if (linkMatch) {
        finalLinkPath = linkMatch[1].trim();
      }

      if (!finalLinkPath || !cookieName || !cookieValue) {
        console.error("  [SID] Error: Could not extract dynamic cookie/link from JS.");
        if (attempt < MAX_RETRIES) {
          console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        return null;
      }

      const finalUrl = new URL(finalLinkPath, origin).href;
      console.log(`  [SID] Dynamic link found: ${finalUrl}`);
      console.log(`  [SID] Dynamic cookie found: ${cookieName}`);

      // Step 5: Set cookie and make final request
      console.log("  [SID] Step 5: Setting cookie and making final request...");
      await jar.setCookie(`${cookieName}=${cookieValue}`, origin);

      const finalResponse = await requestWithTimeout(() => session.get(finalUrl, {
        headers: { 
          'Referer': responseStep2.request.res.responseUrl,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }));

      // Step 6: Extract driveleech URL from meta refresh tag
      $ = cheerio.load(finalResponse.data);
      const metaRefresh = $('meta[http-equiv="refresh"]');
      if (metaRefresh.length > 0) {
        const content = metaRefresh.attr('content');
        const urlMatch = content.match(/url=(.*)/i);
        if (urlMatch && urlMatch[1]) {
          const driveleechUrl = urlMatch[1].replace(/"/g, "").replace(/'/g, "");
          console.log(`  [SID] SUCCESS! Resolved Driveleech URL: ${driveleechUrl}`);
          return driveleechUrl;
        }
      }

      console.error("  [SID] Error: Could not find meta refresh tag with Driveleech URL.");
      if (attempt < MAX_RETRIES) {
        console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      return null;

    } catch (error) {
      console.error(`  [SID] Error during SID resolution on attempt ${attempt + 1}: ${error.message}`);
      
      if (error.response) {
        console.error(`  [SID] Status: ${error.response.status}`);
        // Specific handling for 403 Forbidden errors
        if (error.response.status === 403) {
          console.log(`  [SID] 403 Forbidden - possibly blocked by anti-bot measures`);
          if (attempt < MAX_RETRIES) {
            console.log(`  [SID] Waiting longer for anti-bot cooldown... ${RETRY_DELAY * 2}ms`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * 2)); // Longer delay after 403
            continue;
          }
        } else if (error.response.status === 429) {
          console.log(`  [SID] 429 Too Many Requests - rate limited`);
          // Wait longer for rate limiting
          const rateLimitDelay = parseInt(process.env.UHDMOVIES_SID_RATE_LIMIT_DELAY) || 10000; // 10 seconds default
          if (attempt < MAX_RETRIES) {
            console.log(`  [SID] Waiting for rate limit cooldown... ${rateLimitDelay}ms`);
            await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
            continue;
          }
        }
      }
      
      if (attempt < MAX_RETRIES) {
        console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      
      // Log the error but don't completely fail - just return null to signal failure
      console.error(`  [SID] Final failure after ${MAX_RETRIES + 1} attempts`);
      return null;
    }
  }
}

// Main function to get streams for TMDB content
async function getUHDMoviesStreams(imdbId, tmdbId, mediaType = 'movie', season = null, episode = null, config = {}) {
  console.log(`[UHDMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);

  try {
      // Get Cinemeta info to perform search
      console.time(`[UHDMovies] Cinemeta lookup for ${imdbId}`);
      const cinemetaDetails = await Cinemeta.getMeta(mediaType, imdbId);
      console.timeEnd(`[UHDMovies] Cinemeta lookup for ${imdbId}`);
      if (!cinemetaDetails) {
        throw new Error('Could not extract title from Cinemeta response.');
      }
      const mediaInfo = {
        title: cinemetaDetails.name,
        year: parseInt((cinemetaDetails.year || '').split('–')[0], 10)
      };

      if (!mediaInfo.title) throw new Error('Could not extract title from Cinemeta response.');
      console.log(`[UHDMovies] Cinemeta Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);

      // 3. Search for the media on UHDMovies
      let searchTitle = mediaInfo.title.replace(/:/g, '').replace(/\s*&\s*/g, ' and ');
      console.log(`[UHDMovies] Search title: ${searchTitle}`);
      console.time(`[UHDMovies] searchMovies for ${searchTitle}`);
      let searchResults = await searchMovies(searchTitle);
      console.timeEnd(`[UHDMovies] searchMovies for ${searchTitle}`);
      console.log(`[UHDMovies] Search results:`, searchResults);

      // If no results or only wrong year results, try fallback search with just main title
      if (searchResults.length === 0 || !searchResults.some(result => compareMedia(mediaInfo, result))) {
        console.log(`[UHDMovies] Primary search failed or no matches. Trying fallback search...`);

        // Extract main title (remove subtitles after colon, "and the", etc.)
        let fallbackTitle = mediaInfo.title.split(':')[0].trim();
        if (fallbackTitle.includes('and the')) {
          fallbackTitle = fallbackTitle.split('and the')[0].trim();
        }
        if (fallbackTitle !== searchTitle) {
          console.log(`[UHDMovies] Fallback search with: "${fallbackTitle}"`);
          const fallbackResults = await searchMovies(fallbackTitle);
          if (fallbackResults.length > 0) {
            searchResults = fallbackResults;
          }
        }
      }

      if (searchResults.length === 0) {
        console.log(`[UHDMovies] No search results found for "${mediaInfo.title}".`);
        // Don't cache empty results to allow retrying later
        return [];
      }

      // 4. Find the best matching result
      const matchingResults = searchResults.filter(result => compareMedia(mediaInfo, result));
      console.log(`[UHDMovies] Matching results:`, matchingResults);

      if (matchingResults.length === 0) {
        console.log(`[UHDMovies] No matching content found for "${mediaInfo.title}" (${mediaInfo.year}).`);
        // Don't cache empty results to allow retrying later
        return [];
      }

      let matchingResult;
      let scoredResults = null; // Declare outside the conditional

      if (matchingResults.length === 1) {
        matchingResult = matchingResults[0];
      } else {
        console.log(`[UHDMovies] Found ${matchingResults.length} matching results. Scoring to find the best...`);

        scoredResults = matchingResults.map(result => {
          const score = scoreResult(result.title, mediaType === 'tv' ? season : null, mediaInfo.title);
          console.log(`  - Score ${score}: ${result.title}`);
          return { ...result, score };
        }).sort((a, b) => b.score - a.score);

        matchingResult = scoredResults[0];
        console.log(`[UHDMovies] Best match selected with score ${matchingResult.score}: "${matchingResult.title}"`);
      }

      console.log(`[UHDMovies] Found matching content: "${matchingResult.title}"`);

      // 5. Extract SID links from the movie/show page
      console.time(`[UHDMovies] extractDownloadLinks for ${matchingResult.link}`);
      let downloadInfo = await (mediaType === 'tv' ? extractTvShowDownloadLinks(matchingResult.link, season, episode) : extractDownloadLinks(matchingResult.link, mediaInfo.year));
      console.timeEnd(`[UHDMovies] extractDownloadLinks for ${matchingResult.link}`);
      console.log(`[UHDMovies] Download info:`, downloadInfo);
      
      // Check if season was not found or episode extraction failed, and we have multiple results to try
      if (downloadInfo.links.length === 0 && matchingResults.length > 1 && scoredResults && 
          (downloadInfo.seasonNotFound || (mediaType === 'tv' && downloadInfo.title))) {
        console.log(`[UHDMovies] Season ${season} not found or episode extraction failed on best match. Trying next best match...`);
        
        // Try the next best match
        const nextBestMatch = scoredResults[1];
        console.log(`[UHDMovies] Trying next best match: "${nextBestMatch.title}"`);
        
        downloadInfo = await (mediaType === 'tv' ? extractTvShowDownloadLinks(nextBestMatch.link, season, episode) : extractDownloadLinks(nextBestMatch.link, mediaInfo.year));
        
        if (downloadInfo.links.length > 0) {
          console.log(`[UHDMovies] Successfully found links on next best match!`);
        } else {
          console.log(`[UHDMovies] Next best match also failed. No download links found.`);
        }
      }
      
      if (downloadInfo.links.length === 0) {
        console.log('[UHDMovies] No download links found on page.');
        // Don't cache empty results to allow retrying later
        return [];
      }

      // 6. Store original SID links for lazy resolution with validation
      console.log(`[UHDMovies] Found ${downloadInfo.links.length} SID links - validating before storing`);

      const maxLinksToProcess = Math.min(10, downloadInfo.links.length);
      const candidateLinks = downloadInfo.links.slice(0, maxLinksToProcess);
      let cachedLinks = [];
      // Validate each SID URL individually to filter out dead links
      // Process in parallel with timeout to keep scraping fast
      if (candidateLinks.length > 0) {
        console.log(`[UHDMovies] Validating ${candidateLinks.length} SID URLs to filter out dead links...`);

        const VALIDATION_TIMEOUT = 8000; // 8 seconds per SID validation
        const validatedLinks = [];

        // Validate all links in parallel
        const validationPromises = candidateLinks.map(async (linkInfo) => {
          if (!linkInfo.link) return null;

          try {
            // Race the validation against a timeout
            const validationPromise = resolveSidToDriveleech(linkInfo.link);
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Validation timeout')), VALIDATION_TIMEOUT)
            );

            const driveleechUrl = await Promise.race([validationPromise, timeoutPromise]);

            // Check if it resolves to a dead/invalid/category URL
            // Be more specific: category URLs typically point to directories, while file URLs point to specific files
            const invalidPatterns = [
              'uhdmovies.eu/4k-hdr/',
              'uhdmovies.rip/4k-hdr/',
              'uhdmovies.eu/movies/',
              'uhdmovies.rip/movies/',
              'uhdmovies.eu/1080p-uhd/',
              'uhdmovies.rip/1080p-uhd/',
              'uhdmovies.eu/1080p-60fps/',
              'uhdmovies.rip/1080p-60fps/',
              'uhdmovies.eu/1080p-10bit/',
              'uhdmovies.rip/1080p-10bit/',
              'uhdmovies.eu/2160p-movies/',
              'uhdmovies.rip/2160p-movies/',
              'uhdmovies.eu/3d-movies/',
              'uhdmovies.rip/3d-movies/'
            ];

            // Check if URL ends with / which typically indicates a category/directory page
            // Exception: zfile URLs which are valid file URLs that end with /
            const isCategoryPage = (!driveleechUrl.includes('/zfile/') && driveleechUrl.endsWith('/')) ||
                                 invalidPatterns.some(pattern => driveleechUrl.includes(pattern));
            
            const isInvalid = !driveleechUrl ||
                             driveleechUrl === linkInfo.link ||
                             isCategoryPage;

            if (isInvalid) {
              console.log(`[UHDMovies] ❌ SID resolved to invalid/category URL: ${driveleechUrl?.substring(0, 50) || 'null'}, skipping`);
              return null;
            }

            // Additionally validate that the resolved driveleech URL itself is not dead
            // by checking if it redirects to a valid file page
            try {
              // Follow redirects to get to the actual file page - allow more redirects
              const driveleechValidation = await makeRequest(driveleechUrl, { 
                maxRedirects: 8, // Allow more redirects to reach file page
                timeout: 8000 // Slightly longer timeout for complex redirects
              });
              
              // Check if final page is a valid file page by looking for expected elements
              if (driveleechValidation && driveleechValidation.data) {
                const $test = cheerio.load(driveleechValidation.data);
                
                // Check for common elements in valid file pages on final redirected page
                // Specifically look for zfile/ links which are the valid cloud resume links
                const hasFileElements = $test('li.list-group-item:contains("Size")').length > 0 ||
                                       $test('a[href*="workers.dev"]').length > 0 ||
                                       $test('a[href*="googleusercontent"]').length > 0 ||
                                       $test('a:contains("Resume Cloud")').length > 0 ||
                                       $test('a:contains("Cloud Resume Download")').length > 0 ||
                                       $test('a:contains("Instant Download")').length > 0 ||
                                       $test('a:contains("Resume Worker Bot")').length > 0 ||
                                       $test('a.btn-success:contains("Download")').length > 0 ||
                                       $test('a.btn-warning:contains("Resume")').length > 0 ||
                                       // Most importantly, look for zfile links which are the valid cloud resume links
                                       $test('a[href*="/zfile/"]').length > 0 ||
                                       driveleechValidation.data.includes('video-downloads.googleusercontent') ||
                                       driveleechValidation.data.includes('/zfile/') ||
                                       driveleechValidation.data.includes('Resume Cloud') ||
                                       driveleechValidation.data.includes('Cloud Resume') ||
                                       driveleechValidation.data.includes('Instant Download') ||
                                       driveleechValidation.data.includes('Resume Worker Bot') ||
                                       driveleechValidation.data.includes('downloadBtn') ||
                                       // Check for JavaScript redirects which indicate valid links
                                       driveleechValidation.data.includes('window.location.replace') ||
                                       driveleechValidation.data.includes('window.location.href') ||
                                       driveleechValidation.data.includes('/file/');
                
                // Enhanced validation: specifically check for zfile links which are the gold standard
                const hasZfileLinks = $test('a[href*="/zfile/"]').length > 0 ||
                                     driveleechValidation.data.includes('/zfile/') ||
                                     // Look for the specific pattern in JavaScript redirects
                                     (driveleechValidation.data.includes('window.location.replace') && 
                                      driveleechValidation.data.includes('/file/'));
                
                if (!hasFileElements) {
                  console.log(`[UHDMovies] ❌ Resolved driveleech URL appears to be dead/invalid page: ${driveleechUrl.substring(0, 100)}..., skipping`);
                  console.log(`[UHDMovies]     Final redirected URL: ${driveleechValidation.request.res.responseUrl || 'unknown'}`);
                  console.log(`[UHDMovies]     Page content snippet: ${driveleechValidation.data.substring(0, 500)}`);
                  return null;
                } else {
                  console.log(`[UHDMovies] ✅ Valid file page detected for: ${driveleechUrl.substring(0, 100)}...`);
                  // If we found zfile links, this is especially good
                  if (hasZfileLinks) {
                    console.log(`[UHDMovies] 🎯 High-quality zfile link detected, prioritizing this result`);
                  }
                }
              }
            } catch (validationError) {
              // If DNS resolution fails, but the SID link itself resolved correctly to a driveleech URL,
              // we should still consider it potentially valid since the issue might be temporary
              const errorMessage = validationError.message.toLowerCase();
              if (errorMessage.includes('enotfound') || errorMessage.includes('dns')) {
                console.log(`[UHDMovies] ⚠️ DNS resolution failed for driveleech URL: ${validationError.message}, but SID resolution was successful. Considering as potentially valid.`);
                console.log(`[UHDMovies] ✅ Accepting driveleech URL despite DNS issues: ${driveleechUrl.substring(0, 100)}...`);
                // Still consider it valid since SID resolution succeeded
              } else {
                console.log(`[UHDMovies] ❌ Driveleech URL validation failed: ${validationError.message}, skipping`);
                return null;
              }
            }

            console.log(`[UHDMovies] ✅ SID validated: ${linkInfo.rawQuality?.substring(0, 60) || linkInfo.quality}`);
            return {
              quality: linkInfo.quality,
              rawQuality: linkInfo.rawQuality,
              url: linkInfo.link,  // Original SID URL, not resolved!
              size: linkInfo.size || 'Unknown',
              languageInfo: linkInfo.languageInfo || [], // Include language info from page content
              needsResolution: true
            };
          } catch (validationError) {
            console.log(`[UHDMovies] ❌ SID validation failed: ${validationError.message}, skipping`);
            return null;
          }
        });

        // Wait for all validations to complete
        const results = await Promise.all(validationPromises);
        cachedLinks = results.filter(Boolean);

        console.log(`[UHDMovies] Validation complete: ${cachedLinks.length}/${candidateLinks.length} links are valid`);

        // Deduplicate streams based on quality and size (keep first occurrence)
        const seen = new Set();
        const originalCount = cachedLinks.length;
        cachedLinks = cachedLinks.filter(link => {
          const key = `${link.quality}_${link.size}_${link.rawQuality}`;
          if (seen.has(key)) {
            console.log(`[UHDMovies] Removing duplicate: ${link.rawQuality?.substring(0, 60) || link.quality}`);
            return false;
          }
          seen.add(key);
          return true;
        });

        if (originalCount > cachedLinks.length) {
          console.log(`[UHDMovies] Removed ${originalCount - cachedLinks.length} duplicate stream(s)`);
        }
      } else {
        cachedLinks = [];
      }

    if (!cachedLinks || cachedLinks.length === 0) {
      console.log('[UHDMovies] No SID URLs found after scraping/cache check.');
      return [];
    }

    // 8. Process cached streams (they contain original SID URLs for lazy resolution)
    console.log(`[UHDMovies] Processing ${cachedLinks.length} cached stream(s) with SID URLs for lazy resolution`);
    const streams = cachedLinks.map((streamInfo) => {
      try {
        // Streams contain original SID URLs (not resolved - lazy resolution)
        if (!streamInfo.url) {
          console.log(`[UHDMovies] Stream has no URL, skipping`);
          return null;
        }

        const rawQuality = streamInfo.rawQuality || '';
        const codecs = extractCodecs(rawQuality);
        const cleanQuality = streamInfo.quality || 'Unknown';
        const size = streamInfo.size || 'Unknown';

        const resolution = getResolutionFromName(cleanQuality);
        // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
        let resolutionLabel;
        if (resolution === '2160p') {
          resolutionLabel = '4k';
        } else if (resolution === '1080p') {
          resolutionLabel = '1080p';
        } else if (resolution === '720p') {
          resolutionLabel = '720p';
        } else if (resolution === '480p') {
          resolutionLabel = '480p';
        } else {
          resolutionLabel = resolution; // fallback for other values
        }

        const name = `${STREAM_NAME_MAP.httpstreaming}\n${resolutionLabel || 'N/A'}`;

        // Extract languages from quality/title string using centralized language mapping
        const detectedLanguages = detectLanguagesFromTitle(rawQuality);
        
        // Add languages detected from page content (if any)
        let combinedLanguages = [...detectedLanguages];
        if (streamInfo.languageInfo && Array.isArray(streamInfo.languageInfo) && streamInfo.languageInfo.length > 0) {
          // Merge page-detected languages with filename-detected languages
          combinedLanguages = [...new Set([...combinedLanguages, ...streamInfo.languageInfo])];
        }
        
        // Convert detected language keys to their flag representations
        const flagsSuffix = renderLanguageFlags(combinedLanguages);
        
        // Use rawQuality (full filename) instead of cleanQuality (parsed quality)
        const title = `${rawQuality}${flagsSuffix}\n💾 ${size} | UHDMovies`;

        return {
          name: name,
          title: title,
          url: streamInfo.url,  // Original SID URL (will be resolved on-demand)
          quality: streamInfo.quality,
          size: size,
          fullTitle: rawQuality,
          resolution: resolution,
          codecs: codecs,
          needsResolution: streamInfo.needsResolution,  // Flag for lazy resolution
          behaviorHints: { bingeGroup: `uhdmovies-${streamInfo.quality}` }
        };
      } catch (error) {
        console.error(`[UHDMovies] Error formatting stream: ${error.message}`);
        return null;
      }
    }).filter(Boolean);

    // Filter out streams with "Unknown Quality" - these are unparseable links with no metadata
    const validStreams = streams.filter(stream => {
      const isUnknown = stream.quality === 'Unknown Quality' ||
                        stream.fullTitle === 'Unknown Quality' ||
                        stream.size === 'Unknown';
      if (isUnknown) {
        console.log(`[UHDMovies] Filtering out unknown quality stream`);
        return false;
      }
      return true;
    });

    console.log(`[UHDMovies] Formatted ${validStreams.length} stream(s) (filtered ${streams.length - validStreams.length} unknown quality streams)`);
    console.log(`[UHDMovies] Final streams before sorting:`, validStreams);
    console.log(`[UHDMovies] Successfully processed ${validStreams.length} final stream links.`);

    // Sort by resolution first, then by size within each resolution group
    validStreams.sort((a, b) => {
      // Map resolution to numeric value for sorting (higher resolutions first)
      const resolutionPriority = {
        '2160p': 4,
        '1440p': 3,
        '1080p': 2,
        '720p': 1,
        '480p': 0,
        'other': -1
      };
      
      const resolutionA = resolutionPriority[a.resolution] || 0;
      const resolutionB = resolutionPriority[b.resolution] || 0;
      
      // If resolutions are different, sort by resolution (higher first)
      if (resolutionA !== resolutionB) {
        return resolutionB - resolutionA;
      }
      
      // If resolutions are the same, sort by size (larger first)
      const sizeA = parseSize(a.size);
      const sizeB = parseSize(b.size);
      return sizeB - sizeA;
    });
    // Apply language filtering if config is provided
    const filteredStreams = filterStreamsByLanguage(validStreams, config.Languages);

    return filteredStreams;
  } catch (error) {
    console.error(`[UHDMovies] A critical error occurred in getUHDMoviesStreams for ${tmdbId}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return [];
  }
}

/**
 * Resolve a UHDMovies SID URL to its final direct download link
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve SID to driveleech URL, 2) Follow redirect to file page, 3) Extract final URL
 * @param {string} sidUrl - The original SID URL that needs resolution
 * @returns {Promise<string|null>} - Final direct streaming URL
 */
async function resolveUHDMoviesUrl(sidUrl) {
  try {
    console.log('[UHDMOVIES-RESOLVE] Starting resolution for SID URL:', sidUrl.substring(0, 100) + '...');

    // Step 1: Resolve SID to driveleech URL
    let driveleechUrl = null;
    if (sidUrl.includes('tech.unblockedgames.world') || sidUrl.includes('tech.creativeexpressionsblog.com') || sidUrl.includes('tech.examzculture.in')) {
      console.log('[UHDMOVIES-RESOLVE] Resolving SID to driveleech URL...');
      driveleechUrl = await resolveSidToDriveleech(sidUrl);
    } else if (sidUrl.includes('driveseed.org') || sidUrl.includes('driveleech.net')) {
      // If it's already a driveseed/driveleech link, use it
      driveleechUrl = sidUrl;
      console.log('[UHDMOVIES-RESOLVE] URL is already a driveleech URL');
    }

    if (!driveleechUrl) {
      console.log('[UHDMOVIES-RESOLVE] Failed to resolve SID URL');
      return null;
    }

    console.log('[UHDMOVIES-RESOLVE] Resolved SID to driveleech URL:', driveleechUrl.substring(0, 100) + '...');

    // Check if the driveleech URL is a known dead/expired pattern
    if (driveleechUrl.includes('uhdmovies.eu/4k-hdr/') ||
        driveleechUrl.includes('uhdmovies.rip/4k-hdr/') ||
        driveleechUrl === 'https://uhdmovies.eu/4k-hdr/' ||
        driveleechUrl === 'https://uhdmovies.rip/4k-hdr/') {
      console.log('[UHDMOVIES-RESOLVE] ⚠️ Detected expired/dead SID URL (resolves to dead page), link is no longer valid');
      return null;
    }

    // Step 2: Follow driveleech redirect to final file page
    const { $, finalFilePageUrl } = await followRedirectToFilePage({
      redirectUrl: driveleechUrl,
      get: (url, opts) => makeRequest(url, opts),
      log: console
    });
    console.log(`[UHDMOVIES-RESOLVE] Resolved redirect to final file page: ${finalFilePageUrl}`);

    // Step 3: Extract final download URL from file page
    const origin = new URL(finalFilePageUrl).origin;
    const finalUrl = await extractFinalDownloadFromFilePage($, {
      origin,
      get: (url, opts) => makeRequest(url, opts),
      post: (url, data, opts) => axiosInstance.post(url.startsWith('http') ? (UHDMOVIES_PROXY_URL ? `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}` : url) : url, data, opts),
      validate: (url) => validateVideoUrl(url),
      log: console
    });

    if (!finalUrl) {
      console.log(`[UHDMOVIES-RESOLVE] Could not extract final video URL`);
      return null;
    }

    // Step 4: Post-process video-leech.pro and cdn.video-leech.pro links to extract Google URLs
    let processedUrl = finalUrl;
    if (finalUrl.includes('video-leech.pro') || finalUrl.includes('cdn.video-leech.pro')) {
      try {
        console.log(`[UHDMOVIES-RESOLVE] Processing video-leech link to extract Google URL: ${finalUrl}`);
        const response = await makeRequest(finalUrl, {
          maxRedirects: 5,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        });

        if (response && response.request && response.request.res && response.request.res.responseUrl) {
          const redirectedUrl = response.request.res.responseUrl;
          if (redirectedUrl.includes('video-seed.pro') && redirectedUrl.includes('?url=')) {
            try {
              const urlObj = new URL(redirectedUrl);
              const urlParam = urlObj.searchParams.get('url');
              if (urlParam && urlParam.includes('googleusercontent.com')) {
                console.log(`[UHDMOVIES-RESOLVE] Extracted Google URL from video-seed.pro redirect: ${urlParam}`);
                processedUrl = urlParam;
              }
            } catch (urlParseError) {
              console.log(`[UHDMOVIES-RESOLVE] URL parsing failed: ${urlParseError.message}`);
            }
          }
        }

        if (response && response.data && processedUrl === finalUrl) {
          const html = response.data;
          const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
          if (googleUrlMatch) {
            console.log(`[UHDMOVIES-RESOLVE] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
            processedUrl = googleUrlMatch[0];
          }
        }
      } catch (videoLeechError) {
        console.log(`[UHDMOVIES-RESOLVE] Video-leech processing failed: ${videoLeechError.message}`);
      }
    }

    console.log('[UHDMOVIES-RESOLVE] Successfully resolved to:', processedUrl.substring(0, 100) + '...');
    return processedUrl;
  } catch (error) {
    console.error('[UHDMOVIES-RESOLVE] Error resolving UHDMovies stream:', error.message);
    return null;
  }
}

export { getUHDMoviesStreams, resolveUHDMoviesUrl };