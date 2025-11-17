import axios from 'axios';
import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { getHashFromMagnet, sizeToBytes } from '../../common/torrent-utils.js';
import debridProxyManager from '../../util/debrid-proxy.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Create axios instance with proxy support for scrapers
const axiosWithProxy = axios.create(debridProxyManager.getAxiosConfig('scrapers'));

export async function searchTorrent9(searchKey, signal, logPrefix, config) {
    const scraperName = 'Torrent9';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

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

        // MEMORY LEAK FIX: Clear response.data reference after parsing to prevent ArrayBuffer retention
        let searchResponseData = searchResponse.data;
        const $ = cheerio.load(searchResponseData);
        searchResponseData = null; // Release reference to allow GC
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

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
