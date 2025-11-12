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

export async function searchIlCorsaroNero(searchKey, signal, logPrefix, config) {
    const scraperName = 'IlCorsaroNero';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.ILCORSARONERO_LIMIT || 50;
        const base = ((config?.ILCORSARONERO_URL || ENV.ILCORSARONERO_URL) || 'https://ilcorsaronero.link').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        const searchUrl = `${base}/search?q=${encodeURIComponent(searchKey)}`;
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${searchUrl}`);

        const searchResponse = await axiosWithProxy.get(searchUrl, {
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(searchResponse.data);
        const accumulated = [];
        const seen = new Set();

        // Parse the results - looking for links in the format provided by the user
        // <a class="hover:underline line-clamp-1 w-screen md:w-auto" href="/torrent/64599/...">
        const allLinks = $('a.hover\\:underline[href^="/torrent/"]');

        if (allLinks.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} found no results in response`);
        }

        allLinks.each((i, el) => {
            if (accumulated.length >= limit) return false;

            const titleLink = $(el);
            const title = titleLink.text().trim();
            const detailPath = titleLink.attr('href');

            if (!detailPath || !title) return;

            // Extract the detail ID from the path (e.g., /torrent/64599/...)
            const pathParts = detailPath.split('/');
            const detailId = pathParts[2]; // The numeric ID

            if (!detailId || seen.has(detailId)) return;
            seen.add(detailId);

            accumulated.push({
                Title: title,
                DetailPath: detailPath,
                DetailId: detailId,
                Tracker: scraperName,
                Langs: detectSimpleLangs(title)
            });
        });

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${accumulated.length} results from search page`);

        // Now fetch detail pages to get magnet links and hashes (in batches to avoid overwhelming the server)
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

                    // Find the magnet link
                    const magnetLink = $detail('a[href^="magnet:"]').attr('href');

                    if (!magnetLink) continue;

                    const infoHash = getHashFromMagnet(magnetLink);
                    if (!infoHash) continue;

                    // Try to extract size from the detail page
                    // Looking for "Dimensione:" followed by the size value
                    let size = 0;
                    const sizeText = $detail('li:contains("Dimensione:")').text();
                    const sizeMatch = sizeText.match(/Dimensione:\s*(.+)/);
                    if (sizeMatch) {
                        size = sizeToBytes(sizeMatch[1].trim());
                    }

                    // Try to extract seeders
                    let seeders = 0;
                    const seedersDiv = $detail('div.text-green-500 i.fa-upload').parent();
                    if (seedersDiv.length > 0) {
                        const seedersText = seedersDiv.find('span').first().text().trim();
                        seeders = parseInt(seedersText) || 0;
                    }

                    results.push({
                        Title: item.Title,
                        InfoHash: infoHash,
                        Size: size,
                        Seeders: seeders,
                        Tracker: item.Tracker,
                        Langs: item.Langs,
                        Magnet: magnetLink
                    });
                } catch (e) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} error parsing detail page: ${e.message}`);
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
