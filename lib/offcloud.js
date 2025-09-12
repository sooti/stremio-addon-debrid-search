import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import OC from 'offcloud-api';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio'; // Added for HTML parsing

// ===================================================================================
// --- CONFIGURATION (loaded from .env file) ---
// ===================================================================================
const BITMAGNET_URL = process.env.BITMAGNET_URL || 'http://YOUR_BITMAGNET_URL';
const TORZNAB_LIMIT = parseInt(process.env.TORZNAB_LIMIT) || 50;
const JACKETT_URL = process.env.JACKETT_URL || 'http://YOUR_JACKETT_IP:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || '';
const TORRENTIO_URL = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
const ZILEAN_URL = process.env.ZILEAN_URL || 'https://zilean.elfhosted.com';
const COMET_URL = process.env.COMET_URL || 'https://comet.elfhosted.com';
const STREMTHRU_URL = process.env.STREMTHRU_URL || 'https://stremthru.elfhosted.com';
const BT4G_URL = process.env.BT4G_URL || 'https://bt4gprx.com'; // New scraper URL
const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT) || 5000;

// --- Scraper Enable/Disable Flags ---
const BITMAGNET_ENABLED = process.env.BITMAGNET_ENABLED === 'true';
const JACKETT_ENABLED = process.env.JACKETT_ENABLED === 'true';
const TORRENTIO_ENABLED = process.env.TORRENTIO_ENABLED === 'true';
const ZILEAN_ENABLED = process.env.ZILEAN_ENABLED === 'true';
const COMET_ENABLED = process.env.COMET_ENABLED === 'true';
const STREMTHRU_ENABLED = process.env.STREMTHRU_ENABLED === 'true';
const BT4G_ENABLED = process.env.BT4G_ENABLED === 'true'; // New scraper flag
// ===================================================================================

const OFFCLOUD_API_URL = 'https://offcloud.com/api';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ===================================================================================
// --- 1. CORE SEARCH ORCHESTRATOR ---
// ===================================================================================
async function searchOffcloudTorrents(apiKey, type, id) {
    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) { return []; }

    const searchKey = cinemetaDetails.name;
    const alternateTitles = cinemetaDetails.alternateTitles || [];
    const allSearchKeys = [searchKey, ...alternateTitles].filter(Boolean);

    const specificSearchKey = type === 'series'
        ? `${searchKey} s${season.toString().padStart(2, '0')}e${episode.toString().padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

    console.log(`[OC] Starting unified search for: "${specificSearchKey}" (and ${alternateTitles.length} alternate titles)`);

    const abortController = new AbortController();
    const signal = abortController.signal;

    const scraperPromises = [];
    if (BITMAGNET_ENABLED) scraperPromises.push(searchBitmagnet(specificSearchKey, signal));
    if (JACKETT_ENABLED) scraperPromises.push(searchJackett(specificSearchKey, signal));
    if (TORRENTIO_ENABLED) scraperPromises.push(searchTorrentio(type, imdbId, signal));
    if (ZILEAN_ENABLED) scraperPromises.push(searchZilean(specificSearchKey, season, episode, signal));
    if (COMET_ENABLED) scraperPromises.push(searchComet(type, imdbId, signal, season, episode));
    if (STREMTHRU_ENABLED) scraperPromises.push(searchStremthru(specificSearchKey, signal));
    if (BT4G_ENABLED) scraperPromises.push(searchBt4g(specificSearchKey, signal)); // Added BT4G scraper

    try {
        console.time('[OC] Total search time');
        const [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, allSearchKeys, specificSearchKey, type, season, episode),
            ...scraperPromises
        ]);
        console.timeEnd('[OC] Total search time');

        let combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults);

        // **CRITICAL: Check for bypass streams FIRST, before any other filtering**
        const bypassStreams = combinedResults.filter(stream => stream.bypassFiltering === true);
        if (bypassStreams.length > 0) {
            console.log(`[OC FINAL] Found ${bypassStreams.length} bypass streams - returning ONLY these direct cloud links`);
            console.log(`[OC FINAL] Bypass stream URLs: ${bypassStreams.map(s => s.url).join(', ')}`);
            return bypassStreams;
        }

        if (type === 'movie' && cinemetaDetails.year) {
            const originalCount = combinedResults.length;
            const filtered = combinedResults.filter(torrent => filterYear(torrent, cinemetaDetails));
            console.log(`[OC] Filtered by year (${cinemetaDetails.year}). Removed ${originalCount - filtered.length} mismatched results.`);
            return filtered;
        }

        console.log(`[OC] Returning a combined total of ${combinedResults.length} unique streams.`);
        return combinedResults;
    } catch (error) {
        console.error(`[OC] A scraper may have failed, cancelling other requests.`);
        abortController.abort();
        const completedResults = await Promise.all(scraperPromises.map(p => p.catch(() => [])));
        const personalFiles = await searchPersonalFiles(apiKey, allSearchKeys, specificSearchKey, type, season, episode); // Pass key here too for error case
        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, completedResults);
        
        // **CRITICAL: Check for bypass streams in error case too**
        const bypassStreams = combinedResults.filter(stream => stream.bypassFiltering === true);
        if (bypassStreams.length > 0) {
            console.log(`[OC FINAL ERROR] Found ${bypassStreams.length} bypass streams - returning ONLY these direct cloud links`);
            return bypassStreams;
        }
        
        return combinedResults;
    }
}

// ===================================================================================
// --- 2. SEARCH & COMBINE LOGIC ---
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

// **IMPROVED: Find exact archive match and return direct video link**
// **FIXED: Don't skip video files with 0MB in exact matches**
async function findExactArchiveMatch(OCClient, searchTerm, history, season, episode) {
    const MIN_SIZE = 350 * 1024 * 1024; // 350MB
    
    // Normalize strings for better matching (removes dots, spaces, hyphens, underscores)
    function normalize(str) {
        return str.toLowerCase().replace(/[\.\-_\s]/g, '');
    }
    
    // Extract show name and create multiple episode patterns
    const showName = searchTerm.split(' s0')[0];
    const normalizedShowName = normalize(showName);
    
    // Create multiple season/episode patterns to handle different formats
    const seasonStr = season.toString().padStart(2, '0');
    const episodeStr = episode.toString().padStart(2, '0');
    const seasonEpisodePatterns = [
        `s${seasonStr}e${episodeStr}`,  // s01e08
        `s${season}e${episode}`,        // s1e8
        `s${season}e${episodeStr}`,     // s1e08
        `s${seasonStr}e${episode}`      // s01e8
    ];
    
    console.log(`[OC EXACT] Looking for archives containing: "${showName}" AND season ${season} episode ${episode}`);
    console.log(`[OC EXACT] Normalized show name: "${normalizedShowName}"`);
    console.log(`[OC EXACT] Episode patterns: ${seasonEpisodePatterns.join(', ')}`);
    
    // Look for archives that contain both the show name and season/episode pattern
    for (const item of history) {
        const fileName = item.fileName.toLowerCase();
        const normalizedFileName = normalize(fileName);
        
        // **IMPROVED: Check normalized names for better matching**
        const hasShowName = normalizedFileName.includes(normalizedShowName);
        
        // Check multiple episode patterns
        const hasSeasonEpisode = seasonEpisodePatterns.some(pattern => {
            const normalizedPattern = normalize(pattern);
            return normalizedFileName.includes(normalizedPattern);
        });
        
        if (hasShowName && hasSeasonEpisode) {
            console.log(`[OC EXACT] Found exact match archive: "${item.fileName}"`);
            
            try {
                // Explore the archive to get video files
                console.log(`[OC EXACT] Exploring archive: ${item.requestId}`);
                const urls = await OCClient.cloud.explore(item.requestId);
                if (!urls || urls.length === 0) {
                    console.log(`[OC EXACT] No files found in archive`);
                    continue;
                }

                console.log(`[OC EXACT] Found ${urls.length} files in archive, checking details...`);

                let fileDetails = [];
                try {
                    fileDetails = await OCClient.cloud.explore(item.requestId, { details: true }) || [];
                    console.log(`[OC EXACT] Got detailed info for ${fileDetails.length} files`);
                } catch (error) {
                    console.log(`[OC EXACT] Details failed, using URLs only: ${error.message}`);
                    fileDetails = urls.map(url => ({ url, size: 0 }));
                }

                // Find the largest video file URL (but we'll use archive name/size for display)
                let largestVideoUrl = null;
                let largestVideoSize = 0;
                
                for (let i = 0; i < Math.max(fileDetails.length, urls.length); i++) {
                    const fileInfo = fileDetails[i] || {};
                    const url = fileInfo.url || urls[i];
                    if (!url) continue;

                    const fileSize = fileInfo.size || 0;
                    const fileName = decodeURIComponent(url.split('/').pop());
                    
                    console.log(`[OC EXACT] Checking file: "${fileName}" (${Math.round(fileSize / 1024 / 1024)}MB)`);

                    // Check if it's a video file
                    if (!/\.(mp4|mkv|mov|avi|flv|wmv|webm)$/i.test(fileName)) {
                        console.log(`[OC EXACT] Skipping non-video file: ${fileName}`);
                        continue;
                    }

                    // **CRITICAL FIX: For exact matches, be more lenient with size requirements**
                    // Only skip if we have a size AND it's very small (less than 10MB)
                    if (fileSize > 0 && fileSize < 10 * 1024 * 1024) {
                        console.log(`[OC EXACT] Skipping very small file: ${fileName} (${Math.round(fileSize / 1024 / 1024)}MB)`);
                        continue;
                    }

                    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes|rarbg|sample|proof|cover)\b/i.test(fileName.toLowerCase())) {
                        console.log(`[OC EXACT] Skipping sample/extra file: ${fileName}`);
                        continue;
                    }

                    // **IMPROVED: Accept video files even with 0MB size in exact matches**
                    const effectiveSize = fileSize || MIN_SIZE; // Use MIN_SIZE as fallback for 0MB files
                    
                    if (effectiveSize > largestVideoSize) {
                        largestVideoUrl = createEncodedUrl(url);
                        largestVideoSize = effectiveSize;
                        console.log(`[OC EXACT] New largest video: "${fileName}" (size: ${fileSize > 0 ? Math.round(fileSize / 1024 / 1024) + 'MB' : 'unknown'})`);
                    }
                }

                if (largestVideoUrl) {
                    // **CRITICAL: Use archive name and size, but video file URL**
                    const archiveDisplayName = item.fileName; // Use the archive name
                    const archiveSize = item.fileSize || 0; // Use actual archive size
                    
                    console.log(`[OC EXACT] SUCCESS: Returning archive "${archiveDisplayName}" with size ${Math.round(archiveSize / 1024 / 1024)}MB`);
                    console.log(`[OC EXACT] Direct URL: ${largestVideoUrl}`);
                    
                    return {
                        id: item.requestId,
                        name: archiveDisplayName, // **SHOW ARCHIVE NAME**
                        searchableName: archiveDisplayName,
                        info: PTT.parse(archiveDisplayName), // Parse archive name for metadata
                        size: archiveSize, // **SHOW ACTUAL ARCHIVE SIZE**
                        hash: getHashFromMagnet(item.originalLink),
                        url: largestVideoUrl, // But use the actual video file URL
                        // **CRITICAL: Mark as personal and add proper source info**
                        source: 'offcloud',
                        isPersonal: true,
                        tracker: 'Personal',
                        bypassFiltering: true  // **CRITICAL: Mark to bypass all downstream filtering**
                    };
                }
            } catch (error) {
                console.log(`[OC EXACT] Error exploring "${item.fileName}": ${error.message}`);
                continue;
            }
        }
    }
    
    console.log(`[OC EXACT] No exact archive matches found`);
    return null;
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources) {
    const sourceNames = ['Bitmagnet', 'Jackett', 'Torrentio', 'Zilean', 'Comet', 'StremThru', 'BT4G'];
    const enabledFlags = [BITMAGNET_ENABLED, JACKETT_ENABLED, TORRENTIO_ENABLED, ZILEAN_ENABLED, COMET_ENABLED, STREMTHRU_ENABLED, BT4G_ENABLED];
    let sourceCounts = `Personal(${personalFiles.length})`;
    let sourceIndex = 0;
    for (let i = 0; i < enabledFlags.length; i++) {
        if (enabledFlags[i]) {
            sourceCounts += `, ${sourceNames[i]}(${externalSources[sourceIndex]?.length || 0})`;
            sourceIndex++;
        }
    }
    console.log(`[OC] Sources Found: ${sourceCounts}`);

    // **CRITICAL: If we have personal files with bypass flag, return them immediately**
    const bypassPersonalFiles = personalFiles.filter(file => file.bypassFiltering === true);
    if (bypassPersonalFiles.length > 0) {
        console.log(`[OC COMBINE] Found ${bypassPersonalFiles.length} bypass personal files - returning ONLY these with NO external processing`);
        return bypassPersonalFiles.map(file => ({
            ...file,
            source: 'offcloud',
            isPersonal: true,
            tracker: 'Personal',
            bypassFiltering: true  // Preserve the bypass flag
        }));
    }

    // **CRITICAL: If we have personal files, prioritize them absolutely**
    if (personalFiles.length > 0) {
        console.log(`[OC] Personal files found - they take ABSOLUTE priority over external sources`);
        
        // Mark personal files with proper formatting
        const markedPersonal = personalFiles.map(file => {
            const alreadyMarked = file.source === 'offcloud' && file.isPersonal === true;
            if (alreadyMarked) {
                console.log(`[OC] Personal file already properly marked: ${file.name}`);
                return file;
            }
            
            return { 
                ...file, 
                source: 'offcloud', 
                isPersonal: true, 
                tracker: 'Personal' 
            };
        });

        // **ENHANCED: Check for direct OffCloud URLs with bypass flag (exact archive matches)**
        const hasDirectCloudUrl = personalFiles.some(file => 
            file.url && file.url.includes('offcloud.com/cloud/download/') && file.bypassFiltering
        );
        
        if (hasDirectCloudUrl) {
            console.log(`[OC] Found direct OffCloud URLs with bypass flag - returning ONLY personal results with NO FILTERING`);
            // **SPECIAL BYPASS: Direct cloud files skip all filtering**
            return markedPersonal.map(file => ({
                ...file,
                bypassFiltering: file.bypassFiltering || false  // Preserve the bypass flag
            }));
        }

        // **FALLBACK: Check for any direct cloud URLs**
        const hasAnyDirectCloudUrl = personalFiles.some(file => 
            file.url && file.url.includes('offcloud.com/cloud/download/')
        );
        
        if (hasAnyDirectCloudUrl) {
            console.log(`[OC] Found direct OffCloud URLs - returning ONLY personal results`);
            return markedPersonal;
        }

        // **FALLBACK: For non-direct personal files, check for exact matches**
        const hasExactMatch = personalFiles.some(file => 
            file.searchableName && file.searchableName.length > 0
        );
        
        if (hasExactMatch) {
            console.log(`[OC] Found exact matches in personal files - returning ONLY personal results`);
            return markedPersonal;
        }
    }

    // **FALLBACK: Process external sources only if no personal exact matches**
    const externalTorrents = [].concat(...externalSources);
    const uniqueExternalTorrents = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]));

    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    const markedPersonal = personalFiles.map(file => {
        if (!file.size || file.size === 0) {
            const externalMatch = uniqueExternalTorrents.get(file.hash);
            if (externalMatch && externalMatch.Size > 0) {
                file.size = externalMatch.Size;
            }
        }
        return { ...file, source: 'offcloud', isPersonal: true, tracker: 'Personal' };
    });

    const newExternalTorrents = Array.from(uniqueExternalTorrents.values())
        .filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

    // =================================================================
    // --- CACHE FILTER RE-ENABLED ---
    // =================================================================
    const hashesToCheck = newExternalTorrents.map(r => r.InfoHash);
    const cachedHashes = await checkOffcloudCache(apiKey, hashesToCheck);
    const cachedHashesSet = new Set(cachedHashes.map(h => h.toLowerCase()));

    const finalExternalResults = newExternalTorrents
        .filter(r => cachedHashesSet.has(r.InfoHash.toLowerCase()))
        .map(result => formatExternalResult(result));

    return [...markedPersonal, ...finalExternalResults];
}

function formatExternalResult(result) {
    return {
        name: result.Title, info: PTT.parse(result.Title) || { title: result.Title },
        size: result.Size, seeders: result.Seeders,
        url: `magnet:?xt=urn:btih:${result.InfoHash}`,
        source: 'offcloud', hash: result.InfoHash.toLowerCase(),
        tracker: result.Tracker, isPersonal: false
    };
}

function cleanFileName(filename) {
    return filename
        .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm)$/i, '')
        .replace(/[\.\-_]/g, ' ')
        .replace(/\b(1080p|720p|480p|2160p|4k)\b/gi, '')
        .replace(/\b(bluray|webrip|hdtv|dvdrip|brrip|x264|x265|h264|h265|dts|ac3|aac|ma|hd)\b/gi, '')
        .replace(/\b(yify|rarbg|ettv|nogrp)\b/gi, '')
        .replace(/\b\d{4}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanSearchKey(searchKey) {
    return searchKey
        .replace(/\b(the|and|of|in|on|at|to|for|with|by)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractCoreTitle(title) {
    const words = title.split(' ').filter(word =>
        word.length > 2 &&
        !/\b(the|and|of|in|on|at|to|for|with|by)\b/i.test(word)
    );
    return words.slice(0, 3).join(' ');
}

function getKeywords(str) {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'for', 'with']);
    const normalized = str.toLowerCase()
        .replace(/[._-]/g, ' ')
        .replace(/[':()[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized.split(' ').filter(word => {
        return word.length > 1 &&
               !stopWords.has(word) &&
               !/^(1080p|720p|480p|2160p)$/.test(word) &&
               !/^(bluray|webrip|hdtv|dvdrip)$/.test(word);
    }).filter(Boolean);
}

// SCRAPERS
async function searchBitmagnet(query, signal) {
    console.time('[OC TIMER] Bitmagnet');
    try {
        const url = `${BITMAGNET_URL}?t=search&q=${encodeURIComponent(query)}&limit=${TORZNAB_LIMIT}`;
        const response = await axios.get(url, { timeout: SCRAPER_TIMEOUT, signal });
        const parsedXml = await parseStringPromise(response.data);
        const items = parsedXml.rss.channel[0].item || [];
        console.timeEnd('[OC TIMER] Bitmagnet');
        return items.map(item => {
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
                Title: item.title[0], InfoHash: infoHash,
                Size: size, Seeders: item.seeders ? parseInt(item.seeders[0]) : null,
                Tracker: 'Bitmagnet'
            };
        }).filter(Boolean);
    } catch (error) {
        console.timeEnd('[OC TIMER] Bitmagnet');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] Bitmagnet search failed: ${error.message}`);
        return [];
    }
}

async function searchJackett(query, signal) {
    console.time('[OC TIMER] Jackett');
    try {
        const response = await axios.get(`${JACKETT_URL}/api/v2.0/indexers/all/results`, {
            params: { apikey: JACKETT_API_KEY, Query: query },
            timeout: SCRAPER_TIMEOUT, signal
        });
        console.timeEnd('[OC TIMER] Jackett');
        return (response.data.Results || []).map(r => ({
            Title: r.Title, InfoHash: r.InfoHash, Size: r.Size, Seeders: r.Seeders,
            Tracker: `Jackett | ${r.Tracker}`
        }));
    } catch (error) {
        console.timeEnd('[OC TIMER] Jackett');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] Jackett search failed: ${error.message}`);
        return [];
    }
}

async function searchTorrentio(mediaType, mediaId, signal) {
    console.time('[OC TIMER] Torrentio');
    try {
        const response = await axios.get(`${TORRENTIO_URL}/stream/${mediaType}/${mediaId}.json`, { timeout: SCRAPER_TIMEOUT, signal });
        console.timeEnd('[OC TIMER] Torrentio');
        const dataPattern = /(?:👤 (\d+) )?💾 ([\d.]+ [KMGT]B)(?: ⚙️ (\w+))?/;
        return response.data.streams.map(stream => {
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
        console.timeEnd('[OC TIMER] Torrentio');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] Torrentio search failed: ${error.message}`);
        return [];
    }
}

async function searchZilean(title, season, episode, signal) {
    console.time('[OC TIMER] Zilean');
    try {
        let url = `${ZILEAN_URL}/dmm/filtered?query=${encodeURIComponent(title)}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;
        const response = await axios.get(url, { timeout: SCRAPER_TIMEOUT, signal });
        console.timeEnd('[OC TIMER] Zilean');
        return (response.data || []).map(result => ({
            Title: result.raw_title, InfoHash: result.info_hash,
            Size: parseInt(result.size), Seeders: null, Tracker: 'Zilean | DMM'
        }));
    } catch (error) {
        console.timeEnd('[OC TIMER] Zilean');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] Zilean search failed: ${error.message}`);
        return [];
    }
}

async function searchComet(mediaType, mediaId, signal, season, episode) {
    let finalMediaId = mediaId;

    if (mediaType === 'series' && season && episode) {
        finalMediaId = `${mediaId}:${season}:${episode}`;
    }

    console.log(`[OC DEBUG] Comet: Searching for mediaType='${mediaType}', finalMediaId='${finalMediaId}'`);

    const requestUrl = `${COMET_URL}/stream/${mediaType}/${finalMediaId}.json`;
    console.log(`[OC DEBUG] Comet: Requesting URL -> ${requestUrl}`);

    console.time('[OC TIMER] Comet');

    try {
        const response = await axios.get(requestUrl, { 
            timeout: SCRAPER_TIMEOUT, 
            signal 
        });
        
        console.timeEnd('[OC TIMER] Comet');
        
        return (response.data.streams || []).map(stream => {
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
        console.timeEnd('[OC TIMER] Comet');
        if (axios.isCancel(error)) {
            return [];
        }

        console.error(`[OC SCRAPER] Comet search failed. Status: ${error.response?.status}`);
        if (error.response?.data) {
            console.error('[OC SCRAPER] Comet Response Body:', error.response.data);
        } else {
            console.error(`[OC SCRAPER] Comet Error: ${error.message}`);
        }
        
        return [];
    }
}

async function searchStremthru(query, signal) {
    console.time('[OC TIMER] StremThru');
    try {
        const url = `${STREMTHRU_URL}/v0/torznab/api?t=search&q=${encodeURIComponent(query)}`;
        const response = await axios.get(url, { timeout: SCRAPER_TIMEOUT, signal });
        const parsedXml = await parseStringPromise(response.data);
        const items = parsedXml.rss.channel[0].item || [];
        console.timeEnd('[OC TIMER] StremThru');
        return items.map(item => {
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
                Title: item.title[0], InfoHash: infoHash,
                Size: size, Seeders: item.seeders ? parseInt(item.seeders[0]) : null,
                Tracker: 'StremThru'
            };
        }).filter(Boolean);
    } catch (error) {
        console.timeEnd('[OC TIMER] StremThru');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] StremThru search failed: ${error.message}`);
        return [];
    }
}

async function searchBt4g(query, signal) {
    console.time('[OC TIMER] BT4G');
    try {
        const searchUrl = `${BT4G_URL}/search?q=${encodeURIComponent(query)}`;
        const searchResponse = await axios.get(searchUrl, { timeout: SCRAPER_TIMEOUT, signal });
        const $ = cheerio.load(searchResponse.data);
        const detailPagePromises = [];

        $('div.result-item').each((i, element) => {
            const detailPageLink = $(element).find('h5 > a').attr('href');
            if (detailPageLink) {
                const detailPageUrl = `${BT4G_URL}${detailPageLink}`;
                detailPagePromises.push(axios.get(detailPageUrl, { timeout: SCRAPER_TIMEOUT, signal }).catch(() => null));
            }
        });

        const detailPageResponses = await Promise.all(detailPagePromises);
        const results = [];

        for (const response of detailPageResponses) {
            if (!response || !response.data) continue;
            try {
                const $$ = cheerio.load(response.data);
                const title = $$('h1.title').text().trim();
                const magnetLink = $$('a.btn-info').attr('href');
                const infoHash = getHashFromMagnet(magnetLink);
                if (!infoHash) continue;

                const sizeText = $$('#total-size').text().trim();
                const seeders = parseInt($$('#seeders').text().trim()) || 0;

                results.push({
                    Title: title,
                    InfoHash: infoHash,
                    Size: sizeToBytes(sizeText),
                    Seeders: seeders,
                    Tracker: 'BT4G'
                });
            } catch (e) {
                // Ignore errors from parsing a single detail page
            }
        }
        console.timeEnd('[OC TIMER] BT4G');
        return results;

    } catch (error) {
        console.timeEnd('[OC TIMER] BT4G');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] BT4G search failed: ${error.message}`);
        return [];
    }
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
    const [value, unit] = sizeStr.split(' ');
    const val = parseFloat(value);
    switch (unit?.toUpperCase()) {
        case 'GB': return val * 1024 * 1024 * 1024;
        case 'MB': return val * 1024 * 1024;
        case 'KB': return val * 1024;
        default: return val;
    }
}

async function checkOffcloudCache(apiKey, hashes) {
    if (!hashes || hashes.length === 0) return [];
    
    const lowerCaseHashes = hashes.map(h => h.toLowerCase());
    const url = `${OFFCLOUD_API_URL}/cache?key=${apiKey}`;
    
    try {
        const response = await axios.post(url, { hashes: lowerCaseHashes });
        return response.data.cachedItems || [];
    } catch (error) {
        // --- THIS IS THE NEW, IMPROVED ERROR HANDLING ---
        console.error(`[OC] !! FATAL: OffCloud cache check failed. All external results will be hidden.`);
        if (error.response) {
            // This logs errors returned by the OffCloud API (e.g., bad key, server issue)
            console.error(`[OC] Cache Check Error: Status ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            // This logs network-level errors (e.g., no connection)
            console.error(`[OC] Cache Check Error: ${error.message}`);
        }
        return []; // Still return an empty array so the addon doesn't crash
    }
}

// ===================================================================================
// --- 3. STREAM RESOLVER LOGIC ---
// ===================================================================================
async function resolveStream(apiKey, urlToResolve, type, id) {
    const isMagnet = urlToResolve.startsWith('magnet:');
    if (!isMagnet) return urlToResolve;

    const hash = getHashFromMagnet(urlToResolve);
    if (!hash) return null;

    const OCClient = new OC(apiKey);

    let cinemetaDetails = null;
    let searchKey = '';

    if (id) {
        console.log(`[OC RESOLVER] Media ID ${id} found. Fetching metadata.`);
        const idParts = id.split(':');
        const imdbId = idParts[0];
        cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

        if (cinemetaDetails) {
            if (type === 'series' && idParts.length === 3) {
                const season = idParts[1].toString().padStart(2, '0');
                const episode = idParts[2].toString().padStart(2, '0');
                searchKey = `${cinemetaDetails.name} s${season}e${episode}`;
            } else {
                searchKey = cinemetaDetails.name;
            }
        }
    } else {
        console.log('[OC RESOLVER] No media ID provided. Metadata search skipped.');
    }

    // **ALWAYS TRY EXISTING FILES FIRST**
    console.log(`[OC RESOLVER] Checking for existing files in cloud history...`);
    const history = await OCClient.cloud.history();
    
    if (searchKey) {
        const relevantHistory = filterHistoryByKeywords(history, searchKey);
        const torrents = await processTorrents(OCClient, relevantHistory);
        const existingFile = torrents.find(file => file.hash === hash);

        if (existingFile) {
            console.log(`[OC RESOLVER] Found existing file in cloud. Returning direct link.`);
            return existingFile.url;
        }

        // **NEW: Try fallback with searchKey**
        const exactMatchResult = await findLargestVideoInArchive(OCClient, searchKey, relevantHistory);
        if (exactMatchResult) {
            console.log(`[OC RESOLVER] FALLBACK SUCCESS: Found large video file via searchKey: "${exactMatchResult.name}"`);
            return exactMatchResult.url;
        }
    }

    // **ENHANCED: Always try to find any large video file even without searchKey**
    console.log(`[OC RESOLVER] No specific matches found. Trying to find any large video file with matching hash...`);
    const hashMatchResult = await findLargestVideoByHash(OCClient, hash, history);
    if (hashMatchResult) {
        console.log(`[OC RESOLVER] HASH FALLBACK SUCCESS: Found large video file with matching hash: "${hashMatchResult.name}"`);
        return hashMatchResult.url;
    }

    const addedItem = await addToOffcloud(apiKey, urlToResolve);
    if (!addedItem || !addedItem.requestId) return null;

    const newItemInHistory = await waitForItemInHistory(OCClient, addedItem.requestId);

    if (newItemInHistory) {
        console.log(`[OC RESOLVER] Found new item. Processing it to find video file...`);
        const processedFiles = await processTorrents(OCClient, [newItemInHistory]);

        if (processedFiles.length > 0) {
            // **ALWAYS RETURN LARGEST FILE OVER 350MB**
            const largeFiles = processedFiles.filter(file => file.size && file.size > 350 * 1024 * 1024);
            
            if (largeFiles.length > 0) {
                largeFiles.sort((a, b) => b.size - a.size);
                console.log(`[OC RESOLVER] SUCCESS: Returning largest video file "${largeFiles[0].name}" (${Math.round(largeFiles[0].size / 1024 / 1024)}MB)`);
                return largeFiles[0].url;
            }

            if (searchKey) {
                const fuse = new Fuse(processedFiles, { keys: ['name', 'info.title'], threshold: 0.4 });
                const searchResults = fuse.search(searchKey);

                if (searchResults.length > 0) {
                    console.log(`[OC RESOLVER] SUCCESS: Matched video file "${searchResults[0].item.name}".`);
                    return searchResults[0].item.url;
                }
            }
            
            console.log(`[OC RESOLVER] WARNING: No large files found, falling back to first video file.`);
            return processedFiles[0].url;
        }
    }

    console.error(`[OC RESOLVER] FAILED: Could not find the processed file for requestId ${addedItem.requestId} after adding.`);
    return null;
}

// **NEW: Find largest video file in archive by name matching**
async function findLargestVideoInArchive(OCClient, searchKey, relevantHistory) {
    const MIN_FALLBACK_SIZE = 350 * 1024 * 1024; // 350MB in bytes
    
    console.log(`[OC FALLBACK] Searching for large videos in archives matching: "${searchKey}"`);
    
    // Create fuzzy search for archive name matching
    const fuse = new Fuse(relevantHistory, {
        keys: ['fileName'],
        threshold: 0.4, // Allow broader matches
        includeScore: true
    });
    
    const archiveMatches = fuse.search(searchKey);
    
    if (archiveMatches.length === 0) {
        console.log(`[OC FALLBACK] No matching archives found.`);
        return null;
    }
    
    console.log(`[OC FALLBACK] Found ${archiveMatches.length} matching archives. Checking for large video files...`);
    
    let allLargeVideos = [];
    
    // Check each matching archive for large video files
    for (const match of archiveMatches) {
        const historyItem = match.item;
        console.log(`[OC FALLBACK] Checking archive: "${historyItem.fileName}" (score: ${match.score})`);
        
        try {
            const videoFiles = await processHistoryEntry(OCClient, historyItem);
            
            if (!videoFiles || videoFiles.length === 0) {
                console.log(`[OC FALLBACK] No video files found in "${historyItem.fileName}"`);
                continue;
            }
            
            const filesArray = Array.isArray(videoFiles) ? videoFiles : [videoFiles];
            const largeFiles = filesArray.filter(file => 
                file && file.size && file.size > MIN_FALLBACK_SIZE
            );
            
            allLargeVideos.push(...largeFiles);
            
            if (largeFiles.length > 0) {
                console.log(`[OC FALLBACK] Found ${largeFiles.length} large video files in "${historyItem.fileName}"`);
            }
            
        } catch (error) {
            console.log(`[OC FALLBACK] Error processing "${historyItem.fileName}": ${error.message}`);
            continue;
        }
    }
    
    if (allLargeVideos.length > 0) {
        // Sort by size (largest first) and return the largest
        allLargeVideos.sort((a, b) => b.size - a.size);
        const selectedFile = allLargeVideos[0];
        console.log(`[OC FALLBACK] Selected largest video: "${selectedFile.name}" (${Math.round(selectedFile.size / 1024 / 1024)}MB)`);
        return selectedFile;
    }
    
    console.log(`[OC FALLBACK] No large video files found in any matching archives.`);
    return null;
}

// **NEW: Find largest video file by exact hash match**
async function findLargestVideoByHash(OCClient, targetHash, history) {
    const MIN_FALLBACK_SIZE = 350 * 1024 * 1024; // 350MB in bytes
    
    console.log(`[OC HASH FALLBACK] Looking for archives with hash: ${targetHash}`);
    
    // Find archives that match the hash
    const matchingArchives = history.filter(item => {
        const itemHash = getHashFromMagnet(item.originalLink);
        return itemHash && itemHash.toLowerCase() === targetHash.toLowerCase();
    });
    
    if (matchingArchives.length === 0) {
        console.log(`[OC HASH FALLBACK] No archives found with matching hash.`);
        return null;
    }
    
    console.log(`[OC HASH FALLBACK] Found ${matchingArchives.length} archives with matching hash.`);
    
    let allLargeVideos = [];
    
    for (const archive of matchingArchives) {
        console.log(`[OC HASH FALLBACK] Processing archive: "${archive.fileName}"`);
        
        try {
            const videoFiles = await processHistoryEntry(OCClient, archive);
            
            if (videoFiles && videoFiles.length > 0) {
                const filesArray = Array.isArray(videoFiles) ? videoFiles : [videoFiles];
                const largeFiles = filesArray.filter(file => 
                    file && file.size && file.size > MIN_FALLBACK_SIZE
                );
                
                allLargeVideos.push(...largeFiles);
                
                if (largeFiles.length > 0) {
                    console.log(`[OC HASH FALLBACK] Found ${largeFiles.length} large files in "${archive.fileName}"`);
                }
            }
        } catch (error) {
            console.log(`[OC HASH FALLBACK] Error processing "${archive.fileName}": ${error.message}`);
        }
    }
    
    if (allLargeVideos.length > 0) {
        // Sort by size (largest first) and return the largest
        allLargeVideos.sort((a, b) => b.size - a.size);
        const selectedFile = allLargeVideos[0];
        console.log(`[OC HASH FALLBACK] Selected largest video: "${selectedFile.name}" (${Math.round(selectedFile.size / 1024 / 1024)}MB)`);
        return selectedFile;
    }
    
    console.log(`[OC HASH FALLBACK] No large video files found.`);
    return null;
}

async function addToOffcloud(apiKey, magnetLink) {
    const url = `${OFFCLOUD_API_URL}/cloud?key=${apiKey}`;
    try {
        return (await axios.post(url, { url: magnetLink })).data;
    } catch (error) { return null; }
}

// ===================================================================================
// --- 4. HELPER FUNCTIONS ---
// ===================================================================================
async function waitForItemInHistory(OCClient, requestId, timeout = 30000, interval = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        console.log(`[OC RESOLVER] Polling history for requestId ${requestId}...`);
        const history = await OCClient.cloud.history();
        const newItem = history.find(item => item.requestId === requestId);

        if (newItem && newItem.fileName) {
            console.log(`[OC RESOLVER] Found processed item with name: "${newItem.fileName}"`);
            return newItem;
        }
        await delay(interval);
    }
    console.error(`[OC RESOLVER] Timeout: Could not find processed item for ${requestId} after ${timeout / 1000}s.`);
    return null;
}

async function processTorrents(client, history) {
    const BATCH_SIZE = 20;
    const allTorrents = [];
    for (let i = 0; i < history.length; i += BATCH_SIZE) {
        const batch = history.slice(i, i + BATCH_SIZE);
        const promises = batch.map(item => processHistoryEntry(client, item));
        const results = await Promise.all(promises);
        allTorrents.push(...results);
    }
    return allTorrents.flat().filter(Boolean);
}

async function processHistoryEntry(client, item) {
    const isLikelySingleVideo = /\.(mp4|mkv|mov|avi|flv|wmv|webm)$/i.test(item.fileName);
    if (isLikelySingleVideo) {
        console.log(`[OC EXPLORE] ==> Filename has video extension. Assuming single file: ${item.fileName}`);
        if (isValidVideo(item.fileName, item.fileSize)) {
            return {
                id: item.requestId,
                name: item.fileName,
                searchableName: item.fileName,
                info: PTT.parse(item.fileName),
                size: item.fileSize,
                hash: getHashFromMagnet(item.originalLink),
                url: createEncodedUrl(`https://${item.server}.offcloud.com/cloud/download/${item.requestId}/${item.fileName}`)
            };
        }
        return null;
    }
    try {
        console.log(`[OC EXPLORE] ==> Exploring item: ${item.requestId} (${item.fileName})`);
        const urls = await client.cloud.explore(item.requestId);
        console.log(`[OC EXPLORE] <== Found ${urls.length} files inside for ${item.requestId}.`);
        if (!Array.isArray(urls) || urls.length === 0) return null;
        const hash = getHashFromMagnet(item.originalLink);

        let fileDetails = [];
        try {
            fileDetails = await client.cloud.explore(item.requestId, { details: true }) || [];
        } catch (error) {
            fileDetails = urls.map(url => ({ url, size: 0 }));
        }

        return fileDetails.map((fileInfo, index) => {
            const url = fileInfo.url || urls[index];
            const fileSize = fileInfo.size || 0;
            const fileName = decodeURIComponent(url.split('/').pop());

            if (!isValidVideo(fileName, fileSize)) return null;

            return {
                id: item.requestId,
                name: fileName,
                searchableName: `${item.fileName} ${fileName}`,
                info: PTT.parse(fileName),
                size: fileSize || item.fileSize,
                hash: hash,
                url: createEncodedUrl(url)
            };
        }).filter(Boolean);
    } catch (error) {
        console.log(`[OC EXPLORE] <== Explore failed for ${item.requestId}. Treating as single file.`);
        if (isValidVideo(item.fileName, item.fileSize)) {
            return {
                id: item.requestId,
                name: item.fileName,
                searchableName: item.fileName,
                info: PTT.parse(item.fileName),
                size: item.fileSize,
                hash: getHashFromMagnet(item.originalLink),
                url: createEncodedUrl(`https://${item.server}.offcloud.com/cloud/download/${item.requestId}/${item.fileName}`)
            };
        }
        return null;
    }
}

function isValidVideo(fileName, fileSize = 0, minSize = 50 * 1024 * 1024) {
    if (!fileName) return false;
    const decodedName = decodeURIComponent(fileName).toLowerCase();
    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes)\b/i.test(decodedName)) {
        return false;
    }
    const nameWithoutExtension = decodedName.replace(/\.(mp4|mkv|mov|avi|flv|wmv|webm)$/i, '');
    const isJustGroupName = /^(etrg|yify|rarbg|ettv|nogrp|axxo|sparks|dimension|lol|asap|killers|evolve)$/i.test(nameWithoutExtension);
    if (isJustGroupName) {
        console.log(`[OC] Filtering out group sample file: ${fileName}`);
        return false;
    }
    if (fileSize && fileSize < minSize) {
        console.log(`[OC] Filtering out small file (${Math.round(fileSize / 1024 / 1024)}MB): ${fileName}`);
        return false;
    }
    if (/\b(rarbg|sample|proof|cover)\b/i.test(decodedName)) {
        return false;
    }
    if (!/\.(mp4|mkv|mov|avi|flv|wmv|webm)$/i.test(decodedName)) {
        return false;
    }
    return true;
}

function getHashFromMagnet(magnetLink) {
    if (!magnetLink || !magnetLink.includes('btih:')) return null;
    try {
        const match = magnetLink.match(/btih:([a-zA-Z0-9]{40})/i);
        return match ? match[1].toLowerCase() : null;
    } catch { return null; }
}

function createEncodedUrl(url) {
    try {
        const urlObject = new URL(url);
        const pathParts = urlObject.pathname.split('/');
        const lastSegment = pathParts.pop();
        pathParts.push(encodeURIComponent(lastSegment));
        urlObject.pathname = pathParts.join('/');
        return urlObject.toString();
    } catch { return url; }
}

function filterYear(torrent, cinemetaDetails) {
    if (torrent?.info?.year && cinemetaDetails?.year) {
        return torrent.info.year == cinemetaDetails.year;
    } else if (cinemetaDetails?.year) {
        const yearStr = cinemetaDetails.year.toString();
        // Check both the file name AND the searchable name (which includes archive name)
        return torrent.name.includes(yearStr) || 
               (torrent.searchableName && torrent.searchableName.includes(yearStr));
    }
    return true;
}

function filterHistoryByKeywords(history, searchKey) {
    const searchKeywords = getKeywords(searchKey);
    if (searchKeywords.length === 0) return [];
    const requiredMatches = searchKeywords.length <= 2
        ? searchKeywords.length
        : Math.max(2, Math.ceil(searchKeywords.length * 0.5));

    return history.filter(item => {
        if (!item.fileName) return false;
        const itemNameLower = item.fileName.toLowerCase().replace(/[._-]/g, ' ');
        const actualMatches = searchKeywords.reduce((count, keyword) => {
            return itemNameLower.includes(keyword) ? count + 1 : count;
        }, 0);
        return actualMatches >= requiredMatches;
    });
}

export default { searchOffcloudTorrents, resolveStream };
