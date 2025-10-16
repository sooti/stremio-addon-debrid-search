import axios from 'axios';
import * as cheerio from 'cheerio';
import { URLSearchParams, URL } from 'url';
import FormData from 'form-data';
import { CookieJar } from 'tough-cookie';
import * as MongoCache from './common/mongo-cache.js';
import { followRedirectToFilePage, extractFinalDownloadFromFilePage, resolveSidToRedirect } from './util/linkResolver.js';
import path from 'path';
import { fileURLToPath } from 'url';

import { getResolutionFromName, formatSize } from './common/torrent-utils.js';
import { STREAM_NAME_MAP } from './stream-provider.js';
import Cinemeta from './util/cinemeta.js';

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

// Language flags and functions
const LANG_FLAGS = {
  en: '🇬🇧', fr: '🇫🇷', es: '🇪🇸', de: '🇩🇪', ru: '🇷🇺', it: '🇮🇹', pt: '🇵🇹',
  pl: '🇵🇱', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', ar: '🇦🇪', hi: '🇮🇳', nl: '🇳🇱',
  sv: '🇸🇪', no: '🇳🇴', da: '🇩🇰', fi: '🇫🇮', tr: '🇹🇷', he: '🇮🇱', id: '🇮🇩',
  cs: '🇨🇿', hu: '🇭🇺', ro: '🇷🇴', el: '🇬🇷', th: '🇹🇭'
};

function renderLangFlags(langs) {
  if (!Array.isArray(langs) || langs.length === 0) return '';
  const unique = Array.from(new Set(langs.map(x => String(x).toLowerCase())));
  const flags = unique.map(code => LANG_FLAGS[code]).filter(Boolean);
  return flags.length ? ` ${flags.join('')}` : '';
}

function filterByLanguage(streams, languages) {
    if (!languages || languages.length === 0) {
        return streams;
    }
    return streams.filter(stream => {
        const streamLangs = stream.title.match(/\\b(English|French|Spanish|German|Italian|Portuguese|Russian|Hindi|Japanese|Korean|Chinese|Arabic|Turkish|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Czech|Hungarian|Romanian|Greek|Hebrew|Thai)\\b/gi) || [];
        const streamLangCodes = streamLangs.map(lang => Object.keys(LANG_FLAGS).find(key => LANG_FLAGS[key] === LANG_FLAGS[lang.toLowerCase().slice(0, 2)]));
        return languages.some(lang => streamLangCodes.includes(lang));
    });
}

// --- Proxy Configuration ---
const UHDMOVIES_PROXY_URL = process.env.UHDMOVIES_PROXY_URL;
if (UHDMOVIES_PROXY_URL) {
  console.log(`[UHDMovies] Proxy support enabled: ${UHDMOVIES_PROXY_URL}`);
} else {
  console.log('[UHDMovies] No proxy configured, using direct connections');
}

// --- Domain Fetching ---
let uhdMoviesDomain = 'https://uhdmovies.email'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = 1 * 60 * 1000; // 1 minute

async function getUHDMoviesDomain() {
  const now = Date.now();
  if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
    return uhdMoviesDomain;
  }

  try {
    console.log('[UHDMovies] Fetching latest domain...');
    const response = await makeRequest('https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json', { timeout: 10000 });
    if (response.data && response.data.UHDMovies) {
      uhdMoviesDomain = response.data.UHDMovies;
      domainCacheTimestamp = now;
      console.log(`[UHDMovies] Updated domain to: ${uhdMoviesDomain}`);
    } else {
      console.warn('[UHDMovies] Domain JSON fetched, but "UHDMovies" key was not found. Using fallback.');
    }
  } catch (error) {
    console.error(`[UHDMovies] Failed to fetch latest domain, using fallback. Error: ${error.message}`);
  }
  return uhdMoviesDomain;
}

// Constants

// --- Caching Helper Functions ---
const getFromCache = async (key) => {
    if (!MongoCache.isEnabled()) {
        return null;
    }
    const collection = await MongoCache.getCollection();
    if (!collection) {
        return null;
    }
    const cached = await collection.findOne({ _id: key });
    return cached ? cached.data : null;
};

const saveToCache = async (key, data) => {
    if (!MongoCache.isEnabled()) {
        return;
    }
    const collection = await MongoCache.getCollection();
    if (!collection) {
        return;
    }
    const cacheDoc = {
        _id: key,
        data: data,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) // 6 hours
    };
    await collection.updateOne({ _id: key }, { $set: cacheDoc }, { upsert: true });
};

// Configure axios with headers to mimic a browser
// Configure axios instance with optional proxy support
const createAxiosInstance = () => {
  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0'
    },
    timeout: 60000
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

// Proxy wrapper function
const makeRequest = async (url, options = {}) => {
  if (UHDMOVIES_PROXY_URL) {
    // Route through proxy
    const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
    console.log(`[UHDMovies] Making proxied request to: ${url}`);
    return axiosInstance.get(proxiedUrl, options);
  } else {
    // Direct request
    console.log(`[UHDMovies] Making direct request to: ${url}`);
    return axiosInstance.get(url, options);
  }
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

    const response = await makeRequest(searchUrl);
    const $ = cheerio.load(response.data);

    const searchResults = [];

    // New logic for grid-based search results
    $('article.gridlove-post').each((index, element) => {
      const linkElement = $(element).find('a[href*="/download-"]');
      if (linkElement.length > 0) {
        const link = linkElement.first().attr('href');
        // Prefer the 'title' attribute, fallback to h1 text
        const title = linkElement.first().attr('title') || $(element).find('h1.sanket').text().trim();

        if (link && title && !searchResults.some(item => item.link === link)) {
          searchResults.push({
            title,
            link: link.startsWith('http') ? link : `${baseUrl}${link}`
          });
        }
      }
    });

    // Fallback for original list-based search if new logic fails
    if (searchResults.length === 0) {
      console.log('[UHDMovies] Grid search logic found no results, trying original list-based logic...');
      $('a[href*="/download-"]').each((index, element) => {
        const link = $(element).attr('href');
        // Avoid duplicates by checking if link already exists in results
        if (link && !searchResults.some(item => item.link === link)) {
          const title = $(element).text().trim();
          if (title) {
            searchResults.push({
              title,
              link: link.startsWith('http') ? link : `${baseUrl}${link}`
            });
          }
        }
      });
    }

    console.log(`[UHDMovies] Found ${searchResults.length} results`);
    return searchResults;
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

              console.log(`[UHDMovies] Found match: Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
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

              console.log(`[UHDMovies] Found match (maxbutton): Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
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

            console.log(`[UHDMovies] Found match via enhanced fallback (maxbutton): Quality='${qualityText}', Link='${link}'`);
            downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
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

              console.log(`[UHDMovies] Found match via original fallback: Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
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
          rawQuality: quality.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim()
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
console.log(`[UHDMovies] URL validation is ${URL_VALIDATION_ENABLED ? 'enabled' : 'disabled'}.`);

// Validate if a video URL is working (not 404 or broken)
async function validateVideoUrl(url, timeout = 5000) {
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

    // Check if status is OK (200-299) or partial content (206)
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

    if (getResponse.status >= 200 && getResponse.status < 500) {
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
  const normalizeString = (str) => String(str || '').toLowerCase().replace(/[^a-zA-Z0-9]/g, '');

  const titleWithAnd = mediaInfo.title.replace(/\s*&\s*/g, ' and ');
  const normalizedMediaTitle = normalizeString(titleWithAnd);
  const normalizedResultTitle = normalizeString(searchResult.title);

  console.log(`[UHDMovies] Comparing: "${mediaInfo.title}" (${mediaInfo.year}) vs "${searchResult.title}"`);
  console.log(`[UHDMovies] Normalized: "${normalizedMediaTitle}" vs "${normalizedResultTitle}"`);

  // Check if titles match or result title contains media title
  let titleMatches = normalizedResultTitle.includes(normalizedMediaTitle);

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
  const originalTitleLower = mediaInfo.title.toLowerCase();
  for (const keyword of negativeKeywords) {
    if (normalizedResultTitle.includes(keyword.replace(/\s/g, '')) && !originalTitleLower.includes(keyword)) {
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
function scoreResult(title, requestedSeason = null) {
  let score = 0;
  const lowerTitle = title.toLowerCase();

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

  // Create session with proxy support
  const session = await createProxiedSession(jar);

  try {
    // Step 0: Get the _wp_http value
    console.log("  [SID] Step 0: Fetching initial page...");
    const responseStep0 = await session.get(sidUrl);
    let $ = cheerio.load(responseStep0.data);
    const initialForm = $('#landing');
    const wp_http_step1 = initialForm.find('input[name="_wp_http"]').val();
    const action_url_step1 = initialForm.attr('action');

    if (!wp_http_step1 || !action_url_step1) {
      console.error("  [SID] Error: Could not find _wp_http in initial form.");
      return null;
    }

    // Step 1: POST to the first form's action URL
    console.log("  [SID] Step 1: Submitting initial form...");
    const step1Data = new URLSearchParams({ '_wp_http': wp_http_step1 });
    const responseStep1 = await session.post(action_url_step1, step1Data, {
      headers: { 'Referer': sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // Step 2: Parse verification page for second form
    console.log("  [SID] Step 2: Parsing verification page...");
    $ = cheerio.load(responseStep1.data);
    const verificationForm = $('#landing');
    const action_url_step2 = verificationForm.attr('action');
    const wp_http2 = verificationForm.find('input[name="_wp_http2"]').val();
    const token = verificationForm.find('input[name="token"]').val();

    if (!action_url_step2) {
      console.error("  [SID] Error: Could not find verification form.");
      return null;
    }

    // Step 3: POST to the verification URL
    console.log("  [SID] Step 3: Submitting verification...");
    const step2Data = new URLSearchParams({ '_wp_http2': wp_http2, 'token': token });
    const responseStep2 = await session.post(action_url_step2, step2Data, {
      headers: { 'Referer': responseStep1.request.res.responseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

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
      return null;
    }

    const finalUrl = new URL(finalLinkPath, origin).href;
    console.log(`  [SID] Dynamic link found: ${finalUrl}`);
    console.log(`  [SID] Dynamic cookie found: ${cookieName}`);

    // Step 5: Set cookie and make final request
    console.log("  [SID] Step 5: Setting cookie and making final request...");
    await jar.setCookie(`${cookieName}=${cookieValue}`, origin);

    const finalResponse = await session.get(finalUrl, {
      headers: { 'Referer': responseStep2.request.res.responseUrl }
    });

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
    return null;

  } catch (error) {
    console.error(`  [SID] Error during SID resolution: ${error.message}`);
    if (error.response) {
      console.error(`  [SID] Status: ${error.response.status}`);
    }
    return null;
  }
}

// Main function to get streams for TMDB content
async function getUHDMoviesStreams(imdbId, tmdbId, mediaType = 'movie', season = null, episode = null, config = {}) {
  console.log(`[UHDMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);

  const cacheKey = `uhd_final_v22_${tmdbId}_${mediaType}${season ? `_s${season}e${episode}` : ''}`;

  try {
    // 1. Check cache first
    let cachedLinks = await getFromCache(cacheKey);
    if (cachedLinks && cachedLinks.length > 0) {
      console.log(`[UHDMovies] Cache HIT for ${cacheKey}. Using ${cachedLinks.length} cached Driveleech links.`);
    } else {
      if (cachedLinks && cachedLinks.length === 0) {
        console.log(`[UHDMovies] Cache contains empty data for ${cacheKey}. Refetching from source.`);
      } else {
        console.log(`[UHDMovies] Cache MISS for ${cacheKey}. Fetching from source.`);
      }
      console.log(`[UHDMovies] Cache MISS for ${cacheKey}. Fetching from source.`);
      // 2. If cache miss, get Cinemeta info to perform search
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
          const score = scoreResult(result.title, mediaType === 'tv' ? season : null);
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

      // 6. Resolve SID links → driveleech → final video URLs in one pass (don't cache intermediate URLs)
      console.time(`[UHDMovies] Resolving ${downloadInfo.links.length} links to final video URLs`);
      console.log(`[UHDMovies] Resolving ${downloadInfo.links.length} link(s) through full redirect chain to final video URLs...`);
      const resolutionPromises = downloadInfo.links.slice(0, 10).map(async (linkInfo) => {
        try {
          let driveleechUrl = null;

          // Step 1: Resolve SID to driveleech URL
          if (linkInfo.link && (linkInfo.link.includes('tech.unblockedgames.world') || linkInfo.link.includes('tech.creativeexpressionsblog.com') || linkInfo.link.includes('tech.examzculture.in'))) {
            driveleechUrl = await resolveSidToDriveleech(linkInfo.link);
          } else if (linkInfo.link && (linkInfo.link.includes('driveseed.org') || linkInfo.link.includes('driveleech.net'))) {
            // If it's already a direct driveseed/driveleech link, use it
            driveleechUrl = linkInfo.link;
          }

          if (!driveleechUrl) {
            console.log(`[UHDMovies] Could not resolve SID link for ${linkInfo.quality}`);
            return null;
          }

          console.log(`[UHDMovies] Resolved SID to driveleech URL for ${linkInfo.quality}: ${driveleechUrl}`);

          // Step 2: Follow driveleech redirect to final file page
          const { $, finalFilePageUrl } = await followRedirectToFilePage({
            redirectUrl: driveleechUrl,
            get: (url, opts) => makeRequest(url, opts),
            log: console
          });
          console.log(`[UHDMovies] Resolved redirect to final file page: ${finalFilePageUrl}`);

          // Step 3: Extract file size and name information
          let sizeInfo = 'Unknown';
          let fileName = null;

          const sizeElement = $('li.list-group-item:contains("Size :")').text();
          if (sizeElement) {
            const sizeMatch = sizeElement.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/);
            if (sizeMatch) {
              sizeInfo = sizeMatch[1];
            }
          }

          const nameElement = $('li.list-group-item:contains("Name :")');
          if (nameElement.length > 0) {
            fileName = nameElement.text().replace('Name :', '').trim();
          } else {
            const h5Title = $('div.card-header h5').clone().children().remove().end().text().trim();
            if (h5Title) {
              fileName = h5Title.replace(/\[.*?\]/g, '').trim();
            }
          }

          // Step 4: Extract final download URL from file page
          const origin = new URL(finalFilePageUrl).origin;
          const finalUrl = await extractFinalDownloadFromFilePage($, {
            origin,
            get: (url, opts) => makeRequest(url, opts),
            post: (url, data, opts) => axiosInstance.post(url.startsWith('http') ? (UHDMOVIES_PROXY_URL ? `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}` : url) : url, data, opts),
            validate: (url) => validateVideoUrl(url),
            log: console
          });

          if (!finalUrl) {
            console.log(`[UHDMovies] Could not extract final video URL for ${linkInfo.quality}`);
            return null;
          }

          // Post-process video-leech.pro and cdn.video-leech.pro links to extract Google URLs
          let processedUrl = finalUrl;
          if (finalUrl.includes('video-leech.pro') || finalUrl.includes('cdn.video-leech.pro')) {
            try {
              console.log(`[UHDMovies] Processing video-leech link to extract Google URL: ${finalUrl}`);
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
                      console.log(`[UHDMovies] Extracted Google URL from video-seed.pro redirect: ${urlParam}`);
                      processedUrl = urlParam;
                    }
                  } catch (urlParseError) {
                    console.log(`[UHDMovies] URL parsing failed: ${urlParseError.message}`);
                  }
                }
              }

              if (response && response.data && processedUrl === finalUrl) {
                const html = response.data;
                const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
                if (googleUrlMatch) {
                  console.log(`[UHDMovies] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
                  processedUrl = googleUrlMatch[0];
                }
              }
            } catch (videoLeechError) {
              console.log(`[UHDMovies] Video-leech processing failed: ${videoLeechError.message}`);
            }
          }

          // Return the complete stream info
          return {
            quality: linkInfo.quality,
            rawQuality: linkInfo.rawQuality,
            size: sizeInfo,
            fileName: fileName,
            url: processedUrl
          };
        } catch (error) {
          console.error(`[UHDMovies] Error resolving ${linkInfo.quality}: ${error.message}`);
          return null;
        }
      });

      cachedLinks = (await Promise.all(resolutionPromises)).filter(Boolean);
      console.timeEnd(`[UHDMovies] Resolving ${downloadInfo.links.length} links to final video URLs`);
      console.log(`[UHDMovies] Successfully resolved ${cachedLinks.length} final video URLs`);

      // 7. Cache the final stream results (not intermediate driveleech URLs)
      if (cachedLinks.length > 0) {
        console.log(`[UHDMovies] Caching ${cachedLinks.length} final video streams for key: ${cacheKey}`);
        await saveToCache(cacheKey, cachedLinks);
      } else {
        console.log(`[UHDMovies] No final video URLs could be resolved. Not caching to allow retrying later.`);
        return [];
      }
    }

    if (!cachedLinks || cachedLinks.length === 0) {
      console.log('[UHDMovies] No final video URLs found after scraping/cache check.');
      return [];
    }

    // 8. Process cached streams (they're already final URLs now)
    console.log(`[UHDMovies] Processing ${cachedLinks.length} cached stream(s)`);
    const streamPromises = cachedLinks.map(async (streamInfo) => {
      try {
        // Streams are already fully resolved with final URLs
        if (!streamInfo.url) {
          console.log(`[UHDMovies] Stream has no URL, skipping`);
          return null;
        }

        const rawQuality = streamInfo.rawQuality || '';
        const codecs = extractCodecs(rawQuality);
        const cleanFileName = streamInfo.fileName ? streamInfo.fileName.replace(/\.[^/.]+$/, "").replace(/[._]/g, ' ') : (streamInfo.quality || 'Unknown');

        const resolution = getResolutionFromName(cleanFileName);
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

        // Extract languages from quality/title string
        const langs = rawQuality.match(/\b(English|French|Spanish|German|Italian|Portuguese|Russian|Hindi|Japanese|Korean|Chinese|Arabic|Turkish|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Czech|Hungarian|Romanian|Greek|Hebrew|Thai)\b/gi) || [];
        const langCodes = langs.map(lang => Object.keys(LANG_FLAGS).find(key => LANG_FLAGS[key] === LANG_FLAGS[lang.toLowerCase().slice(0, 2)]));
        const title = `${cleanFileName}${renderLangFlags(langCodes)}\n💾 ${streamInfo.size} | UHDMovies`;

        // Properly encode the URL to handle special characters in filenames
        const encodedUrl = streamInfo.url ? encodeUrlForStreaming(streamInfo.url) : streamInfo.url;

        return {
          name: name,
          title: title,
          url: encodedUrl,
          quality: streamInfo.quality,
          size: streamInfo.size,
          fileName: streamInfo.fileName,
          fullTitle: rawQuality,
          resolution: resolution,
          codecs: codecs,
          behaviorHints: { bingeGroup: `uhdmovies-${streamInfo.quality}` }
        };
      } catch (error) {
        console.error(`[UHDMovies] Error formatting stream: ${error.message}`);
        return null;
      }
    });

    const streams = (await Promise.all(streamPromises)).filter(Boolean);
    console.log(`[UHDMovies] Formatted ${streams.length} stream(s)`);
    console.log(`[UHDMovies] Final streams before sorting:`, streams);
    console.log(`[UHDMovies] Successfully processed ${streams.length} final stream links.`);

    // Sort by resolution first, then by size within each resolution group
    streams.sort((a, b) => {
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
    const filteredStreams = filterByLanguage(streams, config.Languages);


    return filteredStreams;
  } catch (error) {
    console.error(`[UHDMovies] A critical error occurred in getUHDMoviesStreams for ${tmdbId}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return [];
  }
}

export { getUHDMoviesStreams };