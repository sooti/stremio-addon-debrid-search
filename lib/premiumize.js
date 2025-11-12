import axios from 'axios'
import Fuse from 'fuse.js'
import { isVideo } from './util/extension-util.js'
import PTT from './util/parse-torrent-title.js'
import * as scrapers from './common/scrapers.js'
import * as config from './config.js'
import Cinemeta from './util/cinemeta.js'
import { filterEpisode } from './util/filter-torrents.js'
import { BadTokenError, AccessDeniedError } from './util/error-codes.js'
import { encode } from 'urlencode'
import * as torrentUtils from './common/torrent-utils.js'
import searchCoordinator from './util/search-coordinator.js'
import { orchestrateScrapers } from './util/scraper-selector.js'
import * as sqliteCache from './util/sqlite-cache.js'
import * as debridHelpers from './util/debrid-helpers.js'
import debridProxyManager from './util/debrid-proxy.js'

const BASE_URL = 'https://www.premiumize.me/api'
const LOG_PREFIX = 'PM';

// Use debrid-helpers functions
const norm = debridHelpers.norm;
const getQualityCategory = debridHelpers.getQualityCategory;
const addHashToSqlite = (hash, fileName = null, size = null, data = null) => debridHelpers.addHashToSqlite(hash, fileName, size, data, 'premiumize');
const deferSqliteUpserts = debridHelpers.deferSqliteUpserts;
const uniqueUpserts = debridHelpers.uniqueUpserts;

// Helper to get axios with proxy config
const axiosWithProxy = axios.create(debridProxyManager.getAxiosConfig('premiumize'));

async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
    console.log("Search files with searchKey: " + searchKey)

    // Handle undefined or null searchKey
    if (!searchKey) {
        console.log('[PM] Personal files search called with empty searchKey, returning empty results');
        return [];
    }

    let files = await listFiles(apiKey)
    let torrents = files.map(file => toTorrent(file))
    const fuse = new Fuse(torrents, {
        keys: ['info.title'],
        threshold: threshold,
        minMatchCharLength: 2
    })

    const searchResults = fuse.search(searchKey)
    if (searchResults && searchResults.length) {
        return searchResults.map(searchResult => searchResult.item)
    } else {
        return []
    }
}

async function listFiles(apiKey) {
    try {
        const url = `${BASE_URL}/item/listall?apikey=${apiKey}`
        const response = await axiosWithProxy.get(url)

        if (response.data && response.data.status === 'success') {
            return response.data.files || []
        } else {
            console.error('Premiumize listFiles failed:', response.data)
            return []
        }
    } catch (err) {
        return handleError(err)
    }
}

async function getTorrentDetails(apiKey, id) {
    try {
        const url = `${BASE_URL}/item/details?apikey=${apiKey}&id=${id}`
        const response = await axiosWithProxy.get(url)

        console.log(`[${LOG_PREFIX}] getTorrentDetails response for id ${id}:`, JSON.stringify(response.data));
        if (response.data && response.data.status === 'success') {
            return toTorrentDetails({ ...response.data, id: id })
        } else {
            if (response.data.message !== 'File not found or not your file') {
                console.error(`Premiumize getTorrentDetails for id ${id} failed:`, response.data);
            }
            return null
        }
    } catch (err) {
        return handleError(err)
    }
}

function toTorrent(item) {
    return {
        source: 'premiumize',
        id: item.id,
        name: item.name,
        type: 'other',
        info: PTT.parse(item.name),
        size: item.size,
        created: new Date(item.created_at * 1000),
    }
}

function toTorrentDetails(item) {
    const videos = [];

    console.log(`[${LOG_PREFIX}] Converting item to torrent details:`, JSON.stringify(item));

    if (item.type === 'folder' && Array.isArray(item.content)) {
        item.content
            .filter(file => isVideo(file.name))
            .forEach(file => {
                const streamUrl = file.stream_link || file.link;
                if (streamUrl) {
                    videos.push({
                        name: file.name,
                        url: `${process.env.ADDON_URL}/resolve/Premiumize/null/${item.id}/${encode(streamUrl)}`,
                        size: file.size,
                    });
                } else {
                    console.log(`[${LOG_PREFIX}] No streamable link for file:`, file.name);
                }
            });
    } else if (item.type === 'file' && isVideo(item.name)) {
        videos.push({
            name: item.name,
            url: `${process.env.ADDON_URL}/resolve/Premiumize/null/${item.id}/${encode(item.link)}`,
            size: item.size,
        });
    }

    return {
        source: 'premiumize',
        id: item.id,
        name: item.name,
        type: 'other',
        hash: item.id.toLowerCase(),
        size: item.size,
        videos: videos
    };
}

function handleError(err) {
    console.log(err)
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        return Promise.reject(BadTokenError)
    }
    return Promise.reject(err)
}

async function getDirectDownloadLink(apiKey, magnetLink) {
    try {
        const url = `${BASE_URL}/transfer/directdl`
        const body = `apikey=${apiKey}&src=${encodeURIComponent(magnetLink)}`

        // Use extended timeout for directdl endpoint as it can take longer to process
        const extendedTimeout = parseInt(process.env.PREMIUMIZE_DIRECTDL_TIMEOUT || '180000', 10); // 3 minutes default
        const response = await axiosWithProxy.post(url, body, {
            timeout: extendedTimeout,
            socketTimeout: extendedTimeout
        })

        console.log(`[${LOG_PREFIX}] getDirectDownloadLink response:`, JSON.stringify(response.data));
        if (response.data && response.data.status === 'success') {
            return response.data;
        } else {
            console.error('Premiumize getDirectDownloadLink failed:', response.data)
            return null
        }
    } catch (err) {
        // Handle timeout errors specifically
        if (err.code === 'ECONNABORTED' && err.message?.includes('timeout')) {
            console.error(`[${LOG_PREFIX}] getDirectDownloadLink timeout after ${err.config?.timeout}ms for magnet: ${magnetLink.substring(0, 50)}...`);
            return null;
        }

        // Handle auth errors
        if (err.response && (err.response.status === 401 || err.response.status === 403)) {
            console.error(`[${LOG_PREFIX}] Authentication error in getDirectDownloadLink:`, err.message);
            throw BadTokenError;
        }

        // Log other errors but don't crash
        console.error(`[${LOG_PREFIX}] Error in getDirectDownloadLink:`, err.message);
        return null;
    }
}

async function addMagnet(apiKey, magnetLink) {
    try {
        const url = `${BASE_URL}/transfer/create`
        const body = `apikey=${apiKey}&src=${encodeURIComponent(magnetLink)}`
        const response = await axiosWithProxy.post(url, body)
        if (response.data && response.data.status === 'success') {
            return response.data.id
        } else {
            console.error('Premiumize addMagnet failed:', response.data)
            return null
        }
    } catch (err) {
        handleError(err)
        return null
    }
}

async function listTransfers(apiKey) {
    try {
        const url = `${BASE_URL}/transfer/list?apikey=${apiKey}`
        const response = await axiosWithProxy.get(url)
        if (response.data && response.data.status === 'success') {
            return response.data.transfers
        } else {
            console.error('Premiumize listTransfers failed:', response.data)
            return []
        }
    } catch (err) {
        handleError(err)
        return []
    }
}

async function search(apiKey, type, id, userConfig = {}) {
    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) {
        console.error(`[${LOG_PREFIX}] Could not get metadata for ${id}. Aborting search.`);
        return [];
    }

    const searchKey = cinemetaDetails.name;
    const selectedLanguages = Array.isArray(userConfig.Languages) ? userConfig.Languages : [];
    const baseSearchKey = type === 'series'
        ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

    const abortController = debridHelpers.createAbortController();
    const signal = abortController.signal;

    try {
        // Execute coordinated scrapers to avoid duplicate work when multiple services run simultaneously
        const scraperResults = await searchCoordinator.executeSearch(
            'premiumize',
            async () => {
                return await orchestrateScrapers({
                    type,
                    imdbId,
                    searchKey,
                    baseSearchKey,
                    season,
                    episode,
                    signal,
                    logPrefix: LOG_PREFIX,
                    userConfig,
                    selectedLanguages
                });
            },
            type,
            id,
            userConfig
        );
        let torrents = [].concat(...scraperResults);
        if (type === 'series') {
            torrents = torrents.filter(torrent => filterEpisode(torrent, season, episode, cinemetaDetails));
        } else if (type === 'movie') {
            if (cinemetaDetails.year) {
                torrents = torrents.filter(t => torrentUtils.filterByYear(t, cinemetaDetails, LOG_PREFIX));
            }
            // Apply title matching to filter out unrelated movies
            if (cinemetaDetails.name) {
                const beforeTitleFilter = torrents.length;
                const normalizeTitle = (s) => String(s || '').toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
                const expectedTitle = normalizeTitle(cinemetaDetails.name);
                torrents = torrents.filter(torrent => {
                    try {
                        const title = torrent.Title || torrent.name || '';
                        const normalizedFullTitle = normalizeTitle(title);
                        const expectedWords = expectedTitle.split(/\s+/).filter(w => w.length > 2);
                        const wordsToMatch = expectedWords.length > 0 ? expectedWords : expectedTitle.split(/\s+/).filter(w => w.length > 0);
                        const matchingWords = wordsToMatch.filter(word => normalizedFullTitle.includes(word));
                        const requiredMatches = wordsToMatch.length <= 2 ? wordsToMatch.length : Math.ceil(wordsToMatch.length * 0.5);
                        return matchingWords.length >= requiredMatches;
                    } catch {
                        return true;
                    }
                });
                if (beforeTitleFilter !== torrents.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by title matching "${cinemetaDetails.name}". Removed ${beforeTitleFilter - torrents.length} unrelated results.`);
                }
            }
        }
        const hashes = torrents.map(torrent => torrent.InfoHash).filter(Boolean);

        // Check SQLite cache first
        let cachedHashesFromSqlite = new Set();
        try {
            if (sqliteCache?.isEnabled()) {
                const sqliteHashes = await sqliteCache.getCachedHashes('premiumize', hashes);
                sqliteHashes.forEach(h => cachedHashesFromSqlite.add(h.toLowerCase()));
                console.log(`[${LOG_PREFIX}] Found ${cachedHashesFromSqlite.size} hashes in SQLite cache`);
            }
        } catch (error) {
            console.error(`[${LOG_PREFIX} MONGO] Error getting cached hashes: ${error.message}`);
        }

        const cachedResults = await checkCache(apiKey, hashes);
        const cachedHashes = new Set(cachedResults.map(c => c.infoHash));
        const torrentsToProcess = torrents.filter(t => cachedHashes.has(t.InfoHash));

        const processedTorrentsPromises = torrentsToProcess.map(async (torrent) => {
            const cacheInfo = cachedResults.find(c => c.infoHash === torrent.InfoHash);
            const magnet = `magnet:?xt=urn:btih:${torrent.InfoHash}&dn=${encode(cacheInfo.name || torrent.Title || torrent.name || '')}`;

            if (type === 'series') {
                const directDownload = await getDirectDownloadLink(apiKey, magnet);
                if (!directDownload) {
                    return null;
                }

                if (directDownload.content && Array.isArray(directDownload.content) && directDownload.content.length > 0) {
                    // Multi-file torrent (pack).
                    const s = Number(season);
                    const e = Number(episode);

                    const videos = directDownload.content.filter(f => isVideo(f.path));
                    const episodeFile = videos.find(f => {
                        const pttInfo = PTT.parse(f.path);
                        return pttInfo.season === s && pttInfo.episode === e;
                    });

                    if (episodeFile) {
                        const definitiveTitle = `${cacheInfo.name}/${episodeFile.path}`;
                        return {
                            name: definitiveTitle,
                            info: PTT.parse(definitiveTitle),
                            size: episodeFile.size,
                            seeders: torrent.Seeders || torrent.seeders || 0,
                            url: magnet,
                            source: 'premiumize',
                            hash: (torrent.InfoHash || '').toLowerCase(),
                            tracker: torrent.Tracker || 'Cached',
                            isPersonal: false,
                            isCached: true,
                            languages: Array.isArray(torrent.Langs) ? torrent.Langs : [],
                        };
                    }
                    return null; // Pack doesn't contain the episode.
                }

                if (directDownload.location && isVideo(directDownload.filename)) {
                    const pttInfo = PTT.parse(directDownload.filename);
                    const s = Number(season);
                    const e = Number(episode);
                    if (pttInfo.season === s && pttInfo.episode === e) {
                        const definitiveTitle = cacheInfo.name;
                        return {
                            name: definitiveTitle,
                            info: PTT.parse(definitiveTitle),
                            size: cacheInfo.size,
                            seeders: torrent.Seeders || torrent.seeders || 0,
                            url: magnet,
                            source: 'premiumize',
                            hash: (torrent.InfoHash || '').toLowerCase(),
                            tracker: torrent.Tracker || 'Cached',
                            isPersonal: false,
                            isCached: true,
                            languages: Array.isArray(torrent.Langs) ? torrent.Langs : [],
                        };
                    }
                    return null;
                }
                
                return null;
            } else {
                // For movies
                const definitiveTitle = cacheInfo.name;
                return {
                    name: definitiveTitle,
                    info: PTT.parse(definitiveTitle),
                    size: cacheInfo.size,
                    seeders: torrent.Seeders || torrent.seeders || 0,
                    url: magnet,
                    source: 'premiumize',
                    hash: (torrent.InfoHash || '').toLowerCase(),
                    tracker: torrent.Tracker || 'Cached',
                    isPersonal: false,
                    isCached: true,
                    languages: Array.isArray(torrent.Langs) ? torrent.Langs : [],
                };
            }
        });

        const cachedTorrents = (await Promise.all(processedTorrentsPromises)).filter(Boolean);

        // Persist to SQLite cache
        try {
            if (sqliteCache?.isEnabled() && cachedTorrents.length > 0) {
                const upserts = [];
                for (const torrent of cachedTorrents) {
                    if (torrent?.hash) {
                        upserts.push({
                            service: 'premiumize',
                            hash: torrent.hash.toLowerCase(),
                            fileName: torrent.name || null,
                            size: torrent.size || null,
                            category: getQualityCategory(torrent.name || ''),
                            resolution: torrentUtils.getResolutionFromName(torrent.name || ''),
                            data: { source: 'cached' }
                        });
                    }
                }
                deferSqliteUpserts(uniqueUpserts(upserts));
            }
        } catch (error) {
            console.error(`[${LOG_PREFIX} MONGO] Error upserting cached torrents: ${error.message}`);
        }

        return cachedTorrents;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Search failed: ${error.message}`);
        abortController.abort();
        return [];
    }
}

async function checkCache(apiKey, hashes) {
    if (!hashes || hashes.length === 0) {
        return []
    }

    try {
        const url = `${BASE_URL}/cache/check`
        const body = `apikey=${apiKey}&${hashes.map(h => `items[]=${h}`).join('&')}`
        const response = await axiosWithProxy.post(url, body)

        if (response.data && response.data.status === 'success') {
            const cached = []
            for (let i = 0; i < hashes.length; i++) {
                if (response.data.response[i]) {
                    cached.push({
                        infoHash: hashes[i],
                        name: response.data.filename[i],
                        size: Number(response.data.filesize[i]) || 0,
                        source: 'premiumize',
                    })
                }
            }
            return cached
        } else {
            console.error('Premiumize checkCache failed:', response.data)
            return []
        }
    } catch (err) {
        return handleError(err)
    }
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
    if (!searchKey) {
        // Return all files when no search key is provided (for catalog)
        try {
            const files = await listFiles(apiKey);
            return files.map(file => ({
                id: file.id,
                name: file.name,
                info: PTT.parse(file.name),
                size: file.size,
                url: file.link || '',
                isPersonal: true,
                isCached: true,
                source: 'premiumize'
            }));
        } catch (error) {
            console.error(`[${LOG_PREFIX}] Downloads fetch error: ${error.message}`);
            return [];
        }
    }

    // Use existing search functionality when search key is provided
    return await searchPersonalFiles(apiKey, searchKey, threshold);
}

export default { listFiles, searchPersonalFiles, getTorrentDetails, checkCache, search, addMagnet, listTransfers, getDirectDownloadLink, searchDownloads }
