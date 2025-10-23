import axios from 'axios';
import PTT from './util/parse-torrent-title.js';
import { getCachedHashes, upsertCachedMagnet } from './common/mongo-cache.js';
import * as scrapers from './common/scrapers.js';
import * as config from './config.js';
import * as torrentUtils from './common/torrent-utils.js';
import { filterEpisode } from './util/filter-torrents.js';
import Cinemeta from './util/cinemeta.js';
import { obfuscateSensitive } from './common/torrent-utils.js';
import searchCoordinator from './util/search-coordinator.js';
import Newznab from './newznab.js';

const BASE_URL = 'https://debrider.app/api/v1';
const LOG_PREFIX = 'DBA';

// Track active NZB downloads: taskId -> { startTime, lastCheck, config }
const activeNzbDownloads = new Map();

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

    try {
        // Execute coordinated scrapers to avoid duplicate work when multiple services run simultaneously
        const scraperResults = await searchCoordinator.executeSearch(
            'debriderapp',
            async () => {
                const scraperPromises = [];
                if (selectedLanguages.length === 0) {
                    const cfg = { ...userConfig, Languages: [] };
                    const key = baseSearchKey;
                    if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(key, signal, LOG_PREFIX, cfg));
                    if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(key, signal, LOG_PREFIX, cfg));
                    if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX, cfg));
                    if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX, cfg));
                    if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX, cfg));
                    if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(key, signal, LOG_PREFIX, cfg));
                    if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(key, signal, LOG_PREFIX, cfg));
                    if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(key, signal, LOG_PREFIX, cfg));
                    if (config.TORRENT9_ENABLED) scraperPromises.push(scrapers.searchTorrent9(key, signal, LOG_PREFIX, cfg));
                    if (config.TORRENT_1337X_ENABLED) scraperPromises.push(scrapers.search1337x(key, signal, LOG_PREFIX, cfg));
                    if (config.BTDIG_ENABLED) scraperPromises.push(scrapers.searchBtdig(key, signal, LOG_PREFIX, cfg));
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
                        if (config.TORRENT9_ENABLED) scraperPromises.push(scrapers.searchTorrent9(key, signal, LOG_PREFIX, cfg));
                        if (config.TORRENT_1337X_ENABLED) scraperPromises.push(scrapers.search1337x(key, signal, LOG_PREFIX, cfg));
                        if (config.BTDIG_ENABLED) scraperPromises.push(scrapers.searchBtdig(key, signal, LOG_PREFIX, cfg));
                        if (config.SNOWFL_ENABLED) scraperPromises.push(scrapers.searchSnowfl(key, signal, LOG_PREFIX, cfg));
                    }
                }
                return await Promise.all(scraperPromises);
            },
            type,
            id,
            userConfig
        );
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

            return {
                infoHash: cachedTorrent.infoHash,
                name: originalTorrent ? originalTorrent.Title || originalTorrent.name : cachedTorrent.name,
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

/**
 * Get tasks from Personal Cloud API
 * @param {string} apiKey - API key
 * @param {string} baseUrl - Base URL (defaults to BASE_URL)
 * @returns {Promise<Array>} - Array of tasks
 */
async function getTasks(apiKey, baseUrl = BASE_URL) {
    try {
        const url = `${baseUrl}/tasks`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 10000
        });

        // Handle different response structures
        if (response.data && Array.isArray(response.data.data)) {
            return response.data.data;
        } else if (response.data && Array.isArray(response.data.result)) {
            return response.data.result;
        } else if (Array.isArray(response.data)) {
            return response.data;
        }

        console.error(`[${LOG_PREFIX}] Invalid tasks response:`, response.data);
        return [];
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error getting tasks: ${error.message}`);
        return [];
    }
}

/**
 * Create a new NZB task in Personal Cloud
 * @param {string} apiKey - API key
 * @param {string} nzbContent - NZB file content (will be base64 encoded)
 * @param {string} baseUrl - Base URL (defaults to BASE_URL)
 * @returns {Promise<object>} - Task info
 */
async function createNzbTask(apiKey, nzbContent, baseUrl = BASE_URL) {
    try {
        const url = `${baseUrl}/tasks`;

        // Convert NZB content to base64 if not already
        const base64Content = Buffer.from(nzbContent).toString('base64');

        const response = await axios.post(url, {
            type: 'nzb',
            data: base64Content
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 30000
        });

        console.log(`[${LOG_PREFIX}] API Response:`, JSON.stringify(response.data));

        // Handle different response structures
        let taskId;
        let result;

        if (response.data && response.data.data) {
            // Response format: { message: '...', data: { id: '...', ... } }
            result = response.data.data;
            taskId = result.id || result.task_id;
        } else if (response.data && response.data.result) {
            // Response format: { result: { id: '...', ... } }
            result = response.data.result;
            taskId = result.id || result.task_id;
        } else if (response.data && response.data.id) {
            // Direct response format: { id: '...', ... }
            result = response.data;
            taskId = result.id || result.task_id;
        } else if (response.data && response.data.task_id) {
            result = response.data;
            taskId = response.data.task_id;
        }

        if (!taskId) {
            console.error(`[${LOG_PREFIX}] Cannot find task ID in response:`, response.data);
            throw new Error('Invalid response from Personal Cloud - no task ID found');
        }

        console.log(`[${LOG_PREFIX}] Created NZB task: ${taskId}`);

        // Track the task
        activeNzbDownloads.set(taskId, {
            startTime: Date.now(),
            lastCheck: Date.now(),
            apiKey,
            baseUrl
        });

        return {
            taskId,
            status: 'created',
            ...result
        };
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error creating NZB task: ${error.message}`);
        throw error;
    }
}

/**
 * Submit NZB from URL to Personal Cloud (fetches NZB from Newznab first)
 * @param {string} apiKey - API key
 * @param {string} nzbUrl - URL to NZB
 * @param {string} newznabApiKey - Newznab API key for fetching
 * @param {string} baseUrl - Base URL (defaults to BASE_URL)
 * @returns {Promise<object>} - Task info
 */
async function submitNzb(apiKey, nzbUrl, newznabApiKey, baseUrl = BASE_URL) {
    try {
        console.log(`[${LOG_PREFIX}] Fetching NZB from: ${obfuscateSensitive(nzbUrl, newznabApiKey)}`);
        const nzbContent = await Newznab.getNzbContent(nzbUrl, newznabApiKey);

        return await createNzbTask(apiKey, nzbContent, baseUrl);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error submitting NZB: ${error.message}`);
        throw error;
    }
}

/**
 * Wait for task to complete and get video file
 * @param {string} apiKey - API key
 * @param {string} taskId - Task ID
 * @param {string} baseUrl - Base URL (defaults to BASE_URL)
 * @param {number} maxWaitTime - Maximum wait time in ms
 * @returns {Promise<object>} - Task info with video file
 */
async function waitForTaskCompletion(apiKey, taskId, baseUrl = BASE_URL, maxWaitTime = 300000) {
    const startTime = Date.now();
    const pollInterval = 3000; // 3 seconds

    console.log(`[${LOG_PREFIX}] Waiting for task ${taskId} to complete...`);

    while (Date.now() - startTime < maxWaitTime) {
        const tasks = await getTasks(apiKey, baseUrl);
        const task = tasks.find(t => t.id === taskId || t.task_id === taskId);

        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        // Update last check time
        if (activeNzbDownloads.has(taskId)) {
            const downloadInfo = activeNzbDownloads.get(taskId);
            downloadInfo.lastCheck = Date.now();
        }

        // Check if task has video files
        if (task.files && task.files.length > 0) {
            const videoFiles = task.files.filter(file => isVideo(file.name || file.path));
            if (videoFiles.length > 0) {
                console.log(`[${LOG_PREFIX}] Task ${taskId} has ${videoFiles.length} video file(s) available`);
                return {
                    taskId,
                    status: 'ready',
                    task,
                    videoFiles
                };
            }
        }

        console.log(`[${LOG_PREFIX}] Task ${taskId} still processing...`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Timeout waiting for task ${taskId} to complete`);
}

/**
 * Check personal files in tasks for matching content
 * @param {Array} tasks - Array of tasks from Personal Cloud
 * @param {string} type - Content type
 * @param {string} id - Content ID
 * @param {object} cinemetaDetails - Cinemeta details
 * @returns {Array} - Array of personal file streams
 */
function getPersonalStreams(tasks, type, id, cinemetaDetails) {
    const streams = [];
    const [imdbId, season, episode] = id.split(':');

    for (const task of tasks) {
        // Skip if not completed or no files
        if (!task.files || task.files.length === 0) continue;

        const videoFiles = task.files.filter(file => isVideo(file.name || file.path));
        if (videoFiles.length === 0) continue;

        // Match by name/title
        const taskName = task.name || task.title || '';
        const parsed = PTT.parse(taskName);

        // For movies, match by title and year
        if (type === 'movie') {
            if (taskName.toLowerCase().includes(cinemetaDetails.name.toLowerCase())) {
                const largestFile = videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
                streams.push({
                    name: taskName,
                    size: largestFile.size,
                    url: largestFile.download_link || largestFile.url,
                    source: 'debriderapp',
                    tracker: 'Personal',
                    Langs: [],
                    isPersonal: true
                });
            }
        }
        // For series, match by season and episode
        else if (type === 'series') {
            if (parsed.season === Number(season)) {
                // For full season packs, find specific episode
                if (!parsed.episode) {
                    const episodeFile = videoFiles.find(file => {
                        const fileParsed = PTT.parse(file.name || file.path);
                        return fileParsed.season === Number(season) && fileParsed.episode === Number(episode);
                    });
                    if (episodeFile) {
                        streams.push({
                            name: taskName,
                            size: episodeFile.size,
                            url: episodeFile.download_link || episodeFile.url,
                            source: 'debriderapp',
                            tracker: 'Personal',
                            Langs: [],
                            isPersonal: true,
                            fileName: episodeFile.name || episodeFile.path
                        });
                    }
                }
                // Single episode
                else if (parsed.episode === Number(episode)) {
                    const largestFile = videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
                    streams.push({
                        name: taskName,
                        size: largestFile.size,
                        url: largestFile.download_link || largestFile.url,
                        source: 'debriderapp',
                        tracker: 'Personal',
                        Langs: [],
                        isPersonal: true
                    });
                }
            }
        }
    }

    return streams;
}

/**
 * Search with Personal Cloud support - returns both cached torrents and Newznab NZB results
 * When user selects an NZB result, it will be submitted to Personal Cloud via the resolve endpoint
 * @param {string} apiKey - API key
 * @param {string} type - Content type
 * @param {string} id - Content ID
 * @param {object} userConfig - User configuration (can include newznabUrl and newznabApiKey)
 * @param {string} baseUrl - Base URL (defaults to BASE_URL)
 * @returns {Promise<Array>} - Array of streams including personal files, cached torrents, and NZB results
 */
async function searchWithPersonalCloud(apiKey, type, id, userConfig = {}, baseUrl = BASE_URL) {
    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) {
        console.error(`[${LOG_PREFIX}] Could not get metadata for ${id}. Aborting search.`);
        return [];
    }

    try {
        // First, check Personal Cloud for existing tasks/files
        const existingTasks = await getTasks(apiKey, baseUrl);
        console.log(`[${LOG_PREFIX}] Found ${existingTasks.length} existing tasks in Personal Cloud`);

        // Get personal streams from existing files
        const personalStreams = getPersonalStreams(existingTasks, type, id, cinemetaDetails);
        console.log(`[${LOG_PREFIX}] Found ${personalStreams.length} personal cloud streams`);

        // Do the regular search for cached torrents
        const regularStreams = await search(apiKey, type, id, userConfig);

        // If Newznab is configured, search for NZBs
        let newznabStreams = [];
        if (userConfig.newznabUrl && userConfig.newznabApiKey) {
            console.log(`[${LOG_PREFIX}] Searching Newznab for NZBs...`);
            try {
                let query = '';
                let category = '';

                if (type === 'movie') {
                    query = cinemetaDetails.name
                        .replace(/:/g, '')
                        .replace(/[^\w\s-]/g, '')
                        .trim();
                    category = '2000';
                } else if (type === 'series') {
                    const paddedSeason = String(season).padStart(2, '0');
                    const paddedEpisode = String(episode).padStart(2, '0');
                    const cleanName = cinemetaDetails.name
                        .replace(/:/g, '')
                        .replace(/[^\w\s-]/g, '')
                        .trim();
                    query = `${cleanName} S${paddedSeason}E${paddedEpisode}`;
                    category = '5000';
                }

                const nzbResults = await Newznab.search(userConfig.newznabUrl, userConfig.newznabApiKey, query, { category, limit: 50, type });
                console.log(`[${LOG_PREFIX}] Found ${nzbResults.length} NZB results from Newznab`);

                // Transform NZB results to stream format with special marker
                newznabStreams = nzbResults.map(nzb => ({
                    name: nzb.title,
                    size: nzb.size,
                    url: `nzb:${nzb.nzbUrl || nzb.downloadUrl}`, // Special prefix to identify NZB URLs
                    source: 'newznab',
                    tracker: 'Newznab',
                    Langs: [],
                    nzbUrl: nzb.nzbUrl || nzb.downloadUrl,
                    nzbTitle: nzb.title
                }));
            } catch (error) {
                console.error(`[${LOG_PREFIX}] Newznab search error: ${error.message}`);
            }
        }

        // Combine: personal files first, then cached torrents, then NZB results
        const allStreams = [...personalStreams, ...regularStreams, ...newznabStreams];
        console.log(`[${LOG_PREFIX}] Total streams: ${allStreams.length} (${personalStreams.length} personal, ${regularStreams.length} cached, ${newznabStreams.length} NZBs)`);

        return allStreams;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Search with Personal Cloud failed: ${error.message}`);
        // Fallback to regular search if Personal Cloud fails
        return await search(apiKey, type, id, userConfig);
    }
}

export default {
    search,
    searchWithPersonalCloud,
    getTasks,
    createNzbTask,
    submitNzb,
    waitForTaskCompletion,
    activeNzbDownloads
};
