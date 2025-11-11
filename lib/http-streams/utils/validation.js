/**
 * URL validation utilities for HTTP streams
 * Handles URL validation and seekability checks
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import debridProxyManager from '../../util/debrid-proxy.js';

/**
 * Helper function to extract filename from Content-Disposition header
 * @param {string} contentDisposition - Content-Disposition header value
 * @returns {string|null} Extracted filename or null
 */
export function extractFilenameFromHeader(contentDisposition) {
    if (!contentDisposition) return null;

    // Try to match filename*=UTF-8''encoded-filename or filename="quoted-filename" or filename=unquoted-filename
    const patterns = [
        /filename\*=UTF-8''(.+?)(?:;|$)/i,
        /filename\*=([^;]+)/i,
        /filename="(.+?)"/i,
        /filename=([^;]+)/i
    ];

    for (const pattern of patterns) {
        const match = contentDisposition.match(pattern);
        if (match && match[1]) {
            let filename = match[1].trim();
            // Decode URI component if it's encoded
            try {
                filename = decodeURIComponent(filename);
            } catch (e) {
                // If decoding fails, use as-is
            }
            // Remove file extension
            const cleanFilename = filename.replace(/\.(mkv|mp4|avi|webm)$/i, '');

            // For Google User Content URLs, if the filename looks like a random hash, return empty
            // so that the header details (which usually have meaningful info) can be used instead
            if (cleanFilename.length > 50 && /^[A-Za-z0-9_-]+$/.test(cleanFilename)) {
                // Looks like a random hash, probably not meaningful
                return '';
            }

            return cleanFilename;
        }
    }

    return null;
}

/**
 * Validates if a URL is accessible
 * @param {string} url - URL to validate
 * @returns {Promise<boolean>} True if URL is valid
 */
export function validateUrl(url) {
    // Use a default timeout that can be configured via environment variable
    const timeout = parseInt(process.env.VALIDATION_TIMEOUT) || 8000; // Default 8 seconds
    const disableValidation = process.env.DISABLE_URL_VALIDATION === 'true';

    // Skip validation if disabled via environment variable
    if (disableValidation) {
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);

            // Skip validation for known reliable hosting services
            const trustedHosts = [
                'pixeldrain.dev',
                'pixeldrain.com',
                'r2.dev',
                'workers.dev',
                'hubcdn.fans',
                'googleusercontent.com'
            ];

            const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));
            if (isTrustedHost) {
                console.log(`[4KHDHub] Skipping validation for trusted host: ${urlObj.hostname}`);
                resolve(true);
                return;
            }

            const protocol = urlObj.protocol === 'https:' ? https : http;

            const options = {
                method: 'HEAD',
                timeout: timeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            };

            // Add proxy agent if configured
            const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
            if (proxyAgent) {
                options.agent = proxyAgent;
            }

            const req = protocol.request(url, options, (res) => {
                // Consider 2xx and 3xx status codes as valid, including 206 (Partial Content)
                const isValid = res.statusCode >= 200 && res.statusCode < 400;
                console.log(`[4KHDHub] URL validation for ${url}: ${res.statusCode} - ${isValid ? 'VALID' : 'INVALID'}`);
                res.destroy(); // Close connection immediately
                resolve(isValid);
            });

            req.on('error', (err) => {
                console.log(`[4KHDHub] URL validation error for ${url}: ${err.message}`);
                req.destroy(); // Ensure request is destroyed on error
                resolve(false);
            });

            req.on('timeout', () => {
                console.log(`[4KHDHub] URL validation timeout for ${url}`);
                req.destroy();
                resolve(false);
            });

            req.setTimeout(timeout);
            req.end();
        } catch (error) {
            console.log(`[4KHDHub] URL validation parse error for ${url}: ${error.message}`);
            resolve(false);
        }
    });
}

/**
 * Function to validate if a URL supports range requests (seeking)
 * @param {string} url - URL to validate
 * @returns {Promise<{isValid: boolean, filename: string|null}>} Validation result and filename
 */
export function validateSeekableUrl(url) {
    // Use a default timeout that can be configured via environment variable
    const timeout = parseInt(process.env.VALIDATION_TIMEOUT) || 8000; // Default 8 seconds
    const disableSeekValidation = process.env.DISABLE_SEEK_VALIDATION === 'true';

    // Skip seek validation if disabled via environment variable
    if (disableSeekValidation) {
        return validateUrl(url).then(isValid => ({ isValid, filename: null }));
    }

    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);

            // Always allow pixeldrain links regardless of seek validation
            // Skip validation for known reliable hosting services
            const trustedHosts = [
                'pixeldrain.dev',
                'pixeldrain.com',
                'r2.dev',
                'workers.dev',
                'hubcdn.fans',
                'googleusercontent.com'
            ];

            const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));
            const isPixelDrain = urlObj.hostname.includes('pixeldrain');

            if (isTrustedHost) {
                console.log(`[4KHDHub] Skipping seek validation for trusted host: ${urlObj.hostname}`);
                // Still extract filename from Content-Disposition if available
                const protocol = urlObj.protocol === 'https:' ? https : http;
                const options = {
                    method: 'HEAD',
                    timeout: timeout,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };

                // Add proxy agent if configured
                const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
                if (proxyAgent) {
                    options.agent = proxyAgent;
                }

                const req = protocol.request(url, options, (res) => {
                    const filename = extractFilenameFromHeader(res.headers['content-disposition']);
                    res.destroy();
                    resolve({ isValid: true, filename });
                });

                req.on('error', () => {
                    req.destroy(); // Ensure request is destroyed on error
                    resolve({ isValid: true, filename: null });
                });
                req.on('timeout', () => {
                    req.destroy();
                    resolve({ isValid: true, filename: null });
                });
                req.setTimeout(timeout);
                req.end();
                return;
            }

            const protocol = urlObj.protocol === 'https:' ? https : http;

            const options = {
                method: 'HEAD',
                timeout: timeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Range': 'bytes=0-0'  // Test range request to check if seeking is supported
                }
            };

            // Add proxy agent if configured
            const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
            if (proxyAgent) {
                options.agent = proxyAgent;
            }

            const req = protocol.request(url, options, (res) => {
                // Extract filename from Content-Disposition header
                const filename = extractFilenameFromHeader(res.headers['content-disposition']);

                // Always allow pixeldrain links regardless of 206 check result
                const isPixelDrain = url.includes('pixeldrain');
                if (isPixelDrain) {
                    console.log(`[4KHDHub] Allowing PixelDrain link without seek validation: ${url}`);
                    if (filename) console.log(`[4KHDHub] Extracted filename from header: ${filename}`);
                    res.destroy(); // Close connection immediately
                    resolve({ isValid: true, filename });
                    return;
                }

                // Check if the server accepts range requests
                // 206 (Partial Content) means range requests are supported
                // 200 with Accept-Ranges header also indicates seeking capability
                const supportsRanges = res.statusCode === 206 ||
                                      (res.statusCode === 200 && res.headers['accept-ranges'] && res.headers['accept-ranges'] !== 'none');

                // Only consider 2xx status codes as valid
                const isValid = res.statusCode >= 200 && res.statusCode < 300;

                console.log(`[4KHDHub] Seek validation for ${url}: Status ${res.statusCode}, Supports ranges: ${supportsRanges}, Valid: ${isValid}`);
                if (filename) console.log(`[4KHDHub] Extracted filename from header: ${filename}`);

                // Special handling for googleusercontent.com - check for 206 status
                if (urlObj.hostname.includes('googleusercontent.com')) {
                    // For Google User Content URLs, we specifically require 206 status for seeking
                    if (res.statusCode === 206) {
                        console.log(`[4KHDHub] Google User Content URL supports seeking (206 Partial Content): ${url}`);
                        res.destroy();
                        resolve({ isValid: true, filename });
                        return;
                    } else if (res.statusCode === 200 && res.headers['accept-ranges'] && res.headers['accept-ranges'] !== 'none') {
                        console.log(`[4KHDHub] Google User Content URL supports seeking (200 + Accept-Ranges header): ${url}`);
                        res.destroy();
                        resolve({ isValid: true, filename });
                        return;
                    } else {
                        console.log(`[4KHDHub] Google User Content URL does not support seeking (Status: ${res.statusCode}): ${url}`);
                        res.destroy();
                        resolve({ isValid: false, filename });
                        return;
                    }
                }

                // A URL is seekable if it's valid AND supports range requests
                const isSeekable = isValid && supportsRanges;

                res.destroy(); // Close connection immediately
                resolve({ isValid: isSeekable, filename });
            });

            req.on('error', (err) => {
                console.log(`[4KHDHub] Seek validation error for ${url}: ${err.message}`);
                req.destroy(); // Ensure request is destroyed on error
                resolve({ isValid: false, filename: null });
            });

            req.on('timeout', () => {
                console.log(`[4KHDHub] Seek validation timeout for ${url}`);
                req.destroy();
                resolve({ isValid: false, filename: null });
            });

            req.setTimeout(timeout);
            req.end();
        } catch (error) {
            console.log(`[4KHDHub] Seek validation parse error for ${url}: ${error.message}`);
            resolve({ isValid: false, filename: null });
        }
    });
}
