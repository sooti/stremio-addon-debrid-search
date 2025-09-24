// src/lib/scrapers.js
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import * as config from '../config.js';
import { getHashFromMagnet, sizeToBytes } from './torrent-utils.js';

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

/**
 * Checks if a torrent title is likely a junk/bootleg copy.
 * @param {string} title The title of the torrent.
 * @returns {boolean} True if the title is NOT junk, false otherwise.
 */
function isNotJunk(title) {
    if (!title) return true; // Don't filter out items that have no title
    return !JUNK_REGEX.test(title);
}

async function handleScraperError(error, scraperName, logPrefix) {
    if (!axios.isCancel(error)) {
        console.error(`[${logPrefix} SCRAPER] ${scraperName} search failed: ${error.message}`);
    }
}

export async function searchBitmagnet(query, signal, logPrefix) {
    const scraperName = 'Bitmagnet';
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    try {
        const url = `${config.BITMAGNET_URL}?t=search&q=${encodeURIComponent(query)}&limit=${config.TORZNAB_LIMIT}`;
        const response = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });
        const parsedXml = await parseStringPromise(response.data);
        const items = parsedXml.rss.channel[0].item || [];
        return items.map(item => {
            const attrs = item['torznab:attr']?.reduce((acc, attr) => ({ ...acc, [attr.$.name]: attr.$.value }), {});
            if (!attrs?.infohash) return null;
            return {
                Title: item.title[0], InfoHash: attrs.infohash,
                Size: parseInt(attrs.size) || 0,
                Seeders: parseInt(item.seeders?.[0]) || 0,
                Tracker: scraperName
            };
        }).filter(Boolean).filter(r => isNotJunk(r.Title));
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchJackett(query, signal, logPrefix) {
    const scraperName = 'Jackett';
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    try {
        const url = `${config.JACKETT_URL}/api/v2.0/indexers/all/results`;
        const response = await axios.get(url, {
            params: { apikey: config.JACKETT_API_KEY, Query: query },
            timeout: config.SCRAPER_TIMEOUT, signal
        });
        return (response.data.Results || []).slice(0, 200).map(r => ({
            Title: r.Title, InfoHash: r.InfoHash, Size: r.Size, Seeders: r.Seeders,
            Tracker: `${scraperName} | ${r.Tracker}`
        })).filter(r => isNotJunk(r.Title));
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchZilean(title, season, episode, signal, logPrefix) {
    const scraperName = 'Zilean';
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    try {
        let url = `${config.ZILEAN_URL}/dmm/filtered?query=${encodeURIComponent(title)}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;
        
        const response = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });
        let results = response.data || [];

        if (episode) {
            const targetEpisode = parseInt(episode);
            results = results.filter(result => {
                const episodes = Array.isArray(result.episodes) ? result.episodes : [];
                if (episodes.length === 0 || result.complete === true) return true; // Season pack
                return episodes.includes(targetEpisode);
            });
        }
        
        return results.slice(0, config.ZILEAN_LIMIT).map(r => ({
            Title: r.raw_title, InfoHash: r.info_hash, Size: parseInt(r.size),
            Seeders: null, Tracker: `${scraperName} | DMM`
        })).filter(r => isNotJunk(r.Title));
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchTorrentio(mediaType, mediaId, signal, logPrefix) {
    const scraperName = 'Torrentio';
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    try {
        const url = `${config.TORRENTIO_URL}/stream/${mediaType}/${mediaId}.json`;
        const response = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });
        const dataPattern = /(?:ðŸ‘ (\d+) )?ðŸ’ ([\d.]+ [KMGT]B)(?: âš™ï¸ (\w+))?/;
        return response.data.streams.slice(0, 200).map(stream => {
            const title = stream.title.split('\n')[0];
            const match = stream.title.match(dataPattern);
            const tracker = match?.[3] || 'Public';
            return {
                Title: title, InfoHash: stream.infoHash,
                Size: match ? sizeToBytes(match[2]) : 0,
                Seeders: match?.[1] ? parseInt(match[1]) : 0,
                Tracker: `${scraperName} | ${tracker}`
            };
        }).filter(r => isNotJunk(r.Title));
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchComet(mediaType, mediaId, signal, season, episode, logPrefix) {
    const scraperName = 'Comet';
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    try {
        let finalMediaId = mediaId;
        if (mediaType === 'series' && season && episode) {
            finalMediaId = `${mediaId}:${season}:${episode}`;
        }
        const url = `${config.COMET_URL}/stream/${mediaType}/${finalMediaId}.json`;
        const response = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });
        
        return (response.data.streams || []).slice(0, 200).map(stream => {
            const desc = stream.description;
            const title = desc.match(/ðŸ“ (.+)/)?.[1].trim() || 'Unknown Title';
            const seeders = parseInt(desc.match(/ðŸ‘ (\d+)/)?.[1] || '0');
            const tracker = desc.match(/ðŸ” (.+)/)?.[1].trim() || 'Public';
            return {
                Title: title, InfoHash: stream.infoHash,
                Size: stream.behaviorHints?.videoSize || 0,
                Seeders: seeders, Tracker: `${scraperName} | ${tracker}`
            };
        }).filter(r => isNotJunk(r.Title));
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchStremthru(query, signal, logPrefix) {
    const scraperName = 'StremThru';
    // This function is identical to searchBitmagnet but with a different URL and tracker name.
    // In a real-world scenario, you could abstract this further into a single "torznabSearch" function.
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    try {
        const url = `${config.STREMTHRU_URL}/v0/torznab/api?t=search&q=${encodeURIComponent(query)}`;
        const response = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });
        const parsedXml = await parseStringPromise(response.data);
        const items = parsedXml.rss.channel[0].item || [];
        return items.map(item => {
            const attrs = item['torznab:attr']?.reduce((acc, attr) => ({ ...acc, [attr.$.name]: attr.$.value }), {});
            if (!attrs?.infohash) return null;
            return {
                Title: item.title[0], InfoHash: attrs.infohash,
                Size: parseInt(attrs.size) || 0,
                Seeders: parseInt(item.seeders?.[0]) || 0,
                Tracker: scraperName
            };
        }).filter(Boolean).filter(r => isNotJunk(r.Title));
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchBt4g(query, signal, logPrefix) {
    const scraperName = 'BT4G';
    const maxPages = config.BT4G_MAX_PAGES || 3;
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    
    try {
        const allDetailPagePromises = [];

        for (let page = 0; page < maxPages; page++) {
            const searchUrl = `${config.BT4G_URL}/search?q=${encodeURIComponent(query)}&p=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching page ${page + 1}...`);
            
            const searchResponse = await axios.get(searchUrl, { timeout: config.SCRAPER_TIMEOUT, signal });
            const $ = cheerio.load(searchResponse.data);

            if ($('div.result-item').length === 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} no more results found on page ${page + 1}.`);
                break;
            }

            $('div.result-item').each((i, el) => {
                const detailPageLink = $(el).find('h5 > a').attr('href');
                if (detailPageLink) {
                    const detailPageUrl = `${config.BT4G_URL}${detailPageLink}`;
                    allDetailPagePromises.push(axios.get(detailPageUrl, { timeout: config.SCRAPER_TIMEOUT, signal }).catch(() => null));
                }
            });
        }

        const responses = await Promise.all(allDetailPagePromises);
        const results = [];
        
        for (const response of responses) {
            if (!response?.data) continue;
            try {
                const $$ = cheerio.load(response.data);
                const title = $$('h1.title').text().trim();
                const magnetLink = $$('a.btn-info').attr('href');
                const infoHash = getHashFromMagnet(magnetLink);
                if (!infoHash) continue;
                results.push({
                    Title: title, InfoHash: infoHash,
                    Size: sizeToBytes($$('#total-size').text().trim()),
                    Seeders: parseInt($$('#seeders').text().trim()) || 0,
                    Tracker: scraperName
                });
            } catch (e) { /* ignore single page parse error */ }
        }
        return results.filter(r => isNotJunk(r.Title));
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchTorrentGalaxy(searchKey, signal, logPrefix) {
    const scraperName = 'TorrentGalaxy';
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    try {
        const limit = config.TORRENTGALAXY_LIMIT || 200;
        const maxPages = config.TORRENTGALAXY_MAX_PAGES || 10;
        const base = (config.TORRENTGALAXY_URL || 'https://torrentgalaxy.space').replace(/\/$/, '');

        let page = 1;
        let accumulated = [];
        const seen = new Set();
        let pageSize = 50; 

        while (accumulated.length < limit && page <= maxPages) {
            const url = `${base}/get-posts/keywords:${encodeURIComponent(searchKey)}:format:json/?page=${page}`;
            const response = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });
            const payload = response.data || {};
            const results = Array.isArray(payload.results) ? payload.results : [];

            if (payload.page_size && Number.isFinite(Number(payload.page_size))) {
                pageSize = parseInt(payload.page_size, 10);
            }

            if (results.length === 0) break;

            for (const r of results) {
                if (accumulated.length >= limit) break;

                const title = r.n || 'Unknown Title';
                // Filter out junk results before processing them further
                if (!isNotJunk(title)) continue;

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
                    Tracker: `${scraperName} | ${r.u || 'Public'}`
                });
            }

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

export async function searchTorrentDownload(searchKey, signal, logPrefix) {
    const scraperName = 'TorrentDownload';
    console.time(`[${logPrefix} TIMER] ${scraperName}`);

    try {
        const limit = config.TORRENTDOWNLOAD_LIMIT || 200;
        const maxPages = config.TORRENTDOWNLOAD_MAX_PAGES || 10;
        const base = (config.TORRENTDOWNLOAD_URL || 'https://www.torrentdownload.info').replace(/\/$/, '');
        const trackers = 'udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=http%3A%2F%2Ftracker.ipv6tracker.ru%3A80%2Fannounce&tr=udp%3A%2F%2Fretracker.hotplug.ru%3A2710%2Fannounce&tr=https%3A%2F%2Ftracker.fastdownload.xyz%3A443%2Fannounce&tr=https%3A%2F%2Fopentracker.xyz%3A443%2Fannounce&tr=http%3A%2F%2Fopen.trackerlist.xyz%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.birkenwald.de%3A6969%2Fannounce&tr=https%3A%2F%2Ft.quic.ws%3A443%2Fannounce&tr=https%3A%2F%2Ftracker.parrotsec.org%3A443%2Fannounce&tr=udp%3A%2F%2Ftracker.supertracker.net%3A1337%2Fannounce&tr=http%3A%2F%2Fgwp2-v19.rinet.ru%3A80%2Fannounce&tr=udp%3A%2F%2Fbigfoot1942.sektori.org%3A6969%2Fannounce&tr=udp%3A%2F%2Fcarapax.net%3A6969%2Fannounce&tr=udp%3A%2F%2Fretracker.akado-ural.ru%3A80%2Fannounce&tr=udp%3A%2F%2Fretracker.maxnet.ua%3A80%2Fannounce&tr=udp%3A%2F%2Fbt.dy20188.com%3A80%2Fannounce&tr=http%3A%2F%2F0d.kebhana.mx%3A443%2Fannounce&tr=http%3A%2F%2Ftracker.files.fm%3A6969%2Fannounce&tr=http%3A%2F%2Fretracker.joxnet.ru%3A80%2Fannounce&tr=http%3A%2F%2Ftracker.moxing.party%3A6969%2Fannounce';

        let page = 1;
        const accumulated = [];
        const seen = new Set();
        const encoded = encodeURIComponent(searchKey).replace(/%20/g, '+');

        while (accumulated.length < limit && page <= maxPages) {
            const url = `${base}/search?q=${encoded}&p=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${url}`);

            const resp = await axios.get(url, { timeout: config.SCRAPER_TIMEOUT, signal });
            if (!resp?.data) break;

            // normalize whitespace similar to the python version
            const html = resp.data.replace(/\s+/g, ' ').trim();

            // find rows (mirrors Python pattern). Consider switching to cheerio for reliability.
            const trs = html.match(/<tr><td.+?tt-name.+?<\/tr>/gi) || [];
            if (trs.length === 0) break;

            for (const tr of trs) {
                if (accumulated.length >= limit) break;

                const re = /href="\/(.+?)">(.+?)<\/a>.*?tdnormal">([0-9,\.]+ (?:TB|GB|MB|KB)).*?tdseed">([0-9,]+).*?tdleech">([0-9,]+)/i;
                const m = tr.match(re);
                if (!m) continue;

                const pathPart = m[1].split('/')[0];
                let title = m[2].replace(/<span[^>]*>/gi, '').replace(/<\/span>/gi, '').trim();
                const rawSize = m[3].replace(/,/g, '').trim();
                const seeders = parseInt(m[4].replace(/,/g, ''), 10) || 0;

                // build magnet and try to obtain canonical hash
                const magnet = `magnet:?xt=urn:btih:${pathPart}&dn=&tr=${trackers}`;
                const maybeHash = getHashFromMagnet(magnet);
                const cleanedHash = (maybeHash || String(pathPart)).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
                if (!cleanedHash) continue;
                if (seen.has(cleanedHash)) continue;
                seen.add(cleanedHash);

                // convert size to bytes using existing helper; fallback to best-effort
                let sizeBytes = 0;
                try {
                    sizeBytes = sizeToBytes(rawSize);
                } catch (e) {
                    const num = parseFloat(rawSize.replace(/[^0-9\.]/g, '')) || 0;
                    const unit = rawSize.replace(/[^A-Za-z]/g, '').toUpperCase();
                    if (unit === 'TB') sizeBytes = num * 1024 ** 4;
                    else if (unit === 'GB') sizeBytes = num * 1024 ** 3;
                    else if (unit === 'MB') sizeBytes = num * 1024 ** 2;
                    else if (unit === 'KB') sizeBytes = num * 1024;
                }

                if (!isNotJunk(title)) continue;

                accumulated.push({
                    Title: title,
                    InfoHash: cleanedHash,
                    Size: Math.round(sizeBytes),
                    Seeders: seeders,
                    Tracker: scraperName,
                    // optional fields:
                    Magnet: magnet,
                    DescLink: `${base}/${m[1]}`
                });
            }

            page += 1;
        }

        return accumulated.slice(0, limit);
    } catch (error) {
        handleScraperError(error, 'TorrentDownload', logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}
