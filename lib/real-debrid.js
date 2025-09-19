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
    let url;
    const episodeHint = torrent.episodeFileHint || null;
    
    // For personal files, use the realdebrid:torrentId:fileId format
    if (torrent.isPersonal && torrent.id && torrent.id.includes(':')) {
        url = `realdebrid:${torrent.id}`;
    } 
    // For personal files with separate torrent and file IDs
    else if (torrent.isPersonal && torrent.torrentId && torrent.fileId) {
        url = `realdebrid:${torrent.torrentId}:${torrent.fileId}`;
    }
    // For personal files with just a direct URL
    else if (torrent.isPersonal && torrent.url && !torrent.url.includes('magnet:')) {
        url = torrent.url;
    }
    // For external torrents, use magnet link
    else {
        // For external torrents, use magnet link, optionally embedding an episode hint for season packs
        const baseMagnet = `magnet:?xt=urn:btih:${torrent.InfoHash}`;
        if (episodeHint && torrent.InfoHash) {
            try {
                const hintPayload = { hash: (torrent.InfoHash || '').toLowerCase(), ...episodeHint };
                const encodedHint = Buffer.from(JSON.stringify(hintPayload)).toString('base64');
                url = `${baseMagnet}||HINT||${encodedHint}`;
            } catch (_) {
                url = baseMagnet;
            }
        } else {
            url = baseMagnet;
        }
    }

    // If we have a specific episode file hint from a season pack, prefer showing that file path
    const displayName = episodeHint?.filePath ? episodeHint.filePath : title;

    return {
        name: displayName,
        info: PTT.parse(title) || { title: title },
        size: torrent.Size || torrent.size || torrent.filesize || 0,
        seeders: torrent.Seeders || torrent.seeders || 0,
        url: url,
        source: 'realdebrid',
        hash: (torrent.InfoHash || torrent.hash || '').toLowerCase(),
        tracker: torrent.Tracker || (torrent.isPersonal ? 'Personal' : 'Cached'),
        isPersonal: torrent.isPersonal || false,
        isCached: isCached,
        // Keep the original pack/archive name around for display heuristics
        ...(episodeHint?.filePath ? { searchableName: title } : {}),
        ...(episodeHint ? { episodeHint } : {}),
        // Include IDs if available for personal files
        ...(torrent.id && { id: torrent.id }),
        ...(torrent.torrentId && { torrentId: torrent.torrentId }),
        ...(torrent.fileId && { fileId: torrent.fileId })
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
                // Normalize incoming iterable of hashes to an array for length and iteration
                const hashesArray = Array.isArray(hashes) ? hashes : Array.from(hashes || []);

                // Map of hash -> { fileId, fileIndex, filePath, fileBytes }
                const validMap = new Map();

                const inspectPack = async (hash) => {
                    let torrentId = null;
                    try {
                        const magnet = `magnet:?xt=urn:btih:${hash}`;
                        const addResponse = await RD.torrents.addMagnet(magnet).catch(() => null);
                        if (!addResponse?.data?.id) return null;
                        
                        torrentId = addResponse.data.id;
                        // Try to make sure RD parses file list
                        try { await RD.torrents.selectFiles(torrentId, 'all'); } catch (_) {}
                        
                        // Poll a few times for files to appear
                        let torrentInfo = null;
                        let files = null;
                        const maxTries = 5;
                        for (let attempt = 0; attempt < maxTries; attempt++) {
                            torrentInfo = await RD.torrents.info(torrentId).catch(() => null);
                            files = torrentInfo?.data?.files;
                            if (files && files.length > 0) break;
                            await delay(1200);
                        }

                        if (files && files.length > 0) {
                            // Create comprehensive episode pattern matching
                            const paddedSeason = String(season).padStart(2, '0');
                            const paddedEpisode = String(episode).padStart(2, '0');
                            const seasonNum = parseInt(season, 10);
                            const episodeNum = parseInt(episode, 10);
                            
                            // Enhanced regex pattern to match various episode formats
                            const episodePatterns = [
                                // Standard formats
                                `[sS]${paddedSeason}[eE]${paddedEpisode}`,
                                `[sS]${season}[eE]${episode}`,
                                `[sS]${paddedSeason}[eE]${episode}`,
                                `[sS]${season}[eE]${paddedEpisode}`,
                                
                                // Alternative formats
                                `\\b${season}x${paddedEpisode}\\b`,
                                `\\b${season}x${episode}\\b`,
                                `\\b${paddedSeason}x${paddedEpisode}\\b`,
                                `\\b${paddedSeason}x${episode}\\b`,
                                
                                // Season/Episode format
                                `season\\s*${season}\\s*episode\\s*${episode}`,
                                `season\\s*${paddedSeason}\\s*episode\\s*${paddedEpisode}`,
                                `s\\s*${season}\\s*e\\s*${episode}`,
                                `s\\s*${paddedSeason}\\s*e\\s*${paddedEpisode}`,
                                
                                // Episode-only formats (useful when season is implied)
                                `\\b[eE]p?${paddedEpisode}\\b`,
                                `\\b[eE]p?${episode}\\b`,
                                `\\bepisode\\s*${episode}\\b`,
                                `\\bepisode\\s*${paddedEpisode}\\b`,
                                
                                // Numeric formats with separators
                                `\\b${season}\\s*-\\s*${episode}\\b`,
                                `\\b${paddedSeason}\\s*-\\s*${paddedEpisode}\\b`,
                                `\\b${season}\\s*\\-\\s*${paddedEpisode}\\b`,
                                `\\b${paddedSeason}\\s*\\-\\s*${episode}\\b`,
                                
                                // Parentheses formats
                                `\\(${season}x${episode}\\)`,
                                `\\(${paddedSeason}x${paddedEpisode}\\)`,
                                `\\(s${season}e${episode}\\)`,
                                `\\(s${paddedSeason}e${paddedEpisode}\\)`
                            ];
                            
                            // Combine all patterns with OR operator
                            const combinedPattern = new RegExp(episodePatterns.join('|'), 'i');
                            
                            console.log(`[${LOG_PREFIX}] 🔍 Inspecting pack with hash: ${hash}`);
                            console.log(`[${LOG_PREFIX}] 📋 Total files in pack: ${files.length}`);
                            console.log(`[${LOG_PREFIX}] 🎯 Looking for: Season ${season}, Episode ${episode} (patterns: ${episodePatterns.slice(0, 4).join(', ')}...)`);
                            
                            // Log all files in the pack for debugging
                            let matchingFiles = [];
                            let videoFiles = [];
                            
                            for (let i = 0; i < files.length; i++) {
                                const file = files[i];
                                const path = file.path || '';
                                
                                // Check if it matches episode pattern
                                const matchesPattern = combinedPattern.test(path);
                                
                                // Check if it's a valid video
                                const isValid = isValidVideo(path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX);
                                
                                // Log file info
                                console.log(`[${LOG_PREFIX}] 📄 File ${i + 1}/${files.length}: "${path}" (${(file.bytes / (1024*1024*1024)).toFixed(2)} GB)`);
                                console.log(`[${LOG_PREFIX}]    • Pattern match: ${matchesPattern ? '✅ YES' : '❌ NO'}`);
                                console.log(`[${LOG_PREFIX}]    • Valid video: ${isValid ? '✅ YES' : '❌ NO'}`);
                                
                                if (matchesPattern) {
                                    matchingFiles.push({ index: i, file, path });
                                }
                                
                                if (isValid) {
                                    videoFiles.push({ index: i, file, path });
                                }
                            }
                            
                            console.log(`[${LOG_PREFIX}] 📊 Summary: ${matchingFiles.length} files match episode pattern, ${videoFiles.length} are valid videos`);
			    console.log(videoFiles);
                            
                            // Identify matching episode files that are valid videos
                            const matchingEpisodeFiles = [];
                            for (let i = 0; i < files.length; i++) {
                                const f = files[i];
                                if (combinedPattern.test(f.path) && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX)) {
                                    matchingEpisodeFiles.push({
                                        id: f.id,
                                        index: i,
                                        path: f.path,
                                        bytes: f.bytes
                                    });
                                }
                            }

                            const hasEpisodeFile = matchingEpisodeFiles.length > 0;

                            if (hasEpisodeFile) {
                                // Prefer the largest matching episode file
                                matchingEpisodeFiles.sort((a, b) => b.bytes - a.bytes);
                                const best = matchingEpisodeFiles[0];
                                console.log(`[${LOG_PREFIX}] 🎉 FOUND: Pack contains episode S${season}E${episode} with valid video file(s)`);
                                console.log(`[${LOG_PREFIX}]    • Selected file: "${best.path}" (${(best.bytes / (1024*1024*1024)).toFixed(2)} GB)`);
                                addHashToCache(hash);
                                // Record hint for downstream selection
                                validMap.set(hash, { fileId: best.id, fileIndex: best.index, filePath: best.path, fileBytes: best.bytes, season, episode });
                                return hash; // Return the hash if valid
                            } else {
                                console.log(`[${LOG_PREFIX}] ❌ NOT FOUND: No file in pack matches both episode pattern AND is a valid video`);
                                
                                // Show which files matched pattern but weren't valid videos
                                const patternMatchesOnly = matchingFiles.filter(item => 
                                    !isValidVideo(item.file.path, item.file.bytes, 50 * 1024 * 1024, LOG_PREFIX)
                                );
                                
                                if (patternMatchesOnly.length > 0) {
                                    console.log(`[${LOG_PREFIX}] ⚠️ Files matching episode pattern but not valid videos:`);
                                    patternMatchesOnly.forEach(item => {
                                        console.log(`[${LOG_PREFIX}]    • "${item.path}" (${(item.file.bytes / (1024*1024*1024)).toFixed(2)} GB)`);
                                    });
                                }

                                
                                // Show which files are valid videos but don't match episode pattern
                                const videoOnly = videoFiles.filter(item => 
                                    !combinedPattern.test(item.file.path)
                                );
                                
                                if (videoOnly.length > 0) {
                                    console.log(`[${LOG_PREFIX}] ⚠️ Valid video files that don't match episode pattern:`);
                                    videoOnly.forEach(item => {
                                        console.log(`[${LOG_PREFIX}]    • "${item.path}" (${(item.file.bytes / (1024*1024*1024)).toFixed(2)} GB)`);
                                    });
                                }
                            }

                            // Additional check: if no exact match found, check for season folder + episode number
                            if (!hasEpisodeFile) {
                                console.log(`[${LOG_PREFIX}] 🔍 Performing secondary check: Looking for season folder + episode number`);
                                
                                // Look for season folder pattern
                                const seasonFolderPattern = new RegExp(`[\\\\/]s?e?a?s?o?n?\\s*${season}\\b|[\\\\/]s?e?a?s?o?n?\\s*${paddedSeason}\\b`, 'i');
                                
                                // Filter files in season folder
                                const seasonFiles = files.filter(file => seasonFolderPattern.test(file.path));
                                
                                if (seasonFiles.length > 0) {
                                    console.log(`[${LOG_PREFIX}] 📁 Found ${seasonFiles.length} files in season ${season} folder`);
                                    
                                    // Check episode number patterns within season folder
                                    const episodeNumberPatterns = [
                                        `\\b${episode}\\b`,
                                        `\\b${paddedEpisode}\\b`,
                                        `\\b[eE]p?${episode}\\b`,
                                        `\\b[eE]p?${paddedEpisode}\\b`,
                                        `\\bepisode\\s*${episode}\\b`,
                                        `\\bepisode\\s*${paddedEpisode}\\b`
                                    ];
                                    
                                    const episodeNumberPattern = new RegExp(episodeNumberPatterns.join('|'), 'i');
                                    
                                    const matchingSeasonFiles = seasonFiles.filter(file => 
                                        episodeNumberPattern.test(file.path)
                                    );
                                    
                                    if (matchingSeasonFiles.length > 0) {
                                        console.log(`[${LOG_PREFIX}] 🔢 Found ${matchingSeasonFiles.length} files matching episode number in season folder:`);
                                        matchingSeasonFiles.forEach(file => {
                                            console.log(`[${LOG_PREFIX}]    • "${file.path}"`);
                                        });
                                        
                                        // Check if any of these are valid videos
                                        const validEpisodeInSeason = matchingSeasonFiles.some(file => 
                                            isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX)
                                        );
                                        
                                        if (validEpisodeInSeason) {
                                            console.log(`[${LOG_PREFIX}] 🎉 FOUND: Episode found via season folder method`);
                                            addHashToCache(hash);
                                            return hash;
                                        } else {
                                            console.log(`[${LOG_PREFIX}] ❌ NOT VALID: Files match episode number but are not valid videos`);
                                        }
                                    } else {
                                        console.log(`[${LOG_PREFIX}] ❌ NOT FOUND: No files in season folder match episode number patterns`);
                                        console.log(`[${LOG_PREFIX}]    Patterns checked: ${episodeNumberPatterns.join(', ')}`);
                                    }
                                } else {
                                    console.log(`[${LOG_PREFIX}] ❌ NOT FOUND: No files found in season ${season} folder`);
                                }
                            }
                        } else {
                            console.log(`[${LOG_PREFIX}] ❌ ERROR: No files found in torrent or files array is empty`);
                        }
                    } catch (error) {
                        console.error(`[${LOG_PREFIX}] Error during batch pack inspection for hash ${hash}: ${error.message}`);
                        console.error(`[${LOG_PREFIX}] Stack trace: ${error.stack}`);
                    } finally {
                        if (torrentId) {
                            // Add small delay before deletion to ensure API stability
                            await delay(100);
                            await RD.torrents.delete(torrentId).catch(() => {});
                        }
                    }
                    console.log(`[${LOG_PREFIX}] 🚫 RESULT: Pack with hash ${hash} does NOT contain episode S${season}E${episode}`);
                    return null; // Return null if not valid
                };

                console.log(`[${LOG_PREFIX}] 📦 Starting batch inspection of ${hashesArray.length} season packs for S${season}E${episode}`);
                
                const promises = [];
                let index = 0;
                for (const hash of hashesArray) {
                    // Stagger the start of each promise to avoid bursting the API
                    const promise = new Promise(resolve => setTimeout(resolve, index * 300)).then(() => inspectPack(hash));
                    promises.push(promise);
                    index++;
                }

                console.log(`[${LOG_PREFIX}] ⏳ Waiting for all pack inspections to complete...`);
                const results = await Promise.all(promises);
                
                // Filter out null results and return a Set of valid hashes
                const validHashes = results.filter(Boolean);
                console.log(`[${LOG_PREFIX}] ✅ Batch inspection complete: ${validHashes.length}/${hashesArray.length} packs contain episode S${season}E${episode}`);
                
                if (validHashes.length > 0) {
                    console.log(`[${LOG_PREFIX}] 🎯 Valid packs: ${validHashes.join(', ')}`);
                }
                // Return a Map so the caller can access the file hint
                return new Map(validHashes.map(h => [h, validMap.get(h)]));
            },
            // **END: REWRITTEN BATCH FUNCTION**
            cleanup: async () => {
                await saveHashCache();
                if (torrentIdsToDelete.size > 0) {
                    cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete));
                }
            }
        };

        let cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, episodeInfo);

        // Fallback: if nothing cached and it's a series episode, return top specific-episode magnets
        if (cachedResults.length === 0 && episodeInfo?.season && episodeInfo?.episode) {
            const { season, episode } = episodeInfo;
            const paddedSeason = String(season).padStart(2, '0');
            const paddedEpisode = String(episode).padStart(2, '0');
            const specificEpisodePattern = new RegExp(`[sS]${paddedSeason}[eE]${paddedEpisode}|\\b${season}x${paddedEpisode}\\b`, 'i');

            const seen = new Set();
            // Stricter title match: ensure parsed title equals the Cinemeta series name
            const targetTitle = (cinemetaDetails?.name || '').trim().toLowerCase();
            const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const normTarget = normalize(targetTitle);
            const candidates = externalTorrents
                .filter(t => {
                    const rawName = t.name || t.Title || '';
                    const name = rawName.toLowerCase();
                    const hash = (t.InfoHash || t.infoHash || t.hash || '').toLowerCase();
                    if (!hash || seen.has(hash)) return false;
                    // Episode string must match
                    if (!specificEpisodePattern.test(name)) return false;
                    // Parsed title must align with the target show title
                    const parsed = PTT.parse(rawName) || {};
                    const normParsed = normalize(parsed.title || '');
                    const goodTitle = normParsed === normTarget;
                    if (!goodTitle) return false;
                    seen.add(hash);
                    return true;
                })
                .map(t => ({
                    ...t,
                    // normalize fields expected downstream
                    name: t.name || t.Title,
                    InfoHash: (t.InfoHash || t.infoHash || t.hash || '').toLowerCase(),
                    size: t.Size || t.size || t.filesize || 0,
                    isCached: false,
                    from: 'Fallback (magnet)'
                }));

            // Sort by resolution and size (desc)
            candidates.sort((a, b) => {
                const resA = getResolutionFromName(a.name || '');
                const resB = getResolutionFromName(b.name || '');
                const rankA = resolutionOrder[resA] || 0;
                const rankB = resolutionOrder[resB] || 0;
                if (rankA !== rankB) return rankB - rankA;
                return (b.size || 0) - (a.size || 0);
            });

            const limit = parseInt(process.env.FALLBACK_EPISODE_LIMIT || '3', 10);
            cachedResults = candidates.slice(0, limit);

            if (cachedResults.length > 0) {
                console.log(`[${LOG_PREFIX}] Fallback selected ${cachedResults.length} non-cached episode magnets.`);
            }
        }

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
	console.log(allResults)
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

// New comprehensive resolver function
async function resolveStreamUrl(apiKey, encodedUrl, clientIp) {
    try {
        // Decode the URL (it's likely URL-encoded in the request)
        let decodedUrl = decodeURIComponent(encodedUrl);
        
        // Clean up the URL (remove any trailing spaces or invalid characters)
        decodedUrl = decodedUrl.trim();
        
        console.log(`[${LOG_PREFIX}] Resolving stream URL: ${decodedUrl.substring(0, 100)}...`);
        
        // If this is a magnet URL, process it through our magnet resolver
        if (decodedUrl.includes('magnet:') && decodedUrl.includes('urn:btih:')) {
            console.log(`[${LOG_PREFIX}] Detected magnet URL, processing through resolveMagnetUrl`);
            const result = await resolveMagnetUrl(apiKey, decodedUrl, clientIp);
            
            if (!result) {
                console.error(`[${LOG_PREFIX}] Failed to resolve magnet URL to file reference`);
                return null;
            }
            
            // If result is already a streaming URL, return it
            if (result.startsWith('http') && (result.includes('.mp4') || result.includes('.mkv') || result.includes('streaming'))) {
                console.log(`[${LOG_PREFIX}] Returning direct streaming URL`);
                return result;
            }
            
            // If result is a realdebrid reference, process it through unrestrictUrl
            if (result.startsWith('realdebrid:')) {
                console.log(`[${LOG_PREFIX}] Processing realdebrid reference: ${result}`);
                const streamingUrl = await unrestrictUrl(apiKey, result, clientIp);
                return streamingUrl;
            }
            
            // If result is still a magnet (fallback), try one more time
            if (result.includes('magnet:')) {
                console.log(`[${LOG_PREFIX}] Still a magnet URL, trying alternative processing`);
                const altResult = await processMagnetAlternative(apiKey, result, clientIp);
                return altResult;
            }
            
            return result;
        }
        // For any other URL, use the standard unrestrictUrl function
        else {
            console.log(`[${LOG_PREFIX}] Processing as standard URL`);
            const result = await unrestrictUrl(apiKey, decodedUrl, clientIp);
            return result;
        }
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error in resolveStreamUrl: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Stack trace: ${error.stack}`);
        return null;
    }
}

// Alternative magnet processing function as fallback
async function processMagnetAlternative(apiKey, magnetUrl, clientIp) {
    const RD = new RealDebridClient(apiKey, { ip: clientIp });
    
    try {
        console.log(`[${LOG_PREFIX}] Starting alternative magnet processing`);
        
        // Extract the hash
        const hashMatch = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
        if (!hashMatch || !hashMatch[1]) {
            console.error(`[${LOG_PREFIX}] Could not extract hash from magnet URL`);
            return null;
        }
        
        const hash = hashMatch[1].toLowerCase();
        console.log(`[${LOG_PREFIX}] Extracted hash for alternative processing: ${hash}`);
        
        // First, check if this is already in our file hash cache
        if (isHashInCache(hash)) {
            console.log(`[${LOG_PREFIX}] Hash found in cache, attempting to find in personal cloud`);
            
            try {
                // Get user's torrents
                const torrentsResponse = await RD.torrents.get(0, 1, 100);
                const torrents = torrentsResponse.data || [];
                
                const matchingTorrent = torrents.find(t => 
                    t.hash && t.hash.toLowerCase() === hash && 
                    ['downloaded', 'finished'].includes(t.status)
                );
                
                if (matchingTorrent) {
                    console.log(`[${LOG_PREFIX}] Found matching torrent in personal cloud: ${matchingTorrent.id}`);
                    
                    // Get torrent details
                    const torrentInfo = await RD.torrents.info(matchingTorrent.id);
                    
                    if (torrentInfo?.data?.files && torrentInfo.data.links) {
                        // Find video files
                        const videoFiles = torrentInfo.data.files
                            .map((file, index) => ({
                                ...file,
                                link: torrentInfo.data.links[index],
                                index: index
                            }))
                            .filter(file => 
                                file.selected !== false && 
                                isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX) && 
                                file.link && 
                                file.link !== 'undefined'
                            );
                        
                        if (videoFiles.length > 0) {
                            // Sort by size (largest first)
                            videoFiles.sort((a, b) => b.bytes - a.bytes);
                            
                            // Use the largest file
                            const selectedFile = videoFiles[0];
                            console.log(`[${LOG_PREFIX}] Selected file from cached torrent: ${selectedFile.path}`);
                            
                            // Return realdebrid reference
                            return `realdebrid:${matchingTorrent.id}:${selectedFile.id}`;
                        }
                    }
                }
            } catch (error) {
                console.warn(`[${LOG_PREFIX}] Error checking personal cloud for cached hash: ${error.message}`);
            }
        }
        
        // If not in cache or not found in personal cloud, add the magnet
        console.log(`[${LOG_PREFIX}] Adding magnet to cloud via alternative method`);
        
        try {
            // Try to add the magnet
            const addResponse = await RD.torrents.addMagnet(magnetUrl);
            
            if (!addResponse?.data?.id) {
                console.error(`[${LOG_PREFIX}] Alternative method: Failed to add magnet to cloud`);
                return null;
            }
            
            const torrentId = addResponse.data.id;
            console.log(`[${LOG_PREFIX}] Alternative method: Added torrent with ID: ${torrentId}`);
            
            // Wait for initial processing
            await delay(3000);
            
            // Get torrent info
            let torrentInfo = await RD.torrents.info(torrentId);
            let attempts = 0;
            const maxAttempts = 8;
            
            // Wait for torrent to be ready
            const readyStates = ['magnet_conversion', 'queued', 'downloading', 'downloaded', 'finished', 'uploading'];
            
            while (attempts < maxAttempts && 
                   torrentInfo?.data && 
                   !readyStates.includes(torrentInfo.data.status)) {
                await delay(2000);
                try {
                    torrentInfo = await RD.torrents.info(torrentId);
                } catch (error) {
                    console.warn(`[${LOG_PREFIX}] Alternative method: Error getting torrent info: ${error.message}`);
                }
                attempts++;
                console.log(`[${LOG_PREFIX}] Alternative method: Waiting for torrent (status: ${torrentInfo?.data?.status || 'unknown'}, attempt ${attempts}/${maxAttempts})`);
            }
            
            if (!torrentInfo?.data) {
                console.error(`[${LOG_PREFIX}] Alternative method: Could not get torrent info`);
                return null;
            }
            
            // Select files if needed
            if (torrentInfo.data.status !== 'downloaded' && torrentInfo.data.status !== 'finished') {
                console.log(`[${LOG_PREFIX}] Alternative method: Selecting files`);
                
                try {
                    // Try to select all files first
                    await RD.torrents.selectFiles(torrentId, 'all');
                    console.log(`[${LOG_PREFIX}] Alternative method: Selected all files`);
                    
                    // Wait a bit
                    await delay(3000);
                    
                    // Refresh info
                    torrentInfo = await RD.torrents.info(torrentId);
                } catch (error) {
                    console.error(`[${LOG_PREFIX}] Alternative method: Error selecting files: ${error.message}`);
                }
            }
            
            // Check if we have files and links
            if (!torrentInfo.data.files || !torrentInfo.data.links) {
                console.error(`[${LOG_PREFIX}] Alternative method: No files or links available`);
                return null;
            }
            
            // Find video files
            const filesWithLinks = torrentInfo.data.files
                .map((file, index) => ({
                    ...file,
                    link: torrentInfo.data.links[index],
                    index: index
                }))
                .filter(file => 
                    (file.selected !== false) && 
                    file.link && 
                    file.link !== 'undefined'
                );
            
            if (filesWithLinks.length === 0) {
                console.error(`[${LOG_PREFIX}] Alternative method: No files with links found`);
                return null;
            }
            
            // Try to find a video file, or use the largest file
            let selectedFile = filesWithLinks.find(file => 
                isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX)
            );
            
            if (!selectedFile) {
                // Sort by size and take the largest file as fallback
                filesWithLinks.sort((a, b) => b.bytes - a.bytes);
                selectedFile = filesWithLinks[0];
                console.log(`[${LOG_PREFIX}] Alternative method: No video files identified, using largest file: ${selectedFile.path}`);
            }
            
            console.log(`[${LOG_PREFIX}] Alternative method: Selected file: ${selectedFile.path}`);
            
            // Add to cache
            addHashToCache(hash);
            
            // Return realdebrid reference
            return `realdebrid:${torrentId}:${selectedFile.id}`;
            
        } catch (error) {
            console.error(`[${LOG_PREFIX}] Alternative method: Error in magnet processing: ${error.message}`);
            return null;
        }
        
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Alternative method: Unexpected error: ${error.message}`);
        return null;
    }
}

// Updated resolveMagnetUrl with better error handling
async function resolveMagnetUrl(apiKey, magnetUrl, clientIp) {
    const RD = new RealDebridClient(apiKey, { ip: clientIp });
    
    try {
        // Extract hash from magnet URL
        const hashMatch = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
        if (!hashMatch || !hashMatch[1]) {
            console.error(`[${LOG_PREFIX}] Could not extract hash from magnet URL: ${magnetUrl}`);
            return null;
        }
        
        const hash = hashMatch[1].toLowerCase();
        console.log(`[${LOG_PREFIX}] Extracted hash: ${hash}`);
        
        // Check if torrent already exists in user's cloud
        let torrentId = null;
        let existingTorrent = null;
        
        try {
            // Get all torrents (limited to first page for performance)
            const torrentsResponse = await RD.torrents.get(0, 1, 100);
            const existingTorrents = torrentsResponse.data || [];
            
            existingTorrent = existingTorrents.find(t => 
                t.hash && t.hash.toLowerCase() === hash && 
                ['downloaded', 'finished', 'uploading'].includes(t.status)
            );
            
            if (existingTorrent) {
                torrentId = existingTorrent.id;
                console.log(`[${LOG_PREFIX}] Torrent already exists in cloud with ID: ${torrentId}`);
            }
        } catch (error) {
            console.warn(`[${LOG_PREFIX}] Error checking existing torrents: ${error.message}`);
        }
        
        // If torrent doesn't exist, add it
        if (!torrentId) {
            console.log(`[${LOG_PREFIX}] Adding new torrent to cloud`);
            try {
                const addResponse = await RD.torrents.addMagnet(magnetUrl);
                if (!addResponse?.data?.id) {
                    console.error(`[${LOG_PREFIX}] Failed to add magnet to cloud: No ID in response`);
                    return null;
                }
                torrentId = addResponse.data.id;
                console.log(`[${LOG_PREFIX}] Added torrent with ID: ${torrentId}`);
                
                // Wait a bit for the torrent to be processed
                await delay(3000);
            } catch (error) {
                console.error(`[${LOG_PREFIX}] Error adding magnet to cloud: ${error.message}`);
                return null;
            }
        }
        
        // Get torrent info
        let torrentInfo = await RD.torrents.info(torrentId);
        let attempts = 0;
        const maxAttempts = 10;
        
        // Wait for torrent to be ready
        const readyStates = ['magnet_conversion', 'queued', 'downloading', 'downloaded', 'finished', 'uploading'];
        
        while (attempts < maxAttempts && 
               torrentInfo?.data && 
               !readyStates.includes(torrentInfo.data.status)) {
            await delay(2000);
            try {
                torrentInfo = await RD.torrents.info(torrentId);
            } catch (error) {
                console.warn(`[${LOG_PREFIX}] Error getting torrent info on attempt ${attempts + 1}: ${error.message}`);
                await delay(1000);
                continue;
            }
            attempts++;
            console.log(`[${LOG_PREFIX}] Waiting for torrent ${torrentId} to be ready (status: ${torrentInfo?.data?.status || 'unknown'}, attempt ${attempts}/${maxAttempts})`);
        }
        
        if (!torrentInfo?.data) {
            console.error(`[${LOG_PREFIX}] Could not get torrent info for ID: ${torrentId}`);
            return null;
        }
        
        if (!readyStates.includes(torrentInfo.data.status)) {
            console.error(`[${LOG_PREFIX}] Torrent ${torrentId} failed to reach ready state after ${maxAttempts} attempts. Final status: ${torrentInfo.data.status}`);
            return null;
        }
        
        // If files haven't been selected yet, select them
        if (torrentInfo.data.status !== 'downloaded' && torrentInfo.data.status !== 'finished') {
            console.log(`[${LOG_PREFIX}] Selecting files for torrent ${torrentId}`);
            
            try {
                // First try to select all files
                await RD.torrents.selectFiles(torrentId, 'all');
                console.log(`[${LOG_PREFIX}] Selected all files`);
                
                // Wait for selection to process
                await delay(3000);
                
                // Refresh torrent info
                torrentInfo = await RD.torrents.info(torrentId);
            } catch (error) {
                console.error(`[${LOG_PREFIX}] Error selecting files: ${error.message}`);
                // Continue anyway
            }
        }
        
        // Check if we have files and links
        if (!torrentInfo?.data?.files || !Array.isArray(torrentInfo.data.files)) {
            console.error(`[${LOG_PREFIX}] No files in torrent info for ${torrentId}`);
            return null;
        }
        
        // Wait for links if not available
        if (!torrentInfo.data.links || !Array.isArray(torrentInfo.data.links)) {
            console.log(`[${LOG_PREFIX}] No links available yet, waiting...`);
            let linkAttempts = 0;
            const maxLinkAttempts = 5;
            
            while (linkAttempts < maxLinkAttempts && 
                   (!torrentInfo.data.links || !Array.isArray(torrentInfo.data.links))) {
                await delay(2000);
                try {
                    torrentInfo = await RD.torrents.info(torrentId);
                } catch (error) {
                    console.warn(`[${LOG_PREFIX}] Error getting torrent info for links: ${error.message}`);
                }
                linkAttempts++;
            }
            
            if (!torrentInfo.data.links || !Array.isArray(torrentInfo.data.links)) {
                console.error(`[${LOG_PREFIX}] Still no links available after ${maxLinkAttempts} attempts`);
                return null;
            }
        }
        
        // Create array of files with their links
        const filesWithLinks = torrentInfo.data.files
            .map((file, index) => ({
                ...file,
                link: torrentInfo.data.links[index],
                index: index
            }))
            .filter(file => 
                file.selected !== false && 
                file.link && 
                file.link !== 'undefined'
            );
        
        if (filesWithLinks.length === 0) {
            console.error(`[${LOG_PREFIX}] No files with links found in torrent ${torrentId}`);
            return null;
        }
        
        // Try to find a video file
        let selectedFile = filesWithLinks.find(file => 
            isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX)
        );
        
        // If no video file found, use the largest file
        if (!selectedFile) {
            console.log(`[${LOG_PREFIX}] No video files identified, selecting largest file`);
            filesWithLinks.sort((a, b) => b.bytes - a.bytes);
            selectedFile = filesWithLinks[0];
        }
        
        console.log(`[${LOG_PREFIX}] Selected file: ${selectedFile.path} (${selectedFile.bytes} bytes)`);
        
        // Add to cache
        addHashToCache(hash);
        
        // Return realdebrid reference
        const fileReference = `realdebrid:${torrentId}:${selectedFile.id}`;
        console.log(`[${LOG_PREFIX}] Created file reference: ${fileReference}`);
        
        return fileReference;
        
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error resolving magnet URL: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Error stack: ${error.stack}`);
        return null;
    }
}

// Updated unrestrictUrl function
async function unrestrictUrl(apiKey, hostUrl, clientIp) {
    const RD = new RealDebridClient(apiKey, { ip: clientIp });
    try {
        if (!hostUrl || hostUrl === 'undefined' || hostUrl.includes('undefined')) {
            console.error(`[${LOG_PREFIX}] Invalid URL for unrestrict: ${hostUrl}`);
            return null;
        }
        
        // Handle realdebrid file references (format: realdebrid:torrentId:fileId)
        if (hostUrl.startsWith('realdebrid:') && hostUrl.includes(':') && !hostUrl.includes('magnet:')) {
            const parts = hostUrl.split(':');
            const torrentId = parts[1];
            const fileId = parts[2];
            
            if (!torrentId || !fileId) {
                console.error(`[${LOG_PREFIX}] Invalid realdebrid URL format: ${hostUrl}`);
                return null;
            }
            
            try {
                // Get the torrent info to find the link for the specific file
                const torrentInfo = await RD.torrents.info(torrentId);
                if (!torrentInfo?.data?.links) {
                    console.error(`[${LOG_PREFIX}] No links found in torrent info for ${torrentId}`);
                    return null;
                }
                
                // Find the index of the file
                const fileIndex = torrentInfo.data.files.findIndex(f => f.id.toString() === fileId.toString());
                if (fileIndex === -1) {
                    console.error(`[${LOG_PREFIX}] File ID ${fileId} not found in torrent ${torrentId}`);
                    return null;
                }
                
                // Get the link for this specific file
                const directLink = torrentInfo.data.links[fileIndex];
                if (!directLink || directLink === 'undefined') {
                    console.error(`[${LOG_PREFIX}] No direct link found for file ${fileId} in torrent ${torrentId}`);
                    return null;
                }
                
                console.log(`[${LOG_PREFIX}] Unrestricting file link: ${directLink.substring(0, 50)}...`);
                
                // Add small delay to avoid rate limiting
                await delay(500);
                
                const response = await RD.unrestrict.link(directLink);
                const directStreamingUrl = response?.data?.download;
                
                if (!directStreamingUrl) {
                    console.error(`[${LOG_PREFIX}] No direct streaming URL in response`);
                    return null;
                }
                
                console.log(`[${LOG_PREFIX}] Got direct streaming URL: ${directStreamingUrl.substring(0, 80)}...`);
                return directStreamingUrl;
            } catch (error) {
                console.error(`[${LOG_PREFIX}] Error processing realdebrid URL ${hostUrl}: ${error.message}`);
                return null;
            }
        } 
        // Handle regular host URLs (not magnet or realdebrid references)
        else if (!hostUrl.includes('magnet:') && !hostUrl.startsWith('realdebrid:')) {
            console.log(`[${LOG_PREFIX}] Unrestricting: ${hostUrl.substring(0, 50)}...`);
            
            // Add small delay to avoid rate limiting
            await delay(500);
            
            const response = await RD.unrestrict.link(hostUrl);
            const directStreamingUrl = response?.data?.download;
            if (!directStreamingUrl) {
                console.error(`[${LOG_PREFIX}] No direct streaming URL in response`);
                return null;
            }
            console.log(`[${LOG_PREFIX}] Got direct streaming URL: ${directStreamingUrl.substring(0, 80)}...`);
            return directStreamingUrl;
        } 
        // This should not happen with our new flow, but handle just in case
        else if (hostUrl.includes('magnet:')) {
            console.log(`[${LOG_PREFIX}] Processing magnet link (fallback): ${hostUrl.substring(0, 50)}...`);
            const fileReference = await resolveMagnetUrl(apiKey, hostUrl, clientIp);
            
            if (!fileReference) {
                console.error(`[${LOG_PREFIX}] Failed to resolve magnet URL to file reference`);
                return null;
            }
            
            // If we got a direct URL back, return it
            if (fileReference.startsWith('http')) {
                return fileReference;
            }
            
            // Otherwise process the file reference
            return await unrestrictUrl(apiKey, fileReference, clientIp);
        }
        else {
            console.error(`[${LOG_PREFIX}] Unsupported URL format: ${hostUrl}`);
            return null;
        }
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Unrestrict error: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Error stack: ${error.stack}`);
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
                
                // Create a realdebrid reference in the format: realdebrid:torrentId:fileId
                const fileReference = `realdebrid:${torrent.id}:${file.id}`;
                
                if (fileReference && fileReference !== 'undefined') {
                    allVideoFiles.push({
                        id: `${torrent.id}:${file.id}`, 
                        name: file.path, 
                        info: PTT.parse(file.path),
                        size: file.bytes, 
                        hash: torrent.hash, 
                        url: fileReference, // Use the reference instead of direct URL
                        source: 'realdebrid',
                        isPersonal: true, 
                        tracker: 'Personal',
                        torrentId: torrent.id,
                        fileId: file.id
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
    buildPersonalHashCache,
    resolveStreamUrl // Export the new resolver function
};
