import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import OC from 'offcloud-api';
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import { getCachedHashes as mongoGetCachedHashes, upsertCachedMagnet as mongoUpsert, default as mongoCache } from './common/mongo-cache.js';

const { isValidVideo, getHashFromMagnet, createEncodedUrl, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'OC';
const OFFCLOUD_API_URL = 'https://offcloud.com/api';

// ===================================================================================
// --- 1. CORE SEARCH ORCHESTRATOR ---
// ===================================================================================
async function searchOffcloudTorrents(apiKey, type, id, userConfig = {}) {
    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) { return []; }

    const searchKey = cinemetaDetails.name;
    const alternateTitles = cinemetaDetails.alternateTitles || [];
    const allSearchKeys = [searchKey, ...alternateTitles].filter(Boolean);
    const selectedLanguages = Array.isArray(userConfig.Languages) ? userConfig.Languages : [];
    const baseKey = type === 'series'
        ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

    const specificSearchKey = type === 'series'
        ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();
    
    let episodeInfo = null;
    if (type === 'series' && season && episode) {
        episodeInfo = {
            season: parseInt(season, 10),
            episode: parseInt(episode, 10)
        };
    }
    const seriesCtx = type === 'series' ? buildSeriesContext({ search: specificSearchKey, cinemetaTitle: cinemetaDetails.name }) : null;

    console.log(`[${LOG_PREFIX}] Starting unified search for: "${specificSearchKey}" (and ${alternateTitles.length} alternate titles)`);

    const abortController = new AbortController();
    const signal = abortController.signal;

    const scraperPromises = [];
    if (selectedLanguages.length === 0) {
        const cfg = { ...userConfig, Languages: [] };
        const key = baseKey;
        if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
        if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
        if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
        if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX, cfg));
        if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(key, signal, LOG_PREFIX, cfg));
        if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(key, signal, LOG_PREFIX, cfg));
    } else {
        for (const lang of selectedLanguages) {
            const cfg = { ...userConfig, Languages: [lang] };
            const key = baseKey;
            if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
            if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
            if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
            if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
            if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX, cfg));
            if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(key, signal, LOG_PREFIX, cfg));
            if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(key, signal, LOG_PREFIX, cfg));
            if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(key, signal, LOG_PREFIX, cfg));
            if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(key, signal, LOG_PREFIX, cfg));
        }
    }

    try {
        console.time(`[${LOG_PREFIX}] Total search time`);
        let [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, allSearchKeys, specificSearchKey, type, season, episode),
            ...scraperPromises
        ]);
        if (seriesCtx) {
            scraperResults = scraperResults.map(list => list.filter(t => matchesCandidateTitle(t, seriesCtx)));
            const s = seriesCtx.season, e = seriesCtx.episode;
            if (Number.isFinite(s) && Number.isFinite(e)) {
                scraperResults = scraperResults.map(list => list.filter(t => {
                    try {
                        const p = PTT.parse(t.Title || t.name || '');
                        if (p && p.season != null && p.episode != null) {
                            return Number(p.season) === Number(s) && Number(p.episode) === Number(e);
                        }
                        if (p && p.season != null && (p.episode === undefined || Array.isArray(p.episode))) {
                            return Number(p.season) === Number(s);
                        }
                    } catch {}
                    return matchesCandidateTitle(t, seriesCtx);
                }));
            }
        }
        console.timeEnd(`[${LOG_PREFIX}] Total search time`);
        
        let combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, episodeInfo);

        const bypassStreams = combinedResults.filter(stream => stream.bypassFiltering === true);

        if (type === 'movie' && cinemetaDetails.year) {
            const originalCount = combinedResults.length;
            const filtered = combinedResults.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
            console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}). Removed ${originalCount - filtered.length} mismatched results.`);
            return filtered;
        }

        console.log(`[${LOG_PREFIX}] Returning a combined total of ${combinedResults.length} unique streams.`);
        return combinedResults;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] A scraper may have failed, cancelling other requests.`);
        abortController.abort();
        const completedResults = await Promise.all(scraperPromises.map(p => p.catch(() => [])));
        const personalFiles = await searchPersonalFiles(apiKey, allSearchKeys, specificSearchKey, type, season, episode);
        
        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, completedResults, episodeInfo);
        
        const bypassStreams = combinedResults.filter(stream => stream.bypassFiltering === true);
        if (bypassStreams.length > 0) {
            console.log(`[${LOG_PREFIX} FINAL ERROR] Found ${bypassStreams.length} bypass streams - returning ONLY these direct cloud links`);
            return bypassStreams;
        }
        
        return combinedResults;
    }
}

// ===================================================================================
// --- 2. SEARCH & COMBINE LOGIC (OC-Specific) ---
// ===================================================================================
async function searchPersonalFiles(apiKey, searchKeys, specificSearchKey, type, season, episode) {
    console.time('[OC TIMER] Personal Cloud');
    const OCClient = new OC(apiKey);
    try {
        const keys = Array.isArray(searchKeys) ? searchKeys : [searchKeys];
        const primaryKey = keys[0];

        const history = await OCClient.cloud.history();

        // **PRIORITY 1: Check for exact archive name matches first**
        const primarySearchTerm = specificSearchKey || primaryKey;
        if (primarySearchTerm && type === 'series' && season && episode) {
            console.log(`[OC EXACT] Checking for exact archive matches for: "${primarySearchTerm}"`);
            
            const exactArchiveMatch = await findExactArchiveMatch(OCClient, primarySearchTerm, history, season, episode);
            if (exactArchiveMatch) {
                console.log(`[OC EXACT] Found exact archive match, returning ONLY this direct cloud link.`);
                console.log(`[OC EXACT] Final result: ${JSON.stringify({
                    name: exactArchiveMatch.name,
                    url: exactArchiveMatch.url,
                    bypassFiltering: exactArchiveMatch.bypassFiltering
                })}`);
                console.timeEnd('[OC TIMER] Personal Cloud');
                // **CRITICAL: Return ONLY the direct match, no other processing**
                return [exactArchiveMatch];
            }
        }

        // **FALLBACK: Only if no exact match found**
        const relevantHistory = filterHistoryByKeywords(history, primaryKey);
        console.log(`[OC] Pre-filtered personal history from ${history.length} to ${relevantHistory.length} relevant items.`);

        const torrents = await processTorrents(OCClient, relevantHistory);
        console.log(`[OC] Expanded personal cloud to ${torrents.length} video files.`);

        if (torrents.length === 0) {
            console.log(`[OC] No video files found after processing relevant history.`);
            console.timeEnd('[OC TIMER] Personal Cloud');
            return [];
        }

        const enhancedTorrents = torrents.map(torrent => ({
            ...torrent,
            cleanedName: cleanFileName(torrent.name)
        }));

        const fuse = new Fuse(enhancedTorrents, {
            keys: [
                { name: 'searchableName', weight: 0.4 },
                { name: 'name', weight: 0.3 },
                { name: 'info.title', weight: 0.2 },
                { name: 'cleanedName', weight: 0.1 }
            ],
            threshold: 0.6,
            minMatchCharLength: 2,
            ignoreLocation: true,
            includeScore: true,
        });

        const results = fuse.search(primarySearchTerm);
        console.log(`[OC] Fuzzy search "${primarySearchTerm}": found ${results.length} matches`);

        if (results.length > 0) {
            console.log(`[OC] Best fuzzy match: "${results[0].item.name}" (score: ${results[0].score})`);
        }

        const uniqueResults = [...new Map(results.map(result => [result.item.url, result])).values()]
            .sort((a, b) => a.score - b.score);

        console.log(`[OC] Found ${uniqueResults.length} personal files after search.`);
        console.timeEnd('[OC TIMER] Personal Cloud');
        return uniqueResults.map((result) => result.item);
    } catch (error) {
        console.timeEnd('[OC TIMER] Personal Cloud');
        console.error(`[OC] Personal files search error: ${error.message}`);
        return [];
    }
}

async function findExactArchiveMatch(OCClient, searchTerm, history, season, episode) {
    const MIN_SIZE = 350 * 1024 * 1024;
    function normalize(str) { return str.toLowerCase().replace(/[\.\-\_\s]/g, ''); }
    
    const showName = searchTerm.split(' s0')[0];
    const normalizedShowName = normalize(showName);
    
    const seasonStr = String(season).padStart(2, '0');
    const episodeStr = String(episode).padStart(2, '0');
    const seasonEpisodePatterns = [`s${seasonStr}e${episodeStr}`, `s${season}e${episode}`, `s${season}e${episodeStr}`, `s${seasonStr}e${episode}`];
    
    for (const item of history) {
        if (!item.fileName) {
            continue;
        }
        const normalizedFileName = normalize(item.fileName);
        const hasShowName = normalizedFileName.includes(normalizedShowName);
        const hasSeasonEpisode = seasonEpisodePatterns.some(p => normalizedFileName.includes(normalize(p)));
        
        if (hasShowName && hasSeasonEpisode && item.isDirectory) {
            console.log(`[${LOG_PREFIX} EXACT] Found exact match archive: "${item.fileName}"`);
            try {
                const urls = await OCClient.cloud.explore(item.requestId);
                if (!urls || urls.length === 0) continue;

                let fileDetails = [];
                try {
                    fileDetails = await OCClient.cloud.explore(item.requestId, { details: true }) || [];
                } catch {
                    fileDetails = urls.map(url => ({ url, size: 0 }));
                }

                let largestVideoUrl = null;
                let largestVideoSize = 0;
                
                for (let i = 0; i < Math.max(fileDetails.length, urls.length); i++) {
                    const fileInfo = fileDetails[i] || {};
                    const url = fileInfo.url || urls[i];
                    if (!url) continue;

                    const fileSize = fileInfo.size || 0;
                    const fileName = decodeURIComponent(url.split('/').pop());
                    
                    if (!isValidVideo(fileName, fileSize, 10 * 1024 * 1024, LOG_PREFIX)) continue;

                    const effectiveSize = fileSize || MIN_SIZE;
                    if (effectiveSize > largestVideoSize) {
                        largestVideoUrl = createEncodedUrl(url);
                        largestVideoSize = effectiveSize;
                    }
                }

                if (largestVideoUrl) {
                    return {
                        id: item.requestId, name: item.fileName, searchableName: item.fileName,
                        info: PTT.parse(item.fileName), size: item.fileSize || 0,
                        hash: getHashFromMagnet(item.originalLink), url: largestVideoUrl,
                        source: 'offcloud', isPersonal: true, tracker: 'Personal',
                        bypassFiltering: true
                    };
                }
            } catch (error) {
                console.log(`[${LOG_PREFIX} EXACT] Error exploring "${item.fileName}": ${error.message}`);
            }
        }
    }
    return null;
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources, episodeInfo = null) {
    const externalTorrents = [].concat(...externalSources);
    const externalTorrentsMap = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]).filter(([hash]) => hash));

    // **FIX 2 - Enrich personal files with size from external torrents**
    const enrichedPersonalFiles = personalFiles.map(file => {
        if (file.hash && (!file.size || file.size === 0)) {
            const externalMatch = externalTorrentsMap.get(file.hash.toLowerCase());
            if (externalMatch) {
                const newSize = externalMatch.Size || externalMatch.size || externalMatch.filesize || 0;
                if (newSize > 0) {
                    return { ...file, size: newSize };
                }
            }
        }
        return file;
    });

    const personalHashes = new Set(enrichedPersonalFiles.map(f => f.hash).filter(Boolean));
    const markedPersonal = enrichedPersonalFiles.map(file => ({ ...file, source: 'offcloud', isPersonal: true, tracker: 'Personal' }));
    
    const newExternalTorrents = Array.from(externalTorrentsMap.values()).filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

    const ocHandler = {
        getIdentifier: () => LOG_PREFIX,
        checkCachedHashes: async (hashes) => {
            if (!hashes || hashes.length === 0) return new Set();
            const lower = hashes.map(h => h.toLowerCase());
            const cached = new Set();
            try {
                if (mongoCache?.isEnabled()) {
                    const local = await mongoGetCachedHashes('offcloud', lower);
                    local.forEach(h => cached.add(h));
                }
            } catch {}
            const remaining = lower.filter(h => !cached.has(h));
            if (remaining.length === 0) return cached;
            const url = `${OFFCLOUD_API_URL}/cache?key=${apiKey}`;
            try {
                const response = await axios.post(url, { hashes: remaining });
                const remote = new Set(response.data.cachedItems || []);
                remote.forEach(h => cached.add(h));
                return cached;
            } catch (error) {
                console.error(`[${LOG_PREFIX}] !! FATAL: OffCloud cache check failed. All external results will be hidden.`);
                if (error.response) console.error(`[${LOG_PREFIX}] Cache Check Error: Status ${error.response.status} - ${JSON.stringify(error.response.data)}`);
                else console.error(`[${LOG_PREFIX}] Cache Check Error: ${error.message}`);
                return cached; // return what we have
            }
        },
        liveCheckHash: async (hash) => false,
        cleanup: async () => {}
    };

    const cachedTorrents = await processAndFilterTorrents(newExternalTorrents, ocHandler, episodeInfo, {});
    
    const finalExternalResults = cachedTorrents.map(formatExternalResult);

    const allResults = [...markedPersonal, ...finalExternalResults];

    // Persist OffCloud cached items to Mongo
    try {
        if (mongoCache?.isEnabled()) {
            const toPersist = allResults.filter(r => r?.hash);
            for (const r of toPersist) {
                await mongoUpsert({ service: 'offcloud', hash: r.hash.toLowerCase(), fileName: r.name || null, size: r.size || null });
            }
        }
    } catch {}

    return allResults;
}


function cleanFileName(filename) {
    return filename
        .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm)$/i, '')
        .replace(/[\.\-\_]/g, ' ')
        .replace(/\b(1080p|720p|480p|2160p|4k)\b/gi, '')
        .replace(/\b(bluray|webrip|hdtv|dvdrip|brrip|x264|x265|h264|h265|dts|ac3|aac|ma|hd)\b/gi, '')
        .replace(/\b(yify|rarbg|ettv|nogrp)\b/gi, '')
        .replace(/\b\d{4}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatExternalResult(result) {
    return {
        name: result.Title, 
        info: PTT.parse(result.Title) || { title: result.Title },
        size: result.Size || result.size || result.filesize || 0, 
        seeders: result.Seeders,
        url: `magnet:?xt=urn:btih:${result.InfoHash}`,
        source: 'offcloud', 
        hash: result.InfoHash.toLowerCase(),
        tracker: result.Tracker,
        languages: Array.isArray(result.Langs) ? result.Langs : [],
        isPersonal: false,
        isCached: true
    };
}

// ===================================================================================
// --- 3. STREAM RESOLVER LOGIC (OC-Specific) ---
// ===================================================================================
async function resolveStream(apiKey, urlToResolve, type, id) {
    if (!urlToResolve.startsWith('magnet:')) return urlToResolve;
    const hash = getHashFromMagnet(urlToResolve);
    if (!hash) return null;

    const OCClient = new OC(apiKey);
    let searchKey = '';

    if (id) {
        const [imdbId, season, episode] = id.split(':');
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        if (cinemetaDetails) {
            searchKey = type === 'series' && season && episode
                ? `${cinemetaDetails.name} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
                : cinemetaDetails.name;
        }
    }

    const history = await OCClient.cloud.history();
    if (searchKey) {
        const relevantHistory = filterHistoryByKeywords(history, searchKey);
        const torrents = await processTorrents(OCClient, relevantHistory);
        const existingFile = torrents.find(file => file.hash === hash);
        if (existingFile) return existingFile.url;

        const exactMatchResult = await findLargestVideoInArchive(OCClient, searchKey, relevantHistory);
        if (exactMatchResult) return exactMatchResult.url;
    }

    const hashMatchResult = await findLargestVideoByHash(OCClient, hash, history);
    if (hashMatchResult) return hashMatchResult.url;

    const addedItem = await addToOffcloud(apiKey, urlToResolve);
    if (!addedItem?.requestId) return null;

    const newItemInHistory = await waitForItemInHistory(OCClient, addedItem.requestId);
    if (newItemInHistory) {
        const processedFiles = await processTorrents(OCClient, [newItemInHistory]);
        if (processedFiles.length > 0) {
            processedFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
            return processedFiles[0].url;
        }
    }
    return null;
}

// ===================================================================================
// --- 4. HELPER FUNCTIONS (OC-Specific) ---
// ===================================================================================
async function findLargestVideoInArchive(OCClient, searchKey, relevantHistory) {
    const MIN_FALLBACK_SIZE = 350 * 1024 * 1024;
    const fuse = new Fuse(relevantHistory, { keys: ['fileName'], threshold: 0.4, includeScore: true });
    const archiveMatches = fuse.search(searchKey);
    if (archiveMatches.length === 0) return null;

    let allLargeVideos = [];
    for (const match of archiveMatches) {
        try {
            const videoFiles = await processHistoryEntry(OCClient, match.item);
            if (!videoFiles || videoFiles.length === 0) continue;
            const largeFiles = (Array.isArray(videoFiles) ? videoFiles : [videoFiles])
                .filter(file => file?.size && file.size > MIN_FALLBACK_SIZE);
            allLargeVideos.push(...largeFiles);
        } catch {}
    }

    if (allLargeVideos.length > 0) {
        allLargeVideos.sort((a, b) => b.size - a.size);
        return allLargeVideos[0];
    }
    return null;
}

async function findLargestVideoByHash(OCClient, targetHash, history) {
    const MIN_FALLBACK_SIZE = 350 * 1024 * 1024;
    const matchingArchives = history.filter(item => getHashFromMagnet(item.originalLink)?.toLowerCase() === targetHash.toLowerCase());
    if (matchingArchives.length === 0) return null;

    let allLargeVideos = [];
    for (const archive of matchingArchives) {
        try {
            const videoFiles = await processHistoryEntry(OCClient, archive);
            if (videoFiles?.length > 0) {
                const largeFiles = (Array.isArray(videoFiles) ? videoFiles : [videoFiles])
                    .filter(file => file?.size && file.size > MIN_FALLBACK_SIZE);
                allLargeVideos.push(...largeFiles);
            }
        } catch {}
    }

    if (allLargeVideos.length > 0) {
        allLargeVideos.sort((a, b) => b.size - a.size);
        return allLargeVideos[0];
    }
    return null;
}

async function addToOffcloud(apiKey, magnetLink) {
    const url = `${OFFCLOUD_API_URL}/cloud?key=${apiKey}`;
    try {
        return (await axios.post(url, { url: magnetLink })).data;
    } catch {
        return null;
    }
}

async function waitForItemInHistory(OCClient, requestId, timeout = 30000, interval = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const history = await OCClient.cloud.history();
        const newItem = history.find(item => item.requestId === requestId);
        if (newItem?.fileName) return newItem;
        await delay(interval);
    }
    return null;
}

async function processTorrents(client, history) {
    const promises = history.map(item => processHistoryEntry(client, item));
    const results = await Promise.all(promises);
    return results.flat().filter(Boolean);
}

async function processHistoryEntry(client, item) {
    // **START: ROBUSTNESS FIX - Skip history items without a filename**
    if (!item.fileName) {
        return null;
    }
    // **END: ROBUSTNESS FIX**
    const isSingleVideo = /\.(mp4|mkv|mov|avi|flv|wmv|webm)$/i.test(item.fileName);
    const downloadUrl = `https://${item.server}.offcloud.com/cloud/download/${item.requestId}/${item.fileName}`;

    if (isSingleVideo) {
        if (isValidVideo(item.fileName, item.fileSize, 50 * 1024 * 1024, LOG_PREFIX)) {
            return {
                id: item.requestId, name: item.fileName, searchableName: item.fileName,
                info: PTT.parse(item.fileName), size: item.fileSize,
                hash: getHashFromMagnet(item.originalLink), url: createEncodedUrl(downloadUrl)
            };
        }
        return null;
    }

    try {
        const urls = await client.cloud.explore(item.requestId);
        if (!Array.isArray(urls) || urls.length === 0) return null;
        
        const hash = getHashFromMagnet(item.originalLink);
        let fileDetails = [];
        try {
            fileDetails = await client.cloud.explore(item.requestId, { details: true }) || [];
        } catch {
            fileDetails = urls.map(url => ({ url, size: 0 }));
        }

        return fileDetails.map((fileInfo, index) => {
            const url = fileInfo.url || urls[index];
            if (!url) return null; // Additional guard for safety
            const fileName = decodeURIComponent(url.split('/').pop());
            const fileSize = fileInfo.size || 0;
            if (!isValidVideo(fileName, fileSize, 50 * 1024 * 1024, LOG_PREFIX)) return null;

            return {
                id: item.requestId, name: fileName, searchableName: `${item.fileName} ${fileName}`,
                info: PTT.parse(fileName), size: fileSize || item.fileSize,
                hash: hash, url: createEncodedUrl(url)
            };
        }).filter(Boolean);
    } catch {
        if (isValidVideo(item.fileName, item.fileSize, 50 * 1024 * 1024, LOG_PREFIX)) {
            return {
                id: item.requestId, name: item.fileName, searchableName: item.fileName,
                info: PTT.parse(item.fileName), size: item.fileSize,
                hash: getHashFromMagnet(item.originalLink), url: createEncodedUrl(downloadUrl)
            };
        }
        return null;
    }
}

function getKeywords(str) {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'for', 'with']);
    const normalized = str.toLowerCase().replace(/[\._-]/g, ' ').replace(/[':()\[\]]/g, '').replace(/\s+/g, ' ').trim();
    return normalized.split(' ').filter(word => word.length > 1 && !stopWords.has(word) && !/^(1080p|720p|bluray|webrip)$/.test(word)).filter(Boolean);
}

function filterHistoryByKeywords(history, searchKey) {
    const searchKeywords = getKeywords(searchKey);
    if (searchKeywords.length === 0) return [];
    const requiredMatches = searchKeywords.length <= 2 ? searchKeywords.length : Math.max(2, Math.ceil(searchKeywords.length * 0.5));

    return history.filter(item => {
        if (!item.fileName) return false;
        const itemNameLower = item.fileName.toLowerCase().replace(/[\._-]/g, ' ');
        const actualMatches = searchKeywords.reduce((count, keyword) => itemNameLower.includes(keyword) ? count + 1 : count, 0);
        return actualMatches >= requiredMatches;
    });
}

export default { searchOffcloudTorrents, resolveStream };