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

const BASE_URL = 'https://www.premiumize.me/api'
const LOG_PREFIX = 'PM';

async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
    console.log("Search files with searchKey: " + searchKey)

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
        const response = await axios.get(url)

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
        const url = `${BASE_URL}/transfer/directdl?apikey=${apiKey}&id=${id}`
        const response = await axios.get(url)

        if (response.data && response.data.status === 'success') {
            return toTorrentDetails({ ...response.data, id: id })
        } else {
            console.error(`Premiumize getTorrentDetails for id ${id} failed:`, response.data)
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
    const videos = (item.content || [])
        .filter(file => isVideo(file.path))
        .map(file => ({
            name: file.path.split('/').pop(),
            url: `${process.env.ADDON_URL}/resolve/Premiumize/null/${item.id}/${encode(file.stream_link)}`,
            size: file.size,
        }))

    if (videos.length === 0 && item.location && isVideo(item.filename)) {
        videos.push({
            name: item.filename,
            url: `${process.env.ADDON_URL}/resolve/Premiumize/null/${item.id}/${encode(item.location)}`,
            size: item.filesize,
        })
    }

    return {
        source: 'premiumize',
        id: item.id,
        name: item.filename,
        type: 'other',
        hash: item.id.toLowerCase(),
        size: item.filesize,
        videos: videos || []
    }
}

function handleError(err) {
    console.log(err)
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        return Promise.reject(BadTokenError)
    }
    return Promise.reject(err)
}

async function addMagnet(apiKey, magnetLink) {
    try {
        const url = `${BASE_URL}/transfer/create`
        const body = `apikey=${apiKey}&src=${encodeURIComponent(magnetLink)}`
        const response = await axios.post(url, body)
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
        const response = await axios.get(url)
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

    const abortController = new AbortController();
    const signal = abortController.signal;

    const scraperPromises = [];
    if (selectedLanguages.length === 0) {
        const cfg = { ...config, Languages: [] };
        const key = baseSearchKey;
        if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
        if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
        if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
    } else {
        for (const lang of selectedLanguages) {
            const cfg = { ...userConfig, Languages: [lang] };
            const key = baseSearchKey;
            if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
            if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
            if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
            if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
        }
    }

    try {
        const scraperResults = await Promise.all(scraperPromises);
        let torrents = [].concat(...scraperResults);
        if (type === 'series') {
            torrents = torrents.filter(torrent => filterEpisode(torrent, season, episode, cinemetaDetails));
        } else if (type === 'movie') {
            if (cinemetaDetails.year) {
                torrents = torrents.filter(t => torrentUtils.filterByYear(t, cinemetaDetails, LOG_PREFIX));
            }
        }
        const hashes = torrents.map(torrent => torrent.InfoHash).filter(Boolean);
        const cachedResults = await checkCache(apiKey, hashes);
        const cachedHashes = new Set(cachedResults.map(c => c.infoHash));
        const cachedTorrents = torrents
            .filter(t => cachedHashes.has(t.InfoHash))
            .map(t => {
                const cacheInfo = cachedResults.find(c => c.infoHash === t.InfoHash);
                return {
                    ...t,
                    name: cacheInfo.name, // Use name from cache
                    size: cacheInfo.size,   // Use size from cache
                    source: 'premiumize',
                    hash: t.InfoHash,
                    url: t.Url, // Keep magnet link for resolver
                };
            });

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
        const response = await axios.post(url, body)

        if (response.data && response.data.status === 'success') {
            const cached = []
            for (let i = 0; i < hashes.length; i++) {
                if (response.data.response[i]) {
                    cached.push({
                        infoHash: hashes[i],
                        name: response.data.filename[i],
                        size: torrentUtils.sizeToBytes(response.data.filesize[i]),
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

export default { listFiles, searchPersonalFiles, getTorrentDetails, checkCache, search, addMagnet, listTransfers }
