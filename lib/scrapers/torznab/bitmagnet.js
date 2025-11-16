import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import * as config from '../../config.js';
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

export async function searchBitmagnet(query, signal, logPrefix, config) {
    const scraperName = 'Bitmagnet';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const base = (config?.BITMAGNET_URL || ENV.BITMAGNET_URL || '').replace(/\/$/, '');
        const limit = config?.TORZNAB_LIMIT ?? ENV.TORZNAB_LIMIT;
        // Increase timeout for Bitmagnet as it can be slow - use at least 10 seconds
        const timeout = Math.max(config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT, 1500);
        const url = `${base}?t=search&q=${encodeURIComponent(query)}&limit=${limit}`;
        const response = await axiosWithProxy.get(url, { timeout, signal });

        // CRITICAL: Clear response.data reference after parsing to prevent memory retention
        let responseData = response.data;
        const parsedXml = await parseStringPromise(responseData);
        responseData = null; // Release reference to allow GC

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
        console.timeEnd(timerLabel);
    }
}
