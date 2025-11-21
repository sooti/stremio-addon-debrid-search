/**
 * HDHub4u Search Helpers
 * Handles sitemap indexing and page parsing for download links
 */

import Fuse from 'fuse.js';
import { parseStringPromise } from 'xml2js';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';
import { detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { getResolutionFromName } from '../../utils/parsing.js';
import * as SqliteCache from '../../../util/sqlite-cache.js';

const BASE_URL = 'https://hdhub4u.guide';
const SITEMAP_INDEX_URL = `${BASE_URL}/sitemap.xml`;
const SITEMAP_CACHE_TTL = parseInt(process.env.HDHUB4U_SITEMAP_CACHE_TTL, 10) || 6 * 60 * 60 * 1000; // 6 hours
const PAGE_CACHE_TTL = parseInt(process.env.HDHUB4U_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes
const SQLITE_PAGE_CACHE_MINUTES = parseInt(process.env.HDHUB4U_SQLITE_PAGE_TTL_MIN, 10) || (PAGE_CACHE_TTL / (60 * 1000));
const SQLITE_PAGE_CACHE_TTL = SQLITE_PAGE_CACHE_MINUTES * 60 * 1000;
const SQLITE_SERVICE_KEY = 'hdhub4u';
const SQLITE_PAGE_PREFIX = 'page:';

const HOST_PATTERNS = [
    'hubdrive',
    'hubcloud',
    'hubcdn',
    'hubstream',
    'hdstream4u',
    'gadgetsweb',
    'gamerxyt',
    'hblinks',
    '4khdhub',
    'linksly',
    'pixeldrain',
    'workers.dev',
    'r2.dev',
    'googleusercontent',
    'shareus',
    'dood',
    'desiupload',
    'megaup',
    'filepress',
    'mediashore',
    'gofile',
    'ninjastream'
];

const sitemapCache = {
    fetchedAt: 0,
    entries: []
};

const pageCache = new Map(); // url -> { fetchedAt, data }

let fuseIndex = null;
let fuseBuiltAt = 0;
let buildingFusePromise = null;

function normalizeSlug(url) {
    try {
        const { pathname } = new URL(url);
        const slug = pathname.replace(/\/+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
        return cleanTitle(slug);
    } catch {
        return cleanTitle(url);
    }
}

async function fetchSitemapList() {
    const now = Date.now();
    if (sitemapCache.entries.length > 0 && now - sitemapCache.fetchedAt < SITEMAP_CACHE_TTL) {
        return sitemapCache.entries;
    }

    try {
        const response = await makeRequest(SITEMAP_INDEX_URL);
        const parsed = await parseStringPromise(response.body);
        const sitemaps = parsed?.sitemapindex?.sitemap || [];

        const postSitemaps = sitemaps
            .map(item => item.loc?.[0])
            .filter(loc => typeof loc === 'string' && loc.includes('post-sitemap'));

        sitemapCache.entries = postSitemaps;
        sitemapCache.fetchedAt = now;
        return postSitemaps;
    } catch (error) {
        console.error('[HDHub4u] Failed to fetch sitemap index:', error.message);
        return sitemapCache.entries;
    }
}

async function fetchSitemapEntries(url) {
    try {
        const response = await makeRequest(url);
        const parsed = await parseStringPromise(response.body);
        const urls = parsed?.urlset?.url || [];

        return urls
            .map(item => {
                const loc = item.loc?.[0];
                if (!loc) return null;
                return {
                    url: loc,
                    slug: normalizeSlug(loc),
                    lastmod: item.lastmod?.[0] || null
                };
            })
            .filter(Boolean);
    } catch (error) {
        console.error(`[HDHub4u] Failed to fetch sitemap entries for ${url}:`, error.message);
        return [];
    }
}

async function buildFuseIndex() {
    const now = Date.now();
    if (fuseIndex && now - fuseBuiltAt < SITEMAP_CACHE_TTL) {
        return fuseIndex;
    }

    if (buildingFusePromise) {
        return buildingFusePromise;
    }

    buildingFusePromise = (async () => {
        const sitemapUrls = await fetchSitemapList();
        const allEntries = [];

        for (const sitemapUrl of sitemapUrls) {
            const entries = await fetchSitemapEntries(sitemapUrl);
            allEntries.push(...entries);
        }

        fuseIndex = new Fuse(allEntries, {
            includeScore: true,
            threshold: 0.4,
            minMatchCharLength: 2,
            keys: ['slug']
        });
        fuseBuiltAt = Date.now();
        buildingFusePromise = null;
        return fuseIndex;
    })();

    return buildingFusePromise;
}

export async function searchHdHub4uPosts(query, limit = 10) {
    if (!query) return [];

    const fuse = await buildFuseIndex();
    if (!fuse) return [];

    const results = fuse.search(cleanTitle(query), { limit: Math.max(limit * 2, 20) })
        .map(result => ({
            url: result.item.url,
            slug: result.item.slug,
            score: result.score,
            lastmod: result.item.lastmod || null
        }));

    if (results.length > 0) {
        const unique = [];
        const seen = new Set();
        for (const item of results) {
            if (!seen.has(item.url)) {
                seen.add(item.url);
                unique.push(item);
            }
            if (unique.length >= limit) break;
        }
        return unique;
    }

    return [];
}

function normalizeLink(href) {
    if (!href) return null;
    try {
        return new URL(href, BASE_URL).toString();
    } catch {
        return null;
    }
}

function extractFilenameFromUrl(url) {
    if (!url) return null;
    try {
        const urlObj = new URL(url);

        // Skip redirect/shortlink URLs that won't have meaningful filenames
        if (urlObj.search || urlObj.hostname.includes('gadgetsweb') || urlObj.hostname.includes('hblinks')) {
            return null;
        }

        const pathname = urlObj.pathname;
        // Get the last segment of the path
        const segments = pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
            let filename = segments[segments.length - 1];
            // Remove common file extensions
            filename = filename.replace(/\.(mkv|mp4|avi|webm|m3u8|html)$/i, '');
            // Decode URI component
            try {
                filename = decodeURIComponent(filename);
            } catch (e) {
                // If decoding fails, use as-is
            }
            // Check if it looks like a meaningful filename (not just a random hash or ID)
            // Skip if it's very short (likely an ID) or very long (likely encoded data)
            if (filename.length > 10 && filename.length < 200) {
                // Skip if it looks like a random hash (all hex or alphanumeric with no spaces/dashes)
                if (/^[a-f0-9]{20,}$/i.test(filename) || /^[a-zA-Z0-9]{32,}$/i.test(filename)) {
                    return null;
                }
                // Should contain some meaningful characters (letters, spaces, or dashes)
                if (/[a-z].*[a-z]/i.test(filename)) {
                    return filename;
                }
            }
        }
    } catch {
        // Invalid URL
    }
    return null;
}

function shouldIncludeLink(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    if (lower.startsWith(BASE_URL) || lower.includes('#')) return false;
    return HOST_PATTERNS.some(pattern => lower.includes(pattern));
}

function extractSize(label) {
    if (!label) return null;
    const cleaned = label.replace(/\s+/g, ' ');
    const match = cleaned.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    if (!match) return null;
    return `${match[1]} ${match[2].toUpperCase()}`;
}

function extractSeasonEpisode(label) {
    if (!label) return {};

    const seasonMatch = label.match(/S(?:eason)?\s*0*(\d+)/i);
    const episodeMatch = label.match(/E(?:pisode)?\s*0*(\d+)/i) || label.match(/\bEp?\s*0*(\d+)/i);

    const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
    const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;

    return { season, episode };
}

const ARCHIVE_LABEL_KEYWORDS = [
    'pack',
    'full series',
    'all episodes',
    'complete series',
    'complete season',
    'full season',
    's01-s04',
    'season pack'
];

function isArchiveLabel(label) {
    const normalized = label.toLowerCase();
    return ARCHIVE_LABEL_KEYWORDS.some(keyword => normalized.includes(keyword));
}

function collapseWhitespace(value) {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim();
}

function findEpisodeHeaderText($, $element) {
    const parentHeader = $element.closest('h4');
    if (!parentHeader.length) {
        return '';
    }

    const episodeHeader = parentHeader.prevAll('h4').filter((_, hdr) => {
        const text = $(hdr).text();
        return /(episode|ep)\s*\d+/i.test(text);
    });

    if (episodeHeader.length) {
        return collapseWhitespace(episodeHeader.first().text());
    }

    return '';
}

function extractResolutionFromHeader($, $element) {
    const parentHeader = $element.closest('h4');
    if (!parentHeader.length) return null;
    const headerText = collapseWhitespace(parentHeader.text());
    const match = headerText.match(/(2160p|1080p|720p|480p|4k)/i);
    return match ? match[0].toLowerCase() : null;
}

function extractContextFromSurroundingElements($, $element) {
    // Try to find meaningful context from surrounding elements
    const contexts = [];

    // Check parent paragraph or div for additional text
    const $parent = $element.parent();
    if ($parent.length) {
        const parentText = collapseWhitespace($parent.text());
        const linkText = collapseWhitespace($element.text());

        // Get text that's NOT part of the link itself
        const contextText = parentText.replace(linkText, '').trim();
        if (contextText && contextText.length > 10 && contextText.length < 300) {
            // Check if it looks like a filename or meaningful description
            if (/\.(mkv|mp4|avi|webm)|[0-9]+\.?[0-9]*\s*(gb|mb)|bluray|webrip|web-dl|hdtv|remux/i.test(contextText)) {
                contexts.push(contextText);
            }
        }
    }

    // Check for strong/bold tags near the link
    const $strong = $element.closest('p, div, li').find('strong, b').first();
    if ($strong.length) {
        const strongText = collapseWhitespace($strong.text());
        if (strongText && strongText.length > 5 && !contexts.includes(strongText)) {
            contexts.push(strongText);
        }
    }

    // Look for preceding text nodes or spans that might contain filename info
    const $prevSiblings = $element.prevAll().slice(0, 3);
    $prevSiblings.each((_, sibling) => {
        const siblingText = collapseWhitespace($(sibling).text());
        if (siblingText && siblingText.length > 10 && siblingText.length < 200) {
            if (/\.(mkv|mp4|avi|webm)|[0-9]+\.?[0-9]*\s*(gb|mb)|bluray|webrip|web-dl|hdtv/i.test(siblingText)) {
                if (!contexts.includes(siblingText)) {
                    contexts.push(siblingText);
                }
            }
        }
    });

    return contexts.length > 0 ? contexts[0] : null;
}

function buildHdHubLinkLabel($, $element, baseLabel) {
    const parts = [];
    const episodeHeaderText = findEpisodeHeaderText($, $element);
    if (episodeHeaderText) {
        parts.push(episodeHeaderText);
    }

    const parentHeader = $element.closest('h4');
    const parentText = parentHeader.length ? collapseWhitespace(parentHeader.text()) : '';
    if (parentText) {
        parts.push(parentText);
    }

    // If baseLabel is generic or too short, try to find better context
    const isGenericBaseLabel = !baseLabel ||
        baseLabel.length < 8 ||
        /^(download|click|here|link|watch|stream|play|4khdhub|hdhub4u|gdflix|hubcloud|hubdrive)$/i.test(baseLabel.trim());

    if (isGenericBaseLabel) {
        // Try to extract better context from surrounding elements
        const surroundingContext = extractContextFromSurroundingElements($, $element);
        if (surroundingContext) {
            parts.push(surroundingContext);
        } else if (baseLabel) {
            parts.push(baseLabel);
        }
    } else if (baseLabel) {
        parts.push(baseLabel);
    }

    const resolutionHint = extractResolutionFromHeader($, $element);
    if (resolutionHint && !parts.some(part => part.toLowerCase().includes(resolutionHint.toLowerCase()))) {
        parts.push(resolutionHint);
    }

    const label = parts.filter(Boolean).join(' ').trim();
    const hasEpisodeContext = Boolean(episodeHeaderText);
    return { label, hasEpisodeContext };
}

function getPageCacheKey(url) {
    return `${SQLITE_PAGE_PREFIX}${url}`;
}

async function getSqliteCachedPage(url) {
    if (!SqliteCache.isEnabled()) {
        return null;
    }
    try {
        const cached = await SqliteCache.getCachedRecord(SQLITE_SERVICE_KEY, getPageCacheKey(url));
        if (!cached?.data) {
            return null;
        }
        const updatedAt = cached.updatedAt || cached.createdAt;
        if (updatedAt) {
            const age = Date.now() - new Date(updatedAt).getTime();
            if (age <= SQLITE_PAGE_CACHE_TTL) {
                return cached.data;
            }
        }
    } catch (error) {
        console.error(`[HDHub4u] Failed to read sqlite cache for ${url}: ${error.message}`);
    }
    return null;
}

async function cachePageResult(url, data) {
    pageCache.set(url, { fetchedAt: Date.now(), data });
    if (!SqliteCache.isEnabled()) {
        return;
    }
    try {
        await SqliteCache.upsertCachedMagnet({
            service: SQLITE_SERVICE_KEY,
            hash: getPageCacheKey(url),
            fileName: data.title || url,
            data,
            releaseKey: 'hdhub4u-page'
        });
    } catch (error) {
        console.error(`[HDHub4u] Failed to cache page in sqlite for ${url}: ${error.message}`);
    }
}

export async function loadHdHub4uPost(url) {
    if (!url) return null;

    const cached = pageCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < PAGE_CACHE_TTL) {
        return cached.data;
    }

    const sqliteCached = await getSqliteCachedPage(url);
    if (sqliteCached) {
        pageCache.set(url, { fetchedAt: Date.now(), data: sqliteCached });
        return sqliteCached;
    }

    try {
        const response = await makeRequest(url, {
            parseHTML: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = response.document;
        if (!$) {
            throw new Error('Failed to parse page HTML');
        }

        const ogTitle = $('meta[property="og:title"]').attr('content');
        const pageTitle = $('h1.entry-title').first().text();
        const title = (ogTitle || pageTitle || '').trim();

        // Try to extract year from title only
        // Note: We only look in the title to avoid false positives from publication dates
        let year = null;
        const titleYearMatch = title.match(/\((\d{4})\)/);  // Match year in parentheses first
        if (titleYearMatch) {
            const extractedYear = parseInt(titleYearMatch[1]);
            // Only accept years that make sense for movies/shows (1900-2030)
            if (extractedYear >= 1900 && extractedYear <= 2030) {
                year = extractedYear;
            }
        } else {
            // If no parentheses, try standalone 4-digit year
            const standaloneYearMatch = title.match(/\b(19\d{2}|20[0-2]\d)\b/);
            if (standaloneYearMatch) {
                const extractedYear = parseInt(standaloneYearMatch[1]);
                if (extractedYear >= 1900 && extractedYear <= 2030) {
                    year = extractedYear;
                }
            }
        }

        const type = /season|s0*\d+/.test(normalizeSlug(url)) ? 'series' : 'movie';

        // Extract languages from page title (e.g., "Dual-Audio [Hindi & English]")
        const titleLanguages = detectLanguagesFromTitle(title);
        console.log(`[HDHub4u] Detected languages from page title "${title}":`, titleLanguages);

        const links = new Map();
        $('a[href]').each((_, element) => {
            const href = $(element).attr('href');
            const normalized = normalizeLink(href);
            if (!normalized || !shouldIncludeLink(normalized)) return;

            const text = $(element).text().replace(/\s+/g, ' ').trim();
            const titleAttr = $(element).attr('title')?.replace(/\s+/g, ' ').trim();
            let baseLabel = titleAttr || text;

            // Try to extract a meaningful filename from the URL
            const urlFilename = extractFilenameFromUrl(normalized);
            if (urlFilename) {
                // Use URL filename if the baseLabel is generic or too short
                const isGenericLabel = !baseLabel ||
                    baseLabel.length < 5 ||
                    /^(download|click|here|link|watch|stream|play)$/i.test(baseLabel.trim());

                if (isGenericLabel) {
                    baseLabel = urlFilename;
                } else {
                    // Append URL filename to baseLabel for more context
                    baseLabel = `${urlFilename} ${baseLabel}`;
                }
            }

            if (!baseLabel) return;

            const { label, hasEpisodeContext } = buildHdHubLinkLabel($, $(element), baseLabel);
            if (!label || label.toLowerCase().includes('sample')) return;
            if (!hasEpisodeContext && isArchiveLabel(label)) return;

            if (!links.has(normalized)) {
                const linkLanguages = detectLanguagesFromTitle(label);
                // Use link languages if available, otherwise fall back to title languages
                const languages = linkLanguages.length > 0 ? linkLanguages : titleLanguages;
                links.set(normalized, {
                    url: normalized,
                    label,
                    size: extractSize(label),
                    quality: getResolutionFromName(label),
                    languages,
                    ...extractSeasonEpisode(label)
                });
            }
        });

        const data = {
            url,
            title,
            year,
            type,
            titleLanguages,
            downloadLinks: Array.from(links.values())
        };

        await cachePageResult(url, data);
        return data;
    } catch (error) {
        console.error(`[HDHub4u] Failed to load post ${url}:`, error.message);
        return null;
    }
}
