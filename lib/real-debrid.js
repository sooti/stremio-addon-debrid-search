import RealDebridClient from 'real-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import { promises as fs } from 'fs';
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';

const { isValidVideo, isValidTorrentTitle, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'RD';

const personalHashCache = new Set();
let globalAbortController = null;

function createAbortController() {
    if (globalAbortController) {
        globalAbortController.abort();
    }
    globalAbortController = new AbortController();
    return globalAbortController;
}

// ===================================================================================
// --- FILE-BASED HASH CACHING (RD-Specific) ---
// ===================================================================================
let fileHashCache = new Map();

async function loadHashCache() {
    if (!config.RD_HASH_CACHE_ENABLED) return;
    try {
        await fs.access(config.RD_HASH_CACHE_PATH);
        const data = await fs.readFile(config.RD_HASH_CACHE_PATH, 'utf-8');
        const jsonCache = JSON.parse(data);
        fileHashCache = new Map(Object.entries(jsonCache));
        
        const expirationTime = Date.now() - (config.RD_HASH_CACHE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
        let prunedCount = 0;
        for (const [hash, timestamp] of fileHashCache.entries()) {
            if (timestamp < expirationTime) {
                fileHashCache.delete(hash);
                prunedCount++;
            }
        }
        console.log(`[FILE CACHE] Loaded ${fileHashCache.size} hashes. Pruned ${prunedCount} expired entries.`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[FILE CACHE] Cache file not found. A new one will be created.');
            fileHashCache = new Map();
        } else {
            console.error(`[FILE CACHE] Error loading hash cache: ${error.message}`);
        }
    }
}

async function saveHashCache() {
    if (!config.RD_HASH_CACHE_ENABLED) return;
    try {
        const cacheObject = Object.fromEntries(fileHashCache);
        await fs.writeFile(config.RD_HASH_CACHE_PATH, JSON.stringify(cacheObject, null, 2));
        console.log(`[FILE CACHE] Saved ${fileHashCache.size} hashes to disk.`);
    } catch (error) {
        console.error(`[FILE CACHE] Error saving hash cache: ${error.message}`);
    }
}

function addHashToCache(hash) {
    if (!config.RD_HASH_CACHE_ENABLED || !hash) return;
    fileHashCache.set(hash.toLowerCase(), Date.now());
}

function isHashInCache(hash) {
    if (!config.RD_HASH_CACHE_ENABLED || !hash) return false;
    return fileHashCache.has(hash.toLowerCase());
}

// ===================================================================================
// --- CACHE & PRIORITY SYSTEM (RD-Specific) ---
// ===================================================================================
async function buildPersonalHashCache(apiKey) {
    try {
        const RD = new RealDebridClient(apiKey);
        const existingTorrents = await getAllTorrents(RD);
        personalHashCache.clear();
        existingTorrents.forEach(torrent => {
            if (torrent.hash) {
                personalHashCache.add(torrent.hash.toLowerCase());
            }
        });
        console.log(`[RD CACHE] Built personal hash cache with ${personalHashCache.size} torrents`);
        return personalHashCache;
    } catch (error) {
        console.error(`[RD CACHE] Error building personal cache: ${error.message}`);
        return personalHashCache;
    }
}

async function cleanupTemporaryTorrents(RD, torrentIds) {
    console.log(`[RD CLEANUP] 🧹 Starting background deletion of ${torrentIds.length} temporary torrents.`);
    for (const torrentId of torrentIds) {
        try {
            await RD.torrents.delete(torrentId);
            await delay(500); 
        } catch (deleteError) {
            if (deleteError.response?.status === 429) {
                console.warn(`[RD CLEANUP] Rate limited. Pausing for 5 seconds...`);
                await delay(5000);
                await RD.torrents.delete(torrentId).catch(retryError => {
                    console.error(`[RD CLEANUP] ❌ Failed to delete torrent ${torrentId} on retry: ${retryError.message}`);
                });
            } else {
                console.error(`[RD CLEANUP] ❌ Error deleting torrent ${torrentId}: ${deleteError.message}`);
            }
        }
    }
    console.log(`[RD CLEANUP] ✅ Finished background deletion task.`);
}

// ===================================================================================
// --- FORMATTING & COMBINING RESULTS ---
// ===================================================================================
function formatCachedResult(torrent, isCached) {
    const title = torrent.Title || torrent.name || 'Unknown Title';
    const url = torrent.url && torrent.isPersonal 
        ? torrent.url 
        : `magnet:?xt=urn:btih:${torrent.InfoHash}`;

    return {
        name: title,
        info: PTT.parse(title) || { title: title },
        size: torrent.Size || torrent.size || torrent.filesize || 0,
        seeders: torrent.Seeders || torrent.seeders || 0,
        url: url,
        source: 'realdebrid',
        hash: (torrent.InfoHash || torrent.hash || '').toLowerCase(),
        tracker: torrent.Tracker || (torrent.isPersonal ? 'Personal' : 'Cached'),
        isPersonal: torrent.isPersonal || false,
        isCached: isCached
    };
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
        isPersonal: false,
        isCached: true
    };
}

function combineAndMarkResults(apiKey, personalFiles, externalSources, specificSearchKey) {
    const sourceNames = ['Bitmagnet', 'Jackett', 'Torrentio', 'Zilean', 'Comet', 'StremThru', 'BT4G'];
    const enabledFlags = [config.BITMAGNET_ENABLED, config.JACKETT_ENABLED, config.TORRENTIO_ENABLED, config.ZILEAN_ENABLED, config.COMET_ENABLED, config.STREMTHRU_ENABLED, config.BT4G_ENABLED];
    let sourceCounts = `Personal(${personalFiles.length})`;
    let sourceIndex = 0;
    for (let i = 0; i < enabledFlags.length; i++) {
        if (enabledFlags[i]) {
            sourceCounts += `, ${sourceNames[i]}(${externalSources[sourceIndex]?.length || 0})`;
            sourceIndex++;
        }
    }
    console.log(`[${LOG_PREFIX}] Sources found: ${sourceCounts}`);

    const markedPersonal = personalFiles.map(file => ({ ...file, source: 'realdebrid', isPersonal: true, tracker: 'Personal' }));
    const externalTorrents = [].concat(...externalSources);
    const uniqueExternalTorrents = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]));
    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    
    // This now works directly with the raw scraper data, preserving the Tracker property
    const newExternalTorrents = Array.from(uniqueExternalTorrents.values()).filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

    console.log(`[${LOG_PREFIX}] Performing sanity check on ${newExternalTorrents.length} external results for query: "${specificSearchKey}"`);
    const fuse = new Fuse(newExternalTorrents, { keys: ['Title', 'name'], threshold: 0.5, minMatchCharLength: 4 });
    const saneResults = fuse.search(specificSearchKey).map(r => r.item);
    
    const rejectedCount = newExternalTorrents.length - saneResults.length;
    if (rejectedCount > 0) {
        console.log(`[${LOG_PREFIX}] Sanity check REJECTED ${rejectedCount} irrelevant results.`);
    }

    console.log(`[${LOG_PREFIX}] After all filtering: ${personalFiles.length} personal + ${saneResults.length} valid external`);
    return [...markedPersonal, ...saneResults];
}

// ===================================================================================
// --- MAIN SEARCH FUNCTIONS ---
// ===================================================================================
async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
    console.log(`[${LOG_PREFIX}] Starting search for: "${searchKey}"`);
    if (!searchKey) return [];

    const abortController = createAbortController();
    const signal = abortController.signal;

    try {
        console.time(`[${LOG_PREFIX}] Personal files`);
        const personalFiles = await searchPersonalFiles(apiKey, searchKey, threshold);
        console.timeEnd(`[${LOG_PREFIX}] Personal files`);
        
        console.log(`[${LOG_PREFIX}] Searching external sources...`);
        const scraperPromises = [];
        if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(searchKey, signal, LOG_PREFIX));
        if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(searchKey, signal, LOG_PREFIX));
	    if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, null, null, signal, LOG_PREFIX));
        if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet('movie', 'unknown', signal, null, null, LOG_PREFIX));
        if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(searchKey, signal, LOG_PREFIX));
        if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(searchKey, signal, LOG_PREFIX));

        let scraperResults = [];
        try {
            scraperResults = await Promise.all(scraperPromises);
            console.log(`[${LOG_PREFIX}] External scrapers completed`);
        } catch (error) {
            console.log(`[${LOG_PREFIX}] Scraper error: ${error.message}`);
            scraperResults = [];
        }

        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, searchKey);
        if (combinedResults.length === 0) return personalFiles;

        const externalTorrents = combinedResults.filter(t => !t.isPersonal);
        if (externalTorrents.length === 0) return personalFiles;

        const cachedResults = await checkAndProcessCache(apiKey, externalTorrents);
        
        console.log(`[${LOG_PREFIX}] Final: ${personalFiles.length} personal + ${cachedResults.length} cached`);
        return [...personalFiles, ...cachedResults];

    } catch (error) {
        console.error(`[${LOG_PREFIX}] Search error: ${error.message}`);
        return [];
    } finally {
        if (abortController === globalAbortController) {
            globalAbortController = null;
        }
    }
}

async function searchRealDebridTorrents(apiKey, type, id) {
    if (!id || typeof id !== 'string') {
        console.error(`[${LOG_PREFIX}] Invalid id parameter: ${id}`);
        return [];
    }

    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) { return []; }

    const searchKey = cinemetaDetails.name;
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

    console.log(`[${LOG_PREFIX}] Comprehensive search for: "${specificSearchKey}"`);

    const abortController = createAbortController();
    const signal = abortController.signal;

    const scraperPromises = [];
    if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(specificSearchKey, signal, LOG_PREFIX));
    if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(specificSearchKey, signal, LOG_PREFIX));
    if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX));
    if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX));
    if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX));
    if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(specificSearchKey, signal, LOG_PREFIX));
    if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(specificSearchKey, signal, LOG_PREFIX));

    try {
        console.time(`[${LOG_PREFIX}] Comprehensive series search`);
        const [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, searchKey, 0.3),
            ...scraperPromises
        ]);
        console.timeEnd(`[${LOG_PREFIX}] Comprehensive series search`);

        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, specificSearchKey);
        
        let externalTorrents = combinedResults.filter(t => !t.isPersonal);
        
        if (type === 'movie' && cinemetaDetails.year) {
            const originalCount = externalTorrents.length;
            externalTorrents = externalTorrents.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
            console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}): ${originalCount} -> ${externalTorrents.length} external torrents remain.`);
        }
        
        await loadHashCache();
        const RD = new RealDebridClient(apiKey);
        const torrentIdsToDelete = new Set();

        const rdHandler = {
            getIdentifier: () => LOG_PREFIX,
            checkCachedHashes: async (hashes) => {
                const cached = new Set();
                hashes.forEach(hash => {
                    if (isHashInCache(hash)) {
                        cached.add(hash);
                    }
                });
                return cached;
            },
            liveCheckHash: async (hash) => {
                let torrentId;
                try {
                    const magnet = `magnet:?xt=urn:btih:${hash}`;
                    const addResponse = await RD.torrents.addMagnet(magnet).catch(() => null);
                    if (!addResponse?.data?.id) return false;

                    torrentId = addResponse.data.id;
                    torrentIdsToDelete.add(torrentId);

                    await RD.torrents.selectFiles(torrentId, 'all');
                    const torrentInfo = await RD.torrents.info(torrentId).catch(() => null);

                    if (torrentInfo?.data?.status === 'downloaded' || torrentInfo?.data?.status === 'finished') {
                        const hasVideo = torrentInfo.data.files.some(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
                        if (hasVideo) {
                            addHashToCache(hash);
                            return true;
                        }
                    }
                } catch (error) {
                    // silent fail
                }
                return false;
            },
            // **START: REWRITTEN BATCH FUNCTION FOR PARALLEL EXECUTION**
            batchCheckSeasonPacks: async (hashes, season, episode) => {
                const inspectPack = async (hash) => {
                    let torrentId = null;
                    try {
                        const magnet = `magnet:?xt=urn:btih:${hash}`;
                        const addResponse = await RD.torrents.addMagnet(magnet).catch(() => null);
                        if (!addResponse?.data?.id) return null;
                        
                        torrentId = addResponse.data.id;
                        const torrentInfo = await RD.torrents.info(torrentId).catch(() => null);
                        const files = torrentInfo?.data?.files;

                        if (files && files.length > 0) {
                            const paddedSeason = String(season).padStart(2, '0');
                            const paddedEpisode = String(episode).padStart(2, '0');
                            const episodePattern = new RegExp(`[sS]${paddedSeason}[eE]${paddedEpisode}|\\b${season}x${paddedEpisode}\\b`, 'i');
                            
                            const hasEpisodeFile = files.some(file => 
                                episodePattern.test(file.path) && 
                                isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX)
                            );

                            if (hasEpisodeFile) {
                                addHashToCache(hash);
                                return hash; // Return the hash if valid
                            }
                        }
                    } catch (error) {
                        console.error(`[${LOG_PREFIX}] Error during batch pack inspection for hash ${hash}: ${error.message}`);
                    } finally {
                        if (torrentId) {
                            await RD.torrents.delete(torrentId).catch(() => {});
                        }
                    }
                    return null; // Return null if not valid
                };

                const promises = [];
                let index = 0;
                for (const hash of hashes) {
                    // Stagger the start of each promise to avoid bursting the API
                    const promise = new Promise(resolve => setTimeout(resolve, index * 250)).then(() => inspectPack(hash));
                    promises.push(promise);
                    index++;
                }

                const results = await Promise.all(promises);
                // Filter out null results and return a Set of valid hashes
                return new Set(results.filter(Boolean));
            },
            // **END: REWRITTEN BATCH FUNCTION**
            cleanup: async () => {
                await saveHashCache();
                if (torrentIdsToDelete.size > 0) {
                    cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete));
                }
            }
        };

        const cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, episodeInfo);

        const combined = [...personalFiles, ...cachedResults];
        let allResults = combined.map(torrent => formatCachedResult(torrent, torrent.isCached));
        
        allResults.sort((a, b) => {
            const resA = getResolutionFromName(a.name || a.Title);
            const resB = getResolutionFromName(b.name || b.Title);
            const rankA = resolutionOrder[resA] || 0;
            const rankB = resolutionOrder[resB] || 0;
            if (rankA !== rankB) return rankB - rankA;
            return (b.size || 0) - (a.size || 0);
        });

        console.log(`[${LOG_PREFIX}] Comprehensive total: ${allResults.length} streams (sorted)`);
        return allResults;

    } catch (error) {
        console.error(`[${LOG_PREFIX}] Comprehensive search failed: ${error.message}`);
        return [];
    } finally {
        if (abortController === globalAbortController) {
            globalAbortController = null;
        }
    }
}

// ===================================================================================
// --- PERSONAL FILES & UNRESTRICT ---
// ===================================================================================
async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
    const RD = new RealDebridClient(apiKey);
    try {
        const [existingTorrents, existingDownloads] = await Promise.all([
            getAllTorrents(RD).catch(() => []),
            getAllDownloads(RD).catch(() => [])
        ]);
        console.log(`[${LOG_PREFIX}] Found ${existingTorrents.length} torrents, ${existingDownloads.length} downloads`);
        const relevantTorrents = filterFilesByKeywords(existingTorrents, searchKey);
        const relevantDownloads = filterFilesByKeywords(existingDownloads, searchKey);
        if (relevantTorrents.length === 0 && relevantDownloads.length === 0) return [];
        
        const torrentFiles = await processTorrents(RD, relevantTorrents.slice(0, 5));
        const allFiles = [...torrentFiles, ...relevantDownloads.map(d => formatDownloadFile(d))];
        if (allFiles.length === 0) return [];

        // De-duplication step to ensure each unique file link is processed only once.
        const uniqueFiles = [...new Map(allFiles.map(file => [file.url, file])).values()];

        const enhancedFiles = uniqueFiles.map(file => ({ ...file, source: 'realdebrid', isPersonal: true, info: PTT.parse(file.name) }));
        const fuse = new Fuse(enhancedFiles, { keys: ['info.title', 'name'], threshold: threshold, minMatchCharLength: 2 });
        return fuse.search(searchKey).map(r => r.item);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Personal files error: ${error.message}`);
        return [];
    }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
    const RD = new RealDebridClient(apiKey, { ip: clientIp });
    try {
        if (!hostUrl || hostUrl === 'undefined' || hostUrl.includes('undefined')) {
            console.error(`[${LOG_PREFIX}] Invalid URL for unrestrict: ${hostUrl}`);
            return null;
        }
        console.log(`[${LOG_PREFIX}] Unrestricting: ${hostUrl.substring(0, 50)}...`);
        const response = await RD.unrestrict.link(hostUrl);
        const directStreamingUrl = response?.data?.download;
        if (!directStreamingUrl) {
            console.error(`[${LOG_PREFIX}] No direct streaming URL in response`);
            return null;
        }
        console.log(`[${LOG_PREFIX}] Got direct streaming URL: ${directStreamingUrl.substring(0, 80)}...`);
        return directStreamingUrl;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Unrestrict error: ${error.message}`);
        return null;
    }
}

// ===================================================================================
// --- HELPER & CATALOG FUNCTIONS ---
// ===================================================================================
async function getAllTorrents(RD) {
    const allTorrents = [];
    try {
        for (let page = 1; page <= 2; page++) {
            const response = await RD.torrents.get(0, page, 100);
            const torrents = response.data;
            if (!torrents || torrents.length === 0) break;
            allTorrents.push(...torrents);
            if (torrents.length < 50) break;
        }
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error fetching torrents: ${error.message}`);
    }
    return allTorrents;
}

async function getAllDownloads(RD) {
    const allDownloads = [];
    try {
        const response = await RD.downloads.get(0, 1, 100);
        const downloads = response.data || [];
        const nonTorrentDownloads = downloads.filter(d => d.host !== 'real-debrid.com');
        allDownloads.push(...nonTorrentDownloads);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error fetching downloads: ${error.message}`);
    }
    return allDownloads;
}

async function processTorrents(RD, torrents) {
    const allVideoFiles = [];
    for (const torrent of torrents.slice(0, 3)) {
        try {
            const torrentDetails = await RD.torrents.info(torrent.id);
            if (!torrentDetails?.data?.files || !torrentDetails.data.links) continue;
            const videoFiles = torrentDetails.data.files
                .filter(file => file.selected && isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX));
            for (const file of videoFiles) {
                const fileIndex = torrentDetails.data.files.findIndex(f => f.id === file.id);
                const directUrl = torrentDetails.data.links?.[fileIndex];
                if (directUrl && directUrl !== 'undefined') {
                    allVideoFiles.push({
                        id: `${torrent.id}:${file.id}`, name: file.path, info: PTT.parse(file.path),
                        size: file.bytes, hash: torrent.hash, url: directUrl, source: 'realdebrid',
                        isPersonal: true, tracker: 'Personal'
                    });
                }
            }
        } catch (error) {
            console.error(`[${LOG_PREFIX}] Error processing torrent ${torrent.id}: ${error.message}`);
        }
    }
    return allVideoFiles;
}

function formatDownloadFile(download) {
    return {
        id: download.id, name: download.filename, info: PTT.parse(download.filename),
        size: download.filesize, url: download.download, source: 'realdebrid', isPersonal: true, tracker: 'Personal'
    };
}

function filterFilesByKeywords(files, searchKey) {
    const keywords = searchKey.toLowerCase().split(' ').filter(word => word.length > 2);
    return files.filter(file => {
        const fileName = (file.filename || '').toLowerCase();
        return keywords.some(keyword => fileName.includes(keyword));
    });
}

async function listTorrents(apiKey, skip = 0) {
    const RD = new RealDebridClient(apiKey);
    const page = Math.floor(skip / 50) + 1;
    try {
        const response = await RD.torrents.get(0, page, 100);
        const metas = (response.data || []).map(torrent => ({
            id: 'realdebrid:' + torrent.id, name: torrent.filename || 'Unknown', type: 'other',
            poster: null, background: null
        }));
        console.log(`[${LOG_PREFIX}] Returning ${metas.length} catalog items`);
        return metas;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Catalog error: ${error.message}`);
        return [];
    }
}

async function getTorrentDetails(apiKey, id) {
    const RD = new RealDebridClient(apiKey);
    const torrentId = id.includes(':') ? id.split(':')[0] : id;
    try {
        const response = await RD.torrents.info(torrentId);
        return toTorrentDetails(apiKey, response.data);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Torrent details error: ${error.message}`);
        return {
            source: 'realdebrid', id: torrentId, name: 'Unknown Torrent', type: 'other', hash: null,
            info: { title: 'Unknown' }, size: 0, created: new Date(), videos: []
        };
    }
}

async function toTorrentDetails(apiKey, item) {
    if (!item || !item.files) {
        return {
            source: 'realdebrid', id: item?.id || 'unknown', name: item?.filename || 'Unknown Torrent', type: 'other',
            hash: item?.hash || null, info: PTT.parse(item?.filename || '') || { title: 'Unknown' }, size: item?.bytes || 0,
            created: new Date(item?.added || Date.now()), videos: []
        };
    }
    const videos = item.files
        .filter(file => file.selected && isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX))
        .map((file, index) => {
            const fileIndex = item.files.findIndex(f => f.id === file.id);
            const hostUrl = item.links?.[fileIndex];
            if (!hostUrl || hostUrl === 'undefined') return null;
            return {
                id: `${item.id}:${file.id}`, name: file.path, url: hostUrl, size: file.bytes,
                created: new Date(item.added), info: PTT.parse(file.path)
            };
        }).filter(Boolean);
    return {
        source: 'realdebrid', id: item.id, name: item.filename, type: 'other', hash: item.hash,
        info: PTT.parse(item.filename), size: item.bytes, created: new Date(item.added), videos: videos || []
    };
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
    if (!searchKey) return [];
    try {
        const RD = new RealDebridClient(apiKey);
        const downloads = await getAllDownloads(RD);
        const relevantDownloads = filterFilesByKeywords(downloads, searchKey).map(d => formatDownloadFile(d));
        const fuse = new Fuse(relevantDownloads, { keys: ['info.title', 'name'], threshold: threshold });
        return fuse.search(searchKey).map(r => r.item);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Downloads search error: ${error.message}`);
        return [];
    }
}

export default { 
    listTorrents,
    searchTorrents,
    searchDownloads,
    getTorrentDetails,
    unrestrictUrl,
    searchRealDebridTorrents,
    buildPersonalHashCache
};
