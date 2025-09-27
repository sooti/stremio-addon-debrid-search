import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import * as config from './config.js';
import * as scrapers from './common/scrapers-filtered.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import * as cacheDb from './util/cache-db.js';

const { getHashFromMagnet, filterByYear, delay } = torrentUtils;
const LOG_PREFIX = 'TB';
const TB_BASE_URL = 'https://api.torbox.app/v1';
const TIMEOUT = 15000;

// ===================================================================================
// --- 1. CORE SEARCH ORCHESTRATOR ---
// ===================================================================================
async function searchTorboxTorrents(apiKey, type, id) {
    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) {
        console.error(`[${LOG_PREFIX}] Could not get metadata for ${id}. Aborting search.`);
        return [];
    }

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

    console.log(`[${LOG_PREFIX}] Starting unified search for: "${specificSearchKey}"`);

    const abortController = new AbortController();
    const signal = abortController.signal;

    const scraperPromises = [];
    if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(specificSearchKey, signal, LOG_PREFIX));
    if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(specificSearchKey, signal, LOG_PREFIX));
    if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX));
    if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX));
    if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX));
    if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(specificSearchKey, signal, LOG_PREFIX));
    if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(specificSearchKey, signal, LOG_PREFIX));
    if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(specificSearchKey, signal, LOG_PREFIX));

    try {
        console.time(`[${LOG_PREFIX}] Total search time`);
        const [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, searchKey),
            ...scraperPromises
        ]);
        console.timeEnd(`[${LOG_PREFIX}] Total search time`);
        
        // Combine external + personal, run cache & sanity filtering
        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, episodeInfo, specificSearchKey);

        let finalResults = combinedResults;

        // For movie searches: drop any TV-like matches and apply year filtering
        if (type === 'movie') {
            const episodeLike = (name) => {
                if (!name) return false;
                const s = String(name).toLowerCase();
                return /s\d{1,2}\s*e\d{1,2}|\b\d{1,2}\s*x\s*\d{1,2}\b|\bseason\s*\d+\b|\bep(?:isode)?\s*\d+\b/.test(s);
            };
            const beforeType = finalResults.length;
            finalResults = finalResults.filter(t => {
                const n = t?.name || t?.Title || t?.title || '';
                const info = t?.info || PTT.parse(n) || {};
                if (info?.season || info?.episode) return false;
                if (episodeLike(n)) return false;
                return true;
            });
            if (beforeType !== finalResults.length) {
                console.log(`[${LOG_PREFIX}] Movie-mode: removed ${beforeType - finalResults.length} TV-like results.`);
            }

            if (cinemetaDetails.year) {
                const beforeYear = finalResults.length;
                finalResults = finalResults.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
                if (beforeYear !== finalResults.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}): ${beforeYear} -> ${finalResults.length}`);
                }
            }
        }

        console.log(`[${LOG_PREFIX}] Returning a combined total of ${finalResults.length} unique streams.`);
        return finalResults;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] A scraper may have failed, cancelling other requests.`);
        abortController.abort();
        const completedResults = await Promise.all(scraperPromises.map(p => p.catch(() => [])));
        const personalFiles = await searchPersonalFiles(apiKey, searchKey);
        return await combineAndMarkResults(apiKey, personalFiles, completedResults, episodeInfo, specificSearchKey);
    }
}

// ===================================================================================
// --- 2. SEARCH & COMBINE LOGIC ---
// ===================================================================================
async function searchPersonalFiles(apiKey, searchKey) {
    console.time(`[${LOG_PREFIX} TIMER] Personal Cloud`);
    try {
        const allFiles = await listPersonalFiles(apiKey);
        if (allFiles.length === 0) return [];

        const fuse = new Fuse(allFiles, { keys: ['info.title', 'name'], threshold: 0.3, minMatchCharLength: 3 });
        const fuzzyResults = fuse.search(searchKey).map(result => result.item);

        const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const normalizedSearchWords = normalize(searchKey).split(' ');
        
        const strictResults = fuzzyResults.filter(item => {
            const normalizedItemName = normalize(item.name);
            return normalizedSearchWords.every(word => normalizedItemName.includes(word));
        })
        // Porn filter for personal files
        .filter(item => !torrentUtils.isPornTitle(item.name));
        console.log(`[${LOG_PREFIX}] Personal files search found ${strictResults.length} results for "${searchKey}" after filtering.`);
        return strictResults;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Personal files search error: ${error.message}`);
        return [];
    } finally {
        console.timeEnd(`[${LOG_PREFIX} TIMER] Personal Cloud`);
    }
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources, episodeInfo = null, queryForSanity = null) {
    const externalTorrents = [].concat(...externalSources);
    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    const markedPersonal = personalFiles
        .filter(file => !torrentUtils.isPornTitle(file.name))
        .map(file => ({ ...file, isPersonal: true, tracker: 'Personal' }));
    let newExternalTorrents = externalTorrents
        .filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()))
        .filter(t => !torrentUtils.isPornTitle(t?.Title || t?.name || t?.title || ''));

    // Sanity check similar to RD: fuzzy-match against query to drop unrelated items
    if (queryForSanity && typeof queryForSanity === 'string' && newExternalTorrents.length > 0) {
        const norm = (s) => (s || '').replace(/[’'`]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
        const normalized = newExternalTorrents.map(t => {
            const base = (t.Title || t.name || '').toString();
            return { ...t, _normKey: norm(base) };
        });
        const fuse = new Fuse(normalized, {
            keys: ['_normKey'],
            threshold: 0.55,
            distance: 200,
            ignoreLocation: true,
            minMatchCharLength: 2
        });
        const sane = fuse.search(norm(queryForSanity)).map(r => r.item);
        const rejected = newExternalTorrents.length - sane.length;
        if (rejected > 0) console.log(`[${LOG_PREFIX}] Sanity filter rejected ${rejected} irrelevant results.`);
        newExternalTorrents = sane;
    }

    const mongoUpserts = [];
    const tbHandler = {
        getIdentifier: () => LOG_PREFIX,
        onHashChecked: (hash, isCached) => {
            try { mongoUpserts.push({ hash, cached: !!isCached }); } catch {}
        },
        checkCachedHashes: async (hashes) => {
            if (!hashes || hashes.length === 0) return new Set();
            try {
                const lowered = hashes.map(h => h.toLowerCase());
                const pre = await cacheDb.checkHashesCached('torbox', lowered);
                const toQuery = lowered.filter(h => !pre.has(h));
                if (toQuery.length === 0) return pre;
                const url = `${TB_BASE_URL}/api/torrents/checkcached`;
                const headers = getHeaders(apiKey);
                const response = await axios.post(url, { hashes: toQuery }, { headers });
                const fromApi = (response.data?.success && typeof response.data.data === 'object')
                    ? new Set(Object.keys(response.data.data))
                    : new Set();
                // Merge DB and API results
                const merged = new Set([...pre, ...fromApi]);
                return merged;
            } catch (error) {
                console.error(`[${LOG_PREFIX}] !! FATAL: TorBox cache check failed.`);
                return new Set();
            }
        },
        liveCheckHash: async (hash) => false,
        cleanup: async () => {
            if (mongoUpserts.length > 0) {
                try { await cacheDb.upsertHashes('torbox', mongoUpserts); } catch {}
            }
        }
    };

    const cachedTorrents = await processAndFilterTorrents(newExternalTorrents, tbHandler, episodeInfo);
    const finalExternalResults = cachedTorrents
        .map(formatExternalResult)
        .filter(item => !torrentUtils.isPornTitle(item.name));
    return [...markedPersonal, ...finalExternalResults];
}

function formatExternalResult(result) {
    return {
        name: result.Title,
        info: PTT.parse(result.Title) || { title: result.Title },
        size: result.Size || result.size || result.filesize || 0,
        seeders: result.Seeders,
        url: `magnet:?xt=urn:btih:${result.InfoHash}`,
        source: 'torbox',
        hash: result.InfoHash.toLowerCase(),
        tracker: result.Tracker,
        isPersonal: false,
        isCached: true
    };
}

// ===================================================================================
// --- 3. STREAM RESOLVER & HELPERS ---
// ===================================================================================
async function unrestrictUrl(apiKey, itemId, hostUrl, clientIp) {
    console.log(`[${LOG_PREFIX} RESOLVER] Starting resolution for: ${hostUrl}`);
    if (hostUrl.startsWith('magnet:')) {
        try {
            const infoHash = getHashFromMagnet(hostUrl);
            console.log(`[${LOG_PREFIX} RESOLVER] Adding magnet with hash: ${infoHash}`);
            
            const addResponse = await addToTorbox(apiKey, hostUrl);
            if (!addResponse.torrent_id && !addResponse.queued_id) {
                throw new Error('Failed to add magnet to Torbox. Response: ' + JSON.stringify(addResponse));
            }
            console.log(`[${LOG_PREFIX} RESOLVER] Magnet added. Waiting for download to complete...`);
            
            const readyTorrent = await waitForTorrentReady(apiKey, infoHash);
            if (!readyTorrent) {
                throw new Error('Torrent did not become ready in time.');
            }
            console.log(`[${LOG_PREFIX} RESOLVER] Torrent is ready: "${readyTorrent.name}"`);

            const largestFile = readyTorrent.files
                .filter(f => torrentUtils.isValidVideo(f.name))
                .sort((a, b) => b.size - a.size)[0];
            
            if (!largestFile) {
                throw new Error('No valid video file found in the ready torrent.');
            }
            console.log(`[${LOG_PREFIX} RESOLVER] Largest file is "${largestFile.name}" (${largestFile.size} bytes). Getting link...`);

            return await requestDownloadLink(apiKey, readyTorrent.id, largestFile.id, clientIp);
        } catch (error) {
            console.error(`[${LOG_PREFIX} RESOLVER] Error handling magnet link: ${error.message}`);
            return null;
        }
    } else {
        // Handle personal file resolver URLs
        try {
            const urlParts = hostUrl.split('/');
            const fileId = urlParts.pop();
            const torrentId = urlParts.pop();
            return await requestDownloadLink(apiKey, torrentId, fileId, clientIp);
        } catch (error) {
            console.error(`[${LOG_PREFIX} RESOLVER] Error handling personal file link: ${error.message}`);
            return null;
        }
    }
}

async function listPersonalFiles(apiKey) {
    try {
        const torrentsFromApi = await getTorrentList(apiKey); // Uses cache for speed
        return await processPersonalHistory(torrentsFromApi, apiKey);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Failed to list personal files:`, error.message);
        return [];
    }
}

// THIS FUNCTION IS NOW UPDATED
async function getTorrentList(apiKey, bypassCache = false) {
    const url = `${TB_BASE_URL}/api/torrents/mylist`;
    const headers = getHeaders(apiKey);
    const params = {};
    if (bypassCache) {
        params.bypass_cache = true;
    }
    const response = await axios.get(url, { headers, params, timeout: TIMEOUT });
    if (response.data?.success && Array.isArray(response.data.data)) {
        return response.data.data;
    }
    throw new Error(response.data?.error || 'Invalid data format from Torbox API.');
}

async function processPersonalHistory(torrentsFromApi, apiKey) {
    const processedFiles = torrentsFromApi.map(torrent => {
        if (!torrent.files || torrent.download_present !== true) return [];
        
        return torrent.files.map(file => {
            if (!torrentUtils.isValidVideo(file.name)) return null;

            return {
                source: 'torbox',
                id: `${torrent.id}-${file.id}`,
                name: file.name,
                info: PTT.parse(file.name),
                size: file.size,
                hash: torrent.hash?.toLowerCase(),
                url: `${process.env.ADDON_URL}/resolve/Torbox/${apiKey}/${torrent.id}/${file.id}`,
            };
        }).filter(Boolean);
    });
    return processedFiles.flat();
}

async function addToTorbox(apiKey, magnetLink) {
    const url = `${TB_BASE_URL}/api/torrents/createtorrent`;
    const headers = getHeaders(apiKey);
    const data = new URLSearchParams();
    data.append('magnet', magnetLink);
    data.append('allow_zip', 'false');

    const response = await axios.post(url, data, { headers, timeout: TIMEOUT });
    if (response.data?.success) {
        return response.data.data;
    }
    throw new Error(response.data?.error || 'Failed to create torrent on Torbox.');
}

// THIS FUNCTION IS NOW UPDATED
async function waitForTorrentReady(apiKey, infoHash, timeout = 120000, interval = 3000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        // We now force a cache bypass to get the most up-to-date list
        const torrentList = await getTorrentList(apiKey, true);
        const target = torrentList.find(t => t.hash?.toLowerCase() === infoHash.toLowerCase());
        
        if (target && target.download_present === true) {
            return target;
        }
        await delay(interval);
    }
    return null;
}

async function requestDownloadLink(apiKey, torrentId, fileId, clientIp) {
    const url = `${TB_BASE_URL}/api/torrents/requestdl`;
    const headers = getHeaders(apiKey);
    const params = { token: apiKey, torrent_id: torrentId, file_id: fileId, user_ip: clientIp };
    
    const response = await axios.get(url, { params, headers, timeout: TIMEOUT });
    if (response.data?.success && response.data.data) {
        return response.data.data;
    }
    throw new Error(response.data?.error || 'Failed to request download link.');
}

function getHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'StremioAddon/1.0.0',
    };
}

export default { searchTorboxTorrents, unrestrictUrl };
