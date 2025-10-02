import axios from 'axios';
import PTT from './util/parse-torrent-title.js';
import { getCachedHashes, upsertCachedMagnet } from './common/mongo-cache.js';
import * as scrapers from './common/scrapers.js';
import * as config from './config.js';
import * as torrentUtils from './common/torrent-utils.js';
import { filterEpisode } from './util/filter-torrents.js';
import Cinemeta from './util/cinemeta.js';

const BASE_URL = 'https://debrider.app/api/v1';
const LOG_PREFIX = 'DBA';

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
        if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX, cfg));
        if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(key, signal, LOG_PREFIX, cfg));
        if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(key, signal, LOG_PREFIX, cfg));
        if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(key, signal, LOG_PREFIX, cfg));
        if (config.SNOWFL_ENABLED) scraperPromises.push(scrapers.searchSnowfl(key, signal, LOG_PREFIX, cfg));
    } else {
        for (const lang of selectedLanguages) {
            const cfg = { ...userConfig, Languages: [lang] };
            const key = baseSearchKey;
            if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
            if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
            if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
            if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
            if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX, cfg));
            if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(key, signal, LOG_PREFIX, cfg));
            if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(key, signal, LOG_PREFIX, cfg));
            if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(key, signal, LOG_PREFIX, cfg));
            if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(key, signal, LOG_PREFIX, cfg));
            if (config.SNOWFL_ENABLED) scraperPromises.push(scrapers.searchSnowfl(key, signal, LOG_PREFIX, cfg));
        }
    }

    try {
        const scraperResults = await Promise.all(scraperPromises);
        let torrents = [].concat(...scraperResults);
        if (type === 'series') {
            torrents = torrents.filter(torrent => filterEpisode(torrent, season, episode, cinemetaDetails));
        } else if (type === 'movie') {
            // Align with RD/AD: drop series-like titles first, then apply year sanity
            const beforeSeries = torrents.length;
            torrents = torrents.filter(t => {
                try {
                    const title = t.Title || t.name || '';
                    if (torrentUtils.isSeriesLikeTitle(title)) return false;
                    const parsed = PTT.parse(title) || {};
                    if (parsed.season != null || parsed.seasons) return false;
                } catch {}
                return true;
            });
            if (beforeSeries !== torrents.length) {
                console.log(`[${LOG_PREFIX}] Removed ${beforeSeries - torrents.length} series-like results for movie request.`);
            }
            if (cinemetaDetails.year) {
                const beforeYear = torrents.length;
                torrents = torrents.filter(t => torrentUtils.filterByYear(t, cinemetaDetails, LOG_PREFIX));
                if (beforeYear !== torrents.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}). Removed ${beforeYear - torrents.length} mismatched results.`);
                }
            }
        }
        const hashes = torrents.map(torrent => torrent.InfoHash).filter(Boolean);
        console.log(`[${LOG_PREFIX}] Found ${torrents.length} torrents from scrapers. Sending ${hashes.length} unique hashes to check cache.`);
        const cachedTorrents = await checkCache(apiKey, hashes);
        console.log(`[${LOG_PREFIX}] Found ${cachedTorrents.length} cached torrents on debrider.app.`);

        const mergedTorrents = cachedTorrents.flatMap(cachedTorrent => {
            const originalTorrent = torrents.find(t => t.InfoHash === cachedTorrent.infoHash);
            const videoFiles = cachedTorrent.files.filter(file => isVideo(file.name));

            if (videoFiles.length === 0) {
                return null;
            }

            if (videoFiles.length === 1) {
                const videoFile = videoFiles[0];
                return {
                    infoHash: cachedTorrent.infoHash,
                    name: originalTorrent ? originalTorrent.Title || originalTorrent.name : cachedTorrent.name,
                    size: videoFile.size,
                    url: videoFile.download_link,
                    source: 'debriderapp',
                    tracker: originalTorrent ? originalTorrent.Tracker : 'Cached',
                    Langs: originalTorrent ? originalTorrent.Langs : []
                };
            }

            // Handle packs
            const episodeFile = videoFiles.find(file => {
                const pttInfo = PTT.parse(file.name);
                return pttInfo.season === Number(season) && pttInfo.episode === Number(episode);
            });

            if (!episodeFile) {
                return null;
            }

            const pttInfo = PTT.parse(episodeFile.name);
            const episodeInfo = pttInfo.episode ? `S${String(pttInfo.season).padStart(2, '0')}E${String(pttInfo.episode).padStart(2, '0')}` : '';
            const quality = pttInfo.resolution || 'N/A';

            return {
                infoHash: cachedTorrent.infoHash,
                name: `${originalTorrent.Title}\\n${episodeInfo} ${quality}`,
                size: episodeFile.size,
                url: episodeFile.download_link,
                source: 'debriderapp',
                tracker: originalTorrent ? originalTorrent.Tracker : 'Cached',
                Langs: originalTorrent ? originalTorrent.Langs : [],
                fileName: episodeFile.name,
                bingeGroup: `debriderapp|${cachedTorrent.infoHash}`
            };
        }).filter(Boolean);

        return mergedTorrents;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Search failed: ${error.message}`);
        abortController.abort();
        return [];
    }
}

async function checkCache(apiKey, hashes) {
    if (hashes.length === 0) {
        return [];
    }
    try {
        const url = `${BASE_URL}/link/lookup`;
        const response = await axios.post(url, { data: hashes }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        
        if (response.data && Array.isArray(response.data.result)) {
            const cachedTorrents = [];
            response.data.result.forEach((item, index) => {
                if (item.cached) {
                    cachedTorrents.push({
                        infoHash: hashes[index],
                        ...item
                    });
                }
            });
            return cachedTorrents;
        }

        console.error(`[${LOG_PREFIX}] Invalid cache response from debrider.app:`, response.data);
        return [];
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error checking debrider.app cache: ${error.message}`);
        return [];
    }
}

function isVideo(filename) {
    if (typeof filename !== 'string') {
        return false;
    }
    const videoExtensions = ['.mkv', '.mp4', '.avi', 'mov', '.wmv', '.flv', '.webm'];
    return videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

export default { search };
