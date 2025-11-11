/**
 * StreamSrc API Module
 * Handles API interactions with StreamSrc/cloudnestra service
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';

// Base domain for stremsrc requests
let STREMSRC_BASEDOM = "https://cloudnestra.com";
const STREMSRC_SOURCE_URL = "https://vidsrc.xyz/embed";

// Array of realistic user agents to rotate through (from stremsrc)
const STREMSRC_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"
];

/**
 * Gets sec-ch-ua header based on user agent
 * @param {string} userAgent - User agent string
 * @returns {string} sec-ch-ua header value
 */
function getStremsrcSecChUa(userAgent) {
    if (userAgent.includes('Chrome') && userAgent.includes('Edg')) {
        // Edge
        return '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"';
    } else if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
        // Chrome
        return '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"';
    } else if (userAgent.includes('Firefox')) {
        // Firefox doesn't send sec-ch-ua
        return '';
    } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
        // Safari doesn't send sec-ch-ua
        return '';
    }
    // Default to Chrome
    return '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"';
}

/**
 * Gets sec-ch-ua-platform header based on user agent
 * @param {string} userAgent - User agent string
 * @returns {string} sec-ch-ua-platform header value
 */
function getStremsrcSecChUaPlatform(userAgent) {
    if (userAgent.includes('Windows')) {
        return '"Windows"';
    } else if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS X')) {
        return '"macOS"';
    } else if (userAgent.includes('Linux')) {
        return '"Linux"';
    }
    return '"Windows"'; // Default
}

/**
 * Gets a random user agent
 * @returns {string} Random user agent
 */
function getRandomStremsrcUserAgent() {
    return STREMSRC_USER_AGENTS[Math.floor(Math.random() * STREMSRC_USER_AGENTS.length)];
}

/**
 * Gets headers with randomized user agent
 * @returns {Object} Headers object
 */
export function getStremsrcRandomizedHeaders() {
    const userAgent = getRandomStremsrcUserAgent();
    const secChUa = getStremsrcSecChUa(userAgent);
    const secChUaPlatform = getStremsrcSecChUaPlatform(userAgent);

    const headers = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "priority": "u=1",
        "sec-ch-ua-mobile": "?0",
        "sec-fetch-dest": "script",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "same-origin",
        'Sec-Fetch-Dest': 'iframe',
        "Referer": `https://cloudnestra.com/`,
        "Referrer-Policy": "origin",
        "User-Agent": userAgent,
    };

    // Only add sec-ch-ua headers for Chromium-based browsers
    if (secChUa) {
        headers["sec-ch-ua"] = secChUa;
        headers["sec-ch-ua-platform"] = secChUaPlatform;
    }

    return headers;
}

/**
 * Extracts servers from HTML
 * @param {string} html - HTML content
 * @returns {Object} Object with servers array and title
 */
export function serversLoad(html) {
    const $ = cheerio.load(html);
    const servers = [];
    const title = $("title").text() || "";
    const base = $("iframe").attr("src") || "";

    // Update base domain if base URL is found
    if (base) {
        try {
            const baseOrigin = new URL(base.startsWith("//") ? "https:" + base : base).origin;
            if (baseOrigin) {
                STREMSRC_BASEDOM = baseOrigin;
            }
        } catch (e) {
            // If URL parsing fails, keep the default domain
            console.log(`Failed to parse base domain: ${base}`);
        }
    }

    $(".serversList .server").each((index, element) => {
        const server = $(element);
        servers.push({
            name: server.text().trim(),
            dataHash: server.attr("data-hash") || null,
        });
    });

    return {
        servers: servers,
        title: title,
    };
}

/**
 * Handles PRORCP requests
 * @param {string} prorcp - PRORCP parameter
 * @returns {Promise<string|null>} Extracted file URL or null
 */
export async function PRORCPhandler(prorcp) {
    try {
        const prorcpFetch = await makeRequest(`${STREMSRC_BASEDOM}/prorcp/${prorcp}`, {
            headers: {
                ...getStremsrcRandomizedHeaders(),
            },
        });

        if (prorcpFetch.statusCode !== 200) {
            return null;
        }

        const prorcpResponse = prorcpFetch.body;
        const regex = /file:\s*'([^']*)'/gm;
        const match = regex.exec(prorcpResponse);
        if (match && match[1]) {
            return match[1];
        }
        return null;
    } catch (error) {
        console.error('PRORCP handler error:', error);
        return null;
    }
}

/**
 * Grabs RCP data from HTML
 * @param {string} html - HTML content
 * @returns {Object|null} Object with metadata and data, or null
 */
export function rcpGrabber(html) {
    const regex = /src:\s*'([^']*)'/;
    const match = html.match(regex);
    if (!match) return null;
    return {
        metadata: {
            image: "",
        },
        data: match[1],
    };
}

/**
 * Gets content URL based on ID and type
 * @param {string} id - Content ID
 * @param {string} type - Content type ('movie' or 'series'/'tv')
 * @returns {string} Content URL
 */
export function getStreamSrcUrl(id, type) {
    if (type === "movie" || type === "Movie") {
        return `${STREMSRC_SOURCE_URL}/movie/${id}`;
    } else {
        // For series, parse the ID format
        const parts = id.split(':');
        if (parts.length >= 3) {
            const season = parts[1];
            const episode = parts[2];
            return `${STREMSRC_SOURCE_URL}/tv/${parts[0]}/${season}-${episode}`;
        } else {
            // Fallback to original format if not in expected format
            const obj = getObject(id);
            return `${STREMSRC_SOURCE_URL}/tv/${obj.id}/${obj.season}-${obj.episode}`;
        }
    }
}

/**
 * Helper function to parse ID for series (compatibility with existing code)
 * @param {string} id - ID string to parse
 * @returns {Object} Parsed object with id, season, and episode
 */
export function getObject(id) {
    const arr = id.split(':');
    return {
        id: arr[0],
        season: arr[1] || '1',
        episode: arr[2] || '1'
    }
}

/**
 * Gets base domain constant
 * @returns {string} Base domain
 */
export function getStreamSrcBaseDom() {
    return STREMSRC_BASEDOM;
}
