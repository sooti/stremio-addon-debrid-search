import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import * as config from '../../config.js';
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

export async function searchStremthru(mediaType, mediaId, signal, season, episode, logPrefix, config) {
    const scraperName = 'StremThru';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const base = (config?.STREMTHRU_URL || ENV.STREMTHRU_URL || '').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build URL based on media type - use tvsearch or movie with imdbid
        let url;
        if (mediaType === 'series') {
            url = `${base}/v0/torznab/api?t=tvsearch&imdbid=${mediaId}`;
            if (season) url += `&season=${season}`;
            if (episode) url += `&ep=${episode}`;
        } else {
            url = `${base}/v0/torznab/api?t=movie&imdbid=${mediaId}`;
        }

        let torznabResults = [];

        // Get results from traditional Torznab API (original approach)
        try {
            const response = await axiosWithProxy.get(url, { timeout, signal });
            const parsedXml = await parseStringPromise(response.data);

            // Add null checks for RSS structure
            if (!parsedXml?.rss?.channel?.[0]) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} returned invalid RSS structure.`);
                // Continue, we may get results from Torz-style API
            } else {
                const items = parsedXml.rss.channel[0].item || [];
                const results = items.map(item => {
                    const attrs = item['torznab:attr']?.reduce((acc, attr) => ({ ...acc, [attr.$.name]: attr.$.value }), {});
                    if (!attrs?.infohash) return null;
                    return {
                        Title: item.title[0], InfoHash: attrs.infohash,
                        Size: parseInt(attrs.size) || 0,
                        Seeders: parseInt(item.seeders?.[0]) || 0,
                        Tracker: scraperName,
                        Langs: detectSimpleLangs(item.title[0]),
                        Source: 'torznab' // Mark the source
                    };
                });
                torznabResults = results.filter(Boolean);
            }
        } catch (torznabError) {
            console.error(`[${logPrefix} STREMTHRU] Torznab API error:`, torznabError.message);
            // Continue, we may get results from Torz-style API
        }

        // Get results from Torz-style API (direct stremId approach like Torz uses)
        let torzStyleResults = [];
        if (config?.DEBRID_TOKEN && config?.DEBRID_SERVICE) {
            try {
                // Build the correct mediaId for Torz-style endpoint
                const stremId = mediaType === 'series' && season && episode
                    ? `${mediaId}:${season}:${episode}`
                    : mediaId;

                torzStyleResults = await stremThru.getCombinedTorrents(
                    mediaType === 'series' ? 'series' : 'movie',
                    stremId,
                    config.DEBRID_SERVICE,
                    config.DEBRID_TOKEN,
                    config
                );

                // Mark these as coming from Torz source and ensure proper format
                torzStyleResults = torzStyleResults.map(t => ({
                    Title: t.Title || t.name || 'Unknown Title',
                    InfoHash: t.InfoHash || t.infoHash || t.hash,
                    Size: t.Size || t.size || 0,
                    Seeders: t.Seeders || t.seeders || 0,
                    Tracker: `${scraperName} | TorzAPI`,
                    Langs: detectSimpleLangs(t.Title || t.name || ''),
                    Source: 'torz',
                    isConfirmedCached: true // Mark as already verified cached
                })).filter(t => t.InfoHash); // Only keep items with valid infohash
            } catch (torzError) {
                console.error(`[${logPrefix} STREMTHRU] Torz-style API error:`, torzError.message);
                // Continue with torznab results only
            }
        }

        // Combine both sets of results, avoiding duplicates by infohash
        const allResultsMap = new Map();

        // Add Torznab results first
        for (const result of torznabResults) {
            if (result?.InfoHash) {
                allResultsMap.set(result.InfoHash.toLowerCase(), result);
            }
        }

        // Add Torz-style results (will override if same infohash exists)
        for (const result of torzStyleResults) {
            if (result?.InfoHash) {
                // If it's from Torz, it's confirmed cached, so we can prioritize it
                const existing = allResultsMap.get(result.InfoHash.toLowerCase());
                if (!existing) {
                    allResultsMap.set(result.InfoHash.toLowerCase(), result);
                } else if (existing?.Source !== 'torz') {
                    // Prioritize Torz results over Torznab if they have the same hash
                    // Add additional info from existing result while keeping torz marker
                    allResultsMap.set(result.InfoHash.toLowerCase(), {...result, ...existing, Source: 'torz'});
                }
            }
        }

        const combinedResults = Array.from(allResultsMap.values());
        const processedResults = processAndDeduplicate(combinedResults, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${torznabResults.length} results from Torznab API, ${torzStyleResults.length} from Torz-style API. Combined: ${combinedResults.length}, processed: ${processedResults.length}`);

        // If debrid service is configured, get cached results from Torz API and SQLite
        if (config?.DEBRID_TOKEN && config?.DEBRID_SERVICE) {
            const results = [];

            // Get results directly from Torz API (confirmed cached results)
            try {
                console.log(`[${logPrefix} STREMTHRU] Fetching cached results directly from Torz-style API for ${mediaType}/${mediaId}:${season || ''}:${episode || ''}`);

                // Build the correct mediaId for Torz-style endpoint
                const stremId = mediaType === 'series' && season && episode
                    ? `${mediaId}:${season}:${episode}`
                    : mediaId;

                // Create token object like in the example
                const tokenObj = {
                    stores: [{
                        c: config.DEBRID_SERVICE.toLowerCase() === 'realdebrid' ? 'rd' :
                           config.DEBRID_SERVICE.toLowerCase() === 'alldebrid' ? 'ad' :
                           config.DEBRID_SERVICE.toLowerCase(),
                        t: config.DEBRID_TOKEN
                    }],
                    cached: true
                };

                // Encode as base64 URL-safe (same as example)
                const token = Buffer.from(JSON.stringify(tokenObj)).toString('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/, '');

                // Call the Torz endpoint directly - use the exact same pattern as working Torz example
                const torzBaseUrl = (config?.STREMTHRU_URL || ENV.STREMTHRU_URL || '').replace(/\/$/, '');
                const mediaIdForUrl = mediaType === 'series' && season && episode
                    ? `${mediaId}:${season}:${episode}`
                    : mediaId;
                const torzUrl = `${torzBaseUrl}/stremio/torz/${token}/stream/${mediaType}/${mediaIdForUrl}.json`;

                const torzResponse = await axiosWithProxy.get(torzUrl, {
                    timeout: config?.SCRAPER_TIMEOUT ?? 15000,
                    signal
                });

                const torzStreams = torzResponse.data?.streams || [];

                // Convert streams to our result format
                const torzResults = torzStreams.map(stream => ({
                    Title: stream.description || stream.name || stream.title || 'Unknown Title',
                    InfoHash: stream.infoHash || stream.InfoHash || null,
                    Size: stream._size || stream.size || (stream.url ? parseInt(stream.url.match(/size=(\d+)/)?.[1]) : 0) || 0,
                    Seeders: 0, // Torz doesn't typically return seeders in stream format
                    Tracker: `StremThru | Torz-Direct`,
                    Langs: detectSimpleLangs(stream.name || stream.title || ''),
                    Source: 'torz-direct',
                    url: stream.url
                })).filter(r => r.InfoHash); // Only keep results with valid infohash

                console.log(`[${logPrefix} STREMTHRU] Got ${torzResults.length} cached results from Torz direct API`);
                results.push(...torzResults);

            } catch (torzError) {
                const status = torzError.response?.status;

                // Handle known error codes gracefully
                if (status === 404) {
                    console.log(`[${logPrefix} STREMTHRU] Torz endpoint not available (404) - using SQLite cache only`);
                } else if (status === 403) {
                    console.log(`[${logPrefix} STREMTHRU] Torz API access forbidden for ${config.DEBRID_SERVICE} (may not be supported yet)`);
                } else if (status === 500 || status === 503) {
                    console.log(`[${logPrefix} STREMTHRU] Torz API temporarily unavailable for ${config.DEBRID_SERVICE} (status ${status}) - using SQLite cache only`);
                } else {
                    console.error(`[${logPrefix} STREMTHRU] Direct Torz API call failed:`, torzError.message);
                }
                // Continue anyway since we'll still get SQLite cached results
            }

            // Get cached results from SQLite for this service
            try {
                const allHashes = processedResults.map(r => r.InfoHash.toLowerCase()).filter(Boolean);
                if (allHashes.length > 0) {
                    console.log(`[${logPrefix} STREMTHRU] Checking ${allHashes.length} hashes in SQLite cache for ${config.DEBRID_SERVICE}`);
                    const cachedHashesFromSqlite = await sqliteCache.getCachedHashes(config.DEBRID_SERVICE, allHashes);
                    console.log(`[${logPrefix} STREMTHRU] Found ${cachedHashesFromSqlite.size} cached hashes from SQLite`);

                    if (cachedHashesFromSqlite.size > 0) {
                        const sqliteResults = processedResults.filter(r => cachedHashesFromSqlite.has(r.InfoHash.toLowerCase()));
                        console.log(`[${logPrefix} STREMTHRU] ${sqliteResults.length} results found in SQLite cache`);

                        // Add SQLite results that aren't already in Torz results (avoid duplicates)
                        const existingHashes = new Set(results.map(r => r.InfoHash.toLowerCase()));
                        for (const result of sqliteResults) {
                            const hash = result.InfoHash.toLowerCase();
                            if (!existingHashes.has(hash)) {
                                results.push({...result, Source: 'sqlite'});
                                existingHashes.add(hash);
                            }
                        }
                    }
                }
            } catch (sqliteError) {
                console.error(`[${logPrefix} STREMTHRU] SQLite cache check failed:`, sqliteError.message);
            }

            if (results.length > 0) {
                console.log(`[${logPrefix} STREMTHRU] Returning ${results.length} combined cached results (from Torz direct API + SQLite cache)`);
                const deduplicatedResults = processAndDeduplicate(results, config);
                console.log(`[${logPrefix} STREMTHRU] After deduplication: ${deduplicatedResults.length} results`);
                return deduplicatedResults;
            } else {
                console.log(`[${logPrefix} STREMTHRU] No cached results found from Torz direct API or SQLite, falling back to ${processedResults.length} scraped results`);
                return processedResults;
            }
        }

        // If no debrid service configured, return all results
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
