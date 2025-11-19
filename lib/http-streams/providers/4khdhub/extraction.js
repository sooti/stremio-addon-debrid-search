/**
 * 4KHDHub Link Extraction Module
 * Handles extraction of streaming links from HubCloud and HubDrive
 */

import { URL } from 'url';
import { makeRequest } from '../../utils/http.js';
import { getIndexQuality, getBaseUrl } from '../../utils/parsing.js';
import { base64Decode, rot13 } from '../../utils/encoding.js';
import { validateSeekableUrl } from '../../utils/validation.js';

/**
 * Extracts HubCloud download links
 * @param {string} url - HubCloud URL
 * @param {string} referer - Referer string for labeling
 * @returns {Promise<Array>} Array of extracted links
 */
export async function extractHubCloudLinks(url, referer) {
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

            // Find ALL download buttons on the page
            // We'll try all buttons and validate which ones support 206
            let downloadButtons = $('a.btn, a[class*="btn"]');
            console.log(`Found ${downloadButtons.length} download buttons (will try all and validate for 206 support)`);

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
                const text = $(button).text().trim();

                console.log(`Processing button ${index + 1}: "${text}" -> ${link}`);

                if (!link || link.startsWith('javascript:') || link === '#' || link === '') {
                    console.log(`Button ${index + 1} has invalid link, skipping`);
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
                    // Convert PixelDrain URLs from /u/ID to /api/file/ID?download
                    let pixelUrl = link;
                    const pixelMatch = link.match(/pixeldrain\.[^/]+\/u\/([a-zA-Z0-9]+)/);
                    if (pixelMatch) {
                        pixelUrl = `https://pixeldrain.dev/api/file/${pixelMatch[1]}?download`;
                        console.log(`Converted PixelDrain URL: ${link} -> ${pixelUrl}`);
                    }
                    return {
                        name: `PixelServer ${labelExtra}`,
                        title: headerDetails,
                        url: pixelUrl,
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
                    // Convert PixelDrain URLs from /u/ID to /api/file/ID?download
                    let pixelUrl = link;
                    const pixelMatch = link.match(/pixeldrain\.[^/]+\/u\/([a-zA-Z0-9]+)/);
                    if (pixelMatch) {
                        pixelUrl = `https://pixeldrain.dev/api/file/${pixelMatch[1]}?download`;
                        console.log(`Converted PixelDrain URL: ${link} -> ${pixelUrl}`);
                    }
                    return {
                        name: `${referer} PixelServer ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: pixelUrl,
                        quality: quality,
                        size: size
                    };
                } else if (link.includes('mega.nz') || link.includes('mega.co') || link.includes('mega.io') || text.toLowerCase().includes('mega')) {
                    console.log(`Button ${index + 1} is Mega link`);
                    return {
                        name: `${referer} Mega ${labelExtra}`,
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
                .then(async (results) => {
                    console.log(`HubCloud post-processing completed, validating ${results.length} links for 206 support...`);

                    // Separate googleusercontent URLs from other URLs
                    const googleUrls = [];
                    const otherUrls = [];

                    for (const result of results) {
                        if (result.url && result.url.includes('googleusercontent.com')) {
                            googleUrls.push(result);
                        } else {
                            otherUrls.push(result);
                        }
                    }

                    console.log(`Found ${otherUrls.length} non-googleusercontent URLs and ${googleUrls.length} googleusercontent URLs`);

                    // Validate non-googleusercontent URLs first (in batches of 4 for performance)
                    const validatedOtherUrls = [];
                    for (let i = 0; i < otherUrls.length; i += 4) {
                        const batch = otherUrls.slice(i, i + 4);
                        const validationResults = await Promise.all(batch.map(async (result) => {
                            try {
                                console.log(`Validating ${result.name}: ${result.url.substring(0, 80)}...`);
                                const validation = await validateSeekableUrl(result.url, { requirePartialContent: true });
                                if (validation.isValid) {
                                    console.log(`✓ ${result.name} supports 206 (status: ${validation.statusCode})`);
                                    return result;
                                } else {
                                    console.log(`✗ ${result.name} does not support 206 (status: ${validation.statusCode || 'unknown'})`);
                                    return null;
                                }
                            } catch (err) {
                                console.log(`✗ ${result.name} validation failed: ${err.message}`);
                                return null;
                            }
                        }));

                        validatedOtherUrls.push(...validationResults.filter(r => r !== null));
                    }

                    // If we found non-googleusercontent URLs that support 206, return them
                    if (validatedOtherUrls.length > 0) {
                        console.log(`Found ${validatedOtherUrls.length} non-googleusercontent URLs with 206 support, skipping googleusercontent URLs`);
                        return validatedOtherUrls;
                    }

                    // Otherwise, fall back to googleusercontent URLs (validate them too)
                    console.log(`No non-googleusercontent URLs with 206 support found, trying googleusercontent URLs...`);
                    const validatedGoogleUrls = [];
                    for (let i = 0; i < googleUrls.length; i += 4) {
                        const batch = googleUrls.slice(i, i + 4);
                        const validationResults = await Promise.all(batch.map(async (result) => {
                            try {
                                console.log(`Validating googleusercontent: ${result.url.substring(0, 80)}...`);
                                const validation = await validateSeekableUrl(result.url, { requirePartialContent: true });
                                if (validation.isValid) {
                                    console.log(`✓ Googleusercontent URL supports 206 (status: ${validation.statusCode})`);
                                    return result;
                                } else {
                                    console.log(`✗ Googleusercontent URL does not support 206 (status: ${validation.statusCode || 'unknown'})`);
                                    return null;
                                }
                            } catch (err) {
                                console.log(`✗ Googleusercontent validation failed: ${err.message}`);
                                return null;
                            }
                        }));

                        validatedGoogleUrls.push(...validationResults.filter(r => r !== null));
                    }

                    if (validatedGoogleUrls.length > 0) {
                        console.log(`Found ${validatedGoogleUrls.length} googleusercontent URLs with 206 support`);
                        return validatedGoogleUrls;
                    }

                    console.log(`No URLs with 206 support found`);
                    return [];
                });
        })
        .catch(error => {
            console.error(`HubCloud extraction error for ${url}:`, error.message);
            return [];
        });
}

/**
 * Extracts HubDrive download links
 * @param {string} url - HubDrive URL
 * @returns {Promise<Array>} Array of extracted links
 */
export function extractHubDriveLinks(url) {
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

/**
 * Processes a HubDrive link
 * @param {string} href - HubDrive link to process
 * @returns {Promise<Array>} Array of extracted links
 */
export function processHubDriveLink(href) {
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

/**
 * Processes redirect links from 4KHDHub
 * @param {string} url - URL to extract redirect from
 * @returns {Promise<string>} Extracted redirect URL
 */
export function getRedirectLinks(url) {
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

/**
 * Extracts streaming links from download links
 * @param {Array<string>} downloadLinks - Array of download links
 * @returns {Promise<Array>} Array of extracted streaming links
 */
export function extractStreamingLinks(downloadLinks) {
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

/**
 * Async version of processExtractorLink for use with await
 * @param {string} link - Link to process
 * @param {number} linkNumber - Link number for logging
 * @returns {Promise<Array|null>} Array of extracted links or null
 */
export async function processExtractorLinkWithAwait(link, linkNumber) {
    const linkLower = link.toLowerCase();

    console.log(`Checking extractors for link ${linkNumber}: ${link}`);

    // Import hdhub4uGetStream dynamically to avoid circular dependency
    const { hdhub4uGetStream } = await import('../hdhub4u/extraction.js');

    // Check for hblinks.dad first - scrape page for hubcloud/hubdrive links
    if (linkLower.includes('hblinks.dad')) {
        console.log(`Link ${linkNumber} matched HBLinks extractor (scraping for download links)`);
        try {
            const response = await makeRequest(link, { parseHTML: true });
            const $ = response.document;

            // Extract hubdrive and hubcloud links from the page
            const extractedLinks = [];
            $('a[href]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href && (href.includes('hubdrive') || href.includes('hubcloud'))) {
                    extractedLinks.push(href);
                    console.log(`Found link in HBLinks page: ${href}`);
                }
            });

            if (extractedLinks.length === 0) {
                console.log(`No hubdrive/hubcloud links found in HBLinks page ${link}`);
                return null;
            }

            console.log(`Found ${extractedLinks.length} links in HBLinks page, processing ALL of them...`);

            // Process ALL available links to get all quality options
            const allResults = [];
            for (let i = 0; i < extractedLinks.length; i++) {
                const extractedLink = extractedLinks[i];
                console.log(`Processing HBLinks extracted link ${i + 1}/${extractedLinks.length}: ${extractedLink}`);
                try {
                    const results = await processExtractorLinkWithAwait(extractedLink, linkNumber);
                    if (results && Array.isArray(results)) {
                        allResults.push(...results);
                    }
                } catch (err) {
                    console.error(`Failed to process HBLinks link ${i + 1}: ${err.message}`);
                }
            }

            console.log(`HBLinks processing complete: collected ${allResults.length} total streams from ${extractedLinks.length} links`);
            return allResults.length > 0 ? allResults : null;
        } catch (err) {
            console.error(`HBLinks extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('hubcdn.fans') || linkLower.includes('hubcdn')) {
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
    } else if (linkLower.includes('gadgetsweb.xyz') || linkLower.includes('gadgetsweb')) {
        console.log(`Link ${linkNumber} matched GadgetsWeb redirect extractor`);
        try {
            // GadgetsWeb is a redirect service that goes to hblinks.dad
            // Follow the redirect and process recursively
            const response = await makeRequest(link, {
                maxRedirects: 5,
                followRedirect: true
            });

            // Check if we got redirected to hblinks
            const finalUrl = response.url || link;
            console.log(`GadgetsWeb redirected to: ${finalUrl}`);

            if (finalUrl.includes('hblinks')) {
                return await processExtractorLinkWithAwait(finalUrl, linkNumber);
            } else {
                console.log(`GadgetsWeb redirect did not go to hblinks, got: ${finalUrl}`);
                return null;
            }
        } catch (err) {
            console.error(`GadgetsWeb extraction failed for link ${linkNumber} (${link}):`, err.message);
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

/**
 * Promise-based version of processExtractorLink (legacy)
 * @param {string} link - Link to process
 * @param {Function} resolve - Promise resolve function
 * @param {number} linkNumber - Link number for logging
 */
export function processExtractorLink(link, resolve, linkNumber) {
    processExtractorLinkWithAwait(link, linkNumber)
        .then(resolve)
        .catch(err => {
            console.error(`Error in processExtractorLink:`, err);
            resolve(null);
        });
}
