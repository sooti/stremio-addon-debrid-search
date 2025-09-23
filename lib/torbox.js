// torbox-extended.js — TorBox integration mirroring real-debrid.js

import { TorboxApi } from '@torbox/torbox-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import { promises as fs } from 'fs';
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { matchesSeriesTitle, hasEpisodeMarker } from './util/seriesTitleMatcher.js';

const {
  isValidVideo,
  getResolutionFromName,
  resolutionOrder,
  delay,
  filterByYear
} = torrentUtils;

const LOG_PREFIX = 'TB';
const API_BASE_URL = 'https://api.torbox.app';
const API_VERSION = 'v1';
const API_VALIDATION_OPTIONS = { responseValidation: false };

// ---------------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------------
let globalAbortController = null;
function createAbortController() {
  if (globalAbortController) globalAbortController.abort();
  globalAbortController = new AbortController();
  return globalAbortController;
}

// ---------------------------------------------------------------------------------
// Optional file-based hash cache (best-effort, but NOT used for correctness)
// ---------------------------------------------------------------------------------
let fileHashCache = new Map();

async function loadHashCache() {
  if (!config.TB_HASH_CACHE_ENABLED) return;
  try {
    await fs.access(config.TB_HASH_CACHE_PATH);
    const data = await fs.readFile(config.TB_HASH_CACHE_PATH, 'utf-8');
    fileHashCache = new Map(Object.entries(JSON.parse(data)));
    const expirationTime = Date.now() - (config.TB_HASH_CACHE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
    let pruned = 0;
    for (const [hash, ts] of fileHashCache.entries()) {
      if (ts < expirationTime) { fileHashCache.delete(hash); pruned++; }
    }
    console.log(`[FILE CACHE] Loaded ${fileHashCache.size} TB hashes. Pruned ${pruned}.`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[FILE CACHE] TB cache file not found. A new one will be created.');
      fileHashCache = new Map();
    } else {
      console.error(`[FILE CACHE] Error loading TB cache: ${err.message}`);
    }
  }
}

async function saveHashCache() {
  if (!config.TB_HASH_CACHE_ENABLED) return;
  try {
    const obj = Object.fromEntries(fileHashCache);
    await fs.writeFile(config.TB_HASH_CACHE_PATH, JSON.stringify(obj, null, 2));
    console.log(`[FILE CACHE] Saved ${fileHashCache.size} TB hashes.`);
  } catch (err) {
    console.error(`[FILE CACHE] Error saving TB cache: ${err.message}`);
  }
}

function addHashToCache(hash) {
  if (!config.TB_HASH_CACHE_ENABLED || !hash) return;
  fileHashCache.set(hash.toLowerCase(), Date.now());
}
function isHashInCache(hash) {
  if (!config.TB_HASH_CACHE_ENABLED || !hash) return false;
  return fileHashCache.has(hash.toLowerCase());
}

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------
function norm(s) {
  return (s || '')
    .replace(/[’'`]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function tb(apiKey) {
  return new TorboxApi({
    token: apiKey,
    baseUrl: API_BASE_URL,
    validation: API_VALIDATION_OPTIONS
  });
}

// TorBox: check cached without creating torrents
async function torboxCheckCached(api, hashes) {
  if (!hashes || hashes.length === 0) return new Set();
  try {
    // TorBox supports GET and POST for /torrents/checkcached; we’ll POST for batch
    const res = await api.torrents
      .checkCached(API_VERSION, { hashes });
    const data = res?.data?.data || res?.data || {};
    // Expected shape: { "<hash>": true/false, ... } or array of { hash, cached }
    const cached = new Set();
    if (Array.isArray(data)) {
      data.forEach(item => { if ((item.cached ?? item.is_cached) && item.hash) cached.add(item.hash.toLowerCase()); });
    } else {
      Object.entries(data).forEach(([h, v]) => { if (v) cached.add(h.toLowerCase()); });
    }
    return cached;
  } catch (err) {
    console.warn(`[${LOG_PREFIX}] checkcached error: ${err.message}`);
    return new Set();
  }
}

// ---------------------------------------------------------------------------------
// Formatting & combining results
// ---------------------------------------------------------------------------------
function formatCachedResult(torrent, isCached) {
  const title = torrent.Title || torrent.name || 'Unknown Title';
  const episodeHint = torrent.episodeFileHint || null;

  // For TorBox, we keep using a magnet (InfoHash) as the “url” for external results,
  // and personal items will carry a torbox: reference that we can resolve via requestdl.
  let url;
  if (torrent.isPersonal) {
    // Use torbox:<torrentId>:<fileId> as a resolvable handle
    if (torrent.torrentId && torrent.fileId) {
      url = `torbox:${torrent.torrentId}:${torrent.fileId}`;
    } else if (torrent.hash) {
      url = `magnet:?xt=urn:btih:${torrent.hash}`;
    } else {
      url = `magnet:?xt=urn:btih:${torrent.InfoHash || ''}`;
    }
  } else {
    const baseMagnet = `magnet:?xt=urn:btih:${torrent.InfoHash}`;
    if (episodeHint && torrent.InfoHash) {
      try {
        const hintPayload = { hash: (torrent.InfoHash || '').toLowerCase(), ...episodeHint };
        const encodedHint = Buffer.from(JSON.stringify(hintPayload)).toString('base64');
        url = `${baseMagnet}||HINT||${encodedHint}`;
      } catch {
        url = baseMagnet;
      }
    } else {
      url = baseMagnet;
    }
  }

  const displayName = episodeHint?.filePath ? episodeHint.filePath : title;
  const displaySize = (episodeHint && typeof episodeHint.fileBytes === 'number' && episodeHint.fileBytes > 0)
    ? episodeHint.fileBytes
    : (torrent.Size || torrent.size || torrent.filesize || 0);

  return {
    name: displayName,
    info: PTT.parse(title) || { title },
    size: displaySize,
    seeders: torrent.Seeders || torrent.seeders || 0,
    url,
    source: 'torbox',
    hash: (torrent.InfoHash || torrent.hash || '').toLowerCase(),
    tracker: torrent.Tracker || (torrent.isPersonal ? 'Personal' : 'Cached'),
    isPersonal: torrent.isPersonal || false,
    isCached,
    ...(episodeHint?.filePath ? { searchableName: title } : {}),
    ...(episodeHint ? { episodeHint } : {}),
    ...(torrent.id && { id: torrent.id }),
    ...(torrent.torrentId && { torrentId: torrent.torrentId }),
    ...(torrent.fileId && { fileId: torrent.fileId })
  };
}

function combineAndMarkResults(personalFiles, externalSources, specificSearchKey) {
  const sourceNames = ['Bitmagnet', 'Jackett', 'Torrentio', 'Zilean', 'Comet', 'StremThru', 'BT4G', 'TorrentGalaxy'];
  const enabledFlags = [
    config.BITMAGNET_ENABLED,
    config.JACKETT_ENABLED,
    config.TORRENTIO_ENABLED,
    config.ZILEAN_ENABLED,
    config.COMET_ENABLED,
    config.STREMTHRU_ENABLED,
    config.BT4G_ENABLED,
    config.TORRENT_GALAXY_ENABLED
  ];

  let sourceCounts = `Personal(${personalFiles.length})`;
  let idx = 0;
  for (let i = 0; i < enabledFlags.length; i++) {
    if (enabledFlags[i]) {
      sourceCounts += `, ${sourceNames[i]}(${externalSources[idx]?.length || 0})`;
      idx++;
    }
  }
  console.log(`[${LOG_PREFIX}] Sources found: ${sourceCounts}`);

  const markedPersonal = personalFiles.map(f => ({ ...f, source: 'torbox', isPersonal: true, tracker: 'Personal' }));
  const externalTorrents = [].concat(...externalSources);
  const uniqueExternal = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]));
  const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
  const newExternal = Array.from(uniqueExternal.values()).filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

  console.log(`[${LOG_PREFIX}] Sanity check on ${newExternal.length} external for "${specificSearchKey}"`);
  const normalized = newExternal.map(t => {
    const base = (t.Title || t.name || '').toString();
    return { ...t, _normKey: norm(base) };
  });
  const fuse = new Fuse(normalized, {
    keys: ['_normKey'],
    threshold: 0.55,
    distance: 200,
    ignoreLocation: true,
    minMatchCharLength: 2
  });
  const saneResults = fuse.search(norm(specificSearchKey)).map(r => r.item);
  const rejected = newExternal.length - saneResults.length;
  if (rejected > 0) console.log(`[${LOG_PREFIX}] Rejected ${rejected} irrelevant results.`);

  console.log(`[${LOG_PREFIX}] After filtering: ${personalFiles.length} personal + ${saneResults.length} external`);
  return [...markedPersonal, ...saneResults];
}

// ---------------------------------------------------------------------------------
// Main search (generic)
// ---------------------------------------------------------------------------------
async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
  console.log(`[${LOG_PREFIX}] Starting TorBox search for: "${searchKey}"`);
  if (!searchKey) return [];

  const abortController = createAbortController();
  const signal = abortController.signal;

  try {
    console.time(`[${LOG_PREFIX}] Personal files`);
    const personalFiles = await searchPersonalFiles(apiKey, searchKey, threshold);
    console.timeEnd(`[${LOG_PREFIX}] Personal files`);

    console.log(`[${LOG_PREFIX}] Searching external sources...`);
    const scraperPromises = [];
    if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(searchKey, signal, LOG_PREFIX));
    if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(searchKey, signal, LOG_PREFIX));
    if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, null, null, signal, LOG_PREFIX));
    if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet('movie', 'unknown', signal, null, null, LOG_PREFIX));
    if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(searchKey, signal, LOG_PREFIX));
    if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(searchKey, signal, LOG_PREFIX));
    if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(searchKey, signal, LOG_PREFIX));

    let scraperResults = [];
    try {
      scraperResults = await Promise.all(scraperPromises);
      console.log(`[${LOG_PREFIX}] External scrapers completed`);
    } catch (error) {
      console.log(`[${LOG_PREFIX}] Scraper error: ${error.message}`);
      scraperResults = [];
    }

    const combinedResults = combineAndMarkResults(personalFiles, scraperResults, searchKey);
    if (combinedResults.length === 0) return personalFiles;

    const externalTorrents = combinedResults.filter(t => !t.isPersonal);
    if (externalTorrents.length === 0) return personalFiles;

    const cachedResults = await checkAndProcessCache(apiKey, externalTorrents);
    console.log(`[${LOG_PREFIX}] Final: ${personalFiles.length} personal + ${cachedResults.length} cached`);
    return [...personalFiles, ...cachedResults];

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Search error: ${error.message}`);
    return [];
  } finally {
    if (abortController === globalAbortController) globalAbortController = null;
  }
}

// ---------------------------------------------------------------------------------
// Main search (TorBox torrents by meta id)
// ---------------------------------------------------------------------------------
async function searchTorboxTorrents(apiKey, type, id) {
  if (!id || typeof id !== 'string') {
    console.error(`[${LOG_PREFIX}] Invalid id parameter: ${id}`);
    return [];
  }

  const imdbId = id.split(':')[0];
  const [season, episode] = id.split(':').slice(1);
  const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
  if (!cinemetaDetails) return [];

  const searchKey = cinemetaDetails.name;
  const specificSearchKey = type === 'series'
    ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
    : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

  let episodeInfo = null;
  if (type === 'series' && season && episode) {
    episodeInfo = { season: parseInt(season, 10), episode: parseInt(episode, 10) };
  }

  console.log(`[${LOG_PREFIX}] Comprehensive TorBox search for: "${specificSearchKey}"`);
  const abortController = createAbortController();
  const signal = abortController.signal;

  const scraperPromises = [];
  if (config.BITMAGNET_ENABLED) scraperPromises.push(scrapers.searchBitmagnet(specificSearchKey, signal, LOG_PREFIX));
  if (config.JACKETT_ENABLED) scraperPromises.push(scrapers.searchJackett(specificSearchKey, signal, LOG_PREFIX));
  if (config.TORRENTIO_ENABLED) scraperPromises.push(scrapers.searchTorrentio(type, imdbId, signal, LOG_PREFIX));
  if (config.ZILEAN_ENABLED) scraperPromises.push(scrapers.searchZilean(searchKey, season, episode, signal, LOG_PREFIX));
  if (config.COMET_ENABLED) scraperPromises.push(scrapers.searchComet(type, imdbId, signal, season, episode, LOG_PREFIX));
  if (config.STREMTHRU_ENABLED) scraperPromises.push(scrapers.searchStremthru(specificSearchKey, signal, LOG_PREFIX));
  if (config.BT4G_ENABLED) scraperPromises.push(scrapers.searchBt4g(specificSearchKey, signal, LOG_PREFIX));
  if (config.TORRENT_GALAXY_ENABLED) scraperPromises.push(scrapers.searchTorrentGalaxy(specificSearchKey, signal, LOG_PREFIX));

  try {
    console.time(`[${LOG_PREFIX}] Comprehensive series search`);
    const [personalFiles, ...scraperResults] = await Promise.all([
      searchPersonalFiles(apiKey, searchKey, 0.3),
      ...scraperPromises
    ]);
    console.timeEnd(`[${LOG_PREFIX}] Comprehensive series search`);

    let combinedResults = combineAndMarkResults(personalFiles, scraperResults, specificSearchKey);
    let externalTorrents = combinedResults.filter(t => !t.isPersonal);

    if (cinemetaDetails?.name) {
      const before = externalTorrents.length;
      externalTorrents = externalTorrents.filter(t => {
        const primary = (t.Title || t.name || t.searchableName || t.title || '').toString();
        const path = (t.path || '').toString();
        if (matchesSeriesTitle(primary, cinemetaDetails.name)) return true;
        if (primary && matchesSeriesTitle('/' + primary, cinemetaDetails.name)) return true;
        if (path && matchesSeriesTitle(path, cinemetaDetails.name)) return true;
        if (path && matchesSeriesTitle('/' + path, cinemetaDetails.name)) return true;
        return true;
      });
      const afterFranchise = externalTorrents.length;
      if (before !== afterFranchise) {
        console.log(`[${LOG_PREFIX}] Franchise filter "${cinemetaDetails.name}": ${before} -> ${afterFranchise}`);
      }

      if (type === 'series' && episodeInfo) {
        const seasonNum = episodeInfo.season;
        const episodeNum = episodeInfo.episode;
        const beforeEpisode = externalTorrents.length;

        const isLikelyEpisode = (t) => {
          const rawCandidates = [
            (t.Title || t.name || t.searchableName || t.title || '').toString(),
            (t.path || '').toString()
          ].filter(Boolean);

          const variants = [];
          for (const r of rawCandidates) {
            variants.push(r);
            variants.push(r.replace(/^\/+/, ''));
            variants.push('/' + r.replace(/^\/+/, ''));
          }

          for (const v of variants) {
            if (hasEpisodeMarker(v, seasonNum, episodeNum)) return true;
            try {
              const parsed = PTT.parse(v || '') || {};
              if (parsed.season && parsed.episode) {
                if (Number(parsed.season) === Number(seasonNum) && Number(parsed.episode) === Number(episodeNum)) return true;
              }
            } catch {}
            const paddedSeason = String(seasonNum).padStart(2,'0');
            if (new RegExp(`\\b(season|s|saison)\\s*${paddedSeason}\\b`, 'i').test(v)) return true;
            if (new RegExp(`\\bs${paddedSeason}\\b`, 'i').test(v)) return true;
            const ms = v.match(/seasons?\s*(\d+)\s*[,-]?\s*(\d+)|s(\d+)[-]?s(\d+)/i);
            if (ms) {
              const startSeason = parseInt(ms[1] || ms[3], 10);
              const endSeason   = parseInt(ms[2] || ms[4], 10);
              if (!isNaN(startSeason) && !isNaN(endSeason) && seasonNum >= startSeason && seasonNum <= endSeason) return true;
            }
          }
          return false;
        };

        externalTorrents = externalTorrents.filter(t => isLikelyEpisode(t));
        const afterEpisode = externalTorrents.length;
        console.log(`[${LOG_PREFIX}] Episode filtering S${String(seasonNum).padStart(2,'0')}E${String(episodeNum).padStart(2,'0')}: ${beforeEpisode} -> ${afterEpisode}`);
      }
    }

    if (type === 'movie' && cinemetaDetails.year) {
      const originalCount = externalTorrents.length;
      externalTorrents = externalTorrents.filter(t => filterByYear(t, cinemetaDetails, LOG_PREFIX));
      console.log(`[${LOG_PREFIX}] Year filter (${cinemetaDetails.year}): ${originalCount} -> ${externalTorrents.length}`);
    }

    const cachedResults = await checkAndProcessCache(apiKey, externalTorrents, episodeInfo);
    let combined = [...personalFiles, ...cachedResults];

    // Map to unified stream objects & sort
    let allResults = combined.map(t => formatCachedResult(t, t.isCached));
    allResults.sort((a, b) => {
      const resA = getResolutionFromName(a.name || a.Title);
      const resB = getResolutionFromName(b.name || b.Title);
      const rankA = resolutionOrder[resA] || 0;
      const rankB = resolutionOrder[resB] || 0;
      if (rankA !== rankB) return rankB - rankA;
      return (b.size || 0) - (a.size || 0);
    });

    console.log(`[${LOG_PREFIX}] Comprehensive total: ${allResults.length} streams (sorted)`);
    return allResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Comprehensive TorBox search failed: ${error.message}`);
    return [];
  } finally {
    if (abortController === globalAbortController) globalAbortController = null;
  }
}

// ---------------------------------------------------------------------------------
// Personal files & unrestrict (TorBox)
// ---------------------------------------------------------------------------------
async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
  const api = tb(apiKey);
  try {
    const [existingTorrents, existingDownloads] = await Promise.all([
      getAllTorrents(api).catch(() => []),
      getAllWebDownloads(api).catch(() => [])
    ]);
    console.log(`[${LOG_PREFIX}] Found ${existingTorrents.length} torrents, ${existingDownloads.length} web downloads`);

    const relevantTorrents = filterFilesByKeywordsTB(existingTorrents, searchKey);
    const relevantDownloads = filterFilesByKeywordsTB(existingDownloads, searchKey);

    if (relevantTorrents.length === 0 && relevantDownloads.length === 0) return [];

    const torrentFiles = await processTorrents(api, relevantTorrents.slice(0, 5));
    const allFiles = [
      ...torrentFiles,
      ...relevantDownloads.map(d => formatDownloadFileTB(d))
    ];
    if (allFiles.length === 0) return [];

    const uniqueFiles = [...new Map(allFiles.map(file => [file.url, file])).values()];
    const enhanced = uniqueFiles.map(file => ({
      ...file,
      source: 'torbox',
      isPersonal: true,
      info: PTT.parse(file.name)
    }));

    const fuse = new Fuse(enhanced, { keys: ['info.title', 'name'], threshold, minMatchCharLength: 2 });
    return fuse.search(searchKey).map(r => r.item);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Personal TB files error: ${error.message}`);
    return [];
  }
}

async function resolveStreamUrl(apiKey, encodedUrl, clientIp) {
  try {
    let decodedUrl = decodeURIComponent(encodedUrl).trim();
    console.log(`[${LOG_PREFIX}] Resolving TB stream URL: ${decodedUrl.substring(0, 100)}...`);

    if (decodedUrl.startsWith('torbox:')) {
      const parts = decodedUrl.split(':');
      const torrentId = parts[1];
      const fileId = parts[2];
      return await unrestrictUrl(apiKey, `torbox:${torrentId}:${fileId}`, clientIp);
    }

    if (decodedUrl.includes('magnet:') && decodedUrl.includes('urn:btih:')) {
      const ref = await resolveMagnetUrl(apiKey, decodedUrl, clientIp);
      if (!ref) return null;
      if (ref.startsWith('http')) return ref;
      return await unrestrictUrl(apiKey, ref, clientIp);
    }

    // Fallback: if it’s a direct http(s) URL, TorBox “webdl” could be used; for now, return as-is.
    if (/^https?:\/\//i.test(decodedUrl)) return decodedUrl;

    return null;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error in resolveStreamUrl: ${error.message}`);
    console.error(`[${LOG_PREFIX}] Stack: ${error.stack}`);
    return null;
  }
}

async function resolveMagnetUrl(apiKey, magnetUrl, userIp) {
  const api = tb(apiKey);
  try {
    const m = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!m?.[1]) return null;
    const hash = m[1].toLowerCase();

    // Try to locate an existing finished torrent first
    try {
      const list = await api.torrents.getMyList(API_VERSION, { offset: 0, limit: 1000 }).then(r => r.data?.data || []);
      const hit = list.find(t => t.hash?.toLowerCase() === hash && t.download_present);
      if (hit) {
        const info = await getTorrentInfo(api, hit.id);
        const videos = (info.files || []).filter(f => isValidVideo(f.short_name || f.path, f.size || f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
        if (videos.length > 0) {
          videos.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0));
          return `torbox:${hit.id}:${videos[0].id}`;
        }
      }
    } catch {}

    // Create torrent (synchronous) and wait until data is present
    const created = await api.torrents.createTorrent(API_VERSION, { magnet: magnetUrl }).then(r => r?.data?.data);
    const torrentId = created?.id || created?.torrentId || created?.torrent_id;
    if (!torrentId) return null;

    // Poll info for links/files to appear
    let info = await getTorrentInfo(api, torrentId);
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts && !info?.download_present) {
      await delay(500);
      info = await getTorrentInfo(api, torrentId);
      attempts++;
    }
    if (!info) return null;

    // Find best video file
    const files = (info.files || []).map(f => ({
      id: f.id,
      path: f.path || f.short_name,
      bytes: f.size || f.bytes
    }));
    const videos = files.filter(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (videos.length === 0) {
      // fallback: pick biggest file
      files.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
      if (files.length === 0) return null;
      return `torbox:${torrentId}:${files[0].id}`;
    }
    videos.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    return `torbox:${torrentId}:${videos[0].id}`;
  } catch (err) {
    console.error(`[${LOG_PREFIX}] resolveMagnetUrl error: ${err.message}`);
    return null;
  }
}

async function unrestrictUrl(apiKey, hostRef, userIp) {
  const api = tb(apiKey);
  try {
    if (!hostRef || hostRef === 'undefined') return null;

    if (hostRef.startsWith('torbox:')) {
      const [, torrentId, fileId] = hostRef.split(':');
      if (!torrentId || !fileId) return null;

      const res = await api.torrents.requestDownload(API_VERSION, {
        token: apiKey,
        torrentId,
        fileId,
        userIp
      }).then(r => r?.data);

      if (res?.success && res?.data?.download) {
        return res.data.download;
      }
      // Some TorBox deployments return { url } or { link } instead:
      const link = res?.data?.url || res?.data?.link;
      return link || null;
    }

    if (/^https?:\/\//i.test(hostRef)) {
      // If needed, we could call webdl endpoints here, but returning direct URL is fine.
      return hostRef;
    }

    if (hostRef.includes('magnet:')) {
      const ref = await resolveMagnetUrl(apiKey, hostRef, userIp);
      if (!ref) return null;
      if (ref.startsWith('http')) return ref;
      return await unrestrictUrl(apiKey, ref, userIp);
    }

    return null;
  } catch (err) {
    console.error(`[${LOG_PREFIX}] unrestrictUrl TB error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------
// TorBox lists & info
// ---------------------------------------------------------------------------------
async function getAllTorrents(api) {
  const all = [];
  try {
    let offset = 0;
    const limit = 1000;
    while (true) {
      const page = await api.torrents.getMyList(API_VERSION, { offset, limit }).then(r => r?.data?.data || []);
      if (!page.length) break;
      // keep only finished/present
      const finished = page.filter(t => t.download_present);
      all.push(...finished);
      if (page.length < limit) break;
      offset += limit;
      if (offset > 5000) break; // safety
    }
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Error fetching TB torrents: ${err.message}`);
  }
  return all;
}

async function getAllWebDownloads(/* api */) {
  // TorBox “webdl” search can be added later; return empty to match RD symmetry
  return [];
}

async function getTorrentInfo(api, torrentId) {
  try {
    // Prefer GET; TorBox also has POST variant
    const info = await api.torrents.getTorrentInfo(API_VERSION, { id: torrentId }).then(r => r?.data?.data || r?.data);
    return normalizeTorrentInfo(info);
  } catch (err) {
    console.warn(`[${LOG_PREFIX}] getTorrentInfo error: ${err.message}`);
    return null;
  }
}

function normalizeTorrentInfo(info) {
  if (!info) return null;
  // Normalize fields commonly seen across TB responses
  const filesRaw = info.files || info.file_list || [];
  const files = filesRaw.map(f => ({
    id: f.id || f.file_id,
    path: f.path || f.short_name || f.name,
    size: f.size || f.bytes || f.length
  }));
  return {
    id: info.id || info.torrent_id,
    name: info.name || info.filename,
    hash: (info.hash || '').toLowerCase(),
    bytes: info.size || info.bytes,
    added: info.created_at || info.added,
    download_present: !!info.download_present || !!info.finished || !!info.download_finished,
    files
  };
}

async function processTorrents(api, torrents) {
  const allVideoFiles = [];
  for (const t of torrents.slice(0, 3)) {
    try {
      const info = await getTorrentInfo(api, t.id);
      if (!info?.files) continue;
      const videoFiles = info.files.filter(f => isValidVideo(f.path, f.size, 50 * 1024 * 1024, LOG_PREFIX));
      for (const file of videoFiles) {
        const fileReference = `torbox:${info.id}:${file.id}`;
        allVideoFiles.push({
          id: `${info.id}:${file.id}`,
          name: file.path,
          info: PTT.parse(file.path),
          size: file.size,
          hash: info.hash,
          url: fileReference,
          source: 'torbox',
          isPersonal: true,
          tracker: 'Personal',
          torrentId: info.id,
          fileId: file.id
        });
      }
    } catch (err) {
      console.error(`[${LOG_PREFIX}] Error processing TB torrent ${t.id}: ${err.message}`);
    }
  }
  return allVideoFiles;
}

function formatDownloadFileTB(download) {
  return {
    id: download.id,
    name: download.filename || download.name,
    info: PTT.parse(download.filename || download.name || ''),
    size: download.size || download.filesize,
    url: download.download || download.url,
    source: 'torbox',
    isPersonal: true,
    tracker: 'Personal'
  };
}

function filterFilesByKeywordsTB(files, searchKey) {
  const keywords = (searchKey || '').toLowerCase().split(' ').filter(w => w.length > 2);
  return files.filter(file => {
    const fileName = (file.filename || file.name || '').toLowerCase();
    return keywords.some(k => fileName.includes(k));
  });
}

// ---------------------------------------------------------------------------------
// Cache-check & processing for external scrapes (no creation needed)
// ---------------------------------------------------------------------------------
async function checkAndProcessCache(apiKey, externalTorrents, episodeInfo = null) {
  await loadHashCache();
  const api = tb(apiKey);

  // Handler for processAndFilterTorrents
  const handler = {
    getIdentifier: () => LOG_PREFIX,
    checkCachedHashes: async (hashes) => {
      // Prefer local file cache first
      const cached = new Set();
      hashes.forEach(h => { if (isHashInCache(h)) cached.add(h); });
      // For the rest, call TorBox checkcached
      const remaining = hashes.filter(h => !cached.has(h));
      const tbCached = await torboxCheckCached(api, remaining);
      tbCached.forEach(h => { addHashToCache(h); cached.add(h); });
      return cached;
    },
    // For TorBox we do NOT add torrents for cache checking. Use network check for singletons too.
    liveCheckHash: async (hash) => {
      try {
        const res = await torboxCheckCached(api, [hash]);
        if (res.has(hash.toLowerCase())) { addHashToCache(hash); return true; }
      } catch {}
      return false;
    },
    batchCheckSeasonPacks: async (_hashes, _s, _e) => {
      // Optional: TorBox doesn’t expose per-file season selection at cache-check time.
      return new Map();
    },
    cleanup: async () => {
      await saveHashCache();
    }
  };

  let cachedResults = await processAndFilterTorrents(externalTorrents, handler, episodeInfo);

  // include a few top non-cached magnets for fallback
  if (externalTorrents.length > 0) {
    const extras = externalTorrents
      .filter(t => !t.isCached)
      .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
      .slice(0, 5);
    cachedResults = [...cachedResults, ...extras];
  }
  return cachedResults;
}

// ---------------------------------------------------------------------------------
// Catalog & details
// ---------------------------------------------------------------------------------
async function listTorrents(apiKey, skip = 0) {
  const api = tb(apiKey);
  const page = Math.floor(skip / 50) + 1; // kept for parity; TorBox uses offset/limit
  try {
    const offset = (page - 1) * 1000;
    const response = await api.torrents.getMyList(API_VERSION, { offset, limit: 1000 });
    const torrents = response?.data?.data || [];
    const metas = torrents.map(t => ({
      id: 'torbox:' + t.id,
      name: t.name || t.filename || 'Unknown',
      type: 'other',
      poster: null,
      background: null
    }));
    console.log(`[${LOG_PREFIX}] Returning ${metas.length} TB catalog items`);
    return metas;
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Catalog TB error: ${err.message}`);
    return [];
  }
}

async function getTorrentDetails(apiKey, id) {
  const api = tb(apiKey);
  const torrentId = id.includes(':') ? id.split(':')[1] : id;
  try {
    const info = await getTorrentInfo(api, torrentId);
    return toTorrentDetails(apiKey, info);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Torrent details TB error: ${error.message}`);
    return {
      source: 'torbox',
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

function toTorrentDetails(apiKey, item) {
  if (!item || !item.files) {
    return {
      source: 'torbox',
      id: item?.id || 'unknown',
      name: item?.name || 'Unknown Torrent',
      type: 'other',
      hash: item?.hash || null,
      info: PTT.parse(item?.name || '') || { title: 'Unknown' },
      size: item?.bytes || 0,
      created: new Date(item?.added || item?.created_at || Date.now()),
      videos: []
    };
  }
  const videos = item.files
    .filter(file => isValidVideo(file.path, file.size, 50 * 1024 * 1024, LOG_PREFIX))
    .map(file => {
      return {
        id: `${item.id}:${file.id}`,
        name: file.path,
        url: `torbox:${item.id}:${file.id}`,
        size: file.size,
        created: new Date(item.added || item.created_at || Date.now()),
        info: PTT.parse(file.path)
      };
    });

  return {
    source: 'torbox',
    id: item.id,
    name: item.name,
    type: 'other',
    hash: item.hash,
    info: PTT.parse(item.name),
    size: item.bytes,
    created: new Date(item.added || item.created_at || Date.now()),
    videos: videos || []
  };
}

// ---------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------
export default {
  listTorrents,
  searchTorrents,
  getTorrentDetails,
  unrestrictUrl,
  searchTorboxTorrents,
  resolveStreamUrl
};
