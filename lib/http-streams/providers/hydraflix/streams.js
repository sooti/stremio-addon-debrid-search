/**
 * Hydraflix Streams Module
 * Handles fetching and processing streams from Hydraflix
 */

import Cinemeta from '../../../util/cinemeta.js';
import { scrapeHydraflixSearch, loadContent } from './search.js';
import { extractAllEmbeds } from './extraction.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { getResolutionFromName, removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';

/**
 * Generates embed URL based on host and parameters
 * @param {string} embedHost - The embed host identifier
 * @param {string} embedId - The TMDB or embed ID
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {string|null} Generated embed URL or null
 */
function generateEmbedUrl(embedHost, embedId, season, episode) {
    const hostPatterns = {
        'premium': `https://player.smashy.stream/tv/${embedId}?s=${season}&e=${episode}`,
        'embedru': `https://embed.su/embed/tv/${embedId}/${season}/${episode}`,
        'superembed': `https://multiembed.mov/directstream.php?video_id=${embedId}&tmdb=1&s=${season}&e=${episode}`,
        'vidsrc': `https://vidsrc.xyz/embed/tv/${embedId}/${season}/${episode}`,
        'vidbinge': `https://vidbinge.dev/embed/tv/${embedId}/${season}/${episode}`,
        'vidclub': `https://vidclub.top/embed/tv/${embedId}/${season}/${episode}`,
        'autoembed': `https://autoembed.cc/tv/tmdb/${embedId}-${season}-${episode}`,
        'embedsu': `https://embed.su/embed/tv/${embedId}/${season}/${episode}`
    };

    const url = hostPatterns[embedHost];
    if (!url) {
        console.log(`[Hydraflix] Unknown embed host: ${embedHost}`);
        return null;
    }

    return url;
}

/**
 * Validates movie year against expected year
 * @param {Object} content - Content object with year
 * @param {number} expectedYear - Expected year
 * @returns {boolean} Whether year is valid
 */
function validateMovieYear(content, expectedYear) {
    if (!expectedYear) {
        return true; // No year to validate against
    }

    if (!content.year) {
        return true; // No year available in content, assume valid
    }

    // Allow a tolerance of 1 year to account for re-releases, director's cuts etc.
    if (Math.abs(content.year - expectedYear) <= 1) {
        return true;
    } else {
        console.log(`[Hydraflix] Movie year mismatch: found ${content.year}, expected ${expectedYear} (or within 1 year)`);
        return false;
    }
}

/**
 * Extracts streaming URLs from iframe embeds and links
 * @param {Array<string>} streamLinks - Array of stream links/iframes
 * @returns {Array<Object>} Array of stream objects
 */
async function extractStreamUrls(streamLinks) {
    const streams = [];

    for (const link of streamLinks) {
        try {
            let streamUrl = link;
            let title = 'Stream';
            let quality = 'HD';

            // Extract server name from URL
            let serverName = 'Unknown';
            if (link.includes('smashy.stream')) {
                serverName = 'Smashy';
            } else if (link.includes('embed.su')) {
                serverName = 'EmbedSu';
            } else if (link.includes('multiembed.mov')) {
                serverName = 'MultiEmbed';
            } else if (link.includes('vidsrc.xyz')) {
                serverName = 'VidSrc';
            } else if (link.includes('vidbinge.dev')) {
                serverName = 'VidBinge';
            } else if (link.includes('vidclub.top')) {
                serverName = 'VidClub';
            } else if (link.includes('autoembed.cc')) {
                serverName = 'AutoEmbed';
            }

            // Detect quality from URL if possible
            if (link.toLowerCase().includes('1080')) {
                quality = '1080p';
            } else if (link.toLowerCase().includes('720')) {
                quality = '720p';
            } else if (link.toLowerCase().includes('4k') || link.toLowerCase().includes('2160')) {
                quality = '4K';
            }

            title = `${serverName} - ${quality}`;

            streams.push({
                url: streamUrl,
                title: title,
                quality: quality
            });
        } catch (err) {
            console.log(`[Hydraflix] Failed to process link: ${link}`, err.message);
        }
    }

    return streams;
}

/**
 * Gets streams from Hydraflix
 * @param {string} tmdbId - TMDB ID
 * @param {string} type - Content type ('movie' or 'series')
 * @param {number} season - Season number (for series)
 * @param {number} episode - Episode number (for series)
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} Array of streams
 */
export async function getHydraflixStreams(tmdbId, type, season = null, episode = null, config) {
    try {
        console.log(`[Hydraflix] Starting search for TMDB ID: ${tmdbId}, Type: ${type}${season ? `, Season: ${season}` : ''}${episode ? `, Episode: ${episode}` : ''}`);

        // Get TMDB details to get the actual title
        const cinemetaDetails = await Cinemeta.getMeta(type, tmdbId);
        if (!cinemetaDetails) {
            console.log(`[Hydraflix] Could not fetch TMDB details for ID: ${tmdbId}`);
            return [];
        }

        const year = cinemetaDetails.year ? parseInt(cinemetaDetails.year.split('-')[0]) : null;

        console.log(`[Hydraflix] TMDB Details: ${cinemetaDetails.name} (${year || 'N/A'})`);

        // Run all search strategies in parallel
        console.log(`[Hydraflix] Running parallel searches with multiple strategies...`);

        // Build all search queries upfront
        const searchQueries = [];

        // Primary search using the actual title
        searchQueries.push({ query: cinemetaDetails.name, strategy: 'primary' });

        // Search without year
        const titleWithoutYear = removeYear(cinemetaDetails.name);
        if (titleWithoutYear !== cinemetaDetails.name) {
            searchQueries.push({ query: titleWithoutYear, strategy: 'no-year' });
        }

        // Alternative title formats
        const alternativeQueries = generateAlternativeQueries(
            cinemetaDetails.name,
            cinemetaDetails.original_title
        ).filter(query => query !== cinemetaDetails.name && query !== titleWithoutYear);

        alternativeQueries.forEach(query => {
            searchQueries.push({ query, strategy: 'alternative' });
        });

        console.log(`[Hydraflix] Executing ${searchQueries.length} parallel searches...`);

        // Execute all searches in parallel
        const searchPromises = searchQueries.map(async ({ query, strategy }) => {
            try {
                const results = await scrapeHydraflixSearch(query);
                console.log(`[Hydraflix] ${strategy} search "${query}" found ${results.length} results`);
                return { query, strategy, results };
            } catch (err) {
                console.log(`[Hydraflix] ${strategy} search "${query}" failed: ${err.message}`);
                return { query, strategy, results: [] };
            }
        });

        const allSearchResults = await Promise.all(searchPromises);

        // Find the best match across all search results
        let bestMatch = null;
        let sortedMatches = [];
        let searchResults = [];

        for (const { query, strategy, results } of allSearchResults) {
            if (results.length > 0) {
                const sorted = getSortedMatches(results, cinemetaDetails.name);
                const topMatch = sorted[0];

                if (topMatch && (!bestMatch || (topMatch.score || 0) > (bestMatch.score || 0))) {
                    bestMatch = topMatch;
                    sortedMatches = sorted;
                    searchResults = results;
                    const scoreDisplay = (topMatch.score !== undefined && topMatch.score !== null) ? topMatch.score.toFixed(1) : 'N/A';
                    console.log(`[Hydraflix] Best match from ${strategy} search "${query}" (score: ${scoreDisplay})`);
                }
            }
        }

        if (searchResults.length === 0) {
            console.log(`[Hydraflix] No search results found for any query variation`);
            return [];
        }

        if (!bestMatch) {
            console.log(`[Hydraflix] No suitable match found for: ${cinemetaDetails.name}`);
            return [];
        }

        let streamLinks = [];

        if (type === 'movie') {
            // Try top matches with year validation
            const MAX_YEAR_VALIDATION_ATTEMPTS = 5;
            let validMatch = null;
            const matchesToTry = sortedMatches.slice(0, MAX_YEAR_VALIDATION_ATTEMPTS);

            console.log(`[Hydraflix] Trying year validation for top ${matchesToTry.length} matches (out of ${sortedMatches.length} total)`);

            for (const match of matchesToTry) {
                const scoreDisplay = (match.score !== undefined && match.score !== null) ? match.score.toFixed(1) : 'N/A';
                console.log(`[Hydraflix] Trying match: ${match.title} (score: ${scoreDisplay})`);
                const content = await loadContent(match.url || match.postUrl);

                if (validateMovieYear(content, year)) {
                    validMatch = match;
                    streamLinks = content.streamLinks || [];
                    console.log(`[Hydraflix] Year validation passed for ${content.title}, using this match`);
                    console.log(`[Hydraflix] Found ${streamLinks.length} stream links`);
                    break;
                } else {
                    console.log(`[Hydraflix] Movie year validation failed for ${content.title}, trying next match...`);
                }
            }

            if (!validMatch) {
                console.log(`[Hydraflix] No match passed year validation after trying ${matchesToTry.length} matches`);
                return [];
            }
        } else if ((type === 'series' || type === 'tv') && season && episode) {
            const content = await loadContent(bestMatch.url || bestMatch.postUrl);
            console.log(`[Hydraflix] Looking for Season ${season}, Episode ${episode}`);
            console.log(`[Hydraflix] TMDB ID: ${content.tmdbId}, Servers: ${content.servers?.length || 0}`);

            // For TV series, Hydraflix uses embed URLs with the pattern:
            // The servers have embed hosts and IDs - generate embed URLs for the requested episode
            if (content.servers && content.servers.length > 0) {
                console.log(`[Hydraflix] Generating embed URLs for S${season}E${episode}`);

                // Generate embed URLs for each server
                for (const server of content.servers) {
                    // Hydraflix uses these embed patterns (based on data-load-embed-host):
                    // Most embeds follow: https://[host]/embed/[id]/[season]/[episode]
                    const embedUrl = generateEmbedUrl(server.embedHost, server.embedId, season, episode);
                    if (embedUrl) {
                        streamLinks.push(embedUrl);
                        console.log(`[Hydraflix] Generated ${server.name} embed: ${embedUrl}`);
                    }
                }
            } else {
                console.log(`[Hydraflix] No servers found for episode generation`);
            }
        }

        if (streamLinks.length === 0) {
            console.log(`[Hydraflix] No stream links found`);
            return [];
        }

        // First, convert stream links to stream objects
        console.log(`[Hydraflix] Found ${streamLinks.length} stream links, processing...`);
        const embedStreams = await extractStreamUrls(streamLinks);
        console.log(`[Hydraflix] Processed ${embedStreams.length} embed stream(s), extracting actual URLs...`);

        // Extract actual video URLs from embeds
        const extractedStreams = await extractAllEmbeds(embedStreams);
        console.log(`[Hydraflix] Extracted ${extractedStreams.length} working stream(s)`);

        // Convert to Stremio format
        const streams = extractedStreams.map(stream => {
            const resolution = getResolutionFromName(stream.quality);
            const detectedLanguages = detectLanguagesFromTitle(stream.title);

            let resolutionLabel;
            if (resolution === '2160p' || stream.quality === '4K') {
                resolutionLabel = '4k';
            } else if (resolution === '1080p') {
                resolutionLabel = '1080p';
            } else if (resolution === '720p') {
                resolutionLabel = '720p';
            } else if (resolution === '480p') {
                resolutionLabel = '480p';
            } else {
                resolutionLabel = 'HD';
            }

            return {
                name: `[HS+] Sootio\n${resolutionLabel}`,
                title: `${stream.title}${renderLanguageFlags(detectedLanguages)}\nHydraflix`,
                url: stream.url ? encodeUrlForStreaming(stream.url) : stream.url,
                behaviorHints: {
                    bingeGroup: 'hydraflix-streams'
                }
            };
        });

        console.log(`[Hydraflix] Returning ${streams.length} streams`);
        return streams;

    } catch (error) {
        console.error(`[Hydraflix] Error getting streams:`, error.message);
        return [];
    }
}
