/**
 * VidSrc.to Extractor Module
 * Extracts actual video URLs from vidsrc.to embed pages
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';

/**
 * Decodes data-hash using simple base64 decoding
 * @param {string} hash - Encoded hash
 * @returns {string} Decoded hash
 */
function decodeHash(hash) {
    try {
        // VidSrc.to typically uses base64 encoding
        return Buffer.from(hash, 'base64').toString('utf-8');
    } catch (e) {
        console.log(`[VidSrc] Failed to decode hash:`, e.message);
        return hash;
    }
}

/**
 * Extracts video sources from vidsrc.to embed page
 * @param {string} embedUrl - VidSrc.to embed URL (e.g., https://vidsrc.to/embed/tv/225171/1/2)
 * @returns {Promise<Array>} Array of extracted video sources
 */
export async function extractVidSrcTo(embedUrl) {
    try {
        console.log(`[VidSrc] Extracting from: ${embedUrl}`);

        // Fetch the embed page
        const response = await makeRequest(embedUrl, {
            parseHTML: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://vidsrc.to/',
            }
        });

        if (response.statusCode !== 200) {
            console.log(`[VidSrc] Failed to fetch embed page: HTTP ${response.statusCode}`);
            return [];
        }

        const $ = response.document;
        const sources = [];

        // Method 1: Look for data-id attribute on sources
        // VidSrc.to often has server elements with data-id that can be used to fetch sources
        const $servers = $('[data-id]');
        console.log(`[VidSrc] Found ${$servers.length} servers with data-id`);

        if ($servers.length > 0) {
            // Extract the base URL from the embed URL
            const baseUrl = new URL(embedUrl).origin;

            for (let i = 0; i < $servers.length; i++) {
                const $server = $servers.eq(i);
                const dataId = $server.attr('data-id');
                const serverName = $server.text().trim() || `Server ${i + 1}`;

                if (dataId) {
                    console.log(`[VidSrc] Found server: ${serverName}, data-id: ${dataId}`);

                    try {
                        // Fetch the source from the API endpoint
                        // VidSrc.to typically has an endpoint like /ajax/embed/source/{data-id}
                        const sourceUrl = `${baseUrl}/ajax/embed/source/${dataId}`;
                        const sourceResponse = await makeRequest(sourceUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Accept': 'application/json, text/javascript, */*; q=0.01',
                                'X-Requested-With': 'XMLHttpRequest',
                                'Referer': embedUrl,
                            }
                        });

                        if (sourceResponse.statusCode === 200) {
                            const data = JSON.parse(sourceResponse.body);
                            console.log(`[VidSrc] Source response:`, data);

                            if (data.result && data.result.url) {
                                // The URL might be encoded or need decoding
                                let videoUrl = data.result.url;

                                // Check if the URL needs to be decoded
                                if (videoUrl.startsWith('http')) {
                                    sources.push({
                                        url: videoUrl,
                                        quality: data.result.quality || '1080p',
                                        serverName: serverName
                                    });
                                    console.log(`[VidSrc] Extracted source: ${videoUrl}`);
                                } else {
                                    // Try decoding if it's encoded
                                    const decoded = decodeHash(videoUrl);
                                    if (decoded.startsWith('http')) {
                                        sources.push({
                                            url: decoded,
                                            quality: data.result.quality || '1080p',
                                            serverName: serverName
                                        });
                                        console.log(`[VidSrc] Extracted decoded source: ${decoded}`);
                                    }
                                }
                            } else if (data.result && data.result.embed) {
                                // Some servers return an embed URL instead
                                console.log(`[VidSrc] Server returned embed URL: ${data.result.embed}`);
                                // Try to extract from the embed URL recursively (but limit depth)
                                const embedSources = await extractFromEmbed(data.result.embed);
                                sources.push(...embedSources);
                            }
                        }
                    } catch (err) {
                        console.log(`[VidSrc] Failed to fetch source for ${serverName}:`, err.message);
                    }
                }
            }
        }

        // Method 2: Look for iframe sources directly in the HTML
        $('iframe[src]').each((i, el) => {
            const src = $(el).attr('src');
            if (src && src.includes('.m3u8')) {
                sources.push({
                    url: src,
                    quality: '1080p',
                    serverName: 'Direct'
                });
                console.log(`[VidSrc] Found iframe M3U8: ${src}`);
            }
        });

        // Method 3: Look for script tags that might contain video sources
        const scriptContent = $('script').toArray().map(el => $(el).html()).join('\n');

        // Look for common patterns in scripts
        const urlPatterns = [
            /file:\s*["']([^"']+\.m3u8[^"']*)["']/gi,
            /source:\s*["']([^"']+\.m3u8[^"']*)["']/gi,
            /url:\s*["']([^"']+\.m3u8[^"']*)["']/gi,
        ];

        for (const pattern of urlPatterns) {
            let match;
            while ((match = pattern.exec(scriptContent)) !== null) {
                if (match[1] && match[1].startsWith('http')) {
                    sources.push({
                        url: match[1],
                        quality: '1080p',
                        serverName: 'Script'
                    });
                    console.log(`[VidSrc] Found M3U8 in script: ${match[1]}`);
                }
            }
        }

        console.log(`[VidSrc] Extracted ${sources.length} sources`);
        return sources;
    } catch (error) {
        console.error(`[VidSrc] Extraction error:`, error.message);
        return [];
    }
}

/**
 * Helper function to extract sources from nested embed URLs
 * @param {string} embedUrl - Embed URL
 * @returns {Promise<Array>} Array of sources
 */
async function extractFromEmbed(embedUrl) {
    try {
        // Prevent infinite recursion - only extract from known safe domains
        if (!embedUrl.includes('vidsrc') &&
            !embedUrl.includes('streaming') &&
            !embedUrl.includes('player')) {
            return [];
        }

        console.log(`[VidSrc] Extracting from nested embed: ${embedUrl}`);

        const response = await makeRequest(embedUrl, {
            parseHTML: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://vidsrc.to/',
            }
        });

        if (response.statusCode !== 200) {
            return [];
        }

        const $ = response.document;
        const sources = [];

        // Look for M3U8 URLs in the embed
        const scriptContent = $('script').toArray().map(el => $(el).html()).join('\n');
        const m3u8Pattern = /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/gi;

        let match;
        while ((match = m3u8Pattern.exec(scriptContent)) !== null) {
            sources.push({
                url: match[1],
                quality: '1080p',
                serverName: 'Nested'
            });
        }

        return sources;
    } catch (error) {
        console.log(`[VidSrc] Failed to extract from nested embed:`, error.message);
        return [];
    }
}
