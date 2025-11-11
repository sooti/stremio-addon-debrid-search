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

export async function searchJackett(query, signal, logPrefix, config) {
    const scraperName = 'Jackett';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const base = (config?.JACKETT_URL || ENV.JACKETT_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        // Enhanced error handling and debugging
        const apiKey = config?.JACKETT_API_KEY ?? ENV.JACKETT_API_KEY;
        if (!base) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} JACKETT_URL not configured`);
            return [];
        }

        if (!apiKey) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} JACKETT_API_KEY not configured`);
            return [];
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} attempting direct search across all indexers...`);
        const url = `${base}/api/v2.0/indexers/all/results`;
        const response = await axiosWithProxy.get(url, {
            params: { apikey: apiKey, Query: query },
            timeout,
            signal,
            headers: {
                'User-Agent': 'Sooti/1.0',
                'Accept': 'application/json'
            }
        });

        const rawResults = response.data.Results || [];
        console.log(`[${logPrefix} SCRAPER] ${scraperName} direct search found ${rawResults.length} raw results from all indexers.`);

        // Debug log for first few direct search results
        if (rawResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} sample direct search results:`);
            rawResults.slice(0, 5).forEach((result, idx) => {
                console.log(`  ${idx + 1}. ${result.Title.substring(0, 60)}${result.Title.length > 60 ? '...' : ''} | ${Math.round(result.Size / (1024*1024*1024))}GB | ${result.Seeders} seeders | ${result.Tracker || result.tracker || 'Unknown'}`);
            });
        }

        const results = rawResults.slice(0, 200).map(r => ({
            Title: r.Title,
            InfoHash: r.InfoHash,
            Size: r.Size || 0,
            Seeders: r.Seeders || r.seeders || 0,
            Tracker: `${scraperName} | ${r.Tracker || r.tracker || r.indexer || 'Unknown'}`,
            Langs: detectSimpleLangs(r.Title)
        }));

        const processedResults = processAndDeduplicate(results, config);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} direct search failed (${error.message}), trying fallback approaches...`);

        // Fallback: Try the legacy approach with lowercase 'q' parameter as final fallback
        try {
            const base = (config?.JACKETT_URL || ENV.JACKETT_URL || '').replace(/\/$/, '');
            const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
            const apiKey = config?.JACKETT_API_KEY ?? ENV.JACKETT_API_KEY;

            if (!base || !apiKey) {
                return [];
            }

            console.log(`[${logPrefix} SCRAPER] ${scraperName} trying legacy search approach with lowercase parameter...`);
            const searchUrl = `${base}/api/v2.0/indexers/all/results`;
            const response = await axiosWithProxy.get(searchUrl, {
                params: {
                    apikey: apiKey,
                    q: query  // Legacy lowercase parameter
                },
                timeout,
                signal,
                headers: {
                    'User-Agent': 'Sooti/1.0',
                    'Accept': 'application/json'
                }
            });

            const rawResults = response.data.Results || [];
            console.log(`[${logPrefix} SCRAPER] ${scraperName} legacy search found ${rawResults.length} raw results.`);

            // Debug log for first few legacy search results
            if (rawResults.length > 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} sample legacy search results:`);
                rawResults.slice(0, 5).forEach((result, idx) => {
                    console.log(`  ${idx + 1}. ${result.Title.substring(0, 60)}${result.Title.length > 60 ? '...' : ''} | ${Math.round(result.Size / (1024*1024*1024))}GB | ${result.Seeders} seeders | ${result.Tracker || 'Unknown'}`);
                });
            }

            const results = rawResults.slice(0, 200).map(r => ({
                Title: r.Title,
                InfoHash: r.InfoHash,
                Size: r.Size || 0,
                Seeders: r.Seeders || r.seeders || 0,
                Tracker: `${scraperName} | ${r.Tracker || r.tracker || 'Unknown'}`,
                Langs: detectSimpleLangs(r.Title)
            }));

            const processedResults = processAndDeduplicate(results, config);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing ${rawResults.length} raw results using legacy search.`);
            return processedResults;
        } catch (legacyError) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} legacy search also failed (${legacyError.message}).`);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} all approaches failed. The Jackett server might be down, misconfigured, or the API key may be incorrect.`);
            handleScraperError(error, scraperName, logPrefix);
            return [];
        }
    } finally {
        console.timeEnd(timerLabel);
    }
}
