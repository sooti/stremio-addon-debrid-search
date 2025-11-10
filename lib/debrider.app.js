import axios from 'axios';
import PTT from './util/parse-torrent-title.js';
import * as scrapers from './common/scrapers.js';
import * as config from './config.js';
import * as torrentUtils from './common/torrent-utils.js';
import { filterEpisode } from './util/filter-torrents.js';
import Cinemeta from './util/cinemeta.js';
import { obfuscateSensitive } from './common/torrent-utils.js';
import searchCoordinator from './util/search-coordinator.js';
import Newznab from './newznab.js';
import { orchestrateScrapers } from './util/scraper-selector.js';
import * as sqliteCache from './util/sqlite-cache.js';
import * as debridHelpers from './util/debrid-helpers.js';
import debridProxyManager from './util/debrid-proxy.js';

const BASE_URL = 'https://debrider.app/api/v1';
const LOG_PREFIX = 'DBA';

// Use debrid-helpers functions
const norm = debridHelpers.norm;
const getQualityCategory = debridHelpers.getQualityCategory;
const addHashToSqlite = (hash, fileName = null, size = null, data = null) => debridHelpers.addHashToSqlite(hash, fileName, size, data, 'debriderapp');
const deferSqliteUpserts = debridHelpers.deferSqliteUpserts;
const uniqueUpserts = debridHelpers.uniqueUpserts;

// Helper to get axios with proxy config
const axiosWithProxy = axios.create(debridProxyManager.getAxiosConfig('debrider'));

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

    const abortController = debridHelpers.createAbortController();
    const signal = abortController.signal;

    try {
        // Execute coordinated scrapers to avoid duplicate work when multiple services run simultaneously
        const scraperResults = await searchCoordinator.executeSearch(
            'debriderapp',
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
            // Apply title matching to filter out unrelated movies
            if (cinemetaDetails.name) {
                const beforeTitleFilter = torrents.length;
                const normalizeTitle = (s) => String(s || '').toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
                const expectedTitle = normalizeTitle(cinemetaDetails.name);
                torrents = torrents.filter(torrent => {
                    try {
                        const title = torrent.Title || torrent.name || '';
                        const normalizedFullTitle = normalizeTitle(title);

                        // Check if the expected title words are present in the full torrent title
                        const expectedWords = expectedTitle.split(/\s+/).filter(w => w.length > 2);

                        // If no significant words (all words <= 2 chars), use all words
                        const wordsToMatch = expectedWords.length > 0 ? expectedWords : expectedTitle.split(/\s+/).filter(w => w.length > 0);

                        const matchingWords = wordsToMatch.filter(word => normalizedFullTitle.includes(word));

                        // Require at least 50% of significant words to match, or all words if title has 1-2 words
                        const requiredMatches = wordsToMatch.length <= 2 ? wordsToMatch.length : Math.ceil(wordsToMatch.length * 0.5);
                        return matchingWords.length >= requiredMatches;
                    } catch {
                        return true; // If parsing fails, keep the torrent to be safe
                    }
                });
                if (beforeTitleFilter !== torrents.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by title matching "${cinemetaDetails.name}". Removed ${beforeTitleFilter - torrents.length} unrelated results.`);
                }
            }
        }
        const hashes = torrents.map(torrent => torrent.InfoHash).filter(Boolean);
        console.log(`[${LOG_PREFIX}] Found ${torrents.length} torrents from scrapers. Sending ${hashes.length} unique hashes to check cache.`);

        // Check SQLite cache first
        let cachedHashesFromSqlite = new Set();
        try {
            if (sqliteCache?.isEnabled()) {
                const sqliteHashes = await sqliteCache.getCachedHashes('debriderapp', hashes);
                sqliteHashes.forEach(h => cachedHashesFromSqlite.add(h.toLowerCase()));
                console.log(`[${LOG_PREFIX}] Found ${cachedHashesFromSqlite.size} hashes in SQLite cache`);
            }
        } catch (error) {
            console.error(`[${LOG_PREFIX} MONGO] Error getting cached hashes: ${error.message}`);
        }

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

        // Persist to SQLite cache
        try {
            if (sqliteCache?.isEnabled() && mergedTorrents.length > 0) {
                const upserts = [];
                for (const torrent of mergedTorrents) {
                    if (torrent?.infoHash) {
                        upserts.push({
                            service: 'debriderapp',
                            hash: torrent.infoHash.toLowerCase(),
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
        const response = await axiosWithProxy.post(url, { data: hashes }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        
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
        const response = await axiosWithProxy.get(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 10000
        });

        // Handle different response structures
        let tasks = [];
        if (response.data && Array.isArray(response.data.data)) {
            tasks = response.data.data;
        } else if (response.data && Array.isArray(response.data.result)) {
            tasks = response.data.result;
        } else if (Array.isArray(response.data)) {
            tasks = response.data;
        } else {
            console.error(`[${LOG_PREFIX}] Invalid tasks response:`, response.data);
            return [];
        }

        console.log(`[${LOG_PREFIX}] DEBUG - Retrieved ${tasks.length} tasks from Personal Cloud`);
        tasks.forEach((task, idx) => {
            console.log(`[${LOG_PREFIX}] DEBUG - Task ${idx + 1}:`, JSON.stringify({
                id: task.id,
                name: task.name,
                status: task.status,
                type: task.type,
                filesCount: task.files?.length || 0,
                files: task.files?.map(f => ({ name: f.name, size: f.size, path: f.path })) || []
            }, null, 2));
        });

        return tasks;
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

        const response = await axiosWithProxy.post(url, {
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

    console.log(`[${LOG_PREFIX}] DEBUG - Matching personal files for: ${cinemetaDetails.name} (${type})`);
    if (type === 'series') {
        console.log(`[${LOG_PREFIX}] DEBUG - Looking for: Season ${season}, Episode ${episode}`);
    }

    for (const task of tasks) {
        console.log(`[${LOG_PREFIX}] DEBUG - Checking task: ${task.name || task.title}`);

        // Skip if not completed or no files
        if (!task.files || task.files.length === 0) {
            console.log(`[${LOG_PREFIX}] DEBUG - ✗ No files in task`);
            continue;
        }

        const videoFiles = task.files.filter(file => isVideo(file.name || file.path));
        console.log(`[${LOG_PREFIX}] DEBUG - Found ${videoFiles.length} video files:`, videoFiles.map(f => f.name || f.path));

        if (videoFiles.length === 0) continue;

        // For movies, check each video file name for title match
        if (type === 'movie') {
            // Normalize title for matching (remove special chars, lowercase, remove spaces)
            const normalizeTitle = (str) => str.toLowerCase()
                .replace(/[:\-_.]/g, ' ')  // Replace separators with space
                .replace(/\s+/g, ' ')       // Normalize multiple spaces
                .trim();

            const normalizedSearchTitle = normalizeTitle(cinemetaDetails.name);

            for (const videoFile of videoFiles) {
                const fileName = videoFile.name || videoFile.path || '';
                const normalizedFileName = normalizeTitle(fileName);

                // Check if the normalized filename contains the normalized title
                const titleMatch = normalizedFileName.includes(normalizedSearchTitle);

                console.log(`[${LOG_PREFIX}] DEBUG - Checking file: ${fileName}`);
                console.log(`[${LOG_PREFIX}] DEBUG - Normalized: "${normalizedFileName}" vs "${normalizedSearchTitle}"`);
                console.log(`[${LOG_PREFIX}] DEBUG - Movie title match: ${titleMatch}`);

                if (titleMatch) {
                    console.log(`[${LOG_PREFIX}] DEBUG - ✓ MATCH! Adding personal movie stream`);
                    streams.push({
                        name: fileName,
                        size: videoFile.size,
                        url: videoFile.download_link || videoFile.url,
                        source: 'personalcloud',
                        tracker: 'Personal',
                        Langs: [],
                        isPersonal: true
                    });
                }
            }
        }
        // For series, check each video file for season/episode match
        else if (type === 'series') {
            for (const videoFile of videoFiles) {
                const fileName = videoFile.name || videoFile.path || '';
                const parsed = PTT.parse(fileName);
                console.log(`[${LOG_PREFIX}] DEBUG - Checking file: ${fileName}`);
                console.log(`[${LOG_PREFIX}] DEBUG - Parsed file: season=${parsed.season}, episode=${parsed.episode}`);

                if (parsed.season === Number(season) && parsed.episode === Number(episode)) {
                    console.log(`[${LOG_PREFIX}] DEBUG - ✓ MATCH! Season and episode match`);
                    streams.push({
                        name: fileName,
                        size: videoFile.size,
                        url: videoFile.download_link || videoFile.url,
                        source: 'personalcloud',
                        tracker: 'Personal',
                        Langs: [],
                        isPersonal: true,
                        fileName: fileName
                    });
                } else {
                    console.log(`[${LOG_PREFIX}] DEBUG - ✗ No match (wanted S${season}E${episode}, got S${parsed.season}E${parsed.episode})`);
                }
            }
        }
    }

    console.log(`[${LOG_PREFIX}] DEBUG - Total personal streams found: ${streams.length}`);
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
        // Only fetch personal cloud if enablePersonalCloud is not explicitly disabled
        let personalStreams = [];
        if (userConfig.enablePersonalCloud !== false) {
            const existingTasks = await getTasks(apiKey, baseUrl);
            console.log(`[${LOG_PREFIX}] Found ${existingTasks.length} existing tasks in Personal Cloud`);

            // Get personal streams from existing files
            personalStreams = getPersonalStreams(existingTasks, type, id, cinemetaDetails);
            console.log(`[${LOG_PREFIX}] Found ${personalStreams.length} personal cloud streams`);
        } else {
            console.log(`[${LOG_PREFIX}] Personal cloud disabled for this service, skipping personal files`);
        }

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
    activeNzbDownloads,
    getPersonalStreams
};
