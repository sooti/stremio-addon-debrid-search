/**
 * Stream formatting for Stremio
 * Converts torrent/debrid data into Stremio stream objects
 */

import { getResolutionFromName, formatSize } from '../../common/torrent-utils.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../util/language-mapping.js';
import PTT from '../../util/parse-torrent-title.js';
import { STREAM_NAME_MAP } from '../config/stream-names.js';
import { isValidUrl } from '../utils/url-validation.js';

const ADDON_HOST = process.env.ADDON_URL;

/**
 * Convert torrent/debrid details into a Stremio stream object
 *
 * @param {Object} details - Torrent/debrid details
 * @param {string} type - Content type ('movie' or 'series')
 * @param {Object} config - User configuration
 * @param {Object} streamHint - Hints for series (season/episode)
 * @returns {Object|null} - Stremio stream object or null if invalid
 */
export function toStream(details, type, config, streamHint = {}) {
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
  // Detect languages from the display name and render flags
  const detectedLanguages = detectLanguagesFromTitle(displayName);
  const flagsSuffix = renderLanguageFlags(detectedLanguages);
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
  // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
  let resolutionLabel;
  if (resolution === '2160p') {
      resolutionLabel = '4k';
  } else if (resolution === '1080p') {
      resolutionLabel = '1080p';
  } else if (resolution === '720p') {
      resolutionLabel = '720p';
  } else if (resolution === '480p') {
      resolutionLabel = '480p';
  } else {
      resolutionLabel = resolution; // fallback for other values
  }
  name = name + '\n' + (resolutionLabel || 'N/A');

  const base = ADDON_HOST || '';
  let streamUrl;
  let urlToEncode = video.url;

  // If url is missing, construct magnet URL from hash (common for Torz API results)
  if (!urlToEncode && (video.hash || video.infoHash)) {
    const hash = (video.hash || video.infoHash).toLowerCase();
    const torrentName = encodeURIComponent(video.name || video.title || 'torrent');
    urlToEncode = `magnet:?xt=urn:btih:${hash}&dn=${torrentName}`;
    console.log(`[STREAM] Constructed magnet URL from hash for torrent: ${video.name || 'Unknown'}`);
  }

  // If still no URL available, return null (cannot create stream)
  if (!urlToEncode) {
    console.error(`[STREAM] Cannot create stream - no URL or hash available for: ${video.name || 'Unknown'}`);
    return null;
  }

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
    isPersonal: details.isPersonal, // Keep track of personal files for sorting
    _size: video.size || 0,  // Preserve size for filtering
    behaviorHints: {
      bingeGroup: `${details.source}|${details.hash || details.id || 'unknown'}`
    }
  };
  if (details.bypassFiltering) streamObj.bypassFiltering = true;
  return streamObj;
}
