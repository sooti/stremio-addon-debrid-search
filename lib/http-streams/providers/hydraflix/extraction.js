/**
 * Hydraflix Embed Extraction Module
 * Handles extraction of actual video URLs from embed players
 */

import { makeRequest } from '../../utils/http.js';
import { extractVidSrcTo } from './vidsrc-extractor.js';

/**
 * Extracts video URL from VidSrc embed
 * @param {string} embedUrl - VidSrc embed URL
 * @returns {Promise<Array>} Array of extracted streams
 */
async function extractVidSrc(embedUrl) {
    try {
        console.log(`[Hydraflix] Extracting from VidSrc: ${embedUrl}`);

        // VidSrc embeds typically have the video URL in their source
        // We'll use vidsrc.to's extractor
        const urlMatch = embedUrl.match(/vidsrc\.xyz\/embed\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/);
        if (!urlMatch) {
            console.log(`[Hydraflix] Could not parse VidSrc URL`);
            return [];
        }

        const [, contentType, id, season, episode] = urlMatch;

        // Convert to vidsrc.to and extract
        let vidsrcToUrl;
        if (contentType === 'tv' && season && episode) {
            vidsrcToUrl = `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`;
        } else {
            vidsrcToUrl = `https://vidsrc.to/embed/movie/${id}`;
        }

        // Extract actual video URLs from vidsrc.to
        const extractedSources = await extractVidSrcTo(vidsrcToUrl);

        if (extractedSources.length > 0) {
            return extractedSources.map(source => ({
                url: source.url,
                quality: source.quality || '1080p',
                title: `VidSrc (${source.serverName})`,
                isEmbed: false
            }));
        }

        // Fallback - return vidsrc.to URL as embed if extraction fails
        console.log(`[Hydraflix] Failed to extract sources, returning embed URL as fallback`);
        return [{
            url: vidsrcToUrl,
            quality: '1080p',
            title: 'VidSrc',
            isEmbed: true
        }];
    } catch (error) {
        console.log(`[Hydraflix] VidSrc extraction failed:`, error.message);
        return [];
    }
}

/**
 * Extracts video URL from embed player
 * @param {string} embedUrl - Embed URL
 * @param {string} serverName - Server name
 * @returns {Promise<Array>} Array of extracted streams
 */
export async function extractEmbedUrl(embedUrl, serverName) {
    console.log(`[Hydraflix] Extracting from ${serverName}: ${embedUrl}`);

    // For most embed URLs, we'll use them as-is but mark them as embeds
    // The HTTP resolver or Stremio can handle them

    try {
        // Special handling for VidSrc - use vidsrc.to which is more reliable
        if (embedUrl.includes('vidsrc.xyz')) {
            return await extractVidSrc(embedUrl);
        }

        // For other embeds, convert to vidsrc.to if possible
        // Extract TMDB ID and episode info from the URL
        const smashyMatch = embedUrl.match(/smashy\.stream\/tv\/(\d+)\?s=(\d+)&e=(\d+)/);
        const embedSuMatch = embedUrl.match(/embed\.su\/embed\/tv\/(\d+)\/(\d+)\/(\d+)/);
        const multiEmbedMatch = embedUrl.match(/multiembed\.mov.*video_id=(\d+).*s=(\d+)&e=(\d+)/);
        const autoEmbedMatch = embedUrl.match(/autoembed\.cc\/tv\/tmdb\/(\d+)-(\d+)-(\d+)/);
        const vidBingeMatch = embedUrl.match(/vidbinge\.dev\/embed\/tv\/(\d+)\/(\d+)\/(\d+)/);
        const vidClubMatch = embedUrl.match(/vidclub\.top\/embed\/tv\/(\d+)\/(\d+)\/(\d+)/);

        let tmdbId, season, episode;

        if (smashyMatch) {
            [, tmdbId, season, episode] = smashyMatch;
        } else if (embedSuMatch) {
            [, tmdbId, season, episode] = embedSuMatch;
        } else if (multiEmbedMatch) {
            [, tmdbId, season, episode] = multiEmbedMatch;
        } else if (autoEmbedMatch) {
            [, tmdbId, season, episode] = autoEmbedMatch;
        } else if (vidBingeMatch) {
            [, tmdbId, season, episode] = vidBingeMatch;
        } else if (vidClubMatch) {
            [, tmdbId, season, episode] = vidClubMatch;
        }

        if (tmdbId && season && episode) {
            console.log(`[Hydraflix] Converting ${serverName} to VidSrc.to: TMDB ${tmdbId} S${season}E${episode}`);
            // Use vidsrc.to and extract actual video URLs
            const vidsrcUrl = `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`;

            // Extract actual video sources from vidsrc.to
            const extractedSources = await extractVidSrcTo(vidsrcUrl);

            if (extractedSources.length > 0) {
                return extractedSources.map(source => ({
                    url: source.url,
                    quality: source.quality || '1080p',
                    title: `${serverName} (${source.serverName})`,
                    isEmbed: false
                }));
            }

            // Fallback if extraction fails
            console.log(`[Hydraflix] Failed to extract from vidsrc.to, returning embed URL`);
            return [{
                url: vidsrcUrl,
                quality: '1080p',
                title: serverName,
                isEmbed: true
            }];
        }

        // Fallback - return the original embed URL
        console.log(`[Hydraflix] Using embed URL as-is: ${embedUrl}`);
        return [{
            url: embedUrl,
            quality: 'HD',
            title: serverName,
            isEmbed: true
        }];
    } catch (error) {
        console.error(`[Hydraflix] Extraction error for ${serverName}:`, error.message);
        return [];
    }
}

/**
 * Extracts all embed URLs
 * @param {Array<{url: string, title: string}>} embedStreams - Array of embed streams
 * @returns {Promise<Array>} Array of extracted streams
 */
export async function extractAllEmbeds(embedStreams) {
    const results = [];

    for (const stream of embedStreams) {
        const extracted = await extractEmbedUrl(stream.url, stream.title.split(' - ')[0]);
        results.push(...extracted);
    }

    // Remove duplicates (many embeds convert to vidsrc.to)
    const seen = new Set();
    return results.filter(stream => {
        if (seen.has(stream.url)) {
            return false;
        }
        seen.add(stream.url);
        return true;
    });
}
