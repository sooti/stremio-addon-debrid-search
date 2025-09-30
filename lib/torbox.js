import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import { getCachedHashes as mongoGetCachedHashes, upsertCachedMagnet as mongoUpsert, default as mongoCache } from './common/mongo-cache.js';

const { getHashFromMagnet, filterByYear, delay, isValidVideo, isValidTorrentTitle } = torrentUtils;
const LOG_PREFIX = 'TB';
const TB_BASE_URL = 'https://api.torbox.app/v1';
const TIMEOUT = 15000;

// ===================================================================================
// --- 1. CORE SEARCH ORCHESTRATOR ---
// ===================================================================================
async function searchTorboxTorrents(apiKey, type, id, userConfig = {}) {
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
    const seriesCtx = type === 'series' ? buildSeriesContext({ search: specificSearchKey, cinemetaTitle: cinemetaDetails.name }) : null;

    console.log(`[${LOG_PREFIX}] Starting unified search for: "${specificSearchKey}"`);

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
        console.time(`[${LOG_PREFIX}] Total search time`);
        let [personalFiles, ...scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, searchKey),
            ...scraperPromises
        ]);
        console.timeEnd(`[${LOG_PREFIX}] Total search time`);
        
        if (type === 'series' && episodeInfo) {
            const originalCount = personalFiles.length;
            personalFiles = personalFiles.filter(file => {
                const parsed = PTT.parse(file.name || '');
                return parsed.season === episodeInfo.season && parsed.episode === episodeInfo.episode;
            });
            if (personalFiles.length < originalCount) {
                console.log(`[${LOG_PREFIX}] Filtered personal files for S${episodeInfo.season}E${episodeInfo.episode}: ${originalCount} -> ${personalFiles.length}`);
            }
        }
        
        if (seriesCtx) {
            scraperResults = scraperResults.map(list => list.filter(t => matchesCandidateTitle(t, seriesCtx)));
            const s = seriesCtx.season, e = seriesCtx.episode;
            if (Number.isFinite(s) && Number.isFinite(e)) {
                scraperResults = scraperResults.map(list => list.filter(t => {
                    try {
                        const p = PTT.parse(t.Title || t.name || '');
                        if (p && p.season != null && p.episode != null) {
                            return Number(p.season) === Number(s) && Number(p.episode) === Number(e);
                        }
                        if (p && p.season != null && (p.episode === undefined || Array.isArray(p.episode))) {
                            return Number(p.season) === Number(s);
                        }
                    } catch {}
                    return matchesCandidateTitle(t, seriesCtx);
                }));
            }
        }
        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, episodeInfo, cinemetaDetails, seriesCtx);
	console.log('combined results: ', combinedResults)

        if (type === 'movie' && cinemetaDetails.year) {
            const originalCount = combinedResults.length;
            const filtered = combinedResults.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
            console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}). Removed ${originalCount - filtered.length} mismatched results.`);
            return filtered;
        }

        console.log(`[${LOG_PREFIX}] Returning a combined total of ${combinedResults.length} unique streams.`);
        return combinedResults;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] A scraper may have failed, cancelling other requests: ${error.message}`);
        abortController.abort();
        const completedResults = await Promise.all(scraperPromises.map(p => p.catch(() => [])));
        const personalFiles = await searchPersonalFiles(apiKey, searchKey);
        return await combineAndMarkResults(apiKey, personalFiles, completedResults, episodeInfo, cinemetaDetails);
    }
}

// ===================================================================================
// --- 2. SEARCH & COMBINE LOGIC ---
// ===================================================================================
function isPack(torrent) {
    try {
        const parsed = PTT.parse(torrent.Title || torrent.name || '');
        return parsed.season !== undefined && (parsed.episode === undefined || Array.isArray(parsed.episode));
    } catch {
        return false;
    }
}

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
        });
        console.log(`[${LOG_PREFIX}] Personal files search found ${strictResults.length} results for "${searchKey}".`);
        return strictResults;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Personal files search error: ${error.message}`);
        return [];
    } finally {
        console.timeEnd(`[${LOG_PREFIX} TIMER] Personal Cloud`);
    }
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources, episodeInfo = null, cinemetaDetails, seriesCtx = null) {
    // --- Initial Setup and Merging ---
    const externalTorrentsRaw = [].concat(...externalSources);
    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    const markedPersonal = personalFiles.map(file => ({ ...file, isPersonal: true, tracker: 'Personal' }));
    
    const uniqueExternalTorrents = [...new Map(externalTorrentsRaw.map(t => [
        (t.InfoHash || t.infoHash || t.hash || '').toString().toLowerCase(),
        t
    ])).values()];
    console.log(`[TB DEBUG] Started with ${uniqueExternalTorrents.length} unique external torrents.`);

    // --- Filter 1: Title/Episode Matching (generic + strict)
    let episodeFiltered = uniqueExternalTorrents;
    if (seriesCtx) {
        episodeFiltered = uniqueExternalTorrents.filter(t => matchesCandidateTitle(t, seriesCtx));
        const beforeStrict = episodeFiltered.length;
        const s = seriesCtx.season, e = seriesCtx.episode;
        if (Number.isFinite(s) && Number.isFinite(e)) {
            episodeFiltered = episodeFiltered.filter(t => {
                try {
                    const p = PTT.parse(t.Title || t.name || '');
                    if (p && p.season != null && p.episode != null) {
                        return Number(p.season) === Number(s) && Number(p.episode) === Number(e);
                    }
                    if (p && p.season != null && (p.episode === undefined || Array.isArray(p.episode))) {
                        return Number(p.season) === Number(s);
                    }
                } catch {}
                return matchesCandidateTitle(t, seriesCtx);
            });
        }
        console.log(`[${LOG_PREFIX}] ${episodeFiltered.length} torrents remain after title/episode prefilter (strict cut from ${beforeStrict}).`);
    }

    // --- Filter 2: Basic Title Validity ---
    const validTitleTorrents = episodeFiltered.filter(t => isValidTorrentTitle(t.Title, LOG_PREFIX));
    console.log(`[TB DEBUG] ${validTitleTorrents.length} torrents remain after basic title validation.`);

    // --- Filter 3: (use generic matcher again; remove bespoke franchise filter)
    let franchiseFiltered = validTitleTorrents;
    if (seriesCtx) {
        franchiseFiltered = validTitleTorrents.filter(t => matchesCandidateTitle(t, seriesCtx));
    }
    console.log(`[TB DEBUG] ${franchiseFiltered.length} torrents remain after generic matching.`);
    
    // --- Filter 4: Check TorBox Cache ---
    const hashesToCheck = franchiseFiltered
        .map(t => (t.InfoHash || t.infoHash || t.hash || '').toString().toLowerCase())
        .filter(Boolean);
    // Prefer local Mongo cache to save API calls
    let cachedHashes = new Set();
    try {
        if (mongoCache?.isEnabled()) {
            const local = await mongoGetCachedHashes('torbox', hashesToCheck);
            local.forEach(h => cachedHashes.add(h));
        }
    } catch {}
    const remaining = hashesToCheck.filter(h => !cachedHashes.has(h));
    if (remaining.length > 0) {
        const remote = await checkTorboxCache(apiKey, remaining);
        remote.forEach(h => cachedHashes.add(h));
    }
    console.log(`[TB] Found ${cachedHashes.size} cached torrents from ${hashesToCheck.length} unique candidates.`);

        const cachedTorrents = franchiseFiltered.filter(t => {
            const ih = (t.InfoHash || t.infoHash || t.hash || '').toString().toLowerCase();
            return ih && cachedHashes.has(ih);
        });
    
    // --- Process Cached Torrents with Safety Check ---
    const cachedSingleFiles = [];
    const cachedPacks = [];
    const JUNK_EXTENSIONS = ['.exe', '.iso', '.rar', '.zip', '.img', '.scr'];

    for (const torrent of cachedTorrents) {
        const titleLower = (torrent.Title || torrent.name || '').toLowerCase();
        // New safety check for junk extensions.
        if (JUNK_EXTENSIONS.some(ext => titleLower.endsWith(ext))) {
            console.log(`[TB DEBUG] REJECTED (junk extension): ${torrent.Title}`);
            continue; // Skip this torrent entirely
        }

        if (isPack(torrent)) {
            cachedPacks.push(torrent);
        } else {
            cachedSingleFiles.push(torrent);
        }
    }
    console.log(`[TB DEBUG] Divided cached torrents into ${cachedSingleFiles.length} single files and ${cachedPacks.length} packs.`);
    
    const packResults = await inspectCachedPacks(apiKey, cachedPacks, episodeInfo);
    console.log(`[TB DEBUG] Pack inspection found ${packResults.length} matching episode files.`);

    // --- Final Combination ---
    const finalExternalResults = [...cachedSingleFiles, ...packResults].map(formatExternalResult);
    const combined = [...markedPersonal, ...finalExternalResults];
    
    const finalUniqueResults = [...new Map(combined.map(item => [item.hash, item])).values()];
    console.log(`[TB DEBUG] Final combined list has ${finalUniqueResults.length} unique items before returning.`);
    
    // Persist to Mongo cache
    try {
        if (mongoCache?.isEnabled()) {
            const toPersist = finalExternalResults;
            for (const r of toPersist) {
                if (r?.hash) {
                    await mongoUpsert({ service: 'torbox', hash: r.hash.toLowerCase(), fileName: r.name || null, size: r.size || null, data: r.episodeFileHint || null });
                }
            }
        }
    } catch {}

    return finalUniqueResults;
}

async function inspectCachedPacks(apiKey, packs, episodeInfo) {
    if (!episodeInfo || packs.length === 0) {
        return [];
    }
    const { season, episode } = episodeInfo;
    const results = [];
    console.log(`[${LOG_PREFIX} PACK INSPECT] Starting inspection for ${packs.length} cached packs.`);

    for (const pack of packs) {
        try {
            console.log(`[${LOG_PREFIX} PACK INSPECT] 🔍 Inspecting pack: ${pack.Title}`);
            
            const torrentInfo = await getTorrentInfoFromCache(apiKey, pack.InfoHash);
            if (!torrentInfo || !torrentInfo.files) {
                console.log(`[${LOG_PREFIX} PACK INSPECT] ❌ Could not retrieve file list for pack ${pack.InfoHash}`);
                continue;
            };

            const matchingFiles = torrentInfo.files.filter(file => {
                if (!isValidVideo(file.name, file.size, undefined, LOG_PREFIX)) return false;
                const parsed = PTT.parse(file.name) || {};
                return parsed.season === season && parsed.episode === episode;
            });

            if (matchingFiles.length > 0) {
                matchingFiles.sort((a, b) => b.size - a.size);
                const bestFile = matchingFiles[0];
                console.log(`[${LOG_PREFIX} PACK INSPECT] ✅ Found matching file: ${bestFile.name}`);
                results.push({
                    ...pack,
                    Title: bestFile.name,
                    Size: bestFile.size,
                    Tracker: 'Pack Inspection',
                    episodeFileHint: {
                        filePath: bestFile.name,
                        fileBytes: bestFile.size,
                        torrentId: torrentInfo.id,
                        fileId: bestFile.id
                    }
                });
            }
        } catch (error) {
            console.error(`[${LOG_PREFIX} PACK INSPECT] 💥 Error inspecting pack ${pack.InfoHash}: ${error.message}`);
        }
    }
    return results;
}

async function checkTorboxCache(apiKey, hashes) {
    if (!hashes || hashes.length === 0) return new Set();
    const url = `${TB_BASE_URL}/api/torrents/checkcached`;
    const headers = getHeaders(apiKey);
    try {
        const response = await axios.post(url, { hashes }, { headers });
        if (response.data?.success && typeof response.data.data === 'object') {
            return new Set(Object.keys(response.data.data));
        }
        return new Set();
    } catch (error) {
        console.error(`[${LOG_PREFIX}] !! FATAL: TorBox cache check failed.`);
        return new Set();
    }
}

function formatExternalResult(result) {
    const ih = (result.InfoHash || result.infoHash || result.hash || '').toString().toLowerCase();
    let finalUrl = ih ? `magnet:?xt=urn:btih:${ih}` : (result.url || '');

    if (ih && result.episodeFileHint) {
        try {
            const hintPayload = { hash: ih, ...result.episodeFileHint };
            const encodedHint = Buffer.from(JSON.stringify(hintPayload)).toString('base64');
            finalUrl = `${finalUrl}||HINT||${encodedHint}`;
        } catch {}
    }

    const name = result.Title || result.name || 'Unknown Title';
    return {
        name,
        info: PTT.parse(name) || { title: name },
        size: result.Size || result.size || result.filesize || 0,
        seeders: result.Seeders,
        url: finalUrl,
        source: 'torbox',
        hash: ih,
        tracker: result.Tracker,
        languages: Array.isArray(result.Langs) ? result.Langs : [],
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
            let targetFilePath = null;
            if (hostUrl.includes('||HINT||')) {
                const parts = hostUrl.split('||HINT||');
                hostUrl = parts[0];
                const hintPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                targetFilePath = hintPayload.filePath;
                console.log(`[${LOG_PREFIX} RESOLVER] Pack hint found. Target file: "${targetFilePath}"`);
            }
            
            const infoHash = getHashFromMagnet(hostUrl);
            console.log(`[${LOG_PREFIX} RESOLVER] Adding magnet with hash: ${infoHash}`);
            
            const addResponse = await addToTorbox(apiKey, hostUrl);
            if (!addResponse.torrent_id && !addResponse.queued_id) {
                throw new Error('Failed to add magnet to Torbox. Response: ' + JSON.stringify(addResponse));
            }
            console.log(`[${LOG_PREFIX} RESOLVER] Magnet added. Waiting for download to complete...`);
            
            const readyTorrent = await waitForTorrentReady(apiKey, infoHash);
            if (!readyTorrent) throw new Error('Torrent did not become ready in time.');
            console.log(`[${LOG_PREFIX} RESOLVER] Torrent is ready: "${readyTorrent.name}"`);

            let targetFile;
            if (targetFilePath) {
                targetFile = readyTorrent.files.find(f => f.name.toLowerCase().endsWith(targetFilePath.toLowerCase()));
            } else {
                targetFile = readyTorrent.files
                    .filter(f => torrentUtils.isValidVideo(f.name, f.size, undefined, LOG_PREFIX))
                    .sort((a, b) => b.size - a.size)[0];
            }
            
            if (!targetFile) throw new Error('No valid video file found in the ready torrent.');
            console.log(`[${LOG_PREFIX} RESOLVER] Target file is "${targetFile.name}" (${targetFile.size} bytes). Getting link...`);

            return await requestDownloadLink(apiKey, readyTorrent.id, targetFile.id, clientIp);
        } catch (error) {
            console.error(`[${LOG_PREFIX} RESOLVER] Error handling magnet link: ${error.message}`);
            return null;
        }
    } else {
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
        const torrentsFromApi = await getTorrentList(apiKey);
        return await processPersonalHistory(torrentsFromApi, apiKey);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Failed to list personal files:`, error.message);
        return [];
    }
}

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

async function getTorrentInfoFromCache(apiKey, hash) {
    const url = `${TB_BASE_URL}/api/torrents/torrentinfo`;
    const headers = getHeaders(apiKey);
    const data = new URLSearchParams();
    data.append('hash', hash);
    data.append('use_cache_lookup', 'true');
    try {
        const response = await axios.post(url, data, { headers, timeout: TIMEOUT });
        if (response.data?.success && response.data.data) {
            return response.data.data;
        }
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Failed to get torrent info for ${hash}: ${error.message}`);
    }
    return null;
}

async function processPersonalHistory(torrentsFromApi, apiKey) {
    const processedFiles = torrentsFromApi.map(torrent => {
        if (!torrent.files || torrent.download_present !== true) return [];
        
        return torrent.files.map(file => {
            if (!torrentUtils.isValidVideo(file.name, file.size, undefined, LOG_PREFIX)) return null;

            return {
                source: 'torbox',
                id: `${torrent.id}-${file.id}`,
                name: file.name,
                info: PTT.parse(file.name),
                size: file.size,
                hash: torrent.hash?.toLowerCase(),
                // Pass a lightweight identifier that the resolver can parse (torrentId/fileId)
                url: `${torrent.id}/${file.id}`,
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

async function waitForTorrentReady(apiKey, infoHash, timeout = 120000, interval = 3000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
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
