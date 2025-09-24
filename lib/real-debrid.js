// real-debrid.js — full fixed file

import RealDebridClient from 'real-debrid-api';
import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';
import { promises as fs } from 'fs';
import RdLimiter from './util/rd-rate-limit.js';
const rdCall = (fn) => RdLimiter.schedule(fn);
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { matchesSeriesTitle, hasEpisodeMarker } from './util/seriesTitleMatcher.js';

const { isValidVideo, getResolutionFromName, resolutionOrder, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'RD';

// ---------------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------------
const personalHashCache = new Set();
let globalAbortController = null;

function createAbortController() {
  if (globalAbortController) globalAbortController.abort();
  globalAbortController = new AbortController();
  return globalAbortController;
}

// ---------------------------------------------------------------------------------
// File-based hash cache (RD-specific)
// ---------------------------------------------------------------------------------
let fileHashCache = new Map();

async function loadHashCache() {
  if (!config.RD_HASH_CACHE_ENABLED) return;
  try {
    await fs.access(config.RD_HASH_CACHE_PATH);
    const data = await fs.readFile(config.RD_HASH_CACHE_PATH, 'utf-8');
    const jsonCache = JSON.parse(data);
    fileHashCache = new Map(Object.entries(jsonCache));
    const expirationTime = Date.now() - (config.RD_HASH_CACHE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
    let prunedCount = 0;
    for (const [hash, timestamp] of fileHashCache.entries()) {
      if (timestamp < expirationTime) {
        fileHashCache.delete(hash);
        prunedCount++;
      }
    }
    console.log(`[FILE CACHE] Loaded ${fileHashCache.size} hashes. Pruned ${prunedCount} expired entries.`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[FILE CACHE] Cache file not found. A new one will be created.');
      fileHashCache = new Map();
    } else {
      console.error(`[FILE CACHE] Error loading hash cache: ${error.message}`);
    }
  }
}

async function saveHashCache() {
  if (!config.RD_HASH_CACHE_ENABLED) return;
  try {
    const cacheObject = Object.fromEntries(fileHashCache);
    await fs.writeFile(config.RD_HASH_CACHE_PATH, JSON.stringify(cacheObject, null, 2));
    console.log(`[FILE CACHE] Saved ${fileHashCache.size} hashes to disk.`);
  } catch (error) {
    console.error(`[FILE CACHE] Error saving hash cache: ${error.message}`);
  }
}
function addHashToCache(hash) {
  if (!config.RD_HASH_CACHE_ENABLED || !hash) return;
  fileHashCache.set(hash.toLowerCase(), Date.now());
}
function isHashInCache(hash) {
  if (!config.RD_HASH_CACHE_ENABLED || !hash) return false;
  return fileHashCache.has(hash.toLowerCase());
}

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------
async function buildPersonalHashCache(apiKey) {
  try {
    const RD = new RealDebridClient(apiKey);
    const existingTorrents = await getAllTorrents(RD);
    personalHashCache.clear();
    existingTorrents.forEach(t => { if (t.hash) personalHashCache.add(t.hash.toLowerCase()); });
    console.log(`[RD CACHE] Built personal hash cache with ${personalHashCache.size} torrents`);
    return personalHashCache;
  } catch (error) {
    console.error(`[RD CACHE] Error building personal cache: ${error.message}`);
    return personalHashCache;
  }
}

async function cleanupTemporaryTorrents(RD, torrentIds) {
  console.log(`[RD CLEANUP] 🧹 Starting background deletion of ${torrentIds.length} temporary torrents.`);
  for (const torrentId of torrentIds) {
    try {
      await RD.torrents.delete(torrentId);
      await delay(500);
    } catch (deleteError) {
      if (deleteError.response?.status === 429) {
        console.warn(`[RD CLEANUP] Rate limited. Pausing for 5 seconds...`);
        await delay(5000);
        await RD.torrents.delete(torrentId).catch(retryError => {
          console.error(`[RD CLEANUP] ❌ Failed to delete torrent ${torrentId} on retry: ${retryError.message}`);
        });
      } else {
        console.error(`[RD CLEANUP] ❌ Error deleting torrent ${torrentId}: ${deleteError.message}`);
      }
    }
  }
  console.log(`[RD CLEANUP] ✅ Finished background deletion task.`);
}

// Normalize strings for Fuse and title checks (strip apostrophes/quotes, collapse spaces)
function norm(s) {
  return (s || '')
    .replace(/[’'`]/g, '')    // strip apostrophes
    .replace(/\s+/g, ' ')     // collapse whitespace
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------------------------
// Formatting & combining results
// ---------------------------------------------------------------------------------
function formatCachedResult(torrent, isCached) {
  const title = torrent.Title || torrent.name || 'Unknown Title';
  let url;
  const episodeHint = torrent.episodeFileHint || null;

  if (torrent.isPersonal) {
    url = `magnet:?xt=urn:btih:${torrent.hash}`;
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
    info: PTT.parse(title) || { title: title },
    size: displaySize,
    seeders: torrent.Seeders || torrent.seeders || 0,
    url,
    source: 'realdebrid',
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

function combineAndMarkResults(apiKey, personalFiles, externalSources, specificSearchKey) {
  const sourceNames = ['Bitmagnet', 'Jackett', 'Torrentio', 'Zilean', 'Comet', 'StremThru', 'BT4G', 'TorrentGalaxy', 'TorrentDownload'];
  const enabledFlags = [config.BITMAGNET_ENABLED, config.JACKETT_ENABLED, config.TORRENTIO_ENABLED, config.ZILEAN_ENABLED, config.COMET_ENABLED, config.STREMTHRU_ENABLED, config.BT4G_ENABLED, config.TORRENT_GALAXY_ENABLED, config.TORRENT_DOWNLOAD_ENABLED];

  let sourceCounts = `Personal(${personalFiles.length})`;
  let sourceIndex = 0;
  for (let i = 0; i < enabledFlags.length; i++) {
    if (enabledFlags[i]) {
      sourceCounts += `, ${sourceNames[i]}(${externalSources[sourceIndex]?.length || 0})`;
      sourceIndex++;
    }
  }
  console.log(`[${LOG_PREFIX}] Sources found: ${sourceCounts}`);

  const markedPersonal = personalFiles.map(file => ({ ...file, source: 'realdebrid', isPersonal: true, tracker: 'Personal' }));
  const externalTorrents = [].concat(...externalSources);
  const uniqueExternalTorrents = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]));
  const personalHashes = new Set(personalFiles.map(f => f.hash).filter(Boolean));
  const newExternalTorrents = Array.from(uniqueExternalTorrents.values()).filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

  // -------- Sanity check with normalization & tolerant Fuse --------
  console.log(`[${LOG_PREFIX}] Performing sanity check on ${newExternalTorrents.length} external results for query: "${specificSearchKey}"`);

  const normalized = newExternalTorrents.map(t => {
    const base = (t.Title || t.name || '').toString();
    return { ...t, _normKey: norm(base) };
  });

  const fuse = new Fuse(normalized, {
    keys: ['_normKey'],
    threshold: 0.3,      // higher = more permissive (lets Its vs It's through)
    distance: 200,
    ignoreLocation: true, // don't penalize match position
    minMatchCharLength: 2
  });

  const saneResults = fuse.search(norm(specificSearchKey)).map(r => r.item);
  const rejectedCount = newExternalTorrents.length - saneResults.length;
  if (rejectedCount > 0) console.log(`[${LOG_PREFIX}] Sanity check REJECTED ${rejectedCount} irrelevant results.`);

  console.log(`[${LOG_PREFIX}] After all filtering: ${personalFiles.length} personal + ${saneResults.length} valid external`);
  return [...markedPersonal, ...saneResults];
}

// ---------------------------------------------------------------------------------
// Main search (generic)
// ---------------------------------------------------------------------------------
async function searchTorrents(apiKey, searchKey = null, threshold = 0.3) {
  console.log(`[${LOG_PREFIX}] Starting search for: "${searchKey}"`);
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
    if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(searchKey, signal, LOG_PREFIX));

    let scraperResults = [];
    try {
      scraperResults = await Promise.all(scraperPromises);
      console.log(`[${LOG_PREFIX}] External scrapers completed`);
    } catch (error) {
      console.log(`[${LOG_PREFIX}] Scraper error: ${error.message}`);
      scraperResults = [];
    }

    const combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, searchKey);
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
// Main search (RD torrents by meta id)
// ---------------------------------------------------------------------------------
async function searchRealDebridTorrents(apiKey, type, id) {
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

  console.log(`[${LOG_PREFIX}] Comprehensive search for: "${specificSearchKey}"`);
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
  if (config.TORRENT_DOWNLOAD_ENABLED) scraperPromises.push(scrapers.searchTorrentDownload(specificSearchKey, signal, LOG_PREFIX));

  try {
    console.time(`[${LOG_PREFIX}] Comprehensive series search`);
    const [personalFiles, ...scraperResults] = await Promise.all([
      searchPersonalFiles(apiKey, searchKey, 0.3),
      ...scraperPromises
    ]);
    console.timeEnd(`[${LOG_PREFIX}] Comprehensive series search`);

    let combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, specificSearchKey);
    let externalTorrents = combinedResults.filter(t => !t.isPersonal);

    // Franchise filtering: be permissive, rely on episode filtering for precision.
    if (cinemetaDetails?.name) {
      const before = externalTorrents.length;
      externalTorrents = externalTorrents.filter(t => {
        const primary = (t.Title || t.name || t.searchableName || t.title || '').toString();
        const path = (t.path || '').toString();
        // keep if any reasonable match; otherwise don't drop (episode filter will handle)
        if (matchesSeriesTitle(primary, cinemetaDetails.name)) return true;
        if (primary && matchesSeriesTitle('/' + primary, cinemetaDetails.name)) return true;
        if (path && matchesSeriesTitle(path, cinemetaDetails.name)) return true;
        if (path && matchesSeriesTitle('/' + path, cinemetaDetails.name)) return true;
        return true;
      });
      const afterFranchise = externalTorrents.length;
      if (before !== afterFranchise) {
        console.log(`[${LOG_PREFIX}] Filtered by franchise "${cinemetaDetails.name}": ${before} -> ${afterFranchise}`);
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

            // Allow season packs and relevant multi-season packs
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
      externalTorrents = externalTorrents.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
      console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}): ${originalCount} -> ${externalTorrents.length} external torrents remain.`);
    }

    await loadHashCache();
    const RD = new RealDebridClient(apiKey);
    const torrentIdsToDelete = new Set();

    const rdHandler = {
      getIdentifier: () => LOG_PREFIX,
      checkCachedHashes: async (hashes) => {
        const cached = new Set();
        hashes.forEach(hash => { if (isHashInCache(hash)) cached.add(hash); });
        return cached;
      },
      liveCheckHash: async (hash) => {
        let torrentId;
        try {
          const magnet = `magnet:?xt=urn:btih:${hash}`;
          const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet).catch(() => null));
          if (!addResponse?.data?.id) return false;
          torrentId = addResponse.data.id;
          torrentIdsToDelete.add(torrentId);
          await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
          const torrentInfo = await rdCall(() => RD.torrents.info(torrentId).catch(() => null));
          if (torrentInfo?.data?.status === 'downloaded' || torrentInfo?.data?.status === 'finished') {
            const hasVideo = (torrentInfo.data.files || []).some(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
            if (hasVideo) { addHashToCache(hash); return true; }
          }
        } catch {}
        return false;
      },
      batchCheckSeasonPacks: async (hashes, season, episode) => {
        const MAX_PACKS_TO_INSPECT = config.MAX_PACKS_TO_INSPECT || 3;
        const packResults = new Map();
        let inspectedCount = 0;

        console.log(`[${LOG_PREFIX} PACK INSPECT] Starting pack inspection for ${hashes.length} packs, max ${MAX_PACKS_TO_INSPECT} to inspect`);
        
        for (const hash of hashes) {
          if (inspectedCount >= MAX_PACKS_TO_INSPECT) {
            console.log(`[${LOG_PREFIX} PACK INSPECT] Reached max pack inspection limit (${MAX_PACKS_TO_INSPECT})`);
            break;
          }

          try {
            console.log(`[${LOG_PREFIX} PACK INSPECT] 🔍 Inspecting pack: ${hash.substring(0, 8)}... for S${season}E${episode}`);
            
            // Check if pack is already in RD
            let torrentId;
            const torrentsResponse = await rdCall(() => RD.torrents.get(0, 1, 100));
            const existing = torrentsResponse.data || [];
            const existingTorrent = existing.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase());
            
            if (existingTorrent) {
              torrentId = existingTorrent.id;
              console.log(`[${LOG_PREFIX} PACK INSPECT] 📦 Pack already in RD account: ${torrentId}`);
            } else {
              // Add pack to RD for inspection
              const magnet = `magnet:?xt=urn:btih:${hash}`;
              const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet));
              if (!addResponse?.data?.id) {
                console.log(`[${LOG_PREFIX} PACK INSPECT] ❌ Failed to add pack to RD: ${hash}`);
                continue;
              }
              torrentId = addResponse.data.id;
              torrentIdsToDelete.add(torrentId);
              console.log(`[${LOG_PREFIX} PACK INSPECT] ➕ Added pack to RD: ${torrentId}`);
              
              // Select all files and wait for processing
              await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
              
              // Wait for torrent to be processed
              let attempts = 0;
              let info;
              while (attempts < 10) {
                await delay(100);
                info = await rdCall(() => RD.torrents.info(torrentId).catch(() => null));
                if (info?.data?.status === 'downloaded' || info?.data?.status === 'finished') break;
                attempts++;
              }
            }

            // Get pack info
            const info = await rdCall(() => RD.torrents.info(torrentId));
            if (!info?.data?.files) {
              console.log(`[${LOG_PREFIX} PACK INSPECT] ❌ No files found in pack: ${torrentId}`);
              continue;
            }

            console.log(`[${LOG_PREFIX} PACK INSPECT] 📁 Pack contains ${info.data.files.length} files`);

            // Find matching episode files
            const matchingFiles = [];
            for (const file of info.data.files) {
              if (!isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX)) continue;
              
              const parsed = PTT.parse(file.path) || {};
              const fileSeason = parsed.season;
              const fileEpisode = parsed.episode;
              
              if (fileSeason === season && fileEpisode === episode) {
                console.log(`[${LOG_PREFIX} PACK INSPECT] ✅ Found matching file: ${file.path} (${(file.bytes / 1024 / 1024).toFixed(1)}MB)`);
                matchingFiles.push({
                  ...file,
                  fileIndex: info.data.files.findIndex(f => f.id === file.id),
                  parsedInfo: parsed
                });
              }
            }

            if (matchingFiles.length > 0) {
              // Sort by quality/size and take the best one
              matchingFiles.sort((a, b) => b.bytes - a.bytes);
              const bestFile = matchingFiles[0];
              
              const episodeResult = {
                InfoHash: hash,
                Title: info.data.filename,
                Size: bestFile.bytes,
                Seeders: 0, // Pack seeders not relevant for individual files
                Tracker: 'Pack Inspection',
                episodeFileHint: {
                  filePath: bestFile.path,
                  fileBytes: bestFile.bytes,
                  torrentId: torrentId,
                  fileId: bestFile.id
                },
                isCached: true,
                isFromPack: true,
                packHash: hash
              };

              packResults.set(hash, [episodeResult]);
              inspectedCount++;
              
              console.log(`[${LOG_PREFIX} PACK INSPECT] 🎯 Selected best file from pack: ${bestFile.path}`);
              console.log(`[${LOG_PREFIX} PACK INSPECT] 📊 Pack inspection successful: ${matchingFiles.length} files found for S${season}E${episode}`);
            } else {
              console.log(`[${LOG_PREFIX} PACK INSPECT] ❌ No matching files found in pack for S${season}E${episode}`);
            }

          } catch (error) {
            console.error(`[${LOG_PREFIX} PACK INSPECT] 💥 Error inspecting pack ${hash}: ${error.message}`);
          }
        }

        console.log(`[${LOG_PREFIX} PACK INSPECT] ✅ Completed pack inspection: ${inspectedCount} packs inspected, ${packResults.size} yielded results`);
        return packResults;
      },
      cleanup: async () => {
        await saveHashCache();
        if (torrentIdsToDelete.size > 0) cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete));
      }
    };

    let cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, episodeInfo);

    // Always include some non-cached magnets too (top by seeders)
    if (externalTorrents.length > 0) {
      const topNonCached = externalTorrents
        .filter(t => !t.isCached)
        .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
        .slice(0, 5);
      cachedResults = [...cachedResults, ...topNonCached];
    }

    const combined = [...personalFiles, ...cachedResults];
    let allResults = combined.map(torrent => formatCachedResult(torrent, torrent.isCached));

    allResults.sort((a, b) => {
      const resA = getResolutionFromName(a.name || a.Title);
      const resB = getResolutionFromName(b.name || b.Title);
      const rankA = resolutionOrder[resA] || 0;
      const rankB = resolutionOrder[resB] || 0;
      if (rankA !== rankB) return rankB - rankA;
      return (b.size || 0) - (a.size || 0);
    });

    console.log(allResults);
    console.log(`[${LOG_PREFIX}] Comprehensive total: ${allResults.length} streams (sorted)`);
    return allResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Comprehensive search failed: ${error.message}`);
    return [];
  } finally {
    if (abortController === globalAbortController) globalAbortController = null;
  }
}

// ---------------------------------------------------------------------------------
// Personal files & unrestrict
// ---------------------------------------------------------------------------------
async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
  const RD = new RealDebridClient(apiKey);
  try {
    const [existingTorrents, existingDownloads] = await Promise.all([
      getAllTorrents(RD).catch(() => []),
      getAllDownloads(RD).catch(() => [])
    ]);
    console.log(`[${LOG_PREFIX}] Found ${existingTorrents.length} torrents, ${existingDownloads.length} downloads`);
    const relevantTorrents = filterFilesByKeywords(existingTorrents, searchKey);
    const relevantDownloads = filterFilesByKeywords(existingDownloads, searchKey);
    if (relevantTorrents.length === 0 && relevantDownloads.length === 0) return [];

    const torrentFiles = await processTorrents(RD, relevantTorrents.slice(0, 5));
    const allFiles = [...torrentFiles, ...relevantDownloads.map(d => formatDownloadFile(d))];
    if (allFiles.length === 0) return [];

    const uniqueFiles = [...new Map(allFiles.map(file => [file.url, file])).values()];
    const enhancedFiles = uniqueFiles.map(file => ({ ...file, source: 'realdebrid', isPersonal: true, info: PTT.parse(file.name) }));
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
    console.log(`[${LOG_PREFIX}] Resolving stream URL: ${decodedUrl.substring(0, 100)}...`);

    if (decodedUrl.includes('magnet:') && decodedUrl.includes('urn:btih:')) {
      console.log(`[${LOG_PREFIX}] Detected magnet URL, processing through resolveMagnetUrl`);
      const result = await resolveMagnetUrl(apiKey, decodedUrl, clientIp);
      if (!result) return null;
      if (result.startsWith('http') && (/\.(mp4|mkv)\b/i.test(result) || result.includes('streaming'))) return result;
      if (result.startsWith('realdebrid:')) return await unrestrictUrl(apiKey, result, clientIp);
      if (result.includes('magnet:')) return await processMagnetAlternative(apiKey, result, clientIp);
      return result;
    } else {
      console.log(`[${LOG_PREFIX}] Processing as standard URL`);
      return await unrestrictUrl(apiKey, decodedUrl, clientIp);
    }
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error in resolveStreamUrl: ${error.message}`);
    console.error(`[${LOG_PREFIX}] Stack trace: ${error.stack}`);
    return null;
  }
}

async function processMagnetAlternative(apiKey, magnetUrl, clientIp) {
  const RD = new RealDebridClient(apiKey, { ip: clientIp });
  try {
    const hashMatch = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!hashMatch?.[1]) return null;
    const hash = hashMatch[1].toLowerCase();

    if (isHashInCache(hash)) {
      try {
        const torrentsResponse = await rdCall(() => RD.torrents.get(0, 1, 100));
        const torrents = torrentsResponse.data || [];
        const match = torrents.find(t => t.hash && t.hash.toLowerCase() === hash && ['downloaded', 'finished'].includes(t.status));
        if (match) {
          const info = await rdCall(() => RD.torrents.info(match.id));
          if (info?.data?.files && info.data.links) {
            const videos = info.data.files
              .map((f, i) => ({ ...f, link: info.data.links[i], i }))
              .filter(f => f.selected !== false && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX) && f.link && f.link !== 'undefined');
            if (videos.length > 0) {
              videos.sort((a, b) => b.bytes - a.bytes);
              return `realdebrid:${match.id}:${videos[0].id}`;
            }
          }
        }
      } catch {}
    }

    const addResponse = await rdCall(() => RD.torrents.addMagnet(magnetUrl));
    if (!addResponse?.data?.id) return null;
    const torrentId = addResponse.data.id;

    let info = await rdCall(() => RD.torrents.info(torrentId));
    let attempts = 0;
    const maxAttempts = 8;
    const ready = ['magnet_conversion', 'queued', 'downloading', 'downloaded', 'finished', 'uploading'];
    while (attempts < maxAttempts && info?.data && !ready.includes(info.data.status)) {
      try { info = await rdCall(() => RD.torrents.info(torrentId)); } catch {}
      attempts++;
    }
    if (!info?.data) return null;

    if (info.data.status !== 'downloaded' && info.data.status !== 'finished') {
      try {
        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
        info = await rdCall(() => RD.torrents.info(torrentId));
      } catch {}
    }

    if (!info.data.files || !info.data.links) return null;
    const withLinks = info.data.files
      .map((f, i) => ({ ...f, link: info.data.links[i], i }))
      .filter(f => (f.selected !== false) && f.link && f.link !== 'undefined');

    if (withLinks.length === 0) return null;
    let selected = withLinks.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (!selected) { withLinks.sort((a, b) => b.bytes - a.bytes); selected = withLinks[0]; }

    addHashToCache(hash);
    return `realdebrid:${torrentId}:${selected.id}`;
  } catch {
    return null;
  }
}

async function resolveMagnetUrl(apiKey, magnetUrl, clientIp) {
  const RD = new RealDebridClient(apiKey, { ip: clientIp });
  try {
    const m = magnetUrl.match(/urn:btih:([a-fA-F0-9]+)/);
    if (!m?.[1]) return null;
    const hash = m[1].toLowerCase();

    let torrentId = null;
    try {
      const torrentsResponse = await rdCall(() => RD.torrents.get(0, 1, 100));
      const existing = torrentsResponse.data || [];
      const hit = existing.find(t => t.hash && t.hash.toLowerCase() === hash && ['downloaded', 'finished', 'uploading'].includes(t.status));
      if (hit) torrentId = hit.id;
    } catch {}

    if (!torrentId) {
      const addResponse = await rdCall(() => RD.torrents.addMagnet(magnetUrl));
      if (!addResponse?.data?.id) return null;
      torrentId = addResponse.data.id;
    }

    let info = await rdCall(() => RD.torrents.info(torrentId));
    let attempts = 0;
    const maxAttempts = 10;
    const ready = ['magnet_conversion', 'queued', 'downloading', 'downloaded', 'finished', 'uploading'];
    while (attempts < maxAttempts && info?.data && !ready.includes(info.data.status)) {
      try { info = await rdCall(() => RD.torrents.info(torrentId)); } catch {}
      attempts++;
    }
    if (!info?.data) return null;

    if (info.data.status !== 'downloaded' && info.data.status !== 'finished') {
      try {
        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
        info = await rdCall(() => RD.torrents.info(torrentId));
      } catch {}
    }

    if (!info?.data?.files) return null;

    if (!info.data.links || !Array.isArray(info.data.links)) {
      let tries = 0;
      while (tries < 5 && (!info.data.links || !Array.isArray(info.data.links))) {
        await delay(200);
        try { info = await rdCall(() => RD.torrents.info(torrentId)); } catch {}
        tries++;
      }
      if (!info.data.links || !Array.isArray(info.data.links)) return null;
    }

    const filesWithLinks = info.data.files
      .map((file, index) => ({ ...file, link: info.data.links[index], index }))
      .filter(f => f.selected !== false && f.link && f.link !== 'undefined');

    if (filesWithLinks.length === 0) return null;
    let selected = filesWithLinks.find(f => isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
    if (!selected) { filesWithLinks.sort((a, b) => b.bytes - a.bytes); selected = filesWithLinks[0]; }

    addHashToCache(hash);
    return `realdebrid:${torrentId}:${selected.id}`;
  } catch {
    return null;
  }
}

async function unrestrictUrl(apiKey, hostUrl, clientIp) {
  const RD = new RealDebridClient(apiKey, { ip: clientIp });
  try {
    if (!hostUrl || hostUrl === 'undefined' || hostUrl.includes('undefined')) return null;

    if (hostUrl.startsWith('realdebrid:') && hostUrl.includes(':') && !hostUrl.includes('magnet:')) {
      const parts = hostUrl.split(':');
      const torrentId = parts[1];
      const fileId = parts[2];
      if (!torrentId || !fileId) return null;

      const info = await rdCall(() => RD.torrents.info(torrentId));
      if (!info?.data?.links) return null;

      const idx = info.data.files.findIndex(f => f.id.toString() === fileId.toString());
      if (idx === -1) return null;

      const directLink = info.data.links[idx];
      if (!directLink || directLink === 'undefined') return null;

      const response = await rdCall(() => RD.unrestrict.link(directLink));
      return response?.data?.download || null;
    } else if (!hostUrl.includes('magnet:') && !hostUrl.startsWith('realdebrid:')) {
      const response = await rdCall(() => RD.unrestrict.link(hostUrl));
      return response?.data?.download || null;
    } else if (hostUrl.includes('magnet:')) {
      const fileReference = await resolveMagnetUrl(apiKey, hostUrl, clientIp);
      if (!fileReference) return null;
      if (fileReference.startsWith('http')) return fileReference;
      return await unrestrictUrl(apiKey, fileReference, clientIp);
    } else {
      return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------
// RD lists & downloads
// ---------------------------------------------------------------------------------
async function getAllTorrents(RD) {
  const allTorrents = [];
  try {
    for (let page = 1; page <= 2; page++) {
      const response = await rdCall(() => RD.torrents.get(0, page, 100));
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

async function getAllDownloads(RD) {
  const allDownloads = [];
  try {
    const response = await rdCall(() => RD.downloads.get(0, 1, 100));
    const downloads = response.data || [];
    const nonTorrentDownloads = downloads.filter(d => d.host !== 'real-debrid.com');
    allDownloads.push(...nonTorrentDownloads);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error fetching downloads: ${error.message}`);
  }
  return allDownloads;
}

async function processTorrents(RD, torrents) {
  const allVideoFiles = [];
  for (const torrent of torrents.slice(0, 3)) {
    try {
      const info = await rdCall(() => RD.torrents.info(torrent.id));
      if (!info?.data?.files || !info.data.links) continue;
      const videoFiles = info.data.files
        .filter(file => file.selected && isValidVideo(file.path, file.bytes, 50 * 1024 * 1024, LOG_PREFIX));
      for (const file of videoFiles) {
        const fileIndex = info.data.files.findIndex(f => f.id === file.id);
        const fileReference = `realdebrid:${torrent.id}:${file.id}`;
        if (fileReference && fileReference !== 'undefined') {
          allVideoFiles.push({
            id: `${torrent.id}:${file.id}`,
            name: file.path,
            info: PTT.parse(file.path),
            size: file.bytes,
            hash: torrent.hash,
            url: fileReference,
            source: 'realdebrid',
            isPersonal: true,
            tracker: 'Personal',
            torrentId: torrent.id,
            fileId: file.id
          });
        }
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
    source: 'realdebrid',
    isPersonal: true,
    tracker: 'Personal'
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
  const RD = new RealDebridClient(apiKey);
  const page = Math.floor(skip / 50) + 1;
  try {
    const response = await rdCall(() => RD.torrents.get(0, page, 100));
    const metas = (response.data || []).map(torrent => ({
      id: 'realdebrid:' + torrent.id,
      name: torrent.filename || 'Unknown',
      type: 'other',
      poster: null,
      background: null
    }));
    console.log(`[${LOG_PREFIX}] Returning ${metas.length} catalog items`);
    return metas;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Catalog error: ${error.message}`);
    return [];
  }
}

async function getTorrentDetails(apiKey, id) {
  const RD = new RealDebridClient(apiKey);
  const torrentId = id.includes(':') ? id.split(':')[0] : id;
  try {
    const response = await rdCall(() => RD.torrents.info(torrentId));
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
  if (!searchKey) return [];
  try {
    const RD = new RealDebridClient(apiKey);
    const downloads = await getAllDownloads(RD);
    const relevant = filterFilesByKeywords(downloads, searchKey).map(d => formatDownloadFile(d));
    const fuse = new Fuse(relevant, { keys: ['info.title', 'name'], threshold });
    return fuse.search(searchKey).map(r => r.item);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Downloads search error: ${error.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------------
// Shim used by generic searchTorrents() path to cache-check external scrapes
// ---------------------------------------------------------------------------------
async function checkAndProcessCache(apiKey, externalTorrents) {
  await loadHashCache();
  const RD = new RealDebridClient(apiKey);
  const torrentIdsToDelete = new Set();

  const rdHandler = {
    getIdentifier: () => LOG_PREFIX,
    checkCachedHashes: async (hashes) => {
      const cached = new Set();
      hashes.forEach(hash => { if (isHashInCache(hash)) cached.add(hash); });
      return cached;
    },
    liveCheckHash: async (hash) => {
      let torrentId;
      try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        const addResponse = await rdCall(() => RD.torrents.addMagnet(magnet).catch(() => null));
        if (!addResponse?.data?.id) return false;
        torrentId = addResponse.data.id;
        torrentIdsToDelete.add(torrentId);
        await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));
        const torrentInfo = await rdCall(() => RD.torrents.info(torrentId).catch(() => null));
        if (torrentInfo?.data?.status === 'downloaded' || torrentInfo?.data?.status === 'finished') {
          const hasVideo = (torrentInfo.data.files || []).some(f => f.selected && isValidVideo(f.path, f.bytes, 50 * 1024 * 1024, LOG_PREFIX));
          if (hasVideo) { addHashToCache(hash); return true; }
        }
      } catch {}
      return false;
    },
    cleanup: async () => {
      await saveHashCache();
      if (torrentIdsToDelete.size > 0) cleanupTemporaryTorrents(RD, Array.from(torrentIdsToDelete));
    }
  };

  let cachedResults = await processAndFilterTorrents(externalTorrents, rdHandler, null);
  // include a few top non-cached magnets
  if (externalTorrents.length > 0) {
    const extras = externalTorrents.filter(t => !t.isCached).sort((a,b) => (b.seeders||0) - (a.seeders||0)).slice(0,5);
    cachedResults = [...cachedResults, ...extras];
  }
  return cachedResults;
}

// ---------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------
export default {
  listTorrents,
  searchTorrents,
  searchDownloads,
  getTorrentDetails,
  unrestrictUrl,
  searchRealDebridTorrents,
  buildPersonalHashCache,
  resolveStreamUrl
};
