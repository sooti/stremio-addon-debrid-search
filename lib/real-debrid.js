import RealDebridClient from 'real-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import { promises as fs } from 'fs';

// ===================================================================================
// --- CONFIGURATION ---
// ===================================================================================
const BITMAGNET_URL = process.env.BITMAGNET_URL || 'http://YOUR_BITMAGNET_URL';
const TORZNAB_LIMIT = parseInt(process.env.TORZNAB_LIMIT) || 50;
const JACKETT_URL = process.env.JACKETT_URL || 'http://YOUR_JACKETT_IP:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || '';
const TORRENTIO_URL = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
const ZILEAN_URL = process.env.ZILEAN_URL || 'https://zilean.elfhosted.com';
const COMET_URL = process.env.COMET_URL || 'https://comet.elfhosted.com';
const STREMTHRU_URL = process.env.STREMTHRU_URL || 'https://stremthru.elfhosted.com';
const BT4G_URL = process.env.BT4G_URL || 'https://bt4gprx.com';
const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT) || 3000;

// --- Scraper Enable/Disable Flags ---
const BITMAGNET_ENABLED = process.env.BITMAGNET_ENABLED === 'true';
const JACKETT_ENABLED = process.env.JACKETT_ENABLED === 'true';
const TORRENTIO_ENABLED = process.env.TORRENTIO_ENABLED === 'true';
const ZILEAN_ENABLED = process.env.ZILEAN_ENABLED === 'true';
const COMET_ENABLED = process.env.COMET_ENABLED === 'true';
const STREMTHRU_ENABLED = process.env.STREMTHRU_ENABLED === 'true';
const BT4G_ENABLED = process.env.BT4G_ENABLED === 'true';

// --- Priority & Filtering Configuration ---
const PRIORITY_PENALTY_AAC_OPUS_ENABLED = process.env.PRIORITY_PENALTY_AAC_OPUS_ENABLED === 'true';
const PRIORITY_SKIP_WEBRIP_ENABLED = process.env.PRIORITY_SKIP_WEBRIP_ENABLED === 'true';
const PRIORITY_SKIP_LOW_RESOLUTION_ENABLED = process.env.PRIORITY_SKIP_LOW_RESOLUTION_ENABLED === 'true';
const PRIORITY_SKIP_AAC_OPUS_ENABLED = process.env.PRIORITY_SKIP_AAC_OPUS_ENABLED === 'true';
const DIVERSIFY_CODECS_ENABLED = process.env.DIVERSIFY_CODECS_ENABLED === 'true';
const TARGET_CODEC_COUNT = parseInt(process.env.TARGET_CODEC_COUNT) || 2;


// --- File Caching Configuration ---
const RD_HASH_CACHE_ENABLED = process.env.RD_HASH_CACHE_ENABLED === 'true';
const RD_HASH_CACHE_PATH = process.env.RD_HASH_CACHE_PATH || './rd_hash_cache.json';
const RD_HASH_CACHE_LIFETIME_DAYS = parseInt(process.env.RD_HASH_CACHE_LIFETIME_DAYS) || 3;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
// --- FILE-BASED HASH CACHING ---
// ===================================================================================
let fileHashCache = new Map();

async function loadHashCache() {
    if (!RD_HASH_CACHE_ENABLED) return;
    try {
        await fs.access(RD_HASH_CACHE_PATH);
        const data = await fs.readFile(RD_HASH_CACHE_PATH, 'utf-8');
        const jsonCache = JSON.parse(data);
        fileHashCache = new Map(Object.entries(jsonCache));
        
        const expirationTime = Date.now() - (RD_HASH_CACHE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
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
    if (!RD_HASH_CACHE_ENABLED) return;
    try {
        const cacheObject = Object.fromEntries(fileHashCache);
        await fs.writeFile(RD_HASH_CACHE_PATH, JSON.stringify(cacheObject, null, 2));
        console.log(`[FILE CACHE] Saved ${fileHashCache.size} hashes to disk.`);
    } catch (error) {
        console.error(`[FILE CACHE] Error saving hash cache: ${error.message}`);
    }
}

function addHashToCache(hash) {
    if (!RD_HASH_CACHE_ENABLED || !hash) return;
    fileHashCache.set(hash.toLowerCase(), Date.now());
}

function isHashInCache(hash) {
    if (!RD_HASH_CACHE_ENABLED || !hash) return false;
    return fileHashCache.has(hash.toLowerCase());
}

// ===================================================================================
// --- ENHANCED VIDEO FILE FILTERING ---
// ===================================================================================
function isVideo(filename) {
    if (!filename || typeof filename !== 'string') return false;
    
    const videoExtensions = [
        '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', 
        '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts'
    ];
    
    const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return videoExtensions.includes(extension);
}

function isValidVideo(fileName, fileSize = 0, minSize = 50 * 1024 * 1024) {
    if (!fileName) return false;
    const decodedName = decodeURIComponent(fileName).toLowerCase();
    if (!isVideo(decodedName)) return false;
    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes|bonus|cd\d+)\b/i.test(decodedName)) return false;
    if (/\.(exe|iso|dmg|pkg|msi|deb|rpm|zip|rar|7z|tar|gz|txt|nfo|sfv)$/i.test(decodedName)) return false;
    if (fileSize && fileSize < minSize) return false;
    return true;
}

function isValidTorrentTitle(title) {
    if (!title || typeof title !== 'string') return false;
    const titleLower = title.toLowerCase();
    const fakeExtensions = ['.exe', '.iso', '.dmg', '.pkg', '.msi', '.deb', '.rpm', '.zip', '.rar', '.7z', '.txt', '.nfo'];
    if (fakeExtensions.some(ext => titleLower.includes(ext))) {
        console.log(`[RD] Filtering fake extension: ${title}`);
        return false;
    }
    const fakeIndicators = [
        'crack', 'keygen', 'patch', 'loader', 'activator', 'installer', 'setup',
        'virus', 'malware', 'trojan', 'backdoor', 'password', 'readme',
        'sample only', 'trailer only', 'promo only'
    ];
    if (fakeIndicators.some(fake => titleLower.includes(fake))) {
        console.log(`[RD] Filtering fake indicator: ${title}`);
        return false;
    }
    const videoIndicators = [
        '1080p', '720p', '480p', '2160p', '4k', 'uhd', 'hd',
        'bluray', 'webrip', 'hdtv', 'dvdrip', 'web-dl', 'brrip',
        'x264', 'x265', 'h264', 'h265', 'hevc',
        '.mkv', '.mp4', '.avi', '.mov'
    ];
    const hasVideoIndicator = videoIndicators.some(indicator => titleLower.includes(indicator));
    const hasSeriesPattern = /s\d{1,2}e\d{1,2}/i.test(titleLower);
    const hasYearPattern = /\b(19|20)\d{2}\b/.test(titleLower);
    if (!hasVideoIndicator && !hasSeriesPattern && !hasYearPattern) {
        console.log(`[RD] Filtering no video indicators: ${title}`);
        return false;
    }
    return true;
}

// ===================================================================================
// --- CACHE & PRIORITY SYSTEM ---
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

function calculateTorrentPriority(torrent) {
    const name = (torrent.Title || torrent.title || '').toLowerCase();
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
    if (name.includes('cam') || name.includes('ts') || name.includes('screener')) priorityScore -= 100;
    if (name.includes('dvdrip') || name.includes('dvdscr')) priorityScore -= 25;
    
    if (PRIORITY_PENALTY_AAC_OPUS_ENABLED && (name.includes(' aac') || name.includes('.aac') || name.includes(' opus') || name.includes('.opus'))) {
        priorityScore -= 50;
    }

    return priorityScore;
}

function getCodec(torrent) {
    const name = (torrent.Title || torrent.title || '').toLowerCase();
    if (name.includes('x265') || name.includes('hevc') || name.includes('h265')) return 'h265';
    if (name.includes('x264') || name.includes('h264')) return 'h264';
    return 'unknown';
}

async function checkAndProcessCache(apiKey, externalTorrents, searchType, searchId) {
    if (!externalTorrents || externalTorrents.length === 0) {
        console.log(`[RD CACHE] No external torrents provided to check`);
        return [];
    }
    
    await loadHashCache();

    const RD = new RealDebridClient(apiKey);
    const cachedResults = [];
    
    const qualityCountTracker = {
        'Remux': { total: 0, h264: 0, h265: 0 },
        'WEB/WEB-DL': { total: 0, h264: 0, h265: 0 },
        'BluRay': { total: 0, h264: 0, h265: 0 },
        'BRRip/WEBRip': { total: 0, h264: 0, h265: 0 },
        'Audio-Focused': { total: 0, h264: 0, h265: 0 },
        'Other': { total: 0, h264: 0, h265: 0 }
    };
    
    const foundResolutions = new Set();
    const maxPerQuality = process.env.MAX_RESULTS_PER_QUALITY || 6;
    
    console.log(`[RD CACHE] Starting SMART cache check for ${externalTorrents.length} external torrents...`);
    
    let targetSeason = null, targetEpisode = null;
    if (searchType === 'series' && searchId?.includes(':')) {
        const [, season, episode] = searchId.split(':');
        targetSeason = parseInt(season);
        targetEpisode = parseInt(episode);
    }
    
    function containsTargetEpisode(torrent) {
        if (!targetSeason || !targetEpisode) return true;
        const title = (torrent.Title || torrent.title || torrent.name || '').toLowerCase();
        const episodeRegex = new RegExp(`s0?${targetSeason}e0?${targetEpisode}(?!\\d)`, 'i');
        if (episodeRegex.test(title)) return true;
        const seasonPackPatterns = [
            new RegExp(`s0?${targetSeason}(?:\\s|\\.|_)?(?:complete|full|pack)`, 'i'),
            new RegExp(`season\\s?0?${targetSeason}(?:\\s|\\.|_)?(?:complete|full|pack)`, 'i')
        ];
        return seasonPackPatterns.some(pattern => pattern.test(title));
    }
    
    function getResolution(torrent) {
        const name = (torrent.Title || torrent.title || '').toLowerCase();
        if (name.includes('2160p') || name.includes('4k') || name.includes('uhd')) return '2160p';
        if (name.includes('1080p')) return '1080p';
        if (name.includes('720p')) return '720p';
        if (name.includes('480p')) return '480p';
        return 'other';
    }

    function getQualityCategory(torrent) {
        const name = (torrent.Title || torrent.title || '').toLowerCase();
        if (PRIORITY_PENALTY_AAC_OPUS_ENABLED && (name.includes(' aac') || name.includes('.aac') || name.includes(' opus') || name.includes('.opus'))) return 'Audio-Focused';
        if (name.includes('remux')) return 'Remux';
        if (name.includes('.web.') || name.includes('.web-dl.')) return 'WEB/WEB-DL';
        if (name.includes('.bluray.')) return 'BluRay';
        if (name.includes('.brrip.') || name.includes('.webrip.')) return 'BRRip/WEBRip';
        return 'Other';
    }
    
    const validTorrents = externalTorrents
        .filter(containsTargetEpisode)
        .map(torrent => {
            const infoHash = (torrent.InfoHash || torrent.infoHash || torrent.hash || '').toLowerCase();
            if (!infoHash || infoHash.length !== 40) return null;
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
        resolution: getResolution(torrent),
        codec: getCodec(torrent)
    }));
    
    torrentsWithPriority.sort((a, b) => {
        if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
        return (b.Size || 0) - (a.Size || 0);
    });
    
    const torrentsToCheck = torrentsWithPriority.slice(0, 200);
    console.log(`[RD CACHE] 🎯 Top ${torrentsToCheck.length} torrents selected for API check, sorted by priority score then size.`);
    
    try {
        for (let i = 0; i < torrentsToCheck.length; i++) {
            const torrent = torrentsToCheck[i];
            const { category, resolution, InfoHash, codec } = torrent;

            if (PRIORITY_SKIP_LOW_RESOLUTION_ENABLED) {
                const hasHighDefResults = foundResolutions.has('1080p') || foundResolutions.has('2160p');
                const isLowResolution = resolution === '720p' || resolution === '480p';
                if (hasHighDefResults && isLowResolution) {
                    console.log(`[RD CACHE] 🚫 SKIPPING [${resolution}] - Higher resolution results already found.`);
                    continue;
                }
            }

            if (PRIORITY_SKIP_WEBRIP_ENABLED) {
                const hasSuperiorQuality = qualityCountTracker['Remux'].total > 0 || qualityCountTracker['WEB/WEB-DL'].total > 0 || qualityCountTracker['BluRay'].total > 0;
                if (category === 'BRRip/WEBRip' && hasSuperiorQuality) {
                    console.log(`[RD CACHE] 🚫 SKIPPING [${category}] because a superior quality source was found.`);
                    continue;
                }
            }

            if (PRIORITY_SKIP_AAC_OPUS_ENABLED) {
                const hasAnyOtherResult = (qualityCountTracker['Remux'].total + qualityCountTracker['WEB/WEB-DL'].total + qualityCountTracker['BluRay'].total + qualityCountTracker['BRRip/WEBRip'].total + qualityCountTracker['Other'].total) > 0;
                if (category === 'Audio-Focused' && hasAnyOtherResult) {
                    console.log(`[RD CACHE] 🚫 SKIPPING [${category}] because other cached results were found.`);
                    continue;
                }
            }

            const counts = qualityCountTracker[category];
            if (counts.total >= maxPerQuality) {
                console.log(`[RD CACHE] 🚫 SKIPPING [${category}] - category limit (${maxPerQuality}) reached.`);
                continue;
            }

            if (DIVERSIFY_CODECS_ENABLED && codec !== 'unknown') {
                const otherCodec = codec === 'h265' ? 'h264' : 'h265';
                if (counts[codec] >= TARGET_CODEC_COUNT && counts[otherCodec] < TARGET_CODEC_COUNT) {
                    console.log(`[RD CACHE] 🚫 SKIPPING [${codec}] in [${category}] - Codec target reached. Holding out for [${otherCodec}].`);
                    continue;
                }
            }
            
            const handleCachedResult = (torrent, from) => {
                cachedResults.push({ ...torrent, source: 'realdebrid', isCached: true });
                counts.total++;
                if (codec !== 'unknown') {
                    counts[codec]++;
                }
                foundResolutions.add(resolution);
                console.log(`[RD CACHE] ✅ ADDED (${from}) [${category} ${resolution} ${codec}] - Total: ${counts.total}/${maxPerQuality}, H264: ${counts.h264}, H265: ${counts.h265}`);
            };

            if (isHashInCache(InfoHash)) {
                console.log(`[FILE CACHE] ✅ HIT: "${(torrent.Title || torrent.title).substring(0, 60)}"`);
                handleCachedResult(torrent, 'file cache');
                continue;
            }

            let torrentId = null;
            try {
                const torrentTitle = torrent.Title || torrent.title || 'Unknown';
                console.log(`[RD CACHE] [${i + 1}/${torrentsToCheck.length}] API Testing [${category} ${resolution} ${codec}]: "${torrentTitle.substring(0, 60)}"`);
                const magnetLink = `magnet:?xt=urn:btih:${InfoHash}`;

                let addResponse;
                try {
                    addResponse = await RD.torrents.addMagnet(magnetLink);
                } catch (addError) {
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
                const hasVideoFiles = (torrentInfo.data.files || []).filter(f => f.selected && isValidVideo(f.path, f.bytes)).length > 0;
                      
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
                    await RD.torrents.delete(torrentId).catch(async (deleteError) => {
                        if (deleteError.response?.status === 429) {
                            await delay(3000);
                            await RD.torrents.delete(torrentId).catch(() => {});
                        }
                    });
                }
            }
        }
    } finally {
        await saveHashCache();
    }
    
    cachedResults.sort((a, b) => (b.Size || 0) - (a.Size || 0));
    console.log(`[RD CACHE] 🏁 CACHE CHECK COMPLETE: ${cachedResults.length} cached torrents found.`);
    console.log(`[RD CACHE] 🎯 Final counts: ${JSON.stringify(qualityCountTracker, null, 2)}`);
    return cachedResults;
}

// ... the rest of your file (formatCachedResult, search functions, etc.) remains the same ...

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
    if (!isValidTorrentTitle(result.Title)) {
        return null;
    }
    if (result.Size && result.Size < 200 * 1024 * 1024) {
        console.log(`[RD] Filtering small torrent: ${result.Title} (${formatSize(result.Size)})`);
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
    const sourceNames = ['Jackett', 'Zilean', 'Torrentio', 'Comet', 'StremThru', 'Bitmagnet'];
    let sourceCounts = `Personal(${personalFiles.length})`;
    externalSources.forEach((source, index) => {
        if (source && source.length > 0) {
            sourceCounts += `, ${sourceNames[index]}(${source.length})`;
        }
    });
    console.log(`[RD] Sources found: ${sourceCounts}`);

    const markedPersonal = personalFiles.map(file => ({ ...file, source: 'realdebrid', isPersonal: true, tracker: 'Personal' }));
    const externalTorrents = [].concat(...externalSources);
    const uniqueExternalTorrents = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]));
    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    const newExternalTorrents = Array.from(uniqueExternalTorrents.values()).filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));
    const preFilteredResults = newExternalTorrents.map(result => formatExternalResult(result)).filter(Boolean);

    console.log(`[RD] Performing sanity check on ${preFilteredResults.length} external results for query: "${specificSearchKey}"`);
    const fuse = new Fuse(preFilteredResults, { keys: ['name'], threshold: 0.5, minMatchCharLength: 4 });
    const saneResults = fuse.search(specificSearchKey).map(r => r.item);
    
    const rejectedCount = preFilteredResults.length - saneResults.length;
    if (rejectedCount > 0) {
        console.log(`[RD] Sanity check REJECTED ${rejectedCount} irrelevant results.`);
    }

    console.log(`[RD] After all filtering: ${personalFiles.length} personal + ${saneResults.length} valid external`);
    return [...markedPersonal, ...saneResults];
}

// ===================================================================================
// --- MAIN SEARCH FUNCTIONS ---
// ===================================================================================
async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
    console.log(`[RD] Starting search for: "${searchKey}"`);
    if (!searchKey) return [];

    const abortController = createAbortController();
    const signal = abortController.signal;

    try {
        console.time('[RD] Personal files');
        const personalFiles = await searchPersonalFiles(apiKey, searchKey, threshold);
        console.timeEnd('[RD] Personal files');
        
        console.log(`[RD] Searching external sources...`);
        const scraperPromises = [];
        if (JACKETT_ENABLED) scraperPromises.push(searchJackett(searchKey, signal));
        if (ZILEAN_ENABLED) scraperPromises.push(searchZilean(searchKey, null, null, signal));
        if (STREMTHRU_ENABLED) scraperPromises.push(searchStremthru(searchKey, signal));
        if (COMET_ENABLED) scraperPromises.push(searchComet('movie', 'unknown', signal));

        let scraperResults = [];
        try {
            scraperResults = await Promise.all(scraperPromises);
            console.log(`[RD] External scrapers completed`);
        } catch (error) {
            console.log(`[RD] Scraper error: ${error.message}`);
            scraperResults = [];
        }

        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, searchKey);
        if (combinedResults.length === 0) return personalFiles;

        const externalTorrents = combinedResults.filter(t => !t.isPersonal);
        if (externalTorrents.length === 0) return personalFiles;

        const cachedResults = await checkAndProcessCache(apiKey, externalTorrents);
        
        console.log(`[RD] Final: ${personalFiles.length} personal + ${cachedResults.length} cached`);
        return [...personalFiles, ...cachedResults];

    } catch (error) {
        console.error(`[RD] Search error: ${error.message}`);
        return [];
    } finally {
        if (abortController === globalAbortController) {
            globalAbortController = null;
        }
    }
}

async function searchRealDebridTorrents(apiKey, type, id) {
    if (!id || typeof id !== 'string') {
        console.error(`[RD] Invalid id parameter: ${id}`);
        return [];
    }

    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) { return []; }

    const searchKey = cinemetaDetails.name;
    const specificSearchKey = type === 'series'
        ? `${searchKey} s${season.toString().padStart(2, '0')}e${episode.toString().padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

    console.log(`[RD] Comprehensive search for: "${specificSearchKey}"`);

    const abortController = createAbortController();
    const signal = abortController.signal;

    const scraperPromises = [];
    if (JACKETT_ENABLED) scraperPromises.push(searchJackett(specificSearchKey, signal));
    if (ZILEAN_ENABLED) scraperPromises.push(searchZilean(specificSearchKey, season, episode, signal));
    if (TORRENTIO_ENABLED) scraperPromises.push(searchTorrentio(type, imdbId, signal));
    if (COMET_ENABLED) scraperPromises.push(searchComet(type, imdbId, signal, season, episode));
    if (STREMTHRU_ENABLED) scraperPromises.push(searchStremthru(specificSearchKey, signal));

    try {
        console.time('[RD] Comprehensive series search');
        const [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, searchKey, 0.3),
            ...scraperPromises
        ]);
        console.timeEnd('[RD] Comprehensive series search');

        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, specificSearchKey);
        
        let externalTorrents = combinedResults.filter(t => !t.isPersonal);
        
        if (type === 'movie' && cinemetaDetails.year) {
            const originalCount = externalTorrents.length;
            externalTorrents = externalTorrents.filter(torrent => filterYear(torrent, cinemetaDetails));
            console.log(`[RD] Filtered by year (${cinemetaDetails.year}): ${originalCount} -> ${externalTorrents.length} external torrents remain.`);
        }

        const cachedResults = await checkAndProcessCache(apiKey, externalTorrents, type, id);

        let allResults = [...personalFiles, ...cachedResults];
        allResults.sort((a, b) => (b.size || b.Size || 0) - (a.size || a.Size || 0));

        console.log(`[RD] Comprehensive total: ${allResults.length} streams (sorted by size)`);
        return allResults;

    } catch (error) {
        console.error(`[RD] Comprehensive search failed: ${error.message}`);
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
        console.log(`[RD] Found ${existingTorrents.length} torrents, ${existingDownloads.length} downloads`);
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
        console.error(`[RD] Personal files error: ${error.message}`);
        return [];
    }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
    const RD = new RealDebridClient(apiKey, { ip: clientIp });
    try {
        if (!hostUrl || hostUrl === 'undefined' || hostUrl.includes('undefined')) {
            console.error(`[RD] Invalid URL for unrestrict: ${hostUrl}`);
            return null;
        }
        console.log(`[RD] Unrestricting: ${hostUrl.substring(0, 50)}...`);
        const response = await RD.unrestrict.link(hostUrl);
        const directStreamingUrl = response?.data?.download;
        if (!directStreamingUrl) {
            console.error(`[RD] No direct streaming URL in response`);
            return null;
        }
        console.log(`[RD] Got direct streaming URL: ${directStreamingUrl.substring(0, 80)}...`);
        return directStreamingUrl;
    } catch (error) {
        console.error(`[RD] Unrestrict error: ${error.message}`);
        return null;
    }
}

// ===================================================================================
// --- EXTERNAL SCRAPERS ---
// ===================================================================================
async function searchJackett(query, signal) {
    console.time('[RD] Jackett');
    try {
        const response = await axios.get(`${JACKETT_URL}/api/v2.0/indexers/all/results`, {
            params: { apikey: JACKETT_API_KEY, Query: query },
            timeout: SCRAPER_TIMEOUT,
            signal
        });
        console.timeEnd('[RD] Jackett');
        return (response.data.Results || []).slice(0, 100).map(r => ({
            Title: r.Title, InfoHash: r.InfoHash, Size: r.Size, Seeders: r.Seeders, Tracker: `Jackett | ${r.Tracker}`
        }));
    } catch (error) {
        console.timeEnd('[RD] Jackett');
        if (!axios.isCancel(error)) console.error(`[RD] Jackett failed: ${error.message}`);
        return [];
    }
}

async function searchZilean(title, season, episode, signal) {
    console.time('[RD] Zilean');
    try {
        let url = `${ZILEAN_URL}/dmm/filtered?query=${encodeURIComponent(title)}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;
        const response = await axios.get(url, { timeout: SCRAPER_TIMEOUT, signal });
        console.timeEnd('[RD] Zilean');
        return (response.data || []).slice(0, 100).map(result => ({
            Title: result.raw_title, InfoHash: result.info_hash, Size: parseInt(result.size), Seeders: null, Tracker: 'Zilean | DMM'
        }));
    } catch (error) {
        console.timeEnd('[RD] Zilean');
        if (!axios.isCancel(error)) console.error(`[RD] Zilean failed: ${error.message}`);
        return [];
    }
}

async function searchStremthru(query, signal) {
    console.time('[RD] StremThru');
    try {
        const url = `${STREMTHRU_URL}/v0/torznab/api?t=search&q=${encodeURIComponent(query)}`;
        const response = await axios.get(url, { timeout: SCRAPER_TIMEOUT, signal });
        const parsedXml = await parseStringPromise(response.data);
        const items = parsedXml.rss.channel[0].item || [];
        console.timeEnd('[RD] StremThru');
        return items.slice(0, 100).map(item => {
            let infoHash = null, size = 0;
            const torznabAttrs = item['torznab:attr'];
            if (torznabAttrs) {
                for (const attr of torznabAttrs) {
                    if (attr.$.name === 'infohash') infoHash = attr.$.value;
                    if (attr.$.name === 'size') size = parseInt(attr.$.value);
                }
            }
            if (!infoHash) return null;
            return {
                Title: item.title[0], InfoHash: infoHash, Size: size,
                Seeders: item.seeders ? parseInt(item.seeders[0]) : null, Tracker: 'StremThru'
            };
        }).filter(Boolean);
    } catch (error) {
        console.timeEnd('[RD] StremThru');
        if (!axios.isCancel(error)) console.error(`[RD] StremThru failed: ${error.message}`);
        return [];
    }
}

async function searchTorrentio(mediaType, mediaId, signal) {
    console.time('[RD] Torrentio');
    try {
        const response = await axios.get(`${TORRENTIO_URL}/stream/${mediaType}/${mediaId}.json`, { timeout: SCRAPER_TIMEOUT, signal });
        console.timeEnd('[RD] Torrentio');
        const dataPattern = /(?:👤 (\d+) )?💾 ([\d.]+ [KMGT]B)(?: ⚙️ (\w+))?/;
        return response.data.streams.slice(0, 100).map(stream => {
            const title = stream.title.split('\n')[0];
            const match = stream.title.match(dataPattern);
            const tracker = match && match[3] ? match[3] : 'Public';
            return {
                Title: title, InfoHash: stream.infoHash,
                Size: match ? sizeToBytes(match[2]) : 0,
                Seeders: match && match[1] ? parseInt(match[1]) : 0,
                Tracker: `Torrentio | ${tracker}`
            };
        });
    } catch (error) {
        console.timeEnd('[RD] Torrentio');
        if (!axios.isCancel(error)) console.error(`[RD] Torrentio failed: ${error.message}`);
        return [];
    }
}

async function searchComet(mediaType, mediaId, signal, season, episode) {
    let finalMediaId = mediaId;
    if (mediaType === 'series' && season && episode) {
        finalMediaId = `${mediaId}:${season}:${episode}`;
    }
    const requestUrl = `${COMET_URL}/stream/${mediaType}/${finalMediaId}.json`;
    console.time('[RD] Comet');
    try {
        const response = await axios.get(requestUrl, { timeout: SCRAPER_TIMEOUT, signal });
        console.timeEnd('[RD] Comet');
        return (response.data.streams || []).slice(0, 100).map(stream => {
            const desc = stream.description;
            const titleMatch = desc.match(/📄 (.+)/);
            const title = titleMatch ? titleMatch[1].trim() : 'Unknown Title';
            const seedersMatch = desc.match(/👤 (\d+)/);
            const trackerMatch = desc.match(/🔎 (.+)/);
            return {
                Title: title, InfoHash: stream.infoHash, Size: stream.behaviorHints?.videoSize || 0,
                Seeders: seedersMatch ? parseInt(seedersMatch[1], 10) : 0,
                Tracker: `Comet | ${trackerMatch ? trackerMatch[1].trim() : 'Public'}`
            };
        });
    } catch (error) {
        console.timeEnd('[RD] Comet');
        if (axios.isCancel(error)) return [];
        console.error(`[RD] Comet failed: ${error.message}`);
        return [];
    }
}

// ===================================================================================
// --- HELPER FUNCTIONS ---
// ===================================================================================
function formatSize(size) {
    if (!size) return '0 B';
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

function sizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const units = { 'GB': 1024 * 1024 * 1024, 'MB': 1024 * 1024, 'KB': 1024, 'B': 1 };
    const match = sizeStr.match(/([\d.]+)\s*([KMGTB]{1,2})/i);
    if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        return value * (units[unit] || 1);
    }
    return 0;
}

function filterYear(torrent, cinemetaDetails) {
    const expectedYear = cinemetaDetails?.year;
    if (!expectedYear) {
        return true;
    }
    const torrentYear = torrent?.info?.year;
    if (torrentYear) {
        if (Math.abs(torrentYear - expectedYear) > 1) {
            console.log(`[RD] Filtering wrong year: "${torrent.name}" (found ${torrentYear}, expected ${expectedYear})`);
            return false;
        }
    }
    return true;
}

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
        console.error(`[RD] Error fetching torrents: ${error.message}`);
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
        console.error(`[RD] Error fetching downloads: ${error.message}`);
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
                .filter(file => file.selected && isVideo(file.path) && isValidVideo(file.path, file.bytes));
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
            console.error(`[RD] Error processing torrent ${torrent.id}: ${error.message}`);
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

// ===================================================================================
// --- CATALOG FUNCTIONS ---
// ===================================================================================
async function listTorrents(apiKey, skip = 0) {
    const RD = new RealDebridClient(apiKey);
    const page = Math.floor(skip / 50) + 1;
    try {
        const response = await RD.torrents.get(0, page, 100);
        const metas = (response.data || []).map(torrent => ({
            id: 'realdebrid:' + torrent.id, name: torrent.filename || 'Unknown', type: 'other',
            poster: null, background: null
        }));
        console.log(`[RD] Returning ${metas.length} catalog items`);
        return metas;
    } catch (error) {
        console.error(`[RD] Catalog error: ${error.message}`);
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
        console.error(`[RD] Torrent details error: ${error.message}`);
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
        .filter(file => file.selected && isVideo(file.path) && isValidVideo(file.path, file.bytes))
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
        console.error(`[RD] Downloads search error: ${error.message}`);
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
