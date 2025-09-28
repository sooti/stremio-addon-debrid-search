import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import * as config from '../config.js';
// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;
import { Snowfl } from 'snowfl-api';
// Import utilities
import { getHashFromMagnet, sizeToBytes, deduplicateAndKeepLargest } from './torrent-utils.js';


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
    fr: ['fr', 'french', 'vostfr', 'vf', 'vff'],
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
function processAndDeduplicate(results, config = {}) {
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

            const resp = await axios.get(url, { timeout, signal });
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
