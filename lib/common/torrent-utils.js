// src/lib/common/torrent-utils.js
import PTT from '../util/parse-torrent-title.js';
import * as config from '../config.js';

/**
 * Checks if a filename has a video extension.
 * @param {string} filename - The name of the file.
 * @returns {boolean} - True if it's a video file.
 */
function isVideoExtension(filename) {
    if (!filename || typeof filename !== 'string') return false;
    const videoExtensions = [
        '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
        '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts'
    ];
    const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return videoExtensions.includes(extension);
}

/**
 * --- UPDATED FUNCTION ---
 * Provides robust validation for a video file, checking for samples, extras, and minimum size.
 * @param {string} fileName - The name of the file.
 * @param {number} [fileSize=0] - The size of the file in bytes.
 * @param {number} [minSize=50 * 1024 * 1024] - The minimum allowed file size in bytes.
 * @param {string} [logPrefix='UTIL'] - The logging prefix.
 * @returns {boolean} - True if the video is valid.
 */
export function isValidVideo(fileName, fileSize = 0, minSize = 50 * 1024 * 1024, logPrefix = 'UTIL') {
    if (!fileName) return false;
    const decoded = decodeURIComponent(fileName).toLowerCase();

    if (!isVideoExtension(decoded)) return false;

    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes|bonus|cd\d+|proof|cover)\b/i.test(decoded)) {
        return false;
    }

    if (/\.(exe|iso|dmg|pkg|msi|deb|rpm|zip|rar|7z|tar|gz|txt|nfo|sfv)$/i.test(decoded)) {
        return false;
    }

    if (fileSize > 0 && fileSize < minSize) {
        console.log(`[${logPrefix}] Filtering out small file (${formatSize(fileSize)}): ${fileName}`);
        return false;
    }

    const nameWithoutExt = decoded.replace(/\.[^/.]+$/, '');
    if (/^(etrg|yify|rarbg|ettv|nogrp|axxo|sparks|dimension|lol|asap|killers|evolve)$/i.test(nameWithoutExt)) {
        console.log(`[${logPrefix}] Filtering out group sample file: ${fileName}`);
        return false;
    }

    return true;
}

/**
 * Validates a torrent title to filter out fakes, installers, and non-video content.
 * @param {string} title - The title of the torrent.
 * @param {string} [logPrefix='UTIL'] - The logging prefix.
 * @returns {boolean} - True if the title seems valid.
 */
export function isValidTorrentTitle(title, logPrefix = 'UTIL') {
    if (!title || typeof title !== 'string') return false;
    const titleLower = title.toLowerCase();

    const fakeIndicators = [
        '.exe', '.iso', '.zip', '.rar', 'crack', 'keygen', 'patch', 'installer', 'setup',
        'virus', 'malware', 'password', 'readme', 'sample only', 'trailer only'
    ];
    if (fakeIndicators.some(fake => titleLower.includes(fake))) {
        console.log(`[${logPrefix}] Filtering fake indicator: ${title}`);
        return false;
    }

    const videoIndicators = [
        '1080p','720p','480p','2160p','4k','uhd',
        'bluray','blu-ray','bdrip','brrip','webrip','web-dl','webdl','hdtv',
        'remux','amzn','nf','x264','x265','h264','h265','.mkv','.mp4'
    ];
    const hasVideoIndicator = videoIndicators.some(indicator => titleLower.includes(indicator));
    const hasSeriesPattern = /\bs\d{1,2}\s*e\d{1,3}\b/i.test(titleLower);
    const hasSeasonOnlyPattern = /\b(?:s(?:eason)?\s*\d{1,2})(?!\s*e\d{1,3})\b/i.test(titleLower);
    const hasYearPattern = /\b(19|20)\d{2}\b/.test(titleLower);

    if (!hasVideoIndicator && !hasSeriesPattern && !hasSeasonOnlyPattern && !hasYearPattern) {
        console.log(`[${logPrefix}] Filtering no video indicators: ${title}`);
        return false;
    }
    return true;
}

/**
 * Detects whether a title looks like a TV series episode or season pack.
 * Used to exclude series results when searching for movies.
 * @param {string} title
 * @returns {boolean} True if the title appears to be series-related.
 */
export function isSeriesLikeTitle(title) {
    if (!title || typeof title !== 'string') return false;
    const s = title.toLowerCase();
    // Episode markers: SxxEyy or 1x02 or Ep 12
    if (/\b[sS]\d{1,2}\s*[._\- ]?\s*[eE]\d{1,3}\b/.test(s)) return true;
    if (/\b\d{1,2}\s*[xX]\s*\d{1,3}\b/.test(s)) return true;
    if (/\b(?:ep|episode)\.?\s*\d{1,3}\b/.test(s)) return true;
    // Season-only or packs: Season 1, S01, S01-S06, Seasons 1-6, Complete Series/Season
    if (/\bseason\s*\d{1,2}\b/.test(s)) return true;
    if (/\bs\d{1,2}\b/.test(s)) return true;
    if (/\bs\d{1,2}\s*[-–to]+\s*s\d{1,2}\b/.test(s)) return true;
    if (/\bseasons?\s*\d{1,2}\s*[-–to]+\s*\d{1,2}\b/.test(s)) return true;
    if (/complete\s*(series|season|pack)/i.test(title)) return true;
    return false;
}

export function getHashFromMagnet(magnetLink) {
    if (!magnetLink || !magnetLink.includes('btih:')) return null;
    try {
        const match = magnetLink.match(/btih:([a-zA-Z0-9]{40})/i);
        return match ? match[1].toLowerCase() : null;
    } catch {
        return null;
    }
}

export function formatSize(size) {
    if (!size) return '0 B';
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

export function sizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const units = { 'GB': 1024 ** 3, 'MB': 1024 ** 2, 'KB': 1024, 'B': 1 };
    const match = sizeStr.trim().match(/([\d.]+)\s*([KMGTB]{1,2})/i);
    if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        return value * (units[unit] || 1);
    }
    return 0;
}

export function filterByYear(torrent, cinemetaDetails, logPrefix = 'UTIL') {
    const expectedYear = cinemetaDetails?.year;
    if (!expectedYear) {
        return true; // No year to filter by
    }
    const torrentInfo = torrent.info || PTT.parse(torrent.name || torrent.Title);
    const torrentYear = torrentInfo?.year;

    if (torrentYear) {
        if (Math.abs(torrentYear - expectedYear) > 1) {
            console.log(`[${logPrefix}] Filtering wrong year: "${torrent.name || torrent.Title}" (found ${torrentYear}, expected ${expectedYear})`);
            return false;
        }
    }
    return true;
}

export function getResolutionFromName(name) {
    if (!name) return 'other';
    const lowerCaseName = name.toLowerCase();
    if (lowerCaseName.includes('2160p') || lowerCaseName.includes('4k') || lowerCaseName.includes('uhd')) return '2160p';
    if (lowerCaseName.includes('1080p')) return '1080p';
    if (lowerCaseName.includes('720p')) return '720p';
    if (lowerCaseName.includes('480p')) return '480p';
    return 'other';
}

export const resolutionOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, 'other': 0 };

export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function createEncodedUrl(url) {
    try {
        const urlObject = new URL(url);
        const pathParts = urlObject.pathname.split('/');
        const lastSegment = pathParts.pop();
        pathParts.push(encodeURIComponent(lastSegment));
        urlObject.pathname = pathParts.join('/');
        return urlObject.toString();
    } catch {
        return url;
    }
}

export function getQualityCategory(torrent) {
    if (torrent.info && torrent.info.source) {
        const source = torrent.info.source.toLowerCase();
        if (source.includes('remux')) return 'Remux';
        if (source.includes('bluray') || source.includes('blu-ray')) return 'BluRay';
        if (source.includes('web')) return 'WEB/WEB-DL';
        if (source.includes('rip')) return 'BRRip/WEBRip';
    }

    const name = (torrent.name || torrent.Title || torrent.title || '').toLowerCase();
    
    if (config.PRIORITY_PENALTY_AAC_OPUS_ENABLED && /(\s|\.)(aac|opus)\b/.test(name)) {
        return 'Audio-Focused';
    }
    
    if (/\bremux\b/.test(name)) {
        return 'Remux';
    }

    if (/\b(web-?rip|brrip|dlrip|bluray\s*rip)\b/.test(name)) {
        return 'BRRip/WEBRip';
    }
    
    if (/\b(blu-?ray|bdrip)\b/.test(name)) {
        return 'BluRay';
    }

    if (/\b(web-?\.?dl|web\b)/.test(name)) {
        return 'WEB/WEB-DL';
    }

    return 'Other';
}

export function calculateTorrentPriority(torrent) {
    const name = (torrent.Title || torrent.title || torrent.name || '').toLowerCase();
    const seeders = parseInt(torrent.Seeders || torrent.seeders || 0);
    let priorityScore = 0;
    if (name.includes('remux')) priorityScore += 150;
    if (name.includes('.web.') || name.includes(' web ') || name.includes('.web-dl.') || name.includes(' web-dl ')) priorityScore += 100;
    if (name.includes('.bluray.') || name.includes(' bluray ')) priorityScore += 100;
    if (name.includes('.brrip.') || name.includes(' brrip ') || name.includes('bluray rip') || name.includes('.webrip.') || name.includes(' webrip ')) priorityScore += 75;
    if (name.includes('.hdtv.') || name.includes(' hdtv ')) priorityScore += 50;
    if (name.includes('2160p') || name.includes('4k')) priorityScore += 30;
    else if (name.includes('1080p')) priorityScore += 20;
    else if (name.includes('720p')) priorityScore += 10;
    if (name.includes('x265') || name.includes('hevc') || name.includes('h265')) priorityScore += 15;
    if (name.includes('x264') || name.includes('h264')) priorityScore += 10;
    priorityScore += Math.min(seeders / 100, 50);
    
    // Penalties
    if (name.includes('cam') || name.includes('ts') || name.includes('screener') || name.includes('hdrip')) priorityScore -= 100;
    if (name.includes('dvdrip') || name.includes('dvdscr')) priorityScore -= 25;
    if (name.includes('yts')) priorityScore -= 75;
    if (name.includes('10bit')) priorityScore -= 25;
    if (name.includes(' aac') || name.includes('.aac') || name.includes(' opus') || name.includes('.opus')) {
        priorityScore -= 50;
    }
    if (name.includes('brrip') || name.includes('bluray rip')) priorityScore -= 50;

    return priorityScore;
}

export function getCodec(torrent) {
    const name = (torrent.name || torrent.Title || torrent.title || '').toLowerCase();
    if (name.includes('x265') || name.includes('hevc') || name.includes('h265')) return 'h265';
    if (name.includes('x264') || name.includes('h264')) return 'h264';
    return 'unknown';
}

export function deduplicateAndKeepLargest(torrents) {
    if (!Array.isArray(torrents)) return [];
    const uniqueTorrents = new Map();
    const extensionRegex = /\.(mkv|mp4|avi|exe|iso|zip|rar)$/i;
    for (const torrent of torrents) {
        if (!torrent || typeof torrent.Title !== 'string' || typeof torrent.Size !== 'number') {
            continue;
        }
        const normalizedTitle = torrent.Title.replace(extensionRegex, '').trim();
        const existingTorrent = uniqueTorrents.get(normalizedTitle);
        if (!existingTorrent || torrent.Size > existingTorrent.Size) {
            uniqueTorrents.set(normalizedTitle, torrent);
        }
    }
    return Array.from(uniqueTorrents.values());
}
