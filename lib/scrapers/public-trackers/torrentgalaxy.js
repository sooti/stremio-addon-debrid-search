import * as config from '../../config.js';
import { getSharedAxios } from '../../util/shared-axios.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { handleScraperError } from '../utils/error-handling.js';

// Use shared axios instance to prevent memory leaks
const axiosWithProxy = getSharedAxios('scrapers');

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
