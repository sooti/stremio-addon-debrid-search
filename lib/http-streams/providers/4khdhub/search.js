/**
 * 4KHDHub Search Module
 * Handles searching and parsing of 4KHDHub content
 */

import * as cheerio from 'cheerio';
import { makeRequest, getDomains } from '../../utils/http.js';
import { removeYear, cleanTitle } from '../../utils/parsing.js';

/**
 * Normalizes image URLs to absolute URLs
 * @param {string} url - Image URL to normalize
 * @returns {Promise<string>} Normalized URL
 */
async function normalizeImageUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) {
        const domains = await getDomains();
        const baseUrl = domains?.['4khdhub'] || '';
        return baseUrl + url;
    }
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
            part.length > 5 && !part.includes('4khdhub') && !part.includes('fans')
        );
        return relevantPart ? relevantPart.replace(/[^a-zA-Z0-9-]/g, '') : '';
    } catch {
        return '';
    }
}

/**
 * Determines content type from format tags
 * @param {Array<string>} formats - Format tags
 * @returns {string} Content type ('Series' or 'Movie')
 */
function determineContentType(formats) {
    if (formats.some(format => format.toLowerCase().includes('series'))) {
        return 'Series';
    }
    return 'Movie';
}

/**
 * Extracts just the filename from verbose metadata text
 * @param {string} text - Verbose text containing filename and metadata
 * @returns {string} Extracted filename or original text if not found
 */
export function extractFilename(text) {
    if (!text) return text;

    // Match filenames that can contain spaces, dots, brackets, etc.
    // Starts with capital letter or digit, ends with video extension
    // Includes: letters, numbers, spaces, dots, dashes, brackets, parentheses
    const regex = /([A-Z0-9][\w\s.\-\[\]\(\):+,&~'!]+\.(?:mkv|mp4|avi|webm|ts|m2ts|mpg|mpeg|mov|wmv|flv|m4v))/gi;

    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        // Trim any leading/trailing whitespace from the match
        const trimmed = match[1].trim();
        matches.push(trimmed);
    }

    if (matches.length > 0) {
        // Score each match to find the best filename
        const scored = matches.map(filename => {
            let score = filename.length; // Base score on length

            // Strongly prefer filenames with quality markers
            if (/\b(2160p|1080p|720p|480p|4K|UHD)\b/i.test(filename)) score += 1000;

            // Prefer filenames with year
            if (/\b(19|20)\d{2}\b/.test(filename)) score += 500;

            // Prefer filenames with common release patterns
            if (/\b(WEB-DL|WEBRip|BluRay|BRRip|HDTV|HEVC|H\.?265|H\.?264|x265|x264)\b/i.test(filename)) score += 300;

            // Prefer filenames with episode markers (for series)
            if (/\b(S\d{2}E\d{2}|S\d{2}\s+E\d{2}|Chapter|Episode)\b/i.test(filename)) score += 200;

            // Penalize very short filenames (likely just fragments like "ESub.mkv")
            if (filename.length < 20) score -= 500;

            // Strongly penalize filenames that are just release group names or fragments
            // Common release groups: FGT, FraMeSToR, SHORTBREHD, ESub, Joy, Telly, Strange, etc.
            if (/^(ESub|FGT|SHORTBREHD|Strange|Joy|Telly|FraMeSToR|YIFY|RARBG|PSA|EVO|ION10|AMZN|NF)[\s\[\]]*\.mkv$/i.test(filename)) {
                score -= 2000;
            }

            // Penalize filenames that are just a word + brackets + extension (e.g., "Joy [Strange].mkv")
            if (/^[A-Za-z]+\s*\[[^\]]+\]\.mkv$/i.test(filename)) {
                score -= 1500;
            }

            // Penalize single-word filenames (just group name)
            if (/^[A-Za-z]+\.mkv$/i.test(filename) && filename.length < 25) {
                score -= 1500;
            }

            return { filename, score };
        });

        // Sort by score (highest first) and pick the best
        scored.sort((a, b) => b.score - a.score);
        const bestMatch = scored[0].filename;

        console.log(`[4KHDHub] Extracted filename: "${bestMatch}" (score: ${scored[0].score}) from ${matches.length} candidates`);
        return bestMatch;
    }

    // Fallback: if no extension found, return the original text
    return text;
}

const VIDEO_EXTENSION_REGEX = /\.(mkv|mp4|avi|webm|ts|m2ts|mpg|mpeg|mov|wmv|flv|m4v)/i;

/**
 * Attempts to surface the canonical dot-separated release name from a verbose label.
 * Falls back to replacing whitespace with dots if no clean substring is found.
 * @param {string} label - Raw label extracted from the page
 * @returns {string} More readable release name (includes extension)
 */
export function simplifyReleaseLabel(label) {
    if (!label) return label;

    const dotSequenceRegex = /([A-Za-z0-9][A-Za-z0-9.\-]+?\.(?:mkv|mp4|avi|webm|ts|m2ts|mpg|mpeg|mov|wmv|flv|m4v))/gi;
    const dotMatches = [];
    let dotMatch;
    while ((dotMatch = dotSequenceRegex.exec(label)) !== null) {
        dotMatches.push(dotMatch[1]);
    }

    if (dotMatches.length > 0) {
        dotMatches.sort((a, b) => {
            const dotScoreA = (a.match(/\./g)?.length || 0);
            const dotScoreB = (b.match(/\./g)?.length || 0);
            if (dotScoreB !== dotScoreA) {
                return dotScoreB - dotScoreA;
            }
            return b.length - a.length;
        });
        const bestDotMatch = dotMatches[0];
        if ((bestDotMatch.match(/\./g)?.length || 0) >= 2 || bestDotMatch.length > 40) {
            return bestDotMatch;
        }
    }

    const match = label.match(VIDEO_EXTENSION_REGEX);
    const extension = match ? match[1].toLowerCase() : null;
    const baseStart = match ? label.slice(0, match.index) : label;
    const base = baseStart
        .trim()
        .replace(/[-~]/g, ' ') // standardize separators before dot-ification
        .replace(/\s+/g, ' ')
        .trim();

    const sanitized = base
        .replace(/[^A-Za-z0-9]+/g, '.')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+|\.+$/g, '');

    if (!sanitized) {
        return extension ? `${base}.${extension}` : base;
    }

    return extension ? `${sanitized}.${extension}` : sanitized;
}

/**
 * Scrapes 4KHDHub search results
 * @param {string} searchQuery - Search query
 * @returns {Promise<Array>} Array of search results
 */
export async function scrape4KHDHubSearch(searchQuery) {
    try {
        const domains = await getDomains();
        if (!domains || !domains['4khdhub']) {
            throw new Error('Failed to get domain information');
        }

        const baseUrl = domains['4khdhub'];

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
                const searchUrl = `${baseUrl}/?s=${encodeURIComponent(strategy.query)}`;

                console.log(`Searching 4KHDHub with ${strategy.name} query: "${strategy.query}"`);
                console.log(`Search URL: ${searchUrl}`);

                const response = await makeRequest(searchUrl, {
                    parseHTML: true,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Referer': baseUrl + '/',
                    }
                });

                if (response.statusCode === 200) {
                    const results = await parseMovieCards(response.document, baseUrl);
                    console.log(`Got ${results.length} results from ${strategy.name} search`);
                    return results;
                } else {
                    console.log(`Search with ${strategy.name} query failed with status: ${response.statusCode}`);
                    return [];
                }
            } catch (strategyError) {
                console.log(`Search strategy ${strategy.name} failed:`, strategyError.message);
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

        console.log(`Total unique results from all strategies: ${uniqueResults.length}`);
        return uniqueResults;
    } catch (error) {
        console.error('Error scraping 4KHDHub search results:', error);
        throw error;
    }
}

/**
 * Helper function to parse movie cards from HTML
 * @param {Object} $ - Cheerio instance
 * @param {string} baseUrl - Base URL
 * @returns {Promise<Array>} Array of parsed items
 */
async function parseMovieCards($, baseUrl) {
    const items = [];

    // Process movie cards from .card-grid .movie-card elements
    $('.card-grid .movie-card').each((index, element) => {
        const $element = $(element);

        // Extract post URL from the anchor tag
        const postUrl = $element.attr('href');

        // Extract image from .movie-card-image img
        let imageUrl = $element.find('.movie-card-image img').attr('src');
        if (imageUrl) {
            imageUrl = normalizeImageUrl(imageUrl);
        }

        // Extract alt text from img
        const altText = $element.find('.movie-card-image img').attr('alt') || '';

        // Extract title from .movie-card-title
        const title = $element.find('.movie-card-title').text().trim();

        // Extract metadata from .movie-card-meta
        const metaText = $element.find('.movie-card-meta').text().trim();

        // Extract year and season info from meta text
        let year = undefined;
        let season = undefined;

        // Parse year (4-digit number)
        const yearMatch = metaText.match(/(\d{4})/);
        if (yearMatch) {
            year = yearMatch[1];
        }

        // Parse season info (S01-S02, S01, etc.)
        const seasonMatch = metaText.match(/S\d+(?:-S\d+)?/);
        if (seasonMatch) {
            season = seasonMatch[0];
        }

        // Extract formats from .movie-card-format spans
        const formats = [];
        $element.find('.movie-card-format').each((_, formatElement) => {
            const format = $(formatElement).text().trim();
            if (format) {
                formats.push(format);
            }
        });

        // Determine content type
        const type = determineContentType(formats);

        if (title && postUrl) {
            // Make postUrl absolute if it's relative
            const absolutePostUrl = postUrl.startsWith('http') ? postUrl : `${baseUrl}${postUrl.startsWith('/') ? '' : '/'}${postUrl}`;

            // Generate ID from URL
            const id = generateIdFromUrl(absolutePostUrl) || `4khdhub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            items.push({
                id,
                title,
                imageUrl: imageUrl || '',
                postUrl: absolutePostUrl,
                year,
                season,
                altText,
                formats,
                type: type.toLowerCase()
            });
        } else {
            console.log('Skipping incomplete item:', {
                hasTitle: !!title,
                hasUrl: !!postUrl,
                hasImage: !!imageUrl
            });
        }
    });

    console.log(`Successfully parsed ${items.length} movie cards`);
    return items;
}

/**
 * Loads content from a 4KHDHub page
 * @param {string} url - Page URL
 * @returns {Promise<Object>} Parsed content
 */
export function loadContent(url) {
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const $ = response.document;
            const title = $('h1.page-title').text().split('(')[0].trim() || '';
            const poster = $('meta[property="og:image"]').attr('content') || '';
            const tags = $('div.mt-2 span.badge').get().map(el => $(el).text());
            const year = parseInt($('div.mt-2 span').text()) || null;
            const description = $('div.content-section p.mt-4').text().trim() || '';
            const trailer = $('#trailer-btn').attr('data-trailer-url') || '';

            // Extract language information from badges
            let languages = [];

            // Debug: log all badges found on the page
            console.log(`[4KHDHub] Scanning for language badges...`);
            const allBadges = $('span.badge');
            console.log(`[4KHDHub] Found ${allBadges.length} total badges on page`);

            // Try multiple approaches to find language badge
            // 1. Try by style attribute with teal color
            const tealBadges = $('span.badge').filter((i, el) => {
                const style = $(el).attr('style') || '';
                return style.includes('#0d9488') || style.includes('rgb(13, 148, 136)');
            });

            if (tealBadges.length > 0) {
                const languageText = tealBadges.first().text().trim();
                console.log(`[4KHDHub] Found teal badge: "${languageText}"`);
                languages = languageText.split(',').map(lang => lang.trim().toLowerCase()).filter(Boolean);
            }

            // 2. Fallback: search all badges for language-related text
            if (languages.length === 0) {
                console.log(`[4KHDHub] No teal badge found, searching all badges for language info...`);
                $('span.badge').each((i, el) => {
                    const text = $(el).text().trim();
                    const style = $(el).attr('style') || '';
                    console.log(`[4KHDHub] Badge ${i + 1}: "${text}" (style: "${style}")`);

                    // Check if this badge contains language names
                    if (text.match(/hindi|english|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|gujarati|urdu|spanish|french|german|italian|portuguese|chinese|japanese|korean|russian|arabic|dual|multi/i)) {
                        console.log(`[4KHDHub] ✓ Badge ${i + 1} contains language info`);
                        const langs = text.split(',').map(lang => lang.trim().toLowerCase()).filter(Boolean);
                        languages.push(...langs);
                    }
                });
                languages = [...new Set(languages)]; // Remove duplicates
            }

            console.log(`[4KHDHub] Final extracted languages from badges:`, languages);

            const isMovie = tags.includes('Movies');

            // Extract download links with size and quality information
            let downloadLinksWithMetadata = [];

            // Look for download-item divs which contain the link and metadata
            const downloadItems = $('div.download-item');
            console.log(`[4KHDHub] Found ${downloadItems.length} download items`);

            downloadItems.each((i, item) => {
                const $item = $(item);
                const $link = $item.find('a').first();
                const url = $link.attr('href');

                if (!url || !url.trim()) {
                    return;
                }

                // Accept all download links - extraction.js will route them correctly
                // (redirect URLs like gadgetsweb.xyz don't have "hubdrive" in them yet)

                // Extract metadata from the download item
                const itemText = $item.text().trim();
                const linkText = $link.text().trim();

                // Look for size patterns (e.g., "2.5 GB", "500 MB")
                let size = null;
                const sizeMatch = itemText.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
                if (sizeMatch) {
                    size = `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
                }

                // Look for quality patterns (e.g., "2160p", "1080p", "720p", "4K")
                let quality = null;
                const qualityMatch = itemText.match(/(\d{3,4}p|4K|2K)/i);
                if (qualityMatch) {
                    quality = qualityMatch[1];
                }

                // Extract label from the item text, removing button text like "Download HubCloud"
                // Clean up the text first - remove excessive whitespace and newlines
                let cleanedText = itemText.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

                // Remove common button text patterns
                cleanedText = cleanedText.replace(/Download\s+(HubCloud|HubDrive|FSL\s*Server|FSLv?2?\s*Server|Mega|PixelServer)/gi, '').trim();

                // Extract just the filename from the verbose metadata
                let label = extractFilename(cleanedText);

                // If no filename found with extension, try previous approach
                if (label === cleanedText) {
                    // Try to extract filename-like text (usually before quality/size info)
                    const filenameMatch = cleanedText.match(/^([^[\]]+?)(?:\[|$)/);
                    if (filenameMatch && filenameMatch[1].trim().length > 10) {
                        // Found a potential filename - clean it further
                        label = filenameMatch[1].trim().replace(/\s+/g, ' ');
                    } else if (quality || size) {
                        // If no filename found, build label from quality and size
                        const parts = [];
                        if (quality) parts.push(quality);
                        if (size) parts.push(size);
                        label = parts.join(' - ');
                    } else {
                        label = linkText || 'Download';
                    }
                }

                label = simplifyReleaseLabel(label);

                console.log(`[4KHDHub] Extracted: ${label} (${size || 'unknown size'})`);

                downloadLinksWithMetadata.push({
                    url,
                    size,
                    quality,
                    label
                });
            });

            // Fallback: if no download-item divs found, try old method for any download links
            if (downloadLinksWithMetadata.length === 0) {
                console.log('[4KHDHub] No download-item divs found, trying fallback selectors...');
                const selectors = [
                    'a[href*="drive"]',
                    'a[href*="download"]',
                    '.btn[href]',
                    'a.btn'
                ];

                for (const selector of selectors) {
                    const links = $(selector)
                        .get()
                        .map(a => {
                            const $a = $(a);
                            const url = $a.attr('href');
                            if (!url || !url.trim() || url.includes('#')) {
                                return null;
                            }
                            return {
                                url,
                                size: null,
                                quality: null,
                                label: $a.text().trim() || 'Download'
                            };
                        })
                        .filter(Boolean);

                    if (links.length > 0) {
                        downloadLinksWithMetadata = links;
                        console.log(`Found ${links.length} download links using fallback selector: ${selector}`);
                        break;
                    }
                }
            }

            if (downloadLinksWithMetadata.length === 0) {
                console.log('[4KHDHub] No download links found. Available links on page:');
                const allLinks = $('a[href]')
                    .get()
                    .map(a => $(a).attr('href'))
                    .filter(href => href && href.includes('http'))
                    .slice(0, 10);
                console.log(allLinks);
            }

            const content = {
                title,
                poster,
                tags,
                year,
                description,
                trailer,
                type: isMovie ? 'movie' : 'series',
                languages: languages // Add language information to content
            };

            if (isMovie) {
                content.downloadLinks = downloadLinksWithMetadata;
                console.log(`[4KHDHub] Movie languages:`, languages);
                console.log(`[4KHDHub] Found ${downloadLinksWithMetadata.length} hubdrive download links with metadata`);
                return Promise.resolve(content);
            } else {
                // Handle TV series episodes
                const episodes = [];
                const episodesMap = new Map();

                console.log('[4KHDHub] Parsing TV series episodes...');

                const seasonItems = $('div.episodes-list > div.season-item');
                console.log(`[4KHDHub] Found ${seasonItems.length} quality tier items`);

                seasonItems.each((i, seasonElement) => {
                    // Get season number from episode-number div (e.g., "S01")
                    const seasonText = $(seasonElement).find('div.episode-header > div.episode-number').first().text() || '';
                    const seasonMatch = seasonText.match(/S?0*([1-9][0-9]*)/);
                    const season = seasonMatch ? parseInt(seasonMatch[1]) : null;

                    // Get quality tier info from episode-title
                    const qualityTier = $(seasonElement).find('div.episode-header h3.episode-title').text() || '';

                    console.log(`[4KHDHub] Processing quality tier ${i + 1}: "${qualityTier}" (Season ${season})`);

                    if (!season) {
                        console.log(`[4KHDHub] Could not extract season number, skipping`);
                        return;
                    }

                    // Find all episode download items within this quality tier's episode-content
                    // Use direct child selector to avoid nested elements
                    const seasonContent = $(seasonElement).children('div.episode-content');
                    const episodeBlocks = seasonContent.find('.episode-download-item');

                    console.log(`[4KHDHub] Found ${episodeBlocks.length} episode blocks in quality tier "${qualityTier}"`);

                    episodeBlocks.each((j, episodeBlock) => {
                        // Get episode number from badge-psa span (e.g., "Episode-03")
                        const episodeText = $(episodeBlock).find('span.badge-psa').text() || '';
                        const episodeMatch = episodeText.match(/Episode-0*([1-9][0-9]*)/);
                        const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;

                        if (!episode) {
                            console.log(`[4KHDHub] Could not extract episode number from: "${episodeText}"`);
                            return;
                        }

                        // Get all download links for this episode with metadata
                        // IMPORTANT: Extract filename from .episode-file-title div
                        const $episodeItem = $(episodeBlock);
                        const filename = $episodeItem.find('div.episode-file-title').text().trim();

                        // Get size from badge-size
                        let size = null;
                        const $sizeBadge = $episodeItem.find('span.badge-size');
                        if ($sizeBadge.length > 0) {
                            size = $sizeBadge.text().trim();
                        }

                        console.log(`[4KHDHub] Episode file: "${filename}" (${size || 'unknown size'})`);

                        const episodeLinks = $episodeItem.find('div.episode-links a, div.download-item a');
                        const episodeLinksWithMetadata = episodeLinks.get()
                            .map(a => {
                                const $a = $(a);
                                const url = $a.attr('href');

                                if (!url || !url.trim() || url.includes('#')) {
                                    return null;
                                }

                                // Accept all download links - extraction.js routes them correctly

                                // Look for quality in filename
                                let quality = null;
                                if (filename) {
                                    const qualityMatch = filename.match(/(\d{3,4}p|4K|2K)/i);
                                    if (qualityMatch) {
                                        quality = qualityMatch[1];
                                    }
                                }

                                // Use clean filename as label
                                const label = filename || 'Download';

                                return {
                                    url,
                                    size,
                                    quality,
                                    label
                                };
                            })
                            .filter(Boolean);

                        console.log(`[4KHDHub] S${season}E${episode}: found ${episodeLinksWithMetadata.length} download links`);

                        if (episodeLinksWithMetadata.length > 0) {
                            // Use the languages extracted from the page-level badge
                            // All episodes in the series have the same language(s)
                            const key = `${season}-${episode}`;
                            if (!episodesMap.has(key)) {
                                episodesMap.set(key, {
                                    season,
                                    episode,
                                    downloadLinks: [],
                                    languageInfo: [...languages] // Use page-level languages
                                });
                            }
                            episodesMap.get(key).downloadLinks.push(...episodeLinksWithMetadata);
                        }
                    });
                });

                content.episodes = Array.from(episodesMap.values()).map(ep => ({
                    ...ep,
                    downloadLinks: [...new Set(ep.downloadLinks)], // Remove duplicates
                    languageInfo: ep.languageInfo || [] // Include language information
                }));

                console.log(`[4KHDHub] Parsed ${content.episodes.length} total episodes`);

                return Promise.resolve(content);
            }
        });
}
