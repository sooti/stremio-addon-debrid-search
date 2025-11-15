/**
 * Hydraflix Embed Extraction Module
 * Handles extraction of actual video URLs from embed players
 */

import { makeRequest } from '../../utils/http.js';
import {
    getStremsrcRandomizedHeaders,
    serversLoad,
    rcpGrabber,
    PRORCPhandler,
    getStreamSrcBaseDom
} from '../streamsrc/api.js';
import { fetchAndParseHLS } from '../streamsrc/hls.js';

/**
 * Extracts video URL from VidSrc.xyz embed using StreamSrc approach
 * @param {string} embedUrl - VidSrc.xyz embed URL
 * @returns {Promise<Array>} Array of extracted streams
 */
async function extractVidSrcXyz(embedUrl) {
    try {
        console.log(`[Hydraflix] Extracting from VidSrc.xyz: ${embedUrl}`);

        // Use the same extraction approach as StreamSrc since they both use vidsrc.xyz
        // Fetch the embed page
        const embedResponse = await makeRequest(embedUrl, {
            headers: {
                ...getStremsrcRandomizedHeaders()
            }
        });

        if (embedResponse.statusCode !== 200) {
            console.log(`[Hydraflix] Failed to fetch VidSrc embed page, status: ${embedResponse.statusCode}`);
            return [];
        }

        const embedHtml = embedResponse.body;

        // Extract servers and title from the page
        const { servers, title } = serversLoad(embedHtml);
        console.log(`[Hydraflix] Found ${servers.length} VidSrc servers:`, servers.map(s => s.name).join(', '));

        if (servers.length === 0) {
            console.log('[Hydraflix] No servers found on VidSrc page');
            return [];
        }

        // Fetch each server's data
        const rcpResponses = [];
        const STREMSRC_BASEDOM = getStreamSrcBaseDom();

        for (const server of servers) {
            if (!server.dataHash) continue;

            const rcpResponse = await makeRequest(`${STREMSRC_BASEDOM}/rcp/${server.dataHash}`, {
                headers: {
                    ...getStremsrcRandomizedHeaders(),
                    'Sec-Fetch-Dest': '',
                }
            });

            if (rcpResponse.statusCode === 200) {
                rcpResponses.push({ response: rcpResponse.body, serverName: server.name });
            }
        }

        // Process each RCP response
        const extractedStreams = [];
        for (const { response, serverName } of rcpResponses) {
            const item = rcpGrabber(response);
            if (!item) continue;

            // Handle different types of data responses
            let streamUrl = null;
            if (item.data.substring(0, 8) === "/prorcp/") {
                streamUrl = await PRORCPhandler(item.data.replace("/prorcp/", ""));
            } else if (item.data.startsWith('http')) {
                streamUrl = item.data;
            }

            if (streamUrl) {
                // Check if this is an HLS master playlist
                const hlsData = await fetchAndParseHLS(streamUrl);

                extractedStreams.push({
                    url: streamUrl,
                    quality: '1080p',
                    title: serverName,
                    hlsData: hlsData
                });
            }
        }

        console.log(`[Hydraflix] Extracted ${extractedStreams.length} streams from VidSrc.xyz`);
        return extractedStreams;
    } catch (error) {
        console.log(`[Hydraflix] VidSrc.xyz extraction failed:`, error.message);
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
        // Special handling for VidSrc.xyz - use StreamSrc extraction approach
        if (embedUrl.includes('vidsrc.xyz')) {
            return await extractVidSrcXyz(embedUrl);
        }

        // For other embed hosts, just return them as-is for now
        // These may work directly in some Stremio clients or can be added later
        console.log(`[Hydraflix] Returning ${serverName} embed URL as-is: ${embedUrl}`);
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
