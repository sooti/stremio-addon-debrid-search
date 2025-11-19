/**
 * HTTP Stream URL Resolver
 * Resolves redirect URLs to final streaming links
 * Handles lazy-load mode for 4KHDHub, HDHub4u, and UHDMovies
 */

import { getRedirectLinks, processExtractorLinkWithAwait } from '../providers/4khdhub/extraction.js';
import { validateSeekableUrl } from '../utils/validation.js';

const PRIORITY_PATTERNS = [
    { pattern: 'pixeldrain.com', name: 'Pixeldrain' },
    { pattern: 'pixeldrain.net', name: 'Pixeldrain' },
    { pattern: 'pixeldrain.dev', name: 'Pixeldrain' },
    { pattern: 'workers.dev', name: 'Cloudflare Workers' },
    { pattern: 'r2.dev', name: 'Cloudflare R2' },
    { pattern: 'hubcdn.fans', name: 'HubCDN' },
    { pattern: 'googleusercontent.com', name: 'Google Cloud' }
];

async function findSeekableLink(results) {
    if (!Array.isArray(results) || results.length === 0) {
        return null;
    }

    const cache = new Map();

    const checkUrl = async (candidate, label) => {
        if (!candidate?.url) return false;
        if (cache.has(candidate.url)) {
            return cache.get(candidate.url);
        }

        try {
            const validation = await validateSeekableUrl(candidate.url, { requirePartialContent: true });
            if (validation.isValid) {
                console.log(`[HTTP-RESOLVE] Selected ${label} link with confirmed 206 support`);
                cache.set(candidate.url, true);
                return true;
            }
            console.log(`[HTTP-RESOLVE] Rejected ${label} link (status: ${validation.statusCode || 'unknown'}) due to missing 206 support`);
            cache.set(candidate.url, false);
            return false;
        } catch (error) {
            console.error(`[HTTP-RESOLVE] Error validating ${label} link: ${error.message}`);
            cache.set(candidate.url, false);
            return false;
        }
    };

    for (const { pattern, name } of PRIORITY_PATTERNS) {
        const candidate = results.find(r => r.url && r.url.includes(pattern));
        if (candidate && await checkUrl(candidate, name)) {
            return candidate.url;
        }
    }

    for (const candidate of results) {
        let hostname = 'unknown';
        if (candidate?.url) {
            try {
                hostname = new URL(candidate.url).hostname;
            } catch {
                hostname = 'unknown';
            }
        }
        if (await checkUrl(candidate, hostname)) {
            return candidate.url;
        }
    }

    return null;
}

/**
 * Resolve a redirect URL to its final direct streaming link
 * Handles lazy-load resolution for 4KHDHub, HDHub4u, and UHDMovies
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve redirect to file hosting URL, 2) Extract/decrypt to final stream URL, 3) Validate with 206 check
 * @param {string} redirectUrl - Original redirect URL that needs resolution + decryption
 * @returns {Promise<string|null>} - Final direct streaming URL with confirmed 206 support
 */
export async function resolveHttpStreamUrl(redirectUrl) {
    try {
        console.log('[HTTP-RESOLVE] Starting lazy resolution (on-demand extraction + validation)');

        const decodedUrl = decodeURIComponent(redirectUrl);
        console.log('[HTTP-RESOLVE] Redirect URL:', decodedUrl.substring(0, 100) + '...');

        // Detect provider type from URL
        let provider = 'Unknown';
        if (decodedUrl.includes('hubcloud') || decodedUrl.includes('hubdrive') || decodedUrl.includes('4khdhub')) {
            provider = '4KHDHub/HDHub4u';
        } else if (decodedUrl.includes('hubcdn.fans')) {
            provider = 'HDHub4u';
        }
        console.log('[HTTP-RESOLVE] Detected provider:', provider);

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

        const seekableLink = await findSeekableLink(result);
        if (seekableLink) {
            console.log(`[HTTP-RESOLVE] Returning seekable link: ${seekableLink.substring(0, 100)}...`);
            return seekableLink;
        }

        console.log('[HTTP-RESOLVE] No links with confirmed 206 support were found');
        return null;
    } catch (error) {
        console.error('[HTTP-RESOLVE] Error resolving HTTP stream:', error.message);
        return null;
    }
}
