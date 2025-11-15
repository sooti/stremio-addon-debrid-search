/**
 * Hydraflix Search Module
 * Handles searching and parsing of Hydraflix content
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { removeYear, cleanTitle } from '../../utils/parsing.js';

const BASE_URL = 'https://www.hydraflix.cc';

/**
 * Normalizes image URLs to absolute URLs
 * @param {string} url - Image URL to normalize
 * @returns {string} Normalized URL
 */
function normalizeImageUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return BASE_URL + url;
    if (url.startsWith('data:')) return ''; // Skip base64 images
    return url;
}

/**
 * Generates ID from URL
 * @param {string} url - URL to generate ID from
 * @returns {string} Generated ID
 */
function generateIdFromUrl(url) {
    try {
        const urlParts = url.split('/');
        const relevantPart = urlParts.find(part =>
            part.length > 3 && !part.includes('hydraflix') && !part.includes('www')
        );
        return relevantPart ? relevantPart.replace(/[^a-zA-Z0-9-]/g, '') : '';
    } catch {
        return '';
    }
}

/**
 * Determines content type from metadata
 * @param {string} metaText - Metadata text
 * @returns {string} Content type ('series' or 'movie')
 */
function determineContentType(metaText) {
    const lowerText = metaText.toLowerCase();
    // Check for series indicators
    if (lowerText.includes('ss') || lowerText.includes('season') || lowerText.includes('episode')) {
        return 'series';
    }
    return 'movie';
}

/**
 * Scrapes Hydraflix search results
 * @param {string} searchQuery - Search query
 * @returns {Promise<Array>} Array of search results
 */
export async function scrapeHydraflixSearch(searchQuery) {
    try {
        console.log(`[Hydraflix] Searching for: "${searchQuery}"`);

        // Multiple search strategies to get more results
        const searchStrategies = [
            { query: searchQuery, name: 'primary' },
            { query: removeYear(searchQuery), name: 'no-year' },
            { query: searchQuery.split(' ').slice(0, 3).join(' '), name: 'first-three-words' },
            { query: cleanTitle(searchQuery), name: 'clean-title' }
        ];

        // Remove duplicate queries and filter empty ones
        const uniqueStrategies = [];
        const seenQueries = new Set();
        for (const strategy of searchStrategies) {
            if (strategy.query && !seenQueries.has(strategy.query.toLowerCase())) {
                seenQueries.add(strategy.query.toLowerCase());
                uniqueStrategies.push(strategy);
            }
        }

        // Try all search strategies in parallel to improve performance
        const searchPromises = uniqueStrategies.map(async (strategy, index) => {
            try {
                const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(strategy.query)}`;

                console.log(`[Hydraflix] Searching with ${strategy.name} query: "${strategy.query}"`);
                console.log(`[Hydraflix] Search URL: ${searchUrl}`);

                const response = await makeRequest(searchUrl, {
                    parseHTML: true,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Referer': BASE_URL + '/',
                    }
                });

                if (response.statusCode === 200) {
                    const results = await parseSearchResults(response.document);
                    console.log(`[Hydraflix] Got ${results.length} results from ${strategy.name} search`);
                    return results;
                } else {
                    console.log(`[Hydraflix] Search with ${strategy.name} query failed with status: ${response.statusCode}`);
                    return [];
                }
            } catch (strategyError) {
                console.log(`[Hydraflix] Search strategy ${strategy.name} failed:`, strategyError.message);
                return [];
            }
        });

        // Wait for all search promises to complete
        const searchResults = await Promise.all(searchPromises);
        let allResults = [];
        for (const results of searchResults) {
            allResults = allResults.concat(results);
        }

        // Remove duplicate results based on title
        const uniqueResults = [];
        const seenTitles = new Set();
        for (const result of allResults) {
            const titleKey = result.title.toLowerCase();
            if (!seenTitles.has(titleKey)) {
                seenTitles.add(titleKey);
                uniqueResults.push(result);
            }
        }

        console.log(`[Hydraflix] Total unique results from all strategies: ${uniqueResults.length}`);
        return uniqueResults;
    } catch (error) {
        console.error('[Hydraflix] Error scraping search results:', error);
        throw error;
    }
}

/**
 * Helper function to parse search results from HTML
 * @param {Object} $ - Cheerio instance
 * @returns {Promise<Array>} Array of parsed items
 */
async function parseSearchResults($) {
    const items = [];

    // Hydraflix uses .post class for each result item
    const $elements = $('.post');

    if ($elements.length === 0) {
        console.log('[Hydraflix] No results found');
        return items;
    }

    console.log(`[Hydraflix] Found ${$elements.length} results`);

    $elements.each((index, element) => {
        const $element = $(element);

        // Structure: .post > .poster > a (with href) > img (with alt=title)
        const $posterLink = $element.find('.poster a').first();
        const postUrl = $posterLink.attr('href');

        const $img = $posterLink.find('img').first();
        const title = $img.attr('alt') || '';

        // Extract image URL from data-src or src
        let imageUrl = $img.attr('data-src') || $img.attr('src') || '';
        imageUrl = normalizeImageUrl(imageUrl);

        // Extract metadata from .meta div
        const $meta = $element.find('.meta');
        const metaText = $meta.text();

        // Extract year from meta (first span usually contains year)
        let year = undefined;
        const $firstSpan = $meta.find('span').first();
        const yearText = $firstSpan.text().trim();
        const yearMatch = yearText.match(/\b(19|20)\d{2}\b/);
        if (yearMatch) {
            year = yearMatch[0];
        }

        // Determine content type from metadata (SS = series, otherwise movie)
        let type = 'movie';
        if (metaText.includes('SS') || metaText.includes('EP')) {
            type = 'series';
        }

        // Extract quality from metadata if present
        const qualityMatch = metaText.match(/\b(SD|HD|4K|CAM|TS)\b/i);
        const quality = qualityMatch ? qualityMatch[0] : undefined;

        if (title && postUrl) {
            // Make postUrl absolute if it's relative
            const absolutePostUrl = postUrl.startsWith('http') ? postUrl : `${BASE_URL}${postUrl.startsWith('/') ? '' : '/'}${postUrl}`;

            // Generate ID from URL
            const id = generateIdFromUrl(absolutePostUrl) || `hydraflix-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            items.push({
                id,
                title,
                imageUrl: imageUrl || '',
                postUrl: absolutePostUrl,
                year,
                quality,
                type,
                url: absolutePostUrl  // Add alias for compatibility
            });
        } else {
            console.log('[Hydraflix] Skipping incomplete item:', {
                hasTitle: !!title,
                hasUrl: !!postUrl,
                element: $element.attr('id')
            });
        }
    });

    console.log(`[Hydraflix] Successfully parsed ${items.length} search results`);
    return items;
}

/**
 * Loads content from a Hydraflix page
 * @param {string} url - Page URL
 * @returns {Promise<Object>} Parsed content
 */
export async function loadContent(url) {
    try {
        console.log(`[Hydraflix] Loading content from: ${url}`);

        const response = await makeRequest(url, {
            parseHTML: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Referer': BASE_URL + '/',
            }
        });

        if (response.statusCode !== 200) {
            throw new Error(`Failed to load content: HTTP ${response.statusCode}`);
        }

        const $ = response.document;

        // Extract basic information
        const title = $('h1, .entry-title, .page-title').first().text().split('(')[0].trim() || '';
        const poster = $('meta[property="og:image"]').attr('content') ||
                      $('img.wp-post-image').first().attr('src') || '';
        const description = $('meta[property="og:description"]').attr('content') ||
                           $('.entry-content p').first().text().trim() || '';

        // Extract year
        const yearText = $('.year, .date, .post-date').first().text();
        const yearMatch = yearText.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0]) : null;

        // Extract genres/tags
        const tags = [];
        $('a[rel="category tag"], .genre a, .genres a').each((i, el) => {
            const tag = $(el).text().trim();
            if (tag) tags.push(tag);
        });

        // Check if it's a movie or series
        const isMovie = !tags.some(tag => tag.toLowerCase().includes('tv')) &&
                       !title.toLowerCase().includes('season');

        // Try to find streaming/download links
        let streamLinks = [];

        // Look for iframe sources (common for streaming sites)
        $('iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src && src.trim()) {
                streamLinks.push(src);
            }
        });

        // Look for direct links
        $('a[href*="stream"], a[href*="player"], a[href*="embed"], .download-link a, .stream-link a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.trim() && !href.startsWith('#')) {
                streamLinks.push(href);
            }
        });

        const content = {
            title,
            poster,
            tags,
            year,
            description,
            type: isMovie ? 'movie' : 'series',
            streamLinks: [...new Set(streamLinks)] // Remove duplicates
        };

        if (isMovie) {
            console.log(`[Hydraflix] Found movie with ${content.streamLinks.length} stream links`);
            return content;
        } else {
            // Handle TV series - extract TMDB ID and server data
            console.log('[Hydraflix] Parsing TV series data...');

            // Extract TMDB TV ID from the Episodes JavaScript variable
            const htmlText = $.html();
            const episodesVarMatch = htmlText.match(/var Episodes\s*=\s*({[^;]+});/);

            let tmdbId = null;
            let servers = [];

            if (episodesVarMatch) {
                try {
                    const episodesData = JSON.parse(episodesVarMatch[1]);
                    tmdbId = episodesData.tvid;
                    console.log(`[Hydraflix] Found TMDB ID: ${tmdbId}`);
                } catch (e) {
                    console.log(`[Hydraflix] Failed to parse Episodes variable:`, e.message);
                }
            }

            // Extract server/embed information from the page
            $('.server, li.server').each((i, el) => {
                const $el = $(el);
                const embedId = $el.attr('data-load-embed');
                const embedHost = $el.attr('data-load-embed-host');
                const serverName = $el.find('span').text().trim() || `Server ${i + 1}`;

                if (embedId && embedHost) {
                    servers.push({
                        embedId,
                        embedHost,
                        name: serverName
                    });
                }
            });

            console.log(`[Hydraflix] Found ${servers.length} servers, TMDB ID: ${tmdbId}`);

            content.tmdbId = tmdbId;
            content.servers = servers;
            content.embedId = servers.length > 0 ? servers[0].embedId : tmdbId;

            // Since Hydraflix loads episodes dynamically via TMDB API,
            // we'll return the tmdbId and let the streams function handle episode generation
            content.episodes = []; // Will be populated based on requested season/episode
            return content;
        }
    } catch (error) {
        console.error('[Hydraflix] Error loading content:', error);
        throw error;
    }
}
