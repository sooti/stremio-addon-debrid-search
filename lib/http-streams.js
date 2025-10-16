import Cinemeta from './util/cinemeta.js';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
console.log(`[4KHDHub] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.4khdhub_cache') : path.join(__dirname, '.cache', '4khdhub');

const ensureCacheDir = async () => {
  if (!CACHE_ENABLED) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`[4KHDHub Cache] Error creating cache directory: ${error.message}`);
    }
  }
};

const getFromCache = async (key) => {
  if (!CACHE_ENABLED) return null;

  try {
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    const cachedData = await fs.readFile(cacheFilePath, 'utf8');
    const parsedData = JSON.parse(cachedData);
    
    // Check if cache is expired (assuming 24 hours expiration)
    const cacheTime = parsedData.timestamp || 0;
    const now = Date.now();
    const expiryTime = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    
    if (now - cacheTime > expiryTime) {
      // Cache expired, remove the file
      await fs.unlink(cacheFilePath);
      return null;
    }
    
    return parsedData.data || parsedData; // Support both new format (data field) and legacy format
  } catch (error) {
    // Cache file doesn't exist or is invalid
    return null;
  }
};

const saveToCache = async (key, data) => {
  if (!CACHE_ENABLED) return;

  try {
    const cacheData = {
      data: data,
      timestamp: Date.now()
    };
    
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    await fs.writeFile(cacheFilePath, JSON.stringify(cacheData));
  } catch (error) {
    console.error(`[4KHDHub Cache] Error saving to cache: ${error.message}`);
  }
};

// Initialize cache directory on startup
ensureCacheDir();

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
let cachedDomains = null;

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

const LANG_FLAGS = {
  en: '🇬🇧', fr: '🇫🇷', es: '🇪🇸', de: '🇩🇪', ru: '🇷🇺', it: '🇮🇹', pt: '🇵🇹',
  pl: '🇵🇱', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', ar: '🇦🇪', hi: '🇮🇳', nl: '🇳🇱',
  sv: '🇸🇪', no: '🇳🇴', da: '🇩🇰', fi: '🇫🇮', tr: '🇹🇷', he: '🇮🇱', id: '🇮🇩',
  cs: '🇨🇿', hu: '🇭🇺', ro: '🇷🇴', el: '🇬🇷', th: '🇹🇭'
};
function renderLangFlags(langs) {
  if (!Array.isArray(langs) || langs.length === 0) return '';
  const unique = Array.from(new Set(langs.map(x => String(x).toLowerCase())));
  const flags = unique.map(code => LANG_FLAGS[code]).filter(Boolean);
  return flags.length ? ` ${flags.join('')}` : '';
}

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

function filterByLanguage(streams, languages) {
    if (!languages || languages.length === 0) {
        return streams;
    }
    return streams.filter(stream => {
        const streamLangs = stream.title.match(/\b(English|French|Spanish|German|Italian|Portuguese|Russian|Hindi|Japanese|Korean|Chinese|Arabic|Turkish|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Czech|Hungarian|Romanian|Greek|Hebrew|Thai)\b/gi) || [];
        const streamLangCodes = streamLangs.map(lang => Object.keys(LANG_FLAGS).find(key => LANG_FLAGS[key] === LANG_FLAGS[lang.toLowerCase().slice(0, 2)]));
        return languages.some(lang => streamLangCodes.includes(lang));
    });
}

function validateUrl(url) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);
            
            // Skip validation for known reliable hosting services
             const trustedHosts = [
                 'pixeldrain.dev',
                 'r2.dev'
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
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            };
            
            const req = protocol.request(url, options, (res) => {
                // Consider 2xx and 3xx status codes as valid, including 206 (Partial Content)
                const isValid = res.statusCode >= 200 && res.statusCode < 400;
                console.log(`[4KHDHub] URL validation for ${url}: ${res.statusCode} - ${isValid ? 'VALID' : 'INVALID'}`);
                res.destroy(); // Close connection immediately
                resolve(isValid);
            });
            
            req.on('error', (err) => {
                console.log(`[4KHDHub] URL validation error for ${url}: ${err.message}`);
                resolve(false);
            });
            
            req.on('timeout', () => {
                console.log(`[4KHDHub] URL validation timeout for ${url}`);
                req.destroy();
                resolve(false);
            });
            
            req.setTimeout(15000);
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
            return filename.replace(/\.(mkv|mp4|avi|webm)$/i, '');
        }
    }

    return null;
}

// Function to validate if a URL supports range requests (seeking)
function validateSeekableUrl(url) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);

            // Always allow pixeldrain links regardless of seek validation
            // Skip validation for known reliable hosting services
            const trustedHosts = [
                'pixeldrain.dev',
                'pixeldrain.com',
                'r2.dev'
            ];

            const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));
            const isPixelDrain = urlObj.hostname.includes('pixeldrain');

            if (isTrustedHost) {
                console.log(`[4KHDHub] Skipping seek validation for trusted host: ${urlObj.hostname}`);
                // Still extract filename from Content-Disposition if available
                const protocol = urlObj.protocol === 'https:' ? https : http;
                const options = {
                    method: 'HEAD',
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };

                const req = protocol.request(url, options, (res) => {
                    const filename = extractFilenameFromHeader(res.headers['content-disposition']);
                    res.destroy();
                    resolve({ isValid: true, filename });
                });

                req.on('error', () => resolve({ isValid: true, filename: null }));
                req.on('timeout', () => {
                    req.destroy();
                    resolve({ isValid: true, filename: null });
                });
                req.setTimeout(15000);
                req.end();
                return;
            }

            const protocol = urlObj.protocol === 'https:' ? https : http;

            const options = {
                method: 'HEAD',
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Range': 'bytes=0-0'  // Test range request to check if seeking is supported
                }
            };

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

                // A URL is seekable if it's valid AND supports range requests
                const isSeekable = isValid && supportsRanges;

                res.destroy(); // Close connection immediately
                resolve({ isValid: isSeekable, filename });
            });

            req.on('error', (err) => {
                console.log(`[4KHDHub] Seek validation error for ${url}: ${err.message}`);
                resolve({ isValid: false, filename: null });
            });

            req.on('timeout', () => {
                console.log(`[4KHDHub] Seek validation timeout for ${url}`);
                req.destroy();
                resolve({ isValid: false, filename: null });
            });

            req.setTimeout(15000);
            req.end();
        } catch (error) {
            console.log(`[4KHDHub] Seek validation parse error for ${url}: ${error.message}`);
            resolve({ isValid: false, filename: null });
        }
    });
}

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...options.headers
            }
        };

        const req = protocol.request(requestOptions, (res) => {
            // Handle redirects automatically if not explicitly disabled
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && 
                res.headers.location && options.allowRedirects !== false) {
                console.log(`Following redirect from ${url} to ${res.headers.location}`);
                // Recursively follow the redirect
                makeRequest(res.headers.location, options)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data,
                    document: options.parseHTML ? cheerio.load(data) : null,
                    url: res.headers.location || url // Track final URL if redirected
                });
            });
        });

        req.on('error', reject);
        req.end();
    });
}

function getDomains() {
    if (cachedDomains) {
        return Promise.resolve(cachedDomains);
    }
    
    return makeRequest(DOMAINS_URL)
        .then(response => {
            cachedDomains = JSON.parse(response.body);
            return cachedDomains;
        })
        .catch(error => {
            console.error('Failed to fetch domains:', error.message);
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
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    
    // Score each result
    const scoredResults = results.map(result => {
        let score = 0;
        
        // Exact match gets highest score
        if (normalizeTitle(result.title) === normalizeTitle(query)) {
            score += 100;
        }
        
        // Similarity score (0-50 points)
        const similarity = calculateSimilarity(result.title, query);
        score += similarity * 50;
        
        // Word containment bonus (0-30 points)
        if (containsWords(result.title, query)) {
            score += 30;
        }
        
        // Prefer shorter titles (closer matches) (0-10 points)
        const lengthDiff = Math.abs(result.title.length - query.length);
        score += Math.max(0, 10 - lengthDiff / 5);
        
        // Year extraction bonus - prefer titles with years
        if (result.title.match(/\((19|20)\d{2}\)/)) {
            score += 5;
        }
        
        return { ...result, score };
    });
    
    // Sort by score (highest first)
    scoredResults.sort((a, b) => b.score - a.score);
    
    console.log('\nTitle matching scores:');
    scoredResults.slice(0, 5).forEach((result, index) => {
        console.log(`${index + 1}. ${result.title} (Score: ${result.score.toFixed(1)})`);
    });
    
    return scoredResults[0];
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
                    const filename = pathname.split('/').pop();
                    // Remove file extension
                    return filename.replace(/\.(mkv|mp4|avi|webm)$/i, '');
                } catch {
                    return '';
                }
            };

            // Extract quality and size information
            const size = $('i#size').text() || '';
            const header = $('div.card-header').text() || $('title').text() || '';
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
            
            const promises = downloadButtons.get().map((button, index) => {
                return new Promise((resolve) => {
                    const link = $(button).attr('href');
                    const text = $(button).text();

                    console.log(`Processing button ${index + 1}: "${text}" -> ${link}`);

                    if (!link) {
                        console.log(`Button ${index + 1} has no link`);
                        resolve(null);
                        return;
                    }

                    // Check for pixel.hubcdn.fans links - these redirect to googleusercontent.com
                    if (link.includes('pixel.hubcdn.fans') || link.includes('pixel.rohitkiskk.workers.dev')) {
                        console.log(`Button ${index + 1} is pixel.hubcdn.fans link, following redirects to extract googleusercontent URL...`);

                        makeRequest(link, {
                            parseHTML: false,
                            allowRedirects: false
                        })
                        .then(response => {
                            // Follow redirect chain: pixel.hubcdn.fans -> pixel.rohitkiskk.workers.dev -> gamerxyt.com/dl.php?link=googleusercontent
                            let redirectUrl = response.headers['location'];
                            if (!redirectUrl) {
                                console.log(`Button ${index + 1} pixel link has no redirect`);
                                resolve(null);
                                return;
                            }

                            console.log(`Button ${index + 1} redirects to: ${redirectUrl}`);

                            // Follow the next redirect
                            return makeRequest(redirectUrl, {
                                parseHTML: false,
                                allowRedirects: false
                            });
                        })
                        .then(response2 => {
                            if (!response2) {
                                resolve(null);
                                return;
                            }

                            let finalRedirect = response2.headers['location'];
                            if (!finalRedirect) {
                                console.log(`Button ${index + 1} second redirect has no location`);
                                resolve(null);
                                return;
                            }

                            console.log(`Button ${index + 1} final redirect: ${finalRedirect}`);

                            // Extract googleusercontent URL from dl.php?link= parameter
                            if (finalRedirect.includes('dl.php?link=')) {
                                try {
                                    const urlObj = new URL(finalRedirect);
                                    const googleUrl = urlObj.searchParams.get('link');
                                    if (googleUrl && googleUrl.includes('googleusercontent.com')) {
                                        console.log(`Button ${index + 1} extracted googleusercontent URL: ${googleUrl.substring(0, 100)}...`);
                                        resolve({
                                            name: `${referer} ${text} ${labelExtra}`,
                                            title: getFilenameFromUrl(googleUrl) || headerDetails,
                                            url: googleUrl,
                                            quality: quality,
                                            size: size
                                        });
                                        return;
                                    }
                                } catch (urlError) {
                                    console.log(`Button ${index + 1} failed to parse URL: ${urlError.message}`);
                                }
                            }

                            console.log(`Button ${index + 1} could not extract googleusercontent URL`);
                            resolve(null);
                        })
                        .catch(err => {
                            console.log(`Button ${index + 1} redirect follow failed: ${err.message}`);
                            resolve(null);
                        });
                        return;
                    }

                    // Check for direct workers.dev or hubcdn.fans links from gamerxyt.com
                    if (link.includes('workers.dev') || link.includes('hubcdn.fans')) {
                        // Skip .zip files
                        if (link.toLowerCase().endsWith('.zip')) {
                            console.log(`Button ${index + 1} is a ZIP file, skipping`);
                            resolve(null);
                            return;
                        }

                        console.log(`Button ${index + 1} is direct workers.dev/hubcdn link`);
                        resolve({
                            name: `${referer} ${text} ${labelExtra}`,
                            title: getFilenameFromUrl(link) || headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                        return;
                    }

                    const buttonBaseUrl = getBaseUrl(link);

                    if (text.includes('FSL Server')) {
                        console.log(`Button ${index + 1} is FSL Server`);
                        resolve({
                            name: `${referer} [FSL Server] ${labelExtra}`,
                            title: getFilenameFromUrl(link) || headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else if (text.includes('Download File')) {
                        console.log(`Button ${index + 1} is Download File`);
                        resolve({
                            name: `${referer} ${labelExtra}`,
                            title: getFilenameFromUrl(link) || headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else if (text.includes('BuzzServer')) {
                        console.log(`Button ${index + 1} is BuzzServer, following redirect...`);
                        // Handle BuzzServer redirect
                        makeRequest(`${link}/download`, { 
                            parseHTML: false,
                            allowRedirects: false,
                            headers: { 'Referer': link }
                        })
                        .then(response => {
                            const redirectUrl = response.headers['hx-redirect'] || response.headers['location'];
                            if (redirectUrl) {
                                console.log(`BuzzServer redirect found: ${redirectUrl}`);
                                const finalUrl = buttonBaseUrl + redirectUrl;
                                resolve({
                                    name: `${referer} [BuzzServer] ${labelExtra}`,
                                    title: getFilenameFromUrl(finalUrl) || headerDetails,
                                    url: finalUrl,
                                    quality: quality,
                                    size: size
                                });
                            } else {
                                console.log(`BuzzServer redirect not found`);
                                resolve(null);
                            }
                        })
                        .catch(err => {
                            console.log(`BuzzServer redirect failed: ${err.message}`);
                            resolve(null);
                        });
                    } else if (link.includes('pixeldra')) {
                        console.log(`Button ${index + 1} is Pixeldrain`);
                        resolve({
                            name: `PixelServer ${labelExtra}`,
                            title: headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else if (text.includes('S3 Server')) {
                        console.log(`Button ${index + 1} is S3 Server`);
                        resolve({
                            name: `${referer} S3 Server ${labelExtra}`,
                            title: getFilenameFromUrl(link) || headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else if (text.includes('10Gbps')) {
                        console.log(`Button ${index + 1} is 10Gbps server, skipping (does not support seeking)...`);
                        // Skip 10Gbps servers since they don't support seeking
                        resolve(null);
                    } else if (link.includes('pixeldrain.dev') || link.includes('pixeldrain.com')) {
                        console.log(`Button ${index + 1} is PixelDrain link`);
                        resolve({
                            name: `${referer} PixelServer ${labelExtra}`,
                            title: getFilenameFromUrl(link) || headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else {
                        console.log(`Button ${index + 1} is generic link`);
                        // Generic link
                        resolve({
                            name: `${referer} ${labelExtra}`,
                            title: getFilenameFromUrl(link) || headerDetails,
                            url: link,
                            quality: quality
                        });
                    }
                });
            });
            
            return Promise.all(promises)
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

// Main function to scrape 4KHDHub search results
async function scrape4KHDHubSearch(searchQuery) {
    try {
        const domains = await getDomains();
        if (!domains || !domains['4khdhub']) {
            throw new Error('Failed to get domain information');
        }
        
        const baseUrl = domains['4khdhub'];
        const searchUrl = `${baseUrl}/?s=${encodeURIComponent(searchQuery)}`;
        
        console.log(`Searching 4KHDHub with query: ${searchQuery}`);
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

        if (response.statusCode !== 200) {
            throw new Error(`Failed to fetch search results: ${response.statusCode}`);
        }

        return await parseMovieCards(response.document, baseUrl);
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
                type: isMovie ? 'movie' : 'series'
            };
            
            if (isMovie) {
                content.downloadLinks = hrefs;
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
                            const key = `${season}-${episode}`;
                            if (!episodesMap.has(key)) {
                                episodesMap.set(key, {
                                    season,
                                    episode,
                                    downloadLinks: []
                                });
                            }
                            episodesMap.get(key).downloadLinks.push(...episodeHrefs);
                        }
                    });
                });

                content.episodes = Array.from(episodesMap.values()).map(ep => ({
                    ...ep,
                    downloadLinks: [...new Set(ep.downloadLinks)] // Remove duplicates
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
    
    const promises = downloadLinks.map((link, index) => {
        return new Promise((resolve) => {
            console.log(`Processing link ${index + 1}: ${link}`);
            
            // Check if link needs redirect processing
            if (link.toLowerCase().includes('id=')) {
                console.log(`Link ${index + 1} needs redirect processing`);
                getRedirectLinks(link)
                    .then(resolvedLink => {
                        if (resolvedLink) {
                            console.log(`Link ${index + 1} resolved to: ${resolvedLink}`);
                            processExtractorLink(resolvedLink, resolve, index + 1);
                        } else {
                            console.log(`Link ${index + 1} redirect resolution failed`);
                            resolve(null);
                        }
                    })
                    .catch(err => {
                        console.error(`Redirect failed for link ${index + 1} (${link}):`, err.message);
                        resolve(null);
                    });
            } else {
                processExtractorLink(link, resolve, index + 1);
            }
        });
    });
    
    return Promise.all(promises)
        .then(results => {
            const validResults = results.filter(result => result !== null);
            const flatResults = validResults.flat();
            // Filter out .zip files
            const filteredResults = flatResults.filter(link => {
                return link && link.url && !link.url.toLowerCase().endsWith('.zip');
            });
            console.log(`Successfully extracted ${filteredResults.length} streaming links (${flatResults.length - filteredResults.length} .zip files excluded)`);
            return filteredResults;
        });
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
        
        // Create cache key for resolved file hosting URLs
        const cacheKey = `4khdhub_resolved_urls_v4_${tmdbId}_${type}${season ? `_s${season}e${episode}` : ''}`;
        
        let streamingLinks = [];
        
        // 1. Check cache for resolved file hosting URLs first
        let cachedResolvedUrls = await getFromCache(cacheKey);
        if (cachedResolvedUrls && cachedResolvedUrls.length > 0) {
            console.log(`[4KHDHub] Cache HIT for ${cacheKey}. Using ${cachedResolvedUrls.length} cached resolved URLs.`);
            // Process cached resolved URLs directly to final streaming links
            console.log(`[4KHDHub] Processing ${cachedResolvedUrls.length} cached resolved URLs to get streaming links.`);
            streamingLinks = await extractStreamingLinks(cachedResolvedUrls);
        } else {
            if (cachedResolvedUrls && cachedResolvedUrls.length === 0) {
                console.log(`[4KHDHub] Cache contains empty data for ${cacheKey}. Refetching from source.`);
            } else {
                console.log(`[4KHDHub] Cache MISS for ${cacheKey}. Fetching from source.`);
            }
            
            // Get TMDB details to get the actual title
            const cinemetaDetails = await Cinemeta.getMeta(type, tmdbId);
            if (!cinemetaDetails) {
                console.log(`[4KHDHub] Could not fetch TMDB details for ID: ${tmdbId}`);
                return [];
            }
            
            const year = cinemetaDetails.year ? parseInt(cinemetaDetails.year.split('-')[0]) : null;

            console.log(`[4KHDHub] TMDB Details: ${cinemetaDetails.name} (${year || 'N/A'})`);
            
            // Enhanced search with fallback strategies
            let searchResults = [];
            let bestMatch = null;
            
            // Primary search using the actual title
            const searchQuery = cinemetaDetails.name;
            searchResults = await scrape4KHDHubSearch(searchQuery);
            console.log(`[4KHDHub] Primary search found ${searchResults.length} results`);
            
            if (searchResults.length > 0) {
                bestMatch = findBestMatch(searchResults, cinemetaDetails.name, year);
            }
            
            // Fallback search strategies if no good match found
            if (!bestMatch && searchResults.length > 0) {
                console.log(`[4KHDHub] No good match from primary search, trying fallback strategies...`);
                
                // Try search without year
                const titleWithoutYear = removeYear(cinemetaDetails.name);
                if (titleWithoutYear !== cinemetaDetails.name) {
                    console.log(`[4KHDHub] Trying search without year: "${titleWithoutYear}"`);
                    const fallbackResults = await scrape4KHDHubSearch(titleWithoutYear);
                    if (fallbackResults.length > 0) {
                        const fallbackMatch = findBestMatch(fallbackResults, cinemetaDetails.name, year);
                        if (fallbackMatch && (!bestMatch || fallbackMatch.score > bestMatch.score)) {
                            bestMatch = fallbackMatch;
                            searchResults = fallbackResults;
                        }
                    }
                }
                
                // Try search with comprehensive alternative title formats
                if (!bestMatch) {
                    const alternativeQueries = generateAlternativeQueries(
                        cinemetaDetails.name, 
                        cinemetaDetails.original_title
                    ).filter(query => query !== cinemetaDetails.name); // Exclude the original title we already tried
                    
                    for (const altQuery of alternativeQueries) {
                        console.log(`[4KHDHub] Trying alternative search: "${altQuery}"`);
                        const altResults = await scrape4KHDHubSearch(altQuery);
                        if (altResults.length > 0) {
                            const altMatch = findBestMatch(altResults, cinemetaDetails.name, year);
                            if (altMatch && (!bestMatch || altMatch.score > bestMatch.score)) {
                                bestMatch = altMatch;
                                searchResults = altResults;
                                console.log(`[4KHDHub] Found better match with query: "${altQuery}" (score: ${altMatch.score})`);
                                break;
                            }
                        }
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
            
            console.log(`[4KHDHub] Using best match: ${bestMatch.title}`);

            const content = await loadContent(bestMatch.url || bestMatch.postUrl);
            
            let downloadLinks = [];
            
            if (type === 'movie') {
                // Validate movie year for movies
                if (!validateMovieYear(content, year)) {
                    console.log(`[4KHDHub] Movie year validation failed for ${content.title}, skipping...`);
                    return [];
                }
                downloadLinks = content.downloadLinks || [];
            } else if ((type === 'series' || type === 'tv') && season && episode) {
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
            
            // Resolve redirect URLs to actual file hosting URLs
            console.log(`[4KHDHub] Resolving ${downloadLinks.length} redirect URLs to file hosting URLs...`);
            const resolvedUrls = [];
            
            for (let i = 0; i < downloadLinks.length; i++) {
                const link = downloadLinks[i];
                console.log(`[4KHDHub] Resolving link ${i + 1}/${downloadLinks.length}: ${link}`);
                
                try {
                    if (link.toLowerCase().includes('id=')) {
                        // This is a redirect URL, resolve it
                        const resolvedUrl = await getRedirectLinks(link);
                        if (resolvedUrl && resolvedUrl.trim()) {
                            console.log(`[4KHDHub] Link ${i + 1} resolved to: ${resolvedUrl}`);
                            resolvedUrls.push(resolvedUrl);
                        } else {
                            console.log(`[4KHDHub] Link ${i + 1} resolution failed or returned empty`);
                        }
                    } else {
                        // Direct URL, use as-is
                        console.log(`[4KHDHub] Link ${i + 1} is direct URL: ${link}`);
                        resolvedUrls.push(link);
                    }
                } catch (error) {
                    console.error(`[4KHDHub] Error resolving link ${i + 1} (${link}):`, error.message);
                }
            }
            
            if (resolvedUrls.length === 0) {
                console.log(`[4KHDHub] No URLs resolved successfully`);
                return [];
            }
            
            // Cache the resolved file hosting URLs
            console.log(`[4KHDHub] Caching ${resolvedUrls.length} resolved URLs for key: ${cacheKey}`);
            await saveToCache(cacheKey, resolvedUrls);
            
            // Process resolved URLs to get final streaming links
            console.log(`[4KHDHub] Processing ${resolvedUrls.length} resolved URLs to get streaming links.`);
            streamingLinks = await extractStreamingLinks(resolvedUrls);
        }
        
        // Filter out suspicious AMP/redirect URLs
        const filteredLinks = streamingLinks.filter(link => {
            const url = link.url.toLowerCase();
            const suspiciousPatterns = [
                'www-google-com.cdn.ampproject.org',
                'bloggingvector.shop',
                'cdn.ampproject.org'
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
        
        console.log(`[4KHDHub] Processing ${uniqueLinks.length} unique links (${streamingLinks.length - filteredLinks.length} suspicious URLs filtered, ${filteredLinks.length - uniqueLinks.length} duplicates removed)`);
        
        // Validate URLs if DISABLE_4KHDHUB_URL_VALIDATION is false
        let validatedLinks = uniqueLinks;
        const disableValidation = process.env.DISABLE_4KHDHUB_URL_VALIDATION === 'true';
        
        if (!disableValidation) {
            // Check if seeking validation is specifically disabled (by default it's enabled)
            const enableSeekValidation = process.env.DISABLE_4KHDHUB_SEEK_VALIDATION !== 'true';
            
            console.log(`[4KHDHub] URL validation enabled, validating ${uniqueLinks.length} links...`);
            console.log(`[4KHDHub] Seek validation ${enableSeekValidation ? 'enabled' : 'disabled'}`);
            
            const validationPromises = uniqueLinks.map(async (link) => {
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
            
            const validationResults = await Promise.all(validationPromises);
            validatedLinks = validationResults.filter(link => link !== null);
            
            if (enableSeekValidation) {
                console.log(`[4KHDHub] Seek validation complete: ${validatedLinks.length}/${uniqueLinks.length} links are seekable`);
            } else {
                console.log(`[4KHDHub] Basic validation complete: ${validatedLinks.length}/${uniqueLinks.length} links are valid`);
            }
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
            const langs = link.title.match(/\b(English|French|Spanish|German|Italian|Portuguese|Russian|Hindi|Japanese|Korean|Chinese|Arabic|Turkish|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Czech|Hungarian|Romanian|Greek|Hebrew|Thai)\b/gi) || [];
            const langCodes = langs.map(lang => Object.keys(LANG_FLAGS).find(key => LANG_FLAGS[key] === LANG_FLAGS[lang.toLowerCase().slice(0, 2)]));

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
                title: `${link.title}${renderLangFlags(langCodes)}\n💾 ${size} | 4KHDHub`,
                url: link.url ? encodeUrlForStreaming(link.url) : link.url,
                _size: sizeInBytes,  // Preserve size in bytes for filtering
                behaviorHints: {
                    bingeGroup: '4khdhub-streams'
                },
                size: link.size,
                resolution: resolution
            }
        });

        const filteredStreams = filterByLanguage(streams, config.Languages);

        // Sort by resolution first, then by size within each resolution group
        filteredStreams.sort((a, b) => {
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

        console.log(`[4KHDHub] Returning ${filteredStreams.length} streams`);
        return filteredStreams;
        
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

export { get4KHDHubStreams };
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