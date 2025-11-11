/**
 * Dizipall24.com Stream Provider
 *
 * A Turkish streaming site integration for Stremio
 *
 * IMPORTANT NOTES:
 * - Stream URLs expire after 12 hours (check 'e' parameter)
 * - Requires proper User-Agent and Referer headers
 * - Search returns Turkish content primarily
 * - Legal status should be verified before production use
 */

import fetch from 'node-fetch';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_URL = 'https://dizipall24.com';

/**
 * Search for content on Dizipall24
 * @param {string} query - Search query (Turkish series name)
 * @returns {Promise<Array>} - Array of search results
 */
export async function searchDizipall(query) {
    try {
        const response = await fetch(`${BASE_URL}/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT,
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: `query=${encodeURIComponent(query)}`
        });

        if (!response.ok) {
            throw new Error(`Search failed: ${response.status}`);
        }

        const contentType = response.headers.get('content-type');

        // Handle both JSON and HTML responses
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        } else {
            const html = await response.text();
            return parseSearchResults(html);
        }
    } catch (error) {
        console.error('[DIZIPALL24] Search error:', error);
        return [];
    }
}

/**
 * Parse HTML search results
 * @param {string} html - HTML response
 * @returns {Array} - Parsed results
 */
function parseSearchResults(html) {
    const results = [];

    // Extract series cards from HTML
    // Pattern: <a href="/dizi/series-name">
    const linkRegex = /<a[^>]*href="\/dizi\/([^"]+)"[^>]*>(.*?)<\/a>/gs;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
        results.push({
            slug: match[1],
            url: `${BASE_URL}/dizi/${match[1]}`
        });
    }

    return results;
}

/**
 * Build episode URL
 * @param {string} seriesSlug - Series slug (e.g., 'gibi-d24')
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {string} - Episode URL
 */
export function buildEpisodeUrl(seriesSlug, season, episode) {
    return `${BASE_URL}/dizi/${seriesSlug}/sezon-${season}/bolum-${episode}`;
}

/**
 * Get embed URLs from episode page
 * @param {string} episodeUrl - Episode page URL
 * @returns {Promise<Array<string>>} - Array of embed URLs
 */
export async function getEmbedUrls(episodeUrl) {
    try {
        const response = await fetch(episodeUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        if (!response.ok) {
            throw new Error(`Episode page failed: ${response.status}`);
        }

        const html = await response.text();
        return parseEmbedUrls(html);
    } catch (error) {
        console.error('[DIZIPALL24] Get embed URLs error:', error);
        return [];
    }
}

/**
 * Parse embed URLs from episode page HTML
 * @param {string} html - Episode page HTML
 * @returns {Array<string>} - Embed URLs
 */
function parseEmbedUrls(html) {
    const embedUrls = [];

    // Extract from data-frame attributes
    const frameRegex = /data-frame="([^"]+)"/g;
    let match;

    while ((match = frameRegex.exec(html)) !== null) {
        if (match[1] && match[1].startsWith('http')) {
            embedUrls.push(match[1]);
        }
    }

    // Also check for iframe src attributes as fallback
    const iframeRegex = /<iframe[^>]*src="([^"]+)"[^>]*>/g;
    while ((match = iframeRegex.exec(html)) !== null) {
        if (match[1] && match[1].startsWith('http') && !embedUrls.includes(match[1])) {
            embedUrls.push(match[1]);
        }
    }

    return embedUrls;
}

/**
 * Extract stream URL from embed page
 * @param {string} embedUrl - Embed page URL
 * @returns {Promise<Object|null>} - Stream information
 */
export async function getStreamFromEmbed(embedUrl) {
    try {
        const response = await fetch(embedUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': BASE_URL + '/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        if (!response.ok) {
            throw new Error(`Embed fetch failed: ${response.status}`);
        }

        const html = await response.text();
        return parseStreamInfo(html, embedUrl);
    } catch (error) {
        console.error('[DIZIPALL24] Get stream from embed error:', error);
        return null;
    }
}

/**
 * Parse stream information from embed page
 * @param {string} html - Embed page HTML
 * @param {string} embedUrl - Original embed URL for context
 * @returns {Object|null} - Stream info object
 */
function parseStreamInfo(html, embedUrl) {
    // Extract PlayerJS configuration
    const fileMatch = html.match(/file:"([^"]+)"/);

    if (!fileMatch) {
        console.error('[DIZIPALL24] No stream URL found in embed');
        return null;
    }

    const streamUrl = fileMatch[1];

    // Extract additional metadata
    const titleMatch = html.match(/title:"([^"]+)"/);
    const posterMatch = html.match(/poster:"([^"]+)"/);
    const durationMatch = html.match(/duration:"([^"]+)"/);

    // Parse URL expiration
    const expirationInfo = parseUrlExpiration(streamUrl);

    return {
        url: streamUrl,
        title: titleMatch ? titleMatch[1] : 'Dizipall24 Stream',
        poster: posterMatch ? posterMatch[1] : null,
        duration: durationMatch ? parseFloat(durationMatch[1]) : null,
        type: streamUrl.includes('.m3u8') ? 'hls' : 'unknown',
        embedUrl,
        expiresAt: expirationInfo.expiresAt,
        expiresIn: expirationInfo.expiresIn,
        provider: 'Dizipall24'
    };
}

/**
 * Parse expiration information from stream URL
 * @param {string} url - Stream URL
 * @returns {Object} - Expiration info
 */
function parseUrlExpiration(url) {
    try {
        const urlObj = new URL(url);
        const startTime = parseInt(urlObj.searchParams.get('s')) || 0;
        const expirationDuration = parseInt(urlObj.searchParams.get('e')) || 0;

        if (startTime && expirationDuration) {
            const expiresAt = new Date((startTime + expirationDuration) * 1000);
            const expiresIn = Math.max(0, expiresAt.getTime() - Date.now());

            return {
                expiresAt,
                expiresIn,
                isExpired: expiresIn <= 0
            };
        }
    } catch (error) {
        console.error('[DIZIPALL24] Error parsing expiration:', error);
    }

    return {
        expiresAt: null,
        expiresIn: null,
        isExpired: false
    };
}

/**
 * Get stream for a specific episode
 * @param {string} seriesSlug - Series slug
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {Promise<Object|null>} - Stream information
 */
export async function getStream(seriesSlug, season, episode) {
    console.log(`[DIZIPALL24] Getting stream for ${seriesSlug} S${season}E${episode}`);

    // Build episode URL
    const episodeUrl = buildEpisodeUrl(seriesSlug, season, episode);
    console.log(`[DIZIPALL24] Episode URL: ${episodeUrl}`);

    // Get embed URLs
    const embedUrls = await getEmbedUrls(episodeUrl);
    console.log(`[DIZIPALL24] Found ${embedUrls.length} embed URLs`);

    if (embedUrls.length === 0) {
        console.log('[DIZIPALL24] No embed URLs found');
        return null;
    }

    // Try each embed URL until we find a working stream
    for (const embedUrl of embedUrls) {
        console.log(`[DIZIPALL24] Trying embed: ${embedUrl}`);
        const streamInfo = await getStreamFromEmbed(embedUrl);

        if (streamInfo && !streamInfo.isExpired) {
            console.log(`[DIZIPALL24] Found valid stream, expires in ${Math.round(streamInfo.expiresIn / 1000 / 60)} minutes`);
            return streamInfo;
        }
    }

    console.log('[DIZIPALL24] No valid streams found');
    return null;
}

/**
 * Map Turkish series name variations
 * Common mappings for popular Turkish series
 */
const TURKISH_SERIES_MAPPINGS = {
    'gibi': 'gibi-d24',
    // Add more mappings as needed
};

/**
 * Search and get stream with auto-mapping
 * @param {string} query - Search query or series name
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {Promise<Object|null>} - Stream information
 */
export async function searchAndGetStream(query, season, episode) {
    // Check if we have a direct mapping
    const normalizedQuery = query.toLowerCase().trim();
    let seriesSlug = TURKISH_SERIES_MAPPINGS[normalizedQuery];

    // If no direct mapping, try searching
    if (!seriesSlug) {
        const searchResults = await searchDizipall(query);

        if (searchResults.length === 0) {
            console.log('[DIZIPALL24] No search results found');
            return null;
        }

        // Use first result
        seriesSlug = searchResults[0].slug;
        console.log(`[DIZIPALL24] Using series slug from search: ${seriesSlug}`);
    }

    return await getStream(seriesSlug, season, episode);
}

/**
 * Convert stream info to Stremio stream object
 * @param {Object} streamInfo - Stream information
 * @returns {Object} - Stremio stream object
 */
export function toStremioStream(streamInfo) {
    if (!streamInfo) return null;

    const expiresText = streamInfo.expiresIn
        ? ` (expires in ${Math.round(streamInfo.expiresIn / 1000 / 60)}min)`
        : '';

    return {
        name: 'Dizipall24',
        title: streamInfo.title + expiresText,
        url: streamInfo.url,
        behaviorHints: {
            notWebReady: true, // HLS streams work better in native players
            bingeGroup: 'dizipall24-' + streamInfo.embedUrl.split('/').pop()
        }
    };
}

export default {
    searchDizipall,
    buildEpisodeUrl,
    getEmbedUrls,
    getStreamFromEmbed,
    getStream,
    searchAndGetStream,
    toStremioStream
};
