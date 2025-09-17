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
 * Provides robust validation for a video file, checking for samples, extras, and minimum size.
 * This is a merged and improved version from both provider files.
 * @param {string} fileName - The name of the file.
 * @param {number} [fileSize=0] - The size of the file in bytes.
 * @param {number} [minSize=50 * 1024 * 1024] - The minimum allowed file size in bytes.
 * @param {string} [logPrefix='UTIL'] - The logging prefix.
 * @returns {boolean} - True if the video is valid.
 */
export function isValidVideo(fileName, fileSize = 0, minSize = 50 * 1024 * 1024, logPrefix = 'UTIL') {
    if (!fileName) return false;
    const decodedName = decodeURIComponent(fileName).toLowerCase();
    
    if (!isVideoExtension(decodedName)) return false;
    
    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes|bonus|cd\d+|proof|cover)\b/i.test(decodedName)) {
        return false;
    }
    
    if (/\.(exe|iso|dmg|pkg|msi|deb|rpm|zip|rar|7z|tar|gz|txt|nfo|sfv)$/i.test(decodedName)) {
        return false;
    }
    
    if (fileSize > 0 && fileSize < minSize) {
        console.log(`[${logPrefix}] Filtering out small file (${formatSize(fileSize)}): ${fileName}`);
        return false;
    }

    const nameWithoutExt = decodedName.replace(/\.[^/.]+$/, '');
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

    const videoIndicators = ['1080p', '720p', '2160p', '4k', 'bluray', 'webrip', 'hdtv', 'x264', 'x265', '.mkv', '.mp4'];
    const hasVideoIndicator = videoIndicators.some(indicator => titleLower.includes(indicator));
    const hasSeriesPattern = /s\d{1,2}e\d{1,2}/i.test(titleLower);
    const hasYearPattern = /\b(19|20)\d{2}\b/.test(titleLower);

    if (!hasVideoIndicator && !hasSeriesPattern && !hasYearPattern) {
        console.log(`[${logPrefix}] Filtering no video indicators: ${title}`);
        return false;
    }
    return true;
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
    const name = (torrent.name || torrent.Title || torrent.title || '').toLowerCase();
    if (config.PRIORITY_PENALTY_AAC_OPUS_ENABLED && (name.includes(' aac') || name.includes('.aac') || name.includes(' opus') || name.includes('.opus'))) return 'Audio-Focused';
    if (name.includes('remux')) return 'Remux';
    if (name.includes('bluray') || name.includes('blu-ray')) return 'BluRay';
    if (name.includes('.web.') || name.includes('.web-dl.')) return 'WEB/WEB-DL';
    if (name.includes('.brrip.') || name.includes('.webrip.') || name.includes('bluray rip')) return 'BRRip/WEBRip';
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

/**
 * Creates a normalized list of essential keywords from a string.
 * Removes common stop words, punctuation, and quality tags.
 * @param {string} str - The string to process.
 * @returns {string[]} - An array of keywords.
 */
function getKeywords(str) {
    if (!str) return [];
    const stopWords = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'for', 'with']);
    const normalized = str.toLowerCase()
        .replace(/:/g, ' ') // Replace colons with spaces
        .replace(/[._'()]/g, ' ') // Replace other punctuation with spaces
        .replace(/\s+/g, ' ') // Condense multiple spaces
        .trim();
    
    return normalized.split(' ').filter(word => 
        word.length > 1 && 
        !stopWords.has(word) && 
        !/^\d{4}$/.test(word) && // Remove years
        !/^(1080p|720p|2160p|4k|bluray|webrip|hdtv|x264|x265)$/.test(word) // Remove quality tags
    ).filter(Boolean);
}


/**
 * Performs a smart sanity check on torrents based on the official show name.
 * A torrent is only considered valid if its title contains a majority of the essential keywords.
 * @param {Array<Object>} torrents - The list of torrents to filter.
 * @param {Object} cinemetaDetails - The metadata for the series/movie.
 * @param {string} logPrefix - The logging prefix.
 * @returns {Array<Object>} - The filtered list of torrents.
 */
export function smarterSanityCheck(torrents, cinemetaDetails, logPrefix = 'UTIL') {
    if (!cinemetaDetails || !cinemetaDetails.name) {
        return torrents;
    }

    const originalCount = torrents.length;
    const searchKeywords = getKeywords(cinemetaDetails.name);

    if (searchKeywords.length === 0) {
        return torrents; // Not enough keywords to filter by
    }

    // Require a high percentage of keywords to match, with a minimum of 1.
    const requiredMatches = Math.max(1, Math.ceil(searchKeywords.length * 0.75));

    const filteredTorrents = torrents.filter(torrent => {
        const title = (torrent.Title || torrent.name || '').toLowerCase().replace(/[._]/g, ' ');
        
        const actualMatches = searchKeywords.reduce((count, keyword) => {
            return title.includes(keyword) ? count + 1 : count;
        }, 0);

        return actualMatches >= requiredMatches;
    });

    const rejectedCount = originalCount - filteredTorrents.length;
    if (rejectedCount > 0) {
        console.log(`[${logPrefix}] Smart sanity check REJECTED ${rejectedCount} irrelevant results.`);
    }

    return filteredTorrents;
}
