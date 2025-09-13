import RealDebridClient from 'real-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';

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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// **Enhanced cache for RD cache status**
const cacheDB = new Map();
const personalHashCache = new Set();

// **Fixed abort controller management**
let globalAbortController = null;

function createAbortController() {
    if (globalAbortController) {
        globalAbortController.abort();
    }
    globalAbortController = new AbortController();
    return globalAbortController;
}

// ===================================================================================
// --- ENHANCED VIDEO FILE FILTERING ---
// ===================================================================================
function isVideo(filename) {
    if (!filename || typeof filename !== 'string') return false;
    
    // Strict video extensions only
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
    
    // Skip non-video files completely
    if (!isVideo(decodedName)) {
        return false;
    }
    
    // Skip samples, trailers, etc.
    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes|bonus|cd\d+)\b/i.test(decodedName)) {
        return false;
    }
    
    // Skip executables and other non-media files
    if (/\.(exe|iso|dmg|pkg|msi|deb|rpm|zip|rar|7z|tar|gz|txt|nfo|sfv)$/i.test(decodedName)) {
        return false;
    }
    
    // Skip small files
    if (fileSize && fileSize < minSize) {
        return false;
    }
    
    return true;
}

// **NEW: Enhanced torrent title validation**
function isValidTorrentTitle(title) {
    if (!title || typeof title !== 'string') return false;
    
    const titleLower = title.toLowerCase();
    
    // **Filter out obvious fake extensions in title**
    const fakeExtensions = ['.exe', '.iso', '.dmg', '.pkg', '.msi', '.deb', '.rpm', '.zip', '.rar', '.7z', '.txt', '.nfo'];
    if (fakeExtensions.some(ext => titleLower.includes(ext))) {
        console.log(`[RD] Filtering fake extension: ${title}`);
        return false;
    }
    
    // **Filter out common fake indicators**
    const fakeIndicators = [
        'crack', 'keygen', 'patch', 'loader', 'activator', 'installer', 'setup',
        'virus', 'malware', 'trojan', 'backdoor', 'password', 'readme',
        'sample only', 'trailer only', 'promo only'
    ];
    
    if (fakeIndicators.some(fake => titleLower.includes(fake))) {
        console.log(`[RD] Filtering fake indicator: ${title}`);
        return false;
    }
    
    // **Must contain video quality indicators or be a proper video title**
    const videoIndicators = [
        '1080p', '720p', '480p', '2160p', '4k', 'uhd', 'hd',
        'bluray', 'webrip', 'hdtv', 'dvdrip', 'web-dl', 'brrip',
        'x264', 'x265', 'h264', 'h265', 'hevc',
        '.mkv', '.mp4', '.avi', '.mov'
    ];
    
    const hasVideoIndicator = videoIndicators.some(indicator => titleLower.includes(indicator));
    
    // **Additional check for series/movie patterns**
    const hasSeriesPattern = /s\d{1,2}e\d{1,2}/i.test(titleLower);
    const hasYearPattern = /\b(19|20)\d{2}\b/.test(titleLower);
    
    if (!hasVideoIndicator && !hasSeriesPattern && !hasYearPattern) {
        console.log(`[RD] Filtering no video indicators: ${title}`);
        return false;
    }
    
    return true;
}

// ===================================================================================
// --- ENHANCED CACHE CHECKING SYSTEM ---
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

// **Torrent Quality Priority Scoring System**
function calculateTorrentPriority(torrent) {
    const name = (torrent.Title || torrent.title || '').toLowerCase();
    const seeders = parseInt(torrent.Seeders || torrent.seeders || 0);
    
    let priorityScore = 0;
    
    // **HIGH PRIORITY: Premium quality indicators**
    if (name.includes('.web.') || name.includes(' web ')) priorityScore += 100;
    if (name.includes('.web-dl.') || name.includes(' web-dl ')) priorityScore += 100;
    if (name.includes('.bluray.') || name.includes(' bluray ')) priorityScore += 100;
    if (name.includes('remux')) priorityScore += 150; // Highest priority for remux
    
    // **MEDIUM PRIORITY: Good quality indicators**
    if (name.includes('.brrip.') || name.includes(' brrip ')) priorityScore += 75;
    if (name.includes('.webrip.') || name.includes(' webrip ')) priorityScore += 75;
    if (name.includes('.hdtv.') || name.includes(' hdtv ')) priorityScore += 50;
    
    // **RESOLUTION BONUS**
    if (name.includes('2160p') || name.includes('4k')) priorityScore += 30;
    else if (name.includes('1080p')) priorityScore += 20;
    else if (name.includes('720p')) priorityScore += 10;
    
    // **CODEC BONUS**
    if (name.includes('x265') || name.includes('hevc')) priorityScore += 15;
    if (name.includes('x264') || name.includes('h264')) priorityScore += 10;
    
    // **SEEDERS CONTRIBUTION (normalized to max 50 points)**
    priorityScore += Math.min(seeders / 100, 50);
    
    // **PENALTIES: Lower quality indicators**
    if (name.includes('cam') || name.includes('ts') || name.includes('screener')) priorityScore -= 100;
    if (name.includes('dvdrip') || name.includes('dvdscr')) priorityScore -= 25;
    
    return priorityScore;
}

async function checkAndProcessCache(apiKey, externalTorrents, searchType, searchId) {
    if (!externalTorrents || externalTorrents.length === 0) {
        console.log(`[RD CACHE] No external torrents provided to check`);
        return [];
    }
    
    const RD = new RealDebridClient(apiKey);
    const cachedResults = [];
    
    // **Enhanced tracking: Quality + Resolution combinations**
    const qualityResolutionTracker = {
        'Remux': new Set(),      // Track unique resolutions for Remux
        'WEB/WEB-DL': new Set(), // Track unique resolutions for WEB/WEB-DL
        'BluRay': new Set(),     // Track unique resolutions for BluRay
        'BRRip/WEBRip': new Set(), // Track unique resolutions for BRRip/WEBRip
        'Other': new Set()       // Track unique resolutions for Other
    };
    
    const maxPerQuality = 6; // Maximum per quality category
    
    console.log(`[RD CACHE] Starting SMART cache check for ${externalTorrents.length} external torrents...`);
    console.log(`[RD CACHE] 🎯 Quality+Resolution diversity: Max 3 per quality, prefer different resolutions`);
    
    // **Extract episode info from search**
    let targetSeason = null;
    let targetEpisode = null;
    
    if (searchType === 'series' && searchId && searchId.includes(':')) {
        const [imdbId, season, episode] = searchId.split(':');
        targetSeason = parseInt(season);
        targetEpisode = parseInt(episode);
        console.log(`[RD CACHE] 🎯 Target: Season ${targetSeason}, Episode ${targetEpisode}`);
    }
    
    // **Helper function to check if torrent contains target episode**
    function containsTargetEpisode(torrent) {
        if (!targetSeason || !targetEpisode) return true; // For movies
        
        const title = (torrent.Title || torrent.title || torrent.name || '').toLowerCase();
        console.log(`[RD CACHE] 🔍 Checking episode filtering for: "${title.substring(0, 60)}"`);
        
        // **Direct episode match**
        const episodeRegex = new RegExp(`s0?${targetSeason}e0?${targetEpisode}(?!\\d)`, 'i');
        if (episodeRegex.test(title)) {
            console.log(`[RD CACHE] ✅ Direct episode match found`);
            return true;
        }
        
        // **Season pack detection**
        const seasonPackPatterns = [
            new RegExp(`s0?${targetSeason}(?:\\s|\\.|_)?(?:complete|full|pack)`, 'i'),
            new RegExp(`season\\s?0?${targetSeason}(?:\\s|\\.|_)?(?:complete|full|pack)`, 'i')
        ];
        
        const isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(title));
        if (isSeasonPack) {
            console.log(`[RD CACHE] 📦 Season pack detected`);
            return true;
        }
        
        console.log(`[RD CACHE] ❌ No episode match found`);
        return false;
    }
    
    // **Helper function to extract resolution**
    function getResolution(torrent) {
        const name = (torrent.Title || torrent.title || '').toLowerCase();
        
        if (name.includes('2160p') || name.includes('4k') || name.includes('uhd')) return '2160p';
        if (name.includes('1080p')) return '1080p';
        if (name.includes('720p')) return '720p';
        if (name.includes('480p')) return '480p';
        return 'other';
    }
    
    // **Helper function to determine quality category**
    function getQualityCategory(torrent) {
        const name = (torrent.Title || torrent.title || '').toLowerCase();
        
        if (name.includes('remux')) return 'Remux';
        if (name.includes('.web.') || name.includes('.web-dl.') || name.includes(' web ') || name.includes(' web-dl ')) return 'WEB/WEB-DL';
        if (name.includes('.bluray.') || name.includes(' bluray ')) return 'BluRay';
        if (name.includes('.brrip.') || name.includes('.webrip.') || name.includes(' brrip ') || name.includes(' webrip ')) return 'BRRip/WEBRip';
        return 'Other';
    }
    
    // **Helper function to check if we can add this quality+resolution combo**
    function canAddQualityResolution(category, resolution) {
        const currentCount = qualityResolutionTracker[category].size;
        const hasResolution = qualityResolutionTracker[category].has(resolution);
        
        // Can add if under limit AND (don't have this resolution OR slots available)
        return currentCount < maxPerQuality && (!hasResolution || currentCount === 0);
    }
    
    // **Helper function to add quality+resolution combo**
    function addQualityResolution(category, resolution) {
        qualityResolutionTracker[category].add(resolution);
    }
    
    // **Helper function to get current status**
    function getQualityStatus() {
        const status = {};
        for (const [category, resolutions] of Object.entries(qualityResolutionTracker)) {
            if (resolutions.size > 0) {
                status[category] = `${resolutions.size}/3 [${Array.from(resolutions).join(', ')}]`;
            }
        }
        return status;
    }
    
    // **STEP 1: Filter torrents by episode BEFORE processing**
    const episodeFilteredTorrents = externalTorrents.filter(containsTargetEpisode);
    
    console.log(`[RD CACHE] 🎯 Episode filtering: ${episodeFilteredTorrents.length} torrents contain target episode (filtered out ${externalTorrents.length - episodeFilteredTorrents.length})`);
    
    if (episodeFilteredTorrents.length === 0) {
        console.log(`[RD CACHE] No torrents contain the target episode - returning empty results`);
        return [];
    }
    
    // **Extract valid torrents**
    const validTorrents = [];
    
    for (const torrent of episodeFilteredTorrents) {
        let infoHash = torrent.InfoHash || torrent.infoHash || torrent.hash || torrent.Hash;
        
        if (!infoHash || infoHash.length !== 40) continue;
        
        if (!torrent.Title && !torrent.title) {
            torrent.Title = torrent.name || torrent.filename || `Torrent ${infoHash.substring(0, 8)}`;
        }
        
        if (!torrent.InfoHash) torrent.InfoHash = infoHash.toLowerCase();
        validTorrents.push(torrent);
    }
    
    if (validTorrents.length === 0) {
        console.log(`[RD CACHE] No valid torrents to check`);
        return cachedResults;
    }
    
    // **STEP 2: Priority sorting with diversity preference**
    const torrentsWithPriority = validTorrents.map(torrent => {
        const category = getQualityCategory(torrent);
        const resolution = getResolution(torrent);
        const baseScore = calculateTorrentPriority(torrent);
        
        // **DIVERSITY BONUS: Prefer new resolution combinations**
        let diversityBonus = 0;
        if (canAddQualityResolution(category, resolution)) {
            // Higher bonus for categories with fewer resolutions
            const currentResCount = qualityResolutionTracker[category].size;
            diversityBonus = (maxPerQuality - currentResCount) * 50; // Up to 150 bonus points
            
            // Extra bonus for completely new resolution in this category
            if (!qualityResolutionTracker[category].has(resolution)) {
                diversityBonus += 100;
            }
        }
        
        return {
            ...torrent,
            priorityScore: baseScore + diversityBonus,
            category,
            resolution,
            diversityBonus
        };
    });
    
    // Sort by enhanced priority score (highest first)
    torrentsWithPriority.sort((a, b) => b.priorityScore - a.priorityScore);
    
    // **STEP 3: Smart selection - prioritize needed quality+resolution combos**
    const torrentsToCheck = [];
    
    for (const torrent of torrentsWithPriority) {
        if (canAddQualityResolution(torrent.category, torrent.resolution) && torrentsToCheck.length < 200) {
            torrentsToCheck.push(torrent);
        }
    }
    
    if (torrentsToCheck.length === 0) {
        console.log(`[RD CACHE] ✅ All quality+resolution combinations satisfied - returning ${cachedResults.length} results`);
        return cachedResults;
    }
    
    console.log(`[RD CACHE] 🎯 DIVERSITY-TARGETED SELECTION: ${torrentsToCheck.length} torrents to check`);
    
    // **Show what we're still looking for**
    const neededCombos = [];
    for (const [category, resolutions] of Object.entries(qualityResolutionTracker)) {
        if (resolutions.size < maxPerQuality) {
            const available = ['2160p', '1080p', '720p', '480p', 'other'].filter(res => !resolutions.has(res));
            if (available.length > 0) {
                neededCombos.push(`${category}: ${available.join('|')}`);
            }
        }
    }
    console.log(`[RD CACHE] 🎯 Still seeking: ${neededCombos.join(', ')}`);
    
    console.log(`[RD CACHE] 🧲 CHECKING DIVERSITY-TARGETED TORRENTS:`);
    torrentsToCheck.forEach((torrent, index) => {
        const torrentTitle = torrent.Title || torrent.title || 'Unknown';
        const seeders = parseInt(torrent.Seeders || torrent.seeders || 0);
        const bonus = torrent.diversityBonus > 0 ? ` +${torrent.diversityBonus}` : '';
        
        console.log(`[RD CACHE] ${index + 1}. [${torrent.category} ${torrent.resolution}] "${torrentTitle}" (Score: ${Math.round(torrent.priorityScore)}${bonus}, ${seeders} seeders)`);
    });
    
    // **STEP 4: Check targeted torrents via Real-Debrid API**
    for (let i = 0; i < torrentsToCheck.length; i++) {
        const torrent = torrentsToCheck[i];
        const hash = torrent.InfoHash.toLowerCase();
        const { category, resolution } = torrent;
        
        // **Double-check if we still need this combination**
        if (!canAddQualityResolution(category, resolution)) {
            console.log(`[RD CACHE] 🚫 SKIPPING - ${category} ${resolution} no longer needed`);
            continue;
        }
        
        let torrentId = null;
        
        try {
            const torrentTitle = torrent.Title || torrent.title || 'Unknown';
            
            console.log(`[RD CACHE] [${i + 1}/${torrentsToCheck.length}] API Testing [${category} ${resolution}]: "${torrentTitle}"`);
            
            const magnetLink = `magnet:?xt=urn:btih:${torrent.InfoHash}`;
            
            // **API CALL 1: Add magnet with 429 handling**
            let addResponse;
            try {
                addResponse = await RD.torrents.addMagnet(magnetLink);
            } catch (addError) {
                if (addError.response?.status === 429) {
                    console.log(`[RD CACHE] ⚠️ RATE LIMITED (429) - waiting 3 seconds...`);
                    await delay(3000);
                    try {
                        addResponse = await RD.torrents.addMagnet(magnetLink);
                    } catch (retryError) {
                        console.log(`[RD CACHE] ❌ Failed even after retry`);
                        continue;
                    }
                } else {
                    throw addError;
                }
            }
            
            if (!addResponse?.data?.id) {
                console.log(`[RD CACHE] ❌ Failed to add magnet`);
                continue;
            }
            
            torrentId = addResponse.data.id;
            console.log(`[RD CACHE] ➕ Added magnet as torrent: ${torrentId}`);
            
            // **API CALL 2: Select files**
            try {
                await RD.torrents.selectFiles(torrentId);
                console.log(`[RD CACHE] 📁 Selected all files for processing`);
            } catch (selectError) {
                if (selectError.response?.status === 429) {
                    console.log(`[RD CACHE] ⚠️ RATE LIMITED (429) on selectFiles - waiting 3 seconds...`);
                    await delay(3000);
                    try {
                        await RD.torrents.selectFiles(torrentId);
                        console.log(`[RD CACHE] 📁 Selected files after retry`);
                    } catch (retryError) {
                        console.log(`[RD CACHE] ❌ SelectFiles failed even after retry`);
                        throw retryError;
                    }
                } else {
                    throw selectError;
                }
            }
            
            // **API CALL 3: Get torrent info**
            let torrentInfo;
            try {
                torrentInfo = await RD.torrents.info(torrentId);
            } catch (infoError) {
                if (infoError.response?.status === 429) {
                    console.log(`[RD CACHE] ⚠️ RATE LIMITED (429) on info - waiting 3 seconds...`);
                    await delay(3000);
                    try {
                        torrentInfo = await RD.torrents.info(torrentId);
                    } catch (retryError) {
                        console.log(`[RD CACHE] ❌ Info failed even after retry`);
                        throw retryError;
                    }
                } else {
                    throw infoError;
                }
            }
            
            if (!torrentInfo?.data) {
                console.log(`[RD CACHE] ❌ No torrent data received`);
                continue;
            }
            
            const status = torrentInfo.data.status;
            const progress = torrentInfo.data.progress || 0;
            const filename = torrentInfo.data.filename || 'Unknown';
            
            console.log(`[RD CACHE] 📊 "${filename}": status="${status}", progress=${progress}%`);
            
            let isCached = false;
            let hasVideoFiles = false;
            
            if (status === 'downloaded' || status === 'finished') {
                isCached = true;
                console.log(`[RD CACHE] ✅ CACHED (${status})`);
                
                if (torrentInfo.data.files && torrentInfo.data.files.length > 0) {
                    const videoFiles = torrentInfo.data.files
                        .filter(file => file.selected)
                        .filter(file => isVideo(file.path))
                        .filter(file => isValidVideo(file.path, file.bytes));
                    
                    hasVideoFiles = videoFiles.length > 0;
                    console.log(`[RD CACHE] 🎬 Found ${videoFiles.length} valid video files`);
                } else {
                    hasVideoFiles = true;
                }
            } else {
                isCached = false;
                console.log(`[RD CACHE] ❌ NOT CACHED (${status}, ${progress}%)`);
            }
            
            // **STEP 5: Add to results with diversity tracking**
            if (isCached && hasVideoFiles) {
                if (canAddQualityResolution(category, resolution)) {
                    try {
                        const cachedTorrent = {
                            ...torrent,
                            source: 'realdebrid',
                            isCached: true,
                            tracker: (torrent.tracker || 'External') + ' [CACHED]'
                        };
                        cachedResults.push(cachedTorrent);
                        addQualityResolution(category, resolution);
                        console.log(`[RD CACHE] ✅ ADDED [${category} ${resolution}]: "${torrentTitle}"`);
                    } catch (formatError) {
                        console.log(`[RD CACHE] ❌ Error formatting: ${formatError.message}`);
                    }
                } else {
                    console.log(`[RD CACHE] 🚫 CACHED but ${category} ${resolution} no longer needed`);
                }
            } else {
                console.log(`[RD CACHE] ❌ CACHED AS NOT AVAILABLE: "${torrentTitle}"`);
            }
            
        } catch (error) {
            console.log(`[RD CACHE] ❌ ERROR: ${error.message}`);
        } finally {
            // **API CALL 4: Delete test torrent**
            if (torrentId) {
                try {
                    await RD.torrents.delete(torrentId);
                    console.log(`[RD CACHE] 🗑️ Deleted test torrent ${torrentId}`);
                } catch (deleteError) {
                    if (deleteError.response?.status === 429) {
                        console.log(`[RD CACHE] ⚠️ RATE LIMITED (429) on delete - waiting 3 seconds...`);
                        await delay(3000);
                        try {
                            await RD.torrents.delete(torrentId);
                            console.log(`[RD CACHE] 🗑️ Deleted after retry: ${torrentId}`);
                        } catch (finalError) {
                            console.log(`[RD CACHE] ⚠️ Final delete failed: ${finalError.message}`);
                        }
                    } else {
                        console.log(`[RD CACHE] ⚠️ Delete failed: ${deleteError.message}`);
                    }
                }
            }
        }
        
        // **Early termination if all diversity slots filled**
        const currentTotal = Object.values(qualityResolutionTracker).reduce((sum, resSet) => sum + resSet.size, 0);
        const maxPossibleSlots = Object.keys(qualityResolutionTracker).length * maxPerQuality;
        if (currentTotal >= maxPossibleSlots) {
            console.log(`[RD CACHE] 🎯 ALL QUALITY+RESOLUTION COMBINATIONS SATISFIED - stopping early`);
            break;
        }
    }
    
    // **STEP 6: Show final results with diversity breakdown**
    const finalStatus = getQualityStatus();
    
    console.log(`[RD CACHE] 🏁 DIVERSITY-OPTIMIZED RESULT: ${cachedResults.length} total cached torrents returned`);
    console.log(`[RD CACHE] 🎯 Final diversity: ${JSON.stringify(finalStatus)}`);
    
    return cachedResults;
}

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

// **Enhanced external result formatting with pre-filtering**
function formatExternalResult(result) {
    // **CRITICAL: Pre-filter fake torrents**
    if (!isValidTorrentTitle(result.Title)) {
        return null;
    }
    
    // **Filter by minimum size (200MB for external torrents)**
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

function combineAndMarkResults(apiKey, personalFiles, externalSources) {
    const sourceNames = ['Jackett', 'Zilean', 'Torrentio', 'Comet', 'StremThru', 'Bitmagnet'];
    let sourceCounts = `Personal(${personalFiles.length})`;
    
    externalSources.forEach((source, index) => {
        if (source && source.length > 0) {
            sourceCounts += `, ${sourceNames[index]}(${source.length})`;
        }
    });
    
    console.log(`[RD] Sources found: ${sourceCounts}`);

    // Mark personal files
    const markedPersonal = personalFiles.map(file => ({
        ...file,
        source: 'realdebrid',
        isPersonal: true,
        tracker: 'Personal'
    }));

    // **Process external sources with enhanced filtering**
    const externalTorrents = [].concat(...externalSources);
    const uniqueExternalTorrents = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]));

    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    
    // Filter out external torrents we already have
    const newExternalTorrents = Array.from(uniqueExternalTorrents.values())
        .filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

    // **Apply comprehensive filtering and remove nulls**
    const preFilteredResults = newExternalTorrents
        .map(result => formatExternalResult(result))
        .filter(Boolean); // Remove null results from filtering

    console.log(`[RD] After pre-filtering: ${personalFiles.length} personal + ${preFilteredResults.length} valid external`);
    return [...markedPersonal, ...preFilteredResults];
}

// ===================================================================================
// --- MAIN SEARCH WITH ENHANCED FILTERING ---
// ===================================================================================
async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
    console.log(`[RD] Starting search for: "${searchKey}"`);
    
    if (!searchKey) {
        return [];
    }

    const abortController = createAbortController();
    const signal = abortController.signal;

    try {
        // **STEP 1: Get personal files first**
        console.time('[RD] Personal files');
        const personalFiles = await searchPersonalFiles(apiKey, searchKey, threshold);
        console.timeEnd('[RD] Personal files');
        
        // **STEP 2: Search external sources**
        console.log(`[RD] Searching external sources...`);
        
        const scraperPromises = [];
        if (JACKETT_ENABLED) scraperPromises.push(searchJackett(searchKey, signal));
        if (ZILEAN_ENABLED) scraperPromises.push(searchZilean(searchKey, null, null, signal));
        if (STREMTHRU_ENABLED) scraperPromises.push(searchStremthru(searchKey, signal));
        if (COMET_ENABLED) scraperPromises.push(searchComet('movie', 'unknown', signal));

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Search timeout')), 6000);
        });

        let scraperResults = [];
        try {
            scraperResults = await Promise.race([
                Promise.all(scraperPromises),
                timeoutPromise
            ]);
            console.log(`[RD] External scrapers completed`);
        } catch (error) {
            console.log(`[RD] Scraper timeout: ${error.message}`);
            scraperResults = [];
        }

        // **STEP 3: Combine and pre-filter results**
        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults);
        
        if (combinedResults.length === 0) {
            return personalFiles;
        }

        // **STEP 4: Cache check only for external torrents**
        const externalTorrents = combinedResults.filter(t => !t.isPersonal);
        
        if (externalTorrents.length === 0) {
            return personalFiles;
        }

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

// **Comprehensive search for series with metadata**
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

        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults);
        
        // **Enhanced cache checking for series**
        const externalTorrents = combinedResults.filter(t => !t.isPersonal);
        const cachedResults = await checkAndProcessCache(apiKey, externalTorrents);

        // Apply year filtering for movies
        if (type === 'movie' && cinemetaDetails.year) {
            const allResults = [...personalFiles, ...cachedResults];
            const filtered = allResults.filter(torrent => filterYear(torrent, cinemetaDetails));
            console.log(`[RD] Filtered by year (${cinemetaDetails.year})`);
            return filtered;
        }

        const finalResults = [...personalFiles, ...cachedResults];
        console.log(`[RD] Comprehensive total: ${finalResults.length} streams`);
        return finalResults;
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
// --- REST OF THE FUNCTIONS (Personal files, scrapers, etc.) ---
// ===================================================================================
async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
    const RD = new RealDebridClient(apiKey);
    
    try {
        const fetchPromises = [
            Promise.race([
                getAllTorrents(RD),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Torrents timeout')), 5000))
            ]).catch(() => []),
            
            Promise.race([
                getAllDownloads(RD),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Downloads timeout')), 5000))
            ]).catch(() => [])
        ];

        const [existingTorrents, existingDownloads] = await Promise.all(fetchPromises);

        console.log(`[RD] Found ${existingTorrents.length} torrents, ${existingDownloads.length} downloads`);

        const relevantTorrents = filterFilesByKeywords(existingTorrents, searchKey);
        const relevantDownloads = filterFilesByKeywords(existingDownloads, searchKey);

        if (relevantTorrents.length === 0 && relevantDownloads.length === 0) {
            return [];
        }

        const torrentFiles = await processTorrents(RD, relevantTorrents.slice(0, 5));
        const allFiles = [...torrentFiles, ...relevantDownloads.map(d => formatDownloadFile(d))];

        if (allFiles.length === 0) {
            return [];
        }

        const enhancedFiles = allFiles.map(file => ({
            ...file,
            source: 'realdebrid',
            isPersonal: true,
            info: PTT.parse(file.name)
        }));

        const fuse = new Fuse(enhancedFiles, {
            keys: ['info.title', 'name'],
            threshold: threshold,
            minMatchCharLength: 2
        });

        const results = fuse.search(searchKey);
        return results.map(r => r.item);

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
// --- EXTERNAL SCRAPERS (UNCHANGED) ---
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
        return (response.data.Results || []).slice(0, 50).map(r => ({
            Title: r.Title,
            InfoHash: r.InfoHash,
            Size: r.Size,
            Seeders: r.Seeders,
            Tracker: `Jackett | ${r.Tracker}`
        }));
    } catch (error) {
        console.timeEnd('[RD] Jackett');
        if (!axios.isCancel(error)) {
            console.error(`[RD] Jackett failed: ${error.message}`);
        }
        return [];
    }
}

async function searchZilean(title, season, episode, signal) {
    console.time('[RD] Zilean');
    try {
        let url = `${ZILEAN_URL}/dmm/filtered?query=${encodeURIComponent(title)}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;
        
        const response = await axios.get(url, { 
            timeout: SCRAPER_TIMEOUT, 
            signal 
        });
        console.timeEnd('[RD] Zilean');
        return (response.data || []).slice(0, 50).map(result => ({
            Title: result.raw_title,
            InfoHash: result.info_hash,
            Size: parseInt(result.size),
            Seeders: null,
            Tracker: 'Zilean | DMM'
        }));
    } catch (error) {
        console.timeEnd('[RD] Zilean');
        if (!axios.isCancel(error)) {
            console.error(`[RD] Zilean failed: ${error.message}`);
        }
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
        return items.slice(0, 50).map(item => {
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
                Title: item.title[0],
                InfoHash: infoHash,
                Size: size,
                Seeders: item.seeders ? parseInt(item.seeders[0]) : null,
                Tracker: 'StremThru'
            };
        }).filter(Boolean);
    } catch (error) {
        console.timeEnd('[RD] StremThru');
        if (!axios.isCancel(error)) {
            console.error(`[RD] StremThru failed: ${error.message}`);
        }
        return [];
    }
}

async function searchTorrentio(mediaType, mediaId, signal) {
    console.time('[RD] Torrentio');
    try {
        const response = await axios.get(`${TORRENTIO_URL}/stream/${mediaType}/${mediaId}.json`, { timeout: SCRAPER_TIMEOUT, signal });
        console.timeEnd('[RD] Torrentio');
        const dataPattern = /(?:👤 (\d+) )?💾 ([\d.]+ [KMGT]B)(?: ⚙️ (\w+))?/;
        return response.data.streams.slice(0, 50).map(stream => {
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
        
        return (response.data.streams || []).slice(0, 50).map(stream => {
            const desc = stream.description;
            const titleMatch = desc.match(/📄 (.+)/);
            const title = titleMatch ? titleMatch[1].trim() : 'Unknown Title';
            const seedersMatch = desc.match(/👤 (\d+)/);
            const trackerMatch = desc.match(/🔎 (.+)/);
            
            return {
                Title: title,
                InfoHash: stream.infoHash,
                Size: stream.behaviorHints?.videoSize || 0,
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
    if (torrent?.info?.year && cinemetaDetails?.year) {
        return torrent.info.year == cinemetaDetails.year;
    } else if (cinemetaDetails?.year) {
        const yearStr = cinemetaDetails.year.toString();
        return torrent.name.includes(yearStr) || 
               (torrent.searchableName && torrent.searchableName.includes(yearStr));
    }
    return true;
}

async function getAllTorrents(RD) {
    const allTorrents = [];
    
    try {
        for (let page = 1; page <= 2; page++) {
            const response = await RD.torrents.get(0, page, 50);
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
        const response = await RD.downloads.get(0, 1, 50);
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
            
            if (!torrentDetails?.data?.files || !torrentDetails.data.links) {
                continue;
            }

            const videoFiles = torrentDetails.data.files
                .filter(file => file.selected)
                .filter(file => isVideo(file.path))
                .filter(file => isValidVideo(file.path, file.bytes));
            
            for (const file of videoFiles) {
                const fileIndex = torrentDetails.data.files.findIndex(f => f.id === file.id);
                const directUrl = torrentDetails.data.links?.[fileIndex];
                
                if (directUrl && directUrl !== 'undefined') {
                    allVideoFiles.push({
                        id: `${torrent.id}:${file.id}`,
                        name: file.path,
                        info: PTT.parse(file.path),
                        size: file.bytes,
                        hash: torrent.hash,
                        url: directUrl,
                        source: 'realdebrid',
                        isPersonal: true,
                        tracker: 'Personal'
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
        id: download.id,
        name: download.filename,
        info: PTT.parse(download.filename),
        size: download.filesize,
        url: download.download,
        source: 'realdebrid',
        isPersonal: true,
        tracker: 'Personal'
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
        console.log(`[RD] Listing torrents page ${page}`);
        const response = await Promise.race([
            RD.torrents.get(0, page, 50),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        
        const metas = (response.data || []).map(torrent => ({
            id: 'realdebrid:' + torrent.id,
            name: torrent.filename || 'Unknown',
            type: 'other',
            poster: null,
            background: null
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
            source: 'realdebrid',
            id: torrentId,
            name: 'Unknown Torrent',
            type: 'other',
            hash: null,
            info: { title: 'Unknown' },
            size: 0,
            created: new Date(),
            videos: []
        };
    }
}

async function toTorrentDetails(apiKey, item) {
    if (!item || !item.files) {
        return {
            source: 'realdebrid',
            id: item?.id || 'unknown',
            name: item?.filename || 'Unknown Torrent',
            type: 'other',
            hash: item?.hash || null,
            info: PTT.parse(item?.filename || '') || { title: 'Unknown' },
            size: item?.bytes || 0,
            created: new Date(item?.added || Date.now()),
            videos: []
        };
    }

    const videos = item.files
        .filter(file => file.selected)
        .filter(file => isVideo(file.path))
        .filter(file => isValidVideo(file.path, file.bytes))
        .map((file, index) => {
            const fileIndex = item.files.findIndex(f => f.id === file.id);
            const hostUrl = item.links?.[fileIndex];
            
            if (!hostUrl || hostUrl === 'undefined') {
                return null;
            }

            return {
                id: `${item.id}:${file.id}`,
                name: file.path,
                url: hostUrl,
                size: file.bytes,
                created: new Date(item.added),
                info: PTT.parse(file.path)
            };
        })
        .filter(Boolean);

    return {
        source: 'realdebrid',
        id: item.id,
        name: item.filename,
        type: 'other',
        hash: item.hash,
        info: PTT.parse(item.filename),
        size: item.bytes,
        created: new Date(item.added),
        videos: videos || []
    };
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
    if (!searchKey) return [];
    
    try {
        const RD = new RealDebridClient(apiKey);
        const downloads = await getAllDownloads(RD);
        
        const relevantDownloads = filterFilesByKeywords(downloads, searchKey)
            .map(d => formatDownloadFile(d));

        const fuse = new Fuse(relevantDownloads, {
            keys: ['info.title', 'name'],
            threshold: threshold
        });

        const results = fuse.search(searchKey);
        return results.map(r => r.item);
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
    searchTorrents,           // Enhanced with cache checking and filtering
    searchDownloads,
    getTorrentDetails,
    unrestrictUrl,           // Fixed to return direct streaming URLs
    searchRealDebridTorrents // Comprehensive search with metadata and cache checking
};

