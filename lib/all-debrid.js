import AllDebridClient from 'all-debrid-api';
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
import * as mongoCache from './common/mongo-cache.js';
import { obfuscateSensitive } from './common/torrent-utils.js';
import searchCoordinator from './util/search-coordinator.js';
import { orchestrateScrapers } from './util/scraper-selector.js';
import * as debridHelpers from './util/debrid-helpers.js';

const { isValidVideo, isValidTorrentTitle, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'AD';

// ---------------------------------------------------------------------------------
// Global state & Cache
// ---------------------------------------------------------------------------------

// Use debrid-helpers functions
const getQualityCategory = debridHelpers.getQualityCategory;
const createAbortController = debridHelpers.createAbortController;
const norm = debridHelpers.norm;
const addHashToMongo = (hash, fileName = null, size = null, data = null) => debridHelpers.addHashToMongo(hash, fileName, size, data, 'alldebrid');
const deferMongoUpserts = debridHelpers.deferMongoUpserts;
const uniqueUpserts = debridHelpers.uniqueUpserts;

let globalAbortController = null;
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
      console.error(`[AD CLEANUP] ❌ Error deleting magnet ${id}: ${deleteError?.message || deleteError}`);
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

function extractADFiles(mag) {
  const raw = (mag?.links || mag?.files || []) || [];
  // Map to uniform {path, bytes, index, link}
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!f) continue;
    if (typeof f === 'string') {
      out.push({ path: `file_${i}`, bytes: 0, index: i, link: f });
    } else if (typeof f === 'object') {
      out.push({
        path: f.filename || f.name || f.link || `file_${i}`,
        bytes: f.size || f.filesize || 0,
        index: f.index != null ? f.index : i,
        link: f.link || f.download || f.url || null
      });
    }
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
    // Phase 1: fetch personal files first (AllDebrid exposes recent links)
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

    // Compute personal quotas (category + per-resolution)
    const personalByCategory = {};
    const personalByCategoryResolution = {};
    for (const file of enrichedPersonalFiles) {
      if (!file.category) continue;
      personalByCategory[file.category] = (personalByCategory[file.category] || 0) + 1;
      if (file.resolution) {
        personalByCategoryResolution[file.category] = personalByCategoryResolution[file.category] || {};
        personalByCategoryResolution[file.category][file.resolution] = (personalByCategoryResolution[file.category][file.resolution] || 0) + 1;
      }
    }

    // Phase 1.5: MongoDB counts are for scraper optimization only, NOT for quota satisfaction
    const releaseKey = makeReleaseKey(type, imdbId, episodeInfo?.season, episodeInfo?.episode);

    // ONLY personal files count toward quotas (not MongoDB hash metadata)
    // MongoDB cache is used to avoid API calls, but cached hashes still need to be returned as streams
    const combinedByCategory = { ...personalByCategory };
    const combinedByCategoryResolution = JSON.parse(JSON.stringify(personalByCategoryResolution || {}));

    const rdDefaultMax = parseInt(process.env.MAX_RESULTS_PER_QUALITY, 10) || 2;
    const rdQualityLimits = {
      'Remux': parseInt(process.env.MAX_RESULTS_REMUX, 10) || rdDefaultMax,
      'BluRay': parseInt(process.env.MAX_RESULTS_BLURAY, 10) || rdDefaultMax,
      'WEB/WEB-DL': parseInt(process.env.MAX_RESULTS_WEBDL, 10) || rdDefaultMax,
      'BRRip/WEBRip': parseInt(process.env.MAX_RESULTS_WEBRIP, 10) || 1,
      'Audio-Focused': parseInt(process.env.MAX_RESULTS_AUDIO, 10) || 1,
      'Other': parseInt(process.env.MAX_RESULTS_OTHER, 10) || 10
    };

    const HQ_CATEGORIES = ['Remux', 'BluRay', 'WEB/WEB-DL'];
    const HQ_RES = ['2160p', '1080p'];
    // Only allow early-exit when PERSONAL files alone satisfy high-res per-resolution quotas
    const personalHighResSatisfied = HQ_CATEGORIES.every(cat => {
      const limit = rdQualityLimits[cat];
      if (typeof limit !== 'number' || limit <= 0) return true;
      return HQ_RES.every(res => (personalByCategoryResolution?.[cat]?.[res] || 0) >= limit);
    });

    if (personalHighResSatisfied) {
      console.log(`[${LOG_PREFIX}] Personal quotas satisfy high-res limits for ${releaseKey}. Skipping torrent scrapers.`);
      try {
        if (mongoCache?.isEnabled()) {
          const upserts = [];
          for (const file of enrichedPersonalFiles) {
            if (!file.hash) continue;
            upserts.push({
              service: 'alldebrid',
              hash: String(file.hash).toLowerCase(),
              fileName: file.name || null,
              size: file.size || null,
              releaseKey,
              category: file.category || null,
              resolution: file.resolution || null,
              data: { source: 'personal' }
            });
          }
          deferMongoUpserts(uniqueUpserts(upserts));
        }
      } catch {}

      const combined = [...personalFiles];
      let allResults = combined.map(torrent => formatCachedResult(torrent, true));
      allResults.sort((a, b) => {
        const rankA = resolutionOrder[getResolutionFromName(a.name)];
        const rankB = resolutionOrder[getResolutionFromName(b.name)];
        if (rankA !== rankB) return rankB - rankA;
        return (b.size || 0) - (a.size || 0);
      });
      console.log(`[${LOG_PREFIX}] Early exit: ${allResults.length} personal streams (sorted)`);
      return allResults;
    }

    // Phase 2: build scrapers only if needed
    // Execute coordinated scrapers to avoid duplicate work when multiple services run simultaneously
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
    const AD = new AllDebridClient(apiKey);
    const failedPackHashes = new Set();
    const successfulPackResults = new Map();

    const adHandler = {
      getIdentifier: () => LOG_PREFIX,
      checkCachedHashes: async (hashes) => {
        const cached = new Set();
        
        // First, check MongoDB for cached hashes
        if (mongoCache?.isEnabled()) {
            try {
                const mongoHashes = await mongoCache.getCachedHashes('alldebrid', hashes);
                mongoHashes.forEach(h => cached.add(h.toLowerCase()));
            } catch (error) {
                console.error(`[AD MONGO] Error getting cached hashes: ${error.message}`);
            }
        }
        
        return cached;
      },
      liveCheckHash: async (hash) => {
        let magnetId;
        try {
          const magnet = `magnet:?xt=urn:btih:${hash}`;
          const up = await adCall(() => AD.magnet.upload(magnet));
          const created = extractADMagnet(up) || {};
          magnetId = created.id || created.magnet?.id || created.task?.id;
          if (!magnetId) {
            console.log(`[${LOG_PREFIX} CACHE-CHECK] upload failed for ${hash}`);
            return false;
          }
          magnetIdsToDelete.add(magnetId);

          // Poll magnet status briefly; AD returns 'ready' immediately for cached magnets.
          // Be resilient to response shape: data.magnets[0] | data.magnet | data
          let info;
          let lastMag;
          for (let i = 0; i < 1; i++) {
            info = await adCall(() => AD.magnet.status(magnetId));
            const magObj = extractADMagnet(info);
            const status = (magObj?.status || '').toString().toLowerCase();
            lastMag = magObj;
            if (status === 'ready' || (Array.isArray(magObj?.links) && magObj.links.length) || (Array.isArray(magObj?.files) && magObj.files.length)) {
              break;
            }
            await delay(50);
          }

          const mag = lastMag || extractADMagnet(info);
          const files = extractADFiles(mag);

          const JUNK_EXTENSIONS = ['.iso', '.exe', '.zip', '.rar', '.7z', '.scr'];
          const hasJunk = files.some(f => JUNK_EXTENSIONS.some(ext => (f.path || '').toLowerCase().endsWith(ext)));
          const hasVideo = files.some(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
          // If AD reports ready and we have links but couldn't parse metadata to confirm video,
          // still treat as cached to avoid false negatives.
          const statusReady = (mag?.status || '').toString().toLowerCase() === 'ready';
          const hasLinks = Array.isArray(mag?.links) ? mag.links.length > 0 : Array.isArray(mag?.files) ? mag.files.length > 0 : files.length > 0;
          if ((statusReady && hasLinks) && (!hasVideo && !hasJunk)) {
            try { await addHashToMongo(hash, null, null, { status: 'ready' }); } catch {}
            return true;
          }
          if (!hasVideo || hasJunk) return false;

          try {
            const largestVideo = files.filter(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX)).sort((a,b) => (b.bytes||0)-(a.bytes||0))[0] || null;
            await addHashToMongo(hash, largestVideo?.path || null, largestVideo?.bytes || null, { status: 'ready' });
          } catch {}
          return true;
        } catch (e) {
          console.log(`[${LOG_PREFIX} CACHE-CHECK] Exception during live check for ${hash}: ${e?.message || e}`);
        }
        return false;
      },
      batchCheckSeasonPacks: async (hashes, season, episode) => {
        const MAX_PACKS_TO_INSPECT = config.MAX_PACKS_TO_INSPECT || 3;
        const packResults = new Map();
        let inspected = 0;
        for (const hash of hashes) {
          if (inspected >= MAX_PACKS_TO_INSPECT) break;
          try {
            const up = await adCall(() => AD.magnet.upload(`magnet:?xt=urn:btih:${hash}`));
            const created = extractADMagnet(up) || {};
            const magnetId = created.id;
            if (!magnetId) continue;
            magnetIdsToDelete.add(magnetId);
            const info = await adCall(() => AD.magnet.status(magnetId));
            const mag = extractADMagnet(info);
            const files = extractADFiles(mag);
            const JUNK_EXTENSIONS = ['.iso', '.exe', '.zip', '.rar', '.7z', '.scr'];
            const matching = files.filter(file => {
              if (JUNK_EXTENSIONS.some(ext => file.path.toLowerCase().endsWith(ext))) return false;
              const parsed = PTT.parse(file.path) || {};
              return parsed.season === season && parsed.episode === episode;
            });
            if (matching.length > 0) {
              matching.sort((a,b) => b.bytes - a.bytes);
              const bestFile = matching[0];
              const episodeResult = {
                InfoHash: hash, Title: bestFile.path, name: bestFile.path, Size: bestFile.bytes,
                size: bestFile.bytes, Seeders: 0, Tracker: 'Pack Inspection',
                episodeFileHint: { filePath: bestFile.path, fileBytes: bestFile.bytes, magnetId, fileIndex: bestFile.index },
                isCached: true, isFromPack: true, packHash: hash, searchableName: bestFile.path
              };
              packResults.set(hash, [episodeResult]);
              inspected++;
            }
          } catch (error) {
            console.error(`[AD PACK INSPECT] 💥 Error inspecting pack ${hash}: ${error.message}`);
          }
        }
        return packResults;
      },
      cleanup: async () => {}
    };

    const combinedQuotas = { byCategory: combinedByCategory, byCategoryResolution: combinedByCategoryResolution };

    try {
      if (mongoCache?.isEnabled()) {
        const upserts = [];
        for (const file of enrichedPersonalFiles) {
          if (!file.hash) continue;
          upserts.push({
            service: 'alldebrid',
            hash: String(file.hash).toLowerCase(),
            fileName: file.name || null,
            size: file.size || null,
            releaseKey,
            category: file.category || null,
            resolution: file.resolution || null,
            data: { source: 'personal' }
          });
        }
        deferMongoUpserts(upserts);
      }
    } catch {}

    let cachedResults = [];
    let nonCachedTorrents = [];

    // Sort by resolution priority first (4K, 1080p, 720p, etc.), then by seeders within each resolution
    externalTorrents.sort((a, b) => {
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
    cachedResults = await processAndFilterTorrents(externalTorrents, adHandler, episodeInfo, combinedQuotas);
    nonCachedTorrents = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));

    // Check if we already have sufficient high-quality results before inspecting non-cached
    const hasEnoughHQResults = () => {
      const HQ_CATEGORIES = ['Remux', 'BluRay', 'WEB/WEB-DL'];
      const qualityLimits = {
        'Remux': parseInt(process.env.MAX_RESULTS_REMUX, 10) || 2,
        'BluRay': parseInt(process.env.MAX_RESULTS_BLURAY, 10) || 2,
        'WEB/WEB-DL': parseInt(process.env.MAX_RESULTS_WEBDL, 10) || 2
      };

      return HQ_CATEGORIES.some(category => {
        const limit = qualityLimits[category];
        const results1080p = [...personalFiles, ...cachedResults].filter(r =>
          r.category === category && r.resolution === '1080p'
        ).length;
        const results2160p = [...personalFiles, ...cachedResults].filter(r =>
          r.category === category && r.resolution === '2160p'
        ).length;
        return results1080p >= limit || results2160p >= limit;
      });
    };

    if (nonCachedTorrents.length > 0 && !hasEnoughHQResults()) {
      const topNonCached = nonCachedTorrents.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0)).slice(0, 5);
      const verifiedNonCached = await inspectAndFilterNonCached(topNonCached, adHandler);
      cachedResults.push(...verifiedNonCached.map(t => ({ ...t, isCached: false })));
    } else if (nonCachedTorrents.length > 0 && hasEnoughHQResults()) {
      console.log(`[${LOG_PREFIX}] ✅ Already have sufficient HQ results - skipping non-cached torrent inspection`);
    }

    if (cachedResults.length > 0) {

      try {
        if (mongoCache?.isEnabled()) {
          const upserts = [];
          for (const t of cachedResults) {
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
          deferMongoUpserts(uniqueUpserts(upserts));
        }
      } catch {}
    }

    const combined = [...personalFiles, ...cachedResults];
    let allResults = combined.map(torrent => formatCachedResult(torrent, torrent.isCached));

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

    console.log(`[${LOG_PREFIX}] Comprehensive total: ${allResults.length} streams (sorted)`);
    return allResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Comprehensive search failed: ${error.message}`);
    return [];
  } finally {
    await saveHashCache();
    if (abortController === globalAbortController) globalAbortController = null;
    cleanupTemporaryMagnets(new AllDebridClient(apiKey), magnetIdsToDelete);
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
  const AD = new AllDebridClient(apiKey);
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
  const AD = new AllDebridClient(apiKey, { ip: clientIp });
  try {
    const hashMatch = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!hashMatch?.[1]) return null;
    const hash = hashMatch[1].toLowerCase();
    // file cache removed; always resolve via API
    const up = await adCall(() => AD.magnet.upload(magnetUrl));
    const created = extractADMagnet(up) || {};
    const magnetId = created.id;
    if (!magnetId) return null;

    let info = await adCall(() => AD.magnet.status(magnetId));
    const mag = extractADMagnet(info);
    const files = extractADFiles(mag);
    if (files.length === 0) return null;
    let selected = files.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (!selected) { files.sort((a, b) => b.bytes - a.bytes); selected = files[0]; }
    // file cache removed; rely on Mongo upsert only
    try { await addHashToMongo(hash, selected?.path || null, selected?.bytes || null, { magnetId }); } catch {}
    return `alldebrid:${magnetId}:${selected.index}`;
  } catch {
    return null;
  }
}

async function resolveMagnetUrl(apiKey, magnetUrl, clientIp) {
    const AD = new AllDebridClient(apiKey, { ip: clientIp });
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
        let info;

        if (hintPayload?.magnetId) {
            magnetId = hintPayload.magnetId;
            console.log(`[${LOG_PREFIX} RESOLVER] Using magnetId from hint: ${magnetId}`);
            try {
                info = await adCall(() => AD.magnet.status(magnetId));
            } catch (e) {
                console.warn(`[${LOG_PREFIX} RESOLVER] Failed to get status for magnetId ${magnetId} from hint. It might have been deleted. Falling back to re-upload. Error: ${e.message}`);
                info = null;
                magnetId = null;
            }
        }

        if (!info) {
            console.log(`[${LOG_PREFIX} RESOLVER] No valid info from hint, uploading magnet...`);
            try {
                const up = await adCall(() => AD.magnet.upload(magnetUrl));
                const created = extractADMagnet(up) || {};
                magnetId = created.id;
                if (!magnetId) {
                    console.error(`[${LOG_PREFIX} RESOLVER] Failed to upload magnet, no ID returned for hash ${hash}`);
                    return null;
                }
                info = await adCall(() => AD.magnet.status(magnetId));
            } catch (uploadError) {
                const errorMsg = uploadError?.message || uploadError;
                if (errorMsg && (errorMsg.includes('apikey is invalid') || errorMsg.includes('auth') || errorMsg.includes('permission'))) {
                    console.error(`[${LOG_PREFIX} RESOLVER] ❌ Authentication failed: ${errorMsg}`);
                    console.error(`[${LOG_PREFIX} RESOLVER] Please verify your All-Debrid API key is valid and has not expired.`);
                }
                throw uploadError;
            }
        }

        const mag = extractADMagnet(info);
        const files = extractADFiles(mag);
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

        try { await addHashToMongo(hash, selected?.path || null, selected?.bytes || null, { magnetId }); } catch {}

        const finalRef = `alldebrid:${magnetId}:${selected.index}`;
        console.log(`[${LOG_PREFIX} RESOLVER] Successfully created file reference: ${finalRef}`);
        return finalRef;
    } catch (error) {
      console.error(`[${LOG_PREFIX} RESOLVER] Exception in resolveMagnetUrl: ${error?.message || error}`);
      return null;
    }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
  const AD = new AllDebridClient(apiKey, { ip: clientIp });
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
      const info = await adCall(() => AD.magnet.status(magnetId));
      const mag = extractADMagnet(info);
      const files = extractADFiles(mag);
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
  const AD = new AllDebridClient(apiKey);
  try {
    const downloads = await getAllDownloads(AD);
    return downloads.map(download => formatDownloadFile(download));
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error listing torrents: ${error.message}`);
    return [];
  }
}

async function getTorrentDetails(apiKey, id) {
  const AD = new AllDebridClient(apiKey);
  const magnetId = id.includes(':') ? id.split(':')[0] : id;
  try {
    const response = await adCall(() => AD.magnet.status(magnetId));
    const mag = extractADMagnet(response);
    return toTorrentDetails(apiKey, mag);
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
    const AD = new AllDebridClient(apiKey);
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
  const AD = new AllDebridClient(apiKey);
  const magnetIdsToDelete = new Set();
  const adHandler = {
    getIdentifier: () => LOG_PREFIX,
    checkCachedHashes: async (hashes) => {
      const cached = new Set();
      try {
        const magnets = hashes.map(h => `magnet:?xt=urn:btih:${h}`);
        const resp = await adCall(() => AD.magnet.instant(magnets));
        const raw = resp?.data?.magnets || resp?.data || [];
        const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
        for (const entry of list) {
          const h = (entry.hash || entry.magnetHash || '').toLowerCase();
          const instant = entry.instant || entry.ready || entry.found;
          if (h && instant) cached.add(h);
        }
      } catch {}
      return cached;
    },
    liveCheckHash: async (hash) => {
      let magnetId;
      try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        const up = await adCall(() => AD.magnet.upload(magnet));
        const created = extractADMagnet(up) || {};
        magnetId = created.id;
        if (!magnetId) return false;
        magnetIdsToDelete.add(magnetId);
        const info = await adCall(() => AD.magnet.status(magnetId));
        const mag = extractADMagnet(info);
        const files = extractADFiles(mag);
        const hasVideo = files.some(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
        const hasJunk = files.some(f => /(\.iso|\.exe|\.zip|\.rar|\.7z)$/i.test(f.path || ''));
        const statusReady = (mag?.status || '').toString().toLowerCase() === 'ready';
        const hasLinks = Array.isArray(mag?.links) ? mag.links.length > 0 : Array.isArray(mag?.files) ? mag.files.length > 0 : files.length > 0;
        if ((statusReady && hasLinks) && (!hasVideo && !hasJunk)) {
          return true;
        }
        if (!hasVideo || hasJunk) return false;
        return true;
      } catch {}
      return false;
    },
    cleanup: async () => {
      await saveHashCache(); // no-op; file cache removed
      if (magnetIdsToDelete.size > 0) cleanupTemporaryMagnets(AD, magnetIdsToDelete);
    }
  };
  let cachedResults = await processAndFilterTorrents(externalTorrents, adHandler, null);
  if (externalTorrents.length > 0) {
    const nonCached = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));

    // Check if we already have sufficient HQ results
    const HQ_CATEGORIES = ['Remux', 'BluRay', 'WEB/WEB-DL'];
    const qualityLimits = {
      'Remux': parseInt(process.env.MAX_RESULTS_REMUX, 10) || 2,
      'BluRay': parseInt(process.env.MAX_RESULTS_BLURAY, 10) || 2,
      'WEB/WEB-DL': parseInt(process.env.MAX_RESULTS_WEBDL, 10) || 2
    };
    const hasEnoughHQResults = HQ_CATEGORIES.some(category => {
      const limit = qualityLimits[category];
      const results1080p = cachedResults.filter(r => r.category === category && r.resolution === '1080p').length;
      const results2160p = cachedResults.filter(r => r.category === category && r.resolution === '2160p').length;
      return results1080p >= limit || results2160p >= limit;
    });

    if (!hasEnoughHQResults) {
      const verifiedNonCached = await inspectAndFilterNonCached(nonCached.sort((a,b) => (b.Seeders||0) - (a.Seeders||0)).slice(0,5), adHandler);
      cachedResults.push(...verifiedNonCached.map(t => ({...t, isCached: false})));
    } else {
      console.log(`[${LOG_PREFIX}] ✅ Already have sufficient HQ results - skipping non-cached torrent inspection`);
    }
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
  resolveStreamUrl
};
