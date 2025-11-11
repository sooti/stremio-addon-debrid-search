/**
 * HTTP Stream URL Resolver
 * Resolves redirect URLs to final streaming links
 */

import { getRedirectLinks, processExtractorLinkWithAwait } from '../providers/4khdhub/extraction.js';

/**
 * Resolve a single 4KHDHub redirect URL to its final direct streaming link
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve redirect to file hosting URL, 2) Decrypt to final stream URL
 * @param {string} redirectUrl - Original redirect URL that needs resolution + decryption
 * @returns {Promise<string|null>} - Final direct streaming URL
 */
export async function resolveHttpStreamUrl(redirectUrl) {
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
