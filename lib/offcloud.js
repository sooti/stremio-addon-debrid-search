import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import OC from 'offcloud-api';
import { parseStringPromise } from 'xml2js';

// ===================================================================================
// --- CONFIGURATION (loaded from .env file) ---
// ===================================================================================
const JACKETT_URL = process.env.JACKETT_URL || 'http://YOUR_JACKETT_IP:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || '';
const TORRENTIO_URL = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
const ZILEAN_URL = process.env.ZILEAN_URL || 'https://zilean.elfhosted.com';
const COMET_URL = process.env.COMET_URL || 'https://comet.elfhosted.com';
const STREMTHRU_URL = process.env.STREMTHRU_URL || 'https://stremthru.elfhosted.com';
const AIOSTREAMS_URL = process.env.AIOSTREAMS_URL || 'https://aiostreams.am';
const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT) || 5000;

// --- Scraper Enable/Disable Flags ---
const JACKETT_ENABLED = process.env.JACKETT_ENABLED === 'true';
const TORRENTIO_ENABLED = process.env.TORRENTIO_ENABLED === 'true';
const ZILEAN_ENABLED = process.env.ZILEAN_ENABLED === 'true';
const COMET_ENABLED = process.env.COMET_ENABLED === 'true';
const STREMTHRU_ENABLED = process.env.STREMTHRU_ENABLED === 'true';
const AIOSTREAMS_ENABLED = process.env.AIOSTREAMS_ENABLED === 'true';
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
        : searchKey;

    console.log(`[OC] Starting unified search for: "${specificSearchKey}" (and ${alternateTitles.length} alternate titles)`);

    const abortController = new AbortController();
    const signal = abortController.signal;

    const scraperPromises = [];
    if (JACKETT_ENABLED) scraperPromises.push(searchJackett(specificSearchKey, signal));
    if (TORRENTIO_ENABLED) scraperPromises.push(searchTorrentio(type, imdbId, signal));
    if (ZILEAN_ENABLED) scraperPromises.push(searchZilean(specificSearchKey, season, episode, signal));
    if (COMET_ENABLED) scraperPromises.push(searchComet(type, imdbId, signal));
    if (STREMTHRU_ENABLED) scraperPromises.push(searchStremthru(type, imdbId, signal));
    if (AIOSTREAMS_ENABLED) scraperPromises.push(searchAioStreams(type, imdbId, signal));

    try {
        console.time('[OC] Total search time');
        const [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, allSearchKeys),
            ...scraperPromises
        ]);
        console.timeEnd('[OC] Total search time');

        let combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults);

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
        const personalFiles = await searchPersonalFiles(apiKey, allSearchKeys);
        return combineAndMarkResults(apiKey, personalFiles, completedResults);
    }
}

// ===================================================================================
// --- 2. SEARCH & COMBINE LOGIC ---
// ===================================================================================
async function searchPersonalFiles(apiKey, searchKeys) {
    console.time('[OC TIMER] Personal Cloud');
    const OCClient = new OC(apiKey);
    try {
        const keys = Array.isArray(searchKeys) ? searchKeys : [searchKeys];
        const primaryKey = keys[0];

        const history = await OCClient.cloud.history();
        
        const relevantHistory = filterHistoryByKeywords(history, primaryKey);

        console.log(`[OC] Pre-filtered personal history from ${history.length} to ${relevantHistory.length} relevant items.`);

        const torrents = await processTorrents(OCClient, relevantHistory);
        console.log(`[OC] Expanded personal cloud to ${torrents.length} video files.`);
        
        if (torrents.length === 0) {
            console.log(`[OC] No video files found after processing relevant history.`);
            console.timeEnd('[OC TIMER] Personal Cloud');
            return [];
        }

        // Pre-process torrents to add cleaned names for better matching
        const enhancedTorrents = torrents.map(torrent => ({
            ...torrent,
            cleanedName: cleanFileName(torrent.name)
        }));

        // Enhanced fuzzy search with better configuration
        const fuse = new Fuse(enhancedTorrents, {
            keys: [
                { name: 'searchableName', weight: 0.4 },
                { name: 'name', weight: 0.3 },
                { name: 'info.title', weight: 0.2 },
                { name: 'cleanedName', weight: 0.1 }
            ],
            threshold: 0.6,        // More permissive threshold
            minMatchCharLength: 2, // Allow shorter matches
            ignoreLocation: true,
            includeScore: true,    // Include scores for debugging
        });

        let allResults = [];
        for (const key of keys) {
            console.log(`[OC] Searching for: "${key}"`);
            
            // Try multiple search strategies
            const strategies = [
                key,                           // Original search
                cleanSearchKey(key),          // Cleaned version
                extractCoreTitle(key),        // Just the core title
                key.replace(/\s+and\s+/gi, ' ') // Remove "and" which might cause issues
            ];

            for (const searchTerm of strategies) {
                if (!searchTerm || searchTerm.length < 3) continue;
                
                const results = fuse.search(searchTerm);
                console.log(`[OC] Strategy "${searchTerm}": found ${results.length} matches`);
                
                if (results.length > 0) {
                    // Log the best match for debugging
                    console.log(`[OC] Best match: "${results[0].item.name}" (score: ${results[0].score})`);
                }
                
                allResults.push(...results);
                
                // If we found good matches (score < 0.3), stop trying other strategies
                if (results.some(r => r.score < 0.3)) break;
            }
        }
        
        // Remove duplicates and sort by score
        const uniqueResults = [...new Map(allResults.map(result => [result.item.url, result])).values()]
            .sort((a, b) => a.score - b.score);

        console.log(`[OC] Found ${uniqueResults.length} personal files after fuzzy search.`);
        console.timeEnd('[OC TIMER] Personal Cloud');
        return uniqueResults.map((result) => result.item);
    } catch (error) {
        console.timeEnd('[OC TIMER] Personal Cloud');
        console.error(`[OC] Personal files search error: ${error.message}`);
        return [];
    }
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources) {
    const sourceNames = ['Jackett', 'Torrentio', 'Zilean', 'Comet', 'StremThru', 'AIOStreams'];
    const enabledFlags = [JACKETT_ENABLED, TORRENTIO_ENABLED, ZILEAN_ENABLED, COMET_ENABLED, STREMTHRU_ENABLED, AIOSTREAMS_ENABLED];
    let sourceCounts = `Personal(${personalFiles.length})`;
    let sourceIndex = 0;
    for (let i = 0; i < enabledFlags.length; i++) {
        if (enabledFlags[i]) {
            sourceCounts += `, ${sourceNames[i]}(${externalSources[sourceIndex]?.length || 0})`;
            sourceIndex++;
        }
    }
    console.log(`[OC] Sources Found: ${sourceCounts}`);
    
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

// Helper function to clean filenames for better matching
function cleanFileName(filename) {
    return filename
        .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm)$/i, '') // Remove extensions
        .replace(/[\.\-_]/g, ' ')                           // Replace separators with spaces
        .replace(/\b(1080p|720p|480p|2160p|4k)\b/gi, '')   // Remove quality markers
        .replace(/\b(bluray|webrip|hdtv|dvdrip|brrip|x264|x265|h264|h265|dts|ac3|aac|ma|hd)\b/gi, '') // Remove codec/source info
        .replace(/\b(yify|rarbg|ettv|nogrp)\b/gi, '')       // Remove group names (removed etrg from blacklist)
        .replace(/\b\d{4}\b/g, '')                          // Remove years for now
        .replace(/\s+/g, ' ')                               // Collapse spaces
        .trim();
}

// Helper function to clean search keys
function cleanSearchKey(searchKey) {
    return searchKey
        .replace(/\b(the|and|of|in|on|at|to|for|with|by)\b/gi, ' ') // Remove common words
        .replace(/\s+/g, ' ')
        .trim();
}

// Helper function to extract core title (first few words)
function extractCoreTitle(title) {
    const words = title.split(' ').filter(word => 
        word.length > 2 && 
        !/\b(the|and|of|in|on|at|to|for|with|by)\b/i.test(word)
    );
    return words.slice(0, 3).join(' '); // Take first 3 significant words
}

function getKeywords(str) {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'for', 'with']);
    
    // More consistent normalization
    const normalized = str.toLowerCase()
        .replace(/[._-]/g, ' ')     // Convert separators to spaces  
        .replace(/[':()[\]]/g, '')  // Remove brackets and punctuation
        .replace(/\s+/g, ' ')       // Collapse multiple spaces
        .trim();
    
    return normalized.split(' ').filter(word => {
        return word.length > 1 &&  // Allow shorter words
               !stopWords.has(word) &&
               !/^(1080p|720p|480p|2160p)$/.test(word) &&  // Remove common quality markers
               !/^(bluray|webrip|hdtv|dvdrip)$/.test(word); // Remove source markers
    }).filter(Boolean);
}

// SCRAPERS (Functions searchJackett, searchTorrentio, etc. remain unchanged)
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
async function searchComet(mediaType, mediaId, signal) {
    console.time('[OC TIMER] Comet');
    try {
        const response = await axios.get(`${COMET_URL}/stream/${mediaType}/${mediaId}.json`, { timeout: SCRAPER_TIMEOUT, signal });
        console.timeEnd('[OC TIMER] Comet');
        return (response.data.streams || []).map(stream => {
            const desc = stream.description;
            const titleMatch = desc.match(/📄 (.+)/);
            const title = titleMatch ? titleMatch[1] : 'Unknown Title';
            const seedersMatch = desc.match(/👤 (\d+)/);
            const trackerMatch = desc.match(/🔎 (.+)/);
            return {
                Title: title, InfoHash: stream.infoHash,
                Size: stream.behaviorHints?.videoSize || 0,
                Seeders: seedersMatch ? parseInt(seedersMatch[1]) : null,
                Tracker: `Comet | ${trackerMatch ? trackerMatch[1] : 'Public'}`
            };
        });
    } catch (error) {
        console.timeEnd('[OC TIMER] Comet');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] Comet search failed: ${error.message}`);
        return [];
    }
}
async function searchStremthru(mediaType, mediaId, signal) {
    console.time('[OC TIMER] StremThru');
    try {
        const url = `${STREMTHRU_URL}/v0/torznab/api?t=search&imdbid=${mediaId}`;
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
async function searchAioStreams(mediaType, mediaId, signal) {
    console.time('[OC TIMER] AIOStreams');
    try {
        const url = `${AIOSTREAMS_URL}/stream/${mediaType}/${mediaId}.json`;
        const response = await axios.get(url, { timeout: SCRAPER_TIMEOUT, signal });
        console.log(`[OC SCRAPER] AIOStreams request successful. Found ${(response.data.streams || []).length} raw streams.`);
        console.timeEnd('[OC TIMER] AIOStreams');
        return (response.data.streams || []).map(torrent => {
            const { streamData } = torrent;
            if (!streamData || streamData.error || !streamData.torrent?.infoHash) return null;
            let tracker = "AIOStreams";
            if (streamData.indexer) tracker += `|${streamData.indexer}`;
            return {
                Title: streamData.filename, InfoHash: streamData.torrent.infoHash,
                Size: streamData.size, Seeders: streamData.torrent.seeders, Tracker: tracker,
            };
        }).filter(Boolean);
    } catch (error) {
        console.timeEnd('[OC TIMER] AIOStreams');
        if (!axios.isCancel(error)) console.error(`[OC SCRAPER] AIOStreams search failed: ${error.message}`);
        return [];
    }
}


function sizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const [value, unit] = sizeStr.split(' ');
    const val = parseFloat(value);
    switch (unit.toUpperCase()) {
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
    } catch (error) { return []; }
}
// ===================================================================================
// --- 3. STREAM RESOLVER LOGIC (Unchanged) ---
// ===================================================================================
async function resolveStream(apiKey, urlToResolve, type, id) {
    const isMagnet = urlToResolve.startsWith('magnet:');
    if (!isMagnet) return urlToResolve;

    const hash = getHashFromMagnet(urlToResolve);
    if (!hash) return null;
    
    const OCClient = new OC(apiKey);

    let cinemetaDetails = null;
    let searchKey = '';

    // Step 1: Safely populate metadata ONLY if a valid ID is provided.
    if (id) {
        console.log(`[OC RESOLVER] Media ID ${id} found. Fetching metadata.`);
        const idParts = id.split(':');
        const imdbId = idParts[0];
        cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        
        if (cinemetaDetails) {
            // Construct a specific search key for series only if season/episode are present
            if (type === 'series' && idParts.length === 3) {
                searchKey = `${cinemetaDetails.name} s${idParts[1]}e${idParts[2]}`;
            } else {
                searchKey = cinemetaDetails.name;
            }
        }
    } else {
        console.log('[OC RESOLVER] No media ID provided. Metadata search skipped.');
    }

    // Step 2: Use metadata (if available) for an EFFICIENT check of existing files.
    if (searchKey) {
        console.log(`[OC RESOLVER] Checking for existing file in cloud history using searchKey: "${searchKey}"`);
        const history = await OCClient.cloud.history();
        const relevantHistory = filterHistoryByKeywords(history, searchKey);
        const torrents = await processTorrents(OCClient, relevantHistory);
        const existingFile = torrents.find(file => file.hash === hash);

        if (existingFile) {
            console.log(`[OC RESOLVER] Found existing file in cloud. Returning direct link.`);
            return existingFile.url;
        }
    }

    // Step 3: If not found, add the torrent to the cloud.
    const addedItem = await addToOffcloud(apiKey, urlToResolve);
    if (!addedItem || !addedItem.requestId) return null;

    console.log(`[OC RESOLVER] Wait finished. Finding new item in history...`);
    const newHistory = await OCClient.cloud.history();
    const newItemInHistory = newHistory.find(item => item.requestId === addedItem.requestId);

    if (newItemInHistory) {
        console.log(`[OC RESOLVER] Found new item. Processing it to find video file...`);
        const processedFiles = await processTorrents(OCClient, [newItemInHistory]);
        
        if (processedFiles.length > 0) {
            // Step 4: Use the metadata from Step 1 to intelligently find the best video file.
            if (searchKey) {
                const fuse = new Fuse(processedFiles, { keys: ['name', 'info.title'], threshold: 0.4 });
                const searchResults = fuse.search(searchKey);

                if (searchResults.length > 0) {
                    console.log(`[OC RESOLVER] SUCCESS: Matched video file "${searchResults[0].item.name}".`);
                    return searchResults[0].item.url;
                }
            }
            
            console.log(`[OC RESOLVER] WARNING: No specific match found, falling back to first video file.`);
            return processedFiles[0].url;
        }
    }

    console.error(`[OC RESOLVER] FAILED: Could not find the processed file for requestId ${addedItem.requestId} after adding.`);
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

// Updated processHistoryEntry to pass file size information
async function processHistoryEntry(client, item) {
    try {
        console.log(`[OC EXPLORE] ==> Exploring item: ${item.requestId} (${item.fileName})`);
        const urls = await client.cloud.explore(item.requestId);
        console.log(`[OC EXPLORE] <== Found ${urls.length} files inside for ${item.requestId}.`);
        if (!Array.isArray(urls) || urls.length === 0) return null;
        const hash = getHashFromMagnet(item.originalLink);
        
        // Get file details for better filtering
        let fileDetails = [];
        try {
            fileDetails = await client.cloud.explore(item.requestId, { details: true }) || [];
        } catch (error) {
            // If detailed exploration fails, fall back to basic URLs
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
                size: fileSize || item.fileSize, // Use individual file size if available
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

// *** THE CORRECTED VIDEO VALIDATION FUNCTION ***
function isValidVideo(fileName, fileSize = 0) {
    const decodedName = decodeURIComponent(fileName).toLowerCase();
    
    // Filter out obvious non-content files
    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes)\b/i.test(decodedName)) {
        return false;
    }
    
    // Filter out files that are just group names (like "ETRG.mp4", "YIFY.mp4", etc.)
    const nameWithoutExtension = decodedName.replace(/\.(mp4|mkv|mov|avi|flv|wmv|webm)$/i, '');
    const isJustGroupName = /^(etrg|yify|rarbg|ettv|nogrp|axxo|sparks|dimension|lol|asap|killers|evolve)$/i.test(nameWithoutExtension);
    
    if (isJustGroupName) {
        console.log(`[OC] Filtering out group sample file: ${fileName}`);
        return false;
    }
    
    // Filter out very small files (likely samples) - less than 50MB
    if (fileSize && fileSize < 50 * 1024 * 1024) {
        console.log(`[OC] Filtering out small file (${Math.round(fileSize / 1024 / 1024)}MB): ${fileName}`);
        return false;
    }
    
    // Filter out files with suspicious patterns that indicate samples
    if (/\b(rarbg|sample|proof|cover)\b/i.test(decodedName)) {
        return false;
    }
    
    // Must be a video file
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
    }
    return true;
}

function filterHistoryByKeywords(history, searchKey) {
    const searchKeywords = getKeywords(searchKey);
    if (searchKeywords.length === 0) return [];

    // For short queries (1-2 words), we require all words to match.
    // For longer queries, we require at least 50% of the words to match, with a minimum of 2.
    const requiredMatches = searchKeywords.length <= 2 
        ? searchKeywords.length 
        : Math.max(2, Math.ceil(searchKeywords.length * 0.5));

    return history.filter(item => {
        if (!item.fileName) return false;
        const itemNameLower = item.fileName.toLowerCase().replace(/[._-]/g, ' ');

        // Count how many keywords are present in the torrent's file name
        const actualMatches = searchKeywords.reduce((count, keyword) => {
            return itemNameLower.includes(keyword) ? count + 1 : count;
        }, 0);

        // If the number of matches meets our threshold, include it.
        return actualMatches >= requiredMatches;
    });
}

export default { searchOffcloudTorrents, resolveStream };
