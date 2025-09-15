import RealDebridClient from 'real-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import { promises as fs } from 'fs';
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';

const { isValidVideo, isValidTorrentTitle, formatSize, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
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
// --- HELPER FUNCTIONS ---
// ===================================================================================

function getQualityCategory(torrent) {
    const name = (torrent.name || torrent.Title || torrent.title || '').toLowerCase();
    if (config.PRIORITY_PENALTY_AAC_OPUS_ENABLED && (name.includes(' aac') || name.includes('.aac') || name.includes(' opus') || name.includes('.opus'))) return 'Audio-Focused';
    if (name.includes('remux')) return 'Remux';
    if (name.includes('bluray') || name.includes('blu-ray')) return 'BluRay';
    if (name.includes('.web.') || name.includes('.web-dl.')) return 'WEB/WEB-DL';
    if (name.includes('.brrip.') || name.includes('.webrip.')) return 'BRRip/WEBRip';
    return 'Other';
}

function calculateTorrentPriority(torrent) {
    const name = (torrent.Title || torrent.title || torrent.name || '').toLowerCase();
    const seeders = parseInt(torrent.Seeders || torrent.seeders || 0);
    let priorityScore = 0;
    if (name.includes('remux')) priorityScore += 150;
    if (name.includes('.web.') || name.includes(' web ') || name.includes('.web-dl.') || name.includes(' web-dl ')) priorityScore += 100;
    if (name.includes('.bluray.') || name.includes(' bluray ')) priorityScore += 100;
    if (name.includes('.brrip.') || name.includes(' brrip ') || name.includes('.webrip.') || name.includes(' webrip ')) priorityScore += 75;
    if (name.includes('.hdtv.') || name.includes(' hdtv ')) priorityScore += 50;
    if (name.includes('2160p') || name.includes('4k')) priorityScore += 30;
    else if (name.includes('1080p')) priorityScore += 20;
    else if (name.includes('720p')) priorityScore += 10;
    if (name.includes('x265') || name.includes('hevc') || name.includes('h265')) priorityScore += 15;
    if (name.includes('x264') || name.includes('h264')) priorityScore += 10;
    priorityScore += Math.min(seeders / 100, 50);
    
    // Penalties
    if (name.includes('cam') || name.includes('ts') || name.includes('screener') || name.includes('hdrip')) priorityScore -= 100;
    if (name.includes('dvdrip') || name.includes('dvdscr')) priorityScore -= 25;
    if (name.includes('yts')) priorityScore -= 75;
    if (name.includes('10bit')) priorityScore -= 25;
    if (name.includes(' aac') || name.includes('.aac') || name.includes(' opus') || name.includes('.opus')) {
        priorityScore -= 50;
    }
    if (name.includes('brrip')) priorityScore -= 50;

    return priorityScore;
}

function getCodec(torrent) {
    const name = (torrent.name || torrent.Title || torrent.title || '').toLowerCase();
    if (name.includes('x265') || name.includes('hevc') || name.includes('h265')) return 'h265';
    if (name.includes('x264') || name.includes('h264')) return 'h264';
    return 'unknown';
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

async function checkAndProcessCache(apiKey, externalTorrents, searchType, searchId) {
    if (!externalTorrents || externalTorrents.length === 0) {
        console.log(`[RD CACHE] No external torrents provided to check`);
        return [];
    }

    const originalCount = externalTorrents.length;
    const requiredKeywords = [
        '2160p', '1080p', '720p', '480p', 
        'remux', 'bluray', 'blu-ray', 'brrip',
        'webdl', 'web-dl', 'webrip', 'web',
        'dvdrip', 'dvdr', 'hdtv', 'hdrip'
    ];
    const filteredTorrents = externalTorrents.filter(torrent => {
        const title = (torrent.name || torrent.Title || torrent.title || '').toLowerCase();
        return requiredKeywords.some(keyword => title.includes(keyword));
    });
    
    if (filteredTorrents.length === 0 && originalCount > 0) {
        console.log(`[RD CACHE] 🗑️ Pre-filter removed all ${originalCount} torrents. No torrents left to check.`);
        return [];
    }
    
    const removedCount = originalCount - filteredTorrents.length;
    if (removedCount > 0) {
        console.log(`[RD CACHE] 🗑️ Pre-filter removed ${removedCount} torrents without required resolution/quality tags.`);
    }
    
    await loadHashCache();

    const RD = new RealDebridClient(apiKey);
    const cachedResults = [];
    const torrentIdsToDelete = [];
    
    const categoryResolutionCodecTracker = {};
    
    const foundResolutions = new Set();
    // --- NEW: Separate limits for each codec ---
    const maxH265Results = parseInt(process.env.MAX_H265_RESULTS_PER_QUALITY, 10) || 3;
    const maxH264Results = parseInt(process.env.MAX_H264_RESULTS_PER_QUALITY, 10) || 3;
    
    let targetSeason = null, targetEpisode = null;
    if (searchType === 'series' && searchId?.includes(':')) {
        const [, season, episode] = searchId.split(':');
        targetSeason = parseInt(season);
        targetEpisode = parseInt(episode);
    }
    
    function containsTargetEpisode(torrent) {
        if (!targetSeason || !targetEpisode) return true;
        const title = (torrent.name || torrent.Title || torrent.title || '').toLowerCase();
        const episodeRegex = new RegExp(`s0?${targetSeason}e0?${targetEpisode}(?!\\d)`, 'i');
        if (episodeRegex.test(title)) return true;
        const seasonPackPatterns = [
            new RegExp(`s0?${targetSeason}(?:\\s|\\.|_)?(?:complete|full|pack)`, 'i'),
            new RegExp(`season\\s?0?${targetSeason}(?:\\s|\\.|_)?(?:complete|full|pack)`, 'i')
        ];
        return seasonPackPatterns.some(pattern => pattern.test(title));
    }
    
    const validTorrents = filteredTorrents
        .filter(containsTargetEpisode)
        .map(torrent => {
            const infoHash = (torrent.InfoHash || torrent.infoHash || torrent.hash || '').toLowerCase();
            if (!infoHash || infoHash.length < 40) return null;
            if (!torrent.Title && !torrent.title) {
                torrent.Title = torrent.name || `Torrent ${infoHash.substring(0, 8)}`;
            }
            torrent.InfoHash = infoHash;
            return torrent;
        }).filter(Boolean);

    const torrentsWithPriority = validTorrents.map(torrent => ({
        ...torrent,
        priorityScore: calculateTorrentPriority(torrent),
        category: getQualityCategory(torrent),
        resolution: getResolutionFromName(torrent.name || torrent.Title || torrent.title),
        codec: getCodec(torrent)
    }));
    
    torrentsWithPriority.sort((a, b) => {
        if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
        return (b.Size || 0) - (a.Size || 0);
    });
    
    console.log(`[RD CACHE] Sorted ${torrentsWithPriority.length} potential torrents by quality, size, and seeders.`);

    const hasRemuxInPool = torrentsWithPriority.some(t => t.category === 'Remux');
    const hasBluRayInPool = torrentsWithPriority.some(t => t.category === 'BluRay');

    const BATCH_SIZE = parseInt(process.env.RD_BATCH_SIZE, 10) || 50;
    const MAX_PASSES = parseInt(process.env.RD_MAX_PASSES, 10) || 2;

    try {
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            const start = pass * BATCH_SIZE;
            const end = start + BATCH_SIZE;
            const torrentsToCheck = torrentsWithPriority.slice(start, end);

            if (torrentsToCheck.length === 0) {
                console.log(`[RD CACHE] No more torrents to process for pass ${pass + 1}.`);
                break;
            }

            console.log(`[RD CACHE] ⚙️ PASS ${pass + 1}/${MAX_PASSES}: Checking batch of ${torrentsToCheck.length} torrents.`);

            for (let i = 0; i < torrentsToCheck.length; i++) {
                const torrent = torrentsToCheck[i];
                const { category, resolution, InfoHash, codec } = torrent;

                // --- MODIFICATION: Granular check per category, resolution, and codec ---
                const limit = codec === 'h265' ? maxH265Results : maxH264Results;
                const currentCount = categoryResolutionCodecTracker[category]?.[resolution]?.[codec] || 0;
                if (currentCount >= limit) {
                    console.log(`[RD CACHE] 🚫 SKIPPING [${category} ${resolution} ${codec}] - limit of ${limit} reached.`);
                    continue;
                }

                if (config.PRIORITY_SKIP_LOW_RESOLUTION_ENABLED) {
                    const hasHighDefResults = foundResolutions.has('1080p') || foundResolutions.has('2160p');
                    const isLowResolution = resolution === '720p' || resolution === '480p';
                    if (hasHighDefResults && isLowResolution) {
                        console.log(`[RD CACHE] 🚫 SKIPPING [${resolution}] - Higher resolution results already found.`);
                        continue;
                    }
                }
                
                const hasWebDL = categoryResolutionCodecTracker['WEB/WEB-DL'] && Object.keys(categoryResolutionCodecTracker['WEB/WEB-DL']).length > 0;
                if (hasWebDL) {
                    const isLowerQualityRip = category === 'BRRip/WEBRip';
                    const isDvdRip = (torrent.name || torrent.Title || '').toLowerCase().includes('dvdrip');
                    if (isLowerQualityRip || isDvdRip) {
                        console.log(`[RD CACHE] 🚫 SKIPPING [${torrent.name.substring(0, 60)}] because a superior WEB/WEB-DL source was found.`);
                        continue;
                    }
                }
                
                const handleCachedResult = (torrent, from) => {
                    cachedResults.push({ ...torrent, source: 'realdebrid', isCached: true, from });
                    
                    // --- MODIFICATION: Increment granular counter ---
                    categoryResolutionCodecTracker[category] = categoryResolutionCodecTracker[category] || {};
                    categoryResolutionCodecTracker[category][resolution] = categoryResolutionCodecTracker[category][resolution] || {};
                    categoryResolutionCodecTracker[category][resolution][codec] = (categoryResolutionCodecTracker[category][resolution][codec] || 0) + 1;
                    const newCount = categoryResolutionCodecTracker[category][resolution][codec];
                    const currentLimit = codec === 'h265' ? maxH265Results : maxH264Results;

                    foundResolutions.add(resolution);
                    console.log(`[RD CACHE] ✅ ADDED (${from}) [${category} ${resolution} ${codec}] - Total: ${newCount}/${currentLimit}`);
                };

                if (isHashInCache(InfoHash)) {
                    console.log(`[FILE CACHE] ✅ HIT: "${(torrent.name || torrent.Title).substring(0, 60)}"`);
                    handleCachedResult(torrent, 'file cache');
                    continue;
                }

                let torrentId = null;
                try {
                    const torrentTitle = torrent.name || torrent.Title || 'Unknown';
                    console.log(`[RD CACHE] [Pass ${pass + 1} | ${i + 1}/${torrentsToCheck.length}] API Testing [${category} ${resolution} ${codec}]: "${torrentTitle.substring(0, 60)}"`);
                    
                    let magnetLink;
                    if (InfoHash.startsWith('magnet:')) {
                        magnetLink = InfoHash;
                    } else {
                        magnetLink = `magnet:?xt=urn:btih:${InfoHash}`;
                    }

                    let addResponse;
                    try {
                        addResponse = await RD.torrents.addMagnet(magnetLink);
                    } catch (addError) {
                        if (addError.response?.status === 400) {
                            console.error(`[RD CACHE] ❌ 400 Bad Request for magnet. Skipping. Link: ${magnetLink}`);
                            continue;
                        }
                        if (addError.response?.status === 429) { await delay(3000); addResponse = await RD.torrents.addMagnet(magnetLink); } 
                        else throw addError;
                    }
                    if (!addResponse?.data?.id) continue;
                    torrentId = addResponse.data.id;
                    
                    await RD.torrents.selectFiles(torrentId).catch(async (selectError) => {
                        if (selectError.response?.status === 429) { await delay(3000); await RD.torrents.selectFiles(torrentId); } 
                        else throw selectError;
                    });

                    let torrentInfo;
                    try {
                        torrentInfo = await RD.torrents.info(torrentId);
                    } catch (infoError) {
                        if (infoError.response?.status === 429) { await delay(3000); torrentInfo = await RD.torrents.info(torrentId); } 
                        else throw infoError;
                    }
                    if (!torrentInfo?.data) continue;
                    
                    const status = torrentInfo.data.status;
                    const hasVideoFiles = (torrentInfo.data.files || []).filter(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX)).length > 0;
                          
                    if ((status === 'downloaded' || status === 'finished') && hasVideoFiles) {
                        console.log(`[RD CACHE] ✅ CACHED (${status})`);
                        addHashToCache(InfoHash);
                        handleCachedResult(torrent, 'API');
                    } else {
                        console.log(`[RD CACHE] ❌ NOT CACHED or NO VALID VIDEO (${status})`);
                    }
                } catch (error) {
                    console.error(`[RD CACHE] ❌ API ERROR: ${error.message}`);
                } finally {
                    if (torrentId) {
                        torrentIdsToDelete.push(torrentId);
                    }
                }

                await delay(250); 
            }

            const hasFoundRemux = cachedResults.some(r => r.category === 'Remux');
            const hasFoundBluRay = cachedResults.some(r => r.category === 'BluRay');

            const remuxTargetMet = hasFoundRemux || !hasRemuxInPool;
            const blurayTargetMet = hasFoundBluRay || !hasBluRayInPool;

            if (remuxTargetMet && blurayTargetMet) {
                console.log(`[RD CACHE] ✅ Smart diversity target met. Stopping check.`);
                break;
            }

            if (pass < MAX_PASSES - 1) {
                console.log(`[RD CACHE] Pass ${pass + 1} complete. Proceeding to next pass.`);
            }
        }
    } finally {
        await saveHashCache();
    }
    
    if (torrentIdsToDelete.length > 0) {
        cleanupTemporaryTorrents(RD, torrentIdsToDelete);
    }
    
    return cachedResults;
}

/**
 * Deletes temporary torrents from Real-Debrid in the background.
 */
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
    return {
        name: torrent.Title,
        info: PTT.parse(torrent.Title) || { title: torrent.Title },
        size: torrent.Size,
        seeders: torrent.Seeders,
        url: `magnet:?xt=urn:btih:${torrent.InfoHash}`,
        source: 'realdebrid',
        hash: torrent.InfoHash.toLowerCase(),
        tracker: torrent.Tracker + (isCached ? ' [CACHED]' : ''),
        isPersonal: false,
        isCached: isCached
    };
}

function formatExternalResult(result) {
    if (!isValidTorrentTitle(result.Title, LOG_PREFIX)) {
        return null;
    }
    return {
        name: result.Title,
        info: PTT.parse(result.Title) || { title: result.Title },
        size: result.Size,
        seeders: result.Seeders,
        url: `magnet:?xt=urn:btih:${result.InfoHash}`,
        source: 'realdebrid',
        hash: result.InfoHash.toLowerCase(),
        tracker: result.Tracker,
        isPersonal: false
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
    const newExternalTorrents = Array.from(uniqueExternalTorrents.values()).filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));
    const preFilteredResults = newExternalTorrents.map(result => formatExternalResult(result)).filter(Boolean);

    console.log(`[${LOG_PREFIX}] Performing sanity check on ${preFilteredResults.length} external results for query: "${specificSearchKey}"`);
    const fuse = new Fuse(preFilteredResults, { keys: ['name'], threshold: 0.5, minMatchCharLength: 4 });
    const saneResults = fuse.search(specificSearchKey).map(r => r.item);
    
    const rejectedCount = preFilteredResults.length - saneResults.length;
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

        const cachedResults = await checkAndProcessCache(apiKey, externalTorrents, type, id);

        const combined = [...personalFiles, ...cachedResults];
        
        // --- MODIFICATION: Final filter is now granular per category, resolution, and codec ---
        const maxH265Results = parseInt(process.env.MAX_H265_RESULTS_PER_QUALITY, 10) || 3;
        const maxH264Results = 100;
        const finalCountTracker = {};
        
        let allResults = combined.filter(item => {
            if (!item.priorityScore) {
                item.priorityScore = calculateTorrentPriority(item);
            }
            const category = item.category || getQualityCategory(item);
            const resolution = item.resolution || getResolutionFromName(item.name);
            const codec = item.codec || getCodec(item);

            const limit = codec === 'h265' ? maxH265Results : maxH264Results;

            finalCountTracker[category] = finalCountTracker[category] || {};
            finalCountTracker[category][resolution] = finalCountTracker[category][resolution] || {};
            finalCountTracker[category][resolution][codec] = (finalCountTracker[category][resolution][codec] || 0) + 1;
            
            return finalCountTracker[category][resolution][codec] <= limit;
        });
        
        allResults.sort((a, b) => {
            const resA = getResolutionFromName(a.name || a.Title);
            const resB = getResolutionFromName(b.name || b.Title);
            const rankA = resolutionOrder[resA] || 0;
            const rankB = resolutionOrder[resB] || 0;
            if (rankA !== rankB) return rankB - rankA;
            return (b.size || b.Size || 0) - (a.size || a.Size || 0);
        });

        console.log(`[${LOG_PREFIX}] Comprehensive total: ${allResults.length} streams (sorted and capped)`);
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
        const enhancedFiles = allFiles.map(file => ({ ...file, source: 'realdebrid', isPersonal: true, info: PTT.parse(file.name) }));
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

// ===================================================================================
// --- EXPORT ---
// ===================================================================================
export default { 
    listTorrents,
    searchTorrents,
    searchDownloads,
    getTorrentDetails,
    unrestrictUrl,
    searchRealDebridTorrents
};
