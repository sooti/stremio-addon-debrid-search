import axios from 'axios';
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

export async function searchComet(mediaType, mediaId, signal, season, episode, logPrefix, config) {
    const scraperName = 'Comet';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const query = (mediaType === 'series' && season && episode) ? `${mediaId}:${season}:${episode}` : mediaId;

    try {
        let finalMediaId = mediaId;
        if (mediaType === 'series' && season && episode) {
            finalMediaId = `${mediaId}:${season}:${episode}`;
        }
        const base = (config?.COMET_URL || ENV.COMET_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const url = `${base}/stream/${mediaType}/${finalMediaId}.json`;
        const response = await axiosWithProxy.get(url, { timeout, signal });

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
        console.timeEnd(timerLabel);
    }
}
