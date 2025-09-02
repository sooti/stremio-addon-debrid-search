import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import OC from 'offcloud-api';
import { parseStringPromise } from 'xml2js';

// ===================================================================================
// --- CONFIGURATION ---
// ===================================================================================
const JACKETT_URL = process.env.JACKETT_URL || 'http://YOUR_JACKETT_IP:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || '';
const TORRENTIO_URL = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
const ZILEAN_URL = process.env.ZILEAN_URL || 'https://zilean.elfhosted.com';
const COMET_URL = process.env.COMET_URL || 'https://comet.elfhosted.com';
const STREMTHRU_URL = process.env.STREMTHRU_URL || 'https://stremthru.elfhosted.com';
const AIOSTREAMS_URL = process.env.AIOSTREAMS_URL || 'https://aiostreams.am';
const AIOSTREAMS_CREDENTIALS = process.env.AIOSTREAMS_CREDENTIALS || '';
const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT) || 5000;

const JACKETT_ENABLED = process.env.JACKETT_ENABLED === 'true';
const TORRENTIO_ENABLED = process.env.TORRENTIO_ENABLED === 'true';
const ZILEAN_ENABLED = process.env.ZILEAN_ENABLED === 'true';
const COMET_ENABLED = process.env.COMET_ENABLED === 'true';
const STREMTHRU_ENABLED = process.env.STREMTHRU_ENABLED === 'true';
const AIOSTREAMS_ENABLED = process.env.AIOSTREAMS_ENABLED === 'true';
// ===================================================================================

const OFFCLOUD_API_URL = 'https://offcloud.com/api';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Pre-compile regex patterns for performance
const VIDEO_EXT_REGEX = /\.(mp4|mkv|mov|avi|flv|wmv|webm)$/i;
const EXCLUDED_CONTENT_REGEX = /\b(sample|trailer|promo|etrg|extra|featurette|behindthescenes)\b/i;
const HASH_REGEX = /btih:([a-f0-9]{40})/i;

// ===================================================================================
// --- ENHANCED MULTI-LAYER CACHING ---
// ===================================================================================
class OffcloudCache {
    constructor() {
        this.torrents = { data: null, timestamp: 0, apiKey: null };
        this.searches = new Map(); // LRU cache for search results
        this.hashLookup = new Map(); // Fast hash-based lookup
        this.cinemeta = new Map(); // Cinemeta API responses
        this.offcloudCache = new Map(); // Offcloud cache responses
        
        this.TTL = 5 * 60 * 1000; // 5 minutes
        this.searchTTL = 2 * 60 * 1000; // 2 minutes for searches
        this.maxSearches = 50; // LRU limit
        this.maxCacheEntries = 100;
    }
    
    // Torrent cache methods
    isValidTorrents(apiKey) {
        return this.torrents.data && 
               this.torrents.apiKey === apiKey && 
               (Date.now() - this.torrents.timestamp) < this.TTL;
    }
    
    setTorrents(data, apiKey) {
        this.torrents = { data, timestamp: Date.now(), apiKey };
        this.buildHashLookup(data);
        console.log(`[CACHE] Cached ${data.length} torrents with hash lookup`);
    }
    
    getTorrents() {
        return this.torrents.data;
    }
    
    buildHashLookup(torrents) {
        this.hashLookup.clear();
        torrents.forEach(t => {
            if (t.hash) this.hashLookup.set(t.hash, t);
        });
    }
    
    findByHash(hash) {
        return this.hashLookup.get(hash?.toLowerCase());
    }
    
    // Search cache with LRU eviction
    getSearch(key) {
        const entry = this.searches.get(key);
        if (!entry || (Date.now() - entry.timestamp) > this.searchTTL) {
            this.searches.delete(key);
            return null;
        }
        // Move to end (LRU)
        this.searches.delete(key);
        this.searches.set(key, entry);
        return entry.data;
    }
    
    setSearch(key, data) {
        // Remove oldest if at limit
        if (this.searches.size >= this.maxSearches) {
            const firstKey = this.searches.keys().next().value;
            this.searches.delete(firstKey);
        }
        this.searches.set(key, { data, timestamp: Date.now() });
    }
    
    // Generic cache with TTL
    getCached(cache, key, ttl = this.TTL) {
        const entry = cache.get(key);
        if (!entry || (Date.now() - entry.timestamp) > ttl) {
            cache.delete(key);
            return null;
        }
        return entry.data;
    }
    
    setCached(cache, key, data) {
        if (cache.size >= this.maxCacheEntries) {
            const firstKey = cache.keys().next().value;
            cache.delete(firstKey);
        }
        cache.set(key, { data, timestamp: Date.now() });
    }
    
    clear() {
        this.torrents = { data: null, timestamp: 0, apiKey: null };
        this.hashLookup.clear();
    }
}

const cache = new OffcloudCache();

// ===================================================================================
// --- PARALLEL HTTP CLIENT ---
// ===================================================================================
class ParallelHttpClient {
    constructor() {
        this.client = axios.create({
            timeout: SCRAPER_TIMEOUT,
            headers: { 'User-Agent': 'Offcloud-Scraper/1.0' }
        });
    }
    
    async executeParallel(requests, maxConcurrency = 6) {
        const results = new Array(requests.length);
        const executing = [];
        
        for (let i = 0; i < requests.length; i++) {
            const promise = this.executeSingle(requests[i], i, results);
            results[i] = promise;
            
            if (requests.length >= maxConcurrency) {
                executing.push(promise);
                if (executing.length >= maxConcurrency) {
                    await Promise.race(executing);
                    executing.splice(executing.findIndex(p => p === promise), 1);
                }
            }
        }
        
        await Promise.all(results);
        return results.map(r => r.value || []);
    }
    
    async executeSingle(request, index, results) {
        try {
            const response = await request();
            results[index] = { value: response };
            return results[index];
        } catch (error) {
            results[index] = { value: [] };
            return results[index];
        }
    }
}

const httpClient = new ParallelHttpClient();

// ===================================================================================
// --- OPTIMIZED CORE FUNCTIONS ---
// ===================================================================================
async function searchOffcloudTorrents(apiKey, type, id) {
    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    
    // Check cinemeta cache first
    const cinemetaKey = `${type}:${imdbId}`;
    let cinemetaDetails = cache.getCached(cache.cinemeta, cinemetaKey);
    
    if (!cinemetaDetails) {
        cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        if (!cinemetaDetails) return [];
        cache.setCached(cache.cinemeta, cinemetaKey, cinemetaDetails);
    }

    const searchKey = cinemetaDetails.name;
    const specificSearchKey = type === 'series'
        ? `${searchKey} s${season?.padStart(2, '0') || '01'}e${episode?.padStart(2, '0') || '01'}`
        : searchKey;

    console.log(`[OC] Unified search: "${specificSearchKey}"`);

    // Check search cache
    const fullSearchKey = `${apiKey}:${specificSearchKey}:${type}:${imdbId}`;
    const cachedResult = cache.getSearch(fullSearchKey);
    if (cachedResult) {
        console.log(`[CACHE] Using cached search results (${cachedResult.length} items)`);
        return cachedResult;
    }

    const abortController = new AbortController();
    
    // Build scraper requests array for parallel execution
    const scraperRequests = [];
    if (JACKETT_ENABLED) scraperRequests.push(() => searchJackett(specificSearchKey, abortController.signal));
    if (TORRENTIO_ENABLED) scraperRequests.push(() => searchTorrentio(type, imdbId, abortController.signal));
    if (ZILEAN_ENABLED) scraperRequests.push(() => searchZilean(specificSearchKey, season, episode, abortController.signal));
    if (COMET_ENABLED) scraperRequests.push(() => searchComet(type, imdbId, abortController.signal));
    if (STREMTHRU_ENABLED) scraperRequests.push(() => searchStremthru(type, imdbId, abortController.signal));
    if (AIOSTREAMS_ENABLED) scraperRequests.push(() => searchAioStreams(type, imdbId, abortController.signal));

    try {
        const [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, specificSearchKey),
            ...scraperRequests.map(req => req())
        ]);

        let combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults);

        // Optimized year filtering for movies
        if (type === 'movie' && cinemetaDetails.year) {
            const targetYear = cinemetaDetails.year;
            combinedResults = combinedResults.filter(t => 
                !t.info?.year || Math.abs(t.info.year - targetYear) <= 1
            );
        }

        // Cache the final results
        cache.setSearch(fullSearchKey, combinedResults);
        console.log(`[OC] Returning ${combinedResults.length} streams`);
        return combinedResults;
        
    } catch (error) {
        console.error(`[OC] Search error, using partial results`);
        abortController.abort();
        return [];
    }
}

async function getCachedTorrents(apiKey) {
    if (cache.isValidTorrents(apiKey)) {
        return cache.getTorrents();
    }

    console.log(`[CACHE] Fetching fresh torrent data...`);
    const OCClient = new OC(apiKey);
    const history = await OCClient.cloud.history();
    const torrents = await processHistoryOptimized(OCClient, history);
    
    cache.setTorrents(torrents, apiKey);
    return torrents;
}

async function searchPersonalFiles(apiKey, searchKey) {
    try {
        const torrents = await getCachedTorrents(apiKey);
        if (torrents.length === 0) return [];
        
        // Use more efficient fuzzy search configuration
        const fuse = new Fuse(torrents, {
            keys: [
                { name: 'name', weight: 0.8 },
                { name: 'info.title', weight: 0.2 }
            ],
            threshold: 0.35,
            minMatchCharLength: 3,
            ignoreLocation: true,
            includeScore: true
        });
        
        const results = fuse.search(searchKey, { limit: 50 });
        console.log(`[OC] Personal: ${results.length}/${torrents.length}`);
        return results.map(r => r.item);
    } catch (error) {
        console.error(`[OC] Personal search failed: ${error.message}`);
        return [];
    }
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources) {
    const externalTorrents = externalSources.flat();
    const uniqueExternalMap = new Map();
    
    // Deduplicate externals by hash
    externalTorrents.forEach(t => {
        if (t.InfoHash) {
            const hash = t.InfoHash.toLowerCase();
            if (!uniqueExternalMap.has(hash) || t.Seeders > (uniqueExternalMap.get(hash).Seeders || 0)) {
                uniqueExternalMap.set(hash, t);
            }
        }
    });

    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    
    // Process personal files with size enhancement
    const markedPersonal = personalFiles.map(file => {
        if (!file.size || file.size === 0) {
            const externalMatch = uniqueExternalMap.get(file.hash);
            if (externalMatch?.Size > 0) file.size = externalMatch.Size;
        }
        return { ...file, source: 'offcloud', isPersonal: true, tracker: 'Personal' };
    });

    // Filter new externals
    const newExternals = Array.from(uniqueExternalMap.values())
        .filter(t => !personalHashes.has(t.InfoHash.toLowerCase()));

    if (newExternals.length === 0) {
        logSourceCounts(personalFiles.length, []);
        return markedPersonal;
    }

    // Batch cache check
    const hashesToCheck = newExternals.map(r => r.InfoHash);
    const cachedHashes = await checkOffcloudCacheBatch(apiKey, hashesToCheck);
    const cachedSet = new Set(cachedHashes.map(h => h.toLowerCase()));

    const finalExternals = newExternals
        .filter(r => cachedSet.has(r.InfoHash.toLowerCase()))
        .map(formatExternalResult);

    logSourceCounts(personalFiles.length, [externalTorrents.length]);
    return [...markedPersonal, ...finalExternals];
}

function formatExternalResult(result) {
    return {
        name: result.Title,
        info: PTT.parse(result.Title) || { title: result.Title },
        size: result.Size || 0,
        seeders: result.Seeders || 0,
        url: `magnet:?xt=urn:btih:${result.InfoHash}`,
        source: 'offcloud',
        hash: result.InfoHash.toLowerCase(),
        tracker: result.Tracker || 'Unknown',
        isPersonal: false
    };
}

function logSourceCounts(personalCount, externalCounts) {
    const sources = ['Jackett', 'Torrentio', 'Zilean', 'Comet', 'StremThru', 'AIOStreams'];
    const enabled = [JACKETT_ENABLED, TORRENTIO_ENABLED, ZILEAN_ENABLED, COMET_ENABLED, STREMTHRU_ENABLED, AIOSTREAMS_ENABLED];
    
    let log = `Personal(${personalCount})`;
    let idx = 0;
    for (let i = 0; i < enabled.length; i++) {
        if (enabled[i]) {
            log += `, ${sources[i]}(${externalCounts[idx] || 0})`;
            idx++;
        }
    }
    console.log(`[OC] Sources: ${log}`);
}

// ===================================================================================
// --- OPTIMIZED SCRAPERS ---
// ===================================================================================
async function searchJackett(query, signal) {
    try {
        const response = await axios.get(`${JACKETT_URL}/api/v2.0/indexers/all/results`, { 
            params: { apikey: JACKETT_API_KEY, Query: query }, 
            timeout: SCRAPER_TIMEOUT, 
            signal
        });
        return (response.data.Results || []).map(r => ({
            Title: r.Title, 
            InfoHash: r.InfoHash, 
            Size: r.Size || 0, 
            Seeders: r.Seeders || 0,
            Tracker: `Jackett|${r.Tracker || 'Unknown'}`
        }));
    } catch (error) {
        if (!axios.isCancel(error)) console.error(`[SCRAPER] Jackett failed: ${error.message}`);
        return [];
    }
}

async function searchTorrentio(mediaType, mediaId, signal) {
    try {
        const response = await axios.get(
            `${TORRENTIO_URL}/stream/${mediaType}/${mediaId}.json`, 
            { timeout: SCRAPER_TIMEOUT, signal }
        );
        
        const dataRegex = /(?:👤 (\d+) )?💾 ([\d.]+ [KMGT]B)(?: ⚙️ (\w+))?/;
        return response.data.streams.map(stream => {
            const title = stream.title.split('\n')[0];
            const match = stream.title.match(dataRegex);
            
            return {
                Title: title, 
                InfoHash: stream.infoHash,
                Size: match ? sizeToBytes(match[2]) : 0,
                Seeders: match?.[1] ? parseInt(match[1]) : 0,
                Tracker: `Torrentio|${match?.[3] || 'Public'}`
            };
        });
    } catch (error) {
        if (!axios.isCancel(error)) console.error(`[SCRAPER] Torrentio failed: ${error.message}`);
        return [];
    }
}

async function searchZilean(title, season, episode, signal) {
    try {
        let url = `${ZILEAN_URL}/dmm/filtered?query=${encodeURIComponent(title)}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;
        
        const response = await axios.get(url, { timeout: SCRAPER_TIMEOUT, signal });
        return (response.data || []).map(result => ({
            Title: result.raw_title, 
            InfoHash: result.info_hash,
            Size: parseInt(result.size) || 0, 
            Seeders: 0, 
            Tracker: 'Zilean|DMM'
        }));
    } catch (error) {
        if (!axios.isCancel(error)) console.error(`[SCRAPER] Zilean failed: ${error.message}`);
        return [];
    }
}

async function searchComet(mediaType, mediaId, signal) {
    for (let attempt = 0; attempt < 2; attempt++) { // Reduced retries
        try {
            const response = await axios.get(
                `${COMET_URL}/stream/${mediaType}/${mediaId}.json`, 
                { timeout: SCRAPER_TIMEOUT, signal }
            );
            
            return (response.data.streams || []).map(stream => {
                const desc = stream.description || '';
                const titleMatch = desc.match(/📄 (.+)/);
                const seedersMatch = desc.match(/👤 (\d+)/);
                const trackerMatch = desc.match(/🔎 (.+)/);
                
                return {
                    Title: titleMatch?.[1] || 'Unknown',
                    InfoHash: stream.infoHash,
                    Size: stream.behaviorHints?.videoSize || 0,
                    Seeders: seedersMatch ? parseInt(seedersMatch[1]) : 0,
                    Tracker: `Comet|${trackerMatch?.[1] || 'Public'}`
                };
            });
        } catch (error) {
            const isServerError = error.response?.status >= 500;
            if (axios.isCancel(error) || attempt === 1 || !isServerError) {
                if (!axios.isCancel(error)) console.error(`[SCRAPER] Comet failed: ${error.message}`);
                return [];
            }
            await delay(300); // Reduced retry delay
        }
    }
    return [];
}

async function searchStremthru(mediaType, mediaId, signal) {
    try {
        const response = await axios.get(
            `${STREMTHRU_URL}/v0/torznab/api?t=search&imdbid=${mediaId}`,
            { timeout: SCRAPER_TIMEOUT, signal }
        );
        
        const parsed = await parseStringPromise(response.data);
        const items = parsed.rss?.channel?.[0]?.item || [];
        
        return items.map(item => {
            let infoHash = null, size = 0;
            const attrs = item['torznab:attr'];
            
            if (attrs) {
                for (const attr of attrs) {
                    if (attr.$.name === 'infohash') infoHash = attr.$.value;
                    else if (attr.$.name === 'size') size = parseInt(attr.$.value) || 0;
                }
            }
            
            return infoHash ? {
                Title: item.title[0], 
                InfoHash: infoHash,
                Size: size, 
                Seeders: item.seeders ? parseInt(item.seeders[0]) : 0,
                Tracker: 'StremThru'
            } : null;
        }).filter(Boolean);
    } catch (error) {
        if (!axios.isCancel(error)) console.error(`[SCRAPER] StremThru failed: ${error.message}`);
        return [];
    }
}

async function searchAioStreams(mediaType, mediaId, signal) {
    try {
        const headers = {};
        if (AIOSTREAMS_CREDENTIALS) {
            headers.Authorization = `Basic ${Buffer.from(AIOSTREAMS_CREDENTIALS).toString('base64')}`;
        }
        
        const response = await axios.get(`${AIOSTREAMS_URL}/api/v1/search`, {
            params: { type: mediaType, id: mediaId },
            headers, 
            timeout: SCRAPER_TIMEOUT, 
            signal
        });
        
        return (response.data.data?.results || []).map(torrent => 
            torrent.infoHash ? {
                Title: torrent.filename || 'Unknown',
                InfoHash: torrent.infoHash,
                Size: torrent.size || 0,
                Seeders: torrent.seeders || 0,
                Tracker: `AIOStreams${torrent.indexer ? `|${torrent.indexer}` : ''}`,
            } : null
        ).filter(Boolean);
    } catch (error) {
        if (!axios.isCancel(error)) console.error(`[SCRAPER] AIOStreams failed: ${error.message}`);
        return [];
    }
}

// ===================================================================================
// --- OPTIMIZED UTILITIES ---
// ===================================================================================
function sizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const [value, unit] = sizeStr.split(' ');
    const val = parseFloat(value);
    const multipliers = { KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
    return Math.round(val * (multipliers[unit?.toUpperCase()] || 1));
}

async function checkOffcloudCacheBatch(apiKey, hashes) {
    if (!hashes?.length) return [];
    
    const cacheKey = `cache:${hashes.slice(0, 5).join(',')}:${hashes.length}`;
    const cached = cache.getCached(cache.offcloudCache, cacheKey, 60000); // 1 min TTL
    if (cached) return cached;
    
    try {
        const response = await axios.post(`${OFFCLOUD_API_URL}/cache?key=${apiKey}`, {
            hashes: hashes.map(h => h.toLowerCase())
        }, { timeout: 10000 });
        
        const result = response.data.cachedItems || [];
        cache.setCached(cache.offcloudCache, cacheKey, result);
        return result;
    } catch (error) { 
        console.error(`[OC] Cache check failed: ${error.message}`);
        return []; 
    }
}

// ===================================================================================
// --- OPTIMIZED RESOLVER ---
// ===================================================================================
async function resolveStream(apiKey, urlToResolve) {
    if (!urlToResolve?.startsWith('magnet:')) return urlToResolve;

    const hash = getHashFromMagnet(urlToResolve);
    if (!hash) return null;
    
    // Fast hash lookup in cache
    const existingFile = cache.findByHash(hash);
    if (existingFile) {
        console.log(`[RESOLVER] Found in cache: ${hash}`);
        return existingFile.url;
    }

    console.log(`[RESOLVER] Adding to Offcloud: ${hash}`);
    const addedItem = await addToOffcloud(apiKey, urlToResolve);
    if (!addedItem?.requestId) {
        console.log(`[RESOLVER] Failed to add torrent to Offcloud`);
        return null;
    }

    // Clear cache since we added new content
    cache.clear();
    
    const OCClient = new OC(apiKey);
    
    // Wait longer initially and check status first
    const checkIntervals = [10000, 15000, 20000, 30000]; // More realistic timing
    
    for (let i = 0; i < checkIntervals.length; i++) {
        await delay(checkIntervals[i]);
        console.log(`[RESOLVER] Status check ${i + 1}/${checkIntervals.length} (${checkIntervals[i]/1000}s)...`);
        
        try {
            // First check if the item exists in history and its status
            const history = await OCClient.cloud.history();
            const historyItem = history.find(item => item.requestId === addedItem.requestId);
            
            if (!historyItem) {
                console.log(`[RESOLVER] Item not found in history yet, waiting...`);
                continue;
            }
            
            console.log(`[RESOLVER] Item status: ${historyItem.status || 'unknown'}`);
            
            // Only try to explore if the item appears to be completed
            if (historyItem.status && !['completed', 'downloaded'].includes(historyItem.status.toLowerCase())) {
                console.log(`[RESOLVER] Still processing (${historyItem.status}), waiting...`);
                continue;
            }
            
            // Now try to explore the contents
            const urls = await OCClient.cloud.explore(addedItem.requestId);
            if (Array.isArray(urls) && urls.length > 0) {
                const videoFile = urls.find(url => {
                    const fileName = decodeURIComponent(url.split('/').pop());
                    return isValidVideo(fileName);
                });
                
                if (videoFile) {
                    console.log(`[RESOLVER] Found video file: ${decodeURIComponent(videoFile.split('/').pop())}`);
                    return createEncodedUrl(videoFile);
                }
                
                console.log(`[RESOLVER] No valid video files found in torrent`);
            } else {
                console.log(`[RESOLVER] Torrent contents not ready yet`);
            }
        } catch (error) {
            console.log(`[RESOLVER] Check failed: ${error.message}`);
        }
    }
    
    console.log(`[RESOLVER] Timeout waiting for torrent processing: ${hash}`);
    return null;
}

async function addToOffcloud(apiKey, magnetLink) {
    try {
        const response = await axios.post(`${OFFCLOUD_API_URL}/cloud?key=${apiKey}`, {
            url: magnetLink
        }, { timeout: 10000 });
        return response.data;
    } catch (error) { 
        console.error(`[OC] Add failed: ${error.message}`);
        return null; 
    }
}

// ===================================================================================
// --- STREAMLINED HISTORY PROCESSING ---
// ===================================================================================
async function processHistoryOptimized(client, history) {
    if (!history?.length) return [];
    
    console.log(`[OC] Processing ${history.length} items...`);
    const BATCH_SIZE = 25; // Increased batch size
    const results = [];
    
    for (let i = 0; i < history.length; i += BATCH_SIZE) {
        const batch = history.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
            batch.map(item => processHistoryEntryOptimized(client, item))
        );
        results.push(...batchResults.flat().filter(Boolean));
        
        // Progress logging for large histories
        if (i > 0 && i % (BATCH_SIZE * 10) === 0) {
            console.log(`[OC] Processed ${i}/${history.length}...`);
        }
    }
    
    console.log(`[OC] Found ${results.length} video files`);
    return results;
}

async function processHistoryEntryOptimized(client, item) {
    // Quick validation
    if (!item?.requestId) return null;
    
    const hash = getHashFromMagnet(item.originalLink);
    if (!hash) return null;
    
    try {
        const urls = await client.cloud.explore(item.requestId);
        if (!Array.isArray(urls) || urls.length === 0) return null;
        
        return urls.map(url => {
            const fileName = decodeURIComponent(url.split('/').pop());
            if (!isValidVideo(fileName)) return null;
            
            return {
                id: item.requestId,
                name: fileName,
                info: PTT.parse(fileName) || { title: fileName },
                size: item.fileSize || 0,
                hash,
                url: createEncodedUrl(url)
            };
        }).filter(Boolean);
        
    } catch (error) {
        // Fallback for single-file torrents
        if (isValidVideo(item.fileName)) {
            return [{
                id: item.requestId,
                name: item.fileName,
                info: PTT.parse(item.fileName) || { title: item.fileName },
                size: item.fileSize || 0,
                hash,
                url: createEncodedUrl(`https://${item.server}.offcloud.com/cloud/download/${item.requestId}/${item.fileName}`)
            }];
        }
        return null;
    }
}

// ===================================================================================
// --- UTILITY FUNCTIONS ---
// ===================================================================================
function isValidVideo(fileName) {
    if (!fileName) return false;
    const decoded = decodeURIComponent(fileName).toLowerCase();
    return VIDEO_EXT_REGEX.test(decoded) && !EXCLUDED_CONTENT_REGEX.test(decoded);
}

function getHashFromMagnet(magnetLink) {
    if (!magnetLink?.includes('btih:')) return null;
    const match = magnetLink.match(HASH_REGEX);
    return match?.[1]?.toLowerCase() || null;
}

function createEncodedUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        pathParts[pathParts.length - 1] = encodeURIComponent(pathParts[pathParts.length - 1]);
        urlObj.pathname = pathParts.join('/');
        return urlObj.toString();
    } catch { 
        return url; 
    }
}

export default { searchOffcloudTorrents, resolveStream };
