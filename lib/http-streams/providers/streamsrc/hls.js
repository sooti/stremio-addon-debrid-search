/**
 * StreamSrc HLS Parsing Module
 * Handles parsing and extraction of HLS playlist information
 */

import { URL } from 'url';
import { makeRequest } from '../../utils/http.js';

/**
 * Parses HLS attributes from a line
 * @param {string} attributesLine - Attributes line from HLS playlist
 * @returns {Object} Parsed attributes
 */
function parseHLSAttributes(attributesLine) {
    const attributes = {};
    const pairs = attributesLine.split(',');

    for (const pair of pairs) {
        const [key, value] = pair.split('=');
        if (key && value) {
            const cleanKey = key.trim();
            let cleanValue = value.trim();

            // Remove quotes if present
            if (cleanValue.startsWith('"') && cleanValue.endsWith('"')) {
                cleanValue = cleanValue.substring(1, cleanValue.length - 1);
            }

            attributes[cleanKey] = cleanValue;
        }
    }

    return attributes;
}

/**
 * Parses HLS master playlist content to extract quality streams
 * @param {string} masterPlaylistContent - HLS master playlist content
 * @param {string} baseUrl - Base URL for resolving relative URLs
 * @returns {Object} Object with masterUrl and qualities array
 */
export function parseHLSMaster(masterPlaylistContent, baseUrl) {
    const qualities = [];

    // Check for #EXT-X-STREAM-INF which indicates this is a master playlist
    if (!masterPlaylistContent.includes('#EXT-X-STREAM-INF')) {
        return { masterUrl: baseUrl, qualities: [] };
    }

    // Split content into lines
    const lines = masterPlaylistContent.split('\n');

    // Process each line to extract stream info
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            // Extract attributes from EXT-X-STREAM-INF line
            const attributesLine = line.substring('#EXT-X-STREAM-INF:'.length);
            const attributes = parseHLSAttributes(attributesLine);

            // The next line after EXT-X-STREAM-INF should be the URL
            if (i + 1 < lines.length) {
                const url = lines[i + 1].trim();
                if (url && !url.startsWith('#')) {
                    // Construct the full URL
                    const playlistUrl = url.startsWith('http')
                        ? url
                        : new URL(url, baseUrl).toString();

                    // Extract bandwidth (required)
                    const bandwidth = parseInt(attributes.BANDWIDTH || '0');

                    // Extract resolution if available
                    let resolution = null;
                    if (attributes.RESOLUTION) {
                        resolution = attributes.RESOLUTION;
                    }

                    // Extract codecs if available
                    const codecs = attributes.CODECS || null;

                    // Extract frame rate if available
                    const frameRate = attributes['FRAME-RATE'] ? parseFloat(attributes['FRAME-RATE']) : null;

                    // Create a readable title
                    let title = 'Unknown Quality';
                    if (resolution) {
                        // Extract height from resolution like "1920x1080"
                        const heightMatch = resolution.match(/\d+x(\d+)/);
                        if (heightMatch) {
                            const height = parseInt(heightMatch[1]);
                            if (height >= 2160) {
                                title = `${resolution} (4K)`;
                            } else if (height >= 1080) {
                                title = `${resolution} (1080p)`;
                            } else if (height >= 720) {
                                title = `${resolution} (720p)`;
                            } else if (height >= 480) {
                                title = `${resolution} (480p)`;
                            } else {
                                title = `${resolution}`;
                            }
                        } else {
                            title = `${resolution}`;
                        }
                    } else {
                        // Fallback to bandwidth-based naming
                        if (bandwidth > 8000000) {
                            title = '4K Quality';
                        } else if (bandwidth > 5000000) {
                            title = 'High Quality (1080p)';
                        } else if (bandwidth > 2000000) {
                            title = 'Medium Quality (720p)';
                        } else if (bandwidth > 1000000) {
                            title = 'SD Quality (480p)';
                        } else {
                            title = 'Low Quality';
                        }
                    }

                    qualities.push({
                        resolution,
                        bandwidth,
                        codecs,
                        frameRate,
                        url: playlistUrl,
                        title
                    });

                    i++; // Skip the next line as it was used as URL
                }
            }
        }
    }

    // Sort by bandwidth (highest first for better quality ordering)
    qualities.sort((a, b) => b.bandwidth - a.bandwidth);

    return {
        masterUrl: baseUrl,
        qualities
    };
}

/**
 * Fetches and parses HLS playlist
 * @param {string} url - HLS playlist URL
 * @returns {Promise<Object|null>} Parsed HLS data or null
 */
export async function fetchAndParseHLS(url) {
    try {
        const response = await makeRequest(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Referer': url,
                'Origin': new URL(url).origin
            }
        });

        if (response.statusCode !== 200) {
            console.log(`HLS fetch failed with status: ${response.statusCode}`);
            return null;
        }

        const content = response.body;

        // Check if this is a master playlist (contains #EXT-X-STREAM-INF)
        if (!content.includes('#EXT-X-STREAM-INF')) {
            return null;
        }

        return parseHLSMaster(content, url);
    } catch (error) {
        console.error('Failed to fetch and parse HLS:', error);
        return null;
    }
}
