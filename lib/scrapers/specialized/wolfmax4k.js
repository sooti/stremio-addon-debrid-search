import axios from 'axios';
import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import debridProxyManager from '../../util/debrid-proxy.js';
import * as SqliteCache from '../../util/sqlite-cache.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Create axios instance with proxy support for scrapers
const axiosWithProxy = axios.create(debridProxyManager.getAxiosConfig('scrapers'));

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
// IMPORTANT: Wolfmax4K doesn't provide real magnet links or infohashes
// This creates a synthetic hash that WON'T work with debrid services
// This is a known limitation - these torrents may not be downloadable via debrid
async function createWolfmax4KInfoHash(guid) {
    const crypto = await import('crypto');
    return crypto.createHash('sha1').update(guid).digest('hex');
}

export async function searchWolfmax4K(query, signal, logPrefix, config) {
    const scraperName = 'Wolfmax4K';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, query, config);
    const cachedResult = await SqliteCache.getCachedRecord('scraper', cacheKey);
    const cached = cachedResult?.data || null;

    if (cached && Array.isArray(cached)) {
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

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);

        // Save results to cache for future requests
        if (processedResults.length > 0) {
            try {
                await SqliteCache.upsertCachedMagnet({
                    service: 'scraper',
                    hash: cacheKey,
                    data: processedResults
                });
                console.log(`[${logPrefix} SCRAPER] ${scraperName} saved ${processedResults.length} results to cache`);
            } catch (cacheError) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} failed to save to cache: ${cacheError.message}`);
            }
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
