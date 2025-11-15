import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { getHashFromMagnet } from '../../common/torrent-utils.js';
import { getSharedAxios } from '../../util/shared-axios.js';
import * as SqliteCache from '../../util/sqlite-cache.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Use shared axios instance to prevent memory leaks
const axiosWithProxy = getSharedAxios('scrapers');

export async function searchBluDV(query, signal, logPrefix, config) {
    const scraperName = 'BluDV';
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

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
