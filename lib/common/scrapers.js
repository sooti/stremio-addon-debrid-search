// src/lib/scrapers.js
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import * as config from '../config.js';
import { getHashFromMagnet, sizeToBytes } from './torrent-utils.js';

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
        }).filter(Boolean);
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
        }));
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
        }));
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
        const dataPattern = /(?:👤 (\d+) )?💾 ([\d.]+ [KMGT]B)(?: ⚙️ (\w+))?/;
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
        });
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
            const title = desc.match(/📄 (.+)/)?.[1].trim() || 'Unknown Title';
            const seeders = parseInt(desc.match(/👤 (\d+)/)?.[1] || '0');
            const tracker = desc.match(/🔎 (.+)/)?.[1].trim() || 'Public';
            return {
                Title: title, InfoHash: stream.infoHash,
                Size: stream.behaviorHints?.videoSize || 0,
                Seeders: seeders, Tracker: `${scraperName} | ${tracker}`
            };
        });
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
        }).filter(Boolean);
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(`[${logPrefix} TIMER] ${scraperName}`);
    }
}

export async function searchBt4g(query, signal, logPrefix) {
    const scraperName = 'BT4G';
    // Use the config setting for max pages, or default to 3 if not set.
    const maxPages = config.BT4G_MAX_PAGES || 3;
    console.time(`[${logPrefix} TIMER] ${scraperName}`);
    
    try {
        const allDetailPagePromises = [];

        // 1. Loop through the desired number of search result pages.
        for (let page = 0; page < maxPages; page++) {
            const searchUrl = `${config.BT4G_URL}/search?q=${encodeURIComponent(query)}&p=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching page ${page + 1}...`);
            
            const searchResponse = await axios.get(searchUrl, { timeout: config.SCRAPER_TIMEOUT, signal });
            const $ = cheerio.load(searchResponse.data);

            // Break the loop if there are no results on the page
            if ($('div.result-item').length === 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} no more results found on page ${page + 1}.`);
                break;
            }

            // 2. Collect all detail page links from the current search page.
            $('div.result-item').each((i, el) => {
                const detailPageLink = $(el).find('h5 > a').attr('href');
                if (detailPageLink) {
                    const detailPageUrl = `${config.BT4G_URL}${detailPageLink}`;
                    // Add the promise to our master list
                    allDetailPagePromises.push(axios.get(detailPageUrl, { timeout: config.SCRAPER_TIMEOUT, signal }).catch(() => null));
                }
            });
        }

        // 3. Await all the collected detail page promises from all pages.
        const responses = await Promise.all(allDetailPagePromises);
        const results = [];
        
        // 4. Process the responses as before.
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
        return results;
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
