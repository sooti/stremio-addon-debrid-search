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

const execPromise = promisify(exec);



// List of keywords to identify and filter out junk/bootleg files.
const JUNK_KEYWORDS = [
    'CAM', 'HDCAM', 'CAMRIP',
    'TS', 'HDTS', 'TELESYNC',
    'TC', 'HDTC', 'TELECINE',
    'SCR', 'SCREENER', 'DVDSCR', 'BDSCR',
    'R5', 'R6', 'WORKPRINT', 'WP', 'HDRIP'
];

// Regex to test for junk keywords as whole words (case-insensitive).
const JUNK_REGEX = new RegExp(`\\b(${JUNK_KEYWORDS.join('|')})\\b`, 'i');

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
    const sanitized = String(title).toLowerCase().replace(/[\[\]\(\)\._\-]+/g, ' ');
    const words = new Set(sanitized.split(/\s+/).filter(Boolean));
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
    const sanitized = String(title).toLowerCase().replace(/[\[\]\(\)\._\-]+/g, ' ');
    const words = new Set(sanitized.split(/\s+/).filter(Boolean));
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
    const sanitized = String(title).toLowerCase().replace(/[\[\]\(\)\._\-]+/g, ' ');
    const words = new Set(sanitized.split(/\s+/).filter(Boolean));
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
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const base = (config?.BITMAGNET_URL || ENV.BITMAGNET_URL || '').replace(/\/$/, '');
        const limit = config?.TORZNAB_LIMIT ?? ENV.TORZNAB_LIMIT;
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const url = `${base}?t=search&q=${encodeURIComponent(query)}&limit=${limit}`;
        const response = await axios.get(url, { timeout, signal });
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchJackett(query, signal, logPrefix, config) {
    const scraperName = 'Jackett';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const base = (config?.JACKETT_URL || ENV.JACKETT_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const url = `${base}/api/v2.0/indexers/all/results`;
        const response = await axios.get(url, {
            params: { apikey: (config?.JACKETT_API_KEY ?? ENV.JACKETT_API_KEY), Query: query },
            timeout, signal
        });
        const results = (response.data.Results || []).slice(0, 200).map(r => ({
            Title: r.Title, InfoHash: r.InfoHash, Size: r.Size, Seeders: r.Seeders,
            Tracker: `${scraperName} | ${r.Tracker}`,
            Langs: detectSimpleLangs(r.Title)
        }));
        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchZilean(title, season, episode, signal, logPrefix, config) {
    const scraperName = 'Zilean';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const query = season && episode ? `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : title;
    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const base = (config?.ZILEAN_URL || ENV.ZILEAN_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        let url = `${base}/dmm/filtered?query=${encodeURIComponent(title)}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;
        
        if (!base) throw new Error('Missing ZILEAN_URL');
        const response = await axios.get(url, { timeout, signal });
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchTorrentio(mediaType, mediaId, signal, logPrefix, config) {
    const scraperName = 'Torrentio';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    
    const query = `${mediaType}:${mediaId}`;
    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }
    
    try {
        const base = (config?.TORRENTIO_URL || ENV.TORRENTIO_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const url = `${base}/stream/${mediaType}/${mediaId}.json`;
        const response = await axios.get(url, { timeout, signal });
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchComet(mediaType, mediaId, signal, season, episode, logPrefix, config) {
    const scraperName = 'Comet';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const query = (mediaType === 'series' && season && episode) ? `${mediaId}:${season}:${episode}` : mediaId;
    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
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
        const response = await axios.get(url, { timeout, signal });
        
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchStremthru(query, signal, logPrefix, config) {
    const scraperName = 'StremThru';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const base = (config?.STREMTHRU_URL || ENV.STREMTHRU_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const url = `${base}/v0/torznab/api?t=search&q=${encodeURIComponent(query)}`;
        const response = await axios.get(url, { timeout, signal });
        const parsedXml = await parseStringPromise(response.data);
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchBt4g(query, signal, logPrefix, config) {
    const scraperName = 'BT4G';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const maxPages = config?.BT4G_MAX_PAGES || 3;
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }
    
    try {
        const allDetailPagePromises = [];

        const base = (config?.BT4G_URL || ENV.BT4G_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        if (!base) throw new Error('Missing BT4G_URL');
        for (let page = 0; page < maxPages; page++) {
            const searchUrl = `${base}/search?q=${encodeURIComponent(query)}&p=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching page ${page + 1}...`);
            
            const searchResponse = await axios.get(searchUrl, { timeout, signal });
            const $ = cheerio.load(searchResponse.data);

            if ($('div.result-item').length === 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} no more results found on page ${page + 1}.`);
                break;
            }

            $('div.result-item').each((i, el) => {
                const detailPageLink = $(el).find('h5 > a').attr('href');
                if (detailPageLink) {
                    const detailPageUrl = `${base}${detailPageLink}`;
                    allDetailPagePromises.push(axios.get(detailPageUrl, { timeout, signal }).catch(() => null));
                }
            });
        }

        const responses = await Promise.all(allDetailPagePromises);
        const results = [];
        
        for (const response of responses) {
            if (!response?.data) continue;
            try {
                const $ = cheerio.load(response.data);
                const title = $('h1.title').text().trim();
                const magnetLink = $('a.btn-info').attr('href');
                const infoHash = getHashFromMagnet(magnetLink);
                if (!infoHash) continue;
                results.push({
                    Title: title, InfoHash: infoHash,
                    Size: sizeToBytes($('#total-size').text().trim()),
                    Seeders: parseInt($('#seeders').text().trim()) || 0,
                    Tracker: scraperName,
                    Langs: detectSimpleLangs(title)
                });
            } catch (e) { /* ignore single page parse error */ }
        }
        const processedResults = processAndDeduplicate(results, config);
        scraperCache.set(scraperName, query, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchTorrentGalaxy(searchKey, signal, logPrefix, config) {
    const scraperName = 'TorrentGalaxy';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, searchKey, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const limit = config?.TORRENTGALAXY_LIMIT || 200;
        const maxPages = config?.TORRENTGALAXY_MAX_PAGES || 10;
        const base = ((config?.TORRENTGALAXY_URL || ENV.TORRENTGALAXY_URL) || 'https://torrentgalaxy.one').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        let page = 1;
        let accumulated = [];
        const seen = new Set();
        let pageSize = 50; 

        while (accumulated.length < limit && page <= maxPages) {
            const url = `${base}/get-posts/keywords:${encodeURIComponent(searchKey)}:format:json/?page=${page}`;
            const response = await axios.get(url, { timeout, signal });
            const payload = response.data || {};
            const results = Array.isArray(payload.results) ? payload.results : [];

            if (payload.page_size && Number.isFinite(Number(payload.page_size))) {
                pageSize = parseInt(payload.page_size, 10);
            }

            if (results.length === 0) break;

            for (const r of results) {
                if (accumulated.length >= limit) break;

                const title = r.n || 'Unknown Title';
                const rawHash = r.h || r.pk || null;
                if (!rawHash) continue;

                const cleaned = String(rawHash).replace(/[^A-Za-z0-9]/g, '');
                if (!cleaned) continue;
                if (seen.has(cleaned)) continue;
                seen.add(cleaned);

                accumulated.push({
                    Title: title,
                    InfoHash: cleaned,
                    Size: Number.isFinite(Number(r.s)) ? parseInt(r.s, 10) : 0,
                    Seeders: (r.se === null || typeof r.se === 'undefined') ? 0 : (Number.isFinite(Number(r.se)) ? parseInt(r.se, 10) : 0),
                    Tracker: `${scraperName} | ${r.u || 'Public'}`,
                    Langs: detectSimpleLangs(title)
                });
            }

            if (results.length < pageSize) break;

            page += 1;
        }

        const processedResults = processAndDeduplicate(accumulated.slice(0, limit), config);
        scraperCache.set(scraperName, searchKey, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchTorrentDownload(searchKey, signal, logPrefix, config) {
    const scraperName = 'TorrentDownload';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, searchKey, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const limit = config?.TORRENTDOWNLOAD_LIMIT || 200;
        const maxPages = config?.TORRENTDOWNLOAD_MAX_PAGES || 10;
        const base = ((config?.TORRENTDOWNLOAD_URL || ENV.TORRENTDOWNLOAD_URL) || 'https://www.torrentdownload.info').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const trackers = 'udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=http%3A%2F%2Ftracker.ipv6tracker.ru%3A80%2Fannounce&tr=udp%3A%2F%2Fretracker.hotplug.ru%3A2710%2Fannounce';

        let page = 1;
        const accumulated = [];
        const seen = new Set();
        const encoded = encodeURIComponent(searchKey).replace(/%20/g, '+');

        while (accumulated.length < limit && page <= maxPages) {
            const url = `${base}/search?q=${encoded}&p=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${url}`);

            let resp;
            try {
                resp = await axios.get(url, { timeout, signal });
            } catch (error) {
                if (error.code === 'ECONNABORTED' || (error.message || '').toLowerCase().includes('timeout')) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} request timed out on page ${page}. Halting search.`);
                    break;
                }
                throw error; // Rethrow other errors to be handled by the main catch block
            }
            if (!resp?.data) break;

            const html = resp.data.replace(/\s+/g, ' ').trim();
            const trs = html.match(/<tr><td.+?tt-name.+?<\/tr>/gi) || [];
            if (trs.length === 0) break;

            for (const tr of trs) {
                if (accumulated.length >= limit) break;

                const re = /href="\/(.+?)">(.+?)<\/a>.*?tdnormal">([0-9,.]+ (?:TB|GB|MB|KB)).*?tdseed">([0-9,]+).*?tdleech">([0-9,]+)/i;
                const m = tr.match(re);
                if (!m) continue;

                const pathPart = m[1].split('/')[0];
                let title = m[2].replace(/<span[^>]*>/gi, '').replace(/<\/span>/gi, '').trim();
                const rawSize = m[3].replace(/,/g, '').trim();
                const seeders = parseInt(m[4].replace(/,/g, ''), 10) || 0;

                const magnet = `magnet:?xt=urn:btih:${pathPart}&dn=&tr=${trackers}`;
                const maybeHash = getHashFromMagnet(magnet);
                const cleanedHash = (maybeHash || String(pathPart)).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
                if (!cleanedHash) continue;
                if (seen.has(cleanedHash)) continue;
                seen.add(cleanedHash);

                accumulated.push({
                    Title: title,
                    InfoHash: cleanedHash,
                    Size: sizeToBytes(rawSize),
                    Seeders: seeders,
                    Tracker: scraperName,
                    Magnet: magnet,
                    DescLink: `${base}/${m[1]}`,
                    Langs: detectSimpleLangs(title)
                });
            }
            page += 1;
        }
        const processedResults = processAndDeduplicate(accumulated.slice(0, limit), config);
        scraperCache.set(scraperName, searchKey, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, 'TorrentDownload', logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
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
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
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
            });
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchTorrent9(searchKey, signal, logPrefix, config) {
    const scraperName = 'Torrent9';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, searchKey, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const limit = config?.TORRENT9_LIMIT || 50;
        const base = ((config?.TORRENT9_URL || ENV.TORRENT9_URL) || 'https://www.torrent9.town').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        const searchUrl = `${base}/recherche/${encodeURIComponent(searchKey)}`;
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${searchUrl}`);

        const searchResponse = await axios.get(searchUrl, {
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
                axios.get(`${base}${item.DetailPath}`, {
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function search1337x(query, signal, logPrefix, config) {
    const scraperName = '1337x';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const limit = config?.TORRENT_1337X_LIMIT || 200;
        const maxPages = config?.TORRENT_1337X_MAX_PAGES || 3;
        const base = ((config?.TORRENT_1337X_URL || ENV.TORRENT_1337X_URL) || 'https://1337x.bz').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Using the JSON API from 1337x.bz which is much cleaner - based on the API seen in the HTML source
        const searchUrl = `${base}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/`;
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching: ${searchUrl}`);

        const response = await axios.get(searchUrl, {
            timeout,
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
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no valid results found.`);
            return [];
        }

        const allResults = data.results;
        const results = [];
        const seen = new Set();

        // Process each result from the JSON response
        for (let i = 0; i < allResults.length && results.length < limit; i++) {
            const item = allResults[i];
            
            if (!item.pk) continue; // Skip if no primary key
            
            // Skip if we've already seen this item
            if (seen.has(item.pk)) continue;
            seen.add(item.pk);
            
            // Extract details from the JSON response
            const title = item.n || 'Unknown Title';  // Name field
            const seeders = parseInt(item.se) || 0;    // Seeders
            const leechers = parseInt(item.le) || 0;  // Leechers
            const sizeStr = String(item.s || '0');    // Size string - convert to string first
            const size = sizeToBytes(sizeStr);        // Convert to bytes
            
            // Get the detail URL for building the final URL
            const cleanTitle = String(title)
                .replace(/\s+/g, ".")
                .replace(/[^\w.-]/g, "")
                .toLowerCase();
            const detailPath = `/post-detail/${item.pk}/${cleanTitle}/`;
            
            // Add to results - we'll get the magnet link from the detail page
            results.push({
                Title: title,
                DetailPath: detailPath,
                DetailId: item.pk,
                Size: size,
                Seeders: seeders,
                Leechers: leechers,
                Tracker: scraperName,
                Langs: detectSimpleLangs(title)
            });
        }

        // Now fetch magnet links from detail pages for the top results
        const batchSize = 5; // Process in batches
        const finalResults = [];
        
        // Only process the first N results up to the limit to avoid too many requests
        const itemsToProcess = results.slice(0, Math.min(limit, 50)); // Limit to 50 to avoid too many requests
        
        for (let i = 0; i < itemsToProcess.length; i += batchSize) {
            const batch = itemsToProcess.slice(i, i + batchSize);
            
            // Add a small delay between batches
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 second delay between batches
            }
            
            const detailPromises = batch.map(item =>
                axios.get(`${base}${item.DetailPath}`, {
                    timeout,
                    signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': `${base}/get-posts/keywords:${encodeURIComponent(query)}/`,
                        'Connection': 'keep-alive'
                    }
                }).catch((error) => {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} error fetching detail page for ${item.Title}: ${error.message}`);
                    return null;
                })
            );

            const responses = await Promise.all(detailPromises);

            for (let j = 0; j < responses.length; j++) {
                const response = responses[j];
                const item = batch[j];

                if (!response?.data) continue;

                try {
                    const $detail = cheerio.load(response.data);
                    
                    // Extract magnet link - the page structure might be different, let's look for any magnet link
                    let magnetLink = null;
                    
                    // Try different possible selectors for the magnet link
                    const selectors = [
                        'a[href^="magnet:"]',
                        'a[href*="magnet:"]',
                        'a:contains("Magnet")',
                        'a:contains("magnet")'
                    ];
                    
                    for (const selector of selectors) {
                        const linkElement = $detail(selector).first();
                        if (linkElement.length > 0) {
                            const href = linkElement.attr('href');
                            if (href && href.startsWith('magnet:')) {
                                magnetLink = href;
                                break;
                            }
                        }
                    }
                    
                    // If we couldn't find it with specific selectors, try any link containing magnet:
                    if (!magnetLink) {
                        $detail('a').each((index, element) => {
                            const href = $detail(element).attr('href');
                            if (href && href.startsWith('magnet:')) {
                                magnetLink = href;
                                return false; // break out of loop
                            }
                        });
                    }
                    
                    if (!magnetLink) {
                        // Try to find it in the script tags or as part of onclick
                        const onclickAttrs = $detail('*[onclick*="magnet:"]').attr('onclick');
                        if (onclickAttrs) {
                            const match = onclickAttrs.match(/magnet:[^"]*/);
                            if (match) {
                                magnetLink = match[0];
                            }
                        }
                    }

                    if (!magnetLink) {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} no magnet link found for ${item.Title}`);
                        continue;
                    }

                    const infoHash = getHashFromMagnet(magnetLink);
                    if (!infoHash) {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} no valid info hash found for ${item.Title}`);
                        continue;
                    }

                    // Extract additional information from the detail page
                    // Look for the size in the detail page - it should be in a structure like in the original 1337x
                    let page_size = item.Size; // Use the size from JSON as fallback
                    // Try to find size from the detail page
                    const sizeText = $detail('.torrent-detail-page .list li').eq(3).find('span').text().trim(); // Total size element
                    if (sizeText) {
                        const extractedSize = sizeToBytes(sizeText);
                        if (extractedSize > 0) {
                            page_size = extractedSize;
                        }
                    }
                    // Alternative selectors for size on the page (varies by site)
                    if (page_size <= 0) {
                        const sizeElements = $detail('.size, .coll-4.size, td.coll-4.size').first();
                        if (sizeElements.length > 0) {
                            const sizeText2 = sizeElements.text().trim();
                            const extractedSize2 = sizeToBytes(sizeText2.replace(/\s*([0-9,]+)\s+seeders?.*/, '').trim());
                            if (extractedSize2 > 0) {
                                page_size = extractedSize2;
                            }
                        }
                    }
                    
                    finalResults.push({
                        Title: item.Title,
                        InfoHash: infoHash,
                        Size: page_size,
                        Seeders: item.Seeders,
                        Leechers: item.Leechers,
                        Tracker: item.Tracker,
                        Langs: item.Langs,
                        Magnet: magnetLink
                    });
                } catch (e) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} error processing detail page for ${item.Title}: ${e.message}`);
                    // Ignore individual parsing errors
                }
            }
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${finalResults.length}`);
        if (finalResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            finalResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(finalResults, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${finalResults.length}).`);
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}

export async function searchBtdig(query, signal, logPrefix, config) {
    const scraperName = 'BTDigg';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    console.time(`[${logPrefix} TIMER] ${scraperName}${sfx}`);

    const cached = scraperCache.get(scraperName, query, config);
    if (cached) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
        return cached;
    }

    try {
        const limit = config?.BTDIG_LIMIT ?? ENV.BTDIG_LIMIT ?? 50;
        const maxPages = config?.BTDIG_MAX_PAGES ?? ENV.BTDIG_MAX_PAGES ?? 5;
        const base = ((config?.BTDIG_URL || ENV.BTDIG_URL) || 'https://btdig.com').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Build URLs for all pages with order=0 parameter (sort by relevance)
        const pageUrls = Array.from({ length: maxPages }, (_, page) =>
            page === 0
                ? `${base}/search?q=${encodeURIComponent(query)}&order=0`
                : `${base}/search?q=${encodeURIComponent(query)}&p=${page}&order=0`
        );

        // Strategy: Fetch in smaller batches to avoid overwhelming the connection
        const batchSize = 5; // Fetch 5 pages at a time
        const batchDelayMs = 0; // No delay between batches
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

            const batchPromises = batchUrls.map((url, batchIndex) => {
                const index = batchStart + batchIndex;
                // Generate random user agent for each page
                const userAgent = generateRandomUserAgent();

                // Use persistent cookies: -b to read, -c to write
                // Match Firefox browser headers exactly for best compatibility
                const curlCmd = index === 0
                    ? `curl -s -L -c "${cookieFile}" -H "User-Agent: ${userAgent}" -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" -H "Accept-Language: en-US,en;q=0.5" -H "Accept-Encoding: gzip, deflate, br, zstd" -H "DNT: 1" -H "Connection: keep-alive" -H "Upgrade-Insecure-Requests: 1" -H "Sec-Fetch-Dest: document" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: none" -H "Sec-Fetch-User: ?1" -H "Priority: u=0, i" -H "TE: trailers" --compressed "${url}"`
                    : `curl -s -L -b "${cookieFile}" -c "${cookieFile}" -H "User-Agent: ${userAgent}" -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" -H "Accept-Language: en-US,en;q=0.5" -H "Accept-Encoding: gzip, deflate, br, zstd" -H "DNT: 1" -H "Connection: keep-alive" -H "Upgrade-Insecure-Requests: 1" -H "Sec-Fetch-Dest: document" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: same-origin" -H "Sec-Fetch-User: ?1" -H "Referer: ${base}/search?q=${encodeURIComponent(query)}&p=${index - 1}&order=0" -H "Priority: u=0, i" -H "TE: trailers" --compressed "${url}"`;

                return execPromise(curlCmd, execOptions)
                    .then(({ stdout }) => ({ pageNum: index + 1, html: stdout }))
                    .catch(error => {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} failed: ${error.message}`);
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
    }
}
