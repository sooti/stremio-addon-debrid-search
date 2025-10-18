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
        const maxPages = config?.TORRENTDOWNLOAD_MAX_PAGES || 3; // Reduce max pages to avoid timeouts
        const base = ((config?.TORRENTDOWNLOAD_URL || ENV.TORRENTDOWNLOAD_URL) || 'https://www.torrentdownload.info').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        let page = 1;
        const accumulated = [];
        const seen = new Set();
        const encoded = encodeURIComponent(searchKey).replace(/%20/g, '+');

        // Define headers to match the curl request
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Referer': 'https://www.torrentdownload.info/',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1',
            'Priority': 'u=0, i',
            'Cache-Control': 'max-age=0'
        };

        // Add cookie if available from config
        if (config?.TORRENTDOWNLOAD_COOKIE) {
            headers['Cookie'] = config.TORRENTDOWNLOAD_COOKIE;
        }

        while (accumulated.length < limit && page <= maxPages) {
            const url = `${base}/search?q=${encoded}&p=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${url}`);

            // Use a custom request that can handle zstd compression
            let response;
            try {
                // Since axios doesn't handle zstd natively, we need a custom approach
                // For now, let's try using node-fetch which might handle it better or use a workaround
                const nodeFetch = (await import('node-fetch')).default;
                
                const res = await nodeFetch(url, { 
                    headers,
                    signal, 
                    timeout: timeout 
                });

                if (!res.ok) {
                    throw new Error(`HTTP error! Status: ${res.status}`);
                }

                // Check if response is compressed with zstd
                const contentEncoding = res.headers.get('content-encoding');
                
                let html;
                if (contentEncoding && contentEncoding.toLowerCase().includes('zstd')) {
                    // For now, we'll handle this by getting the buffer and using a zstd library if available
                    // Since the zstd libraries had issues, let's try the approach with a fallback
                    const buffer = await res.buffer();
                    
                    // We need to decompress zstd manually, but since the libraries had issues,
                    // we'll try to use a more robust approach
                    try {
                        // Try to dynamically import a zstd module if available
                        let decompress;
                        try {
                            // Try the zstd-codec approach
                            const zstdCodec = await import('zstd-codec');
                            const ZstdCodec = zstdCodec.ZstdCodec;
                            ZstdCodec.run();
                            decompress = (buf) => {
                                const result = ZstdCodec.decode(new Uint8Array(buf));
                                return new TextDecoder().decode(result);
                            };
                        } catch (e) {
                            // Alternative approach: try to handle through axios with different settings
                            console.log(`Falling back to alternative method for zstd decompression`);
                            // If zstd libraries fail, we'll have to handle this differently
                            throw new Error('Zstd libraries not working, need to use alternative');
                        }
                        
                        html = decompress(buffer);
                    } catch (e) {
                        console.error('Zstd decompression failed, trying axios with different settings:', e.message);
                        // Fallback to axios which might handle it automatically in some cases
                        throw new Error('Zstd decompression is required but not available');
                    }
                } else {
                    html = await res.text();
                }
                
                response = { data: html };
            } catch (fetchError) {
                console.log(`node-fetch failed: ${fetchError.message}, trying axios with different settings...`);
                
                // Try with axios and handle the response manually
                const axiosResponse = await axios({
                    method: 'GET',
                    url: url,
                    headers: headers,
                    timeout: timeout,
                    signal: signal,
                    responseType: 'arraybuffer', // Get raw buffer to handle decompression manually
                    decompress: false // Disable automatic decompression to handle it ourselves
                });
                
                // Check if response is compressed with zstd
                const contentEncoding = axiosResponse.headers['content-encoding'];
                
                let html;
                if (contentEncoding && contentEncoding.toLowerCase().includes('zstd')) {
                    console.log('Response is zstd compressed, but decompression libraries may not be working');
                    // Since we know the libraries have issues, we'll need to rely on the system having support
                    // or find an alternative approach
                    const buffer = Buffer.from(axiosResponse.data);
                    
                    // At this point, without working zstd libraries, we might not be able to process the content
                    // This is a limitation we have to work around
                    throw new Error('Zstd compression detected but decompression library not available');
                } else {
                    // Handle other compression types or uncompressed content
                    html = Buffer.from(axiosResponse.data).toString('utf8');
                }
                
                response = { data: html };
            }

            if (!response?.data) break;

            const html = response.data;
            const $ = cheerio.load(html);
            let foundResults = false;

            // Look for table rows containing torrent info - this is the original pattern
            $('tr').each((index, element) => {
                if (accumulated.length >= limit) return false; // Break the loop if we've reached the limit

                const $row = $(element);
                
                // Look for the title link - typically in a cell with class tt-name or similar
                const $titleLink = $row.find('td a, td a[href*="/"]');
                
                if ($titleLink.length === 0) return; // Skip if no title link found

                const $firstLink = $titleLink.first();
                const title = $firstLink.text().trim();
                const href = $firstLink.attr('href');
                
                if (!title || !href) return;

                // Extract the info hash from the href (format: /hash/INFOHASH or similar)
                // Try to find the infohash in the URL
                const pathParts = href.split('/');
                let infoHash = null;
                
                // Look for a 40 character hex string in the URL path
                for (const part of pathParts) {
                    const hashMatch = part.match(/^([a-fA-F0-9]{40})$/);
                    if (hashMatch) {
                        infoHash = hashMatch[1].toLowerCase();
                        break;
                    }
                }
                
                // If not found in URL, try to get from text content
                if (!infoHash) {
                    const textMatch = $row.text().match(/([a-fA-F0-9]{40})/);
                    if (textMatch) {
                        infoHash = textMatch[1].toLowerCase();
                    }
                }

                // If we still can't find an info hash, skip this item
                if (!infoHash || infoHash.length !== 40) return;

                // Skip if we've already seen this hash
                if (seen.has(infoHash)) return;
                seen.add(infoHash);

                // Extract size from the row - look for size patterns
                let size = 0;
                const textContent = $row.text();
                const sizeMatch = textContent.match(/(\d+\.?\d*\s*[KMGT]?B)/i);
                if (sizeMatch) {
                    size = sizeToBytes(sizeMatch[0]);
                }

                // Extract seeders - find numbers in the row that could be seeders
                let seeders = 0;
                // Look for numbers in the row, typically seeders are positive integers
                const allNumbers = textContent.match(/\d+/g) || [];
                if (allNumbers.length > 0) {
                    // Take the largest number that seems reasonable for seeders
                    const numberValues = allNumbers.map(n => parseInt(n)).filter(n => !isNaN(n));
                    if (numberValues.length > 0) {
                        // Sort in descending order and take the first reasonable value
                        numberValues.sort((a, b) => b - a);
                        // Usually seeders won't be extremely large, so we'll cap at a reasonable value
                        for (const num of numberValues) {
                            if (num <= 1000000) { // reasonable upper limit
                                seeders = num;
                                break;
                            }
                        }
                    }
                }

                // Build the magnet link directly from the info hash
                const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                
                accumulated.push({
                    Title: title,
                    InfoHash: infoHash,
                    Size: size,
                    Seeders: seeders,
                    Tracker: scraperName,
                    Magnet: magnet,
                    DescLink: `${base}${href}`,
                    Langs: detectSimpleLangs(title)
                });
                
                foundResults = true;
            });

            // If no results were found on this page, break the loop
            if (!foundResults) break;
            
            page += 1;
        }
        
        const processedResults = processAndDeduplicate(accumulated.slice(0, limit), config);
        scraperCache.set(scraperName, searchKey, config, processedResults);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        // If the error is specifically about zstd decompression, provide a more helpful message
        if (error.message.includes('zstd') || error.message.includes('Zstd')) {
            console.error(`[${logPrefix} SCRAPER] ${scraperName} failed due to compression handling. The site uses zstd compression which requires additional setup.`);
        }
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
                if (!titleMatchesQuery(title, query)) {
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
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}${sfx}`);
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

export async function searchTorrentGalaxy(searchKey, signal, logPrefix) {



    const scraperName = 'TorrentGalaxy';


    console.time(`[${logPrefix} TIMER] ${scraperName}`);


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


            const response = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });


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


        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);


    }


}