import RealDebridClient from 'real-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import RdLimiter from './util/rd-rate-limit.js';
const rdCall = (fn, apiKey) => RdLimiter.schedule(fn, 'rd-call', apiKey);
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { matchesSeriesTitle, hasEpisodeMarker } from './util/seriesTitleMatcher.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import * as sqliteCache from './util/sqlite-cache.js';
import { obfuscateSensitive } from './common/torrent-utils.js';
import personalFilesCache from './util/personal-files-cache.js';
import searchCoordinator from './util/search-coordinator.js';
import { orchestrateScrapers } from './util/scraper-selector.js';
import * as debridHelpers from './util/debrid-helpers.js';
import debridProxyManager from './util/debrid-proxy.js';
import * as stremThru from './util/stremthru.js';

const { isValidVideo, isValidTorrentTitle, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'RD';

// ---------------------------------------------------------------------------------
// Global state & Cache
// ---------------------------------------------------------------------------------

// Use helper functions from debrid-helpers
const getQualityCategory = debridHelpers.getQualityCategory;
const createAbortController = debridHelpers.createAbortController;
const addHashToSqlite = (hash, fileName, size, data) => debridHelpers.addHashToSqlite(hash, fileName, size, data, 'realdebrid');
const deferSqliteUpserts = debridHelpers.deferSqliteUpserts;
const uniqueUpserts = debridHelpers.uniqueUpserts;
const norm = debridHelpers.norm;

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------
function createRealDebridClient(apiKey, options = {}) {
  const proxyConfig = debridProxyManager.getAxiosConfig('realdebrid');
  const clientOptions = { ...options, ...proxyConfig };

  // Add client IP headers if available (for Real-Debrid authentication)
  if (options.clientIp) {
    clientOptions.ip = options.clientIp; // For POST requests
    clientOptions.headers = clientOptions.headers || {};
    clientOptions.headers['X-Forwarded-For'] = options.clientIp; // For all requests
    clientOptions.headers['X-Real-IP'] = options.clientIp;
  }

  return new RealDebridClient(apiKey, clientOptions);
}

async function saveHashCache() { return; }

async function loadHashCache() { return; }

async function buildPersonalHashCache(apiKey) {
  try {
    const RD = createRealDebridClient(apiKey);
    const existingTorrents = await getAllTorrents(RD, apiKey);
    const personalHashCache = new Set();
    existingTorrents.forEach(t => { if (t.hash) personalHashCache.add(t.hash.toLowerCase()); });
    console.log(`[RD CACHE] Built personal hash cache with ${personalHashCache.size} torrents`);
    return personalHashCache;
  } catch (error) {
    console.error(`[RD CACHE] Error building personal cache: ${error.message}`);
    return new Set();
  }
}

async function cleanupTemporaryTorrents(RD, torrentIds, apiKey) {
  if (torrentIds.size === 0) return;
  console.log(`[RD CLEANUP] 🧹 Starting background deletion of ${torrentIds.size} temporary torrents.`);
  for (const torrentId of torrentIds) {
    try {
      await rdCall(() => RD.torrents.delete(torrentId), apiKey);
    } catch (deleteError) {
      const status = deleteError.response?.status;

      // 404 means torrent already deleted/doesn't exist - this is fine, skip silently
      if (status === 404) {
        continue;
      }

      if (status === 429) {
        console.warn(`[RD CLEANUP] Rate limited. Pausing for 3 seconds...`);
        await delay(3000);
        await rdCall(() => RD.torrents.delete(torrentId), apiKey).catch(retryError => {
          // Also skip 404 on retry
          if (retryError.response?.status === 404) return;
          console.error(`[RD CLEANUP] ❌ Failed to delete torrent ${torrentId} on retry: ${retryError.message}`);
        });
      } else {
        console.error(`[RD CLEANUP] ❌ Error deleting torrent ${torrentId}: ${deleteError.message}`);
      }
    }
  }
  console.log(`[RD CLEANUP] ✅ Finished background deletion task.`);
}


// ---------------------------------------------------------------------------------
// Formatting & combining results (using debrid-helpers)
// ---------------------------------------------------------------------------------
function formatCachedResult(torrent, isCached) {
  const episodeHint = torrent.episodeFileHint || null;
    const definitiveTitle = episodeHint?.filePath || torrent.Title || torrent.name || 'Unknown Title';
    const definitiveSize = (episodeHint && typeof episodeHint.fileBytes === 'number' && episodeHint.fileBytes > 0)
        ? episodeHint.fileBytes
        : (torrent.Size || torrent.size || torrent.filesize || 0);

    let url;
    if (torrent.isPersonal) {
        // Personal files already have the correct URL format (either realdebrid:torrentId:fileId or direct download URL)
        // Don't convert to magnet links as they're already in RealDebrid
        url = torrent.url || `magnet:?xt=urn:btih:${torrent.hash}`;
    } else {
        const baseMagnet = `magnet:?xt=urn:btih:${torrent.InfoHash}`;
        if (episodeHint && torrent.InfoHash) {
            try {
                const hintPayload = { hash: (torrent.InfoHash || '').toLowerCase(), ...episodeHint };
                const encodedHint = Buffer.from(JSON.stringify(hintPayload)).toString('base64');
                url = `${baseMagnet}||HINT||${encodedHint}`;
            } catch { url = baseMagnet; }
        } else {
            url = baseMagnet;
        }
    }

    const searchableTitle = torrent.searchableName || definitiveTitle;

    return {
        name: definitiveTitle,
        info: PTT.parse(definitiveTitle) || { title: definitiveTitle },
        size: definitiveSize,
        seeders: torrent.Seeders || torrent.seeders || 0,
        url,
        source: 'realdebrid',
        hash: (torrent.InfoHash || torrent.hash || '').toLowerCase(),
        tracker: torrent.Tracker || (torrent.isPersonal ? 'Personal' : 'Cached'),
        isPersonal: torrent.isPersonal || false,
        isCached,
        languages: Array.isArray(torrent.Langs) ? torrent.Langs : [],
        ...(episodeHint?.filePath ? { searchableName: searchableTitle } : {}),
        ...(episodeHint ? { episodeHint } : {}),
        ...(torrent.id && { id: torrent.id }),
        ...(torrent.torrentId && { torrentId: torrent.torrentId }),
        ...(torrent.fileId && { fileId: torrent.fileId }),
        ...(torrent.isConfirmedCached && { isConfirmedCached: true })
    };
}

function combineAndMarkResults(apiKey, personalFiles, externalSources, specificSearchKey) {
    const markedPersonal = personalFiles.map(file => ({ ...file, isPersonal: true, tracker: 'Personal' }));
    const externalTorrents = [].concat(...externalSources).map(t => ({ ...t, isPersonal: false }));

    // Deduplicate by hash, preferring confirmed cached results (Torz) over others
    const uniqueMap = new Map();
    for (const t of externalTorrents) {
        const hash = t.InfoHash?.toLowerCase();
        if (!hash) continue;

        const existing = uniqueMap.get(hash);
        // Prefer confirmed cached (Torz), or add if no existing entry
        if (!existing || (t.isConfirmedCached && !existing.isConfirmedCached)) {
            uniqueMap.set(hash, t);
        }
    }
    const uniqueExternalTorrents = [...uniqueMap.values()];

    const personalHashes = new Set(personalFiles.map(f => f.hash?.toLowerCase()).filter(Boolean));
    const newExternalTorrents = uniqueExternalTorrents.filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

    const saneResults = newExternalTorrents;

    const validTitleResults = saneResults.filter(t => isValidTorrentTitle(t.Title, LOG_PREFIX));

    return [...markedPersonal, ...validTitleResults];
}

async function inspectAndFilterNonCached(torrents, rdHandler) {
    console.log(`[RD] Inspecting ${torrents.length} top non-cached torrents for validity...`);
    const validTorrents = [];
    for (const torrent of torrents) {
        const isValid = await rdHandler.liveCheckHash(torrent.InfoHash);
        if (isValid) {
            console.log(`[RD] -> VALID: ${torrent.Title}`);
            validTorrents.push(torrent);
        } else {
            console.log(`[RD] -> REJECTED (see CACHE-CHECK logs for reason): ${torrent.Title}`);
        }
    }
    return validTorrents;
}

// ---------------------------------------------------------------------------------
// Main search functions
// ---------------------------------------------------------------------------------

async function searchRealDebridTorrents(apiKey, type, id, userConfig = {}, clientIp = null, isBackgroundRefresh = false) {
  if (!id || typeof id !== 'string') {
    return [];
  }

  // Reset rate limit abort flag at the start of each new search
  RdLimiter.getLimiter(apiKey).resetRateLimitAbort();

  const imdbId = id.split(':')[0];
  const [season, episode] = id.split(':').slice(1);
  const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
  if (!cinemetaDetails) return [];

  const searchKey = cinemetaDetails.name;
  const selectedLanguages = Array.isArray(userConfig.Languages) ? userConfig.Languages : [];
  const baseSearchKey = type === 'series'
    ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
    : `${searchKey} ${cinemetaDetails.year || ''}`.trim();
  
  const specificSearchKey = baseSearchKey;

  let episodeInfo = null;
  if (type === 'series' && season && episode) {
    episodeInfo = { season: parseInt(season, 10), episode: parseInt(episode, 10) };
  }
  const seriesCtx = type === 'series' ? buildSeriesContext({ search: specificSearchKey, cinemetaTitle: cinemetaDetails.name }) : null;

  console.log(`[${LOG_PREFIX}] Comprehensive search for: "${specificSearchKey}"`);
  const abortController = createAbortController();
  const signal = abortController.signal;

  const torrentIdsToDelete = new Set();

  try {
    // Phase 0: fetch personal files first (these are the user's personal cloud results)
    // Only fetch personal files if enablePersonalCloud is not explicitly disabled
    let personalFiles = [];
    if (userConfig.enablePersonalCloud !== false) {
      personalFiles = await searchPersonalFiles(apiKey, searchKey, 0.3, clientIp);
    } else {
      console.log(`[${LOG_PREFIX}] Personal cloud disabled for this service, skipping personal files`);
    }

    const isLikelyEpisode = (t) => seriesCtx ? matchesCandidateTitle(t, { ...seriesCtx }) : true;

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

    // Ensure personal files have category/resolution for quota checking
    const enrichedPersonalFiles = personalFiles.map(file => {
        if (!file.category) {
            return {
                ...file,
                category: getQualityCategory(file.name || file.Title),
                resolution: torrentUtils.getResolutionFromName(file.name || file.Title)
            };
        }
        return file;
    });

    // Phase 1: Execute coordinated scrapers to avoid duplicate work when multiple services run simultaneously
    const scraperResults = await searchCoordinator.executeSearch(
      'realdebrid',
      async () => {
        // Add debrid service info to userConfig for scrapers that need it (like StremThru Torz API)
        const scraperConfig = {
          ...userConfig,
          DEBRID_SERVICE: 'realdebrid',
          DEBRID_TOKEN: apiKey
        };

        return await orchestrateScrapers({
          type,
          imdbId,
          searchKey,
          baseSearchKey,
          season,
          episode,
          signal,
          logPrefix: LOG_PREFIX,
          userConfig: scraperConfig,
          selectedLanguages,
          forceAllScrapers: isBackgroundRefresh
        });
      },
      type,
      id,
      userConfig
    );
    let combinedResults = combineAndMarkResults(apiKey, personalFiles, scraperResults, specificSearchKey);
    let externalTorrents = combinedResults.filter(t => !t.isPersonal);

    // Separate confirmed cached torrents (from Torz API) from other torrents
    // Confirmed cached torrents should bypass all filters and be returned immediately
    const confirmedCachedTorrents = externalTorrents.filter(t => t.isConfirmedCached === true);
    const unconfirmedTorrents = externalTorrents.filter(t => t.isConfirmedCached !== true);

    console.log(`[${LOG_PREFIX}] Separated ${confirmedCachedTorrents.length} confirmed cached (Torz) from ${unconfirmedTorrents.length} unconfirmed torrents`);

    // Apply filters only to unconfirmed torrents
    let filteredUnconfirmedTorrents = unconfirmedTorrents;

    if (episodeInfo) {
        filteredUnconfirmedTorrents = filteredUnconfirmedTorrents.filter(t => isLikelyEpisode(t));
        // Strict gate: if an explicit S/E is present in title, require exact match; allow season-only packs
        const s = episodeInfo.season, e = episodeInfo.episode;
        filteredUnconfirmedTorrents = filteredUnconfirmedTorrents.filter(t => {
            try {
                const p = PTT.parse(t.Title || t.name || '');
                if (p && p.season != null && p.episode != null) {
                    return Number(p.season) === Number(s) && Number(p.episode) === Number(e);
                }
                if (p && p.season != null && (p.episode === undefined || Array.isArray(p.episode))) {
                    return Number(p.season) === Number(s);
                }
            } catch {}
            return true;
        });
    }

    if (type === 'movie') {
        // 1) Exclude season packs/episodes outright for movie searches
        filteredUnconfirmedTorrents = filteredUnconfirmedTorrents.filter(t => {
            try {
                const title = t.Title || t.name || '';
                if (torrentUtils.isSeriesLikeTitle(title)) return false;
                const parsed = PTT.parse(title) || {};
                if (parsed.season != null || parsed.seasons) return false;
            } catch {}
            return true;
        });
        // 2) Apply year sanity when available
        if (cinemetaDetails.year) {
            filteredUnconfirmedTorrents = filteredUnconfirmedTorrents.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
        }
        // 3) Apply title matching to filter out unrelated movies
        if (cinemetaDetails.name) {
            const beforeTitleFilter = filteredUnconfirmedTorrents.length;
            const normalizeTitle = (s) => String(s || '').toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
            const expectedTitle = normalizeTitle(cinemetaDetails.name);
            filteredUnconfirmedTorrents = filteredUnconfirmedTorrents.filter(torrent => {
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
            if (beforeTitleFilter !== filteredUnconfirmedTorrents.length) {
                console.log(`[${LOG_PREFIX}] Filtered by title matching "${cinemetaDetails.name}". Removed ${beforeTitleFilter - filteredUnconfirmedTorrents.length} unrelated results.`);
            }
        }
    }

    // Combine confirmed cached (no filters applied) with filtered unconfirmed torrents
    externalTorrents = [...confirmedCachedTorrents, ...filteredUnconfirmedTorrents];

    await loadHashCache();
    
    // Phase 2: Check for cached results from StremThru (the common debrid cache system) - this is the fast cache for other users' results
    const releaseKey = makeReleaseKey(type, imdbId, episodeInfo?.season, episodeInfo?.episode);
    const allExternalHashes = [...new Set(externalTorrents.map(t => (t.InfoHash || t.hash || '').toLowerCase()).filter(Boolean))];
    
    let stremthruCachedHashes = new Set();
    if (stremThru.isEnabled() && apiKey) {
      try {
        // Build SId for episode-specific filtering (like Torz does: imdbid:season:episode)
        let sid = null;
        if (type === 'series' && imdbId && season && episode) {
          sid = `${imdbId}:${season}:${episode}`;
        }
        
        console.log(`[${LOG_PREFIX}] Querying StremThru for ${allExternalHashes.length} hashes (RD)`);
        stremthruCachedHashes = await stremThru.checkInstantAvailability(allExternalHashes, 'realdebrid', apiKey, clientIp, sid);
        console.log(`[${LOG_PREFIX}] StremThru returned ${stremthruCachedHashes.size} cached hashes`);
      } catch (error) {
        console.error(`[${LOG_PREFIX}] Error querying StremThru:`, error.message);
      }
    }
    
    // Phase 3: Get results from personal SQLite cache as well (user's personal cloud results)
    let sqliteCachedHashes = new Set();
    if (sqliteCache?.isEnabled()) {
        try {
          const results = await sqliteCache.getCachedHashes('realdebrid', allExternalHashes);
          for (const hash of results) {
              sqliteCachedHashes.add(hash.toLowerCase());
          }
          console.log(`[${LOG_PREFIX}] SQLite returned ${sqliteCachedHashes.size} cached hashes`);
        } catch (error) {
          console.error(`[${LOG_PREFIX}] Error getting SQLite cached hashes:`, error.message);
        }
    }
    
    // Phase 4: Combine all cached results (StremThru = others' cached, SQLite = user's personal, Torz = confirmed cached) and return immediately
    // Add confirmed cached hashes from Torz API to the combined set
    const confirmedCachedHashes = new Set(
      confirmedCachedTorrents.map(t => (t.InfoHash || t.hash || '').toLowerCase()).filter(Boolean)
    );
    const combinedCachedHashes = new Set([...stremthruCachedHashes, ...sqliteCachedHashes, ...confirmedCachedHashes]);

    console.log(`[${LOG_PREFIX}] Total cached hashes: ${combinedCachedHashes.size} (StremThru: ${stremthruCachedHashes.size}, SQLite: ${sqliteCachedHashes.size}, Torz confirmed: ${confirmedCachedHashes.size})`);

    const cachedExternalTorrents = externalTorrents.filter(t => combinedCachedHashes.has((t.InfoHash || t.hash || '').toLowerCase()));
    const uncachedExternalTorrents = externalTorrents.filter(t => !combinedCachedHashes.has((t.InfoHash || t.hash || '').toLowerCase()));

    console.log(`[${LOG_PREFIX}] Returning ${cachedExternalTorrents.length} cached results immediately, ${uncachedExternalTorrents.length} will be checked in background`);

    // Save initially cached results to SQLite with full metadata (from StremThru/SQLite check)
    if (sqliteCache?.isEnabled() && cachedExternalTorrents.length > 0) {
      try {
        const upserts = [];
        for (const t of cachedExternalTorrents) {
          const hash = (t.InfoHash || t.hash || '').toLowerCase();
          if (!hash) continue;
          // Only add if not already in sqliteCachedHashes (to avoid redundant writes)
          if (!sqliteCachedHashes.has(hash)) {
            upserts.push({
              service: 'realdebrid',
              hash,
              fileName: t.Title || t.name || null,
              size: t.Size || t.size || null,
              releaseKey,
              category: getQualityCategory(t.Title || t.name || ''),
              resolution: torrentUtils.getResolutionFromName(t.Title || t.name || ''),
              data: { source: 'initial-cache-check', status: 'cached' }
            });
          }
        }
        if (upserts.length > 0) {
          deferSqliteUpserts(uniqueUpserts(upserts));
          console.log(`[${LOG_PREFIX}] Deferred ${upserts.length} initially cached torrents to SQLite`);
        }
      } catch (error) {
        console.error(`[${LOG_PREFIX}] Error saving initially cached results to SQLite:`, error.message);
      }
    }

    // Format and return cached results immediately (both StremThru cached and SQLite cached)
    const cachedResults = cachedExternalTorrents.map(torrent => formatCachedResult(torrent, true));
    const personalResults = enrichedPersonalFiles.map(file => formatCachedResult(file, true));
    
    const combined = [...personalResults, ...cachedResults];
    let allResults = combined;
    
    // Check if we have StremThru cached results and should bypass quotas
    const hasStremThruResults = stremthruCachedHashes.size > 0;
    
    if (episodeInfo) {
        allResults = allResults.filter(item => {
            // Allow personal files, items from pack inspection, confirmed cached from Torz, and any cached results
            // Cached results are already verified as available, so safe to include even if they're packs
            if (item.isPersonal || item.episodeHint || item.isConfirmedCached || item.isCached) {
                return true;
            }
            // For external files, if it's a pack, it must have come from inspection.
            // Since we are filtering items without episodeHint, we check if it's a pack. If so, reject.
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

    allResults.sort((a, b) => {
      const rankA = resolutionOrder[getResolutionFromName(a.name)];
      const rankB = resolutionOrder[getResolutionFromName(b.name)];
      if (rankA !== rankB) return rankB - rankA;
      return (b.size || 0) - (a.size || 0);
    });

    // Phase 5: Start background processing for uncached torrents to update caches (the API cache check)
    if (uncachedExternalTorrents.length > 0) {
      const RD = createRealDebridClient(apiKey, { clientIp });
      let permissionDenied = false;

      // Track hashes we already checked in foreground to avoid redundant checks
      const foregroundCheckedHashes = new Set(allExternalHashes.map(h => h.toLowerCase()));

      const rdHandler = {
          getIdentifier: () => LOG_PREFIX,
          isAborted: () => permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted(),
          checkCachedHashes: async (hashes) => {
              if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) return new Set();

              // Filter out hashes we already checked in foreground to avoid redundant API calls
              const newHashes = hashes.filter(h => !foregroundCheckedHashes.has(h.toLowerCase()));

              if (newHashes.length === 0) {
                // All hashes were already checked in foreground, no need to re-check
                return new Set();
              }

              console.log(`[RD CACHE-CHECK] Checking ${newHashes.length} new hashes not checked in foreground`);

              let cached = new Set();
              // First check SQLite cache for existing results
              try {
                if (sqliteCache?.isEnabled()) {
                  const sqliteResults = await sqliteCache.getCachedHashes('realdebrid', newHashes);
                  for (const hash of sqliteResults) {
                    cached.add(hash.toLowerCase());
                  }
                }
              } catch {}

              // Additionally check StremThru for any hashes not yet in SQLite
              if (stremThru?.isEnabled() && apiKey && cached.size < newHashes.length) {
                try {
                  // Build SId for episode-specific filtering (like Torz does: imdbid:season:episode)
                  let sid = null;
                  if (type === 'series' && imdbId && season && episode) {
                    sid = `${imdbId}:${season}:${episode}`;
                  }
                  
                  const hashesToCheck = newHashes.filter(hash => !cached.has(hash.toLowerCase()));
                  if (hashesToCheck.length > 0) {
                    const stremthruResults = await stremThru.checkInstantAvailability(hashesToCheck, 'realdebrid', apiKey, clientIp, sid);
                    for (const hash of stremthruResults) {
                      cached.add(hash.toLowerCase());
                    }
                  }
                } catch (stremError) {
                  console.error(`[RD CACHE-CHECK] Error checking StremThru during background:`, stremError.message);
                }
              }

              return cached;
          },
          liveCheckHash: async (hash) => {
              if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) return false;
              let torrentId;
              try {
                  const magnet = `magnet:?xt=urn:btih:${hash}`;
                  // Don't catch errors here - let the rate limiter handle retries
                  const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet), apiKey);
                  if (!addResponse?.data?.id) {
                    console.log(`[${LOG_PREFIX} CACHE-CHECK] addMagnet failed for ${hash} (no torrent ID returned)`);
                    return false;
                  }
                  torrentId = addResponse.data.id;
                  torrentIdsToDelete.add(torrentId);
                  await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'), apiKey);
                  // Don't catch errors here - let the rate limiter handle retries
                  const torrentInfo = await rdCall(() => RD.torrents.info(torrentId), apiKey);
                  const status = torrentInfo?.data?.status || 'unknown';
                  if (!['downloaded', 'finished'].includes(status)) {
                    console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} not cached (status=${status}).`);
                    return false;
                  }
                  const files = torrentInfo?.data?.files || [];
                  const JUNK_EXTENSIONS = ['.iso', '.exe', '.zip', '.rar', '.7z', '.scr'];
                  const hasJunk = files.some(f => JUNK_EXTENSIONS.some(ext => f.path.toLowerCase().endsWith(ext)));
                  const hasVideo = files.some(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
                  if (!hasVideo) {
                    console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} has no valid video files after finish.`);
                    return false;
                  }
                  if (hasJunk) {
                    const sample = files.find(f => JUNK_EXTENSIONS.some(ext => f.path.toLowerCase().endsWith(ext)))?.path || 'unknown';
                    console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} contains junk file(s) e.g. ${sample}.`);
                    return false;
                  }
                  // Persist to SQLite when successful
                  try {
                    const largestVideo = files
                      .filter(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX))
                      .sort((a,b) => (b.bytes||0)-(a.bytes||0))[0] || null;
                    await addHashToSqlite(hash, largestVideo?.path || null, largestVideo?.bytes || null, { status });
                  } catch {}
                  return true;
              } catch (e) {
                const status = e?.response?.status || e?.status;
                const message = e?.response?.data?.error || e?.message || 'unknown';

                // Check for permission denied (403) and abort the entire search
                if (status === 403 && message && message.toLowerCase().includes('permission')) {
                  console.error(`[${LOG_PREFIX} CACHE-CHECK] ⛔ Permission denied (HTTP 403) - stopping all searches for this user. Please check your RealDebrid API key and account status.`);
                  permissionDenied = true;
                  return false;
                }

                console.log(`[${LOG_PREFIX} CACHE-CHECK] Exception during live check for ${hash}: ${status ? `HTTP ${status}` : ''} ${message}`);
              }
              return false;
          },
          batchCheckSeasonPacks: async (hashes, season, episode) => {
              if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) return new Map();
              const MAX_PACKS_TO_INSPECT = config.MAX_PACKS_TO_INSPECT || 3;
              const packResults = new Map();
              let inspectedCount = 0;

              for (const hash of hashes) {
                  if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) break;
                  if (inspectedCount >= MAX_PACKS_TO_INSPECT) break;
                  try {
                      let torrentId;
                      const torrentsResponse = await rdCall(() => RD.torrents.get(0, 1, 100), apiKey);
                      const existingTorrent = (torrentsResponse.data || []).find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase());

                      if (existingTorrent) {
                          torrentId = existingTorrent.id;
                      } else {
                          const magnet = `magnet:?xt=urn:btih:${hash}`;
                          const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet), apiKey);
                          if (!addResponse?.data?.id) continue;
                          torrentId = addResponse.data.id;
                          torrentIdsToDelete.add(torrentId);
                          await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'), apiKey);
                      }
                      const info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
                      if (!info?.data?.files) continue;

                      const JUNK_EXTENSIONS = ['.iso', '.exe', '.zip', '.rar', '.7z', '.scr'];
                      const matchingFiles = info.data.files.filter(file => {
                          const isJunk = JUNK_EXTENSIONS.some(ext => file.path.toLowerCase().endsWith(ext));
                          if (isJunk) return false; // Reject junk files

                          const parsed = PTT.parse(file.path) || {};
                          return parsed.season === season && parsed.episode === episode;
                      });

                      if (matchingFiles.length > 0) {
                          matchingFiles.sort((a, b) => b.bytes - a.bytes);
                          const bestFile = matchingFiles[0];
                          const episodeResult = {
                              InfoHash: hash, Title: bestFile.path, name: bestFile.path, Size: bestFile.bytes,
                              size: bestFile.bytes, Seeders: 0, Tracker: 'Pack Inspection',
                              episodeFileHint: { filePath: bestFile.path, fileBytes: bestFile.bytes, torrentId: torrentId, fileId: bestFile.id },
                              isCached: true, isFromPack: true, packHash: hash, searchableName: info.data.filename
                          };
                          packResults.set(hash, [episodeResult]);
                          inspectedCount++;
                      }
                  } catch (error) {
                      const status = error?.response?.status || error?.status;
                      const message = error?.response?.data?.error || error?.message || 'unknown';

                      // Check for permission denied and abort
                      if (status === 403 && message && message.toLowerCase().includes('permission')) {
                          console.error(`[RD PACK INSPECT] ⛔ Permission denied (HTTP 403) - stopping all searches for this user. Please check your RealDebrid API key and account status.`);
                          permissionDenied = true;
                          break;
                      }

                      if (error.response?.status === 429) {
                          console.warn(`[RD PACK INSPECT] Rate limited on pack ${hash.substring(0,8)}. Pausing for 2s.`);
                          await delay(2000);
                      }
                      console.error(`[RD PACK INSPECT] 💥 Error inspecting pack ${hash}: ${error.message}`);
                  }
              }
              return packResults;
          },
          cleanup: async () => {
            await saveHashCache(); // no-op; file cache removed
            if (torrentIdsToDelete.size > 0) cleanupTemporaryTorrents(RD, torrentIdsToDelete, apiKey);
          }
      };

      setImmediate(async () => {
        try {
            // Sort by resolution priority first (4K, 1080p, 720p, etc.), then by seeders within each resolution
            uncachedExternalTorrents.sort((a, b) => {
                // First sort by resolution priority (higher resolution first)
                const resolutionA = getResolutionFromName(a.name || a.Title || '');
                const resolutionB = getResolutionFromName(b.name || b.Title || '');

                // If resolutions are different, sort by resolution priority (higher resolution first)
                if (resolutionA !== resolutionB) {
                    const rankA = resolutionOrder[resolutionA] || 0;
                    const rankB = resolutionOrder[resolutionB] || 0;
                    // Higher rank value means higher priority (4K > 1080p > 720p > 480p)
                    return rankB - rankA; // Higher resolution first
                }

                // If same resolution, sort by seeders first, then by size
                const seedersA = a.Seeders || a.seeders || 0;
                const seedersB = b.Seeders || b.seeders || 0;
                if (seedersB !== seedersA) {
                    return seedersB - seedersA; // Higher seeders first within same resolution
                }
                return (b.Size || b.size || 0) - (a.Size || a.size || 0); // Then by size if seeders are equal
            });
            
            // Process the remaining uncached torrents in the background
            // Bypass quotas if we had StremThru cached results to ensure all cached results are returned
            const bypassQuotas = hasStremThruResults;
            const backgroundCachedResults = await processAndFilterTorrents(uncachedExternalTorrents, rdHandler, episodeInfo, { byCategory: {}, byCategoryResolution: {} }, bypassQuotas);
            const backgroundNonCachedTorrents = uncachedExternalTorrents.filter(t => !backgroundCachedResults.some(c => c.InfoHash === t.InfoHash));

            // Update SQLite cache with background results (both API checked and those that were found in background)
            if (backgroundCachedResults.length > 0) {
              try {
                if (sqliteCache?.isEnabled()) {
                  const upserts = [];
                  for (const t of backgroundCachedResults) {
                    const hash = (t.InfoHash || t.hash || '').toLowerCase();
                    if (!hash) continue;
                    upserts.push({
                      service: 'realdebrid',
                      hash,
                      fileName: t.name || t.Title || null,
                      size: t.size || t.Size || null,
                      releaseKey,
                      category: t.category || getQualityCategory(t.name || t.Title || ''),
                      resolution: torrentUtils.getResolutionFromName(t.name || t.Title || ''),
                      data: { source: t.isPersonal ? 'personal' : (t.isCached ? 'cached' : 'checked') }
                    });
                  }
                  deferSqliteUpserts(uniqueUpserts(upserts));
                }
              } catch (error) {
                console.error(`[${LOG_PREFIX}] Error updating SQLite cache:`, error.message);
              }
            }
            
            console.log(`[${LOG_PREFIX}] Background cache check completed for ${uncachedExternalTorrents.length} uncached external torrents, found ${backgroundCachedResults.length} cached`);
        } catch (error) {
            console.error(`[${LOG_PREFIX}] Background cache check failed:`, error.message);
        } finally {
            try {
                if (rdHandler && typeof rdHandler.cleanup === 'function') {
                    await rdHandler.cleanup();
                }
            } catch (cleanupError) {
                console.error(`[${LOG_PREFIX}] Background cleanup failed:`, cleanupError.message);
            }
        }
      });
    }

    console.log(`[${LOG_PREFIX}] Returning ${allResults.length} immediate cached streams (sorted)`);
    return allResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Comprehensive search failed: ${error.message}`);
    return [];
  } finally {
    await saveHashCache();
    cleanupTemporaryTorrents(createRealDebridClient(apiKey), torrentIdsToDelete, apiKey);
  }
}

async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
  await loadHashCache(); // no-op; file cache removed
  const RD = createRealDebridClient(apiKey);
  const torrentIdsToDelete = new Set();
  let permissionDenied = false;

  const rdHandler = {
    getIdentifier: () => LOG_PREFIX,
    isAborted: () => permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted(),
    checkCachedHashes: async (hashes) => {
      if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) return new Set();
      let cached = new Set();
      try {
        if (sqliteCache?.isEnabled()) {
          const sqliteResults = await sqliteCache.getCachedHashes('realdebrid', hashes);
          for (const hash of sqliteResults) {
            cached.add(hash.toLowerCase());
          }
        }
      } catch {}
      
      // Additionally check StremThru for any hashes not yet in SQLite
      if (stremThru?.isEnabled() && apiKey && cached.size < hashes.length) {
        try {
          const hashesToCheck = hashes.filter(hash => !cached.has(hash.toLowerCase()));
          if (hashesToCheck.length > 0) {
            const stremthruResults = await stremThru.checkInstantAvailability(hashesToCheck, 'realdebrid', apiKey, null);
            for (const hash of stremthruResults) {
              cached.add(hash.toLowerCase());
            }
          }
        } catch (stremError) {
          console.error(`[RD CACHE-CHECK] Error checking StremThru in searchTorrents:`, stremError.message);
        }
      }
      
      return cached;
    },
    liveCheckHash: async (hash) => {
      if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) return false;
      let torrentId;
      try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        // Don't catch errors here - let the rate limiter handle retries
        const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet), apiKey);
        if (!addResponse?.data?.id) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] addMagnet failed for ${hash} (no torrent ID returned)`);
          return false;
        }
        torrentId = addResponse.data.id;
        torrentIdsToDelete.add(torrentId);
        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'), apiKey);
        // Don't catch errors here - let the rate limiter handle retries
        const torrentInfo = await rdCall(() => RD.torrents.info(torrentId), apiKey);
        const status = torrentInfo?.data?.status || 'unknown';
        if (!['downloaded', 'finished'].includes(status)) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} not cached (status=${status}).`);
          return false;
        }
        const files = torrentInfo?.data?.files || [];
        const hasVideo = files.some(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
        const hasJunk = files.some(f => /\.(iso|exe|zip|rar|7z)$/i.test(f.path));
        if (!hasVideo) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} has no valid video files after finish.`);
          return false;
        }
        if (hasJunk) {
          const sample = files.find(f => /(\.iso|\.exe|\.zip|\.rar|\.7z)$/i.test(f.path))?.path || 'unknown';
          console.log(`[${LOG_PREFIX} CACHE-CHECK] ${hash} contains junk file(s) e.g. ${sample}.`);
          return false;
        }
        return true;
      } catch (e) {
        const status = e?.response?.status || e?.status;
        const message = e?.response?.data?.error || e?.message || 'unknown';

        // Check for permission denied (403) and abort the entire search
        if (status === 403 && message && message.toLowerCase().includes('permission')) {
          console.error(`[${LOG_PREFIX} CACHE-CHECK] ⛔ Permission denied (HTTP 403) - stopping all searches for this user. Please check your RealDebrid API key and account status.`);
          permissionDenied = true;
          return false;
        }

        console.log(`[${LOG_PREFIX} CACHE-CHECK] Exception during live check for ${hash}: ${status ? `HTTP ${status}` : ''} ${message}`);
      }
      return false;
    },
    cleanup: async () => {
      await saveHashCache(); // no-op; file cache removed
      if (torrentIdsToDelete.size > 0) cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete), apiKey);
    }
  };

  // Fetch external torrents using orchestrateScrapers since externalTorrents is not defined in this scope
  const scraperResults = await orchestrateScrapers({
    type: 'all',
    imdbId: null,
    searchKey: searchKey || '',
    baseSearchKey: searchKey || '',
    season: null,
    episode: null,
    signal: null,
    logPrefix: LOG_PREFIX,
    userConfig: {},
    selectedLanguages: []
  });
  
  const externalTorrents = [].concat(...scraperResults).map(t => ({ ...t, isPersonal: false }));
  const uniqueExternalTorrents = [...new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t])).values()];
  
  // Check if StremThru is enabled and potentially has cached results
  const hasStremThruResults = stremThru.isEnabled() && config.STREMTHRU_API_TOKEN;
  let cachedResults = await processAndFilterTorrents(uniqueExternalTorrents, rdHandler, null, {}, hasStremThruResults);
  if (uniqueExternalTorrents.length > 0) {

  }
  return cachedResults;
}

// ---------------------------------------------------------------------------------
// Other functions
// ---------------------------------------------------------------------------------

async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3, clientIp = null) {
  const RD = createRealDebridClient(apiKey, { clientIp });
  try {
    // Try to get cached personal files first
    let cached = personalFilesCache.get(apiKey);
    let existingTorrents, existingDownloads;

    if (cached) {
      existingTorrents = cached.torrents;
      existingDownloads = cached.downloads;
    } else {
      // Cache miss - fetch from API
      [existingTorrents, existingDownloads] = await Promise.all([
        getAllTorrents(RD, apiKey).catch(() => []),
        getAllDownloads(RD, apiKey).catch(() => [])
      ]);
      // Store in cache
      personalFilesCache.set(apiKey, existingTorrents, existingDownloads);
    }

    const relevantTorrents = filterFilesByKeywords(existingTorrents, searchKey);
    const relevantDownloads = filterFilesByKeywords(existingDownloads, searchKey);

    // Only fetch torrent info for relevant torrents (not all torrents)
    const torrentFiles = await processTorrents(RD, relevantTorrents.slice(0, 3), apiKey); // Reduced from 5 to 3
    const allFiles = [...torrentFiles, ...relevantDownloads.map(d => formatDownloadFile(d))];
    if (allFiles.length === 0) return [];
    const uniqueFiles = [...new Map(allFiles.map(file => [file.url, file])).values()];
    const enhancedFiles = uniqueFiles.map(file => ({ ...file, isPersonal: true, info: PTT.parse(file.name) }));
    const fuse = new Fuse(enhancedFiles, { keys: ['info.title', 'name'], threshold, minMatchCharLength: 2 });
    return fuse.search(searchKey).map(r => r.item);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Personal files error: ${error.message}`);
    return [];
  }
}

async function resolveStreamUrl(apiKey, encodedUrl, clientIp) {
    try {
        let decodedUrl = decodeURIComponent(encodedUrl).trim();
        if (decodedUrl.includes('magnet:')) {
            const result = await resolveMagnetUrl(apiKey, decodedUrl, clientIp);
            if (!result) return null;
            if (result.startsWith('http')) return result;
            if (result.startsWith('realdebrid:')) return await unrestrictUrl(apiKey, result, clientIp);
            if (result.includes('magnet:')) return await processMagnetAlternative(apiKey, result, clientIp);
            return result;
        } else {
            return await unrestrictUrl(apiKey, decodedUrl, clientIp);
        }
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error in resolveStreamUrl: ${error.message}`);
        return null;
    }
}

async function processMagnetAlternative(apiKey, magnetUrl, clientIp) {
  const RD = createRealDebridClient(apiKey, { ip: clientIp });
  try {
    const hashMatch = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!hashMatch?.[1]) return null;
    const hash = hashMatch[1].toLowerCase();

    // file cache removed; try API directly
    const addResponse = await rdCall(() => RD.torrents.addMagnet(magnetUrl), apiKey);
    if (!addResponse?.data?.id) return null;
    const torrentId = addResponse.data.id;
    await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'), apiKey);

    // Add a delay to allow RealDebrid to process the torrent before getting info
    await delay(1000);

    let info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
    if (!info?.data?.files) return null;

    // Wait for links to become available with multiple attempts
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
        if (info.data.links && Array.isArray(info.data.links) && info.data.links.length > 0) {
            break;
        }
        await delay(1000); // Wait 1 second between attempts
        info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
        attempts++;
    }
    
    if (!info.data.links || !Array.isArray(info.data.links) || info.data.links.length === 0) {
        console.log(`[${LOG_PREFIX}] Error: No links available for torrent ${torrentId} in processMagnetAlternative after ${maxAttempts} attempts`);
        return null;
    }

    // Create file-link mapping more robustly
    const files = info.data.files || [];
    const links = info.data.links || [];
    
    // Map files to links more reliably
    const filesWithLinks = files
        .filter(file => file.selected !== false) // Only selected files
        .map(file => {
            // Try to find a matching link for this file
            if (file.links && Array.isArray(file.links) && file.links.length > 0) {
                return { ...file, link: file.links[0] }; // Use the first available link
            }
            // Fallback: match by index
            const link = links[file.id]; // Use file.id as the index
            if (link && link !== 'undefined') {
                return { ...file, link };
            }
            // If no match found by id, try by position in the files array
            const positionIndex = files.indexOf(file);
            if (positionIndex < links.length && links[positionIndex] && links[positionIndex] !== 'undefined') {
                return { ...file, link: links[positionIndex] };
            }
            return null;
        })
        .filter(f => f !== null);

    if (filesWithLinks.length === 0) {
        console.log(`[${LOG_PREFIX}] Error: No files with valid links found in processMagnetAlternative for torrent ${torrentId}`);
        return null;
    }
    
    let selected = filesWithLinks.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (!selected) { 
        filesWithLinks.sort((a, b) => (b.bytes || 0) - (a.bytes || 0)); 
        selected = filesWithLinks[0]; 
    }
    
    if (!selected) {
        console.log(`[${LOG_PREFIX}] Error: No valid video file found in processMagnetAlternative for torrent ${torrentId}`);
        return null;
    }
    
    // file cache removed; rely on Mongo upsert only
    try { await addHashToSqlite(hash, selected?.path || null, selected?.bytes || null, { torrentId }); } catch {}
    return `realdebrid:${torrentId}:${selected.id}`;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] processMagnetAlternative error: ${error.message}`);
    return null;
  }
}

async function resolveMagnetUrl(apiKey, magnetUrl, clientIp) {
  const RD = createRealDebridClient(apiKey, { ip: clientIp });
  console.log(`[${LOG_PREFIX} RESOLVER] Resolving magnet URL: ${magnetUrl.substring(0, 100)}...`);
  try {
    // Parse HINT payload if present (for season pack episode files)
    let hintPayload = null;
    if (magnetUrl.includes('||HINT||')) {
      const parts = magnetUrl.split('||HINT||');
      magnetUrl = parts[0];
      try {
        hintPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        console.log(`[${LOG_PREFIX} RESOLVER] Pack hint found:`, hintPayload);
      } catch (e) {
        console.error(`[${LOG_PREFIX} RESOLVER] Failed to parse HINT: ${e.message}`);
      }
    }

    const m = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!m?.[1]) {
      console.error(`[${LOG_PREFIX} RESOLVER] Could not parse hash from magnet: ${magnetUrl}`);
      return null;
    }
    const hash = m[1].toLowerCase();

    let torrentId = null;
    let torrentData = null;

    // Try to reuse torrentId from hint if available
    if (hintPayload?.torrentId) {
      torrentId = hintPayload.torrentId;
      console.log(`[${LOG_PREFIX} RESOLVER] Using torrentId from hint: ${torrentId}`);
      try {
        const info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
        if (info?.data && ['downloaded', 'finished', 'uploading'].includes(info.data.status)) {
          torrentData = info.data;
        } else {
          console.warn(`[${LOG_PREFIX} RESOLVER] Torrent ${torrentId} from hint is not ready (status: ${info?.data?.status}). Will search for another.`);
          torrentId = null;
        }
      } catch (e) {
        console.warn(`[${LOG_PREFIX} RESOLVER] Failed to get torrent ${torrentId} from hint. It might have been deleted. Falling back to search. Error: ${e.message}`);
        torrentId = null;
      }
    }

    // If hint didn't work, search for existing torrent by hash
    if (!torrentId) {
      console.log(`[${LOG_PREFIX} RESOLVER] Searching for existing torrent with hash ${hash.substring(0, 16)}...`);
      try {
        const torrentsResponse = await rdCall(() => RD.torrents.get(0, 1, 100), apiKey);
        const hit = (torrentsResponse.data || []).find(t => t.hash && t.hash.toLowerCase() === hash && ['downloaded', 'finished', 'uploading'].includes(t.status));
        if (hit) {
          torrentId = hit.id;
          console.log(`[${LOG_PREFIX} RESOLVER] Found existing torrent: ${torrentId}`);
        }
      } catch {}
    }

    // If still no torrent, upload the magnet
    if (!torrentId) {
      console.log(`[${LOG_PREFIX} RESOLVER] No existing torrent found, uploading magnet...`);
      const addResponse = await rdCall(() => RD.torrents.addMagnet(magnetUrl), apiKey);
      if (!addResponse?.data?.id) return null;
      torrentId = addResponse.data.id;
    }
    await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'), apiKey);

    // Add a delay to allow RealDebrid to process the torrent before getting info
    await delay(1000);

    let info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
    if (!info?.data?.files) return null;

    // Wait for links to become available with multiple attempts
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
        if (info.data.links && Array.isArray(info.data.links) && info.data.links.length > 0) {
            break;
        }
        await delay(1000); // Wait 1 second between attempts
        info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
        attempts++;
    }
    
    if (!info.data.links || !Array.isArray(info.data.links) || info.data.links.length === 0) {
        console.log(`[${LOG_PREFIX}] Error: No links available for torrent ${torrentId} after ${maxAttempts} attempts`);
        return null;
    }

    // Create file-link mapping more robustly
    const files = info.data.files || [];
    const links = info.data.links || [];
    
    // The API sometimes returns more files than links or vice versa
    // Map files to links by matching file size/index info
    const filesWithLinks = files
        .filter(file => file.selected !== false) // Only selected files
        .map(file => {
            // Try to find a matching link for this file
            // First, look for files that have a 'links' array in the file object itself (newer RealDebrid API)
            if (file.links && Array.isArray(file.links) && file.links.length > 0) {
                return { ...file, link: file.links[0] }; // Use the first available link
            }
            // Fallback: match by index (old method)
            const link = links[file.id]; // Use file.id as the index
            if (link && link !== 'undefined') {
                return { ...file, link };
            }
            // If no match found by id, try by position in the files array
            const positionIndex = files.indexOf(file);
            if (positionIndex < links.length && links[positionIndex] && links[positionIndex] !== 'undefined') {
                return { ...file, link: links[positionIndex] };
            }
            return null;
        })
        .filter(f => f !== null);

    if (filesWithLinks.length === 0) {
        console.log(`[${LOG_PREFIX} RESOLVER] Error: No files with valid links found for torrent ${torrentId}`);
        return null;
    }

    // Try to select file using hint if available
    let selected = null;
    if (hintPayload?.fileId != null) {
      selected = filesWithLinks.find(f => f.id === hintPayload.fileId);
      if (selected) {
        console.log(`[${LOG_PREFIX} RESOLVER] Selected file by hint fileId ${hintPayload.fileId}: "${selected.path}"`);
      } else {
        console.error(`[${LOG_PREFIX} RESOLVER] Hint fileId ${hintPayload.fileId} not found in torrent files.`);
        // Try fallback to filePath if provided
        if (hintPayload?.filePath) {
          selected = filesWithLinks.find(f => f.path === hintPayload.filePath);
          if (selected) console.log(`[${LOG_PREFIX} RESOLVER] Selected file by hint path as fallback: "${selected.path}"`);
        }
      }
    } else if (hintPayload?.filePath) {
      selected = filesWithLinks.find(f => f.path === hintPayload.filePath);
      if (selected) {
        console.log(`[${LOG_PREFIX} RESOLVER] Selected file by hint path: "${selected.path}"`);
      }
    }

    // Fallback to heuristic selection if hint didn't work
    if (!selected) {
      console.log(`[${LOG_PREFIX} RESOLVER] No hint match or hint invalid. Falling back to largest video file.`);
      selected = filesWithLinks.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
      if (!selected) {
        filesWithLinks.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
        selected = filesWithLinks[0];
      }
      if (selected) {
        console.log(`[${LOG_PREFIX} RESOLVER] Fallback selected file: "${selected.path}"`);
      }
    }

    if (!selected) {
        console.log(`[${LOG_PREFIX} RESOLVER] Error: No valid video file found in torrent ${torrentId}`);
        return null;
    }
    
    // file cache removed; rely on Mongo upsert only
    try { await addHashToSqlite(hash, selected?.path || null, selected?.bytes || null, { torrentId }); } catch {}

    const finalRef = `realdebrid:${torrentId}:${selected.id}`;
    console.log(`[${LOG_PREFIX} RESOLVER] Successfully created file reference: ${finalRef}`);
    return finalRef;
  } catch (error) {
    console.error(`[${LOG_PREFIX} RESOLVER] Exception in resolveMagnetUrl: ${error?.message || error}`);
    return null;
  }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
  const RD = createRealDebridClient(apiKey, { ip: clientIp });
  try {
    if (!hostUrl || hostUrl.includes('undefined')) {
      console.log(`[${LOG_PREFIX}] unrestrictUrl: Invalid hostUrl: ${hostUrl}`);
      return null;
    }
    if (hostUrl.startsWith('realdebrid:')) {
      const parts = hostUrl.split(':');
      const torrentId = parts[1];
      const fileId = parts[2];
      console.log(`[${LOG_PREFIX}] unrestrictUrl: Processing realdebrid format - torrentId: ${torrentId}, fileId: ${fileId}`);
      if (!torrentId || !fileId) {
        console.log(`[${LOG_PREFIX}] unrestrictUrl: Missing torrentId or fileId`);
        return null;
      }
      let info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
      if (!info?.data) {
        console.log(`[${LOG_PREFIX}] unrestrictUrl: No info found for torrent ${torrentId}`);
        return null;
      }

      // Wait for links to be available if they're not ready yet
      let attempts = 0;
      const maxAttempts = 10;
      while ((attempts < maxAttempts) && (!info.data.links || info.data.links.length === 0)) {
        console.log(`[${LOG_PREFIX}] unrestrictUrl: Waiting for links to become available for torrent ${torrentId} (attempt ${attempts + 1}/${maxAttempts})`);
        await delay(1000);
        info = await rdCall(() => RD.torrents.info(torrentId), apiKey);
        attempts++;
      }
      
      if (!info.data.links || info.data.links.length === 0) {
        console.log(`[${LOG_PREFIX}] unrestrictUrl: No links available after ${maxAttempts} attempts for torrent ${torrentId}`);
        return null;
      }
      
      console.log(`[${LOG_PREFIX}] unrestrictUrl: Found ${info.data.files?.length || 0} files, ${info.data.links.length} links`);
      
      // Find the file by ID more robustly
      let directLink = null;
      const files = info.data.files || [];
      
      // First try to find by file ID in the files array
      for (let i = 0; i < files.length; i++) {
        if (files[i]?.id?.toString() === fileId.toString()) {
          // Use the index of this file to get the corresponding link
          if (i < info.data.links.length) {
            directLink = info.data.links[i];
            break;
          }
          // Or if the file has its own links array (newer API)
          if (files[i]?.links && Array.isArray(files[i].links) && files[i].links.length > 0) {
            directLink = files[i].links[0];
            break;
          }
        }
      }
      
      // Fallback: if the direct index doesn't work, try to find by matching on the file ID property
      if (!directLink) {
        const fileObj = files.find(f => f.id?.toString() === fileId.toString());
        if (fileObj && fileObj.links && Array.isArray(fileObj.links) && fileObj.links.length > 0) {
          directLink = fileObj.links[0];
        } else if (fileObj) {
          // Use the position of the file in the array to get the corresponding link
          const fileIndex = files.indexOf(fileObj);
          if (fileIndex >= 0 && fileIndex < info.data.links.length) {
            directLink = info.data.links[fileIndex];
          }
        }
      }
      
      // If still no link found, try using the fileId directly as an index (old API behavior)
      if (!directLink && !isNaN(fileId)) {
        const idx = parseInt(fileId, 10);
        if (idx >= 0 && idx < info.data.links.length) {
          directLink = info.data.links[idx];
        }
      }
      
      console.log(`[${LOG_PREFIX}] unrestrictUrl: Direct link for file ${fileId}: ${directLink ? 'found' : 'not found'}`);
      if (!directLink || directLink === 'undefined') {
        console.log(`[${LOG_PREFIX}] unrestrictUrl: Could not find direct link for file ${fileId} in torrent ${torrentId}`);
        return null;
      }

      const response = await rdCall(() => RD.unrestrict.link(directLink), apiKey);
      const downloadUrl = response?.data?.download || null;
      console.log(`[${LOG_PREFIX}] unrestrictUrl: Final download URL: ${downloadUrl ? 'obtained' : 'failed'}`);
      return downloadUrl;
    } else if (hostUrl.includes('magnet:')) {
      console.log(`[${LOG_PREFIX}] unrestrictUrl: Processing magnet link`);
      const fileReference = await resolveMagnetUrl(apiKey, hostUrl, clientIp);
      if (!fileReference) return null;
      if (fileReference.startsWith('http')) return fileReference;
      return await unrestrictUrl(apiKey, fileReference, clientIp);
    } else {
      console.log(`[${LOG_PREFIX}] unrestrictUrl: Unrestricting direct URL`);
      const response = await rdCall(() => RD.unrestrict.link(hostUrl), apiKey);
      return response?.data?.download || null;
    }
  } catch (error) {
    console.error(`[${LOG_PREFIX}] unrestrictUrl error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return null;
  }
}

async function getAllTorrents(RD, apiKey) {
  const allTorrents = [];
  try {
    for (let page = 1; page <= 2; page++) {
      const response = await rdCall(() => RD.torrents.get(0, page, 100), apiKey);
      const torrents = response.data;
      if (!torrents || torrents.length === 0) break;
      allTorrents.push(...torrents);
      if (torrents.length < 50) break;
    }
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error fetching torrents: ${error.message}`);
  }
  return allTorrents;
}

async function getAllDownloads(RD, apiKey) {
  try {
    const response = await rdCall(() => RD.downloads.get(0, 1, 100), apiKey);
    const allDownloads = response.data || [];
    console.log(`[${LOG_PREFIX}] getAllDownloads: Found ${allDownloads.length} downloads`);
    return allDownloads;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error fetching downloads: ${error.message}`);
    return [];
  }
}

async function processTorrents(RD, torrents, apiKey) {
  const allVideoFiles = [];
  for (const torrent of torrents.slice(0, 3)) {
    try {
      const info = await rdCall(() => RD.torrents.info(torrent.id), apiKey);
      if (!info?.data?.files || !info.data.links) continue;
      const videoFiles = info.data.files.filter(file => file.selected && isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX));
      for (const file of videoFiles) {
        const fileReference = `realdebrid:${torrent.id}:${file.id}`;
        allVideoFiles.push({
            id: `${torrent.id}:${file.id}`,
            name: file.path,
            info: PTT.parse(file.path),
            size: file.bytes,
            hash: torrent.hash,
            url: fileReference,
            isPersonal: true,
            isCached: true,
            tracker: 'Personal',
            category: getQualityCategory(file.path),
            resolution: torrentUtils.getResolutionFromName(file.path),
            torrentId: torrent.id,
            fileId: file.id
        });
      }
    } catch (error) {
      console.error(`[${LOG_PREFIX}] Error processing torrent ${torrent.id}: ${error.message}`);
    }
  }
  return allVideoFiles;
}

function formatDownloadFile(download) {
  return {
    id: download.id,
    name: download.filename,
    info: PTT.parse(download.filename),
    size: download.filesize,
    url: download.download,
    isPersonal: true,
    isCached: true,
    tracker: 'Personal',
    category: getQualityCategory(download.filename),
    resolution: torrentUtils.getResolutionFromName(download.filename)
  };
}

function filterFilesByKeywords(files, searchKey) {
  const keywords = (searchKey || '').toLowerCase().split(' ').filter(w => w.length > 2);
  return files.filter(file => {
    const fileName = (file.filename || '').toLowerCase();
    return keywords.some(k => fileName.includes(k));
  });
}

async function listTorrents(apiKey, skip = 0) {
  const RD = createRealDebridClient(apiKey);
  try {
    // Use cached torrents if available to avoid API calls
    let allTorrents;
    const cached = personalFilesCache.get(apiKey);

    if (cached) {
      allTorrents = cached.torrents;
    } else {
      // Cache miss - fetch from API
      allTorrents = await getAllTorrents(RD, apiKey);
      const downloads = await getAllDownloads(RD, apiKey).catch(() => []);
      personalFilesCache.set(apiKey, allTorrents, downloads);
    }

    // Apply pagination to cached results
    const page = Math.floor(skip / 50);
    const start = page * 50;
    const end = start + 50;
    const pageTorrents = allTorrents.slice(start, end);

    const metas = pageTorrents.map(torrent => ({
      id: 'realdebrid:' + torrent.id,
      name: torrent.filename || 'Unknown',
      type: 'other',
      poster: null,
      background: null
    }));
    console.log(`[${LOG_PREFIX}] Returning ${metas.length} catalog items (from ${cached ? 'cache' : 'API'})`);
    return metas;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Catalog error: ${error.message}`);
    return [];
  }
}

async function getTorrentDetails(apiKey, id) {
  const RD = createRealDebridClient(apiKey);
  const torrentId = id.includes(':') ? id.split(':')[0] : id;
  try {
    const response = await rdCall(() => RD.torrents.info(torrentId), apiKey);
    return toTorrentDetails(apiKey, response.data);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Torrent details error: ${error.message}`);
    return {
      source: 'realdebrid',
      id: torrentId,
      name: 'Unknown Torrent',
      type: 'other',
      hash: null,
      info: { title: 'Unknown' },
      size: 0,
      created: new Date(),
      videos: []
    };
  }
}

async function toTorrentDetails(apiKey, item) {
  if (!item || !item.files) {
    return {
      source: 'realdebrid',
      id: item?.id || 'unknown',
      name: item?.filename || 'Unknown Torrent',
      type: 'other',
      hash: item?.hash || null,
      info: PTT.parse(item?.filename || '') || { title: 'Unknown' },
      size: item?.bytes || 0,
      created: new Date(item?.added || Date.now()),
      videos: []
    };
  }
  const videos = item.files
    .filter(file => file.selected && isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX))
    .map((file, index) => {
      const idx = item.files.findIndex(f => f.id === file.id);
      const hostUrl = item.links?.[idx];
      if (!hostUrl || hostUrl === 'undefined') return null;
      return {
        id: `${item.id}:${file.id}`,
        name: file.path,
        url: hostUrl,
        size: file.bytes,
        created: new Date(item.added),
        info: PTT.parse(file.path)
      };
    })
    .filter(Boolean);
  return {
    source: 'realdebrid',
    id: item.id,
    name: item.filename,
    type: 'other',
    hash: item.hash,
    info: PTT.parse(item.filename),
    size: item.bytes,
    created: new Date(item.added),
    videos: videos || []
  };
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
  try {
    const RD = createRealDebridClient(apiKey);
    const downloads = await getAllDownloads(RD, apiKey);

    // If no search key, return all downloads formatted for catalog
    if (!searchKey || searchKey.trim() === '') {
      return downloads.map(d => formatDownloadFile(d));
    }

    // Otherwise, perform fuzzy search
    const relevant = filterFilesByKeywords(downloads, searchKey).map(d => formatDownloadFile(d));
    const fuse = new Fuse(relevant, { keys: ['info.title', 'name'], threshold });
    return fuse.search(searchKey).map(r => r.item);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Downloads search error: ${error.message}`);
    return [];
  }
}

async function checkAndProcessCache(apiKey, externalTorrents) {
  await loadHashCache(); // no-op; file cache removed
  const RD = createRealDebridClient(apiKey);
  const torrentIdsToDelete = new Set();
  let permissionDenied = false;

  const rdHandler = {
    getIdentifier: () => LOG_PREFIX,
    isAborted: () => permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted(),
    checkCachedHashes: async (hashes) => {
      if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) return new Set();
      let cached = new Set();
      try {
        if (sqliteCache?.isEnabled()) {
          const sqliteResults = await sqliteCache.getCachedHashes('realdebrid', hashes);
          for (const hash of sqliteResults) {
            cached.add(hash.toLowerCase());
          }
        }
      } catch {}
      
      // Additionally check StremThru for any hashes not yet in SQLite
      if (stremThru?.isEnabled() && apiKey && cached.size < hashes.length) {
        try {
          const hashesToCheck = hashes.filter(hash => !cached.has(hash.toLowerCase()));
          if (hashesToCheck.length > 0) {
            const stremthruResults = await stremThru.checkInstantAvailability(hashesToCheck, 'realdebrid', apiKey, null);
            for (const hash of stremthruResults) {
              cached.add(hash.toLowerCase());
            }
          }
        } catch (stremError) {
          console.error(`[RD CACHE-CHECK] Error checking StremThru in checkAndProcessCache:`, stremError.message);
        }
      }

      return cached;
    },
    liveCheckHash: async (hash) => {
      if (permissionDenied || RdLimiter.getLimiter(apiKey).isRateLimitAborted()) return false;
      let torrentId;
      try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        // Don't catch errors here - let the rate limiter handle retries
        const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet), apiKey);
        if (!addResponse?.data?.id) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] addMagnet failed for ${hash} (no torrent ID returned)`);
          return false;
        }
        torrentId = addResponse.data.id;
        torrentIdsToDelete.add(torrentId);
        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'), apiKey);
        // Don't catch errors here - let the rate limiter handle retries
        const torrentInfo = await rdCall(() => RD.torrents.info(torrentId), apiKey);
        if (['downloaded', 'finished'].includes(torrentInfo?.data?.status)) {
          const files = torrentInfo.data.files || [];
          const hasVideo = files.some(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
          const hasJunk = files.some(f => /\.(iso|exe|zip|rar|7z)$/i.test(f.path));
          if (hasVideo && !hasJunk) {
        // file cache removed; rely on Mongo upsert (if used elsewhere)
        return true;
          }
        }
      } catch (e) {
        const status = e?.response?.status || e?.status;
        const message = e?.response?.data?.error || e?.message || 'unknown';

        // Check for permission denied (403) and abort the entire search
        if (status === 403 && message && message.toLowerCase().includes('permission')) {
          console.error(`[${LOG_PREFIX} CACHE-CHECK] ⛔ Permission denied (HTTP 403) - stopping all searches for this user. Please check your RealDebrid API key and account status.`);
          permissionDenied = true;
          return false;
        }

        console.log(`[${LOG_PREFIX} CACHE-CHECK] Exception during live check for ${hash}: ${status ? `HTTP ${status}` : ''} ${message}`);
      }
      return false;
    },
    cleanup: async () => {
      await saveHashCache(); // no-op; file cache removed
      if (torrentIdsToDelete.size > 0) cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete), apiKey);
    }
  };
  let cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, null, {}, false);
  if (externalTorrents.length > 0) {
      const nonCached = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));
      const verifiedNonCached = await inspectAndFilterNonCached(nonCached, rdHandler);
      cachedResults.push(...verifiedNonCached.map(t => ({...t, isCached: false})));
  }
  return cachedResults;
}


export default {
  listTorrents,
  searchTorrents,
  searchDownloads,
  getTorrentDetails,
  unrestrictUrl,
  searchRealDebridTorrents,
  buildPersonalHashCache,
  resolveStreamUrl,
  validatePersonalStreams,
  makeReleaseKey,
  searchPersonalFiles
};

function makeReleaseKey(type, imdbId, season = null, episode = null) {
  if (type === 'series' && season != null && episode != null) {
    return `${type}:${imdbId}:S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
  }
  return `${type}:${imdbId}`;
}

async function validatePersonalStreams(apiKey, streams) {
    if (!apiKey || !Array.isArray(streams) || streams.length === 0) {
        return streams;
    }

    // Helper to extract hash from a Stremio stream object
    const getHash = (stream) => {
        if (stream.url && stream.url.includes('btih:')) {
            const match = stream.url.match(/btih:([a-fA-F0-9]{40})/i);
            if (match) return match[1].toLowerCase();
        }
        if (stream.behaviorHints && stream.behaviorHints.bingeGroup) {
            const parts = stream.behaviorHints.bingeGroup.split('|');
            if (parts.length > 1 && parts[1].length === 40) {
                return parts[1].toLowerCase();
            }
        }
        return null;
    };

    const streamsToValidate = streams.filter(s => s.title && s.title.includes('| Personal'));
    if (streamsToValidate.length === 0) {
        return streams;
    }

    console.log(`[RD VALIDATE] Validating ${streamsToValidate.length} personal streams...`);

    try {
        const RD = createRealDebridClient(apiKey);

        // Use cached torrents if available
        let userTorrents;
        const cached = personalFilesCache.get(apiKey);
        if (cached) {
            userTorrents = cached.torrents;
        } else {
            userTorrents = await getAllTorrents(RD, apiKey).catch(() => []);
            const downloads = await getAllDownloads(RD, apiKey).catch(() => []);
            personalFilesCache.set(apiKey, userTorrents, downloads);
        }

        const userHashes = new Set(userTorrents.map(t => t.hash.toLowerCase()));

        let validatedCount = 0;
        const updatedStreams = streams.map(stream => {
            if (stream.title && stream.title.includes('| Personal')) {
                const streamHash = getHash(stream);

                // We can only validate torrents with a hash.
                if (streamHash && !userHashes.has(streamHash)) {
                    validatedCount++;

                    // Re-format the title from "Personal" to "Cached"
                    let newTitle = stream.title.replace('[Cloud]', '').trim();
                    newTitle = newTitle.replace(/☁️/g, '💾');
                    newTitle = newTitle.replace('| Personal', '| Cached');

                    return { ...stream, title: newTitle };
                }
            }
            return stream;
        });

        if (validatedCount > 0) {
            console.log(`[RD VALIDATE] ${validatedCount} streams updated from Personal to Cached.`);
        }

        return updatedStreams;
    } catch (error) {
        console.error(`[RD VALIDATE] Error validating personal streams: ${error.message}`);
        return streams;
    }
}
