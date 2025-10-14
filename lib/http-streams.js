import Cinemeta from './util/cinemeta.js';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import RedisCache from './util/redisCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
console.log(`[4KHDHub] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.4khdhub_cache') : path.join(__dirname, '.cache', '4khdhub');
const redisCache = new RedisCache('4KHDHub');

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

  // Try Redis cache first, then fallback to file system
  const cachedData = await redisCache.getFromCache(key, '', CACHE_DIR);
  if (cachedData) {
    return cachedData.data || cachedData; // Support both new format (data field) and legacy format
  }

  return null;
};

const saveToCache = async (key, data) => {
  if (!CACHE_ENABLED) return;

  const cacheData = {
    data: data
  };

  // Save to both Redis and file system
  await redisCache.saveToCache(key, cacheData, '', CACHE_DIR);
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
    if (lowerCaseName.includes('2160p') || lowerCaseName.includes('4k') || lowerCaseName.includes('uhd')) return '2160p';
    if (lowerCaseName.includes('1080p')) return '1080p';
    if (lowerCaseName.includes('720p')) return '720p';
    if (lowerCaseName.includes('480p')) return '480p';
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

        if (options.allowRedirects === false) {
            requestOptions.followRedirect = false;
        }

        const req = protocol.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data,
                    document: options.parseHTML ? cheerio.load(data) : null
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
            
            // Check if this is already a hubcloud.php URL
            let href;
            if (url.includes('hubcloud.php')) {
                href = url;
                console.log(`Already a hubcloud.php URL: ${href}`);
            } else {
                const downloadElement = $('#download');
                if (!downloadElement) {
                    console.log('Download element #download not found, trying alternatives...');
                    // Try alternative selectors
                    const alternatives = ['a[href*="hubcloud.php"]', '.download-btn', 'a[href*="download"]'];
                    let found = false;
                    
                    for (const selector of alternatives) {
                        const altElement = $(selector);
                        if (altElement) {
                            const rawHref = altElement.attr('href');
                            if (rawHref) {
                                href = rawHref.startsWith('http') ? rawHref : `${baseUrl.replace(/\/$/, '')}/${rawHref.replace(/^\//, '')}`;
                                console.log(`Found download link with selector ${selector}: ${href}`);
                                found = true;
                                break;
                            }
                        }
                    }
                    
                    if (!found) {
                        throw new Error('Download element not found with any selector');
                    }
                } else {
                    const rawHref = downloadElement.attr('href');
                    if (!rawHref) {
                        throw new Error('Download href not found');
                    }
                    
                    href = rawHref.startsWith('http') ? rawHref : `${baseUrl.replace(/\/$/, '')}/${rawHref.replace(/^\//, '')}`;
                    console.log(`Found download href: ${href}`);
                }
            }
            
            console.log(`Making request to HubCloud download page: ${href}`);
            return makeRequest(href, { parseHTML: true });
        })
        .then(response => {
            const $ = response.document;
            const results = [];
            
            console.log(`Processing HubCloud download page...`);
            
            // Extract quality and size information
            const size = $('i#size').text() || '';
            const header = $('div.card-header').text() || '';
            const quality = getIndexQuality(header);
            const headerDetails = cleanTitle(header).trim();
            
            console.log(`Extracted info - Size: ${size}, Header: ${header}, Quality: ${quality}`);
            
            const labelExtras = [];
            if (headerDetails) labelExtras.push(`[${headerDetails}]`);
            if (size) labelExtras.push(`[${size}]`);
            const labelExtra = labelExtras.join('');
            
            // Find download buttons
            const downloadButtons = $('div.card-body h2 a.btn');
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
                    
                    const buttonBaseUrl = getBaseUrl(link);
                    
                    if (text.includes('FSL Server')) {
                        console.log(`Button ${index + 1} is FSL Server`);
                        resolve({
                            name: `${referer} [FSL Server] ${labelExtra}`,
                            title: headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else if (text.includes('Download File')) {
                        console.log(`Button ${index + 1} is Download File`);
                        resolve({
                            name: `${referer} ${labelExtra}`,
                            title: headerDetails,
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
                                resolve({
                                    name: `${referer} [BuzzServer] ${labelExtra}`,
                                    title: headerDetails,
                                    url: buttonBaseUrl + redirectUrl,
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
                            name: `Pixeldrain ${labelExtra}`,
                            title: headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else if (text.includes('S3 Server')) {
                        console.log(`Button ${index + 1} is S3 Server`);
                        resolve({
                            name: `${referer} S3 Server ${labelExtra}`,
                            title: headerDetails,
                            url: link,
                            quality: quality,
                            size: size
                        });
                    } else if (text.includes('10Gbps')) {
                        console.log(`Button ${index + 1} is 10Gbps server, following redirects...`);
                        // Handle 10Gbps server with multiple redirects
                        let currentLink = link;
                        
                        const followRedirects = () => {
                            return makeRequest(currentLink, { 
                                parseHTML: false,
                                allowRedirects: false 
                            })
                            .then(response => {
                                const redirectUrl = response.headers['location'];
                                if (!redirectUrl) {
                                    throw new Error('No redirect found');
                                }
                                
                                console.log(`10Gbps redirect: ${redirectUrl}`);
                                
                                if (redirectUrl.includes('id=')) {
                                    // Final redirect, extract the link parameter
                                    const finalLink = redirectUrl.split('link=')[1];
                                    if (finalLink) {
                                        console.log(`10Gbps final link: ${finalLink}`);
                                        return {
                                            name: `${referer} [Download] ${labelExtra}`,
                                            title: headerDetails,
                                            url: decodeURIComponent(finalLink),
                                            quality: quality,
                                            size: size
                                        };
                                    }
                                    throw new Error('Final link not found');
                                } else {
                                    currentLink = redirectUrl;
                                    return followRedirects();
                                }
                            });
                        };
                        
                        followRedirects()
                            .then(result => {
                                console.log(`10Gbps processing completed`);
                                resolve(result);
                            })
                            .catch(err => {
                                console.log(`10Gbps processing failed: ${err.message}`);
                                resolve(null);
                            });
                    } else {
                        console.log(`Button ${index + 1} is generic link`);
                        // Generic link
                        resolve({
                            name: `${referer} ${labelExtra}`,
                            title: headerDetails,
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
                    return validResults;
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
            
            // Use the exact selector from Kotlin code
            const downloadBtn = $('.btn.btn-primary.btn-user.btn-success1.m-1');
            
            if (!downloadBtn) {
                console.log('Primary download button not found, trying alternative selectors...');
                // Try alternative selectors
                const alternatives = [
                    'a.btn.btn-primary',
                    '.btn-primary',
                    'a[href*="download"]',
                    'a.btn'
                ];
                
                let foundBtn = null;
                for (const selector of alternatives) {
                    foundBtn = $(selector);
                    if (foundBtn) {
                        console.log(`Found download button with selector: ${selector}`);
                        break;
                    }
                }
                
                if (!foundBtn) {
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

function searchContent(query) {
    return getDomains()
        .then(domains => {
            if (!domains || !domains['4khdhub']) {
                throw new Error('Failed to get domain information');
            }
            
            const baseUrl = domains['4khdhub'];
            const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;
            return makeRequest(searchUrl, { parseHTML: true })
                .then(response => ({ response, baseUrl }));
        })
        .then(({ response, baseUrl }) => {
            const $ = response.document;
            const results = [];
            
            const cards = $('div.card-grid a');
            cards.each((index, card) => {
                const title = $(card).find('h3').text();
                const href = $(card).attr('href');
                const posterUrl = $(card).find('img').attr('src');
                
                if (title && href) {
                    // Convert relative URLs to absolute URLs
                    const absoluteUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
                    results.push({
                        title: title.trim(),
                        url: absoluteUrl,
                        poster: posterUrl || ''
                    });
                }
            });
            
            return results;
        });
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
                
                const seasonItems = $('div.episodes-list div.season-item');
                seasonItems.each((i, seasonElement) => {
                    const seasonText = $(seasonElement).find('div.episode-number').text() || '';
                    const seasonMatch = seasonText.match(/S?([1-9][0-9]*)/);
                    const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
                    
                    const episodeItems = $(seasonElement).find('div.episode-download-item');
                    episodeItems.each((j, episodeItem) => {
                        const episodeText = $(episodeItem).find('div.episode-file-info span.badge-psa').text() || '';
                        const episodeMatch = episodeText.match(/Episode-0*([1-9][0-9]*)/);
                        const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;
                        
                        const episodeHrefs = $(episodeItem).find('a')
                            .get()
                            .map(a => $(a).attr('href'))
                            .filter(href => href && href.trim());
                        
                        if (season && episode && episodeHrefs.length > 0) {
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
    
    if (linkLower.includes('hubdrive')) {
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
        if (link.includes('http') && (link.includes('.mp4') || link.includes('.mkv') || link.includes('.avi'))) {
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
            searchResults = await searchContent(searchQuery);
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
                    const fallbackResults = await searchContent(titleWithoutYear);
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
                        const altResults = await searchContent(altQuery);
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
            
            const content = await loadContent(bestMatch.url);
            
            let downloadLinks = [];
            
            if (type === 'movie') {
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
            console.log(`[4KHDHub] URL validation enabled, validating ${uniqueLinks.length} links...`);
            const validationPromises = uniqueLinks.map(async (link) => {
                const isValid = await validateUrl(link.url);
                return isValid ? link : null;
            });
            
            const validationResults = await Promise.all(validationPromises);
            validatedLinks = validationResults.filter(link => link !== null);
            
            console.log(`[4KHDHub] URL validation complete: ${validatedLinks.length}/${uniqueLinks.length} links are valid`);
        } else {
            console.log(`[4KHDHub] URL validation disabled, skipping validation`);
        }
        
        // Convert to Stremio format
        const streams = validatedLinks.map(link => {
            const resolution = getResolutionFromName(link.title);
            const resolutionLabel = (resolution === '2160p') ? '4k' : resolution;
            const size = link.size || 'N/A';
            const langs = link.title.match(/\b(English|French|Spanish|German|Italian|Portuguese|Russian|Hindi|Japanese|Korean|Chinese|Arabic|Turkish|Dutch|Swedish|Norwegian|Danish|Finnish|Polish|Czech|Hungarian|Romanian|Greek|Hebrew|Thai)\b/gi) || [];
            const langCodes = langs.map(lang => Object.keys(LANG_FLAGS).find(key => LANG_FLAGS[key] === LANG_FLAGS[lang.toLowerCase().slice(0, 2)]));

            return {
                name: `[HS+] Sootio\n${resolutionLabel}`,
                title: `${link.title}${renderLangFlags(langCodes)}\n💾 ${size} | 4KHDHub`,
                url: link.url ? encodeUrlForStreaming(link.url) : link.url,
                behaviorHints: {
                    bingeGroup: '4khdhub-streams'
                },
                size: link.size
            }
        });

        const filteredStreams = filterByLanguage(streams, config.Languages);

        filteredStreams.sort((a, b) => {
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

export { get4KHDHubStreams };
