import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import { getCachedHashes as mongoGetCachedHashes, upsertCachedMagnet as mongoUpsert, default as mongoCache } from './common/mongo-cache.js';
import { obfuscateSensitive } from './common/torrent-utils.js';
import searchCoordinator from './util/search-coordinator.js';
import { orchestrateScrapers } from './util/scraper-selector.js';
import * as debridHelpers from './util/debrid-helpers.js';

const { getHashFromMagnet, filterByYear, delay, isValidVideo, isValidTorrentTitle } = torrentUtils;
const LOG_PREFIX = 'TB';
const TB_BASE_URL = 'https://api.torbox.app/v1';
const TIMEOUT = 15000;

// Use debrid-helpers functions
const norm = debridHelpers.norm;
const getQualityCategory = debridHelpers.getQualityCategory;
const addHashToMongo = (hash, fileName = null, size = null, data = null) => debridHelpers.addHashToMongo(hash, fileName, size, data, 'torbox');
const deferMongoUpserts = debridHelpers.deferMongoUpserts;
const uniqueUpserts = debridHelpers.uniqueUpserts;



// ===================================================================================
// --- 1. CORE SEARCH ORCHESTRATOR ---
// ===================================================================================
async function searchTorboxTorrents(apiKey, type, id, userConfig = {}) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== NEW SEARCH REQUEST ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Type: ${type}, ID: ${id}`);
    console.log(`[${LOG_PREFIX} DEBUG] User Config:`, JSON.stringify(userConfig));

    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    console.log(`[${LOG_PREFIX} DEBUG] Parsed - IMDB: ${imdbId}, Season: ${season}, Episode: ${episode}`);

    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) {
        console.error(`[${LOG_PREFIX}] Could not get metadata for ${id}. Aborting search.`);
        return [];
    }

    console.log(`[${LOG_PREFIX} DEBUG] Cinemeta Details:`, JSON.stringify({ name: cinemetaDetails.name, year: cinemetaDetails.year }));

    const searchKey = cinemetaDetails.name;
    const selectedLanguages = Array.isArray(userConfig.Languages) ? userConfig.Languages : [];
    const baseSearchKey = type === 'series'
        ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

    const specificSearchKey = type === 'series'
        ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

    console.log(`[${LOG_PREFIX} DEBUG] Search Keys - Base: "${baseSearchKey}", Specific: "${specificSearchKey}"`);

    let episodeInfo = null;
    if (type === 'series' && season && episode) {
        episodeInfo = {
            season: parseInt(season, 10),
            episode: parseInt(episode, 10)
        };
        console.log(`[${LOG_PREFIX} DEBUG] Episode Info:`, episodeInfo);
    }
    const seriesCtx = type === 'series' ? buildSeriesContext({ search: specificSearchKey, cinemetaTitle: cinemetaDetails.name }) : null;
    if (seriesCtx) {
        console.log(`[${LOG_PREFIX} DEBUG] Series Context:`, JSON.stringify(seriesCtx));
    }

    console.log(`[${LOG_PREFIX}] Starting unified search for: "${specificSearchKey}"`);

    const abortController = new AbortController();
    const signal = abortController.signal;

    try {
        console.time(`[${LOG_PREFIX}] Total search time`);
        let [personalFiles, scraperResults] = await Promise.all([
            searchPersonalFiles(apiKey, searchKey),
            orchestrateScrapers({
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
            })
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

        // scraperResults is already an array of arrays (one per scraper), use it directly
        let scraperResultsArray = scraperResults;

        if (seriesCtx) {
            scraperResultsArray = scraperResultsArray.map(list => list.filter(t => matchesCandidateTitle(t, seriesCtx)));
            const s = seriesCtx.season, e = seriesCtx.episode;
            if (Number.isFinite(s) && Number.isFinite(e)) {
                scraperResultsArray = scraperResultsArray.map(list => list.filter(t => {
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
        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResultsArray, episodeInfo, cinemetaDetails, seriesCtx);
	console.log('combined results: ', obfuscateSensitive(JSON.stringify(combinedResults), apiKey))

        // Match RD/AD movie filtering: drop series-like titles, then apply year sanity
        if (type === 'movie') {
            const beforeSeriesFilter = combinedResults.length;
            let filtered = combinedResults.filter(item => {
                try {
                    const title = item?.Title || item?.name || '';
                    if (torrentUtils.isSeriesLikeTitle(title)) return false;
                    const parsed = PTT.parse(title) || {};
                    if (parsed.season != null || parsed.seasons) return false;
                } catch {}
                return true;
            });
            if (beforeSeriesFilter !== filtered.length) {
                console.log(`[${LOG_PREFIX}] Removed ${beforeSeriesFilter - filtered.length} series-like results for movie request.`);
            }
            if (cinemetaDetails.year) {
                const beforeYear = filtered.length;
                filtered = filtered.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
                if (beforeYear !== filtered.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}). Removed ${beforeYear - filtered.length} mismatched results.`);
                }
            }
            return filtered;
        }

        console.log(`[${LOG_PREFIX}] Returning a combined total of ${combinedResults.length} unique streams.`);
        return combinedResults;
    } catch (error) {
        // In the coordinated approach, scraper failures are handled by the coordinator
        // We can still attempt to get personal files to return at least those
        const personalFiles = await searchPersonalFiles(apiKey, searchKey);
        // Since scraperResults failed, we return only personal files
        const combined = await combineAndMarkResults(apiKey, personalFiles, [], episodeInfo, cinemetaDetails);
        if (type === 'movie') {
            let filtered = combined.filter(item => {
                try {
                    const title = item?.Title || item?.name || '';
                    if (torrentUtils.isSeriesLikeTitle(title)) return false;
                    const parsed = PTT.parse(title) || {};
                    if (parsed.season != null || parsed.seasons) return false;
                } catch {}
                return true;
            });
            if (cinemetaDetails.year) filtered = filtered.filter(t => filterByYear(t, cinemetaDetails, LOG_PREFIX));
            return filtered;
        }
        return combined;
    }
}

// ===================================================================================
// --- 2. SEARCH & COMBINE LOGIC ---
// ===================================================================================
function isPack(torrent) {
    try {
        const parsed = PTT.parse(torrent.Title || torrent.name || '');
        const hasSeason = parsed.season !== undefined || (parsed.seasons && parsed.seasons.length > 0);
        return hasSeason && (parsed.episode === undefined || Array.isArray(parsed.episode));
    } catch {
        return false;
    }
}

async function searchPersonalFiles(apiKey, searchKey) {
    console.log(`[${LOG_PREFIX} DEBUG] searchPersonalFiles called with searchKey: "${searchKey}"`);
    console.time(`[${LOG_PREFIX} TIMER] Personal Cloud`);
    try {
        const allFiles = await listPersonalFiles(apiKey);
        console.log(`[${LOG_PREFIX} DEBUG] listPersonalFiles returned ${allFiles.length} files`);
        if (allFiles.length === 0) return [];

        const fuse = new Fuse(allFiles, { keys: ['info.title', 'name'], threshold: 0.3, minMatchCharLength: 3 });
        const fuzzyResults = fuse.search(searchKey).map(result => result.item);
        console.log(`[${LOG_PREFIX} DEBUG] Fuzzy search returned ${fuzzyResults.length} results`);

        const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const normalizedSearchWords = normalize(searchKey).split(' ');
        console.log(`[${LOG_PREFIX} DEBUG] Normalized search words:`, normalizedSearchWords);

        const strictResults = fuzzyResults.filter(item => {
            const normalizedItemName = normalize(item.name);
            return normalizedSearchWords.every(word => normalizedItemName.includes(word));
        });
        console.log(`[${LOG_PREFIX}] Personal files search found ${strictResults.length} results for "${searchKey}".`);
        return strictResults;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Personal files search error: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Personal files search stack:`, error.stack);
        return [];
    } finally {
        console.timeEnd(`[${LOG_PREFIX} TIMER] Personal Cloud`);
    }
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources, episodeInfo = null, cinemetaDetails, seriesCtx = null) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== COMBINE AND MARK RESULTS ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Personal files: ${personalFiles.length}, External sources: ${externalSources.length}`);
    console.log(`[${LOG_PREFIX} DEBUG] Episode Info:`, episodeInfo);

    // --- Initial Setup and Merging ---
    const externalTorrentsRaw = [].concat(...externalSources);
    console.log(`[${LOG_PREFIX} DEBUG] Raw external torrents after concat: ${externalTorrentsRaw.length}`);

    const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
    console.log(`[${LOG_PREFIX} DEBUG] Personal hashes count: ${personalHashes.size}`);

    const markedPersonal = personalFiles.map(file => ({ ...file, isPersonal: true, tracker: 'Personal' }));

    // Debug: Log all hashes before deduplication
    const allHashes = externalTorrentsRaw.map(t => ({
        title: t.Title || t.name,
        hash: (t.InfoHash || t.infoHash || t.hash || '').toString().toLowerCase()
    }));
    console.log(`[TB DEBUG] All hashes before dedup:`, allHashes.slice(0, 10));

    const uniqueExternalTorrents = [...new Map(externalTorrentsRaw.map(t => [
        (t.InfoHash || t.infoHash || t.hash || '').toString().toLowerCase(),
        t
    ])).values()];
    console.log(`[TB DEBUG] Started with ${uniqueExternalTorrents.length} unique external torrents.`);
    if (uniqueExternalTorrents.length > 0) {
        console.log(`[TB DEBUG] Sample unique torrent:`, {
            title: uniqueExternalTorrents[0].Title || uniqueExternalTorrents[0].name,
            hash: uniqueExternalTorrents[0].InfoHash || uniqueExternalTorrents[0].infoHash || uniqueExternalTorrents[0].hash
        });
    }

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
    console.log(`[${LOG_PREFIX} DEBUG] Hashes to check: ${hashesToCheck.length}`);
    console.log(`[${LOG_PREFIX} DEBUG] Sample hashes to check:`, hashesToCheck.slice(0, 5));

    // Prefer local Mongo cache to save API calls
    let cachedHashes = new Set();
    try {
        if (mongoCache && mongoCache.isEnabled && mongoCache.isEnabled()) {
            console.log(`[${LOG_PREFIX} DEBUG] Mongo cache is enabled, querying local cache...`);
            const local = await mongoGetCachedHashes('torbox', hashesToCheck);
            console.log(`[${LOG_PREFIX} DEBUG] Mongo returned ${local.length} cached hashes`);
            local.forEach(h => cachedHashes.add(h));
        } else {
            console.log(`[${LOG_PREFIX} DEBUG] Mongo cache is disabled`);
        }
    } catch (err) {
        console.error(`[${LOG_PREFIX} DEBUG] Error querying mongo cache:`, err.message);
    }
    const remaining = hashesToCheck.filter(h => !cachedHashes.has(h));
    console.log(`[${LOG_PREFIX} DEBUG] After mongo check: ${cachedHashes.size} cached, ${remaining.length} remaining to check with API`);
    if (remaining.length > 0) {
        const remote = await checkTorboxCache(apiKey, remaining);
        console.log(`[${LOG_PREFIX} DEBUG] TorBox API returned ${remote.size} cached hashes`);
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
    console.log(`[${LOG_PREFIX} DEBUG] Final external results: ${finalExternalResults.length} (${cachedSingleFiles.length} single + ${packResults.length} from packs)`);

    const combined = [...markedPersonal, ...finalExternalResults];
    console.log(`[${LOG_PREFIX} DEBUG] Combined results before dedup: ${combined.length} (${markedPersonal.length} personal + ${finalExternalResults.length} external)`);

    const finalUniqueResults = [...new Map(combined.map(item => [item.hash, item])).values()];
    console.log(`[TB DEBUG] Final combined list has ${finalUniqueResults.length} unique items before returning.`);
    console.log(`[${LOG_PREFIX} DEBUG] ========== PIPELINE SUMMARY ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Input: ${uniqueExternalTorrents.length} external + ${personalFiles.length} personal`);
    console.log(`[${LOG_PREFIX} DEBUG] After episode filter: ${episodeFiltered.length}`);
    console.log(`[${LOG_PREFIX} DEBUG] After title validation: ${validTitleTorrents.length}`);
    console.log(`[${LOG_PREFIX} DEBUG] After franchise filter: ${franchiseFiltered.length}`);
    console.log(`[${LOG_PREFIX} DEBUG] Cache check: ${hashesToCheck.length} hashes -> ${cachedHashes.size} cached`);
    console.log(`[${LOG_PREFIX} DEBUG] Cached torrents split: ${cachedSingleFiles.length} single + ${cachedPacks.length} packs`);
    console.log(`[${LOG_PREFIX} DEBUG] Pack inspection: ${cachedPacks.length} packs -> ${packResults.length} matching files`);
    console.log(`[${LOG_PREFIX} DEBUG] Final output: ${finalUniqueResults.length} unique streams`);
    
    // Persist to Mongo cache
    try {
        if (mongoCache?.isEnabled()) {
            const upserts = [];
            for (const r of finalExternalResults) {
                if (r?.hash) {
                    upserts.push({
                        service: 'torbox',
                        hash: r.hash.toLowerCase(),
                        fileName: r.name || null,
                        size: r.size || null,
                        category: getQualityCategory(r.name || ''),
                        resolution: torrentUtils.getResolutionFromName(r.name || ''),
                        data: r.episodeFileHint || null
                    });
                }
            }
            deferMongoUpserts(uniqueUpserts(upserts));
        }
    } catch {}

    if (episodeInfo) {
        return finalUniqueResults.filter(item => {
            // Allow personal files and items from pack inspection
            if (item.isPersonal || item.episodeFileHint) {
                return true;
            }
            // For external files, if it's a pack, it must have come from inspection.
            // Since we are filtering items without episodeFileHint, we check if it's a pack. If so, reject.
            const title = item.name || '';
            const parsed = item.info || PTT.parse(title);

            const hasSeason = parsed.season !== undefined || (parsed.seasons && parsed.seasons.length > 0);
            const isPackByPtt = hasSeason && (parsed.episode === undefined || Array.isArray(parsed.episode));
            if (isPackByPtt) {
                console.log(`[${LOG_PREFIX}] Filtering uninspected pack (PTT): ${item.name}`);
                return false; // It's a pack that slipped through
            }

            // PTT thinks it's a single episode. Double check for episode ranges like E01-E10.
            if (/\bE\d{2,3}[-~_]E?\d{2,3}\b/i.test(title)) {
                console.log(`[${LOG_PREFIX}] Filtering uninspected pack (range regex): ${item.name}`);
                return false;
            }

            return true;
        });
    }

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
    console.log(`[${LOG_PREFIX} DEBUG] ========== CHECK TORBOX CACHE ==========`);
    if (!hashes || hashes.length === 0) {
        console.log(`[${LOG_PREFIX} DEBUG] No hashes provided, returning empty set`);
        return new Set();
    }
    const url = `${TB_BASE_URL}/api/torrents/checkcached`;
    const headers = getHeaders(apiKey);
    console.log(`[${LOG_PREFIX} DEBUG] Request URL: ${url}`);
    console.log(`[${LOG_PREFIX} DEBUG] Request headers:`, JSON.stringify(headers));

    try {
        console.log(`[${LOG_PREFIX}] Checking cache for ${hashes.length} hashes (hex format).`);
        console.log(`[${LOG_PREFIX}] Sample hex hashes:`, hashes.slice(0, 3));

        // TorBox API expects hex hashes directly - no conversion needed
        const hexHashes = hashes.map(h => h.toLowerCase()).filter(h => /^[a-f0-9]{40}$/.test(h));
        console.log(`[${LOG_PREFIX} DEBUG] Input hashes: ${hashes.length}, Valid hex hashes after filter: ${hexHashes.length}`);
        console.log(`[${LOG_PREFIX} DEBUG] Invalid hashes filtered:`, hashes.filter(h => !/^[a-f0-9]{40}$/i.test(h)).slice(0, 5));

        if (hexHashes.length === 0) {
            console.log(`[${LOG_PREFIX}] No valid hex hashes to check.`);
            return new Set();
        }

        const requestBody = { hashes: hexHashes };
        console.log(`[${LOG_PREFIX} DEBUG] Request body (first 3 hashes):`, { hashes: hexHashes.slice(0, 3) });
        console.log(`[${LOG_PREFIX} DEBUG] Sending POST request to TorBox API...`);

        const response = await axios.post(url, requestBody, { headers, timeout: TIMEOUT });

        console.log(`[${LOG_PREFIX} DEBUG] Response status: ${response.status}`);
        console.log(`[${LOG_PREFIX} DEBUG] Response headers:`, JSON.stringify(response.headers));
        console.log(`[${LOG_PREFIX} DEBUG] Response data.success:`, response.data?.success);
        console.log(`[${LOG_PREFIX} DEBUG] Response data type:`, typeof response.data?.data);
        if (response.data?.data) {
            console.log(`[${LOG_PREFIX} DEBUG] Response data keys count:`, Object.keys(response.data.data).length);
            console.log(`[${LOG_PREFIX} DEBUG] Response data sample:`, JSON.stringify(response.data.data).substring(0, 500));
        }

        if (response.data?.success && typeof response.data.data === 'object') {
            // TorBox API returns an object where cached hashes are keys with values indicating status
            const cachedHashes = new Set(Object.keys(response.data.data).map(h => h.toLowerCase()));
            console.log(`[${LOG_PREFIX}] TorBox API returned ${cachedHashes.size} cached hashes`);
            console.log(`[${LOG_PREFIX}] Sample cached:`, Array.from(cachedHashes).slice(0, 3));
            return cachedHashes;
        }
        console.log(`[${LOG_PREFIX} DEBUG] Response did not match expected format, returning empty set`);
        return new Set();
    } catch (error) {
        console.error(`[${LOG_PREFIX}] !! FATAL: TorBox cache check failed: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Error name:`, error.name);
        console.error(`[${LOG_PREFIX}] Error code:`, error.code);
        console.error(`[${LOG_PREFIX}] Error response status:`, error.response?.status);
        console.error(`[${LOG_PREFIX}] Error response headers:`, JSON.stringify(error.response?.headers));
        console.error(`[${LOG_PREFIX}] Error response data:`, JSON.stringify(error.response?.data));
        console.error(`[${LOG_PREFIX}] Error stack:`, error.stack);
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
        isCached: true,
        ...(result.episodeFileHint && { episodeFileHint: result.episodeFileHint })
    };
}


// ===================================================================================
// --- 3. STREAM RESOLVER & HELPERS ---
// ===================================================================================
async function unrestrictUrl(apiKey, itemId, hostUrl, clientIp) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== UNRESTRICT URL ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Item ID: ${itemId}, Client IP: ${clientIp}`);
    console.log(`[${LOG_PREFIX} RESOLVER] Starting resolution for: ${hostUrl.substring(0, 150)}`);

    if (hostUrl.startsWith('magnet:')) {
        console.log(`[${LOG_PREFIX} DEBUG] Processing magnet link`);
        try {
            let torrentId, fileId, targetFilePath;
            if (hostUrl.includes('||HINT||')) {
                console.log(`[${LOG_PREFIX} DEBUG] Detected pack hint in URL`);
                const parts = hostUrl.split('||HINT||');
                hostUrl = parts[0]; // The magnet part
                const hintPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                targetFilePath = hintPayload.filePath;
                torrentId = hintPayload.torrentId;
                fileId = hintPayload.fileId;
                console.log(`[${LOG_PREFIX} RESOLVER] Pack hint found. Target: "${targetFilePath}"`, { torrentId, fileId });
                console.log(`[${LOG_PREFIX} DEBUG] Hint payload:`, hintPayload);
            } else {
                console.log(`[${LOG_PREFIX} DEBUG] No hint in magnet link`);
            }

            if (torrentId && fileId) {
                console.log(`[${LOG_PREFIX} RESOLVER] Using torrentId/fileId from hint to get download link directly.`);
                return await requestDownloadLink(apiKey, torrentId, fileId, clientIp);
            }

            const infoHash = getHashFromMagnet(hostUrl);
            console.log(`[${LOG_PREFIX} RESOLVER] Adding magnet with hash: ${infoHash}`);

            const addResponse = await addToTorbox(apiKey, hostUrl);
            if (!addResponse.torrent_id && !addResponse.queued_id) {
                console.error(`[${LOG_PREFIX} RESOLVER] Failed to add magnet to Torbox. Response:`, addResponse);
                throw new Error('Failed to add magnet to Torbox. Response: ' + JSON.stringify(addResponse));
            }
            console.log(`[${LOG_PREFIX} RESOLVER] Magnet added. Waiting for download to complete...`, addResponse);

            const readyTorrent = await waitForTorrentReady(apiKey, infoHash);
            if (!readyTorrent) {
                console.error(`[${LOG_PREFIX} RESOLVER] Torrent did not become ready in time for hash ${infoHash}.`);
                throw new Error('Torrent did not become ready in time.');
            }
            console.log(`[${LOG_PREFIX} RESOLVER] Torrent is ready: "${readyTorrent.name}"`, `Files: ${readyTorrent.files?.length || 0}`);

            let targetFile;
            if (targetFilePath) {
                console.log(`[${LOG_PREFIX} RESOLVER] Searching for file path: "${targetFilePath}"`);
                targetFile = readyTorrent.files.find(f => f.name.toLowerCase().endsWith(targetFilePath.toLowerCase()));
                if (!targetFile) {
                    console.warn(`[${LOG_PREFIX} RESOLVER] Could not find hinted file. Available files:`, readyTorrent.files?.map(f => f.name));
                }
            }
            
            if (!targetFile) {
                console.log(`[${LOG_PREFIX} RESOLVER] Hinted file not found or no hint. Falling back to largest video file.`);
                targetFile = readyTorrent.files
                    .filter(f => torrentUtils.isValidVideo(f.name, f.size, undefined, LOG_PREFIX))
                    .sort((a, b) => b.size - a.size)[0];
            }

            if (!targetFile) {
                console.error(`[${LOG_PREFIX} RESOLVER] No valid video file found in the ready torrent.`);
                throw new Error('No valid video file found in the ready torrent.');
            }
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
        console.log(`[${LOG_PREFIX}] listPersonalFiles: Fetching torrent list from TorBox API...`);
        const torrentsFromApi = await getTorrentList(apiKey);
        console.log(`[${LOG_PREFIX}] listPersonalFiles: Got ${torrentsFromApi.length} torrents from API`);
        const processed = await processPersonalHistory(torrentsFromApi, apiKey);
        console.log(`[${LOG_PREFIX}] listPersonalFiles: Processed into ${processed.length} video files`);
        return processed;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Failed to list personal files:`, error.message);
        console.error(`[${LOG_PREFIX}] Stack:`, error.stack);
        return [];
    }
}

async function getTorrentList(apiKey, bypassCache = false) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== GET TORRENT LIST ==========`);
    const url = `${TB_BASE_URL}/api/torrents/mylist`;
    const headers = getHeaders(apiKey);
    const params = {};
    if (bypassCache) {
        params.bypass_cache = true;
        console.log(`[${LOG_PREFIX} DEBUG] Bypass cache enabled`);
    }
    console.log(`[${LOG_PREFIX} DEBUG] Request URL: ${url}`);
    console.log(`[${LOG_PREFIX} DEBUG] Request params:`, params);
    console.log(`[${LOG_PREFIX} DEBUG] Request headers:`, JSON.stringify(headers));

    try {
        console.log(`[${LOG_PREFIX} DEBUG] Sending GET request...`);
        const response = await axios.get(url, { headers, params, timeout: TIMEOUT });
        console.log(`[${LOG_PREFIX} DEBUG] Response status: ${response.status}`);
        console.log(`[${LOG_PREFIX} DEBUG] Response data.success:`, response.data?.success);
        console.log(`[${LOG_PREFIX} DEBUG] Response data is array:`, Array.isArray(response.data?.data));
        console.log(`[${LOG_PREFIX} DEBUG] Response data count:`, response.data?.data?.length);

        if (response.data?.success && Array.isArray(response.data.data)) {
            console.log(`[${LOG_PREFIX} DEBUG] Returning ${response.data.data.length} torrents`);
            return response.data.data;
        }
        console.error(`[${LOG_PREFIX} DEBUG] Invalid response format`);
        throw new Error(response.data?.error || 'Invalid data format from Torbox API.');
    } catch (error) {
        console.error(`[${LOG_PREFIX} DEBUG] getTorrentList error:`, error.message);
        console.error(`[${LOG_PREFIX} DEBUG] Error status:`, error.response?.status);
        console.error(`[${LOG_PREFIX} DEBUG] Error data:`, JSON.stringify(error.response?.data));

        // Handle TorBox API errors gracefully
        if (error.response?.status === 403) {
            console.error(`[${LOG_PREFIX}] TorBox API returned 403 Forbidden. Check your API key.`);
            return [];
        }
        if (error.response?.status === 500) {
            console.error(`[${LOG_PREFIX}] TorBox API returned 500 error. Returning empty list.`);
            return [];
        }
        throw error;
    }
}

async function getTorrentInfoFromCache(apiKey, hash) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== GET TORRENT INFO FROM CACHE ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Hash: ${hash}`);
    const url = `${TB_BASE_URL}/api/torrents/torrentinfo`;
    const headers = getHeaders(apiKey);
    const data = new URLSearchParams();
    data.append('hash', hash);
    data.append('use_cache_lookup', 'true');
    console.log(`[${LOG_PREFIX} DEBUG] Request URL: ${url}`);
    console.log(`[${LOG_PREFIX} DEBUG] Request body:`, data.toString());

    try {
        console.log(`[${LOG_PREFIX} DEBUG] Sending POST request...`);
        const response = await axios.post(url, data, { headers, timeout: TIMEOUT });
        console.log(`[${LOG_PREFIX} DEBUG] Response status: ${response.status}`);
        console.log(`[${LOG_PREFIX} DEBUG] Response data.success:`, response.data?.success);
        console.log(`[${LOG_PREFIX} DEBUG] Response has data:`, !!response.data?.data);
        if (response.data?.data) {
            console.log(`[${LOG_PREFIX} DEBUG] Torrent info id:`, response.data.data.id);
            console.log(`[${LOG_PREFIX} DEBUG] Torrent info files count:`, response.data.data.files?.length);
        }

        if (response.data?.success && response.data.data) {
            return response.data.data;
        }
        console.log(`[${LOG_PREFIX} DEBUG] Invalid response format, returning null`);
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Failed to get torrent info for ${hash}: ${error.message}`);
        console.error(`[${LOG_PREFIX} DEBUG] Error status:`, error.response?.status);
        console.error(`[${LOG_PREFIX} DEBUG] Error data:`, JSON.stringify(error.response?.data));
    }
    return null;
}

async function processPersonalHistory(torrentsFromApi, apiKey) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== PROCESS PERSONAL HISTORY ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Processing ${torrentsFromApi.length} torrents from API`);

    const processedFiles = torrentsFromApi.map((torrent, idx) => {
        if (!torrent.files || torrent.download_present !== true) {
            console.log(`[${LOG_PREFIX} DEBUG] Skipping torrent ${idx}: no files or not downloaded. download_present=${torrent.download_present}`);
            return [];
        }

        console.log(`[${LOG_PREFIX} DEBUG] Processing torrent ${idx}: ${torrent.name}, files: ${torrent.files.length}`);

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

    const flatFiles = processedFiles.flat();
    console.log(`[${LOG_PREFIX} DEBUG] Processed ${flatFiles.length} valid video files from personal history`);
    return flatFiles;
}

async function addToTorbox(apiKey, magnetLink) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== ADD TO TORBOX ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Magnet link (truncated):`, magnetLink.substring(0, 100));
    const url = `${TB_BASE_URL}/api/torrents/createtorrent`;
    const headers = getHeaders(apiKey);
    const data = new URLSearchParams();
    data.append('magnet', magnetLink);
    data.append('allow_zip', 'false');
    console.log(`[${LOG_PREFIX} DEBUG] Request URL: ${url}`);
    console.log(`[${LOG_PREFIX} DEBUG] Request body keys:`, Array.from(data.keys()));

    try {
        console.log(`[${LOG_PREFIX} DEBUG] Sending POST request...`);
        const response = await axios.post(url, data, { headers, timeout: TIMEOUT });
        console.log(`[${LOG_PREFIX} DEBUG] Response status: ${response.status}`);
        console.log(`[${LOG_PREFIX} DEBUG] Response data:`, JSON.stringify(response.data));

        if (response.data?.success) {
            console.log(`[${LOG_PREFIX} DEBUG] Torrent added successfully. ID:`, response.data.data?.torrent_id || response.data.data?.queued_id);
            return response.data.data;
        }
        throw new Error(response.data?.error || 'Failed to create torrent on Torbox.');
    } catch (error) {
        console.error(`[${LOG_PREFIX} DEBUG] addToTorbox error:`, error.message);
        console.error(`[${LOG_PREFIX} DEBUG] Error status:`, error.response?.status);
        console.error(`[${LOG_PREFIX} DEBUG] Error data:`, JSON.stringify(error.response?.data));
        throw error;
    }
}

async function waitForTorrentReady(apiKey, infoHash, timeout = 120000, interval = 3000) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== WAIT FOR TORRENT READY ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Info hash: ${infoHash}, Timeout: ${timeout}ms, Interval: ${interval}ms`);
    const startTime = Date.now();
    let attempts = 0;

    while (Date.now() - startTime < timeout) {
        attempts++;
        const elapsed = Date.now() - startTime;
        console.log(`[${LOG_PREFIX} DEBUG] Wait attempt ${attempts}, elapsed: ${elapsed}ms`);

        const torrentList = await getTorrentList(apiKey, true);
        console.log(`[${LOG_PREFIX} DEBUG] Got ${torrentList.length} torrents from list`);

        const target = torrentList.find(t => t.hash?.toLowerCase() === infoHash.toLowerCase());

        if (target) {
            console.log(`[${LOG_PREFIX} DEBUG] Found target torrent. download_present: ${target.download_present}, name: ${target.name}`);
            if (target.download_present === true) {
                console.log(`[${LOG_PREFIX} DEBUG] Torrent is ready after ${attempts} attempts and ${elapsed}ms`);
                return target;
            } else {
                console.log(`[${LOG_PREFIX} DEBUG] Torrent found but not ready yet. Status:`, target.download_state);
            }
        } else {
            console.log(`[${LOG_PREFIX} DEBUG] Target torrent not found in list yet`);
        }

        console.log(`[${LOG_PREFIX} DEBUG] Waiting ${interval}ms before next check...`);
        await delay(interval);
    }
    console.error(`[${LOG_PREFIX} DEBUG] Timeout reached after ${attempts} attempts`);
    return null;
}

async function requestDownloadLink(apiKey, torrentId, fileId, clientIp) {
    console.log(`[${LOG_PREFIX} DEBUG] ========== REQUEST DOWNLOAD LINK ==========`);
    console.log(`[${LOG_PREFIX} DEBUG] Torrent ID: ${torrentId}, File ID: ${fileId}, Client IP: ${clientIp}`);
    const url = `${TB_BASE_URL}/api/torrents/requestdl`;
    const headers = getHeaders(apiKey);
    const params = { token: apiKey, torrent_id: torrentId, file_id: fileId, user_ip: clientIp };
    console.log(`[${LOG_PREFIX} DEBUG] Request URL: ${url}`);
    console.log(`[${LOG_PREFIX} DEBUG] Request params:`, { ...params, token: '[REDACTED]' });

    try {
        console.log(`[${LOG_PREFIX} DEBUG] Sending GET request...`);
        const response = await axios.get(url, { params, headers, timeout: TIMEOUT });
        console.log(`[${LOG_PREFIX} DEBUG] Response status: ${response.status}`);
        console.log(`[${LOG_PREFIX} DEBUG] Response data.success:`, response.data?.success);
        console.log(`[${LOG_PREFIX} DEBUG] Response has download link:`, !!response.data?.data);

        if (response.data?.success && response.data.data) {
            console.log(`[${LOG_PREFIX} DEBUG] Download link obtained successfully`);
            return response.data.data;
        }
        throw new Error(response.data?.error || 'Failed to request download link.');
    } catch (error) {
        console.error(`[${LOG_PREFIX} DEBUG] requestDownloadLink error:`, error.message);
        console.error(`[${LOG_PREFIX} DEBUG] Error status:`, error.response?.status);
        console.error(`[${LOG_PREFIX} DEBUG] Error data:`, JSON.stringify(error.response?.data));
        throw error;
    }
}

function getHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'StremioAddon/1.0.0',
    };
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
    try {
        console.log(`[${LOG_PREFIX}] searchDownloads called with searchKey: "${searchKey}"`);
        const allFiles = await listPersonalFiles(apiKey);
        console.log(`[${LOG_PREFIX}] searchDownloads: listPersonalFiles returned ${allFiles.length} files`);

        if (allFiles.length === 0) {
            console.log(`[${LOG_PREFIX}] searchDownloads: No files found, returning empty array`);
            return [];
        }

        // If no search key, return all files
        if (!searchKey || searchKey === '') {
            console.log(`[${LOG_PREFIX}] searchDownloads: No search key, returning all ${allFiles.length} files`);
            return allFiles;
        }

        // Use Fuse for fuzzy searching
        const fuse = new Fuse(allFiles, {
            keys: ['info.title', 'name'],
            threshold,
            minMatchCharLength: 2
        });
        const results = fuse.search(searchKey).map(r => r.item);
        console.log(`[${LOG_PREFIX}] searchDownloads: Fuzzy search found ${results.length} matches`);
        return results;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Downloads search error: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Stack:`, error.stack);
        return [];
    }
}

export default { searchTorboxTorrents, unrestrictUrl, searchDownloads };
