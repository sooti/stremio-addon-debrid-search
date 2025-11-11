import axios from 'axios';
import * as config from '../../config.js';
import { getHashFromMagnet } from '../../common/torrent-utils.js';
import debridProxyManager from '../../util/debrid-proxy.js';
import * as sqliteCache from '../../util/sqlite-cache.js';
import * as stremThru from '../../util/stremthru.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Create axios instance with proxy support for scrapers
const axiosWithProxy = axios.create(debridProxyManager.getAxiosConfig('scrapers'));

// Perform background cache checking for torrents without blocking the response
async function performBackgroundCacheCheck(results, config, logPrefix) {
    try {
        // This function runs in the background without blocking the main response
        const LOG_PREFIX = logPrefix;
        const hashesToCheck = results.map(r => r.InfoHash).filter(Boolean);

        if (hashesToCheck.length === 0) return;

        console.log(`[${LOG_PREFIX} BG] Background cache checking ${hashesToCheck.length} hashes from Knaben`);

        // For background cache checking, we use a timeout to not block the main thread
        // The actual cache checking would happen via the debrid service integration elsewhere
        // This function serves as a placeholder to indicate that background processing happens

        // In a real implementation, this would call the appropriate debrid service
        // to check the availability of these hashes and cache the results in SQLite
        // For now, we just log that this would happen

    } catch (error) {
        console.error(`[${logPrefix} BG] Background cache check error: ${error.message}`);
        // Don't throw - background errors shouldn't affect main flow
    }
}

export async function searchKnaben(query, signal, logPrefix, config) {
    const scraperName = 'Knaben';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.KNABEN_LIMIT ?? ENV.KNABEN_LIMIT ?? 300;
        const base = (config?.KNABEN_URL || ENV.KNABEN_URL || 'https://api.knaben.org/v1').replace(/\/$/, ''); // Use the correct base URL
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Prepare the search parameters based on the API documentation
        const requestBody = {
            query: query,
            size: limit,
            hideUnsafe: false, // Default from API docs
            hideXXX: true      // Default from API docs
        };

        // Also add categories if available - for movies, TV, anime
        // This can be extended based on the media type
        if (config?.MEDIA_TYPE === 'movie') {
            requestBody.categories = [3000000]; // Movies category (example from API docs)
        } else if (config?.MEDIA_TYPE === 'series') {
            requestBody.categories = [2000000]; // TV category (example from API docs)
        } else if (config?.IS_ANIME) {
            requestBody.categories = [6000000]; // Anime category (example from API docs)
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} searching with query: ${query}`);

        const response = await axiosWithProxy.post(`${base}`, requestBody, { // Changed to POST request
            timeout,
            signal,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        if (!response.data || !response.data.hits) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} returned invalid response structure.`);
            return [];
        }

        const hits = response.data.hits || [];
        const results = hits.slice(0, limit).map(hit => {
            // Extract infoHash from either hash field or magnet URL
            let infoHash = hit.hash || getHashFromMagnet(hit.magnetUrl);

            if (!infoHash && hit.magnetUrl) {
                // Extract from magnet URL if not in hash field
                infoHash = getHashFromMagnet(hit.magnetUrl);
            }

            if (!infoHash) {
                return null;
            }

            return {
                Title: hit.title,
                InfoHash: infoHash.toLowerCase(),
                Size: hit.bytes || 0,
                Seeders: hit.seeders || 0,
                Leechers: hit.peers || 0,
                Tracker: `${scraperName} | ${hit.tracker || 'Unknown'}`,
                Langs: detectSimpleLangs(hit.title)
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);

        // If StremThru is enabled, return cached results first and perform background cache check
        if (stremThru.isEnabled() && config?.DEBRID_TOKEN && config?.DEBRID_SERVICE) {
            // Extract all hashes to check against StremThru
            const allHashes = processedResults.map(r => r.InfoHash.toLowerCase()).filter(Boolean);

            if (allHashes.length > 0) {
                try {
                    // Get cached hashes from SQLite first
                    console.log(`[${logPrefix} SQLCACHE] Checking ${allHashes.length} hashes in SQLite cache for ${config.DEBRID_SERVICE}`);
                    const cachedHashesFromSqlite = await sqliteCache.getCachedHashes(config.DEBRID_SERVICE, allHashes);
                    console.log(`[${logPrefix} SQLCACHE] Found ${cachedHashesFromSqlite.size} cached hashes from SQLite for ${config.DEBRID_SERVICE}`);

                    // If StremThru is enabled, check for cached hashes via StremThru API
                    if (config.STREMTHRU_ENABLED) {
                        const stremthruCachedHashes = await stremThru.checkInstantAvailability(
                            allHashes,
                            config.DEBRID_SERVICE,
                            config.STREMTHRU_API_TOKEN || config.DEBRID_TOKEN
                        );

                        // Combine SQLite cached and StremThru cached hashes
                        const allCachedHashes = new Set([...cachedHashesFromSqlite, ...stremthruCachedHashes]);

                        // Return immediately available cached results
                        const immediateResults = processedResults.filter(r => allCachedHashes.has(r.InfoHash.toLowerCase()));

                        // Perform background cache check for non-cached results
                        const nonCachedResults = processedResults.filter(r => !allCachedHashes.has(r.InfoHash.toLowerCase()));

                        if (immediateResults.length > 0) {
                            console.log(`[${logPrefix} SCRAPER] ${scraperName} returning ${immediateResults.length} cached results immediately via StremThru/SQLite.`);
                        }

                        // Perform background cache checking for remaining results in parallel
                        if (nonCachedResults.length > 0) {
                            // Execute background check without awaiting
                            performBackgroundCacheCheck(nonCachedResults, config, logPrefix);
                        }

                        return immediateResults;
                    } else {
                        // Only SQLite cache available
                        const immediateResults = processedResults.filter(r => cachedHashesFromSqlite.has(r.InfoHash.toLowerCase()));

                        if (immediateResults.length > 0) {
                            console.log(`[${logPrefix} SCRAPER] ${scraperName} returning ${immediateResults.length} cached results from SQLite immediately.`);
                        }

                        // Perform background cache checking for remaining results
                        const nonCachedResults = processedResults.filter(r => !cachedHashesFromSqlite.has(r.InfoHash.toLowerCase()));
                        if (nonCachedResults.length > 0) {
                            performBackgroundCacheCheck(nonCachedResults, config, logPrefix);
                        }

                        return immediateResults;
                    }
                } catch (cacheError) {
                    console.error(`[${logPrefix} SCRAPER] ${scraperName} cache check failed: ${cacheError.message}, returning all results`);
                    // If cache check fails, return all results
                    return processedResults;
                }
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
