import Cinemeta from './util/cinemeta.js';
import DebridLink from './debrid-link.js';
import RealDebrid from './real-debrid.js';
import RealDebridClient from 'real-debrid-api';
import AllDebrid from './all-debrid.js';
import Premiumize from './premiumize.js';
import OffCloud from './offcloud.js';
import TorBox from './torbox.js';
import { BadRequestError } from './util/error-codes.js';
import { FILE_TYPES } from './util/file-types.js';
import { matchesSeriesTitle, hasEpisodeMarker } from './util/seriesTitleMatcher.js';
import { getResolutionFromName, formatSize, getCodec } from './common/torrent-utils.js';

const ADDON_HOST = process.env.ADDON_URL;

export const STREAM_NAME_MAP = {
  debridlink: "[DL+] Sootio",
  realdebrid: "[RD+] Sootio",
  alldebrid: "[AD+] Sootio",
  premiumize: "[PM+] Sootio",
  torbox: "[TB+] Sootio",
  offcloud: "[OC+] Sootio"
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

const resolutionOrder = { '2160p':4,'1080p':3,'720p':2,'480p':1,'other':0 };

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

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function titleMatches(objTitle, metaName) {
  if (!objTitle || !metaName) return true;
  return normalizeTitle(objTitle) === normalizeTitle(metaName);
}

async function getMovieStreams(config, type, id) {
  const cinemetaDetails = await Cinemeta.getMeta(type, id);
  const searchKey = cinemetaDetails.name;
  let apiKey = config.DebridLinkApiKey ? config.DebridLinkApiKey : config.DebridApiKey;
  const debridProvider = config.DebridProvider || (config.DebridLinkApiKey ? "DebridLink" : null);

  if (debridProvider == "DebridLink") {
    const torrents = await DebridLink.searchTorrents(apiKey, searchKey, 0.1);
    if (torrents && torrents.length) {
      const torrentIds = torrents.filter(t => filterYear(t, cinemetaDetails)).map(t => t.id);
      if (torrentIds && torrentIds.length) {
        return DebridLink.getTorrentDetails(apiKey, torrentIds.join())
          .then(list => list.sort(sortTorrents).map(t => toStream(t, type, config)).filter(Boolean));
      }
    }
  } else if (debridProvider == "RealDebrid") {
    const allResults = await RealDebrid.searchRealDebridTorrents(apiKey, type, id, config);
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = /\b[sS]\d{1,2}\s*[._\- ]?\s*[eE]\d{1,3}\b/.test(name) || /\bseason\s*\d{1,2}\b/i.test(name) || /\bs\d{1,2}\b/i.test(name);
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await AllDebrid.searchAllDebridTorrents(apiKey, type, id, config);
    if (!allResults || allResults.length === 0) return [];
    // Enforce movie-only semantics: apply year sanity and drop any series-like items
    let filtered = allResults.filter(item => filterYear(item, cinemetaDetails));
    filtered = filtered.filter(item => {
      const name = item?.name || item?.title || '';
      const info = item?.info || {};
      const hasSeriesInfo = (info && (info.season != null || Array.isArray(info.seasons)));
      const looksSeries = /\b[sS]\d{1,2}\s*[._\- ]?\s*[eE]\d{1,3}\b/.test(name) || /\bseason\s*\d{1,2}\b/i.test(name) || /\bs\d{1,2}\b/i.test(name);
      return !hasSeriesInfo && !looksSeries;
    });
    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });
    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const files = await Premiumize.searchFiles(apiKey, searchKey, 0.1);
    if (files && files.length) {
      const streams = await Promise.all(
        files.sort(sortTorrents)
          .filter(f => filterYear(f, cinemetaDetails))
          .map(t => Premiumize.getTorrentDetails(apiKey, t.id)
            .then(td => toStream(td, type, config))
            .catch(() => undefined))
      );
      return streams.filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await OffCloud.searchOffcloudTorrents(apiKey, type, id);
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, config))
        .filter(Boolean);
    }
  } else if (debridProvider == "TorBox") {
    const torrents = await TorBox.searchTorboxTorrents(apiKey, type, id, config);
    if (torrents && torrents.length) {
      return torrents.sort(sortTorrents)
        .filter(t => filterYear(t, cinemetaDetails))
        .map(td => toStream(td, type, config))
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
    const torrents = await DebridLink.searchTorrents(apiKey, searchKey, 0.1);
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
    const allResults = await RealDebrid.searchRealDebridTorrents(apiKey, type, id, config);
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterDownloadEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "AllDebrid") {
    const allResults = await AllDebrid.searchAllDebridTorrents(apiKey, type, id, config);
    if (!allResults || allResults.length === 0) return [];

    const s = Number(season), e = Number(episode);
    const looksCorrectEp = t => t?.info && Number(t.info.season) === s && Number(t.info.episode) === e;

    const filtered = allResults.filter(t =>
      looksCorrectEp(t) ||
      (filterSeason(t, season, cinemetaDetails) && filterDownloadEpisode(t, season, episode, cinemetaDetails))
    );

    const wrapped = filtered.map(item => {
      if (item && typeof item.url === 'string' && item.url.includes('/resolve/')) return item;
      return toStream(item, type, config);
    });

    return wrapped.filter(Boolean);
  } else if (debridProvider == "Premiumize") {
    const torrents = await Premiumize.searchFiles(apiKey, searchKey, 0.1);
    if (torrents && torrents.length) {
      const streams = await Promise.all(
        torrents.sort(sortTorrents)
          .filter(t => filterSeason(t, season, cinemetaDetails))
          .map(t => Premiumize.getTorrentDetails(apiKey, t.id)
            .then(td => {
              if (filterEpisode(td, season, episode, cinemetaDetails)) return toStream(td, type, config);
            })
            .catch(() => undefined))
      );
      return streams.filter(Boolean);
    }
  } else if (debridProvider.toLowerCase() == "offcloud") {
    const torrents = await OffCloud.searchOffcloudTorrents(apiKey, type, id);
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
    const torrents = await TorBox.searchTorboxTorrents(apiKey, type, id);
    if (torrents && torrents.length) {
      // Results are already pre-filtered at the scraping layer for series/episode.
      return torrents
        .sort(sortTorrents)
        .map(td => toStream(td, type, config))
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
    } else if (provider === "debridlink" || provider === "premiumize") {
      return hostUrl;
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

function filterSeason(torrent, season, cinemetaDetails) {
  const s = Number(season);
  if (torrent?.info?.season != null && Number(torrent.info.season) === s) return true;
  if (Array.isArray(torrent?.info?.seasons) && torrent.info.seasons.map(Number).includes(s)) return true;
  if (cinemetaDetails?.name) {
    const candidate = torrent?.info?.title || torrent?.title || torrent?.name || torrent?.searchableName || torrent?.path;
    if (!titleMatches(candidate, cinemetaDetails.name)) return false;
  }
  return true;
}

function filterEpisode(torrentDetails, season, episode, cinemetaDetails) {
  if (cinemetaDetails?.name) {
    if (!matchesSeriesTitle(torrentDetails, cinemetaDetails.name)) return false;
  }
  if (torrentDetails.videos && Array.isArray(torrentDetails.videos)) {
    const matched = torrentDetails.videos
      .filter(v => String(season) == String(v.info.season) && String(episode) == String(v.info.episode));
    return matched.length > 0;
  }
  const candidates = [];
  ['name','title','searchableName','path'].forEach(f => { if (torrentDetails[f]) candidates.push(torrentDetails[f]); });
  if (torrentDetails.files && Array.isArray(torrentDetails.files)) {
    for (const f of torrentDetails.files) {
      if (f.path) candidates.push(f.path);
      if (f.name) candidates.push(f.name);
    }
  }
  for (const c of candidates) { if (c && hasEpisodeMarker(c, season, episode)) return true; }
  return false;
}

function filterYear(torrent, cinemetaDetails) {
  if (torrent?.info?.year && cinemetaDetails?.year) return torrent.info.year == cinemetaDetails.year;
  return true;
}

function filterDownloadEpisode(download, season, episode, cinemetaDetails) {
  const s = Number(season), e = Number(episode);
  if (download?.info?.season != null && download?.info?.episode != null) {
    if (Number(download.info.season) === s && Number(download.info.episode) === e) return true;
  }
  if (cinemetaDetails?.name) {
    const candidate = download?.info?.title || download?.title || download?.name || download?.searchableName || download?.path;
    if (!titleMatches(candidate, cinemetaDetails.name)) {
      const pool = [];
      if (download.name) pool.push(download.name);
      if (download.title) pool.push(download.title);
      if (download.path) pool.push(download.path);
      if (download.searchableName) pool.push(download.searchableName);
      if (Array.isArray(download.files)) {
        for (const f of download.files) {
          if (f?.path) pool.push(f.path);
          if (f?.name) pool.push(f.name);
        }
      }
      const hit = pool.some(c => c && hasEpisodeMarker(c, s, e));
      if (!hit) return false;
    }
  }
  const candidates = [];
  if (download.name) candidates.push(download.name);
  if (download.title) candidates.push(download.title);
  if (download.path) candidates.push(download.path);
  if (download.searchableName) candidates.push(download.searchableName);
  if (Array.isArray(download.files)) {
    for (const f of download.files) {
      if (f?.path) candidates.push(f.path);
      if (f?.name) candidates.push(f.name);
    }
  }
  return candidates.some(c => c && hasEpisodeMarker(c, s, e));
}

function toStream(details, type, config) {
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
  const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
  title = title + '\n' + icon + ' ' + formatSize(video.size) + trackerInfo;

  let name = STREAM_NAME_MAP[details.source] || "[DS+] Sootio";
  name = name + '\n' + (video.info?.resolution || 'N/A');

  const base = ADDON_HOST || '';
  let streamUrl;
  if (details.source === 'realdebrid') {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
    const encodedUrl = encodeURIComponent(video.url);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/realdebrid/${encodedApiKey}/${encodedUrl}`
      : video.url;
  } else if (details.source === 'offcloud' && video.url.includes('offcloud.com/cloud/download/')) {
    streamUrl = video.url;
  } else {
    const encodedApiKey = encodeURIComponent(config.DebridApiKey || config.DebridLinkApiKey || '');
    const encodedUrl = encodeURIComponent(video.url);
    streamUrl = (base && base.startsWith('http'))
      ? `${base}/resolve/${details.source}/${encodedApiKey}/${encodedUrl}`
      : video.url;
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

export default { getMovieStreams, getSeriesStreams, resolveUrl, STREAM_NAME_MAP };
