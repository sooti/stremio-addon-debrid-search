/**
 * StreamSrc Streams Module
 * Handles fetching and processing streams from StreamSrc
 */

import { makeRequest } from '../../utils/http.js';
import { getStremsrcRandomizedHeaders, serversLoad, rcpGrabber, PRORCPhandler, getStreamSrcUrl, getStreamSrcBaseDom } from './api.js';
import { fetchAndParseHLS } from './hls.js';

/**
 * Gets streams from StreamSrc
 * @param {string} imdbId - IMDb ID
 * @param {string} type - Content type ('movie' or 'series')
 * @param {number} season - Season number (for series)
 * @param {number} episode - Episode number (for series)
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} Array of streams
 */
export async function getStreamSrcStreams(imdbId, type, season = null, episode = null, config) {
    try {
        console.log(`[StreamSrc] Starting search for IMDb ID: ${imdbId}, Type: ${type}${season ? `, Season: ${season}` : ''}${episode ? `, Episode: ${episode}` : ''}`);

        // Format the ID based on type
        let id;
        if (type === 'movie' || type === 'Movie') {
            id = imdbId; // For movies, just use the IMDb ID
        } else {
            // For series, format as imdbId:season:episode
            id = `${imdbId}:${season || '1'}:${episode || '1'}`;
        }

        // Get the URL for the content
        const url = getStreamSrcUrl(id, type);
        console.log(`[StreamSrc] Fetching from URL: ${url}`);

        // Fetch the embed page
        const embedResponse = await makeRequest(url, {
            headers: {
                ...getStremsrcRandomizedHeaders()
            }
        });

        if (embedResponse.statusCode !== 200) {
            console.log(`[StreamSrc] Failed to fetch embed page, status: ${embedResponse.statusCode}`);
            return [];
        }

        const embedHtml = embedResponse.body;

        // Extract servers and title from the page
        const { servers, title } = serversLoad(embedHtml);
        console.log(`[StreamSrc] Found ${servers.length} servers:`, servers.map(s => s.name).join(', '));

        if (servers.length === 0) {
            console.log('[StreamSrc] No servers found on the page');
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
        const apiResponses = [];
        for (const { response, serverName } of rcpResponses) {
            const item = rcpGrabber(response);
            if (!item) continue;

            // Handle different types of data responses
            if (item.data.substring(0, 8) === "/prorcp/") {
                const streamUrl = await PRORCPhandler(item.data.replace("/prorcp/", ""));
                if (streamUrl) {
                    // Check if this is an HLS master playlist
                    const hlsData = await fetchAndParseHLS(streamUrl);

                    apiResponses.push({
                        name: title,
                        image: item.metadata.image,
                        mediaId: id,
                        stream: streamUrl,
                        referer: STREMSRC_BASEDOM,
                        hlsData: hlsData,
                        serverName: serverName
                    });
                }
            } else if (item.data.startsWith('http')) {
                // Direct URL
                const hlsData = await fetchAndParseHLS(item.data);

                apiResponses.push({
                    name: title,
                    image: item.metadata.image,
                    mediaId: id,
                    stream: item.data,
                    referer: STREMSRC_BASEDOM,
                    hlsData: hlsData,
                    serverName: serverName
                });
            }
        }

        // Convert to Stremio format
        let streams = [];
        for (const st of apiResponses) {
            if (!st.stream) continue;

            // If we have HLS data with multiple qualities, create separate streams
            if (st.hlsData && st.hlsData.qualities && st.hlsData.qualities.length > 0) {
                // Add the master playlist as "Auto Quality"
                streams.push({
                    name: `[HS+] Sootio\nAuto`,
                    title: `${st.name || 'Unknown'} - Auto Quality ${st.serverName ? `(${st.serverName})` : ''}`,
                    url: st.stream,
                    behaviorHints: { notWebReady: true, bingeGroup: 'stremsrc-streams' },
                    _size: 0,  /* No size info available */
                    resolution: 'unknown'
                });

                // Add individual quality streams
                for (const quality of st.hlsData.qualities) {
                    // Determine resolution from quality title
                    let resolution = '1080p'; // Default
                    if (quality.title.includes('4K')) {
                        resolution = '2160p';
                    } else if (quality.title.includes('1080p')) {
                        resolution = '1080p';
                    } else if (quality.title.includes('720p')) {
                        resolution = '720p';
                    } else if (quality.title.includes('480p')) {
                        resolution = '480p';
                    }

                    streams.push({
                        name: `[HS+] Sootio\n${resolution === '2160p' ? '4k' : resolution}`,
                        title: `${st.name || 'Unknown'} - ${quality.title} ${st.serverName ? `(${st.serverName})` : ''}`,
                        url: quality.url,
                        behaviorHints: { notWebReady: true, bingeGroup: 'stremsrc-streams' },
                        _size: 0,
                        resolution: resolution
                    });
                }
            } else {
                // Fallback to original behavior if no HLS data
                // Determine resolution from stream URL or server name
                let resolution = '1080p'; // Default
                if (st.serverName && (st.serverName.toLowerCase().includes('4k') || st.serverName.toLowerCase().includes('2160'))) {
                    resolution = '2160p';
                } else if (st.serverName && (st.serverName.toLowerCase().includes('1080'))) {
                    resolution = '1080p';
                } else if (st.serverName && (st.serverName.toLowerCase().includes('720'))) {
                    resolution = '720p';
                }

                streams.push({
                    name: `[HS+] Sootio\n${resolution === '2160p' ? '4k' : resolution}`,
                    title: `${st.name || 'Unknown'} ${st.serverName ? `(${st.serverName})` : ''}`,
                    url: st.stream,
                    behaviorHints: { notWebReady: true, bingeGroup: 'stremsrc-streams' },
                    _size: 0,
                    resolution: resolution
                });
            }
        }

        // Filter out video-downloads.googleusercontent.com URLs
        streams = streams.filter(stream => {
            if (!stream.url) return true; // Keep streams without URL
            const urlLower = stream.url.toLowerCase();
            if (urlLower.includes('video-downloads.googleusercontent.com')) {
                console.log(`[StreamSrc] Filtered out Google video download URL: ${stream.url}`);
                return false;
            }
            return true;
        });

        console.log(`[StreamSrc] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error('[StreamSrc] Error getting streams:', error);
        return [];
    }
}
