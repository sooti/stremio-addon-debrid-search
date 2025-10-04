import Cinemeta from './util/cinemeta.js';
import DebridLink from './debrid-link.js';
import RealDebrid from './real-debrid.js';
import RealDebridClient from 'real-debrid-api';
import AllDebrid from './all-debrid.js';
import Premiumize from './premiumize.js';
import OffCloud from './offcloud.js';
import TorBox from './torbox.js';
import DebriderApp from './debrider.app.js';
import * as MongoCache from './common/mongo-cache.js';
import { BadRequestError } from './util/error-codes.js';
import { FILE_TYPES } from './util/file-types.js';
import { filterSeason, filterEpisode, filterYear, matchesSeriesTitle, hasEpisodeMarker } from './util/filter-torrents.js';
import { getResolutionFromName, formatSize, getCodec, resolutionOrder } from './common/torrent-utils.js';
import PTT from './util/parse-torrent-title.js';

const ADDON_HOST = process.env.ADDON_URL;

export const STREAM_NAME_MAP = {
  debridlink: "[DL+] Sootio",
  realdebrid: "[RD+] Sootio",
  alldebrid: "[AD+] Sootio",
  premiumize: "[PM+] Sootio",
  torbox: "[TB+] Sootio",
  offcloud: "[OC+] Sootio",
  debriderapp: "[DBA+] Sootio"
};

const LANG_FLAGS = {
  en: '🇬🇧', fr: '🇫🇷', es: '🇪🇸', de: '🇩🇪', ru: '🇷🇺', it: '🇮🇹', pt: '🇵🇹',
  pl: '🇵🇱', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', ar: '🇦🇪', hi: '🇮🇳', nl: '🇳🇱',
  sv: '🇸🇪', no: '🇳🇴', da: '🇩🇰', fi: '🇫🇮', tr: '🇹🇷', he: '🇮🇱', id: '🇮🇩',
  cs: '🇨🇿', hu: '🇭🇺', ro: '🇷🇴', el: '🇬🇷', th: '🇹🇭'
};
function renderLangFlags(langs) {
  if (!Array.isArray(langs) || langs.length === 0) return '';
  const unique = Array.from(new Set(langs.map(x => String(x).toLowerCase())));
  const flags = unique.map(code => LANG_FLAGS[code]).filter(Boolean);
  return flags.length ? ` ${flags.join('')}` : '';
}

function isValidUrl(url) {
  return url &&
    typeof url === 'string' &&
    url !== 'undefined' &&
    url !== 'null' &&
    url.length > 0 &&
    (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:') || url.startsWith('/resolve/'));
}

function isVideo(filename) {
  if (!filename || typeof filename !== 'string') return false;
  const exts = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.mpg','.mpeg','.3gp','.ogv','.ts','.m2ts'];
  const i = filename.toLowerCase().lastIndexOf('.');
  if (i < 0) return false;
  return exts.includes(filename.toLowerCase().substring(i));
}

function sortTorrents(a, b) {
  const nameA = a.name || a.title || '';
  const nameB = b.name || b.title || '';
  const resA = getResolutionFromName(nameA);
  const resB = getResolutionFromName(nameB);
  const rankA = resolutionOrder[resA] || 0;
  const rankB = resolutionOrder[resB] || 0;
  if (rankA !== rankB) return rankB - rankA;
  const sizeA = a.size || 0;
  const sizeB = b.size || 0;
  return sizeB - sizeA;
}

const SCRAPER_CACHE_TTL_SERIES_MIN = process.env.SCRAPER_CACHE_TTL_SERIES_MIN || 60;
const SCRAPER_CACHE_TTL_MOVIE_MIN = process.env.SCRAPER_CACHE_TTL_MOVIE_MIN || 360;

// Caches search results from debrid providers to speed up subsequent requests.
// When a search is performed for a movie or series, the results are stored in MongoDB.
// If the same item is requested again before the cache expires, the results are served from the cache,
// avoiding the need to re-run the search.
// The cache key is based on the provider, media type, ID, and selected languages.
// Movies are cached for 6 hours, and series for 1 hour.
async function getCachedTorrents(provider, type, id, config, searchFn) {
  if (!MongoCache.isEnabled()) {
    return searchFn();
  }

  const collection = await MongoCache.getCollection();
  if (!collection) {
    return searchFn();
  }

  const langKey = (config.Languages || []).join(',');
  const providerKey = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  const cacheKey = `${providerKey}-search:${type}:${id}:${langKey}`;
  const cached = await collection.findOne({ _id: cacheKey });

  if (cached) {
    console.log(`[CACHE] HIT: ${cacheKey}`);
    return cached.data;
  }
  console.log(`[CACHE] MISS: ${cacheKey}`);

  const results = await searchFn();

  if (results && results.length > 0) {
    // Filter out personal cloud files and any items that are already fully-formed stream objects.
    // This prevents storing user-specific data and URLs in the shared cache.
    const cacheableData = results.filter(item => {
      if (!item) {
        return true; // Retain null/empty entries for cache consistency.
      }

      // Exclude personal cloud files.
      if (item.isPersonal) {
        return false;
      }

      // Exclude items with resolver or direct URLs. Magnet links are not filtered.
      if (typeof item.url === 'string' && item.url) {
        return !(item.url.startsWith('http') || item.url.startsWith('/resolve/'));
      }

      return true;
    });

    if (cacheableData.length > 0) {
      const ttlMinutes = type === 'series' ? SCRAPER_CACHE_TTL_SERIES_MIN : SCRAPER_CACHE_TTL_MOVIE_MIN;
      const cacheDoc = {
        _id: cacheKey,
        data: cacheableData,
        expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000)
      };
      try {
        await collection.updateOne({ _id: cacheKey }, { $set: cacheDoc }, { upsert: true });
        console.log(`[CACHE] STORED: ${cacheKey} (TTL: ${ttlMinutes}m)`);
      } catch (e) {
        console.error(`[CACHE] FAILED to store ${cacheKey}:`, e.message);
      }
    }
  }

  return results;
}

async function getMovieStreams(config, type, id) {
  const cinemetaDetails = await Cinemeta.getMeta(type, id);
  const searchKey = cinemetaDetails.name;
  let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;
  const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

  if (debridProvider == "DebridLink") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebridLink.searchTorrents(apiKey, searchKey, 0.1));
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterYear(t, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list.sort(sortTorrents).map(t => toStream(t, type, config)).filter(Boolean));
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config));
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = hasEpisodeMarker(name, 1, 1); // Check for S01E01 to guess if it's a series
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config));
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = hasEpisodeMarker(name, 1, 1); // Check for S01E01 to guess if it's a series
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => Premiumize.search(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toStream(td, type, config))
        .filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => OffCloud.searchOffcloudTorrents(apiKey, type, id));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, config))
        .filter(Boolean);
    }
  } else if (debridProvider == "TorBox") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => TorBox.searchTorboxTorrents(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, config))
        .filter(Boolean);
    }
  } else if (debridProvider == "DebriderApp") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toDebriderStream(td, type, config))
        .filter(Boolean);
    }
  } else {
    return Promise.reject(BadRequestError);
  }
  return [];
}

async function getSeriesStreams(config, type, id) {
  const [imdbId, season, episode] = id.split(":");
  const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
  const searchKey = cinemetaDetails.name;
  let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;
  const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

  if (debridProvider == "DebridLink") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebridLink.searchTorrents(apiKey, searchKey, 0.1));
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterSeason(t, season, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list
            .sort(sortTorrents)
            .filter(td => filterEpisode(td, season, episode, cinemetaDetails))
            .map(td => toStream(td, type, config))
            .filter(Boolean)
          );
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => RealDebrid.searchRealDebridTorrents(apiKey, type, id, config));
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await getCachedTorrents(debridProvider, type, id, config, () => AllDebrid.searchAllDebridTorrents(apiKey, type, id, config));
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => Premiumize.search(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents
        .sort(sortTorrents)
        .map(td => toStream(td, type, config, { season, episode }))
        .filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => OffCloud.searchOffcloudTorrents(apiKey, type, id));
    if (torrents && torrents.length) {
      const bypass = torrents.filter(t => t.bypassFiltering === true);
//      if (bypass.length > 0) {
//        return bypass.sort(sortTorrents).map(td => toStream(td, type, config)).filter(Boolean);
//      }
      const episodeRegex = new RegExp(`s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`, 'i');
      const realEpisodes = torrents
        .filter(t => matchesSeriesTitle(t, cinemetaDetails.name))
        .filter(t => episodeRegex.test(t.name || t.title || ''));
      return realEpisodes.sort(sortTorrents).map(td => toStream(td, type, config)).filter(Boolean);
    }
  } else if (debridProvider == "TorBox") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => TorBox.searchTorboxTorrents(apiKey, type, id, config));
    if (torrents && torrents.length) {
      // Results are already pre-filtered at the scraping layer for series/episode.
      return torrents
        .sort(sortTorrents)
        .map(td => toStream(td, type, config))
        .filter(Boolean);
    }
  } else if (debridProvider == "DebriderApp") {
    const torrents = await getCachedTorrents(debridProvider, type, id, config, () => DebriderApp.search(apiKey, type, id, config));
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .map(td => toDebriderStream(td, type, config))
        .filter(Boolean);
    }
  } else {
    return Promise.reject(BadRequestError);
  }
  return [];
}

async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp) {
  const provider = debridProvider.toLowerCase();
  if (!isValidUrl(hostUrl)) {
    console.error(`[RESOLVER] Invalid URL provided: ${hostUrl}`);
    return null;
  }
  try {
    if (provider === "realdebrid") {
      if (hostUrl.startsWith('magnet:') || hostUrl.includes('||HINT||')) {
        const maxRetries = 10;
        const retryInterval = 5000;
        let episodeHint = null;
        if (hostUrl.includes('||HINT||')) {
          try {
            const parts = hostUrl.split('||HINT||');
            hostUrl = parts[0];
            episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
          } catch (_) { episodeHint = null; }
        }
        const RD = new RealDebridClient(debridApiKey);
        let torrentId = null;
        try {
          const addResponse = await RD.torrents.addMagnet(hostUrl);
          if (!addResponse?.data?.id) throw new Error("Failed to add magnet.");
          torrentId = addResponse.data.id;
          await RD.torrents.selectFiles(torrentId, 'all');

          let torrentInfo = null;
          for (let i = 0; i < maxRetries; i++) {
            torrentInfo = await RD.torrents.info(torrentId);
            const status = torrentInfo?.data?.status;
            if (status === 'downloaded' || status === 'finished') break;
            if (['magnet_error','error','virus','dead'].includes(status)) throw new Error(`Torrent failed: ${status}`);
            if (i === maxRetries - 1) throw new Error(`Torrent not ready after ${Math.ceil((maxRetries*retryInterval)/1000)}s`);
            await new Promise(r => setTimeout(r, retryInterval));
          }
          if (!torrentInfo?.data?.links?.length) throw new Error("No streamable links found.");
          const files = torrentInfo.data.files || [];
          const links = torrentInfo.data.links || [];
          const videoFiles = files.filter(f => f.selected);
          if (videoFiles.length === 0) throw new Error("No valid video files.");
          let chosen = null;
          if (episodeHint) {
            if (episodeHint.fileId != null) chosen = videoFiles.find(f => f.id === episodeHint.fileId) || null;
            if (!chosen && episodeHint.filePath) chosen = videoFiles.find(f => f.path === episodeHint.filePath) || null;
            if (!chosen && episodeHint.season && episodeHint.episode) {
              const s = String(episodeHint.season).padStart(2, '0');
              const e = String(episodeHint.episode).padStart(2, '0');
              const patterns = [
                new RegExp('[sS][\\W_]*' + s + '[\\W_]*[eE][\\W_]*' + e, 'i'),
                new RegExp('\\b' + Number(episodeHint.season) + '[\\W_]*x[\\W_]*' + e + '\\b', 'i'),
                new RegExp('\\b[eE]p?\\.?\\s*' + Number(episodeHint.episode) + '\\b', 'i'),
                new RegExp('episode\\s*' + Number(episodeHint.episode), 'i')
              ];
              chosen = videoFiles.find(f => patterns.some(p => p.test(f.path))) || null;
            }
          }
          if (!chosen) chosen = videoFiles.reduce((a, b) => (a.bytes > b.bytes ? a : b));
          const fileIndexInAll = files.findIndex(f => String(f.id) === String(chosen.id));
          if (fileIndexInAll === -1) throw new Error("Chosen file index not found.");
          const directUrl = links[fileIndexInAll];
          if (!directUrl || directUrl === 'undefined') throw new Error("Direct URL not found.");
          const unrestrictedUrl = await RealDebrid.unrestrictUrl(debridApiKey, directUrl, clientIp);
          if (!unrestrictedUrl) throw new Error("Unrestrict failed.");
          return unrestrictedUrl;
        } catch (error) {
          console.error(`[RESOLVER] RD magnet error: ${error.message}`);
          if (torrentId) { try { await RD.torrents.delete(torrentId); } catch (_) {} }
          return null;
        }
      } else {
        return RealDebrid.unrestrictUrl(debridApiKey, hostUrl, clientIp);
      }
    } else if (provider === "offcloud") {
      let inferredType = null;
      if (itemId && typeof itemId === 'string') {
        const parts = itemId.split(':');
        inferredType = parts.length > 1 ? 'series' : 'movie';
      }
      const resolvedUrl = await OffCloud.resolveStream(debridApiKey, hostUrl, inferredType, itemId);
      if (!resolvedUrl) throw new Error("OffCloud resolve returned empty.");
      return resolvedUrl;
    } else if (provider === "debridlink") {
      return hostUrl;
    } else if (provider === "premiumize") {
        if (hostUrl.startsWith('magnet:')) {
            let episodeHint = null;
            if (hostUrl.includes('||HINT||')) {
                try {
                    const parts = hostUrl.split('||HINT||');
                    hostUrl = parts[0];
                    episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
                } catch (_) { episodeHint = null; }
            }

            const directDownload = await Premiumize.getDirectDownloadLink(debridApiKey, hostUrl);
            if (!directDownload) {
                throw new Error("Failed to get direct download link from Premiumize.");
            }

            let videos = [];
            if (directDownload.content && Array.isArray(directDownload.content) && directDownload.content.length > 0) {
                // Multi-file torrent
                videos = directDownload.content
                    .filter(f => isVideo(f.path))
                    .map(f => ({ ...f, name: f.path })); // Normalize name for PTT
            } else if (directDownload.location && isVideo(directDownload.filename)) {
                // Single file torrent
                videos.push({
                    name: directDownload.filename,
                    size: directDownload.filesize,
                    stream_link: directDownload.stream_link || directDownload.location,
                    link: directDownload.location,
                });
            }

            if (videos.length === 0) {
                throw new Error("No video files found in direct download response.");
            }

            let chosenVideo = null;
            if (videos.length > 1 && episodeHint && episodeHint.season && episodeHint.episode) {
                const s = Number(episodeHint.season);
                const e = Number(episodeHint.episode);

                chosenVideo = videos.find(f => {
                    const pttInfo = PTT.parse(f.name);
                    return pttInfo.season === s && pttInfo.episode === e;
                });
            }

            if (!chosenVideo) {
                if (videos.length > 1) {
                    chosenVideo = videos.reduce((a, b) => (a.size > b.size ? a : b));
                } else {
                    chosenVideo = videos[0];
                }
            }

            const streamLink = chosenVideo.stream_link || chosenVideo.link;
            if (!streamLink) {
                throw new Error("No streamable link found for the chosen video file.");
            }

            return streamLink;
        }
        return hostUrl; // for non-magnet links
    } else if (provider === "alldebrid") {
      return AllDebrid.unrestrictUrl(debridApiKey, hostUrl);
    } else if (provider === "torbox") {
      return TorBox.unrestrictUrl(debridApiKey, itemId, hostUrl, clientIp);
    } else {
      throw new Error(`Unsupported debrid provider: ${debridProvider}`);
    }
  } catch (error) {
    console.error(`[RESOLVER] Critical error for ${debridProvider}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return null;
  }
}

function toStream(details, type, config, streamHint = {}) {
  let video = details;
  let icon = details.isPersonal ? '☁️' : '💾';
  let personalTag = details.isPersonal ? '[Cloud] ' : '';
  // Defer URL validity check until after we build the final streamUrl

  function shouldUseArchiveName(videoFileName, archiveName) {
    if (!videoFileName || !archiveName) return false;
    const meaningfulPatterns = [
      /s\d{2}e\d{2}/i,
      /1080p|720p|480p|2160p|4k/i,
      /bluray|web|hdtv|dvd|brrip/i,
      /x264|x265|h264|h265/i,
      /remaster|director|extended/i,
      /\d{4}/
    ];
    return !meaningfulPatterns.some(p => p.test(videoFileName));
  }

  let displayName = video.name || video.title || 'Unknown';
  const flagsSuffix = renderLangFlags(details.languages || details.langs);
  if (video.searchableName && shouldUseArchiveName(video.name, video.searchableName)) {
    const archiveName = video.searchableName.split(' ')[0] || video.name;
    displayName = archiveName;
  }

  let title = personalTag + displayName + flagsSuffix;
  if (type == 'series' && video.name && video.name !== displayName) title = title + '\n' + video.name;
  
  const pttInfo = PTT.parse(displayName);
  if (type === 'series' && streamHint.season && streamHint.episode && pttInfo.season && !pttInfo.episode) {
    const episodeInfo = `S${String(streamHint.season).padStart(2, '0')}E${String(streamHint.episode).padStart(2, '0')}`;
    title = `${personalTag}${displayName}\n${episodeInfo}${flagsSuffix}`;
  }

  const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
  title = title + '\n' + icon + ' ' + formatSize(video.size) + trackerInfo;

  let name = STREAM_NAME_MAP[details.source] || "[DS+] Sootio";
  const resolution = getResolutionFromName(video.name || video.title || '');
  const resolutionLabel = (resolution === '2160p') ? '4k' : resolution;
  name = name + '\n' + (resolutionLabel || 'N/A');

  const base = ADDON_HOST || '';
  let streamUrl;
  let urlToEncode = video.url;

  if (details.source === 'premiumize' && type === 'series' && streamHint.season && streamHint.episode) {
    const hint = Buffer.from(JSON.stringify({ season: streamHint.season, episode: streamHint.episode })).toString('base64');
    urlToEncode += '||HINT||' + hint;
  }

  if (details.source === 'realdebrid') {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
    const encodedUrl = encodeURIComponent(urlToEncode);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/realdebrid/${encodedApiKey}/${encodedUrl}`
      : urlToEncode;
  } else if (details.source === 'offcloud' && urlToEncode.includes('offcloud.com/cloud/download/')) {
    streamUrl = urlToEncode;
  } else {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || config.DebridLinkApiKey || '');
    const encodedUrl = encodeURIComponent(urlToEncode);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/${details.source}/${encodedApiKey}/${encodedUrl}`
      : urlToEncode;
  }

  if (!isValidUrl(streamUrl)) return null;

  const streamObj = {
    name,
    title,
    url: streamUrl,
    behaviorHints: {
      bingeGroup: `${details.source}|${details.hash || details.id || 'unknown'}`
    }
  };
  if (details.bypassFiltering) streamObj.bypassFiltering = true;
  return streamObj;
}

function toDebriderStream(details, type, config) {
    const resolution = getResolutionFromName(details.fileName || details.name);
    const resolutionLabel = (resolution === '2160p') ? '4k' : resolution;
    const icon = '💾';
    const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
    const flagsSuffix = renderLangFlags(details.Langs);

    let title = details.name;
    if (details.fileName) {
        title = `${details.name}/${details.fileName}`;
    }
    title = `${title}\n${icon} ${formatSize(details.size)}${trackerInfo}${flagsSuffix}`;
    const name = `${STREAM_NAME_MAP.debriderapp}\n${resolutionLabel}`;

    return {
        name: name,
        title: title,
        url: details.url,
        behaviorHints: {
            directLink: true,
            bingeGroup: details.bingeGroup || `debriderapp|${details.infoHash}`
        }
    };
}

export default { getMovieStreams, getSeriesStreams, resolveUrl, STREAM_NAME_MAP };
