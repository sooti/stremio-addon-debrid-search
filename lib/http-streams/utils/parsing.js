/**
 * Parsing and string manipulation utilities for HTTP streams
 * Handles resolution detection, quality parsing, title matching, and formatting
 */

/**
 * Extracts resolution from a string name
 * @param {string} name - String containing resolution info
 * @returns {string} Resolution string (2160p, 1080p, 720p, 480p, or 'other')
 */
export function getResolutionFromName(name) {
    if (!name) return 'other';
    const lowerCaseName = name.toLowerCase();
    // Check for more specific resolutions first (higher to lower)
    if (lowerCaseName.includes('2160p')) return '2160p';
    if (lowerCaseName.includes('1080p')) return '1080p';
    if (lowerCaseName.includes('720p')) return '720p';
    if (lowerCaseName.includes('480p')) return '480p';
    // Fallback to '4k' or 'uhd' if no specific resolution is found
    if (lowerCaseName.includes('4k') || lowerCaseName.includes('uhd')) return '2160p';
    return 'other';
}

/**
 * Formats a size in bytes to human-readable format
 * @param {number} size - Size in bytes
 * @returns {string} Formatted size string
 */
export function formatSize(size) {
    if (!size) return '0 B';
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

/**
 * Extracts quality number from a string
 * @param {string} str - String containing quality info
 * @returns {number} Quality number (defaults to 2160 if not found)
 */
export function getIndexQuality(str) {
    const match = (str || '').match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 2160;
}

/**
 * Extracts base URL (protocol + host) from a URL
 * @param {string} url - Full URL
 * @returns {string} Base URL or empty string if invalid
 */
export function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        return '';
    }
}

/**
 * Cleans a title by extracting quality and codec information
 * @param {string} title - Title to clean
 * @returns {string} Cleaned title with quality tags
 */
export function cleanTitle(title) {
    const parts = title.split(/[.\-_]/);

    const qualityTags = ['WEBRip', 'WEB-DL', 'WEB', 'BluRay', 'HDRip', 'DVDRip', 'HDTV', 'CAM', 'TS', 'R5', 'DVDScr', 'BRRip', 'BDRip', 'DVD', 'PDTV', 'HD'];
    const audioTags = ['AAC', 'AC3', 'DTS', 'MP3', 'FLAC', 'DD5', 'EAC3', 'Atmos'];
    const subTags = ['ESub', 'ESubs', 'Subs', 'MultiSub', 'NoSub', 'EnglishSub', 'HindiSub'];
    const codecTags = ['x264', 'x265', 'H264', 'HEVC', 'AVC'];

    const startIndex = parts.findIndex(part =>
        qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );

    const endIndex = parts.map((part, index) => {
        const hasTag = [...subTags, ...audioTags, ...codecTags].some(tag =>
            part.toLowerCase().includes(tag.toLowerCase())
        );
        return hasTag ? index : -1;
    }).filter(index => index !== -1).pop() || -1;

    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        return parts.slice(startIndex, endIndex + 1).join('.');
    } else if (startIndex !== -1) {
        return parts.slice(startIndex).join('.');
    } else {
        return parts.slice(-3).join('.');
    }
}

/**
 * Normalize title for better matching
 * @param {string} title - Title to normalize
 * @returns {string} Normalized title
 */
export function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')  // Remove special characters
        .replace(/\s+/g, ' ')          // Normalize whitespace
        .trim();
}

/**
 * Calculate similarity between two strings using Levenshtein distance
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score (0-1)
 */
export function calculateSimilarity(str1, str2) {
    const s1 = normalizeTitle(str1);
    const s2 = normalizeTitle(str2);

    if (s1 === s2) return 1.0;

    const len1 = s1.length;
    const len2 = s2.length;

    if (len1 === 0) return len2 === 0 ? 1.0 : 0.0;
    if (len2 === 0) return 0.0;

    const matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));

    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }

    const maxLen = Math.max(len1, len2);
    return (maxLen - matrix[len1][len2]) / maxLen;
}

/**
 * Check if query words are contained in title
 * @param {string} title - Title to search in
 * @param {string} query - Query to search for
 * @returns {boolean} True if all query words are contained in title
 */
export function containsWords(title, query) {
    const titleWords = normalizeTitle(title).split(' ');
    const queryWords = normalizeTitle(query).split(' ');

    return queryWords.every(queryWord =>
        titleWords.some(titleWord =>
            titleWord.includes(queryWord) || queryWord.includes(titleWord)
        )
    );
}

/**
 * Helper function to remove year from title
 * @param {string} title - Title with possible year
 * @returns {string} Title without year
 */
export function removeYear(title) {
    // Remove year patterns like (2023), [2023], 2023 at the end
    return title
        .replace(/[\(\[]?\d{4}[\)\]]?$/g, '')
        .replace(/\s+\d{4}$/g, '')
        .trim();
}

/**
 * Helper function to generate alternative query variations
 * @param {string} title - Primary title
 * @param {string|null} originalTitle - Original title (optional)
 * @returns {string[]} Array of alternative query strings
 */
export function generateAlternativeQueries(title, originalTitle = null) {
    const queries = [];

    if (title) {
        queries.push(title);
        queries.push(removeYear(title));

        // Remove special characters
        const cleaned = title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleaned !== title) {
            queries.push(cleaned);
        }
    }

    // Add original title if different
    if (originalTitle && originalTitle !== title) {
        queries.push(originalTitle);
        queries.push(removeYear(originalTitle));
    }

    // Return unique queries
    return [...new Set(queries)].filter(Boolean);
}

/**
 * Find best matching result from search results
 * @param {Array} results - Array of search results with title property
 * @param {string} query - Query string to match against
 * @returns {Object|null} Best matching result or null
 */
export function findBestMatch(results, query) {
    const sorted = getSortedMatches(results, query);
    return sorted.length > 0 ? sorted[0] : null;
}

/**
 * Sort search results by similarity to query
 * @param {Array} results - Array of search results with title property
 * @param {string} query - Query string to match against
 * @returns {Array} Sorted array of results with score property
 */
export function getSortedMatches(results, query) {
    if (results.length === 0) return [];
    if (results.length === 1) return results;

    // Score each result
    const scoredResults = results.map(result => {
        let score = 0;

        // Guard against missing title
        if (!result.title || !query) {
            return { ...result, score: 0 };
        }

        // Exact match gets highest score
        if (normalizeTitle(result.title) === normalizeTitle(query)) {
            score += 100;
        }

        // Similarity score (0-50 points)
        const similarity = calculateSimilarity(result.title, query);
        if (!isNaN(similarity)) {
            score += similarity * 50;
        }

        // Word containment bonus (0-30 points)
        if (containsWords(result.title, query)) {
            score += 30;
        }

        // Prefer shorter titles (closer matches) (0-10 points)
        const lengthDiff = Math.abs(result.title.length - query.length);
        const lengthScore = Math.max(0, 10 - lengthDiff / 5);
        if (!isNaN(lengthScore)) {
            score += lengthScore;
        }

        // Year extraction bonus - prefer titles with years
        if (result.title.match(/\((19|20)\d{2}\)/)) {
            score += 5;
        }

        return { ...result, score: isNaN(score) ? 0 : score };
    });

    // Sort by score (highest first)
    scoredResults.sort((a, b) => (b.score || 0) - (a.score || 0));

    console.log('\nTitle matching scores:');
    scoredResults.slice(0, 5).forEach((result, index) => {
        const scoreDisplay = (result.score !== undefined && result.score !== null) ? result.score.toFixed(1) : 'N/A';
        console.log(`${index + 1}. ${result.title} (Score: ${scoreDisplay})`);
    });

    return scoredResults;
}
