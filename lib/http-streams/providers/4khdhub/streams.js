/**
 * 4KHDHub Streams Module
 * Handles fetching and processing streams from 4KHDHub
 */

import Cinemeta from '../../../util/cinemeta.js';
import { scrape4KHDHubSearch, loadContent } from './search.js';
import { extractStreamingLinks } from './extraction.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { getResolutionFromName, removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';
import { validateUrl, validateSeekableUrl } from '../../utils/validation.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';

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
        console.log(`[4KHDHub] Movie year mismatch: found ${content.year}, expected ${expectedYear} (or within 1 year)`);
        return false;
    }
}

/**
 * Gets streams from 4KHDHub
 * @param {string} tmdbId - TMDB ID
 * @param {string} type - Content type ('movie' or 'series')
 * @param {number} season - Season number (for series)
 * @param {number} episode - Episode number (for series)
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} Array of streams
 */
export async function get4KHDHubStreams(tmdbId, type, season = null, episode = null, config) {
    try {
        console.log(`[4KHDHub] Starting search for TMDB ID: ${tmdbId}, Type: ${type}${season ? `, Season: ${season}` : ''}${episode ? `, Episode: ${episode}` : ''}`);

        let streamingLinks = [];
        let pageLanguages = []; // Store languages from the page badge - must be declared here for scope

        // Get TMDB details to get the actual title
        const cinemetaDetails = await Cinemeta.getMeta(type, tmdbId);
        if (!cinemetaDetails) {
            console.log(`[4KHDHub] Could not fetch TMDB details for ID: ${tmdbId}`);
            return [];
        }

        const year = cinemetaDetails.year ? parseInt(cinemetaDetails.year.split('-')[0]) : null;

        console.log(`[4KHDHub] TMDB Details: ${cinemetaDetails.name} (${year || 'N/A'})`);

        // PERFORMANCE FIX: Run all search strategies in parallel instead of sequentially
        // This reduces search time from 5-10+ seconds to ~1-2 seconds
        console.log(`[4KHDHub] Running parallel searches with multiple strategies...`);

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

        console.log(`[4KHDHub] Executing ${searchQueries.length} parallel searches...`);

        // Execute all searches in parallel
        const searchPromises = searchQueries.map(async ({ query, strategy }) => {
            try {
                const results = await scrape4KHDHubSearch(query);
                console.log(`[4KHDHub] ${strategy} search "${query}" found ${results.length} results`);
                return { query, strategy, results };
            } catch (err) {
                console.log(`[4KHDHub] ${strategy} search "${query}" failed: ${err.message}`);
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
                    console.log(`[4KHDHub] Best match from ${strategy} search "${query}" (score: ${scoreDisplay})`);
                }
            }
        }

        if (searchResults.length === 0) {
            console.log(`[4KHDHub] No search results found for any query variation`);
            return [];
        }

        if (!bestMatch) {
            console.log(`[4KHDHub] No suitable match found for: ${cinemetaDetails.name}`);
            return [];
        }

        let downloadLinks = [];
        // pageLanguages is already declared at function level

        if (type === 'movie') {
            // PERFORMANCE FIX: Limit year validation attempts to top 5 matches to avoid wasting time
            const MAX_YEAR_VALIDATION_ATTEMPTS = 5;
            let validMatch = null;
            const matchesToTry = sortedMatches.slice(0, MAX_YEAR_VALIDATION_ATTEMPTS);

            console.log(`[4KHDHub] Trying year validation for top ${matchesToTry.length} matches (out of ${sortedMatches.length} total)`);

            for (const match of matchesToTry) {
                const scoreDisplay = (match.score !== undefined && match.score !== null) ? match.score.toFixed(1) : 'N/A';
                console.log(`[4KHDHub] Trying match: ${match.title} (score: ${scoreDisplay})`);
                const content = await loadContent(match.url || match.postUrl);

                if (validateMovieYear(content, year)) {
                    validMatch = match;
                    downloadLinks = content.downloadLinks || [];
                    pageLanguages = content.languages || []; // Preserve page-level languages
                    console.log(`[4KHDHub] Year validation passed for ${content.title}, using this match`);
                    console.log(`[4KHDHub] Page languages from badge:`, pageLanguages);
                    break;
                } else {
                    console.log(`[4KHDHub] Movie year validation failed for ${content.title}, trying next match...`);
                }
            }

            if (!validMatch) {
                console.log(`[4KHDHub] No match passed year validation after trying ${matchesToTry.length} matches`);
                return [];
            }
        } else if ((type === 'series' || type === 'tv') && season && episode) {
            const content = await loadContent(bestMatch.url || bestMatch.postUrl);
            pageLanguages = content.languages || []; // Preserve page-level languages
            console.log(`[4KHDHub] Page languages from badge:`, pageLanguages);
            console.log(`[4KHDHub] Looking for Season ${season}, Episode ${episode}`);
            console.log(`[4KHDHub] Available episodes:`, content.episodes?.map(ep => `S${ep.season}E${ep.episode} (${ep.downloadLinks?.length || 0} links)`));

            const targetEpisode = content.episodes?.find(ep =>
                ep.season === parseInt(season) && ep.episode === parseInt(episode)
            );

            if (targetEpisode) {
                console.log(`[4KHDHub] Found target episode S${targetEpisode.season}E${targetEpisode.episode} with ${targetEpisode.downloadLinks?.length || 0} links`);
                downloadLinks = targetEpisode.downloadLinks || [];
            } else {
                console.log(`[4KHDHub] Target episode S${season}E${episode} not found`);
            }
        }

        if (downloadLinks.length === 0) {
            console.log(`[4KHDHub] No download links found`);
            return [];
        }

        // Optimized extraction: parallel processing with smart prioritization
        console.log(`[4KHDHub] Found ${downloadLinks.length} redirect URLs, extracting final streams...`);

        // IMPROVED: Increased from 10 to 25 to get more quality options
        const MAX_WORKING_LINKS = parseInt(process.env.MAX_4KHDHUB_LINKS) || 25;
        const PARALLEL_BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 8; // Increased from 5 to 8 for faster processing

        streamingLinks = [];

        // OPTIMIZATION: Prioritize links that are more likely to have higher quality
        // Move HubCloud and direct CDN links to the front
        const prioritizedLinks = [...downloadLinks].sort((a, b) => {
            const aPriority = a.toLowerCase().includes('hubcloud') || a.toLowerCase().includes('pixel') ? 0 :
                a.toLowerCase().includes('hubdrive') ? 1 :
                    a.toLowerCase().includes('workers.dev') ? 2 : 3;
            const bPriority = b.toLowerCase().includes('hubcloud') || b.toLowerCase().includes('pixel') ? 0 :
                b.toLowerCase().includes('hubdrive') ? 1 :
                    b.toLowerCase().includes('workers.dev') ? 2 : 3;
            return aPriority - bPriority;
        });

        console.log(`[4KHDHub] Link prioritization: HubCloud/Pixel first, then HubDrive, then Workers.dev`);

        // Process in batches for parallel execution
        for (let i = 0; i < prioritizedLinks.length && streamingLinks.length < MAX_WORKING_LINKS; i += PARALLEL_BATCH_SIZE) {
            const batch = prioritizedLinks.slice(i, i + PARALLEL_BATCH_SIZE);
            console.log(`[4KHDHub] Processing batch ${Math.floor(i / PARALLEL_BATCH_SIZE) + 1} (${batch.length} links)...`);

            // Process batch in parallel
            const batchPromises = batch.map(async (link) => {
                try {
                    const extracted = await extractStreamingLinks([link]);
                    return extracted; // Array of extracted streams
                } catch (err) {
                    console.log(`[4KHDHub] Failed to extract link: ${err.message}`);
                    return [];
                }
            });

            const batchResults = await Promise.all(batchPromises);

            // Flatten and add to streamingLinks
            for (const result of batchResults) {
                streamingLinks.push(...result);
                // IMPROVED: Only stop early if we have enough 4K streams OR reached max
                const has4K = streamingLinks.some(s => {
                    const title = (s.title || s.name || '').toLowerCase();
                    return title.includes('2160p') || title.includes('4k');
                });

                if (streamingLinks.length >= MAX_WORKING_LINKS && has4K) {
                    console.log(`[4KHDHub] Reached ${MAX_WORKING_LINKS} working links with 4K content, stopping early`);
                    break;
                }
            }
        }

        console.log(`[4KHDHub] Extracted ${streamingLinks.length} working stream(s)`);

        // Filter out suspicious AMP/redirect URLs
        const filteredLinks = streamingLinks.filter(link => {
            const url = link.url.toLowerCase();
            const suspiciousPatterns = [
                'www-google-com.cdn.ampproject.org',
                'bloggingvector.shop',
                'cdn.ampproject.org',
            ];

            const isSuspicious = suspiciousPatterns.some(pattern => url.includes(pattern));
            if (isSuspicious) {
                console.log(`[4KHDHub] Filtered out suspicious URL: ${link.url}`);
                return false;
            }
            return true;
        });

        // Remove duplicates based on URL
        const uniqueLinks = [];
        const seenUrls = new Set();

        for (const link of filteredLinks) {
            if (!seenUrls.has(link.url)) {
                seenUrls.add(link.url);
                uniqueLinks.push(link);
            }
        }

        console.log(`[4KHDHub] After URL dedup: ${uniqueLinks.length} unique links (${streamingLinks.length - filteredLinks.length} suspicious URLs filtered, ${filteredLinks.length - uniqueLinks.length} duplicates removed)`);

        // Skip quality-based deduplication - keep all unique URLs
        console.log(`[4KHDHub] Skipping quality dedup, keeping all ${uniqueLinks.length} unique URLs`);

        // Validate URLs if DISABLE_4KHDHUB_URL_VALIDATION is false
        let validatedLinks = uniqueLinks;
        const disableValidation = process.env.DISABLE_4KHDHUB_URL_VALIDATION === 'true';

        if (!disableValidation) {
            // Check if seeking validation is specifically disabled (by default it's enabled)
            const enableSeekValidation = process.env.DISABLE_4KHDHUB_SEEK_VALIDATION !== 'true';

            console.log(`[4KHDHub] URL validation enabled, validating ${uniqueLinks.length} links...`);
            console.log(`[4KHDHub] Seek validation ${enableSeekValidation ? 'enabled' : 'disabled'}`);

            // Group links by hostname to identify trusted hosts that can skip validation
            const trustedHosts = [];
            const otherLinks = [];

            for (const link of uniqueLinks) {
                try {
                    const urlObj = new URL(link.url);
                    const hostname = urlObj.hostname;

                    // Check if this host is in the trusted list
                    const isTrustedHost = [
                        'pixeldrain.dev',
                        'pixeldrain.com',
                        'r2.dev',
                        'workers.dev',
                        'hubcdn.fans',
                        'googleusercontent.com'
                    ].some(host => hostname.includes(host));

                    if (isTrustedHost) {
                        trustedHosts.push(link);
                    } else {
                        otherLinks.push(link);
                    }
                } catch {
                    otherLinks.push(link); // If URL is malformed, add to other links for validation
                }
            }

            // For trusted hosts, we can skip validation and immediately return them as valid
            let validatedTrustedLinks = trustedHosts;

            // Validate other links in chunks to avoid overwhelming the system
            let validatedOtherLinks = [];
            if (otherLinks.length > 0) {
                // Process validation in chunks to avoid overwhelming the system
                const chunkSize = 5; // Process 5 validations at a time
                for (let i = 0; i < otherLinks.length; i += chunkSize) {
                    const chunk = otherLinks.slice(i, i + chunkSize);
                    const validationPromises = chunk.map(async (link) => {
                        let result;

                        if (enableSeekValidation) {
                            // Check for seeking capability (range requests)
                            result = await validateSeekableUrl(link.url);
                        } else {
                            // Use basic validation (original behavior)
                            const isValid = await validateUrl(link.url);
                            // Wrap basic validation in same format
                            result = { isValid, filename: null };
                        }

                        if (!result.isValid) return null;

                        // Update title with extracted filename if available, preserving language tags
                        if (result.filename) {
                            // Extract language information from original title
                            const originalLangs = link.title.match(/\b(English|French|Spanish|German|Italian|Portuguese|Russian|Hindi|Japanese|Korean|Chinese|Arabic|Turkish|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Czech|Hungarian|Romanian|Greek|Hebrew|Thai)\b/gi) || [];

                            // Create new title with filename and preserved language tags
                            const langTags = originalLangs.length > 0 ? ' ' + originalLangs.join(' ') : '';
                            const newTitle = result.filename + langTags;

                            console.log(`[4KHDHub] Updating link title from "${link.title}" to "${newTitle}"`);
                            link.title = newTitle;
                        }

                        return link;
                    });

                    const validationResults = await Promise.allSettled(validationPromises);
                    const chunkValidatedLinks = validationResults
                        .filter(result => result.status === 'fulfilled' && result.value !== null)
                        .map(result => result.value);

                    validatedOtherLinks = validatedOtherLinks.concat(chunkValidatedLinks);
                }

                if (enableSeekValidation) {
                    console.log(`[4KHDHub] Seek validation complete: ${validatedOtherLinks.length}/${otherLinks.length} non-trusted links are seekable`);
                } else {
                    console.log(`[4KHDHub] Basic validation complete: ${validatedOtherLinks.length}/${otherLinks.length} non-trusted links are valid`);
                }
            } else {
                console.log(`[4KHDHub] All links from trusted hosts, skipping validation for ${trustedHosts.length} links`);
            }

            validatedLinks = [...validatedTrustedLinks, ...validatedOtherLinks];
            console.log(`[4KHDHub] Total validated links: ${validatedLinks.length}/${uniqueLinks.length}`);
        } else {
            console.log(`[4KHDHub] URL validation disabled, skipping validation`);
        }

        // Convert to Stremio format
        const streams = validatedLinks.map(link => {
            let resolution = getResolutionFromName(link.title);
            // Add resolution assumption logic if no resolution is found in title
            if (resolution === 'other') {
                const titleLower = link.title.toLowerCase();
                // Only assume resolution based on codec if no specific resolution was found in the title
                if (titleLower.includes('h265') || titleLower.includes('hevc')) {
                    resolution = '2160p'; // assume 4K for H265/HEVC only if no specific resolution found
                } else if (titleLower.includes('h264')) {
                    resolution = '1080p'; // assume 1080p for H264 only if no specific resolution found
                } else {
                    resolution = '1080p'; // default assumption
                }
            }
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
            const size = link.size || 'N/A';
            // Use page-level languages from badge if available, otherwise detect from title
            let detectedLanguages;

            if (pageLanguages.length > 0) {
                // Use badge languages as primary source
                const titleLanguages = detectLanguagesFromTitle(link.title);
                // Merge badge and title languages, but badge takes priority
                detectedLanguages = [...new Set([...pageLanguages, ...titleLanguages])];
                console.log(`[4KHDHub] Languages - Badge: [${pageLanguages.join(', ')}], Title: [${titleLanguages.join(', ')}], Final: [${detectedLanguages.join(', ')}]`);
            } else {
                // No badge languages found, use title detection
                detectedLanguages = detectLanguagesFromTitle(link.title);
                console.log(`[4KHDHub] Using title-detected languages: [${detectedLanguages.join(', ')}]`);
            }

            // Convert size string to bytes for filtering
            let sizeInBytes = 0;
            if (link.size && typeof link.size === 'string') {
                const sizeMatch = link.size.match(/([\d.]+)\s*(GB|MB|TB)/i);
                if (sizeMatch) {
                    const value = parseFloat(sizeMatch[1]);
                    const unit = sizeMatch[2].toUpperCase();
                    if (unit === 'GB') {
                        sizeInBytes = value * 1024 * 1024 * 1024;
                    } else if (unit === 'MB') {
                        sizeInBytes = value * 1024 * 1024;
                    } else if (unit === 'TB') {
                        sizeInBytes = value * 1024 * 1024 * 1024 * 1024;
                    }
                }
            }

            return {
                name: `[HS+] Sootio\n${resolutionLabel}`,
                title: `${link.title}${renderLanguageFlags(detectedLanguages)}\n💾 ${size} | 4KHDHub`,
                url: link.url ? encodeUrlForStreaming(link.url) : link.url,
                _size: sizeInBytes,  // Preserve size in bytes for filtering
                behaviorHints: {
                    bingeGroup: '4khdhub-streams'
                },
                size: link.size,
                resolution: resolution
            }
        });

        // Sort by resolution first, then by size within each resolution group
        streams.sort((a, b) => {
            // Map resolution to numeric value for sorting (higher resolutions first)
            const resolutionPriority = {
                '2160p': 4,
                '1440p': 3,
                '1080p': 2,
                '720p': 1,
                '480p': 0,
                'other': -1
            };

            const resolutionA = resolutionPriority[a.resolution] || 0;
            const resolutionB = resolutionPriority[b.resolution] || 0;

            // If resolutions are different, sort by resolution (higher first)
            if (resolutionA !== resolutionB) {
                return resolutionB - resolutionA;
            }

            // If resolutions are the same, sort by size (larger first)
            const sizeA = a.size ? parseInt(a.size.replace(/[^0-9]/g, '')) : 0;
            const sizeB = b.size ? parseInt(b.size.replace(/[^0-9]/g, '')) : 0;
            return sizeB - sizeA;
        });

        // Additional episode filtering for series to ensure only requested episode is returned
        if ((type === 'series' || type === 'tv') && season && episode) {
            console.log(`[4KHDHub] Additional episode filtering: requested S${season}E${episode}`);
            const requestedEpisodeRegex = new RegExp(`S0*${parseInt(season)}E0*${parseInt(episode)}|S0*${parseInt(season)}-E0*${parseInt(episode)}|\\b${parseInt(season)}x0*${parseInt(episode)}\\b|Episode[\\s-]*0*${parseInt(episode)}\\b`, 'i');

            const episodeFilteredStreams = streams.filter(stream => {
                // Check if episode information is in the title
                const hasCorrectEpisode = requestedEpisodeRegex.test(stream.title);
                if (hasCorrectEpisode) {
                    console.log(`[4KHDHub] Keeping stream for S${season}E${episode}: ${stream.title}`);
                    return true;
                } else {
                    console.log(`[4KHDHub] Filtering out stream (not S${season}E${episode}): ${stream.title}`);
                    return false;
                }
            });

            console.log(`[4KHDHub] Episode filtering: ${streams.length} -> ${episodeFilteredStreams.length} streams after filtering`);
            console.log(`[4KHDHub] Returning ${episodeFilteredStreams.length} streams`);
            return episodeFilteredStreams;
        }

        console.log(`[4KHDHub] Returning ${streams.length} streams`);
        return streams;

    } catch (error) {
        console.error(`[4KHDHub] Error getting streams:`, error.message);
        return [];
    }
}
