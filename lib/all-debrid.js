import AllDebridClient from 'all-debrid-api';
import axios from 'axios';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import AdLimiter from './util/ad-rate-limit.js';
const adCall = (fn) => AdLimiter.schedule(fn);
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { matchesSeriesTitle, hasEpisodeMarker } from './util/seriesTitleMatcher.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import * as sqliteCache from './util/sqlite-cache.js';
import { obfuscateSensitive } from './common/torrent-utils.js';
import searchCoordinator from './util/search-coordinator.js';
import { orchestrateScrapers } from './util/scraper-selector.js';
import * as debridHelpers from './util/debrid-helpers.js';
import debridProxyManager from './util/debrid-proxy.js';
import * as stremThru from './util/stremthru.js';

const { isValidVideo, isValidTorrentTitle, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'AD';

// ---------------------------------------------------------------------------------
// Global state & Cache
// ---------------------------------------------------------------------------------

// Use debrid-helpers functions
const getQualityCategory = debridHelpers.getQualityCategory;
const createAbortController = debridHelpers.createAbortController;
const norm = debridHelpers.norm;
const addHashToSqlite = (hash, fileName = null, size = null, data = null) => debridHelpers.addHashToSqlite(hash, fileName, size, data, 'alldebrid');
const deferSqliteUpserts = debridHelpers.deferSqliteUpserts;
const uniqueUpserts = debridHelpers.uniqueUpserts;

// file cache removed

async function loadHashCache() { return; }

async function saveHashCache() { return; }
function addHashToCache(hash) { return; }
function isHashInCache(hash) { return false; }

function makeReleaseKey(type, imdbId, season = null, episode = null) {
  if (type === 'series' && season != null && episode != null) {
    return `${type}:${imdbId}:S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  }
  return `${type}:${imdbId}`;
}

function createAllDebridClient(apiKey, options = {}) {
  // Get proxy configuration for alldebrid service
  const proxyConfig = debridProxyManager.getAxiosConfig('alldebrid');
  
  // Log if proxy is being used
  const hasProxy = !!(proxyConfig.httpAgent || proxyConfig.httpsAgent);
  if (hasProxy) {
    console.log('[AD] Proxy configured for AllDebrid API calls');
  } else {
    console.log('[AD] No proxy configured for AllDebrid API calls');
  }
  
  try {
    // Create a custom axios instance with proxy configuration if needed
    if (hasProxy) {
      const customAxios = axios.create({
        httpAgent: proxyConfig.httpAgent,
        httpsAgent: proxyConfig.httpsAgent,
        proxy: false, // Disable axios built-in proxy since we're using agent
        timeout: 30000
      });
      
      // Pass the custom axios instance to the AllDebridClient
      return new AllDebridClient(apiKey, { ...options, axios: customAxios });
    } else {
      // No proxy needed, use default configuration
      return new AllDebridClient(apiKey, options);
    }
  } catch (error) {
    // If creating client with axios fails, try without custom axios (fallback)
    console.warn('[AD] Failed to create AllDebrid client with custom axios, trying default:', error.message);
    return new AllDebridClient(apiKey, options);
  }
}

/**
 * Get files and links from magnet IDs using the /v4/magnet/files API
 * @param {AllDebridClient} AD - The All-Debrid client
 * @param {string|string[]} magnetIds - Single magnet ID or array of magnet IDs
 * @returns {Promise<Object>} Response with magnets array containing file trees
 */
async function getMagnetFiles(AD, magnetIds) {
  const ids = Array.isArray(magnetIds) ? magnetIds : [magnetIds];

  try {
    // The AD client should already be configured with proxy settings if needed
    const response = await adCall(() => AD._post('magnet/files', {
      form: { id: ids }
    }));
    return response;
  } catch (error) {
    console.error(`[AD FILES] Error fetching files for magnets: ${error?.message || error}`);
    // Log a more specific error if it looks like a proxy/unauthorized error
    if (error?.message && (error.message.includes('VPN') || error.message.includes('server') || error.message.includes('not allowed'))) {
      console.error('[AD FILES] This error suggests the proxy is not working properly.');
      console.error('[AD FILES] Verify that your SOCKS5 proxy is working and accessible.');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------
async function buildPersonalHashCache(apiKey) {
  try {
    // AllDebrid API does not provide a full list of magnet tasks; fall back to empty
    console.log(`[AD CACHE] Personal magnet list is not exposed; returning empty cache.`);
    return new Set();
  } catch (error) {
    console.error(`[AD CACHE] Error building personal cache: ${error.message}`);
    return new Set();
  }
}

async function cleanupTemporaryMagnets(AD, magnetIds) {
  if (magnetIds.size === 0) return;
  console.log(`[AD CLEANUP] 🧹 Starting background deletion of ${magnetIds.size} temporary magnets.`);
  for (const id of magnetIds) {
    try {
      await adCall(() => AD.magnet.delete(id));
    } catch (deleteError) {
      const errorMessage = deleteError?.message || deleteError;
      // Only log as error if it's not a "does not exist" error
      if (!errorMessage.toLowerCase().includes('does not exist') && !errorMessage.toLowerCase().includes('invalid')) {
        console.error(`[AD CLEANUP] ❌ Error deleting magnet ${id}: ${errorMessage}`);
      } else {
        // Log as debug/info level for "does not exist" errors
        console.log(`[AD CLEANUP] ℹ️  Magnet ${id} does not exist or is invalid (likely already processed)`);
      }
      await delay(1500).catch(() => {});
    }
  }
  console.log(`[AD CLEANUP] ✅ Finished background deletion task.`);
}

// ---------------------------------------------------------------------------------
// AD response helpers (normalize varying shapes)
// ---------------------------------------------------------------------------------
function extractADMagnet(resp) {
  const d = resp?.data || resp;
  // data.magnets may be an array or an object
  const m = d?.magnets;
  if (Array.isArray(m)) return m[0] || null;
  if (m && typeof m === 'object') return m;
  if (d?.magnet && typeof d.magnet === 'object') return d.magnet;
  // Sometimes the magnet object is returned directly as data
  if (d && typeof d === 'object') return d;
  return null;
}

/**
 * Extract files from All-Debrid response (handles both old and new API formats)
 * New format from magnet/files API: { n: name, s: size, l: link, e: [nested entries] }
 * Old format: { filename/name, size/filesize, link/download/url }
 * @param {Object} mag - Magnet object or response data
 * @returns {Array} Array of {path, bytes, index, link} objects
 */
function extractADFiles(mag) {
  const out = [];
  let fileIndex = 0;

  // Recursive function to traverse nested folder structure
  function traverseFiles(entries, parentPath = '') {
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      if (!entry) continue;

      // New API format: { n: name, s: size, l: link, e: [subentries] }
      if (entry.n) {
        const currentPath = parentPath ? `${parentPath}/${entry.n}` : entry.n;

        // If entry has 'e' (subentries), it's a folder - recurse into it
        if (entry.e && Array.isArray(entry.e)) {
          traverseFiles(entry.e, currentPath);
        }
        // If entry has 'l' (link), it's a file
        else if (entry.l) {
          out.push({
            path: currentPath,
            bytes: entry.s || 0,
            index: fileIndex++,
            link: entry.l
          });
        }
      }
      // Old API formats
      else if (typeof entry === 'string') {
        out.push({
          path: `file_${fileIndex}`,
          bytes: 0,
          index: fileIndex++,
          link: entry
        });
      }
      else if (typeof entry === 'object') {
        out.push({
          path: entry.filename || entry.name || entry.link || `file_${fileIndex}`,
          bytes: entry.size || entry.filesize || 0,
          index: fileIndex++,
          link: entry.link || entry.download || entry.url || null
        });
      }
    }
  }

  // Try new API format first (magnet/files response)
  if (mag?.files && Array.isArray(mag.files)) {
    traverseFiles(mag.files);
  }
  // Try old API formats
  else {
    const raw = (mag?.links || mag?.files || []) || [];
    traverseFiles(raw);
  }

  return out;
}

// ---------------------------------------------------------------------------------
// Formatting & combining results
// ---------------------------------------------------------------------------------
function formatCachedResult(torrent, isCached) {
  const episodeHint = torrent.episodeFileHint || null;
  const definitiveTitle = episodeHint?.filePath || torrent.Title || torrent.name || 'Unknown Title';
  const definitiveSize = (episodeHint && typeof episodeHint.fileBytes === 'number' && episodeHint.fileBytes > 0)
    ? episodeHint.fileBytes
    : (torrent.Size || torrent.size || torrent.filesize || 0);

  let url;
  if (torrent.isPersonal) {
    // Personal cloud files are direct links, not torrents
    url = torrent.url || torrent.link || null;
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
    source: 'alldebrid',
    hash: (torrent.InfoHash || torrent.hash || '').toLowerCase(),
    tracker: torrent.Tracker || (torrent.isPersonal ? 'Personal' : 'Cached'),
    isPersonal: torrent.isPersonal || false,
    isCached,
    languages: Array.isArray(torrent.Langs) ? torrent.Langs : [],
    ...(episodeHint?.filePath ? { searchableName: searchableTitle } : {}),
    ...(episodeHint ? { episodeHint } : {}),
    ...(torrent.id && { id: torrent.id }),
    ...(torrent.magnetId && { magnetId: torrent.magnetId }),
    ...(torrent.fileIndex != null && { fileIndex: torrent.fileIndex })
  };
}

function combineAndMarkResults(apiKey, personalFiles, externalSources, specificSearchKey) {
  const markedPersonal = personalFiles.map(file => ({ ...file, isPersonal: true, tracker: 'Personal' }));
  const externalTorrents = [].concat(...externalSources).map(t => ({ ...t, isPersonal: false }));
  const uniqueExternalTorrents = [...new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t])).values()];
  const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
  const newExternalTorrents = uniqueExternalTorrents.filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

  const saneResults = newExternalTorrents;
  const validTitleResults = saneResults.filter(t => isValidTorrentTitle(t.Title, LOG_PREFIX));
  return [...markedPersonal, ...validTitleResults];
}

async function inspectAndFilterNonCached(torrents, adHandler) {
  console.log(`[${LOG_PREFIX}] Inspecting ${torrents.length} top non-cached torrents for validity...`);
  const validTorrents = [];
  for (const torrent of torrents) {
    const isValid = await adHandler.liveCheckHash(torrent.InfoHash);
    if (isValid) {
      console.log(`[${LOG_PREFIX}] -> VALID: ${torrent.Title}`);
      validTorrents.push(torrent);
    } else {
      console.log(`[${LOG_PREFIX}] -> REJECTED: ${torrent.Title}`);
    }
  }
  return validTorrents;
}

// ---------------------------------------------------------------------------------
// Main search functions
// ---------------------------------------------------------------------------------

async function searchAllDebridTorrents(apiKey, type, id, userConfig = {}) {
  if (!id || typeof id !== 'string') {
    return [];
  }

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

  const magnetIdsToDelete = new Set();

  try {
    // Phase 0: Fetch personal files first (AllDebrid exposes recent links) - these are the user's personal cloud results
    let personalFiles = await searchPersonalFiles(apiKey, searchKey, 0.3);

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

    // Ensure personal files have category/resolution
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
      'alldebrid',
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
    let combinedResults = combineAndMarkResults(apiKey, personalFiles, scraperResults, specificSearchKey);
    let externalTorrents = combinedResults.filter(t => !t.isPersonal);

    if (episodeInfo) {
      externalTorrents = externalTorrents.filter(t => isLikelyEpisode(t));
      const s = episodeInfo.season, e = episodeInfo.episode;
      externalTorrents = externalTorrents.filter(t => {
        try {
          const p = PTT.parse(t.Title || t.name || '');
          if (p && p.season != null && p.episode != null) return Number(p.season) === Number(s) && Number(p.episode) === Number(e);
          if (p && p.season != null && (p.episode === undefined || Array.isArray(p.episode))) return Number(p.season) === Number(s);
        } catch {}
        return true;
      });
    }

    if (type === 'movie') {
      externalTorrents = externalTorrents.filter(t => {
        try {
          const title = t.Title || t.name || '';
          if (torrentUtils.isSeriesLikeTitle(title)) return false;
          const parsed = PTT.parse(title) || {};
          if (parsed.season != null || parsed.seasons) return false;
        } catch {}
        return true;
      });
      if (cinemetaDetails.year) {
        externalTorrents = externalTorrents.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
      }
      // Apply title matching to filter out unrelated movies
      if (cinemetaDetails.name) {
        const beforeTitleFilter = externalTorrents.length;
        const normalizeTitle = (s) => String(s || '').toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
        const expectedTitle = normalizeTitle(cinemetaDetails.name);
        externalTorrents = externalTorrents.filter(torrent => {
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
        if (beforeTitleFilter !== externalTorrents.length) {
          console.log(`[${LOG_PREFIX}] Filtered by title matching "${cinemetaDetails.name}". Removed ${beforeTitleFilter - externalTorrents.length} unrelated results.`);
        }
      }
    }

    await loadHashCache();
    
    // Phase 2: Check for cached results from StremThru (the common debrid cache system) - this is the fast cache for other users' results
    const releaseKey = makeReleaseKey(type, imdbId, episodeInfo?.season, episodeInfo?.episode);
    const allExternalHashes = [...new Set(externalTorrents.map(t => (t.InfoHash || t.hash || '').toLowerCase()).filter(Boolean))];
    
    let stremthruCachedHashes = new Set();
    if (stremThru.isEnabled() && apiKey) {
      try {
        console.log(`[${LOG_PREFIX}] Querying StremThru for ${allExternalHashes.length} hashes (AD)`);
        stremthruCachedHashes = await stremThru.checkInstantAvailability(allExternalHashes, 'alldebrid', apiKey);
        console.log(`[${LOG_PREFIX}] StremThru returned ${stremthruCachedHashes.size} cached hashes`);
      } catch (error) {
        console.error(`[${LOG_PREFIX}] Error querying StremThru:`, error.message);
      }
    }
    
    // Phase 3: Get results from personal SQLite cache as well (user's personal cloud results)
    let sqliteCachedHashes = new Set();
    if (sqliteCache?.isEnabled()) {
        try {
          const results = await sqliteCache.getCachedHashes('alldebrid', allExternalHashes);
          for (const hash of results) {
              sqliteCachedHashes.add(hash.toLowerCase());
          }
          console.log(`[${LOG_PREFIX}] SQLite returned ${sqliteCachedHashes.size} cached hashes`);
        } catch (error) {
          console.error(`[${LOG_PREFIX}] Error getting SQLite cached hashes:`, error.message);
        }
    }
    
    // Phase 4: Combine all cached results (StremThru = others' cached, SQLite = user's personal) and return immediately
    const combinedCachedHashes = new Set([...stremthruCachedHashes, ...sqliteCachedHashes]);
    
    const cachedExternalTorrents = externalTorrents.filter(t => combinedCachedHashes.has((t.InfoHash || t.hash || '').toLowerCase()));
    const uncachedExternalTorrents = externalTorrents.filter(t => !combinedCachedHashes.has((t.InfoHash || t.hash || '').toLowerCase()));
    
    console.log(`[${LOG_PREFIX}] Returning ${cachedExternalTorrents.length} cached results immediately, ${uncachedExternalTorrents.length} will be checked in background`);
    
    // Format and return cached results immediately (both StremThru cached and SQLite cached)
    const cachedResults = cachedExternalTorrents.map(torrent => formatCachedResult(torrent, true));
    const personalResults = enrichedPersonalFiles.map(file => formatCachedResult(file, true));
    
    const combined = [...personalResults, ...cachedResults];
    let allResults = combined;
    
    if (episodeInfo) {
        allResults = allResults.filter(item => {
            // Allow personal files and items from pack inspection
            if (item.isPersonal || item.episodeHint) {
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
      const AD = createAllDebridClient(apiKey);
      const adHandler = {
        getIdentifier: () => LOG_PREFIX,
        checkCachedHashes: async (hashes) => {
          let cached = new Set();
          // First check SQLite cache for existing results
          if (sqliteCache?.isEnabled()) {
              try {
                  const sqliteHashes = await sqliteCache.getCachedHashes('alldebrid', hashes);
                  for (const hash of sqliteHashes) {
                    cached.add(hash.toLowerCase());
                  }
              } catch (error) {
                  console.error(`[AD CACHE-CHECK] Error getting cached hashes: ${error.message}`);
              }
          }
          
          // Additionally check StremThru for any hashes not yet in SQLite
          if (stremThru?.isEnabled() && apiKey && cached.size < hashes.length) {
            try {
              const hashesToCheck = hashes.filter(hash => !cached.has(hash.toLowerCase()));
              if (hashesToCheck.length > 0) {
                const stremthruResults = await stremThru.checkInstantAvailability(hashesToCheck, 'alldebrid', apiKey);
                for (const hash of stremthruResults) {
                  cached.add(hash.toLowerCase());
                }
              }
            } catch (stremError) {
              console.error(`[AD CACHE-CHECK] Error checking StremThru during background:`, stremError.message);
            }
          }
          
          return cached;
        },
        liveCheckHash: async (hash) => {
          // Try to check cache status by uploading magnet and seeing if it's cached
          // AllDebrid does not have a batch check but we can check individually
          try {
            const magnet = `magnet:?xt=urn:btih:${hash}`;
            // Upload the magnet to check if it's cached
            const response = await adCall(() => AD.magnet.upload(magnet));
            const uploadMagnet = response?.data?.magnets?.[0];
            const magnetId = uploadMagnet?.id;
            
            if (magnetId) {
              console.log(`[AD CACHE-CHECK] Uploaded magnet ${magnetId} for ${hash.substring(0,16)}..., upload ready: ${uploadMagnet.ready || false}`);
              
              // If uploadMagnet.ready is true, it means it was already cached
              // Use magnet/files API to get the file list which indicates cache status
              const filesResponse = await getMagnetFiles(AD, magnetId);
              const magnetInfo = filesResponse?.data?.magnets?.[0];
              
              if (!magnetInfo) {
                console.log(`[AD CACHE-CHECK] No magnet info returned for ${magnetId}`);
                // Add to cleanup queue since it wasn't cached
                magnetIdsToDelete.add(magnetId);
                return false;
              }
              
              // In AllDebrid, if files exist in the response, it means the content is cached
              console.log(`[AD CACHE-CHECK] Magnet ${magnetId} has ${magnetInfo.files?.length || 0} files, checking for video content...`);
              
              // Check if it has valid video files (cached torrents will have files immediately available)
              const files = extractADFiles(magnetInfo);
              const hasVideo = files.some(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
              const hasValidSize = files.some(f => f.bytes > 50 * 1024 * 1024); // 50MB minimum
              
              console.log(`[AD CACHE-CHECK] hasVideo=${hasVideo}, hasValidSize=${hasValidSize} for ${hash.substring(0,16)}...`);
              
              if (hasVideo && hasValidSize) {
                // Persist to SQLite cache
                try {
                  const largestVideo = files
                    .filter(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX))
                    .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
                  await addHashToSqlite(hash, largestVideo?.path || null, largestVideo?.bytes || null, { status: 'cached', magnetId: magnetId });
                } catch {}
                console.log(`[AD CACHE-CHECK] ✅ CACHE HIT: ${hash.substring(0,16)}... has valid video and size`);
                // Add to cleanup queue even if cached, as we've used it for verification
                magnetIdsToDelete.add(magnetId);
                return true;
              } else {
                console.log(`[AD CACHE-CHECK] ❌ CACHE MISS: ${hash.substring(0,16)}... hasVideo=${hasVideo}, hasValidSize=${hasValidSize}`);
              }
              
              // Add to cleanup queue since it wasn't cached
              magnetIdsToDelete.add(magnetId);
            } else {
              console.log(`[AD CACHE-CHECK] Failed to upload magnet for ${hash.substring(0,16)}...`);
            }
          } catch (error) {
            const errorMessage = error?.message || error;
            console.log(`[AD CACHE-CHECK] Live check for ${hash.substring(0,16)}... failed: ${errorMessage}`);
            // Check if this is the VPN/proxy error from AllDebrid
            if (errorMessage.includes('VPN') || errorMessage.includes('server') || errorMessage.includes('not allowed')) {
              console.error('[AD CACHE-CHECK] Proxy is not working properly - AllDebrid detected server location');
            }
          }
          return false;
        },
        batchCheckSeasonPacks: async (hashes, season, episode) => {
          // Enable pack inspection for AllDebrid using available APIs
          const MAX_PACKS_TO_INSPECT = config.MAX_PACKS_TO_INSPECT || 3;
          const packResults = new Map();
          let inspectedCount = 0;

          console.log(`[AD PACK INSPECT] Starting pack inspection for S${season}E${episode}, checking up to ${MAX_PACKS_TO_INSPECT} packs`);

          for (const hash of hashes) {
              if (inspectedCount >= MAX_PACKS_TO_INSPECT) break;
              try {
                  const magnet = `magnet:?xt=urn:btih:${hash}`;
                  console.log(`[AD PACK INSPECT] Inspecting pack ${hash.substring(0,16)}...`);
                  
                  // Upload the magnet to inspect its files
                  const response = await adCall(() => AD.magnet.upload(magnet));
                  const uploadMagnet = response?.data?.magnets?.[0];
                  const magnetId = uploadMagnet?.id;
                  
                  if (!magnetId) {
                    console.log(`[AD PACK INSPECT] Upload failed for ${hash.substring(0,16)}...`);
                    continue;
                  }
                  
                  // Use magnet/files API to get file list
                  const filesResponse = await getMagnetFiles(AD, magnetId);
                  const packInfo = filesResponse?.data?.magnets?.[0];
                  
                  if (!packInfo) {
                    console.log(`[AD PACK INSPECT] No pack info returned for ${magnetId}`);
                    // Add to cleanup queue
                    magnetIdsToDelete.add(magnetId);
                    continue;
                  }

                  console.log(`[AD PACK INSPECT] Pack ${magnetId} has ${packInfo.files?.length || 0} files`);

                  // Get files from the pack
                  const files = extractADFiles(packInfo);
                  
                  // Filter for episode files matching the requested season and episode
                  const matchingFiles = files.filter(file => {
                      const parsed = PTT.parse(file.path) || {};
                      return parsed.season === season && parsed.episode === episode;
                  });

                  if (matchingFiles.length > 0) {
                      console.log(`[AD PACK INSPECT] ✅ Found ${matchingFiles.length} matching files for S${season}E${episode} in pack ${hash.substring(0,16)}...`);
                      // Find the best file (largest valid video)
                      matchingFiles.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
                      const bestFile = matchingFiles[0];
                      
                      // Create episode result with all necessary data for the stream
                      const episodeResult = {
                          InfoHash: hash,
                          Title: bestFile.path,
                          name: bestFile.path,
                          Size: bestFile.bytes,
                          size: bestFile.bytes,
                          Seeders: 0, // Season packs typically don't have seeders info
                          Tracker: 'Pack Inspection',
                          episodeFileHint: {
                              filePath: bestFile.path,
                              fileBytes: bestFile.bytes,
                              magnetId: magnetId,
                              fileIndex: bestFile.index
                          },
                          isCached: true,
                          isFromPack: true,
                          packHash: hash,
                          searchableName: packInfo.filename || packInfo.name
                      };
                      
                      packResults.set(hash, [episodeResult]);
                      inspectedCount++;
                      
                      // We'll clean up this magnet later in the cleanup function
                      magnetIdsToDelete.add(magnetId);
                  } else {
                    console.log(`[AD PACK INSPECT] ❌ No matching files for S${season}E${episode} in pack ${hash.substring(0,16)}...`);
                    // Add to cleanup queue if no match found
                    magnetIdsToDelete.add(magnetId);
                  }
              } catch (error) {
                  const errorMessage = error?.message || error;
                  console.error(`[AD PACK INSPECT] Error inspecting pack ${hash.substring(0,8)}: ${errorMessage}`);
                  // Check if this is the VPN/proxy error from AllDebrid
                  if (errorMessage.includes('VPN') || errorMessage.includes('server') || errorMessage.includes('not allowed')) {
                      console.error('[AD PACK INSPECT] Proxy is not working properly - AllDebrid detected server location');
                  }
              }
          }
          console.log(`[AD PACK INSPECT] Completed, found ${packResults.size} packs with matching episodes`);
          return packResults;
        },
        cleanup: async () => {
          await saveHashCache(); // no-op; file cache removed
          if (magnetIdsToDelete.size > 0) cleanupTemporaryMagnets(AD, Array.from(magnetIdsToDelete));
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
          const backgroundCachedResults = await processAndFilterTorrents(uncachedExternalTorrents, adHandler, episodeInfo, { byCategory: {}, byCategoryResolution: {} }, false);
          const backgroundNonCachedTorrents = uncachedExternalTorrents.filter(t => !backgroundCachedResults.some(c => c.InfoHash === t.InfoHash));

          // Check if we already have sufficient high-quality results before inspecting non-cached
          const hasEnoughHQResults = () => {
            const HQ_CATEGORIES = ['Remux', 'BluRay', 'WEB/WEB-DL'];
            const qualityLimits = {
              'Remux': (parseInt(process.env.MAX_RESULTS_REMUX, 10) || 2) * 2,
              'BluRay': (parseInt(process.env.MAX_RESULTS_BLURAY, 10) || 2) * 2,
              'WEB/WEB-DL': (parseInt(process.env.MAX_RESULTS_WEBDL, 10) || 2) * 2
            };

            return HQ_CATEGORIES.some(category => {
              const limit = qualityLimits[category];
              const results1080p = [...personalResults, ...backgroundCachedResults].filter(r =>
                r.category === category && r.resolution === '1080p'
              ).length;
              const results2160p = [...personalResults, ...backgroundCachedResults].filter(r =>
                r.category === category && r.resolution === '2160p'
              ).length;
              return results1080p >= limit || results2160p >= limit;
            });
          };

          if (backgroundNonCachedTorrents.length > 0 && !hasEnoughHQResults()) {
            const topNonCached = backgroundNonCachedTorrents.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0)).slice(0, 10); // Increased from 5 to 10
            const verifiedNonCached = await inspectAndFilterNonCached(topNonCached, adHandler);
            backgroundCachedResults.push(...verifiedNonCached.map(t => ({ ...t, isCached: false })));
          } else if (backgroundNonCachedTorrents.length > 0 && hasEnoughHQResults()) {
            console.log(`[${LOG_PREFIX}] ✅ Already have sufficient HQ results - skipping non-cached torrent inspection (background)`);
          }

          // Update SQLite cache with background results (both API checked and those that were found in background)
          if (backgroundCachedResults.length > 0) {
            try {
              if (sqliteCache?.isEnabled()) {
                const upserts = [];
                for (const t of backgroundCachedResults) {
                  const hash = (t.InfoHash || t.hash || '').toLowerCase();
                  if (!hash) continue;
                  upserts.push({
                    service: 'alldebrid',
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
            if (adHandler && typeof adHandler.cleanup === 'function') {
              await adHandler.cleanup();
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
    cleanupTemporaryMagnets(createAllDebridClient(apiKey), magnetIdsToDelete);
  }
}

async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
  // NOTE: AllDebrid does not expose a list of active magnets; this helper focuses on link history
  const results = await searchDownloads(apiKey, searchKey, threshold);
  return results.map(r => ({ ...r, isCached: true }));
}

// ---------------------------------------------------------------------------------
// Other functions
// ---------------------------------------------------------------------------------

async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
  const AD = createAllDebridClient(apiKey);
  try {
    const existingDownloads = await getAllDownloads(AD).catch(() => []);
    const relevantDownloads = filterFilesByKeywords(existingDownloads, searchKey);
    const allFiles = [...relevantDownloads.map(d => formatDownloadFile(d))];
    if (allFiles.length === 0) return [];
    const uniqueFiles = [...new Map(allFiles.map(file => [file.url, file])).values()];
    const enhanced = uniqueFiles.map(file => ({ ...file, isPersonal: true, info: PTT.parse(file.name) }));
    const fuse = new Fuse(enhanced, { keys: ['info.title', 'name'], threshold, minMatchCharLength: 2 });
    return fuse.search(searchKey).map(r => r.item);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Personal files error: ${error.message}`);
    return [];
  }
}

async function resolveStreamUrl(apiKey, encodedUrl, clientIp) {
  console.log(`[${LOG_PREFIX} RESOLVER] Starting resolution for encoded URL: ${encodedUrl.substring(0, 100)}...`);
  try {
    let decodedUrl = decodeURIComponent(encodedUrl).trim();
    if (decodedUrl.includes('magnet:')) {
      const result = await resolveMagnetUrl(apiKey, decodedUrl, clientIp);
      if (!result) return null;
      if (result.startsWith('http')) return result;
      if (result.startsWith('alldebrid:')) return await unrestrictUrl(apiKey, result, clientIp);
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
  const AD = createAllDebridClient(apiKey, { ip: clientIp });
  try {
    const hashMatch = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!hashMatch?.[1]) return null;
    const hash = hashMatch[1].toLowerCase();
    // file cache removed; always resolve via API
    const up = await adCall(() => AD.magnet.upload(magnetUrl));
    const created = extractADMagnet(up) || {};
    const magnetId = created.id;
    if (!magnetId) return null;

    // Use magnet/files API to get file list
    const filesResp = await getMagnetFiles(AD, magnetId);
    const magnetData = filesResp?.data?.magnets?.[0];
    if (!magnetData) return null;

    const files = extractADFiles(magnetData);
    if (files.length === 0) return null;
    let selected = files.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (!selected) { files.sort((a, b) => b.bytes - a.bytes); selected = files[0]; }
    // file cache removed; rely on Mongo upsert only
    try { await addHashToSqlite(hash, selected?.path || null, selected?.bytes || null, { magnetId }); } catch {}
    return `alldebrid:${magnetId}:${selected.index}`;
  } catch {
    return null;
  }
}

async function resolveMagnetUrl(apiKey, magnetUrl, clientIp) {
    const AD = createAllDebridClient(apiKey, { ip: clientIp });
    console.log(`[${LOG_PREFIX} RESOLVER] Resolving magnet URL: ${magnetUrl.substring(0, 100)}...`);
    try {
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

        let magnetId;
        let magnetData = null;

        if (hintPayload?.magnetId) {
            magnetId = hintPayload.magnetId;
            console.log(`[${LOG_PREFIX} RESOLVER] Using magnetId from hint: ${magnetId}`);
            try {
                const filesResp = await getMagnetFiles(AD, magnetId);
                magnetData = filesResp?.data?.magnets?.[0];
            } catch (e) {
                console.warn(`[${LOG_PREFIX} RESOLVER] Failed to get files for magnetId ${magnetId} from hint. It might have been deleted. Falling back to re-upload. Error: ${e.message}`);
                magnetData = null;
                magnetId = null;
            }
        }

        if (!magnetData) {
            console.log(`[${LOG_PREFIX} RESOLVER] No valid magnet data from hint, uploading magnet...`);
            try {
                const up = await adCall(() => AD.magnet.upload(magnetUrl));
                const created = extractADMagnet(up) || {};
                magnetId = created.id;
                if (!magnetId) {
                    console.error(`[${LOG_PREFIX} RESOLVER] Failed to upload magnet, no ID returned for hash ${hash}`);
                    return null;
                }
                // Use magnet/files API to get file list
                const filesResp = await getMagnetFiles(AD, magnetId);
                magnetData = filesResp?.data?.magnets?.[0];
            } catch (uploadError) {
                const errorMsg = uploadError?.message || uploadError;
                if (errorMsg && (errorMsg.includes('apikey is invalid') || errorMsg.includes('auth') || errorMsg.includes('permission'))) {
                    console.error(`[${LOG_PREFIX} RESOLVER] ❌ Authentication failed: ${errorMsg}`);
                    console.error(`[${LOG_PREFIX} RESOLVER] Please verify your All-Debrid API key is valid and has not expired.`);
                }
                throw uploadError;
            }
        }

        if (!magnetData) {
            console.error(`[${LOG_PREFIX} RESOLVER] No magnet data returned for magnet ${magnetId}`);
            return null;
        }

        const files = extractADFiles(magnetData);
        if (files.length === 0) {
            console.error(`[${LOG_PREFIX} RESOLVER] No files found in magnet ${magnetId}`);
            return null;
        }

        let selected = null;
        if (hintPayload?.fileIndex != null) {
            selected = files.find(f => f.index === hintPayload.fileIndex);
            if (selected) {
                console.log(`[${LOG_PREFIX} RESOLVER] Selected file by hint index ${hintPayload.fileIndex}: "${selected.path}"`);
            } else {
                 console.error(`[${LOG_PREFIX} RESOLVER] Hint file index ${hintPayload.fileIndex} not found in magnet files.`);
                 if (hintPayload?.filePath) {
                    selected = files.find(f => f.path === hintPayload.filePath);
                    if (selected) console.log(`[${LOG_PREFIX} RESOLVER] Selected file by hint path as fallback: "${selected.path}"`);
                 }
            }
        } else if (hintPayload?.filePath) {
            selected = files.find(f => f.path === hintPayload.filePath);
            if (selected) {
                console.log(`[${LOG_PREFIX} RESOLVER] Selected file by hint path: "${selected.path}"`);
            }
        }

        if (!selected) {
            console.log(`[${LOG_PREFIX} RESOLVER] No hint match or hint invalid. Falling back to largest video file.`);
            selected = files
                .filter(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX))
                .sort((a,b) => b.bytes - a.bytes)[0];
            
            if (!selected) {
                 console.log(`[${LOG_PREFIX} RESOLVER] No valid video file found, falling back to largest file overall.`);
                 files.sort((a, b) => b.bytes - a.bytes);
                 selected = files[0];
            }
            if (selected) {
                console.log(`[${LOG_PREFIX} RESOLVER] Fallback selected file: "${selected.path}"`);
            }
        }

        if (!selected) {
            console.error(`[${LOG_PREFIX} RESOLVER] Could not select a file from magnet ${magnetId}`);
            return null;
        }

        try { await addHashToSqlite(hash, selected?.path || null, selected?.bytes || null, { magnetId }); } catch {}

        const finalRef = `alldebrid:${magnetId}:${selected.index}`;
        console.log(`[${LOG_PREFIX} RESOLVER] Successfully created file reference: ${finalRef}`);
        return finalRef;
    } catch (error) {
      console.error(`[${LOG_PREFIX} RESOLVER] Exception in resolveMagnetUrl: ${error?.message || error}`);
      return null;
    }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
  const AD = createAllDebridClient(apiKey, { ip: clientIp });
  console.log(`[${LOG_PREFIX} RESOLVER] Unrestricting URL: ${hostUrl.substring(0, 100)}...`);
  try {
    if (!hostUrl || hostUrl.includes('undefined')) {
        console.error(`[${LOG_PREFIX} RESOLVER] Invalid hostUrl provided.`);
        return null;
    }
    if (hostUrl.startsWith('alldebrid:')) {
      const parts = hostUrl.split(':');
      const magnetId = parts[1];
      const fileIndex = parseInt(parts[2], 10);
      if (!magnetId || isNaN(fileIndex)) {
          console.error(`[${LOG_PREFIX} RESOLVER] Invalid alldebrid reference: ${hostUrl}`);
          return null;
      }
      console.log(`[${LOG_PREFIX} RESOLVER] alldebrid reference found. MagnetId: ${magnetId}, FileIndex: ${fileIndex}`);

      // Use magnet/files API to get file list
      const filesResp = await getMagnetFiles(AD, magnetId);
      const magnetData = filesResp?.data?.magnets?.[0];
      if (!magnetData) {
          console.error(`[${LOG_PREFIX} RESOLVER] No magnet data returned for magnet ${magnetId}`);
          return null;
      }

      const files = extractADFiles(magnetData);
      const f = files.find(file => file.index === fileIndex);
      if (!f) {
          console.error(`[${LOG_PREFIX} RESOLVER] File with index ${fileIndex} not found in magnet ${magnetId}`);
          return null;
      }
      const link = f.link;
      if (!link) {
          console.error(`[${LOG_PREFIX} RESOLVER] No link found for file index ${fileIndex} in magnet ${magnetId}`);
          return null;
      }
      console.log(`[${LOG_PREFIX} RESOLVER] Unlocking link for file: ${f.path}`);
      const response = await adCall(() => AD.link.unlock(link));
      const finalLink = response?.data?.link || response?.data?.download || link;
      console.log(`[${LOG_PREFIX} RESOLVER] Unlocked link: ${finalLink}`);
      return finalLink;
    } else if (hostUrl.includes('magnet:')) {
      console.log(`[${LOG_PREFIX} RESOLVER] Magnet URL found, re-processing with resolveMagnetUrl.`);
      const fileReference = await resolveMagnetUrl(apiKey, hostUrl, clientIp);
      if (!fileReference) {
        console.error(`[${LOG_PREFIX} RESOLVER] Failed to resolve magnet URL. This may be due to an authentication issue.`);
        return null;
      }
      if (fileReference.startsWith('http')) return fileReference;
      return await unrestrictUrl(apiKey, fileReference, clientIp);
    } else {
      console.log(`[${LOG_PREFIX} RESOLVER] Unlocking direct link: ${hostUrl}`);
      const response = await adCall(() => AD.link.unlock(hostUrl));
      const finalLink = response?.data?.link || response?.data?.download || null;
      console.log(`[${LOG_PREFIX} RESOLVER] Unlocked direct link: ${finalLink}`);
      return finalLink;
    }
  } catch (error) {
    console.error(`[${LOG_PREFIX} RESOLVER] Exception in unrestrictUrl: ${error?.message || error}`);
    return null;
  }
}

async function getAllDownloads(AD) {
  try {
    const response = await adCall(() => AD.user.recentLinks());
    // Normalize a few possible shapes
    const list = response?.data?.links || response?.data?.history || response?.data || [];
    return list;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error fetching downloads: ${error.message}`);
    return [];
  }
}

function formatDownloadFile(download) {
  const filename = download.filename || download.name || download.link || download.url || 'Unknown';
  const size = download.size || download.filesize || 0;
  const url = download.link || download.download || download.url || null;
  return {
    id: download.id || null,
    name: filename,
    info: PTT.parse(filename),
    size,
    url,
    isPersonal: true,
    isCached: true,
    tracker: 'Personal',
    category: getQualityCategory(filename),
    resolution: torrentUtils.getResolutionFromName(filename)
  };
}

function filterFilesByKeywords(files, searchKey) {
  const keywords = (searchKey || '').toLowerCase().split(' ').filter(w => w.length > 2);
  return files.filter(file => {
    const fileName = (file.filename || file.name || '').toLowerCase();
    return keywords.some(k => fileName.includes(k));
  });
}

async function listTorrents(apiKey, skip = 0) {
  const AD = createAllDebridClient(apiKey);
  try {
    const downloads = await getAllDownloads(AD);
    return downloads.map(download => formatDownloadFile(download));
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error listing torrents: ${error.message}`);
    return [];
  }
}

async function getTorrentDetails(apiKey, id) {
  const AD = createAllDebridClient(apiKey);
  const magnetId = id.includes(':') ? id.split(':')[0] : id;
  try {
    // Use magnet/files API to get file list
    const filesResp = await getMagnetFiles(AD, magnetId);
    const magnetData = filesResp?.data?.magnets?.[0];
    if (!magnetData) {
      throw new Error('No magnet data returned');
    }
    return toTorrentDetails(apiKey, magnetData);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Torrent details error: ${error.message}`);
    return {
      source: 'alldebrid',
      id: magnetId,
      name: 'Unknown Magnet',
      type: 'other',
      hash: null,
      info: { title: 'Unknown' },
      size: 0,
      created: new Date(),
      videos: []
    };
  }
}

async function toTorrentDetails(apiKey, mag) {
  if (!mag) {
    return {
      source: 'alldebrid',
      id: 'unknown',
      name: 'Unknown Magnet',
      type: 'other',
      hash: mag?.hash || null,
      info: PTT.parse(mag?.filename || '') || { title: 'Unknown' },
      size: mag?.size || 0,
      created: new Date(),
      videos: []
    };
  }
  const files = extractADFiles(mag).map((f) => ({
    id: `${mag.id}:${f.index}`,
    name: f.path || `file_${f.index}`,
    url: f.link || null,
    size: f.bytes || 0,
    created: new Date(mag.added || Date.now()),
    info: PTT.parse(f.path || '')
  }));
  const videos = files.filter(file => file.url && isValidVideo(file.name, file.size, 50 * 1024 * 1024, LOG_PREFIX));
  return {
    source: 'alldebrid',
    id: mag.id,
    name: mag.filename || mag.name || 'Magnet',
    type: 'other',
    hash: mag.hash,
    info: PTT.parse(mag.filename || ''),
    size: mag.size,
    created: new Date(mag.added || Date.now()),
    videos
  };
}

async function searchDownloads(apiKey, searchKey = null, threshold = 0.3) {
  if (!searchKey) return [];
  try {
    const AD = createAllDebridClient(apiKey);
    const downloads = await getAllDownloads(AD);
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
  const AD = createAllDebridClient(apiKey);
  const magnetIdsToDelete = new Set();
  const adHandler = {
    getIdentifier: () => LOG_PREFIX,
    checkCachedHashes: async (hashes) => {
      let cached = new Set();
      // First check SQLite cache for existing results
      if (sqliteCache?.isEnabled()) {
          try {
              const sqliteHashes = await sqliteCache.getCachedHashes('alldebrid', hashes);
              for (const hash of sqliteHashes) {
                cached.add(hash.toLowerCase());
              }
              if (sqliteHashes.length > 0) {
                  console.log(`[AD CACHE-CHECK] SQLite returned ${sqliteHashes.length}/${hashes.length} cached hashes`);
              }
          } catch (error) {
              console.error(`[AD SQLITE] Error getting cached hashes: ${error.message}`);
          }
      }
      
      // Additionally check StremThru for any hashes not yet in SQLite
      if (stremThru?.isEnabled() && apiKey && cached.size < hashes.length) {
        try {
          const hashesToCheck = hashes.filter(hash => !cached.has(hash.toLowerCase()));
          if (hashesToCheck.length > 0) {
            const stremthruResults = await stremThru.checkInstantAvailability(hashesToCheck, 'alldebrid', apiKey);
            for (const hash of stremthruResults) {
              cached.add(hash.toLowerCase());
            }
          }
        } catch (stremError) {
          console.error(`[AD CACHE-CHECK] Error checking StremThru in checkAndProcessCache:`, stremError.message);
        }
      }
      
      return cached;
    },
    liveCheckHash: async (hash) => {
      // Try to check cache status by uploading magnet and seeing if it's cached
      try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        // Upload the magnet to check if it's cached
        const response = await adCall(() => AD.magnet.upload(magnet));
        const uploadMagnet = response?.data?.magnets?.[0];
        const magnetId = uploadMagnet?.id;
        
        if (magnetId) {
          console.log(`[AD CACHE-CHECK] Uploaded magnet ${magnetId} for ${hash.substring(0,16)}..., upload ready: ${uploadMagnet.ready || false}`);
          
          // If uploadMagnet.ready is true, it means it was already cached
          // Use magnet/files API to get the file list which indicates cache status
          const filesResponse = await getMagnetFiles(AD, magnetId);
          const magnetInfo = filesResponse?.data?.magnets?.[0];
          
          if (!magnetInfo) {
            console.log(`[AD CACHE-CHECK] No magnet info returned for ${magnetId}`);
            // Add to cleanup queue since it wasn't cached
            magnetIdsToDelete.add(magnetId);
            return false;
          }
          
          // In AllDebrid, if files exist in the response, it means the content is cached
          console.log(`[AD CACHE-CHECK] Magnet ${magnetId} has ${magnetInfo.files?.length || 0} files, checking for video content...`);
          
          // Check if it has valid video files (cached torrents will have files immediately available)
          const files = extractADFiles(magnetInfo);
          const hasVideo = files.some(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
          const hasValidSize = files.some(f => f.bytes > 50 * 1024 * 1024); // 50MB minimum
          
          console.log(`[AD CACHE-CHECK] hasVideo=${hasVideo}, hasValidSize=${hasValidSize} for ${hash.substring(0,16)}...`);
          
          if (hasVideo && hasValidSize) {
            // Persist to Mongo cache
            try {
              const largestVideo = files
                .filter(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX))
                .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
              await addHashToSqlite(hash, largestVideo?.path || null, largestVideo?.bytes || null, { status: 'cached', magnetId: magnetId });
            } catch {}
            console.log(`[AD CACHE-CHECK] ✅ CACHE HIT: ${hash.substring(0,16)}... has valid video and size`);
            // Add to cleanup queue even if cached, as we've used it for verification
            magnetIdsToDelete.add(magnetId);
            return true;
          } else {
            console.log(`[AD CACHE-CHECK] ❌ CACHE MISS: ${hash.substring(0,16)}... hasVideo=${hasVideo}, hasValidSize=${hasValidSize}`);
          }
          
          // Add to cleanup queue since it wasn't cached
          magnetIdsToDelete.add(magnetId);
        } else {
          console.log(`[AD CACHE-CHECK] Failed to upload magnet for ${hash.substring(0,16)}...`);
        }
      } catch (error) {
        const errorMessage = error?.message || error;
        console.log(`[AD CACHE-CHECK] Live check for ${hash.substring(0,16)}... failed: ${errorMessage}`);
        // Check if this is the VPN/proxy error from AllDebrid
        if (errorMessage.includes('VPN') || errorMessage.includes('server') || errorMessage.includes('not allowed')) {
          console.error('[AD CACHE-CHECK] Proxy is not working properly - AllDebrid detected server location');
        }
      }
      return false;
    },
    cleanup: async () => {
      await saveHashCache(); // no-op; file cache removed
      if (magnetIdsToDelete.size > 0) cleanupTemporaryMagnets(AD, magnetIdsToDelete);
    }
  };
  let cachedResults = await processAndFilterTorrents(externalTorrents, adHandler, null, {}, false);
  if (externalTorrents.length > 0) {
      const nonCached = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));
      const verifiedNonCached = await inspectAndFilterNonCached(nonCached, adHandler);
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
  searchAllDebridTorrents,
  buildPersonalHashCache,
  resolveStreamUrl,
  makeReleaseKey,
  searchPersonalFiles
};
