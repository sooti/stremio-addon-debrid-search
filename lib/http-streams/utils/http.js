/**
 * HTTP request utilities for HTTP streams
 * Handles HTTP/HTTPS requests with retry logic and domain caching
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import * as cheerio from 'cheerio';
import debridProxyManager from '../../util/debrid-proxy.js';

// Configuration
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
// PERFORMANCE FIX: Add domain cache with TTL to avoid stale domains
const DOMAIN_CACHE_TTL_MS = parseInt(process.env.DOMAIN_CACHE_TTL_MS) || 60000; // 1 minute default
let cachedDomains = null;
let domainCacheTimestamp = null;

/**
 * Makes an HTTP/HTTPS request with retry logic
 * @param {string} url - URL to request
 * @param {Object} options - Request options
 * @param {string} options.method - HTTP method
 * @param {Object} options.headers - Request headers
 * @param {boolean} options.allowRedirects - Whether to follow redirects
 * @param {boolean} options.parseHTML - Whether to parse response as HTML
 * @returns {Promise<{statusCode: number, headers: Object, body: string, document: Object|null, url: string}>}
 */
export function makeRequest(url, options = {}) {
    // Default timeout configuration
    const DEFAULT_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 15000; // 15 seconds default
    const MAX_RETRIES = parseInt(process.env.REQUEST_MAX_RETRIES) || 2; // 2 retries by default
    const RETRY_DELAY = parseInt(process.env.REQUEST_RETRY_DELAY) || 1000; // 1 second delay

    return new Promise(async (resolve, reject) => {
        let lastError;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const urlObj = new URL(url);
                const protocol = urlObj.protocol === 'https:' ? https : http;

                const requestOptions = {
                    hostname: urlObj.hostname,
                    port: urlObj.port,
                    path: urlObj.pathname + urlObj.search,
                    method: options.method || 'GET',
                    timeout: DEFAULT_TIMEOUT,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        ...options.headers
                    }
                };

                // Add proxy agent if configured for http-streams
                const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
                if (proxyAgent) {
                    requestOptions.agent = proxyAgent;
                }

                const req = protocol.request(requestOptions, (res) => {
                    // Handle redirects automatically if not explicitly disabled
                    if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) &&
                        res.headers.location && options.allowRedirects !== false) {
                        console.log(`Following redirect from ${url} to ${res.headers.location}`);
                        // MEMORY LEAK FIX: Destroy response stream to prevent memory leak
                        res.destroy();
                        // Recursively follow the redirect
                        makeRequest(res.headers.location, options)
                            .then(resolve)
                            .catch(reject);
                        return;
                    }

                    // Use Buffer.concat for large responses to avoid string length limits
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => {
                        try {
                            const buffer = Buffer.concat(chunks);
                            const data = buffer.toString('utf8');
                            resolve({
                                statusCode: res.statusCode,
                                headers: res.headers,
                                body: data,
                                document: options.parseHTML ? cheerio.load(data) : null,
                                url: res.headers.location || url // Track final URL if redirected
                            });
                        } catch (err) {
                            reject(new Error(`Failed to process response: ${err.message}`));
                        }
                    });
                });

                req.on('error', (err) => {
                    req.destroy(); // Ensure request is destroyed on error
                    lastError = err;
                    if (attempt < MAX_RETRIES) {
                        console.log(`Request attempt ${attempt + 1} failed for ${url}, retrying in ${RETRY_DELAY}ms... Error: ${err.message}`);
                        return; // Let the loop handle the retry
                    } else {
                        reject(err);
                    }
                });

                req.on('timeout', () => {
                    req.destroy();
                    lastError = new Error(`Request timeout after ${DEFAULT_TIMEOUT}ms for ${url}`);
                    if (attempt < MAX_RETRIES) {
                        console.log(`Request attempt ${attempt + 1} timed out for ${url}, retrying in ${RETRY_DELAY}ms...`);
                        return; // Let the loop handle the retry
                    } else {
                        reject(lastError);
                    }
                });

                req.end();

                // Wait for the request to complete or timeout before checking for retry
                await new Promise((reqResolve) => {
                    req.on('close', reqResolve);
                });

                // If we reach here, the request was successful
                return;

            } catch (err) {
                lastError = err;
                if (attempt < MAX_RETRIES) {
                    console.log(`Request attempt ${attempt + 1} failed for ${url}, retrying in ${RETRY_DELAY}ms... Error: ${err.message}`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
            }
        }

        // If we exhausted all retries, reject with the last error
        reject(lastError);
    });
}

/**
 * Fetches and caches domain configuration
 * @returns {Promise<Object|null>} Domain configuration object
 */
export function getDomains() {
    // PERFORMANCE FIX: Check if cached domains are still valid (within TTL)
    const now = Date.now();
    if (cachedDomains && domainCacheTimestamp && (now - domainCacheTimestamp < DOMAIN_CACHE_TTL_MS)) {
        console.log(`[4KHDHub] Using cached domains (age: ${Math.floor((now - domainCacheTimestamp) / 1000)}s)`);
        return Promise.resolve(cachedDomains);
    }

    console.log(`[4KHDHub] Fetching fresh domains from ${DOMAINS_URL}`);
    return makeRequest(DOMAINS_URL)
        .then(response => {
            cachedDomains = JSON.parse(response.body);
            domainCacheTimestamp = Date.now();
            console.log(`[4KHDHub] Domains cached successfully`);
            return cachedDomains;
        })
        .catch(error => {
            console.error('Failed to fetch domains:', error.message);
            // Return stale cache if available, otherwise null
            if (cachedDomains) {
                console.log(`[4KHDHub] Using stale cached domains due to fetch error`);
                return cachedDomains;
            }
            return null;
        });
}
