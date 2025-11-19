/**
 * HDHub4u Streams
 * Converts HDHub4u download links into direct HTTP streams
 */

import Cinemeta from '../../../util/cinemeta.js';
import {
    renderLanguageFlags,
    detectLanguagesFromTitle
} from '../../../util/language-mapping.js';
import {
    getResolutionFromName,
    removeYear,
    generateAlternativeQueries,
    calculateSimilarity,
    normalizeTitle
} from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { validateSeekableUrl } from '../../utils/validation.js';
import { searchHdHub4uPosts, loadHdHub4uPost } from './search.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';

const MAX_LINKS = parseInt(process.env.HDHUB4U_MAX_LINKS, 10) || 14;
const MAX_THREAD_COUNT = Math.max(
    1,
    parseInt(process.env.HDHUB4U_THREAD_COUNT || process.env.HDHUB4U_BATCH_SIZE, 10) || 8
);
const SEEK_VALIDATION_ENABLED = process.env.DISABLE_HDHUB4U_SEEK_VALIDATION !== 'true';

const TRUSTED_HOSTS = [
    'pixeldrain',
    'workers.dev',
    'r2.dev',
    'hubcdn.fans',
    'googleusercontent.com'
];

const SUSPICIOUS_PATTERNS = [
    'cdn.ampproject.org',
    'bloggingvector.shop'
];

function normalizeLabel(label) {
    return label ? label.replace(/\s+/g, ' ').trim() : '';
}

function prioritizeLinks(downloadLinks, type, season, episode) {
    const requestedSeason = season ? parseInt(season) : null;
    const requestedEpisode = episode ? parseInt(episode) : null;

    return downloadLinks
        .map(link => {
            let priority = 0;

            // Prefer per-episode links for series
            if (type === 'series') {
                if (requestedSeason && link.season === requestedSeason) {
                    priority += 30;
                }
                if (requestedEpisode && link.episode === requestedEpisode) {
                    priority += 40;
                }
                if (!requestedEpisode && requestedSeason && link.label?.includes(`S${requestedSeason}`)) {
                    priority += 20;
                }
            }

            // Prefer higher resolution
            const resolution = getResolutionFromName(link.label);
            if (resolution === '2160p') priority += 25;
            else if (resolution === '1080p') priority += 20;
            else if (resolution === '720p') priority += 10;

            // Prefer HEVC/265 encodes
            if (/HEVC|H265|x265/i.test(link.label)) priority += 5;

            // Slight preference for smaller sizes for faster extraction
            if (link.size && /MB/i.test(link.size)) priority += 3;

            return { ...link, priority };
        })
        .sort((a, b) => b.priority - a.priority);
}

async function processDownloadLink(link, index) {
    try {
        const results = await processExtractorLinkWithAwait(link.url, index + 1);
        if (!results || results.length === 0) {
            return [];
        }

        return results.map(result => ({
            url: result.url,
            name: result.name || 'HDHub4u',
            quality: result.quality || getResolutionFromName(link.label),
            size: link.size,
            sourceLabel: link.label,
            languages: link.languages?.length ? link.languages : detectLanguagesFromTitle(link.label),
            resolverUrl: link.url
        }));
    } catch (error) {
        console.error(`[HDHub4u] Failed to process link ${link.url}:`, error.message);
        return [];
    }
}

async function extractStreamingLinks(downloadLinks, type, season, episode) {
    const prioritized = prioritizeLinks(downloadLinks, type, season, episode);
    const limited = prioritized.slice(0, MAX_LINKS);

    if (limited.length === 0) {
        return [];
    }

    const concurrency = Math.min(MAX_THREAD_COUNT, limited.length);
    console.log(`[HDHub4u] Extracting ${limited.length} links with concurrency ${concurrency}`);

    const results = new Array(limited.length);
    let cursor = 0;

    const worker = async () => {
        while (cursor < limited.length) {
            const currentIndex = cursor++;
            const link = limited[currentIndex];
            results[currentIndex] = await processDownloadLink(link, currentIndex);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results.flat();
}

function filterSuspicious(links) {
    return links.filter(link => {
        if (!link.url) return false;
        const lower = link.url.toLowerCase();
        const suspicious = SUSPICIOUS_PATTERNS.some(pattern => lower.includes(pattern));
        if (suspicious) {
            console.log(`[HDHub4u] Filtered suspicious URL: ${link.url}`);
            return false;
        }
        return true;
    });
}

function dedupeLinks(links) {
    const seen = new Set();
    const unique = [];
    for (const link of links) {
        if (!link.url) continue;
        if (!seen.has(link.url)) {
            seen.add(link.url);
            unique.push(link);
        }
    }
    return unique;
}

async function validateLinks(links) {
    if (!links?.length) {
        return [];
    }

    if (process.env.DISABLE_HDHUB4U_URL_VALIDATION === 'true') {
        console.log('[HDHub4u] URL validation disabled via env, but enforcing 206 confirmation');
    }

    if (!SEEK_VALIDATION_ENABLED) {
        console.log('[HDHub4u] Seek validation disabled via env override, forcing 206 confirmation for all links');
    }

    const trusted = [];
    const otherLinks = [];
    for (const link of links) {
        if (!link.url) continue;
        if (TRUSTED_HOSTS.some(host => link.url.includes(host))) {
            trusted.push(link);
        } else {
            otherLinks.push(link);
        }
    }

    const orderedLinks = [...trusted, ...otherLinks];
    const validated = [];

    for (let i = 0; i < orderedLinks.length; i += 4) {
        const slice = orderedLinks.slice(i, i + 4);
        const checks = await Promise.all(slice.map(async (link) => {
            try {
                const result = await validateSeekableUrl(link.url, { requirePartialContent: true });
                if (!result.isValid) {
                    console.log(`[HDHub4u] Dropped link (status ${result.statusCode || 'unknown'}) without confirmed 206 response: ${link.url}`);
                    return null;
                }
                if (result.filename) {
                    link.sourceLabel = `${result.filename} ${link.sourceLabel || ''}`.trim();
                }
                return link;
            } catch (error) {
                console.log(`[HDHub4u] Error validating ${link.url}: ${error.message}`);
                return null;
            }
        }));

        validated.push(...checks.filter(Boolean));
    }

    return validated;
}

function mapToStreams(links) {
    return links.map(link => {
        let resolution = getResolutionFromName(link.sourceLabel);
        if (resolution === 'other') {
            resolution = getResolutionFromName(link.name);
        }

        let resolutionLabel = resolution;
        if (resolution === '2160p') resolutionLabel = '4k';

        const languages = link.languages?.length ? link.languages : detectLanguagesFromTitle(link.sourceLabel);
        const languageFlags = renderLanguageFlags(languages);
        const needsResolution = Boolean(link.resolverUrl);
        const resolverSource = needsResolution ? link.resolverUrl : link.url;
        const directUrl = encodeUrlForStreaming(link.url);
        const streamUrl = encodeUrlForStreaming(resolverSource);
        const size = link.size || extractSizeFromLabel(link.sourceLabel || link.name);

        return {
            name: `[HS+] Sootio\n${resolutionLabel}`,
            title: `${normalizeLabel(link.sourceLabel || link.name)}${languageFlags}\n💾 ${size || 'N/A'} | HDHub4u`,
            url: streamUrl,
            size,
            resolution,
            needsResolution,
            resolverFallbackUrl: directUrl,
            behaviorHints: {
                bingeGroup: 'hdhub4u-streams',
                hdhub4uDirectUrl: directUrl
            }
        };
    });
}

function extractSizeFromLabel(label) {
    if (!label) return null;
    const match = label.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    if (!match) return null;
    return `${match[1]} ${match[2].toUpperCase()}`;
}

function filterEpisodeStreams(streams, season, episode) {
    if (!season || !episode) return streams;
    const requestedSeason = parseInt(season);
    const requestedEpisode = parseInt(episode);
    const episodeRegex = new RegExp(`S0*${requestedSeason}E0*${requestedEpisode}|S0*${requestedSeason}-E0*${requestedEpisode}|\\b${requestedSeason}x0*${requestedEpisode}\\b|Episode[\\s-]*0*${requestedEpisode}\\b`, 'i');
    return streams.filter(stream => episodeRegex.test(stream.title));
}

async function findBestMatch(searchResults, targetTitle) {
    let bestMatch = null;
    let bestScore = -Infinity;
    const normalizedTarget = normalizeTitle(targetTitle);

    for (const result of searchResults) {
        const similarity = calculateSimilarity(normalizedTarget, result.slug);
        const score = similarity - (result.score || 0);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = result;
        }
    }

    return bestMatch;
}

export async function getHDHub4uStreams(imdbId, type, season = null, episode = null) {
    try {
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        if (!cinemetaDetails) {
            console.log('[HDHub4u] Cinemeta lookup failed');
            return [];
        }

        const year = cinemetaDetails.year ? parseInt(cinemetaDetails.year.split('-')[0]) : null;
        const queries = generateAlternativeQueries(cinemetaDetails.name, cinemetaDetails.original_title);

        let searchResults = [];
        for (const query of queries) {
            const results = await searchHdHub4uPosts(query, 12);
            if (results.length > 0) {
                searchResults = results;
                break;
            }
        }

        if (searchResults.length === 0) {
            console.log('[HDHub4u] No search results found');
            return [];
        }

        const bestMatch = await findBestMatch(searchResults, cinemetaDetails.name);
        if (!bestMatch) {
            console.log('[HDHub4u] No suitable search match found');
            return [];
        }

        const content = await loadHdHub4uPost(bestMatch.url);
        if (!content || !content.downloadLinks?.length) {
            console.log(`[HDHub4u] No download links found for ${bestMatch.url}`);
            return [];
        }

        if (type === 'movie' && year && content.year && Math.abs(content.year - year) > 1) {
            console.log(`[HDHub4u] Year mismatch (${content.year} vs ${year})`);
            return [];
        }

        const streamingLinks = await extractStreamingLinks(content.downloadLinks, type, season, episode);
        if (streamingLinks.length === 0) {
            console.log('[HDHub4u] No streaming links after extraction');
            return [];
        }

        const filtered = filterSuspicious(streamingLinks);
        const unique = dedupeLinks(filtered);
        const validated = await validateLinks(unique);
        if (validated.length === 0) {
            console.log('[HDHub4u] No validated links remained');
            return [];
        }

        let streams = mapToStreams(validated);
        streams.sort((a, b) => {
            const priority = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, other: 0 };
            const resDiff = (priority[b.resolution] || 0) - (priority[a.resolution] || 0);
            if (resDiff !== 0) return resDiff;
            return (b.size || '').localeCompare(a.size || '');
        });

        if ((type === 'series' || type === 'tv') && season && episode) {
            const episodeStreams = filterEpisodeStreams(streams, season, episode);
            if (episodeStreams.length > 0) {
                streams = episodeStreams;
            }
        }

        console.log(`[HDHub4u] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error('[HDHub4u] Error getting streams:', error.message);
        return [];
    }
}
