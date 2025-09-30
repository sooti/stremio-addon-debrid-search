import AllDebridClient from 'all-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import RdLimiter from './util/rd-rate-limit.js';
const adCall = (fn) => RdLimiter.schedule(fn);
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { matchesSeriesTitle, hasEpisodeMarker } from './util/seriesTitleMatcher.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import { getCachedHashes as mongoGetCachedHashes, upsertCachedMagnet as mongoUpsert, getReleaseCounts as mongoGetReleaseCounts, default as mongoCache } from './common/mongo-cache.js';

const { isValidVideo, isValidTorrentTitle, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'AD';

// ---------------------------------------------------------------------------------
// Global state & Cache
// ---------------------------------------------------------------------------------

function getQualityCategory(torrentName) {
  const name = (torrentName || '').toLowerCase();

  if (config.PRIORITY_PENALTY_AAC_OPUS_ENABLED && /(\s|\.)((aac|opus))\b/.test(name)) {
    return 'Audio-Focused';
  }

  if (/\bremux\b/.test(name)) return 'Remux';
  if (/\b(web-?rip|brrip|dlrip|bluray\s*rip)\b/.test(name)) return 'BRRip/WEBRip';
  if (/\b(blu-?ray|bdrip)\b/.test(name)) return 'BluRay';
  if (/\b(web-?\.?dl|web\b)/.test(name)) return 'WEB/WEB-DL';
  return 'Other';
}

let globalAbortController = null;
// file cache removed

function createAbortController() {
  if (globalAbortController) globalAbortController.abort();
  globalAbortController = new AbortController();
  return globalAbortController;
}

async function loadHashCache() { return; }

async function saveHashCache() { return; }
function addHashToCache(hash) { return; }
function isHashInCache(hash) { return false; }
function addHashToMongo(hash, fileName = null, size = null, data = null) {
  try {
    if (!hash || !mongoCache?.isEnabled()) return;
    const payload = { service: 'alldebrid', hash: String(hash).toLowerCase(), fileName, size, data };
    setImmediate(() => { mongoUpsert(payload).catch(() => {}); });
  } catch (_) {}
}

function deferMongoUpserts(payloads = []) {
  try {
    if (!mongoCache?.isEnabled()) return;
    if (!Array.isArray(payloads) || payloads.length === 0) return;
    setImmediate(() => {
      Promise.allSettled(payloads.map(p => mongoUpsert(p))).catch(() => {});
    });
  } catch (_) {}
}

function makeReleaseKey(type, imdbId, season = null, episode = null) {
  if (type === 'series' && season != null && episode != null) {
    return `${type}:${imdbId}:S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  }
  return `${type}:${imdbId}`;
}


function uniqueUpserts(payloads = []) {
  const seen = new Set();
  const out = [];
  for (const p of payloads) {
    const key = `${p.service || ''}:${(p.hash || '').toLowerCase()}`;
    if (!p.hash || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
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

function norm(s) {
  return (s || '').replace(/[’'`]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
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
    url = `magnet:?xt=urn:btih:${torrent.hash}`;
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
  const externalTorrents = [].concat(...externalSources);
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

    // Phase 1.5: if Mongo enabled, check release-level counts to potentially skip scrapers
    const releaseKey = makeReleaseKey(type, imdbId, episodeInfo?.season, episodeInfo?.episode);
    let mongoCounts = { byCategory: {}, byCategoryResolution: {}, total: 0 };
    if (mongoCache?.isEnabled()) {
      try { mongoCounts = await mongoGetReleaseCounts('alldebrid', releaseKey); } catch {}
    }

    const combinedByCategory = { ...mongoCounts.byCategory };
    const combinedByCategoryResolution = JSON.parse(JSON.stringify(mongoCounts.byCategoryResolution || {}));
    for (const [cat, count] of Object.entries(personalByCategory)) {
      combinedByCategory[cat] = (combinedByCategory[cat] || 0) + count;
    }
    for (const [cat, byRes] of Object.entries(personalByCategoryResolution)) {
      combinedByCategoryResolution[cat] = combinedByCategoryResolution[cat] || {};
      for (const [res, c] of Object.entries(byRes)) {
        combinedByCategoryResolution[cat][res] = (combinedByCategoryResolution[cat][res] || 0) + c;
      }
    }

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
    const highResSatisfied = HQ_CATEGORIES.every(cat => {
      const limit = rdQualityLimits[cat];
      if (typeof limit !== 'number' || limit <= 0) return true;
      return HQ_RES.every(res => (combinedByCategoryResolution?.[cat]?.[res] || 0) >= limit);
    });

    if (highResSatisfied) {
      console.log(`[${LOG_PREFIX}] Mongo+Personal quotas satisfy high-res limits for ${releaseKey}. Skipping torrent scrapers.`);
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
    const scraperPromises = [];
    const cfgBase = (lang) => ({ ...userConfig, Languages: lang ? [lang] : [] });
    const key = baseSearchKey;
    const pushAllScrapers = (cfg) => {
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
    };

    if (selectedLanguages.length === 0) {
      pushAllScrapers(cfgBase());
    } else {
      for (const lang of selectedLanguages) pushAllScrapers(cfgBase(lang));
    }

    const scraperResults = await Promise.all(scraperPromises);
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
    }

    await loadHashCache();
    const AD = new AllDebridClient(apiKey);
    const failedPackHashes = new Set();
    const successfulPackResults = new Map();

    const adHandler = {
      getIdentifier: () => LOG_PREFIX,
      checkCachedHashes: async (hashes) => {
        const cached = new Set();
        // Prefer Mongo cache when enabled
        try {
          if (mongoCache?.isEnabled()) {
            const mongoSet = await mongoGetCachedHashes('alldebrid', hashes);
            for (const h of mongoSet) cached.add(String(h).toLowerCase());
          }
        } catch {}
        // Ask AllDebrid for instant availability
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
        // File cache removed; rely on Mongo + API only
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
          for (let i = 0; i < 3; i++) {
            info = await adCall(() => AD.magnet.status(magnetId));
            const magObj = extractADMagnet(info);
            const status = (magObj?.status || '').toString().toLowerCase();
            lastMag = magObj;
            if (status === 'ready' || (Array.isArray(magObj?.links) && magObj.links.length) || (Array.isArray(magObj?.files) && magObj.files.length)) {
              break;
            }
            await delay(400);
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
                isCached: true, isFromPack: true, packHash: hash, searchableName: mag?.filename || mag?.name
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

    cachedResults = await processAndFilterTorrents(externalTorrents, adHandler, episodeInfo, combinedQuotas);
    nonCachedTorrents = externalTorrents.filter(t => !cachedResults.some(c => c.InfoHash === t.InfoHash));

    if (nonCachedTorrents.length > 0) {
      const topNonCached = nonCachedTorrents.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0)).slice(0, 5);
      const verifiedNonCached = await inspectAndFilterNonCached(topNonCached, adHandler);
      cachedResults.push(...verifiedNonCached.map(t => ({ ...t, isCached: false })));

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
  try {
    const m = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!m?.[1]) return null;
    const hash = m[1].toLowerCase();
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

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
  const AD = new AllDebridClient(apiKey, { ip: clientIp });
  try {
    if (!hostUrl || hostUrl.includes('undefined')) return null;
    if (hostUrl.startsWith('alldebrid:')) {
      const parts = hostUrl.split(':');
      const magnetId = parts[1];
      const fileIndex = parseInt(parts[2], 10);
      if (!magnetId || isNaN(fileIndex)) return null;
      const info = await adCall(() => AD.magnet.status(magnetId));
      const mag = extractADMagnet(info);
      const files = extractADFiles(mag);
      const f = files[fileIndex];
      if (!f) return null;
      const link = f.link;
      if (!link) return null;
      const response = await adCall(() => AD.link.unlock(link));
      return response?.data?.link || response?.data?.download || link;
    } else if (hostUrl.includes('magnet:')) {
      const fileReference = await resolveMagnetUrl(apiKey, hostUrl, clientIp);
      if (!fileReference) return null;
      if (fileReference.startsWith('http')) return fileReference;
      return await unrestrictUrl(apiKey, fileReference, clientIp);
    } else {
      const response = await adCall(() => AD.link.unlock(hostUrl));
      return response?.data?.link || response?.data?.download || null;
    }
  } catch {
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
  // AllDebrid API does not expose a paginated torrent catalog; return empty list
  console.log(`[${LOG_PREFIX}] Catalog listing not supported by AllDebrid.`);
  return [];
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
    const verifiedNonCached = await inspectAndFilterNonCached(nonCached.sort((a,b) => (b.Seeders||0) - (a.Seeders||0)).slice(0,5), adHandler);
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
  resolveStreamUrl
};
