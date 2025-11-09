import Cinemeta from './util/cinemeta.js';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import * as cheerio from 'cheerio';
import { renderLanguageFlags, detectLanguagesFromTitle } from './util/language-mapping.js';
import debridProxyManager from './util/debrid-proxy.js';
import crypto from 'crypto';

// --- Caching Configuration ---
// NOTE: HTTP streaming results are cached via SQLite in stream-provider.js using getCachedTorrents()
// This provides:
// - Cache-first behavior: Returns cached results immediately to user
// - Background refresh: Always refreshes http-streams in background (URLs can expire)
// - Cross-worker sharing: All workers share the same SQLite cache
// - Consistent TTL: 360 minutes for movies, 60 minutes for series
console.log(`[4KHDHub] Caching is handled by SQLite via stream-provider.js`);

// Function to encode URLs for streaming, being careful not to over-encode existing encoded URLs
function encodeUrlForStreaming(url) {
  if (!url) return url;
  
  // Don't re-encode already encoded URLs
  if (url.includes('%')) {
    // If it's already partially encoded, return as-is to avoid double encoding
    return url;
  }
  
  // For URLs with special characters that need encoding
  try {
    // Use URL constructor to handle the encoding properly 
    const urlObj = new URL(url);
    // The URL constructor already handles proper encoding
    return urlObj.toString();
  } catch (e) {
    // If URL is malformed, do selective encoding
    return url
      .replace(/ /g, '%20')  // Encode spaces
      .replace(/#/g, '%23')  // Encode hash (fragment identifier)
      .replace(/\[/g, '%5B') // Encode brackets
      .replace(/\]/g, '%5D')
      .replace(/{/g, '%7B') // Encode braces
      .replace(/}/g, '%7D');
  }
}

// Configuration
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
// PERFORMANCE FIX: Add domain cache with TTL to avoid stale domains
const DOMAIN_CACHE_TTL_MS = parseInt(process.env.DOMAIN_CACHE_TTL_MS) || 60000; // 1 minute default
let cachedDomains = null;
let domainCacheTimestamp = null;

// Utility functions
function base64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf-8');
}

function base64Encode(str) {
    return Buffer.from(str, 'utf-8').toString('base64');
}

function rot13(str) {
    return str.replace(/[A-Za-z]/g, function(char) {
        const start = char <= 'Z' ? 65 : 97;
        return String.fromCharCode(((char.charCodeAt(0) - start + 13) % 26) + start);
    });
}

function getResolutionFromName(name) {
    if (!name) return 'other';
    const lowerCaseName = name.toLowerCase();
    // Check for more specific resolutions first (higher to lower)
    if (lowerCaseName.includes('2160p')) return '2160p';
    if (lowerCaseName.includes('1080p')) return '1080p';
    if (lowerCaseName.includes('720p')) return '720p';
    if (lowerCaseName.includes('480p')) return '480p';
    // Fallback to '4k' or 'uhd' if no specific resolution is found
    if (lowerCaseName.includes('4k') || lowerCaseName.includes('uhd')) return '2160p';
    return 'other';
}

function formatSize(size) {
    if (!size) return '0 B';
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

// DEPRECATED: Old LANG_FLAGS mapping - now using centralized language-mapping.js
// Kept for reference only - renderLangFlags is now imported from language-mapping.js

function tryDecodeBase64(str) {
    try {
        if (str && str.length > 20 && /^[A-Za-z0-9+/=]+$/.test(str) && !str.includes(' ')) {
            const decoded = base64Decode(str);
            if (!/[^\x20-\x7E]/.test(decoded)) {
                return decoded;
            }
        }
    } catch (e) {
        // Not a valid base64 string
    }
    return str;
}

// DEPRECATED: Old filterByLanguage - now using filterStreamsByLanguage from language-mapping.js
// This function is replaced by the centralized implementation

function validateUrl(url) {
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

// Helper function to extract filename from Content-Disposition header
function extractFilenameFromHeader(contentDisposition) {
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

// Function to validate if a URL supports range requests (seeking)
function validateSeekableUrl(url) {
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

function makeRequest(url, options = {}) {
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

function getDomains() {
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

function getRedirectLinks(url) {
    return makeRequest(url)
        .then(response => {
            const doc = response.body;
            const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
            let combinedString = '';
            let match;
            
            while ((match = regex.exec(doc)) !== null) {
                const extractedValue = match[1] || match[2];
                if (extractedValue) {
                    combinedString += extractedValue;
                }
            }
            
            try {
                const decodedString = base64Decode(rot13(base64Decode(base64Decode(combinedString))));
                const jsonObject = JSON.parse(decodedString);
                const encodedurl = base64Decode(jsonObject.o || '').trim();
                const data = base64Decode(jsonObject.data || '').trim();
                const wphttp1 = (jsonObject.blog_url || '').trim();
                
                if (encodedurl) {
                    return Promise.resolve(encodedurl);
                }
                
                if (wphttp1 && data) {
                    return makeRequest(`${wphttp1}?re=${data}`, { parseHTML: true })
                        .then(resp => resp.document.body.textContent.trim())
                        .catch(() => '');
                }
                
                return Promise.resolve('');
            } catch (e) {
                console.error('Error processing links:', e.message);
                return Promise.resolve('');
            }
        })
        .catch(error => {
            console.error('Error fetching redirect links:', error.message);
            return Promise.resolve('');
        });
}

function getIndexQuality(str) {
    const match = (str || '').match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 2160;
}

function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        return '';
    }
}

function cleanTitle(title) {
    const parts = title.split(/[.\-_]/);
    
    const qualityTags = ['WEBRip', 'WEB-DL', 'WEB', 'BluRay', 'HDRip', 'DVDRip', 'HDTV', 'CAM', 'TS', 'R5', 'DVDScr', 'BRRip', 'BDRip', 'DVD', 'PDTV', 'HD'];
    const audioTags = ['AAC', 'AC3', 'DTS', 'MP3', 'FLAC', 'DD5', 'EAC3', 'Atmos'];
    const subTags = ['ESub', 'ESubs', 'Subs', 'MultiSub', 'NoSub', 'EnglishSub', 'HindiSub'];
    const codecTags = ['x264', 'x265', 'H264', 'HEVC', 'AVC'];
    
    const startIndex = parts.findIndex(part => 
        qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );
    
    const endIndex = parts.map((part, index) => {
        const hasTag = [...subTags, ...audioTags, ...codecTags].some(tag => 
            part.toLowerCase().includes(tag.toLowerCase())
        );
        return hasTag ? index : -1;
    }).filter(index => index !== -1).pop() || -1;
    
    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        return parts.slice(startIndex, endIndex + 1).join('.');
    } else if (startIndex !== -1) {
        return parts.slice(startIndex).join('.');
    } else {
        return parts.slice(-3).join('.');
    }
}

// Normalize title for better matching
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')  // Remove special characters
        .replace(/\s+/g, ' ')          // Normalize whitespace
        .trim();
}

// Calculate similarity between two strings using Levenshtein distance
function calculateSimilarity(str1, str2) {
    const s1 = normalizeTitle(str1);
    const s2 = normalizeTitle(str2);
    
    if (s1 === s2) return 1.0;
    
    const len1 = s1.length;
    const len2 = s2.length;
    
    if (len1 === 0) return len2 === 0 ? 1.0 : 0.0;
    if (len2 === 0) return 0.0;
    
    const matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
    
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }
    
    const maxLen = Math.max(len1, len2);
    return (maxLen - matrix[len1][len2]) / maxLen;
}

// Check if query words are contained in title
function containsWords(title, query) {
    const titleWords = normalizeTitle(title).split(' ');
    const queryWords = normalizeTitle(query).split(' ');
    
    return queryWords.every(queryWord => 
        titleWords.some(titleWord => 
            titleWord.includes(queryWord) || queryWord.includes(titleWord)
        )
    );
}

// Helper function to remove year from title
function removeYear(title) {
    // Remove year patterns like (2023), [2023], 2023 at the end
    return title
        .replace(/[\(\[]?\d{4}[\)\]]?$/g, '')
        .replace(/\s+\d{4}$/g, '')
        .trim();
}

// Helper function to generate alternative query variations
function generateAlternativeQueries(title, originalTitle = null) {
    const queries = [];

    if (title) {
        queries.push(title);
        queries.push(removeYear(title));

        // Remove special characters
        const cleaned = title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleaned !== title) {
            queries.push(cleaned);
        }
    }

    // Add original title if different
    if (originalTitle && originalTitle !== title) {
        queries.push(originalTitle);
        queries.push(removeYear(originalTitle));
    }

    // Return unique queries
    return [...new Set(queries)].filter(Boolean);
}

// Find best matching result from search results
function findBestMatch(results, query) {
    const sorted = getSortedMatches(results, query);
    return sorted.length > 0 ? sorted[0] : null;
}

function getSortedMatches(results, query) {
    if (results.length === 0) return [];
    if (results.length === 1) return results;

    // Score each result
    const scoredResults = results.map(result => {
        let score = 0;

        // Guard against missing title
        if (!result.title || !query) {
            return { ...result, score: 0 };
        }

        // Exact match gets highest score
        if (normalizeTitle(result.title) === normalizeTitle(query)) {
            score += 100;
        }

        // Similarity score (0-50 points)
        const similarity = calculateSimilarity(result.title, query);
        if (!isNaN(similarity)) {
            score += similarity * 50;
        }

        // Word containment bonus (0-30 points)
        if (containsWords(result.title, query)) {
            score += 30;
        }

        // Prefer shorter titles (closer matches) (0-10 points)
        const lengthDiff = Math.abs(result.title.length - query.length);
        const lengthScore = Math.max(0, 10 - lengthDiff / 5);
        if (!isNaN(lengthScore)) {
            score += lengthScore;
        }

        // Year extraction bonus - prefer titles with years
        if (result.title.match(/\((19|20)\d{2}\)/)) {
            score += 5;
        }

        return { ...result, score: isNaN(score) ? 0 : score };
    });

    // Sort by score (highest first)
    scoredResults.sort((a, b) => (b.score || 0) - (a.score || 0));

    console.log('\nTitle matching scores:');
    scoredResults.slice(0, 5).forEach((result, index) => {
        const scoreDisplay = (result.score !== undefined && result.score !== null) ? result.score.toFixed(1) : 'N/A';
        console.log(`${index + 1}. ${result.title} (Score: ${scoreDisplay})`);
    });

    return scoredResults;
}

function extractHubCloudLinks(url, referer) {
    console.log(`Starting HubCloud extraction for: ${url}`);
    const baseUrl = getBaseUrl(url);
    
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const $ = response.document;
            console.log(`Got HubCloud page, looking for download element...`);
            
            // Check if this is already a hubcloud.php or gamerxyt.com page
            let href;
            if (url.includes('hubcloud.php') || url.includes('gamerxyt.com')) {
                // If it's already a gamerxyt/hubcloud.php page, use it directly
                href = url;
                console.log(`Already a hubcloud.php/gamerxyt URL: ${href}`);
            } else {
                // Try to find the download link - new structure uses id="download"
                console.log('Looking for download button on page...');
                const downloadElement = $('a#download, a[id="download"]');
                const rawHref = downloadElement.attr('href');

                if (rawHref) {
                    href = rawHref.startsWith('http') ? rawHref : `${baseUrl.replace(/\/$/, '')}/${rawHref.replace(/^\//, '')}`;
                    console.log(`Found download href with #download: ${href}`);
                } else {
                    console.log('Download element #download not found, trying alternatives...');
                    // Try alternative selectors including hubcloud.one direct links
                    const alternatives = [
                        'a[href*="hubcloud.php"]',
                        'a[href*="gamerxyt.com"]',
                        'a[href*="hubcloud.one"]',
                        '.download-btn',
                        'a[href*="download"]',
                        'a.btn.btn-primary',
                        '.btn[href]'
                    ];
                    let found = false;

                    for (const selector of alternatives) {
                        const altElement = $(selector).first();
                        const altHref = altElement.attr('href');
                        if (altHref) {
                            href = altHref.startsWith('http') ? altHref : `${baseUrl.replace(/\/$/, '')}/${altHref.replace(/^\//, '')}`;
                            console.log(`Found download link with selector ${selector}: ${href}`);
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        // Log all available links for debugging
                        console.log('Could not find download link. Available links on page:');
                        $('a[href]').each((i, elem) => {
                            if (i < 20) {  // Only log first 20 links
                                console.log(`Link ${i + 1}: ${$(elem).attr('href')} (text: ${$(elem).text().trim().substring(0, 50)})`);
                            }
                        });
                        throw new Error('Download element not found with any selector');
                    }
                }
            }
            
            // If the URL is already a hubcloud.one page, we need to extract video directly from it
            if (href.includes('hubcloud.one')) {
                console.log(`Processing hubcloud.one page directly: ${href}`);
                return makeRequest(href, { parseHTML: true });
            } else {
                console.log(`Making request to HubCloud download page: ${href}`);
                return makeRequest(href, { parseHTML: true });
            }
        })
        .then(response => {
            const $ = response.document;
            const results = [];

            const currentUrl = response.url || url;

            console.log(`Processing HubCloud download page (gamerxyt, hubcloud.php, or hubcloud.one)...`);

            // Helper function to extract filename from URL
            const getFilenameFromUrl = (url) => {
                try {
                    const urlObj = new URL(url);
                    const pathname = decodeURIComponent(urlObj.pathname);
                    let filename = pathname.split('/').pop();
                    
                    // Special handling for Google User Content URLs which often have random paths
                    if (urlObj.hostname.includes('googleusercontent.com')) {
                        // For Google User Content URLs, try to get filename from query parameters or header details
                        const searchParams = urlObj.searchParams;
                        if (searchParams.has('file')) {
                            filename = searchParams.get('file');
                        } else if (searchParams.has('name')) {
                            filename = searchParams.get('name');
                        } else if (searchParams.has('title')) {
                            filename = searchParams.get('title');
                        }
                        // If still no meaningful filename, return empty so headerDetails can be used
                        if (filename && filename.length < 10) {
                            // Very short filename, probably not meaningful
                            return '';
                        }
                    }
                    
                    // Remove file extension
                    return filename.replace(/\.(mkv|mp4|avi|webm)$/i, '');
                } catch {
                    return '';
                }
            };

            // Extract quality and size information
            const size = $('i#size').text() || '';
            const rawHeader = $('div.card-header').text() || $('title').text() || '';
            // Clean up header: remove tabs, newlines, and extra whitespace
            const header = rawHeader.replace(/[\t\n\r]+/g, ' ').trim();
            const quality = getIndexQuality(header);
            const headerDetails = header;

            console.log(`Extracted info - Size: ${size}, Header: ${header}, Quality: ${quality}`);

            const labelExtras = [];
            if (headerDetails) labelExtras.push(`[${headerDetails}]`);
            if (size) labelExtras.push(`[${size}]`);
            const labelExtra = labelExtras.join('');

            // Check if this is a hubcloud.one page - these pages have download buttons, not embedded video players
            // So we should NOT try to extract video directly, just look for download buttons
            if (currentUrl.includes('hubcloud.one')) {
                console.log(`Detected hubcloud.one page - looking for download buttons (these pages don't have embedded video players)...`);
            }

            // Check if this is a gamerxyt page - these pages have direct workers.dev links
            if (currentUrl.includes('gamerxyt.com') || currentUrl.includes('hubcloud.php')) {
                console.log(`Detected gamerxyt/hubcloud.php page - looking for workers.dev/hubcdn.fans links...`);
            }

            // Find download buttons - check for gamerxyt.com style links first
            // Priority: pixeldrain > anime4u.co > pixel.hubcdn.fans > hubcdn.fans > workers.dev
            let downloadButtons = $('a[href*="pixeldrain"], a[href*="anime4u.co"], a[href*="pixel.hubcdn.fans"], a[href*="hubcdn.fans"], a.btn[href*="workers.dev"], a[href*="workers.dev"]');
            if (downloadButtons.length === 0) {
                // Fallback to original selectors
                downloadButtons = $('div.card-body h2 a.btn');
            }
            console.log(`Found ${downloadButtons.length} download buttons`);

            if (downloadButtons.length === 0) {
                // Try alternative selectors for download buttons
                const altSelectors = ['a.btn', '.btn', 'a[href]'];
                for (const selector of altSelectors) {
                    const altButtons = $(selector);
                    if (altButtons.length > 0) {
                        console.log(`Found ${altButtons.length} buttons with alternative selector: ${selector}`);
                        altButtons.each((index, btn) => {
                            const link = $(btn).attr('href');
                            const text = $(btn).text();
                            console.log(`Button ${index + 1}: ${text} -> ${link}`);
                        });
                        break;
                    }
                }
            }
            
            // Process all download buttons in parallel for better performance
            const buttonPromises = downloadButtons.get().map(async (button, index) => {
                const link = $(button).attr('href');
                const text = $(button).text();

                console.log(`Processing button ${index + 1}: "${text}" -> ${link}`);

                if (!link) {
                    console.log(`Button ${index + 1} has no link`);
                    return null;
                }

                // Check for pixel.hubcdn.fans links - these redirect to googleusercontent.com
                if (link.includes('pixel.hubcdn.fans') || link.includes('pixel.rohitkiskk.workers.dev')) {
                    console.log(`Button ${index + 1} is pixel.hubcdn.fans link, following redirects to extract googleusercontent URL...`);

                    try {
                        // Follow redirect chain: pixel.hubcdn.fans -> pixel.rohitkiskk.workers.dev -> gamerxyt.com/dl.php?link=googleusercontent
                        const response = await makeRequest(link, {
                            parseHTML: false,
                            allowRedirects: false
                        });

                        let redirectUrl = response.headers['location'];
                        if (!redirectUrl) {
                            console.log(`Button ${index + 1} pixel link has no redirect`);
                            return null;
                        }

                        console.log(`Button ${index + 1} redirects to: ${redirectUrl}`);

                        // Follow the next redirect
                        const response2 = await makeRequest(redirectUrl, {
                            parseHTML: false,
                            allowRedirects: false
                        });

                        let finalRedirect = response2.headers['location'];
                        if (!finalRedirect) {
                            console.log(`Button ${index + 1} second redirect has no location`);
                            return null;
                        }

                        console.log(`Button ${index + 1} final redirect: ${finalRedirect}`);

                        // Extract googleusercontent URL from dl.php?link= parameter
                        if (finalRedirect.includes('dl.php?link=')) {
                            try {
                                const urlObj = new URL(finalRedirect);
                                const googleUrl = urlObj.searchParams.get('link');
                                if (googleUrl && googleUrl.includes('googleusercontent.com')) {
                                    console.log(`Button ${index + 1} extracted googleusercontent URL: ${googleUrl.substring(0, 100)}...`);
                                    return {
                                        name: `${referer} ${text} ${labelExtra}`,
                                        title: getFilenameFromUrl(googleUrl) || headerDetails,
                                        url: googleUrl,
                                        quality: quality,
                                        size: size
                                    };
                                }
                            } catch (urlError) {
                                console.log(`Button ${index + 1} failed to parse URL: ${urlError.message}`);
                            }
                        }

                        console.log(`Button ${index + 1} could not extract googleusercontent URL`);
                        return null;
                    } catch (err) {
                        console.log(`Button ${index + 1} redirect follow failed: ${err.message}`);
                        return null;
                    }
                }

                // Check for direct workers.dev or hubcdn.fans links from gamerxyt.com
                if (link.includes('workers.dev') || link.includes('hubcdn.fans')) {
                    // Keep workers.dev links even if they end in .zip - they're often direct video links with obfuscated names
                    // We'll validate 206 support later
                    if (!link.includes('workers.dev') && link.toLowerCase().endsWith('.zip')) {
                        console.log(`Button ${index + 1} is a ZIP file, skipping`);
                        return null;
                    }

                    console.log(`Button ${index + 1} is direct workers.dev/hubcdn link`);
                    return {
                        name: `${referer} ${text} ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size
                    };
                }

                const buttonBaseUrl = getBaseUrl(link);

                if (text.includes('FSL Server')) {
                    console.log(`Button ${index + 1} is FSL Server`);
                    return {
                        name: `${referer} [FSL Server] ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size
                    };
                } else if (text.includes('Download File')) {
                    console.log(`Button ${index + 1} is Download File`);
                    return {
                        name: `${referer} ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size
                    };
                } else if (text.includes('BuzzServer')) {
                    console.log(`Button ${index + 1} is BuzzServer, following redirect...`);
                    try {
                        // Handle BuzzServer redirect
                        const response = await makeRequest(`${link}/download`, { 
                            parseHTML: false,
                            allowRedirects: false,
                            headers: { 'Referer': link }
                        });

                        const redirectUrl = response.headers['hx-redirect'] || response.headers['location'];
                        if (redirectUrl) {
                            console.log(`BuzzServer redirect found: ${redirectUrl}`);
                            const finalUrl = buttonBaseUrl + redirectUrl;
                            return {
                                name: `${referer} [BuzzServer] ${labelExtra}`,
                                title: getFilenameFromUrl(finalUrl) || headerDetails,
                                url: finalUrl,
                                quality: quality,
                                size: size
                            };
                        } else {
                            console.log(`BuzzServer redirect not found`);
                            return null;
                        }
                    } catch (err) {
                        console.log(`BuzzServer redirect failed: ${err.message}`);
                        return null;
                    }
                } else if (link.includes('pixeldra')) {
                    console.log(`Button ${index + 1} is Pixeldrain`);
                    return {
                        name: `PixelServer ${labelExtra}`,
                        title: headerDetails,
                        url: link,
                        quality: quality,
                        size: size
                    };
                } else if (text.includes('S3 Server')) {
                    console.log(`Button ${index + 1} is S3 Server`);
                    return {
                        name: `${referer} S3 Server ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size
                    };
                } else if (text.includes('10Gbps')) {
                    console.log(`Button ${index + 1} is 10Gbps server - testing (validation will check seekability)...`);
                    // FIXED: Don't skip 10Gbps servers - let validation check if they're seekable
                    // Some 10Gbps servers DO support seeking and may have 4K content
                    return {
                        name: `${referer} 10Gbps ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size
                    };
                } else if (link.includes('pixeldrain.dev') || link.includes('pixeldrain.com')) {
                    console.log(`Button ${index + 1} is PixelDrain link`);
                    return {
                        name: `${referer} PixelServer ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size
                    };
                } else {
                    console.log(`Button ${index + 1} is generic link`);
                    // Generic link
                    return {
                        name: `${referer} ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality
                    };
                }
            });
            
            return Promise.all(buttonPromises)
                .then(results => {
                    const validResults = results.filter(result => result !== null);
                    console.log(`HubCloud extraction completed, found ${validResults.length} valid links`);

                    // Try to extract direct video URLs from results if they look like hubcloud/hubdrive URLs
                    return Promise.all(validResults.map(async (result) => {
                        // If the URL is a hubcloud page, try to extract the actual video URL
                        if (result.url && (result.url.includes('hubcloud') || result.url.includes('hubdrive'))) {
                            try {
                                const videoPageRes = await makeRequest(result.url, {
                                    headers: {
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    }
                                });

                                const videoPageHtml = videoPageRes.body;

                                // Try to extract video URL from various patterns
                                const videoUrlPatterns = [
                                    /sources:\s*\[\s*{\s*file:\s*"([^"]+)"/,
                                    /file:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                    /src:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                    /"file":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                    /"src":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                    /video[^>]*src="([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/
                                ];

                                for (const pattern of videoUrlPatterns) {
                                    const match = videoPageHtml.match(pattern);
                                    if (match && match[1]) {
                                        console.log(`Extracted direct video URL from ${result.url}: ${match[1]}`);
                                        return {
                                            ...result,
                                            url: match[1],
                                            name: result.name + ' [Direct Stream]'
                                        };
                                    }
                                }

                                // If no video URL found, return original result
                                console.log(`No direct video URL found in ${result.url}, using original URL`);
                                return result;
                            } catch (err) {
                                console.error(`Error extracting video URL from ${result.url}:`, err.message);
                                return result;
                            }
                        }
                        return result;
                    }));
                })
                .then(results => {
                    console.log(`HubCloud post-processing completed`);
                    return results;
                });
        })
        .catch(error => {
            console.error(`HubCloud extraction error for ${url}:`, error.message);
            return [];
        });
}

function extractHubDriveLinks(url) {
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const $ = response.document;
            
            // Sometimes the page may have redirected to hubcloud.one already
            // Check if this is a hubcloud.one page by looking for the download element
            const currentUrl = response.url || url;
            console.log(`Processing URL: ${currentUrl}, Original URL: ${url}`);
            
            const downloadBtn = $('.btn.btn-primary.btn-user.btn-success1.m-1');
            
            if (!downloadBtn || downloadBtn.length === 0) {
                console.log('Primary download button not found, trying alternative selectors...');
                
                // Check for hubcloud.one specific elements
                const hubcloudDownload = $('#download');
                if (hubcloudDownload.length > 0 && (currentUrl.includes('hubcloud.one') || currentUrl.includes('gamerxyt.com'))) {
                    console.log('Found download element on hubcloud/gamerxyt page');
                    const href = hubcloudDownload.attr('href') || hubcloudDownload.attr('data-href') || hubcloudDownload.attr('onclick');
                    if (href) {
                        let processedHref = href;
                        // If onclick, extract URL from it
                        if (href.includes('location.href')) {
                            const urlMatch = href.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
                            if (urlMatch) {
                                processedHref = urlMatch[1];
                            }
                        }
                        return processHubDriveLink(processedHref);
                    }
                }
                
                // Try alternative selectors
                const alternatives = [
                    'a.btn.btn-primary',
                    '.btn-primary',
                    'a[href*="download"]',
                    'a.btn',
                    '#download',
                    '.download-btn',
                    '[href*="hubcloud.php"]',
                    '[href*="gamerxyt.com"]'
                ];
                
                let foundBtn = null;
                let usedSelector = '';
                for (const selector of alternatives) {
                    foundBtn = $(selector);
                    if (foundBtn.length > 0) {
                        console.log(`Found element with selector: ${selector}`);
                        usedSelector = selector;
                        break;
                    }
                }
                
                if (!foundBtn || foundBtn.length === 0) {
                    console.log('Available links on page:');
                    $('a[href]').slice(0, 20).each((i, elem) => {
                        console.log(`Link ${i + 1}: ${$(elem).attr('href')} (text: ${$(elem).text().trim().substring(0, 50)})`);
                    });
                    throw new Error('Download button not found with any selector');
                }
                
                const href = foundBtn.attr('href');
                if (!href) {
                    throw new Error('Download link not found');
                }
                
                return processHubDriveLink(href);
            }
            
            const href = downloadBtn.attr('href');
            if (!href) {
                throw new Error('Download link not found');
            }
            
            return processHubDriveLink(href);
        })
        .catch(error => {
            console.error('Error extracting HubDrive links:', error.message);
            return [];
        });
}

function processHubDriveLink(href) {
    // Check if it's a HubCloud link
    if (href.toLowerCase().includes('hubcloud')) {
        console.log('HubDrive link redirects to HubCloud, processing...');
        return extractHubCloudLinks(href, 'HubDrive');
    } else {
        console.log('HubDrive direct link found');
        // Direct link or other extractor
        return Promise.resolve([{
            name: 'HubDrive',
            title: 'HubDrive',
            url: href,
            quality: 1080
        }]);
    }
}

// Function to normalize image URLs
async function normalizeImageUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) {
        const domains = await getDomains();
        const baseUrl = domains?.['4khdhub'] || '';
        return baseUrl + url;
    }
    return url;
}

// Function to generate ID from URL
function generateIdFromUrl(url) {
    try {
        const urlParts = url.split('/');
        const relevantPart = urlParts.find(part => 
            part.length > 5 && !part.includes('4khdhub') && !part.includes('fans')
        );
        return relevantPart ? relevantPart.replace(/[^a-zA-Z0-9-]/g, '') : '';
    } catch {
        return '';
    }
}

// Function to determine content type
function determineContentType(formats) {
    if (formats.some(format => format.toLowerCase().includes('series'))) {
        return 'Series';
    }
    return 'Movie';
}

// --- Stremsrc HTTP Streaming Implementation ---

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

// Function to get sec-ch-ua based on user agent (from stremsrc)
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

// Function to get sec-ch-ua-platform based on user agent (from stremsrc)
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

// Function to get a random user agent (from stremsrc)
function getRandomStremsrcUserAgent() {
  return STREMSRC_USER_AGENTS[Math.floor(Math.random() * STREMSRC_USER_AGENTS.length)];
}

// Function to get headers with randomized user agent (from stremsrc)
function getStremsrcRandomizedHeaders() {
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

// --- HLS Parsing Implementation ---

// Parse HLS master playlist content to extract quality streams
function parseHLSMaster(masterPlaylistContent, baseUrl) {
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

// Helper function to parse HLS attributes
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

// Function to fetch and parse HLS playlist
async function fetchAndParseHLS(url) {
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

// Main function to scrape 4KHDHub search results
async function scrape4KHDHubSearch(searchQuery) {
    try {
        const domains = await getDomains();
        if (!domains || !domains['4khdhub']) {
            throw new Error('Failed to get domain information');
        }
        
        const baseUrl = domains['4khdhub'];
        
        // Multiple search strategies to get more results
        const searchStrategies = [
            { query: searchQuery, name: 'primary' },
            { query: removeYear(searchQuery), name: 'no-year' },
            { query: searchQuery.split(' ').slice(0, 3).join(' '), name: 'first-three-words' },
            { query: cleanTitle(searchQuery), name: 'clean-title' }
        ];
        
        // Remove duplicate queries and filter empty ones
        const uniqueStrategies = [];
        const seenQueries = new Set();
        for (const strategy of searchStrategies) {
            if (strategy.query && !seenQueries.has(strategy.query.toLowerCase())) {
                seenQueries.add(strategy.query.toLowerCase());
                uniqueStrategies.push(strategy);
            }
        }
        
        // Try all search strategies in parallel to improve performance
        const searchPromises = uniqueStrategies.map(async (strategy, index) => {
            try {
                const searchUrl = `${baseUrl}/?s=${encodeURIComponent(strategy.query)}`;
                
                console.log(`Searching 4KHDHub with ${strategy.name} query: "${strategy.query}"`);
                console.log(`Search URL: ${searchUrl}`);

                const response = await makeRequest(searchUrl, { 
                    parseHTML: true,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Referer': baseUrl + '/',
                    }
                });

                if (response.statusCode === 200) {
                    const results = await parseMovieCards(response.document, baseUrl);
                    console.log(`Got ${results.length} results from ${strategy.name} search`);
                    return results;
                } else {
                    console.log(`Search with ${strategy.name} query failed with status: ${response.statusCode}`);
                    return [];
                }
            } catch (strategyError) {
                console.log(`Search strategy ${strategy.name} failed:`, strategyError.message);
                return [];
            }
        });

        // Wait for all search promises to complete
        const searchResults = await Promise.all(searchPromises);
        let allResults = [];
        for (const results of searchResults) {
            allResults = allResults.concat(results);
        }

        // Remove duplicate results based on title
        const uniqueResults = [];
        const seenTitles = new Set();
        for (const result of allResults) {
            const titleKey = result.title.toLowerCase();
            if (!seenTitles.has(titleKey)) {
                seenTitles.add(titleKey);
                uniqueResults.push(result);
            }
        }

        console.log(`Total unique results from all strategies: ${uniqueResults.length}`);
        return uniqueResults;
    } catch (error) {
        console.error('Error scraping 4KHDHub search results:', error);
        throw error;
    }
}

// Helper function to parse movie cards from HTML
async function parseMovieCards($, baseUrl) {
    const items = [];

    // Process movie cards from .card-grid .movie-card elements
    $('.card-grid .movie-card').each((index, element) => {
        const $element = $(element);
        
        // Extract post URL from the anchor tag
        const postUrl = $element.attr('href');
        
        // Extract image from .movie-card-image img
        let imageUrl = $element.find('.movie-card-image img').attr('src');
        if (imageUrl) {
            imageUrl = normalizeImageUrl(imageUrl);
        }
        
        // Extract alt text from img
        const altText = $element.find('.movie-card-image img').attr('alt') || '';
        
        // Extract title from .movie-card-title
        const title = $element.find('.movie-card-title').text().trim();
        
        // Extract metadata from .movie-card-meta
        const metaText = $element.find('.movie-card-meta').text().trim();
        
        // Extract year and season info from meta text
        let year = undefined;
        let season = undefined;
        
        // Parse year (4-digit number)
        const yearMatch = metaText.match(/(\d{4})/);
        if (yearMatch) {
            year = yearMatch[1];
        }
        
        // Parse season info (S01-S02, S01, etc.)
        const seasonMatch = metaText.match(/S\d+(?:-S\d+)?/);
        if (seasonMatch) {
            season = seasonMatch[0];
        }
        
        // Extract formats from .movie-card-format spans
        const formats = [];
        $element.find('.movie-card-format').each((_, formatElement) => {
            const format = $(formatElement).text().trim();
            if (format) {
                formats.push(format);
            }
        });
        
        // Determine content type
        const type = determineContentType(formats);
        
        if (title && postUrl) {
            // Make postUrl absolute if it's relative
            const absolutePostUrl = postUrl.startsWith('http') ? postUrl : `${baseUrl}${postUrl.startsWith('/') ? '' : '/'}${postUrl}`;
            
            // Generate ID from URL
            const id = generateIdFromUrl(absolutePostUrl) || `4khdhub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            items.push({
                id,
                title,
                imageUrl: imageUrl || '',
                postUrl: absolutePostUrl,
                year,
                season,
                altText,
                formats,
                type: type.toLowerCase()
            });
        } else {
            console.log('Skipping incomplete item:', { 
                hasTitle: !!title,
                hasUrl: !!postUrl,
                hasImage: !!imageUrl
            });
        }
    });

    console.log(`Successfully parsed ${items.length} movie cards`);
    return items;
}

function loadContent(url) {
    return makeRequest(url, { parseHTML: true })
        .then(response => {
            const $ = response.document;
            const title = $('h1.page-title').text().split('(')[0].trim() || '';
            const poster = $('meta[property="og:image"]').attr('content') || '';
            const tags = $('div.mt-2 span.badge').get().map(el => $(el).text());
            const year = parseInt($('div.mt-2 span').text()) || null;
            const description = $('div.content-section p.mt-4').text().trim() || '';
            const trailer = $('#trailer-btn').attr('data-trailer-url') || '';

            // Extract language information from badges
            let languages = [];

            // Debug: log all badges found on the page
            console.log(`[4KHDHub] Scanning for language badges...`);
            const allBadges = $('span.badge');
            console.log(`[4KHDHub] Found ${allBadges.length} total badges on page`);

            // Try multiple approaches to find language badge
            // 1. Try by style attribute with teal color
            const tealBadges = $('span.badge').filter((i, el) => {
                const style = $(el).attr('style') || '';
                return style.includes('#0d9488') || style.includes('rgb(13, 148, 136)');
            });

            if (tealBadges.length > 0) {
                const languageText = tealBadges.first().text().trim();
                console.log(`[4KHDHub] Found teal badge: "${languageText}"`);
                languages = languageText.split(',').map(lang => lang.trim().toLowerCase()).filter(Boolean);
            }

            // 2. Fallback: search all badges for language-related text
            if (languages.length === 0) {
                console.log(`[4KHDHub] No teal badge found, searching all badges for language info...`);
                $('span.badge').each((i, el) => {
                    const text = $(el).text().trim();
                    const style = $(el).attr('style') || '';
                    console.log(`[4KHDHub] Badge ${i + 1}: "${text}" (style: "${style}")`);

                    // Check if this badge contains language names
                    if (text.match(/hindi|english|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|gujarati|urdu|spanish|french|german|italian|portuguese|chinese|japanese|korean|russian|arabic|dual|multi/i)) {
                        console.log(`[4KHDHub] ✓ Badge ${i + 1} contains language info`);
                        const langs = text.split(',').map(lang => lang.trim().toLowerCase()).filter(Boolean);
                        languages.push(...langs);
                    }
                });
                languages = [...new Set(languages)]; // Remove duplicates
            }

            console.log(`[4KHDHub] Final extracted languages from badges:`, languages);

            const isMovie = tags.includes('Movies');
            
            // Try multiple selectors to find download links
            let hrefs = [];
            const selectors = [
                'div.download-item a',
                '.download-item a',
                'a[href*="hubdrive"]',
                'a[href*="hubcloud"]',
                'a[href*="drive"]',
                '.btn[href]',
                'a.btn'
            ];
            
            for (const selector of selectors) {
                const links = $(selector)
                    .get()
                    .map(a => $(a).attr('href'))
                    .filter(href => href && href.trim());
                if (links.length > 0) {
                    hrefs = links;
                    console.log(`Found ${links.length} links using selector: ${selector}`);
                    break;
                }
            }
            
            if (hrefs.length === 0) {
                console.log('No download links found. Available links on page:');
                const allLinks = $('a[href]')
                    .get()
                    .map(a => $(a).attr('href'))
                    .filter(href => href && href.includes('http'))
                    .slice(0, 10); // Show first 10 links
                console.log(allLinks);
            }
            
            const content = {
                title,
                poster,
                tags,
                year,
                description,
                trailer,
                type: isMovie ? 'movie' : 'series',
                languages: languages // Add language information to content
            };

            if (isMovie) {
                content.downloadLinks = hrefs;
                console.log(`[4KHDHub] Movie languages:`, languages);
                return Promise.resolve(content);
            } else {
                // Handle TV series episodes
                const episodes = [];
                const episodesMap = new Map();

                console.log('[4KHDHub] Parsing TV series episodes...');

                const seasonItems = $('div.episodes-list div.season-item');
                console.log(`[4KHDHub] Found ${seasonItems.length} season items`);

                seasonItems.each((i, seasonElement) => {
                    // Get season number from episode-number div (e.g., "S01")
                    const seasonText = $(seasonElement).find('div.episode-number').first().text() || '';
                    const seasonMatch = seasonText.match(/S?0*([1-9][0-9]*)/);
                    const season = seasonMatch ? parseInt(seasonMatch[1]) : null;

                    console.log(`[4KHDHub] Processing season ${season} from text: "${seasonText}"`);

                    if (!season) {
                        console.log(`[4KHDHub] Could not extract season number, skipping`);
                        return;
                    }

                    // Find all episode download items within this season
                    // Each episode has: episode-file-info with badge-psa (episode number) and episode-links with download links
                    const seasonContent = $(seasonElement).find('div.episode-content');
                    const episodeBlocks = seasonContent.find('.episode-download-item');

                    console.log(`[4KHDHub] Found ${episodeBlocks.length} episode blocks for season ${season}`);

                    episodeBlocks.each((j, episodeBlock) => {
                        // Get episode number from badge-psa span (e.g., "Episode-03")
                        const episodeText = $(episodeBlock).find('span.badge-psa').text() || '';
                        const episodeMatch = episodeText.match(/Episode-0*([1-9][0-9]*)/);
                        const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;

                        if (!episode) {
                            console.log(`[4KHDHub] Could not extract episode number from: "${episodeText}"`);
                            return;
                        }

                        // Get all download links for this episode
                        const episodeLinks = $(episodeBlock).find('div.episode-links a');
                        const episodeHrefs = episodeLinks.get()
                            .map(a => $(a).attr('href'))
                            .filter(href => href && href.trim() && !href.includes('#'));

                        console.log(`[4KHDHub] S${season}E${episode}: found ${episodeHrefs.length} download links`);

                        if (episodeHrefs.length > 0) {
                            // Use the languages extracted from the page-level badge
                            // All episodes in the series have the same language(s)
                            const key = `${season}-${episode}`;
                            if (!episodesMap.has(key)) {
                                episodesMap.set(key, {
                                    season,
                                    episode,
                                    downloadLinks: [],
                                    languageInfo: [...languages] // Use page-level languages
                                });
                            }
                            episodesMap.get(key).downloadLinks.push(...episodeHrefs);
                        }
                    });
                });

                content.episodes = Array.from(episodesMap.values()).map(ep => ({
                    ...ep,
                    downloadLinks: [...new Set(ep.downloadLinks)], // Remove duplicates
                    languageInfo: ep.languageInfo || [] // Include language information
                }));

                console.log(`[4KHDHub] Parsed ${content.episodes.length} total episodes`);

                return Promise.resolve(content);
            }
        });
}

function extractStreamingLinks(downloadLinks) {
    console.log(`Processing ${downloadLinks.length} download links...`);
    
    // Log the actual links being processed
    downloadLinks.forEach((link, index) => {
        console.log(`Link ${index + 1}: ${link}`);
    });
    
    // Process all links in parallel with configurable concurrency
    const processLink = async (link, index) => {
        try {
            console.log(`Processing link ${index + 1}: ${link}`);
            
            // Check if link needs redirect processing
            if (link.toLowerCase().includes('id=')) {
                console.log(`Link ${index + 1} needs redirect processing`);
                const resolvedLink = await getRedirectLinks(link);
                if (resolvedLink) {
                    console.log(`Link ${index + 1} resolved to: ${resolvedLink}`);
                    return await processExtractorLinkWithAwait(resolvedLink, index + 1);
                } else {
                    console.log(`Link ${index + 1} redirect resolution failed`);
                    return null;
                }
            } else {
                return await processExtractorLinkWithAwait(link, index + 1);
            }
        } catch (err) {
            console.error(`Error processing link ${index + 1} (${link}):`, err.message);
            return null;
        }
    };
    
    // Remove duplicate links before processing to avoid redundant work
    const uniqueDownloadLinks = [...new Set(downloadLinks)];
    
    // Process all links in parallel using Promise.all for better performance
    return Promise.all(uniqueDownloadLinks.map((link, index) => processLink(link, index)))
        .then(results => {
            const validResults = results.filter(result => result !== null);
            const flatResults = validResults.flat();
            // Filter out .zip files and video-downloads.googleusercontent.com URLs
            const filteredResults = flatResults.filter(link => {
                return link && link.url && 
                       !link.url.toLowerCase().endsWith('.zip') && 
                       !link.url.toLowerCase().includes('video-downloads.googleusercontent.com');
            });
            console.log(`Successfully extracted ${filteredResults.length} streaming links (${flatResults.length - filteredResults.length} .zip files excluded)`);
            return filteredResults;
        });
}

// Async version of processExtractorLink for use with await
async function processExtractorLinkWithAwait(link, linkNumber) {
    const linkLower = link.toLowerCase();

    console.log(`Checking extractors for link ${linkNumber}: ${link}`);

    // Check for hubcdn.fans first - needs special decoding for direct MP4 links
    if (linkLower.includes('hubcdn.fans') || linkLower.includes('hubcdn')) {
        console.log(`Link ${linkNumber} matched HubCDN extractor (direct stream extraction)`);
        try {
            const streamResults = await hdhub4uGetStream(link);
            if (streamResults && streamResults.length > 0) {
                // Convert hdhub4uGetStream results to our format
                const convertedLinks = streamResults.map(result => ({
                    name: result.server || 'HubCDN Stream',
                    title: result.server || 'HubCDN Stream',
                    url: result.link,
                    quality: 1080,
                    type: result.type || 'mp4'
                }));
                console.log(`HubCDN extraction completed for link ${linkNumber}:`, convertedLinks);
                return convertedLinks;
            } else {
                console.log(`HubCDN extraction returned no results for link ${linkNumber}`);
                return null;
            }
        } catch (err) {
            console.error(`HubCDN extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('hubdrive')) {
        console.log(`Link ${linkNumber} matched HubDrive extractor`);
        try {
            const links = await extractHubDriveLinks(link);
            console.log(`HubDrive extraction completed for link ${linkNumber}:`, links);
            return links;
        } catch (err) {
            console.error(`HubDrive extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('hubcloud')) {
        console.log(`Link ${linkNumber} matched HubCloud extractor`);
        try {
            const links = await extractHubCloudLinks(link, 'HubCloud');
            console.log(`HubCloud extraction completed for link ${linkNumber}:`, links);
            return links;
        } catch (err) {
            console.error(`HubCloud extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else {
        console.log(`No extractor matched for link ${linkNumber}: ${link}`);
        // Try to extract any direct streaming URLs from the link
        if (link.includes('http') && (link.includes('.mp4') || link.includes('.mkv') || link.includes('.avi') || link.includes('.webm') || link.includes('.m3u8'))) {
            console.log(`Link ${linkNumber} appears to be a direct video link`);
            return [{
                name: 'Direct Link',
                url: link,
                quality: 1080
            }];
        } else {
            return null;
        }
    }
}

function processExtractorLink(link, resolve, linkNumber) {
    const linkLower = link.toLowerCase();

    console.log(`Checking extractors for link ${linkNumber}: ${link}`);

    // Check for hubcdn.fans first - needs special decoding for direct MP4 links
    if (linkLower.includes('hubcdn.fans') || linkLower.includes('hubcdn')) {
        console.log(`Link ${linkNumber} matched HubCDN extractor (direct stream extraction)`);
        hdhub4uGetStream(link)
            .then(streamResults => {
                if (streamResults && streamResults.length > 0) {
                    // Convert hdhub4uGetStream results to our format
                    const convertedLinks = streamResults.map(result => ({
                        name: result.server || 'HubCDN Stream',
                        title: result.server || 'HubCDN Stream',
                        url: result.link,
                        quality: 1080,
                        type: result.type || 'mp4'
                    }));
                    console.log(`HubCDN extraction completed for link ${linkNumber}:`, convertedLinks);
                    resolve(convertedLinks);
                } else {
                    console.log(`HubCDN extraction returned no results for link ${linkNumber}`);
                    resolve(null);
                }
            })
            .catch(err => {
                console.error(`HubCDN extraction failed for link ${linkNumber} (${link}):`, err.message);
                resolve(null);
            });
    } else if (linkLower.includes('hubdrive')) {
        console.log(`Link ${linkNumber} matched HubDrive extractor`);
        extractHubDriveLinks(link)
            .then(links => {
                console.log(`HubDrive extraction completed for link ${linkNumber}:`, links);
                resolve(links);
            })
            .catch(err => {
                console.error(`HubDrive extraction failed for link ${linkNumber} (${link}):`, err.message);
                resolve(null);
            });
    } else if (linkLower.includes('hubcloud')) {
        console.log(`Link ${linkNumber} matched HubCloud extractor`);
        extractHubCloudLinks(link, 'HubCloud')
            .then(links => {
                console.log(`HubCloud extraction completed for link ${linkNumber}:`, links);
                resolve(links);
            })
            .catch(err => {
                console.error(`HubCloud extraction failed for link ${linkNumber} (${link}):`, err.message);
                resolve(null);
            });
    } else {
        console.log(`No extractor matched for link ${linkNumber}: ${link}`);
        // Try to extract any direct streaming URLs from the link
        if (link.includes('http') && (link.includes('.mp4') || link.includes('.mkv') || link.includes('.avi') || link.includes('.webm') || link.includes('.m3u8'))) {
            console.log(`Link ${linkNumber} appears to be a direct video link`);
            resolve([{
                name: 'Direct Link',
                url: link,
                quality: 1080
            }]);
        } else {
            resolve(null);
        }
    }
}



async function get4KHDHubStreams(tmdbId, type, season = null, episode = null, config) {
    try {
        console.log(`[4KHDHub] Starting search for TMDB ID: ${tmdbId}, Type: ${type}${season ? `, Season: ${season}` : ''}${episode ? `, Episode: ${episode}` : ''}`);

        let streamingLinks = [];
        let pageLanguages = []; // Store languages from the page badge - must be declared here for scope

        // Get TMDB details to get the actual title
        const cinemetaDetails = await Cinemeta.getMeta(type, tmdbId);
            if (!cinemetaDetails) {
                console.log(`[4KHDHub] Could not fetch TMDB details for ID: ${tmdbId}`);
                return [];
            }
            
            const year = cinemetaDetails.year ? parseInt(cinemetaDetails.year.split('-')[0]) : null;

            console.log(`[4KHDHub] TMDB Details: ${cinemetaDetails.name} (${year || 'N/A'})`);
            
            // PERFORMANCE FIX: Run all search strategies in parallel instead of sequentially
            // This reduces search time from 5-10+ seconds to ~1-2 seconds
            console.log(`[4KHDHub] Running parallel searches with multiple strategies...`);

            // Build all search queries upfront
            const searchQueries = [];

            // Primary search using the actual title
            searchQueries.push({ query: cinemetaDetails.name, strategy: 'primary' });

            // Search without year
            const titleWithoutYear = removeYear(cinemetaDetails.name);
            if (titleWithoutYear !== cinemetaDetails.name) {
                searchQueries.push({ query: titleWithoutYear, strategy: 'no-year' });
            }

            // Alternative title formats
            const alternativeQueries = generateAlternativeQueries(
                cinemetaDetails.name,
                cinemetaDetails.original_title
            ).filter(query => query !== cinemetaDetails.name && query !== titleWithoutYear);

            alternativeQueries.forEach(query => {
                searchQueries.push({ query, strategy: 'alternative' });
            });

            console.log(`[4KHDHub] Executing ${searchQueries.length} parallel searches...`);

            // Execute all searches in parallel
            const searchPromises = searchQueries.map(async ({ query, strategy }) => {
                try {
                    const results = await scrape4KHDHubSearch(query);
                    console.log(`[4KHDHub] ${strategy} search "${query}" found ${results.length} results`);
                    return { query, strategy, results };
                } catch (err) {
                    console.log(`[4KHDHub] ${strategy} search "${query}" failed: ${err.message}`);
                    return { query, strategy, results: [] };
                }
            });

            const allSearchResults = await Promise.all(searchPromises);

            // Find the best match across all search results
            let bestMatch = null;
            let sortedMatches = [];
            let searchResults = [];

            for (const { query, strategy, results } of allSearchResults) {
                if (results.length > 0) {
                    const sorted = getSortedMatches(results, cinemetaDetails.name);
                    const topMatch = sorted[0];

                    if (topMatch && (!bestMatch || (topMatch.score || 0) > (bestMatch.score || 0))) {
                        bestMatch = topMatch;
                        sortedMatches = sorted;
                        searchResults = results;
                        const scoreDisplay = (topMatch.score !== undefined && topMatch.score !== null) ? topMatch.score.toFixed(1) : 'N/A';
                        console.log(`[4KHDHub] Best match from ${strategy} search "${query}" (score: ${scoreDisplay})`);
                    }
                }
            }

            if (searchResults.length === 0) {
                console.log(`[4KHDHub] No search results found for any query variation`);
                return [];
            }

            if (!bestMatch) {
                console.log(`[4KHDHub] No suitable match found for: ${cinemetaDetails.name}`);
                return [];
            }

            let downloadLinks = [];
            // pageLanguages is already declared at function level

            if (type === 'movie') {
                // PERFORMANCE FIX: Limit year validation attempts to top 5 matches to avoid wasting time
                const MAX_YEAR_VALIDATION_ATTEMPTS = 5;
                let validMatch = null;
                const matchesToTry = sortedMatches.slice(0, MAX_YEAR_VALIDATION_ATTEMPTS);

                console.log(`[4KHDHub] Trying year validation for top ${matchesToTry.length} matches (out of ${sortedMatches.length} total)`);

                for (const match of matchesToTry) {
                    const scoreDisplay = (match.score !== undefined && match.score !== null) ? match.score.toFixed(1) : 'N/A';
                    console.log(`[4KHDHub] Trying match: ${match.title} (score: ${scoreDisplay})`);
                    const content = await loadContent(match.url || match.postUrl);

                    if (validateMovieYear(content, year)) {
                        validMatch = match;
                        downloadLinks = content.downloadLinks || [];
                        pageLanguages = content.languages || []; // Preserve page-level languages
                        console.log(`[4KHDHub] Year validation passed for ${content.title}, using this match`);
                        console.log(`[4KHDHub] Page languages from badge:`, pageLanguages);
                        break;
                    } else {
                        console.log(`[4KHDHub] Movie year validation failed for ${content.title}, trying next match...`);
                    }
                }

                if (!validMatch) {
                    console.log(`[4KHDHub] No match passed year validation after trying ${matchesToTry.length} matches`);
                    return [];
                }
            } else if ((type === 'series' || type === 'tv') && season && episode) {
                const content = await loadContent(bestMatch.url || bestMatch.postUrl);
                pageLanguages = content.languages || []; // Preserve page-level languages
                console.log(`[4KHDHub] Page languages from badge:`, pageLanguages);
                console.log(`[4KHDHub] Looking for Season ${season}, Episode ${episode}`);
                console.log(`[4KHDHub] Available episodes:`, content.episodes?.map(ep => `S${ep.season}E${ep.episode} (${ep.downloadLinks?.length || 0} links)`));

                const targetEpisode = content.episodes?.find(ep =>
                    ep.season === parseInt(season) && ep.episode === parseInt(episode)
                );

                if (targetEpisode) {
                    console.log(`[4KHDHub] Found target episode S${targetEpisode.season}E${targetEpisode.episode} with ${targetEpisode.downloadLinks?.length || 0} links`);
                    downloadLinks = targetEpisode.downloadLinks || [];
                } else {
                    console.log(`[4KHDHub] Target episode S${season}E${episode} not found`);
                }
            }
            
            if (downloadLinks.length === 0) {
                console.log(`[4KHDHub] No download links found`);
                return [];
            }

            // Optimized extraction: parallel processing with smart prioritization
            console.log(`[4KHDHub] Found ${downloadLinks.length} redirect URLs, extracting final streams...`);

            // IMPROVED: Increased from 10 to 25 to get more quality options
            const MAX_WORKING_LINKS = parseInt(process.env.MAX_4KHDHUB_LINKS) || 25;
            const PARALLEL_BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 8; // Increased from 5 to 8 for faster processing

            streamingLinks = [];

            // OPTIMIZATION: Prioritize links that are more likely to have higher quality
            // Move HubCloud and direct CDN links to the front
            const prioritizedLinks = [...downloadLinks].sort((a, b) => {
                const aPriority = a.toLowerCase().includes('hubcloud') || a.toLowerCase().includes('pixel') ? 0 :
                                 a.toLowerCase().includes('hubdrive') ? 1 :
                                 a.toLowerCase().includes('workers.dev') ? 2 : 3;
                const bPriority = b.toLowerCase().includes('hubcloud') || b.toLowerCase().includes('pixel') ? 0 :
                                 b.toLowerCase().includes('hubdrive') ? 1 :
                                 b.toLowerCase().includes('workers.dev') ? 2 : 3;
                return aPriority - bPriority;
            });

            console.log(`[4KHDHub] Link prioritization: HubCloud/Pixel first, then HubDrive, then Workers.dev`);

            // Process in batches for parallel execution
            for (let i = 0; i < prioritizedLinks.length && streamingLinks.length < MAX_WORKING_LINKS; i += PARALLEL_BATCH_SIZE) {
                const batch = prioritizedLinks.slice(i, i + PARALLEL_BATCH_SIZE);
                console.log(`[4KHDHub] Processing batch ${Math.floor(i/PARALLEL_BATCH_SIZE) + 1} (${batch.length} links)...`);

                // Process batch in parallel
                const batchPromises = batch.map(async (link) => {
                    try {
                        const extracted = await extractStreamingLinks([link]);
                        return extracted; // Array of extracted streams
                    } catch (err) {
                        console.log(`[4KHDHub] Failed to extract link: ${err.message}`);
                        return [];
                    }
                });

                const batchResults = await Promise.all(batchPromises);

                // Flatten and add to streamingLinks
                for (const result of batchResults) {
                    streamingLinks.push(...result);
                    // IMPROVED: Only stop early if we have enough 4K streams OR reached max
                    const has4K = streamingLinks.some(s => {
                        const title = (s.title || s.name || '').toLowerCase();
                        return title.includes('2160p') || title.includes('4k');
                    });

                    if (streamingLinks.length >= MAX_WORKING_LINKS && has4K) {
                        console.log(`[4KHDHub] Reached ${MAX_WORKING_LINKS} working links with 4K content, stopping early`);
                        break;
                    }
                }
            }

            console.log(`[4KHDHub] Extracted ${streamingLinks.length} working stream(s)`);

        // Filter out suspicious AMP/redirect URLs
        const filteredLinks = streamingLinks.filter(link => {
            const url = link.url.toLowerCase();
            const suspiciousPatterns = [
                'www-google-com.cdn.ampproject.org',
                'bloggingvector.shop',
                'cdn.ampproject.org',
            ];
            
            const isSuspicious = suspiciousPatterns.some(pattern => url.includes(pattern));
            if (isSuspicious) {
                console.log(`[4KHDHub] Filtered out suspicious URL: ${link.url}`);
                return false;
            }
            return true;
        });
        
        // Remove duplicates based on URL
        const uniqueLinks = [];
        const seenUrls = new Set();

        for (const link of filteredLinks) {
            if (!seenUrls.has(link.url)) {
                seenUrls.add(link.url);
                uniqueLinks.push(link);
            }
        }

        console.log(`[4KHDHub] After URL dedup: ${uniqueLinks.length} unique links (${streamingLinks.length - filteredLinks.length} suspicious URLs filtered, ${filteredLinks.length - uniqueLinks.length} duplicates removed)`);

        // Skip quality-based deduplication - keep all unique URLs
        console.log(`[4KHDHub] Skipping quality dedup, keeping all ${uniqueLinks.length} unique URLs`);

        // Validate URLs if DISABLE_4KHDHUB_URL_VALIDATION is false
        let validatedLinks = uniqueLinks;
        const disableValidation = process.env.DISABLE_4KHDHUB_URL_VALIDATION === 'true';

        if (!disableValidation) {
            // Check if seeking validation is specifically disabled (by default it's enabled)
            const enableSeekValidation = process.env.DISABLE_4KHDHUB_SEEK_VALIDATION !== 'true';

            console.log(`[4KHDHub] URL validation enabled, validating ${uniqueLinks.length} links...`);
            console.log(`[4KHDHub] Seek validation ${enableSeekValidation ? 'enabled' : 'disabled'}`);

            // Group links by hostname to identify trusted hosts that can skip validation
            const trustedHosts = [];
            const otherLinks = [];

            for (const link of uniqueLinks) {
                try {
                    const urlObj = new URL(link.url);
                    const hostname = urlObj.hostname;
                    
                    // Check if this host is in the trusted list
                    const isTrustedHost = [
                        'pixeldrain.dev',
                        'pixeldrain.com',
                        'r2.dev',
                        'workers.dev',
                        'hubcdn.fans',
                        'googleusercontent.com'
                    ].some(host => hostname.includes(host));
                    
                    if (isTrustedHost) {
                        trustedHosts.push(link);
                    } else {
                        otherLinks.push(link);
                    }
                } catch {
                    otherLinks.push(link); // If URL is malformed, add to other links for validation
                }
            }
            
            // For trusted hosts, we can skip validation and immediately return them as valid
            let validatedTrustedLinks = trustedHosts;
            
            // Validate other links in chunks to avoid overwhelming the system
            let validatedOtherLinks = [];
            if (otherLinks.length > 0) {
                // Process validation in chunks to avoid overwhelming the system
                const chunkSize = 5; // Process 5 validations at a time
                for (let i = 0; i < otherLinks.length; i += chunkSize) {
                    const chunk = otherLinks.slice(i, i + chunkSize);
                    const validationPromises = chunk.map(async (link) => {
                        let result;

                        if (enableSeekValidation) {
                            // Check for seeking capability (range requests)
                            result = await validateSeekableUrl(link.url);
                        } else {
                            // Use basic validation (original behavior)
                            const isValid = await validateUrl(link.url);
                            // Wrap basic validation in same format
                            result = { isValid, filename: null };
                        }

                        if (!result.isValid) return null;

                        // Update title with extracted filename if available, preserving language tags
                        if (result.filename) {
                            // Extract language information from original title
                            const originalLangs = link.title.match(/\b(English|French|Spanish|German|Italian|Portuguese|Russian|Hindi|Japanese|Korean|Chinese|Arabic|Turkish|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Czech|Hungarian|Romanian|Greek|Hebrew|Thai)\b/gi) || [];

                            // Create new title with filename and preserved language tags
                            const langTags = originalLangs.length > 0 ? ' ' + originalLangs.join(' ') : '';
                            const newTitle = result.filename + langTags;

                            console.log(`[4KHDHub] Updating link title from "${link.title}" to "${newTitle}"`);
                            link.title = newTitle;
                        }

                        return link;
                    });
                    
                    const validationResults = await Promise.allSettled(validationPromises);
                    const chunkValidatedLinks = validationResults
                        .filter(result => result.status === 'fulfilled' && result.value !== null)
                        .map(result => result.value);
                    
                    validatedOtherLinks = validatedOtherLinks.concat(chunkValidatedLinks);
                }
                
                if (enableSeekValidation) {
                    console.log(`[4KHDHub] Seek validation complete: ${validatedOtherLinks.length}/${otherLinks.length} non-trusted links are seekable`);
                } else {
                    console.log(`[4KHDHub] Basic validation complete: ${validatedOtherLinks.length}/${otherLinks.length} non-trusted links are valid`);
                }
            } else {
                console.log(`[4KHDHub] All links from trusted hosts, skipping validation for ${trustedHosts.length} links`);
            }
            
            validatedLinks = [...validatedTrustedLinks, ...validatedOtherLinks];
            console.log(`[4KHDHub] Total validated links: ${validatedLinks.length}/${uniqueLinks.length}`);
        } else {
            console.log(`[4KHDHub] URL validation disabled, skipping validation`);
        }
        
        // Convert to Stremio format
        const streams = validatedLinks.map(link => {
            let resolution = getResolutionFromName(link.title);
            // Add resolution assumption logic if no resolution is found in title
            if (resolution === 'other') {
                const titleLower = link.title.toLowerCase();
                // Only assume resolution based on codec if no specific resolution was found in the title
                if (titleLower.includes('h265') || titleLower.includes('hevc')) {
                    resolution = '2160p'; // assume 4K for H265/HEVC only if no specific resolution found
                } else if (titleLower.includes('h264')) {
                    resolution = '1080p'; // assume 1080p for H264 only if no specific resolution found
                } else {
                    resolution = '1080p'; // default assumption
                }
            }
            // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
            let resolutionLabel;
            if (resolution === '2160p') {
                resolutionLabel = '4k';
            } else if (resolution === '1080p') {
                resolutionLabel = '1080p';
            } else if (resolution === '720p') {
                resolutionLabel = '720p';
            } else if (resolution === '480p') {
                resolutionLabel = '480p';
            } else {
                resolutionLabel = resolution; // fallback for other values
            }
            const size = link.size || 'N/A';
            // Use page-level languages from badge if available, otherwise detect from title
            let detectedLanguages;

            if (pageLanguages.length > 0) {
                // Use badge languages as primary source
                const titleLanguages = detectLanguagesFromTitle(link.title);
                // Merge badge and title languages, but badge takes priority
                detectedLanguages = [...new Set([...pageLanguages, ...titleLanguages])];
                console.log(`[4KHDHub] Languages - Badge: [${pageLanguages.join(', ')}], Title: [${titleLanguages.join(', ')}], Final: [${detectedLanguages.join(', ')}]`);
            } else {
                // No badge languages found, use title detection
                detectedLanguages = detectLanguagesFromTitle(link.title);
                console.log(`[4KHDHub] Using title-detected languages: [${detectedLanguages.join(', ')}]`);
            }

            // Convert size string to bytes for filtering
            let sizeInBytes = 0;
            if (link.size && typeof link.size === 'string') {
                const sizeMatch = link.size.match(/([\d.]+)\s*(GB|MB|TB)/i);
                if (sizeMatch) {
                    const value = parseFloat(sizeMatch[1]);
                    const unit = sizeMatch[2].toUpperCase();
                    if (unit === 'GB') {
                        sizeInBytes = value * 1024 * 1024 * 1024;
                    } else if (unit === 'MB') {
                        sizeInBytes = value * 1024 * 1024;
                    } else if (unit === 'TB') {
                        sizeInBytes = value * 1024 * 1024 * 1024 * 1024;
                    }
                }
            }

            return {
                name: `[HS+] Sootio\n${resolutionLabel}`,
                title: `${link.title}${renderLanguageFlags(detectedLanguages)}\n💾 ${size} | 4KHDHub`,
                url: link.url ? encodeUrlForStreaming(link.url) : link.url,
                _size: sizeInBytes,  // Preserve size in bytes for filtering
                behaviorHints: {
                    bingeGroup: '4khdhub-streams'
                },
                size: link.size,
                resolution: resolution
            }
        });

        // Sort by resolution first, then by size within each resolution group
        streams.sort((a, b) => {
            // Map resolution to numeric value for sorting (higher resolutions first)
            const resolutionPriority = {
                '2160p': 4,
                '1440p': 3,
                '1080p': 2,
                '720p': 1,
                '480p': 0,
                'other': -1
            };
            
            const resolutionA = resolutionPriority[a.resolution] || 0;
            const resolutionB = resolutionPriority[b.resolution] || 0;
            
            // If resolutions are different, sort by resolution (higher first)
            if (resolutionA !== resolutionB) {
                return resolutionB - resolutionA;
            }
            
            // If resolutions are the same, sort by size (larger first)
            const sizeA = a.size ? parseInt(a.size.replace(/[^0-9]/g, '')) : 0;
            const sizeB = b.size ? parseInt(b.size.replace(/[^0-9]/g, '')) : 0;
            return sizeB - sizeA;
        });

        // Additional episode filtering for series to ensure only requested episode is returned
        if ((type === 'series' || type === 'tv') && season && episode) {
            console.log(`[4KHDHub] Additional episode filtering: requested S${season}E${episode}`);
            const requestedEpisodeRegex = new RegExp(`S0*${parseInt(season)}E0*${parseInt(episode)}|S0*${parseInt(season)}-E0*${parseInt(episode)}|\\b${parseInt(season)}x0*${parseInt(episode)}\\b|Episode[\\s-]*0*${parseInt(episode)}\\b`, 'i');

            const episodeFilteredStreams = streams.filter(stream => {
                // Check if episode information is in the title
                const hasCorrectEpisode = requestedEpisodeRegex.test(stream.title);
                if (hasCorrectEpisode) {
                    console.log(`[4KHDHub] Keeping stream for S${season}E${episode}: ${stream.title}`);
                    return true;
                } else {
                    console.log(`[4KHDHub] Filtering out stream (not S${season}E${episode}): ${stream.title}`);
                    return false;
                }
            });

            console.log(`[4KHDHub] Episode filtering: ${streams.length} -> ${episodeFilteredStreams.length} streams after filtering`);
            console.log(`[4KHDHub] Returning ${episodeFilteredStreams.length} streams`);
            return episodeFilteredStreams;
        }

        console.log(`[4KHDHub] Returning ${streams.length} streams`);
        return streams;
        
    } catch (error) {
        console.error(`[4KHDHub] Error getting streams:`, error.message);
        return [];
    }
}

function validateMovieYear(content, expectedYear) {
    if (!expectedYear) {
        return true; // No year to validate against
    }
    
    if (!content.year) {
        return true; // No year available in content, assume valid
    }
    
    // Allow a tolerance of 1 year to account for re-releases, director's cuts etc.
    if (Math.abs(content.year - expectedYear) <= 1) {
        return true;
    } else {
        console.log(`[4KHDHub] Movie year mismatch: found ${content.year}, expected ${expectedYear} (or within 1 year)`);
        return false;
    }
}

// --- Stremsrc Stream Extraction Function ---

// --- Stremsrc Helper Functions ---

// Base domain for stremsrc requests
let STREMSRC_BASEDOM = "https://cloudnestra.com";
const STREMSRC_SOURCE_URL = "https://vidsrc.xyz/embed";

// Function to extract servers from HTML (from stremsrc)
function serversLoad(html) {
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

// Function to handle PRORCP (from stremsrc)
async function PRORCPhandler(prorcp) {
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

// Function to grab RCP data (from stremsrc)
function rcpGrabber(html) {
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

// Function to get content URL based on ID and type (from stremsrc)
function getStreamSrcUrl(id, type) {
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

// Helper function to parse ID for series (compatibility with existing code)
function getObject(id) {
  const arr = id.split(':');
  return {
    id: arr[0],
    season: arr[1] || '1',
    episode: arr[2] || '1'
  }
}

// Main function to get streams from stremsrc
async function getStreamSrcStreams(tmdbId, type, season = null, episode = null, config) {
  try {
    console.log(`[StreamSrc] Starting search for TMDB ID: ${tmdbId}, Type: ${type}${season ? `, Season: ${season}` : ''}${episode ? `, Episode: ${episode}` : ''}`);
    
    // Format the ID based on type
    let id;
    if (type === 'movie' || type === 'Movie') {
      id = tmdbId; // For movies, just use the TMDB ID
    } else {
      // For series, format as tmdbId:season:episode
      id = `${tmdbId}:${season || '1'}:${episode || '1'}`;
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

// Enhanced stream extraction functions based on ScarperApi (without duplicate helpers)
// Using existing rot13, base64Decode, etc. functions that are already defined

async function getRedirectLinksForStream(link) {
    try {
        const res = await makeRequest(link, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        });

        const resText = res.body;

        const regex = /ck\('_wp_http_\d+','([^']+)'/g;
        let combinedString = '';

        let match;
        while ((match = regex.exec(resText)) !== null) {
            combinedString += match[1];
        }

        // Use existing base64Decode and other helper functions
        const decodedString = base64Decode(rot13(base64Decode(base64Decode(combinedString))));
        const data = JSON.parse(decodedString);
        console.log('Redirect data:', data);

        const token = base64Encode(data?.data);
        const blogLink = data?.wp_http1 + '?re=' + token;

        // Wait for the required time
        const waitTime = (Number(data?.total_time) + 3) * 1000;
        console.log(`Waiting ${waitTime}ms before proceeding...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        console.log('Blog link:', blogLink);

        let vcloudLink = 'Invalid Request';
        let attempts = 0;
        const maxAttempts = 5;

        while (vcloudLink.includes('Invalid Request') && attempts < maxAttempts) {
            const blogRes = await makeRequest(blogLink, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            });

            const blogText = blogRes.body;

            if (blogText.includes('Invalid Request')) {
                console.log('Invalid request, retrying...');
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            } else {
                const reurlMatch = blogText.match(/var reurl = "([^"]+)"/);
                if (reurlMatch) {
                    vcloudLink = reurlMatch[1];
                    break;
                }
            }
        }

        return blogLink;
    } catch (err) {
        console.log('Error in getRedirectLinks:', err);
        return link;
    }
}

async function hdhub4uGetStream(link) {
    try {
        console.log('Processing HDHub4u stream link:', link);

        let hubcloudLink = '';

        // Handle hubcdn.fans links directly
        if (link.includes('hubcdn.fans')) {
            console.log('Processing hubcdn.fans link:', link);
            const hubcdnRes = await makeRequest(link, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            });

            const hubcdnText = hubcdnRes.body;

            // Extract reurl from script tag
            const reurlMatch = hubcdnText.match(/var reurl = "([^"]+)"/);
            if (reurlMatch && reurlMatch[1]) {
                const reurlValue = reurlMatch[1];
                console.log('Found reurl:', reurlValue);

                // Extract base64 encoded part after r=
                const urlMatch = reurlValue.match(/\?r=(.+)$/);
                if (urlMatch && urlMatch[1]) {
                    const base64Encoded = urlMatch[1];
                    console.log('Base64 encoded part:', base64Encoded);

                    try {
                        const decodedUrl = base64Decode(base64Encoded);
                        console.log('Decoded URL:', decodedUrl);

                        let finalVideoUrl = decodedUrl;
                        const linkMatch = decodedUrl.match(/[?&]link=(.+)$/);
                        if (linkMatch && linkMatch[1]) {
                            finalVideoUrl = decodeURIComponent(linkMatch[1]);
                            console.log('Extracted video URL:', finalVideoUrl);
                        }

                        return [
                            {
                                server: 'HDHub4u Direct',
                                link: finalVideoUrl,
                                type: 'mp4',
                                copyable: true,
                            },
                        ];
                    } catch (decodeError) {
                        console.error('Error decoding base64:', decodeError);
                    }
                }
            }
        }

        if (link.includes('hubdrive') || link.includes('hubcloud')) {
            hubcloudLink = link;
        } else {
            const res = await makeRequest(link, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            });

            const text = res.body;
            const encryptedString = text.split("s('o','")?.[1]?.split("',180")?.[0];
            console.log('Encrypted string:', encryptedString);

            if (!encryptedString) {
                throw new Error('Could not extract encrypted string from response');
            }

            // Use the decodeString function that already exists in the file
            const decodedString = decodeString(encryptedString);
            console.log('Decoded string:', decodedString);

            if (!decodedString?.o) {
                throw new Error('Invalid decoded data structure');
            }

            link = base64Decode(decodedString.o);
            console.log('New link:', link);

            const redirectLink = await getRedirectLinksForStream(link);
            console.log('Redirect link:', redirectLink);

            // Check if the redirect link is already a hubcloud drive link
            if (redirectLink.includes('hubcloud') && redirectLink.includes('/drive/')) {
                hubcloudLink = redirectLink;
                console.log('Using redirect link as hubcloud link:', hubcloudLink);
            } else {
                // Fetch the redirect page to find download links
                const redirectLinkRes = await makeRequest(redirectLink, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    }
                });

                const redirectLinkText = redirectLinkRes.body;
                const $ = cheerio.load(redirectLinkText);

                // Try multiple selectors to find download/stream links
                hubcloudLink = $('h3:contains("1080p")').find('a').attr('href') ||
                    $('a[href*="hubdrive"]').first().attr('href') ||
                    $('a[href*="hubcloud"]').first().attr('href') ||
                    $('a[href*="drive"]').first().attr('href');

                // If still not found, try regex patterns
                if (!hubcloudLink) {
                    const hubcloudPatterns = [
                        /href="(https:\/\/hubcloud\.[^\/]+\/drive\/[^"]+)"/g,
                        /href="(https:\/\/[^"]*hubdrive[^"]*)"/g,
                        /href="(https:\/\/[^"]*drive[^"]*[a-zA-Z0-9]+)"/g
                    ];

                    for (const pattern of hubcloudPatterns) {
                        const matches = [...redirectLinkText.matchAll(pattern)];
                        if (matches.length > 0) {
                            hubcloudLink = matches[matches.length - 1][1];
                            break;
                        }
                    }
                }

                console.log('Extracted hubcloud link from page:', hubcloudLink);
            }
        }

        if (!hubcloudLink) {
            throw new Error('Could not extract hubcloud link');
        }

        console.log('Final hubcloud link:', hubcloudLink);

        // Extract the final video URL from hubcloud
        const hubcloudRes = await makeRequest(hubcloudLink, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        });

        const finalText = hubcloudRes.body;

        // Try to extract video URL from various patterns
        const videoUrlPatterns = [
            /sources:\s*\[\s*{\s*file:\s*"([^"]+)"/,
            /file:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /src:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /"file":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /"src":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
            /video[^>]*src="([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/
        ];

        for (const pattern of videoUrlPatterns) {
            const match = finalText.match(pattern);
            if (match && match[1]) {
                console.log('Found video URL:', match[1]);
                return [
                    {
                        server: 'HDHub4u Stream',
                        link: match[1],
                        type: 'mp4',
                        copyable: true,
                    }
                ];
            }
        }

        // If no direct video URL found, return the hubcloud link
        return [
            {
                server: 'HDHub4u Hubcloud',
                link: hubcloudLink,
                type: 'redirect',
                copyable: true,
            }
        ];

    } catch (error) {
        console.error('Error in HDHub4u stream extraction:', error);
        return [];
    }
}

// Function to decode string (similar to the one in the original code)
function decodeString(encryptedString) {
    try {
        console.log('Starting decode with:', encryptedString);

        // First base64 decode
        let decoded = base64Decode(encryptedString);
        console.log('After first base64 decode:', decoded);

        // Second base64 decode
        decoded = base64Decode(decoded);
        console.log('After second base64 decode:', decoded);

        // ROT13 decode
        decoded = rot13(decoded);
        console.log('After ROT13 decode:', decoded);

        // Third base64 decode
        decoded = base64Decode(decoded);
        console.log('After third base64 decode:', decoded);

        // Parse JSON
        const result = JSON.parse(decoded);
        console.log('Final parsed result:', result);
        return result;
    } catch (error) {
        console.error('Error decoding string:', error);

        // Try alternative decoding approaches
        try {
            console.log('Trying alternative decode approach...');
            let altDecoded = base64Decode(encryptedString);
            altDecoded = base64Decode(altDecoded);
            const altResult = JSON.parse(altDecoded);
            console.log('Alternative decode successful:', altResult);
            return altResult;
        } catch (altError) {
            console.error('Alternative decode also failed:', altError);
            return null;
        }
    }
}
/**
 * Resolve a single 4KHDHub redirect URL to its final direct streaming link
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve redirect to file hosting URL, 2) Decrypt to final stream URL
 * @param {string} redirectUrl - Original redirect URL that needs resolution + decryption
 * @returns {Promise<string|null>} - Final direct streaming URL
 */
async function resolveHttpStreamUrl(redirectUrl) {
    try {
        console.log('[HTTP-RESOLVE] Starting resolution for redirect URL');

        const decodedUrl = decodeURIComponent(redirectUrl);
        console.log('[HTTP-RESOLVE] Redirect URL:', decodedUrl.substring(0, 100) + '...');

        // Step 1: Resolve redirect to file hosting URL (hubcloud/hubdrive)
        let fileHostingUrl;
        if (decodedUrl.toLowerCase().includes('id=')) {
            console.log('[HTTP-RESOLVE] Resolving redirect to file hosting URL...');
            fileHostingUrl = await getRedirectLinks(decodedUrl);
            if (!fileHostingUrl || !fileHostingUrl.trim()) {
                console.log('[HTTP-RESOLVE] Failed to resolve redirect');
                return null;
            }
            console.log('[HTTP-RESOLVE] Resolved to file hosting URL:', fileHostingUrl.substring(0, 100) + '...');
        } else {
            // Already a direct URL
            fileHostingUrl = decodedUrl;
            console.log('[HTTP-RESOLVE] URL is already a file hosting URL');
        }

        // Step 2: Decrypt file hosting URL to final streaming URL
        console.log('[HTTP-RESOLVE] Decrypting file hosting URL...');
        const result = await processExtractorLinkWithAwait(fileHostingUrl, 99);  // Get ALL results, not just 1

        if (!result || result.length === 0) {
            console.log('[HTTP-RESOLVE] No valid stream found after decryption');
            return null;
        }

        console.log(`[HTTP-RESOLVE] Found ${result.length} potential stream(s), selecting best one...`);

        // Log all results for debugging
        result.forEach((r, idx) => {
            const type = r.url.includes('pixeldrain') ? 'Pixeldrain' :
                         r.url.includes('googleusercontent') ? 'GoogleUserContent' :
                         r.url.includes('workers.dev') ? 'Workers.dev' :
                         r.url.includes('hubcdn') ? 'HubCDN' :
                         r.url.includes('r2.dev') ? 'R2' : 'Other';
            console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${type}] ${r.url.substring(0, 80)}...`);
        });

        // Prioritize links that are likely to support 206 range requests
        // Priority order: pixeldrain > workers.dev > r2.dev > hubcdn.fans > googleusercontent (last resort)
        // NOTE: Pixeldrain is TOP priority - it supports 206 and has no rate limits for streaming
        const priorityPatterns = [
            { pattern: 'pixeldrain.com', name: 'Pixeldrain' },
            { pattern: 'pixeldrain.net', name: 'Pixeldrain' },
            { pattern: 'workers.dev', name: 'Cloudflare Workers' },
            { pattern: 'r2.dev', name: 'Cloudflare R2' },
            { pattern: 'hubcdn.fans', name: 'HubCDN' },
            { pattern: 'googleusercontent.com', name: 'Google Cloud' }
        ];

        // Try priority patterns first
        for (const { pattern, name } of priorityPatterns) {
            const match = result.find(r => r.url && r.url.includes(pattern));
            if (match) {
                console.log(`[HTTP-RESOLVE] Selected ${name} link: ${match.url.substring(0, 100)}...`);
                return match.url;
            }
        }

        // Fallback to first result if no priority match (might be Pixeldrain or other)
        console.log(`[HTTP-RESOLVE] No priority match found, using first result: ${result[0].url.substring(0, 100)}...`);
        return result[0].url;
    } catch (error) {
        console.error('[HTTP-RESOLVE] Error resolving HTTP stream:', error.message);
        return null;
    }
}

// --- VidLink.pro Stream Extraction ---

// VidLink.pro API configuration
const VIDLINK_API_BASE = 'https://vidlink.pro/api/b';
const VIDLINK_KEY_HEX = '2de6e6ea13a9df9503b11a6117fd7e51941e04a0c223dfeacfe8a1dbb6c52783';
const VIDLINK_KEY = Buffer.from(VIDLINK_KEY_HEX, 'hex').slice(0, 32); // 32 bytes for AES-256
const VIDLINK_ALGORITHM = 'aes-256-cbc';

/**
 * Encrypt data for VidLink.pro API using AES-256-CBC
 * @param {string} data - Data to encrypt
 * @returns {string} - Base64 encoded result in format "iv:encrypted"
 */
function vidlinkEncrypt(data) {
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(VIDLINK_ALGORITHM, VIDLINK_KEY, iv);
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const result = `${iv.toString('hex')}:${encrypted}`;
        return Buffer.from(result).toString('base64');
    } catch (error) {
        console.error('[VidLink] Encryption error:', error);
        throw error;
    }
}

/**
 * Decrypt data from VidLink.pro API using AES-256-CBC
 * @param {string} encryptedData - Base64 encoded data in format "iv:encrypted"
 * @returns {string} - Decrypted data
 */
function vidlinkDecrypt(encryptedData) {
    try {
        if (!encryptedData) {
            throw new Error('No data provided for decryption');
        }

        const decodedData = Buffer.from(encryptedData, 'base64').toString('utf8');
        console.log(`[VidLink] Decoded data before split: ${decodedData.substring(0, 100)}`);

        const [ivHex, encryptedHex] = decodedData.split(':');

        if (!ivHex || !encryptedHex) {
            throw new Error(`Invalid encrypted data format. Expected "iv:encrypted", got: ${decodedData.substring(0, 100)}`);
        }

        const iv = Buffer.from(ivHex, 'hex');
        const encrypted = Buffer.from(encryptedHex, 'hex');
        const decipher = crypto.createDecipheriv(VIDLINK_ALGORITHM, VIDLINK_KEY, iv);
        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString('utf8');
    } catch (error) {
        console.error('[VidLink] Decryption error:', error);
        throw error;
    }
}

/**
 * Make request to VidLink.pro API
 * @param {string} endpoint - API endpoint (e.g., '/movie/123')
 * @returns {Promise<Object>} - Parsed JSON response
 */
async function vidlinkApiRequest(endpoint) {
    const url = `${VIDLINK_API_BASE}${endpoint}`;
    console.log(`[VidLink] Making API request to: ${url}`);

    return new Promise((resolve, reject) => {
        const options = {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://vidlink.pro/'
            },
            timeout: 15000
        };

        const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
        if (proxyAgent) {
            options.agent = proxyAgent;
        }

        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;

        const req = protocol.request(urlObj, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        console.error(`[VidLink] API returned status ${res.statusCode}: ${data}`);
                        reject(new Error(`API returned status ${res.statusCode}`));
                        return;
                    }

                    console.log(`[VidLink] Raw response (first 200 chars): ${data.substring(0, 200)}`);
                    console.log(`[VidLink] Response length: ${data.length}`);

                    // Check if response is empty
                    if (!data || data.trim().length === 0) {
                        console.error('[VidLink] API returned empty response');
                        reject(new Error('Empty API response'));
                        return;
                    }

                    // Try to decrypt the response
                    let parsed;
                    try {
                        const decrypted = vidlinkDecrypt(data);
                        parsed = JSON.parse(decrypted);
                    } catch (decryptError) {
                        // If decryption fails, try parsing as plain JSON
                        console.log('[VidLink] Decryption failed, attempting to parse as plain JSON');
                        try {
                            parsed = JSON.parse(data);
                            console.log('[VidLink] Successfully parsed as plain JSON (API may have changed format)');
                        } catch (jsonError) {
                            console.error('[VidLink] Failed to parse as both encrypted and plain JSON');
                            throw decryptError; // Throw the original decryption error
                        }
                    }
                    resolve(parsed);
                } catch (error) {
                    console.error('[VidLink] Failed to parse response:', error);
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            console.error('[VidLink] Request error:', error);
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

/**
 * Get streams from VidLink.pro
 * @param {string} imdbId - IMDB ID (will be converted to TMDB ID via Cinemeta)
 * @param {string} type - 'movie' or 'tv'
 * @param {number} season - Season number (for TV shows)
 * @param {number} episode - Episode number (for TV shows)
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} - Array of stream objects
 */
async function getVidLinkProStreams(imdbId, type, season = null, episode = null, config = {}) {
    try {
        console.log(`[VidLink] Starting search for IMDB ID: ${imdbId}, Type: ${type}${season ? `, Season: ${season}` : ''}${episode ? `, Episode: ${episode}` : ''}`);

        // Get metadata from Cinemeta to extract TMDB ID
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        if (!cinemetaDetails || !cinemetaDetails.moviedb_id) {
            console.log(`[VidLink] Could not fetch TMDB ID from Cinemeta for IMDB ID: ${imdbId}`);
            return [];
        }

        const tmdbId = cinemetaDetails.moviedb_id;
        console.log(`[VidLink] Resolved TMDB ID: ${tmdbId} from IMDB ID: ${imdbId}`);

        // Encrypt the TMDB ID
        const encryptedId = vidlinkEncrypt(tmdbId.toString());
        const encodedId = encodeURIComponent(encryptedId);

        // Build the API endpoint
        let endpoint;
        if (type === 'movie') {
            endpoint = `/movie/${encodedId}`;
        } else if (type === 'tv' || type === 'series') {
            if (!season || !episode) {
                console.log('[VidLink] Season and episode are required for TV shows');
                return [];
            }
            endpoint = `/tv/${encodedId}/${season}/${episode}`;
        } else {
            console.log(`[VidLink] Unsupported type: ${type}`);
            return [];
        }

        // Make the API request
        const response = await vidlinkApiRequest(endpoint);
        console.log(`[VidLink] API response:`, JSON.stringify(response).substring(0, 200));

        if (!response || !response.stream) {
            console.log('[VidLink] No stream data in response');
            return [];
        }

        const stream = response.stream;

        // Check if playlist URL exists
        if (!stream.playlist) {
            console.log('[VidLink] No playlist URL found in stream');
            return [];
        }

        console.log(`[VidLink] Found playlist: ${stream.playlist}`);

        // Get media title for display (already fetched above)
        const mediaTitle = cinemetaDetails.name || 'Unknown';

        // Create stream object
        const streamObject = {
            name: '[HS+] Sootio\nVidLink',
            title: `${mediaTitle}\n🎬 VidLink.pro | HLS Stream`,
            url: stream.playlist,
            needsResolution: false, // HLS playlists can be played directly
            behaviorHints: {
                bingeGroup: `vidlink-${tmdbId}`,
                notWebReady: false // HLS works in browsers
            }
        };

        // Add captions if available
        if (stream.captions && Array.isArray(stream.captions) && stream.captions.length > 0) {
            streamObject.subtitles = stream.captions.map(caption => ({
                id: caption.id || caption.language,
                url: caption.url,
                lang: caption.language || 'unknown'
            }));
            console.log(`[VidLink] Found ${stream.captions.length} subtitle(s)`);
        }

        console.log('[VidLink] Successfully extracted 1 stream');
        return [streamObject];

    } catch (error) {
        console.error('[VidLink] Error:', error.message);
        return [];
    }
}

// Export functions
export { get4KHDHubStreams, getStreamSrcStreams, validateSeekableUrl, resolveHttpStreamUrl, extractHubCloudLinks, getVidLinkProStreams };
