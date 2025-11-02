import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import * as config from '../config.js';
// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;
import { Snowfl } from 'snowfl-api';
import { exec } from 'child_process';
import { promisify } from 'util';
// Import utilities
import { getHashFromMagnet, sizeToBytes, deduplicateAndKeepLargest } from './torrent-utils.js';
import * as scraperCache from '../util/scraper-cache.js';
import proxyManager from '../util/proxy-manager.js';
import debridProxyManager from '../util/debrid-proxy.js';

const execPromise = promisify(exec);

// Create axios instance with proxy support for scrapers
const axiosWithProxy = axios.create(debridProxyManager.getAxiosConfig('scrapers'));

// ---------------------------------------------------------------------------------
// Unique Timer Label Generation
// ---------------------------------------------------------------------------------
let timerCounter = 0;

/**
 * Generate a unique timer label to prevent conflicts with concurrent requests
 * @param {string} logPrefix - Log prefix (e.g., 'RD', 'TB')
 * @param {string} scraperName - Scraper name (e.g., 'Jackett', '1337x')
 * @param {string} suffix - Optional suffix (e.g., ':en', ':none')
 * @returns {string} Unique timer label
 */
function createTimerLabel(logPrefix, scraperName, suffix = '') {
  const id = ++timerCounter;
  return `[${logPrefix} TIMER] ${scraperName}${suffix}#${id}`;
}

// List of keywords to identify and filter out junk/bootleg files.
const JUNK_KEYWORDS = [
    'CAM', 'HDCAM', 'CAMRIP',
    'TS', 'HDTS', 'TELESYNC',
    'TC', 'HDTC', 'TELECINE',
    'SCR', 'SCREENER', 'DVDSCR', 'BDSCR',
    'R5', 'R6', 'WORKPRINT', 'WP', 'HDRIP'
];

// Regex to test for junk keywords as whole words (case-insensitive).
const JUNK_REGEX = new RegExp(`$b(${JUNK_KEYWORDS.join('|')})$b`, 'i');

// Simple language token check in the title using common markers
const SIMPLE_LANG_MAP = {
    en: ['en', 'eng', 'english'],
    ru: ['ru', 'rus', 'russian'],
    fr: ['fr', 'fra', 'french', 'vostfr', 'vf', 'vff', 'truefrench'],
    es: ['es', 'esp', 'spanish', 'lat', 'latam', 'cast', 'castellano', 'latino'],
    de: ['de', 'ger', 'german', 'deu'],
    it: ['it', 'ita', 'italian', 'italiano'],
    pt: ['pt', 'por', 'portuguese'],
    pl: ['pl']
};
function detectSimpleLangs(title) {
    if (!title) return [];
    const sanitized = String(title).toLowerCase().replace(/[$[$]$($)$._$-]+/g, ' ');
    const words = new Set(sanitized.split(/$s+/).filter(Boolean));
    const hits = new Set();
    for (const [code, tokens] of Object.entries(SIMPLE_LANG_MAP)) {
        for (const t of tokens) {
            if (words.has(t)) { hits.add(code); break; }
        }
    }
    return Array.from(hits);
}
function hasSimpleLanguageToken(title, codes = []) {
    if (!title || !Array.isArray(codes) || codes.length === 0) return true;
    const nonEnglish = codes.filter(c => c && c.toLowerCase() !== 'en');
    if (nonEnglish.length === 0) return true;
    const sanitized = String(title).toLowerCase().replace(/[$[$]$($)$._$-]+/g, ' ');
    const words = new Set(sanitized.split(/$s+/).filter(Boolean));
    for (const code of nonEnglish) {
        const key = String(code).toLowerCase();
        const tokens = SIMPLE_LANG_MAP[key] || [key];
        for (const t of tokens) {
            if (words.has(t.toLowerCase())) return true;
        }
    }
    return false;
}
function hasAnyNonEnglishToken(title) {
    if (!title) return false;
    const sanitized = String(title).toLowerCase().replace(/[$[$]$($)$._$-]+/g, ' ');
    const words = new Set(sanitized.split(/$s+/).filter(Boolean));
    for (const [code, tokens] of Object.entries(SIMPLE_LANG_MAP)) {
        if (code === 'en') continue;
        for (const t of tokens) {
            if (words.has(t)) return true;
        }
    }
    return false;
}

/**
 * Checks if a torrent title is likely a junk/bootleg copy.
 * @param {string} title The title of the torrent.
 * @returns {boolean} True if the title is NOT junk, false otherwise.
 */
function isNotJunk(title) {
    if (!title) return true; // Don't filter out items that have no title
    return !JUNK_REGEX.test(title);
}

/**
 * NEW WRAPPER FUNCTION: Processes raw scraper results to filter junk and deduplicate.
 * @param {Array<Object>} results - The raw results from a scraper.
 * @param {Object} config - The user's configuration object.
 * @returns {Array<Object>} - The cleaned, filtered, and deduplicated results.
 */
export function processAndDeduplicate(results, config = {}) {
    if (!Array.isArray(results)) return [];
    // 1. Filter out null/boolean entries and junk titles
    let filtered = results.filter(Boolean).filter(r => isNotJunk(r.Title));

    // 2. Language filtering per selected languages
    try {
        const selected = Array.isArray(config?.Languages) ? config.Languages.filter(Boolean) : [];
        const lower = selected.map(s => String(s).toLowerCase());
        const englishOnly = (lower.length === 1 && lower[0] === 'en');
        const noneSelected = lower.length === 0;
        if (englishOnly) {
            filtered = filtered.filter(r => !hasAnyNonEnglishToken(r.Title));
        } else if (!noneSelected) {
            filtered = filtered.filter(r => hasSimpleLanguageToken(r.Title, selected));
        }
    } catch (_) {}

    // 3. Deduplicate the filtered results, keeping the largest size for each title
    return deduplicateAndKeepLargest(filtered);
}

async function handleScraperError(error, scraperName, logPrefix) {
    if (!axios.isCancel(error)) {
        console.error(`[${logPrefix} SCRAPER] ${scraperName} search failed: ${error.message}`);
    }
}

export async function searchBitmagnet(query, signal, logPrefix, config) {
    const scraperName = 'Bitmagnet';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const base = (config?.BITMAGNET_URL || ENV.BITMAGNET_URL || '').replace(/\/$/, '');
        const limit = config?.TORZNAB_LIMIT ?? ENV.TORZNAB_LIMIT;
        // Increase timeout for Bitmagnet as it can be slow - use at least 10 seconds
        const timeout = Math.max(config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT, 2500);
        const url = `${base}?t=search&q=${encodeURIComponent(query)}&limit=${limit}`;
        const response = await axiosWithProxy.get(url, { timeout, signal });
        const parsedXml = await parseStringPromise(response.data);
        const items = parsedXml.rss.channel[0].item || [];
        const results = items.map(item => {
            const attrs = item['torznab:attr']?.reduce((acc, attr) => ({ ...acc, [attr.$.name]: attr.$.value }), {});
            if (!attrs?.infohash) return null;
            const title = item.title[0];
            return {
                Title: title, InfoHash: attrs.infohash,
                Size: parseInt(attrs.size) || 0,
                Seeders: parseInt(item.seeders?.[0]) || 0,
                Tracker: scraperName,
                Langs: detectSimpleLangs(title)
            };
        });
        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchJackett(query, signal, logPrefix, config) {
    const scraperName = 'Jackett';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const base = (config?.JACKETT_URL || ENV.JACKETT_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        // Enhanced error handling and debugging
        const apiKey = config?.JACKETT_API_KEY ?? ENV.JACKETT_API_KEY;
        if (!base) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} JACKETT_URL not configured`);
            return [];
        }

        if (!apiKey) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} JACKETT_API_KEY not configured`);
            return [];
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} attempting direct search across all indexers...`);
        const url = `${base}/api/v2.0/indexers/all/results`;
        const response = await axiosWithProxy.get(url, {
            params: { apikey: apiKey, Query: query },
            timeout, 
            signal,
            headers: {
                'User-Agent': 'Sooti/1.0',
                'Accept': 'application/json'
            }
        });
        
        const rawResults = response.data.Results || [];
        console.log(`[${logPrefix} SCRAPER] ${scraperName} direct search found ${rawResults.length} raw results from all indexers.`);
        
        // Debug log for first few direct search results
        if (rawResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} sample direct search results:`);
            rawResults.slice(0, 5).forEach((result, idx) => {
                console.log(`  ${idx + 1}. ${result.Title.substring(0, 60)}${result.Title.length > 60 ? '...' : ''} | ${Math.round(result.Size / (1024*1024*1024))}GB | ${result.Seeders} seeders | ${result.Tracker || result.tracker || 'Unknown'}`);
            });
        }
        
        const results = rawResults.slice(0, 200).map(r => ({
            Title: r.Title, 
            InfoHash: r.InfoHash, 
            Size: r.Size || 0, 
            Seeders: r.Seeders || r.seeders || 0,
            Tracker: `${scraperName} | ${r.Tracker || r.tracker || r.indexer || 'Unknown'}`,
            Langs: detectSimpleLangs(r.Title)
        }));
        
        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} direct search failed (${error.message}), trying fallback approaches...`);
        
        // Fallback: Try the legacy approach with lowercase 'q' parameter as final fallback
        try {
            const base = (config?.JACKETT_URL || ENV.JACKETT_URL || '').replace(/\/$/, '');
            const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
            const apiKey = config?.JACKETT_API_KEY ?? ENV.JACKETT_API_KEY;

            if (!base || !apiKey) {
                return [];
            }

            console.log(`[${logPrefix} SCRAPER] ${scraperName} trying legacy search approach with lowercase parameter...`);
            const searchUrl = `${base}/api/v2.0/indexers/all/results`;
            const response = await axiosWithProxy.get(searchUrl, {
                params: { 
                    apikey: apiKey,
                    q: query  // Legacy lowercase parameter
                },
                timeout,
                signal,
                headers: {
                    'User-Agent': 'Sooti/1.0',
                    'Accept': 'application/json'
                }
            });

            const rawResults = response.data.Results || [];
            console.log(`[${logPrefix} SCRAPER] ${scraperName} legacy search found ${rawResults.length} raw results.`);
            
            // Debug log for first few legacy search results
            if (rawResults.length > 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} sample legacy search results:`);
                rawResults.slice(0, 5).forEach((result, idx) => {
                    console.log(`  ${idx + 1}. ${result.Title.substring(0, 60)}${result.Title.length > 60 ? '...' : ''} | ${Math.round(result.Size / (1024*1024*1024))}GB | ${result.Seeders} seeders | ${result.Tracker || 'Unknown'}`);
                });
            }

            const results = rawResults.slice(0, 200).map(r => ({
                Title: r.Title, 
                InfoHash: r.InfoHash, 
                Size: r.Size || 0, 
                Seeders: r.Seeders || r.seeders || 0,
                Tracker: `${scraperName} | ${r.Tracker || r.tracker || 'Unknown'}`,
                Langs: detectSimpleLangs(r.Title)
            }));

            const processedResults = processAndDeduplicate(results, config);
            scraperCache.set(scraperName, query, config, processedResults);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing ${rawResults.length} raw results using legacy search.`);
            return processedResults;
        } catch (legacyError) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} legacy search also failed (${legacyError.message}).`);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} all approaches failed. The Jackett server might be down, misconfigured, or the API key may be incorrect.`);
            handleScraperError(error, scraperName, logPrefix);
            return [];
        }
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchZilean(title, season, episode, signal, logPrefix, config) {
    const scraperName = 'Zilean';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const query = season && episode ? `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : title;
    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const base = (config?.ZILEAN_URL || ENV.ZILEAN_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        let url = `${base}/dmm/filtered?query=${encodeURIComponent(title)}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;
        
        if (!base) throw new Error('Missing ZILEAN_URL');
        const response = await axiosWithProxy.get(url, { timeout, signal });
        let results = response.data || [];

        // Zilean-specific language filtering using the languages field
        const selected = Array.isArray(config?.Languages) ? config.Languages.filter(Boolean).map(s => String(s).toLowerCase()) : [];
        const englishOnly = (selected.length === 1 && selected[0] === 'en');
        const noneSelected = selected.length === 0;
        if (englishOnly) {
            results = results.filter(r => {
                const langs = Array.isArray(r.languages) ? r.languages.map(x => String(x).toLowerCase()) : [];
                return langs.length === 0 || langs.includes('en');
            });
        } else if (!noneSelected) {
            results = results.filter(r => {
                const langs = Array.isArray(r.languages) ? r.languages.map(x => String(x).toLowerCase()) : [];
                return selected.some(code => langs.includes(code));
            });
        }

        if (episode) {
            const targetEpisode = parseInt(episode);
            results = results.filter(result => {
                const episodes = Array.isArray(result.episodes) ? result.episodes : [];
                if (episodes.length === 0 || result.complete === true) return true; // Season pack
                return episodes.includes(targetEpisode);
            });
        }
        
        const limit = config?.ZILEAN_LIMIT ?? ENV.ZILEAN_LIMIT;
        const mappedResults = results.slice(0, limit).map(r => ({
            Title: r.raw_title,
            InfoHash: r.info_hash,
            Size: parseInt(r.size),
            Seeders: null,
            Tracker: `${scraperName} | DMM`
        }));
        const processedResults = processAndDeduplicate(mappedResults, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchTorrentio(mediaType, mediaId, signal, logPrefix, config) {
    const scraperName = 'Torrentio';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);
    
    const query = `${mediaType}:${mediaId}`;
    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }
    
    try {
        const base = (config?.TORRENTIO_URL || ENV.TORRENTIO_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const url = `${base}/stream/${mediaType}/${mediaId}.json`;
        const response = await axiosWithProxy.get(url, { timeout, signal });
        const dataPattern = /(?:👤 (\d+) )?💾 ([\d.]+ [KMGT]B)(?: ⚙️ (\w+))?/;
        const results = response.data.streams.slice(0, 200).map(stream => {
            const title = stream.title.split('\n')[0];
            const match = stream.title.match(dataPattern);
            const tracker = match?.[3] || 'Public';
            return {
                Title: title, InfoHash: stream.infoHash,
                Size: match ? sizeToBytes(match[2]) : 0,
                Seeders: match?.[1] ? parseInt(match[1]) : 0,
                Tracker: `${scraperName} | ${tracker}`,
                Langs: detectSimpleLangs(title)
            };
        });
        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchComet(mediaType, mediaId, signal, season, episode, logPrefix, config) {
    const scraperName = 'Comet';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const query = (mediaType === 'series' && season && episode) ? `${mediaId}:${season}:${episode}` : mediaId;
    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        let finalMediaId = mediaId;
        if (mediaType === 'series' && season && episode) {
            finalMediaId = `${mediaId}:${season}:${episode}`;
        }
        const base = (config?.COMET_URL || ENV.COMET_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const url = `${base}/stream/${mediaType}/${finalMediaId}.json`;
        const response = await axiosWithProxy.get(url, { timeout, signal });
        
        const results = (response.data.streams || []).slice(0, 200).map(stream => {
            const desc = stream.description;
            const title = desc.match(/💾 (.+)/)?.[1].trim() || 'Unknown Title';
            const seeders = parseInt(desc.match(/👤 (\d+)/)?.[1] || '0');
            const tracker = desc.match(/⚙️ (.+)/)?.[1].trim() || 'Public';
            return {
                Title: title, InfoHash: stream.infoHash,
                Size: stream.behaviorHints?.videoSize || 0,
                Seeders: seeders, Tracker: `${scraperName} | ${tracker}`,
                Langs: detectSimpleLangs(title)
            };
        });
        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchStremthru(mediaType, mediaId, signal, season, episode, logPrefix, config) {
    const scraperName = 'StremThru';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const query = `${mediaType}:${mediaId}`;
    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const base = (config?.STREMTHRU_URL || ENV.STREMTHRU_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build URL based on media type - use tvsearch or movie with imdbid
        let url;
        if (mediaType === 'series') {
            url = `${base}/v0/torznab/api?t=tvsearch&imdbid=${mediaId}`;
            if (season) url += `&season=${season}`;
            if (episode) url += `&ep=${episode}`;
        } else {
            url = `${base}/v0/torznab/api?t=movie&imdbid=${mediaId}`;
        }

        const response = await axiosWithProxy.get(url, { timeout, signal });
        const parsedXml = await parseStringPromise(response.data);

        // Add null checks for RSS structure
        if (!parsedXml?.rss?.channel?.[0]) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} returned invalid RSS structure.`);
            return [];
        }

        const items = parsedXml.rss.channel[0].item || [];
        const results = items.map(item => {
            const attrs = item['torznab:attr']?.reduce((acc, attr) => ({ ...acc, [attr.$.name]: attr.$.value }), {});
            if (!attrs?.infohash) return null;
            return {
                Title: item.title[0], InfoHash: attrs.infohash,
                Size: parseInt(attrs.size) || 0,
                Seeders: parseInt(item.seeders?.[0]) || 0,
                Tracker: scraperName,
                Langs: detectSimpleLangs(item.title[0])
            };
        });
        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

/**
 * Searches Snowfl for torrents using the snowfl-api package.
 *
 * @param {string} query The search term.
 * @param {AbortSignal} signal The AbortController signal for request cancellation.
 * @param {string} logPrefix A prefix for console log messages.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of torrent objects.
 */
export async function searchSnowfl(query, signal, logPrefix, config) {
    const scraperName = 'Snowfl';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    // Instantiate the Snowfl client
    const snowfl = new Snowfl();

    try {
        // --- REFACTORED LOGIC USING snowfl-api ---
        // Create a promise that rejects when the signal is aborted
        const abortPromise = new Promise((_, reject) => {
            if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
            }
            signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });

        // Race the API call against the abort promise
        const response = await Promise.race([
            snowfl.parse(query), // Default sort is 'NONE', matching the original logic
            abortPromise
        ]);

        // --- END OF REFACTORED LOGIC ---

        if (response.status !== 200 || !Array.isArray(response.data)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} returned a non-successful status or invalid data.`);
            return [];
        }

        // Map the API response to your standard torrent object format.
        const results = response.data.map(torrent => {
            if (!torrent.magnet) return null;

            const infoHash = getHashFromMagnet(torrent.magnet);
            if (!infoHash) return null;

            return {
                Title: torrent.name,
                InfoHash: infoHash,
                Size: sizeToBytes(torrent.size || '0 MB'),
                Seeders: parseInt(torrent.seeder) || 0,
                Tracker: `${scraperName} | ${torrent.site}`,
                Langs: detectSimpleLangs(torrent.name),
            };
        }).filter(Boolean); // Filter out any null entries

        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        console.log('the torrents we found:  ', processedResults);
        return processedResults;

    } catch (error) {
        // The centralized error handler will catch AbortError as well
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchTorrent9(searchKey, signal, logPrefix, config) {
    const scraperName = 'Torrent9';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, searchKey, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const limit = config?.TORRENT9_LIMIT || 50;
        const base = ((config?.TORRENT9_URL || ENV.TORRENT9_URL) || 'https://www.torrent9.town').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        const searchUrl = `${base}/recherche/${encodeURIComponent(searchKey)}`;
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${searchUrl}`);

        const searchResponse = await axiosWithProxy.get(searchUrl, {
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(searchResponse.data);
        const accumulated = [];
        const seen = new Set();

        // Parse the results table
        const allRows = $('div.table-responsive table.table-striped tbody tr');

        if (allRows.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} found no table rows in response`);
        }

        allRows.each((i, el) => {
            if (accumulated.length >= limit) return false;

            // Skip rows without td elements
            if ($(el).find('td').length === 0) return;

            const titleLink = $(el).find('td:first-child a');
            const title = titleLink.attr('title') || titleLink.text().trim();
            const detailPath = titleLink.attr('href');

            if (!detailPath || !title) return;

            const sizeText = $(el).find('td:nth-child(2)').text().trim();
            const seedersText = $(el).find('td:nth-child(3)').text().trim();

            // Extract the detail ID from the path (e.g., /detail/38634)
            const detailId = detailPath.split('/').pop();

            if (!detailId || seen.has(detailId)) return;
            seen.add(detailId);

            accumulated.push({
                Title: title,
                DetailPath: detailPath,
                DetailId: detailId,
                Size: sizeToBytes(sizeText),
                Seeders: parseInt(seedersText.match(/\d+/)?.[0]) || 0,
                Tracker: scraperName,
                Langs: detectSimpleLangs(title)
            });
        });

        // Now fetch magnet links from detail pages (in batches to avoid overwhelming the server)
        const batchSize = 5;
        const results = [];

        for (let i = 0; i < accumulated.length; i += batchSize) {
            const batch = accumulated.slice(i, i + batchSize);
            const detailPromises = batch.map(item =>
                axiosWithProxy.get(`${base}${item.DetailPath}`, {
                    timeout,
                    signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }).catch(() => null)
            );

            const responses = await Promise.all(detailPromises);

            for (let j = 0; j < responses.length; j++) {
                const response = responses[j];
                const item = batch[j];

                if (!response?.data) continue;

                try {
                    const $detail = cheerio.load(response.data);
                    const magnetLink = $detail('a[href^="magnet:"]').attr('href');

                    if (!magnetLink) continue;

                    const infoHash = getHashFromMagnet(magnetLink);
                    if (!infoHash) continue;

                    results.push({
                        Title: item.Title,
                        InfoHash: infoHash,
                        Size: item.Size,
                        Seeders: item.Seeders,
                        Tracker: item.Tracker,
                        Langs: item.Langs,
                        Magnet: magnetLink
                    });
                } catch (e) {
                    // Ignore individual parsing errors
                }
            }
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        scraperCache.set(scraperName, searchKey, config, processedResults);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

// Helper function to extract year from title
function extractYear(title) {
    const yearMatch = title.match(/\b(19|20)\d{2}\b/);
    return yearMatch ? parseInt(yearMatch[0]) : null;
}

// Helper function to check if title matches search query with year more strictly
function titleMatchesQuery(title, query) {
    // Extract the year and name from the query
    const yearMatch = query.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? parseInt(yearMatch[0]) : null;
    const namePart = year ? query.replace(/\b(19|20)\d{2}\b/, '').trim() : query.trim();
    
    // Normalize title for comparison (also removing common word separators)
    const normalizedTitle = title.toLowerCase().replace(/[._\-:]/g, ' ').trim();
    
    if (year) {
        // If a year was specified in query, check if title has the exact same year
        const titleYear = extractYear(title);
        const yearMatches = titleYear === year;
        
        // For the name part, we need exact word matching to prevent "dudes" matching "dude"
        if (namePart) {
            // Create a regex pattern that looks for the name as a whole word
            const escapedNamePart = namePart.replace(/[.*+?^${}()|[\]$]/g, '$$&');
            const exactNamePattern = new RegExp(`$b${escapedNamePart}$b`, 'i');
            const nameMatches = exactNamePattern.test(normalizedTitle);
            return nameMatches && yearMatches;
        } else {
            // If no name part (only year in query), just match the year
            return yearMatches;
        }
    } else {
        // If no year in query, just check if the full query matches
        const escapedQuery = query.replace(/[.*+?^${}()|[\]$]/g, '$$&');
        const exactQueryPattern = new RegExp(`$b${escapedQuery}$b`, 'i');
        return exactQueryPattern.test(normalizedTitle);
    }
}

export async function search1337x(query, signal, logPrefix, config) {
    const scraperName = '1337x';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const limit = config?.TORRENT_1337X_LIMIT || 200;
        const maxPages = config?.TORRENT_1337X_MAX_PAGES || 3;
        const base = ((config?.TORRENT_1337X_URL || ENV.TORRENT_1337X_URL) || 'https://1337x.bz').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        const results = [];
        const seen = new Set();

        // Determine how many pages to fetch based on limit and maxPages
        const pagesToFetch = Math.min(maxPages, Math.ceil(limit / 50)); // Assuming ~50 items per page
        
        // Create array of page numbers to fetch
        const pagePromises = [];
        for (let page = 1; page <= pagesToFetch; page++) {
            pagePromises.push(fetch1337xPage(base, query, page, timeout, signal, logPrefix, scraperName));
        }

        // Fetch all pages in parallel
        const allPageResults = await Promise.all(pagePromises);
        
        // Process all results from all pages
        for (const pageResult of allPageResults) {
            if (!pageResult) continue;
            
            const pageResults = pageResult.results;
            
            for (let i = 0; i < pageResults.length && results.length < limit; i++) {
                const item = pageResults[i];
                
                // Use the hash from the JSON if available, otherwise skip
                let infoHash = item.h; // Hash field from JSON response
                if (!infoHash) {
                    // If no hash in JSON, try to extract from pk (primary key)
                    infoHash = String(item.pk || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
                }
                
                if (!infoHash) continue; // Skip if no hash available
                
                // Normalize the hash to be sure it's a valid hex string
                infoHash = infoHash.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
                if (infoHash.length < 40) continue; // Info hashes should be 40 chars (20 bytes hex)

                // Skip if we've already seen this hash
                if (seen.has(infoHash)) continue;
                seen.add(infoHash);
                
                // Extract details from the JSON response
                const title = item.n || 'Unknown Title';  // Name field
                const seeders = parseInt(item.se) || 0;    // Seeders
                const leechers = parseInt(item.le) || 0;  // Leechers
                const size = parseInt(item.s) || 0;       // Size in bytes (already a number in the JSON)
                
                // Apply more strict filtering to match query terms and year
                if (config?.TORRENT_1337X_STRICT_MATCH && !titleMatchesQuery(title, query)) {
                    continue; // Skip results that don't match our query criteria more strictly
                }

                
                // Build magnet link using the hash from JSON
                const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
                
                results.push({
                    Title: title,
                    InfoHash: infoHash,
                    Size: size,
                    Seeders: seeders,
                    Leechers: leechers,
                    Tracker: scraperName,
                    Langs: detectSimpleLangs(title),
                    Magnet: magnetLink
                });
                
                if (results.length >= limit) break;
            }
        }

        // If we hit the limit, we might have skipped some results, so we should re-check
        // to ensure we get as many results as possible while respecting the limit

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        scraperCache.set(scraperName, query, config, processedResults);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

async function fetch1337xPage(base, query, page, timeout, signal, logPrefix, scraperName) {
    try {
        const searchUrl = page === 1 
            ? `${base}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/`
            : `${base}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/?page=${page}`;
        
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching page ${page}: ${searchUrl}`);

        // When fetching pages in parallel, use a longer timeout to account for server load
        // But cap it to avoid hanging indefinitely
        const pageTimeout = Math.min(timeout * 2, 15000); // Double the timeout, max 15 seconds

        const response = await axios.get(searchUrl, {
            timeout: pageTimeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': `${base}/home/`,
                'Connection': 'keep-alive'
            }
        });

        const data = response.data;
        
        // Check if the response has the expected structure
        if (!data || !data.results || !Array.isArray(data.results)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no valid results found on page ${page}.`);
            return null;
        }
        
        return data;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} error fetching page ${page}: ${error.message}`);
        return null;
    }
}

export async function searchBtdig(query, signal, logPrefix, config) {
    const scraperName = 'BTDigg';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const limit = config?.BTDIG_LIMIT ?? ENV.BTDIG_LIMIT ?? 50;
        const maxPages = config?.BTDIG_MAX_PAGES ?? ENV.BTDIG_MAX_PAGES ?? 5;
        const base = ((config?.BTDIG_URL || ENV.BTDIG_URL) || 'https://btdig.com').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const useProxies = config?.BTDIG_USE_PROXIES ?? ENV.BTDIG_USE_PROXIES ?? false;

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Log proxy usage
        if (useProxies) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} using rotating proxies`);
            const stats = proxyManager.getStats();
            console.log(`[${logPrefix} SCRAPER] ${scraperName} proxy stats:`, stats);
        }

        // Build URLs for all pages with order=0 parameter (sort by relevance)
        const pageUrls = Array.from({ length: maxPages }, (_, page) =>
            page === 0
                ? `${base}/search?q=${encodeURIComponent(query)}&order=0`
                : `${base}/search?q=${encodeURIComponent(query)}&p=${page}&order=0`
        );

        // Strategy: Fetch in smaller batches to avoid overwhelming the connection
        const batchSize = 2; // Fetch 2 pages at a time to avoid rate limiting
        const batchDelayMs = 1000; // 1 second delay between batches
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${maxPages} pages in parallel (batches of ${batchSize})...`);

        // Generate random realistic User-Agents (Firefox-based for best BTDigg compatibility)
        function generateRandomUserAgent() {
            const firefoxVersions = ['138.0', '139.0', '140.0', '141.0'];
            const platforms = [
                'Macintosh; Intel Mac OS X 10.15',
                'Macintosh; Intel Mac OS X 14.1',
                'Windows NT 10.0; Win64; x64',
                'X11; Linux x86_64',
                'X11; Ubuntu; Linux x86_64'
            ];

            const version = firefoxVersions[Math.floor(Math.random() * firefoxVersions.length)];
            const platform = platforms[Math.floor(Math.random() * platforms.length)];

            return `Mozilla/5.0 (${platform}; rv:${version}) Gecko/20100101 Firefox/${version}`;
        }

        // Cookie file for persistence across requests
        const cookieFile = `/tmp/btdig-cookies-${Date.now()}.txt`;

        // Fetch all pages in parallel using curl with rotating user agents and persistent cookies
        // Increase timeout for parallel requests: base timeout + 2s per page
        const perRequestTimeout = Math.max(timeout || 10000, maxPages * 2000);
        const execOptions = { timeout: perRequestTimeout };
        if (signal && !signal.aborted) {
            execOptions.signal = signal;
        }

        // Fetch pages in batches to avoid overwhelming the server
        const allPageResults = [];
        for (let batchStart = 0; batchStart < pageUrls.length; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, pageUrls.length);
            const batchUrls = pageUrls.slice(batchStart, batchEnd);

            // Add delay between batches (except for first batch)
            if (batchStart > 0) {
                await new Promise(resolve => setTimeout(resolve, batchDelayMs));
            }

            const batchPromises = batchUrls.map(async (url, batchIndex) => {
                const index = batchStart + batchIndex;

                // Add a small staggered delay between requests to avoid rate limiting
                // Each request in batch waits index * 800ms (0ms, 800ms)
                if (batchIndex > 0) {
                    await new Promise(resolve => setTimeout(resolve, batchIndex * 800));
                }

                // Generate random user agent for each page
                const userAgent = generateRandomUserAgent();

                // Get a proxy if enabled
                let proxy = null;
                if (useProxies) {
                    proxy = await proxyManager.getNextProxy();
                }

                // Use persistent cookies: -b to read, -c to write
                // Match Firefox browser headers exactly for best compatibility
                // Build proper referer URL matching the previous page's actual URL format
                const prevPageReferer = index === 1
                    ? `${base}/search?q=${encodeURIComponent(query)}&order=0`  // First page has no p parameter
                    : `${base}/search?q=${encodeURIComponent(query)}&p=${index - 1}&order=0`;

                // Build curl command with properly escaped single quotes
                // Escape single quotes in dynamic values by replacing ' with '\''
                const escapedUrl = url.replace(/'/g, "'\\''");
                const escapedUserAgent = userAgent.replace(/'/g, "'\\''");
                const escapedCookieFile = cookieFile.replace(/'/g, "'\\''");
                const escapedReferer = prevPageReferer.replace(/'/g, "'\\''");

                // Build proxy argument for curl
                let proxyArg = '';
                if (proxy) {
                    const escapedProxy = proxy.replace(/'/g, "'\\''");
                    if (proxy.startsWith('socks')) {
                        proxyArg = `--socks5 '${escapedProxy.replace('socks5://', '')}'`;
                    } else {
                        proxyArg = `-x '${escapedProxy}'`;
                    }
                }

                const curlCmd = index === 0
                    ? `curl -s -L ${proxyArg} -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`
                    : `curl -s -L ${proxyArg} -b '${escapedCookieFile}' -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Referer: ${escapedReferer}' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`;

                // Remove signal from execOptions to avoid interference with child_process
                const curlExecOptions = { timeout: execOptions.timeout };

                return execPromise(curlCmd, curlExecOptions)
                    .then(({ stdout }) => {
                        // Mark proxy as successful if used
                        if (proxy) proxyManager.markSuccess(proxy);
                        return { pageNum: index + 1, html: stdout };
                    })
                    .catch(async (error) => {
                        // Mark proxy as failed if used
                        if (proxy) proxyManager.markFailure(proxy);

                        // Log detailed error information including stderr and exit code
                        const stderr = error.stderr ? String(error.stderr).trim() : '';
                        const stdout = error.stdout ? String(error.stdout).trim() : '';
                        const exitCode = error.code || 'unknown';
                        const errorMsg = stderr || stdout || error.message || 'Unknown error';
                        const proxyInfo = proxy ? ` via proxy ${proxy}` : '';
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} failed${proxyInfo} (exit code: ${exitCode}): ${errorMsg}`);

                        // If proxy failed with connection error, retry without proxy
                        // Exit codes: 5=Couldn't resolve proxy, 7=Failed to connect, 28=Timeout, 35=SSL error, 56=Recv failure
                        if (proxy && (exitCode === 5 || exitCode === 7 || exitCode === 35 || exitCode === 28 || exitCode === 56)) {
                            console.log(`[${logPrefix} SCRAPER] ${scraperName} retrying page ${index + 1} without proxy...`);

                            // Build curl command without proxy
                            const curlCmdNoproxy = index === 0
                                ? `curl -s -L -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`
                                : `curl -s -L -b '${escapedCookieFile}' -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Referer: ${escapedReferer}' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`;

                            try {
                                const { stdout: retryStdout } = await execPromise(curlCmdNoproxy, curlExecOptions);
                                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} succeeded without proxy`);
                                return { pageNum: index + 1, html: retryStdout };
                            } catch (retryError) {
                                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} also failed without proxy`);
                                return { pageNum: index + 1, html: null };
                            }
                        }

                        return { pageNum: index + 1, html: null };
                    });
            });

            const batchResults = await Promise.all(batchPromises);
            allPageResults.push(...batchResults);
        }

        const pageResults = allPageResults;

        // Process all page results
        const results = [];
        const seen = new Set();
        let captchaDetected = false;

        for (const { pageNum, html } of pageResults) {
            if (!html || results.length >= limit) continue;

            const $ = cheerio.load(html);

            // Detect CAPTCHA page
            if (html.includes('security check') || html.includes('g-recaptcha') || html.includes('One more step')) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} CAPTCHA detected on page ${pageNum}. BTDigg has anti-bot protection enabled.`);
                captchaDetected = true;
                continue;
            }

            const resultDivs = $('.one_result');

            if (resultDivs.length === 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} no results found on page ${pageNum}.`);
                continue;
            }

            resultDivs.each((i, el) => {
                if (results.length >= limit) return false;

                try {
                    // Extract title
                    const titleLink = $(el).find('.torrent_name a');
                    const title = titleLink.text().replace(/<b[^>]*>/gi, '').replace(/<\/b>/gi, '').trim();

                    // Extract magnet link
                    const magnetLink = $(el).find('.torrent_magnet a[href^="magnet:"]').attr('href');
                    if (!magnetLink) return;

                    // Decode HTML entities in magnet link
                    const decodedMagnet = magnetLink
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"');

                    const infoHash = getHashFromMagnet(decodedMagnet);
                    if (!infoHash) return;

                    // Skip if already seen
                    if (seen.has(infoHash)) return;
                    seen.add(infoHash);

                    // Extract size
                    const sizeText = $(el).find('.torrent_size').text().trim();
                    const size = sizeToBytes(sizeText);

                    // Extract seeders (not available on BTDigg)
                    const seeders = 0;

                    // Extract number of files
                    const filesText = $(el).find('.torrent_files').text().trim();
                    const fileCount = parseInt(filesText) || 0;

                    results.push({
                        Title: title,
                        InfoHash: infoHash,
                        Size: size,
                        Seeders: seeders,
                        Tracker: scraperName,
                        Langs: detectSimpleLangs(title),
                        Magnet: decodedMagnet,
                        FileCount: fileCount
                    });
                } catch (e) {
                    // Ignore individual parsing errors
                }
            });
        }

        if (captchaDetected && results.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} WARNING: BTDigg has enabled CAPTCHA/anti-bot protection. The scraper cannot bypass this automatically.`);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Consider: 1) Disabling BTDigg scraper 2) Using alternative scrapers 3) Waiting and trying again later`);
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Files: ${r.FileCount}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        // Clean up cookie file
        try {
            await execPromise(`rm -f "${cookieFile}"`);
        } catch (e) {
            // Ignore cleanup errors
        }

        scraperCache.set(scraperName, query, config, processedResults);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchMagnetDL(query, signal, logPrefix, config) {
    const scraperName = 'MagnetDL';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const limit = config?.MAGNETDL_LIMIT || 200;
        const base = ((config?.MAGNETDL_URL || ENV.MAGNETDL_URL) || 'https://magnetdl.homes').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build the API URL for searching - using all categories by default
        const encodedQuery = encodeURIComponent(query).replace(/\%20/g, '+');
        const apiUrl = `${base}/api.php?url=/q.php?q=${encodedQuery}`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${apiUrl}`);

        // Use curl command to handle zstd compression properly
        // Escape single quotes in URLs by replacing ' with '\''
        const escapedApiUrl = apiUrl.replace(/'/g, "'\\''");
        const escapedBase = base.replace(/'/g, "'\\''");
        const curlCmd = `curl -s --compressed -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Referer: ${escapedBase}/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' '${escapedApiUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout: Math.max(timeout, 15000) });

        if (!stdout) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} received empty response.`);
            return [];
        }

        let resultsData;
        try {
            resultsData = JSON.parse(stdout);
        } catch (parseError) {
            console.error(`[${logPrefix} SCRAPER] ${scraperName} failed to parse JSON response:`, parseError.message);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} Response was:`, stdout.substring(0, 500));
            return [];
        }

        // Convert the response array/object to our standard format
        const resultArray = Array.isArray(resultsData) ? resultsData : Object.values(resultsData);
        const results = resultArray.slice(0, limit).map(item => {
            if (!item?.info_hash || !item?.name) return null;

            return {
                Title: item.name,
                InfoHash: item.info_hash.toLowerCase(), // Normalize to lowercase to match cache expectations
                Size: parseInt(item.size) || 0,
                Seeders: parseInt(item.seeders) || 0,
                Leechers: parseInt(item.leechers) || 0,
                Tracker: `${scraperName} | ${item.category ? `Cat:${item.category}` : 'Public'}`,
                Langs: detectSimpleLangs(item.name),
                Username: item.username,
                Added: item.added ? new Date(parseInt(item.added) * 1000).toISOString() : null
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchMagnetDLMovie(query, signal, logPrefix, config) {
    const scraperName = 'MagnetDL-Movie';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = `MagnetDL-Movie:${query}`;
    const cached = scraperCache.get(scraperName, cacheKey, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const limit = config?.MAGNETDL_LIMIT || 200;
        const base = ((config?.MAGNETDL_URL || ENV.MAGNETDL_URL) || 'https://magnetdl.homes').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build the API URL for searching with movie category (201)
        const encodedQuery = encodeURIComponent(query).replace(/\%20/g, '+');
        const apiUrl = `${base}/api.php?url=/q.php?q=${encodedQuery}&cat=201`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${apiUrl}`);

        // Use curl command to handle zstd compression properly
        // Escape single quotes in URLs by replacing ' with '\''
        const escapedApiUrl = apiUrl.replace(/'/g, "'\\''");
        const escapedBase = base.replace(/'/g, "'\\''");
        const curlCmd = `curl -s --compressed -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Referer: ${escapedBase}/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' '${escapedApiUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout: Math.max(timeout, 15000) });

        if (!stdout) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} received empty response.`);
            return [];
        }

        let resultsData;
        try {
            resultsData = JSON.parse(stdout);
        } catch (parseError) {
            console.error(`[${logPrefix} SCRAPER] ${scraperName} failed to parse JSON response:`, parseError.message);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} Response was:`, stdout.substring(0, 500));
            return [];
        }

        // Convert the response array/object to our standard format
        const resultArray = Array.isArray(resultsData) ? resultsData : Object.values(resultsData);
        const results = resultArray.slice(0, limit).map(item => {
            if (!item?.info_hash || !item?.name) return null;

            return {
                Title: item.name,
                InfoHash: item.info_hash.toLowerCase(), // Normalize to lowercase to match cache expectations
                Size: parseInt(item.size) || 0,
                Seeders: parseInt(item.seeders) || 0,
                Leechers: parseInt(item.leechers) || 0,
                Tracker: `${scraperName} | ${item.category ? `Cat:${item.category}` : 'Public'}`,
                Langs: detectSimpleLangs(item.name),
                Username: item.username,
                Added: item.added ? new Date(parseInt(item.added) * 1000).toISOString() : null
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, cacheKey, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchMagnetDLTV(query, signal, logPrefix, config) {
    const scraperName = 'MagnetDL-TV';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = `MagnetDL-TV:${query}`;
    const cached = scraperCache.get(scraperName, cacheKey, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const limit = config?.MAGNETDL_LIMIT || 200;
        const base = ((config?.MAGNETDL_URL || ENV.MAGNETDL_URL) || 'https://magnetdl.homes').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build the API URL for searching with TV category (205)
        const encodedQuery = encodeURIComponent(query).replace(/\%20/g, '+');
        const apiUrl = `${base}/api.php?url=/q.php?q=${encodedQuery}&cat=205`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${apiUrl}`);

        // Use curl command to handle zstd compression properly
        // Escape single quotes in URLs by replacing ' with '\''
        const escapedApiUrl = apiUrl.replace(/'/g, "'\\''");
        const escapedBase = base.replace(/'/g, "'\\''");
        const curlCmd = `curl -s --compressed -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Referer: ${escapedBase}/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' '${escapedApiUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout: Math.max(timeout, 15000) });

        if (!stdout) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} received empty response.`);
            return [];
        }

        let resultsData;
        try {
            resultsData = JSON.parse(stdout);
        } catch (parseError) {
            console.error(`[${logPrefix} SCRAPER] ${scraperName} failed to parse JSON response:`, parseError.message);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} Response was:`, stdout.substring(0, 500));
            return [];
        }

        // Convert the response array/object to our standard format
        const resultArray = Array.isArray(resultsData) ? resultsData : Object.values(resultsData);
        const results = resultArray.slice(0, limit).map(item => {
            if (!item?.info_hash || !item?.name) return null;

            return {
                Title: item.name,
                InfoHash: item.info_hash.toLowerCase(), // Normalize to lowercase to match cache expectations
                Size: parseInt(item.size) || 0,
                Seeders: parseInt(item.seeders) || 0,
                Leechers: parseInt(item.leechers) || 0,
                Tracker: `${scraperName} | ${item.category ? `Cat:${item.category}` : 'Public'}`,
                Langs: detectSimpleLangs(item.name),
                Username: item.username,
                Added: item.added ? new Date(parseInt(item.added) * 1000).toISOString() : null
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, cacheKey, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchTorrentGalaxy(searchKey, signal, logPrefix) {



    const scraperName = 'TorrentGalaxy';
    const sfx = ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);


    console.time(timerLabel);


    try {


        const limit = config.TORRENTGALAXY_LIMIT || 200;


        const maxPages = config.TORRENTGALAXY_MAX_PAGES || 10; // safe upper bound


        const base = (config.TORRENTGALAXY_URL || 'https://torrentgalaxy.space').replace(/\/$/, '');






        let page = 1;


        let accumulated = [];


        const seen = new Set();


        let pageSize = 50; // fallback if server doesn't return page_size






        while (accumulated.length < limit && page <= maxPages) {


            const url = `${base}/get-posts/keywords:${encodeURIComponent(searchKey)}:format:json/?page=${page}`;


            // console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching page ${page} -> ${url}`);


            const response = await axiosWithProxy.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });


            const payload = response.data || {};


            const results = Array.isArray(payload.results) ? payload.results : [];






            // update pageSize if server provides it


            if (payload.page_size && Number.isFinite(Number(payload.page_size))) {


                pageSize = parseInt(payload.page_size, 10);


            }






            if (results.length === 0) break; // no more items






            for (const r of results) {


                if (accumulated.length >= limit) break;






                const rawHash = r.h || r.pk || null;


                if (!rawHash) continue;






                const cleaned = String(rawHash).replace(/[^A-Za-z0-9]/g, '');


                if (!cleaned) continue;


                if (seen.has(cleaned)) continue; // dedupe across pages


                seen.add(cleaned);






                accumulated.push({


                    Title: r.n || 'Unknown Title',


                    InfoHash: cleaned,


                    Size: Number.isFinite(Number(r.s)) ? parseInt(r.s, 10) : 0,


                    Seeders: (r.se === null || typeof r.se === 'undefined') ? 0 : (Number.isFinite(Number(r.se)) ? parseInt(r.se, 10) : 0),


                    Tracker: `${scraperName} | ${r.u || 'Public'}`


                });


            }






            // If server returned fewer results than a full page, it's the last page


            if (results.length < pageSize) break;






            page += 1;


        }






        return accumulated.slice(0, limit);


    } catch (error) {


        handleScraperError(error, scraperName, logPrefix);


        return [];


    } finally {


        console.timeEnd(timerLabel);


    }


}


/**
 * Wolfmax4K scraper
 * Spanish public tracker for movies and TV shows
 */

// Helper function to convert quality strings to standard format
function parseWolfmax4KQuality(quality) {
    if (quality === '4KWebrip') return 'WEBRip-2160p';
    return quality;
}

// Helper function to determine if content is a TV show
function isWolfmax4KTvShow(torrentName, guid) {
    return guid.includes('/serie') ||
           (guid.includes('/temporada-') && guid.includes('/capitulo-')) ||
           /Cap\.\s*(\d+)/i.test(torrentName);
}

// Helper function to parse season and episode info
function parseWolfmax4KSeasonEpisode(torrentName, guid) {
    let result = '';

    // Try to extract from URL path first
    const seasonMatch = /\/temporada-(\d+)/.exec(guid);
    if (seasonMatch) {
        result += 'S' + seasonMatch[1].padStart(2, '0');
    }

    const episodeMatch = /\/capitulo-(\d+)(-al-(\d+))?/.exec(guid);
    if (seasonMatch && episodeMatch) {
        result += 'E' + episodeMatch[1].padStart(2, '0');
        if (episodeMatch[3]) {
            result += '-E' + episodeMatch[3].padStart(2, '0');
        }
    }

    if (result) return result;

    // Fallback to Cap. notation in torrent name
    const capsMatch = /Cap\.\s*([\d_]+)/i.exec(torrentName);
    if (!capsMatch) return result;

    const caps = capsMatch[1].trim().split('_')
        .map(cap => cap.padStart(4, '0'))
        .filter(cap => cap.length === 4);

    if (caps.length === 0) return result;

    const season = caps[0].substring(0, 2);
    const episodes = caps.map(cap => cap.substring(2));

    result = 'S' + season + 'E' + episodes[0];
    if (episodes.length > 1) {
        result += '-E' + episodes[episodes.length - 1];
    }

    return result;
}

// Helper function to extract episode numbers from title
function getWolfmax4KEpisodes(title) {
    const matches = [...title.matchAll(/E(\d+)/g)];
    const vals = matches.map(m => parseInt(m[1]));

    if (vals.length === 1) {
        return [vals[0]];
    }

    if (vals.length === 2 && vals[1] > vals[0]) {
        const episodes = [];
        for (let i = vals[0]; i <= vals[1]; i++) {
            episodes.push(i);
        }
        return episodes;
    }

    return [];
}

// Helper function to parse title
function parseWolfmax4KTitle(torrentName, guid, quality) {
    let title = torrentName
        .replace(/(\- )?(Tem\.|Temp\.|Temporada)\s+?\d+?/g, '')
        .replace(/\[(Esp|Spanish)\]/gi, '')
        .replace(/\(?wolfmax4k\.com\)?/gi, '')
        .trim();

    const seasonEpisode = parseWolfmax4KSeasonEpisode(torrentName, guid);
    if (seasonEpisode) {
        // Only replace Cap. if we could parse season/episode
        title = title.replace(/\[Cap\.\s*(\d+)\]/g, '').trim();
        title += ' ' + seasonEpisode;
    }

    // Remove quality info and add standardized quality
    title = title.replace(/\[(.*)(HDTV|Bluray|4k|DVDRIP)(.*)\]/gi, '').trim();
    title = title + ' [' + quality + '] SPANISH';

    return title.trim();
}

// Estimated sizes by category (in bytes)
const WOLFMAX4K_SIZES = {
    'pelicula': 2 * 1024 * 1024 * 1024,      // 2 GB
    'pelicula720': 5 * 1024 * 1024 * 1024,   // 5 GB
    'pelicula1080': 15 * 1024 * 1024 * 1024, // 15 GB
    'pelicula4k': 30 * 1024 * 1024 * 1024,   // 30 GB
    'serie': 512 * 1024 * 1024,              // 512 MB
    'serie720': 1 * 1024 * 1024 * 1024,      // 1 GB
    'serie1080': 3 * 1024 * 1024 * 1024,     // 3 GB
    'serie4k': 8 * 1024 * 1024 * 1024        // 8 GB
};

// Helper function to determine Wolfmax4K category
function getWolfmax4KCategory(torrentName, guid, quality) {
    const isTvShow = isWolfmax4KTvShow(torrentName, guid);
    const qualityLower = quality.toLowerCase();

    if (isTvShow) {
        if (qualityLower.includes('720')) return 'serie720';
        if (qualityLower.includes('1080')) return 'serie1080';
        if (qualityLower.includes('4k') || qualityLower.includes('2160p')) return 'serie4k';
        return 'serie';
    } else {
        if (qualityLower.includes('720')) return 'pelicula720';
        if (qualityLower.includes('1080')) return 'pelicula1080';
        if (qualityLower.includes('4k') || qualityLower.includes('2160p')) return 'pelicula4k';
        return 'pelicula';
    }
}

// Helper function to create a fake InfoHash from URL
// Since Wolfmax4K doesn't provide magnet links directly, we create a deterministic hash
async function createWolfmax4KInfoHash(guid) {
    const crypto = await import('crypto');
    return crypto.createHash('sha1').update(guid).digest('hex');
}

export async function searchWolfmax4K(query, signal, logPrefix, config) {
    const scraperName = 'Wolfmax4K';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const base = ((config?.WOLFMAX4K_URL || ENV.WOLFMAX4K_URL) || 'https://wolfmax4k.com/').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Step 1: Get search token from main page
        const mainPageResponse = await axiosWithProxy.get(base, {
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $main = cheerio.load(mainPageResponse.data);
        const searchToken = $main('input[name="token"]').attr('value');

        if (!searchToken) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} could not extract search token`);
            return [];
        }

        // Step 2: Build search URL
        const adminHost = new URL(base).host;
        const searchUrl = `https://admin.${adminHost}/admin/admpctn/app/data.find.php`;

        // Sanitize search query (remove year, punctuation, etc.)
        let searchTerm = query.replace(/[-._\(\)@/\\\[\]\+\%]/g, ' ').trim();
        searchTerm = searchTerm.replace(/\b(espa[ñn]ol|spanish|castellano|spa)\b/gi, '');

        // Parse and remove year
        const yearMatch = /\s+(\d{4})$/.exec(searchTerm);
        if (yearMatch) {
            searchTerm = searchTerm.replace(yearMatch[0], '');
        }
        searchTerm = searchTerm.trim();

        // Step 3: Make search request
        const searchParams = new URLSearchParams({
            pg: '',
            token: searchToken,
            cidr: '',
            c: '0',
            q: searchTerm,
            l: searchTerm ? '1000' : '100'
        });

        const searchResponse = await axiosWithProxy.post(searchUrl, searchParams, {
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': base
            }
        });

        const jsonResponse = searchResponse.data;
        const data = jsonResponse?.data?.datafinds?.[0];

        if (!data) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} found no results`);
            return [];
        }

        // Step 4: Parse results
        const results = [];
        const dataValues = Object.values(data);

        for (const item of dataValues) {
            try {
                const torrentName = item.torrentName;
                const guid = item.guid;
                const quality = item.calidad;

                // Skip if missing required fields
                if (!torrentName || !guid || !quality) continue;

                const parsedQuality = parseWolfmax4KQuality(quality);
                const title = parseWolfmax4KTitle(torrentName, guid, parsedQuality);
                const category = getWolfmax4KCategory(torrentName, guid, parsedQuality);
                const episodes = getWolfmax4KEpisodes(title);
                const episodeCount = Math.max(episodes.length, 1);

                // Generate a deterministic InfoHash from the GUID
                const infoHash = await createWolfmax4KInfoHash(guid);

                // Create magnet link
                const magnetLink = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;

                results.push({
                    Title: title,
                    InfoHash: infoHash,
                    Size: WOLFMAX4K_SIZES[category] * episodeCount,
                    Seeders: 1,  // Unknown, default to 1
                    Tracker: scraperName,
                    Langs: ['es'],  // Spanish tracker
                    Magnet: magnetLink
                });
            } catch (e) {
                // Skip individual items that fail to parse
                continue;
            }
        }

        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

/**
 * BluDV scraper
 * Portuguese public tracker for movies and TV shows
 * Provides dual audio (Portuguese/English) and subtitled content
 */
export async function searchBluDV(query, signal, logPrefix, config) {
    const scraperName = 'BluDV';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    try {
        const limit = config?.BLUDV_LIMIT ?? ENV.BLUDV_LIMIT ?? 50;
        const base = ((config?.BLUDV_URL || ENV.BLUDV_URL) || 'https://bludv.net').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        const searchUrl = `${base}/?s=${encodeURIComponent(query)}`;
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${searchUrl}`);

        const searchResponse = await axiosWithProxy.get(searchUrl, {
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        const $ = cheerio.load(searchResponse.data);
        const accumulated = [];
        const seen = new Set();

        // Parse search results - each result is in a div with class "post"
        const posts = $('div.post');

        if (posts.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} found no results`);
            return [];
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${posts.length} search results`);

        // Process each search result
        posts.each((i, el) => {
            if (accumulated.length >= limit) return false;

            try {
                // Extract the title and detail page URL from div.title > a
                const titleLink = $(el).find('div.title > a').first();
                const title = titleLink.text().trim();
                const detailUrl = titleLink.attr('href');

                if (!detailUrl || !title) return;

                // Skip duplicates
                if (seen.has(detailUrl)) return;
                seen.add(detailUrl);

                accumulated.push({
                    Title: title,
                    DetailUrl: detailUrl,
                    Tracker: scraperName,
                    Langs: ['pt']  // Portuguese tracker
                });
            } catch (e) {
                // Skip items that fail to parse
            }
        });

        console.log(`[${logPrefix} SCRAPER] ${scraperName} extracted ${accumulated.length} items from search results, fetching detail pages...`);

        // Now fetch detail pages in batches to get magnet links
        const batchSize = 5;
        const results = [];

        for (let i = 0; i < accumulated.length; i += batchSize) {
            const batch = accumulated.slice(i, i + batchSize);
            const detailPromises = batch.map(item =>
                axiosWithProxy.get(item.DetailUrl, {
                    timeout,
                    signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Referer': base
                    }
                }).catch(() => null)
            );

            const responses = await Promise.all(detailPromises);

            for (let j = 0; j < responses.length; j++) {
                const response = responses[j];
                const item = batch[j];

                if (!response?.data) continue;

                try {
                    const $detail = cheerio.load(response.data);

                    // Look for magnet links - they use systemads.org/get.php redirect
                    // We need to find the actual magnet links
                    const magnetLinks = [];

                    // Method 1: Direct magnet links
                    $detail('a[href^="magnet:"]').each((idx, el) => {
                        const href = $detail(el).attr('href');
                        if (href) magnetLinks.push(href);
                    });

                    // Method 2: systemads.org links that redirect to magnets
                    // These are typically in the format: systemads.org/get.php?id=...&refsite=bludv
                    $detail('a[href*="systemads.org/get.php"]').each((idx, el) => {
                        const href = $detail(el).attr('href');
                        if (href) magnetLinks.push(href);
                    });

                    if (magnetLinks.length === 0) continue;

                    // Extract quality and size information from the page content
                    const contentText = $detail('.post .content, article').text();

                    // Try to extract sizes from multiple sources (e.g., "2.82 GB", "19.32 GB")
                    // Get all sizes to pair with links
                    const sizeMatches = contentText.matchAll(/(\d+[\.,]?\d*)\s*(GB|MB)/gi);
                    const sizes = [];
                    for (const match of sizeMatches) {
                        const sizeValue = parseFloat(match[1].replace(',', '.'));
                        const sizeUnit = match[2].toUpperCase();
                        const sizeBytes = sizeUnit === 'GB' ? sizeValue * 1024 * 1024 * 1024 : sizeValue * 1024 * 1024;
                        sizes.push(sizeBytes);
                    }

                    // Use the average size if we found multiple, or the first one
                    let size = sizes.length > 0 ? sizes[0] : 0;

                    // Process each magnet link found (different qualities)
                    for (const magnetLink of magnetLinks) {
                        // For systemads.org links, we can't get the actual magnet without following the redirect
                        // So we'll create a synthetic infohash from the URL
                        let infoHash;

                        if (magnetLink.startsWith('magnet:')) {
                            infoHash = getHashFromMagnet(magnetLink);
                        } else {
                            // For systemads.org links, create a deterministic hash from the URL
                            const crypto = await import('crypto');
                            infoHash = crypto.createHash('sha1').update(magnetLink).digest('hex');
                        }

                        if (!infoHash) continue;

                        results.push({
                            Title: item.Title,
                            InfoHash: infoHash,
                            Size: size,
                            Seeders: 1,  // Unknown, default to 1
                            Tracker: item.Tracker,
                            Langs: item.Langs,
                            Magnet: magnetLink.startsWith('magnet:') ? magnetLink : `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.Title)}`
                        });

                        // For systemads links, we only take the first one to avoid duplicates
                        if (!magnetLink.startsWith('magnet:')) break;
                    }
                } catch (e) {
                    // Ignore individual parsing errors
                }
            }
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        scraperCache.set(scraperName, query, config, processedResults);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
