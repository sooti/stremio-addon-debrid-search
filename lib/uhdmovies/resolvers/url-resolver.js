import * as cheerio from 'cheerio';
import { URL } from 'url';
import { makeRequest, axiosInstance } from '../utils/http.js';
import { validateVideoUrl } from '../utils/validation.js';
import { UHDMOVIES_PROXY_URL, USE_HTTPSTREAMS_PROXY } from '../config/proxy.js';
import { resolveSidToDriveleech } from './sid-resolver.js';
import { followRedirectToFilePage, extractFinalDownloadFromFilePage } from '../../util/linkResolver.js';

/**
 * Resolve a UHDMovies SID URL to its final direct download link
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve SID to driveleech URL, 2) Follow redirect to file page, 3) Extract final URL
 * @param {string} sidUrl - The original SID URL that needs resolution
 * @returns {Promise<string|null>} - Final direct streaming URL
 */
export async function resolveUHDMoviesUrl(sidUrl) {
  try {
    console.log('[UHDMOVIES-RESOLVE] Starting resolution for SID URL:', sidUrl.substring(0, 100) + '...');

    // Step 1: Resolve SID to driveleech URL
    let driveleechUrl = null;
    if (sidUrl.includes('tech.unblockedgames.world') || sidUrl.includes('tech.creativeexpressionsblog.com') || sidUrl.includes('tech.examzculture.in')) {
      console.log('[UHDMOVIES-RESOLVE] Resolving SID to driveleech URL...');
      driveleechUrl = await resolveSidToDriveleech(sidUrl);
    } else if (sidUrl.includes('driveseed.org') || sidUrl.includes('driveleech.net')) {
      // If it's already a driveseed/driveleech link, use it
      driveleechUrl = sidUrl;
      console.log('[UHDMOVIES-RESOLVE] URL is already a driveleech URL');
    }

    if (!driveleechUrl) {
      console.log('[UHDMOVIES-RESOLVE] Failed to resolve SID URL');
      return null;
    }

    console.log('[UHDMOVIES-RESOLVE] Resolved SID to driveleech URL:', driveleechUrl.substring(0, 100) + '...');

    // Step 2: Follow redirect to file page
    const { finalUrl: finalFilePageUrl, $: $ } = await followRedirectToFilePage(driveleechUrl, {
      get: (url, opts) => makeRequest(url, opts),
      log: console
    });
    console.log(`[UHDMOVIES-RESOLVE] Resolved redirect to final file page: ${finalFilePageUrl}`);

    // Step 3: Extract final download URL from file page
    const origin = new URL(finalFilePageUrl).origin;
    const finalUrl = await extractFinalDownloadFromFilePage($, {
      origin,
      get: (url, opts) => makeRequest(url, opts),
      post: async (url, data, opts) => {
        if (UHDMOVIES_PROXY_URL) {
          // Legacy proxy - encode URL for proxy
          const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
          console.log(`[UHDMovies] Making legacy proxied POST request to: ${url}`);
          return await axiosInstance.post(proxiedUrl, data, opts);
        } else if (USE_HTTPSTREAMS_PROXY) {
          // Use debrid-proxy system (no need to modify URL - agent handles it)
          console.log(`[UHDMovies] Making proxied POST request via debrid-proxy to: ${url}`);
          return await axiosInstance.post(url, data, opts);
        } else {
          // Direct request
          console.log(`[UHDMovies] Making direct POST request to: ${url}`);
          return await axiosInstance.post(url, data, opts);
        }
      },
      validate: (url) => validateVideoUrl(url),
      log: console
    });

    if (!finalUrl) {
      console.log(`[UHDMOVIES-RESOLVE] Could not extract final video URL`);
      return null;
    }

    // Step 4: Post-process video-leech.pro and cdn.video-leech.pro links to extract Google URLs
    let processedUrl = finalUrl;
    if (finalUrl.includes('video-leech.pro') || finalUrl.includes('cdn.video-leech.pro')) {
      try {
        console.log(`[UHDMOVIES-RESOLVE] Processing video-leech link to extract Google URL: ${finalUrl}`);
        const response = await makeRequest(finalUrl, {
          maxRedirects: 5,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        });

        if (response && response.request && response.request.res && response.request.res.responseUrl) {
          const redirectedUrl = response.request.res.responseUrl;
          if (redirectedUrl.includes('video-seed.pro') && redirectedUrl.includes('?url=')) {
            try {
              const urlObj = new URL(redirectedUrl);
              const urlParam = urlObj.searchParams.get('url');
              if (urlParam && urlParam.includes('googleusercontent.com')) {
                console.log(`[UHDMOVIES-RESOLVE] Extracted Google URL from video-seed.pro redirect: ${urlParam}`);
                processedUrl = urlParam;
              }
            } catch (urlParseError) {
              console.log(`[UHDMOVIES-RESOLVE] URL parsing failed: ${urlParseError.message}`);
            }
          }
        }

        if (response && response.data && processedUrl === finalUrl) {
          const html = response.data;
          const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
          if (googleUrlMatch) {
            console.log(`[UHDMOVIES-RESOLVE] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
            processedUrl = googleUrlMatch[0];
          }
        }
      } catch (videoLeechError) {
        console.log(`[UHDMOVIES-RESOLVE] Video-leech processing failed: ${videoLeechError.message}`);
      }
    }

    // Convert PixelDrain URLs from /u/ID to /api/file/ID?download format
    if (processedUrl && processedUrl.includes('pixeldrain')) {
      const pixelMatch = processedUrl.match(/pixeldrain\.[^/]+\/u\/([a-zA-Z0-9]+)/);
      if (pixelMatch) {
        const fileId = pixelMatch[1];
        processedUrl = `https://pixeldrain.dev/api/file/${fileId}?download`;
        console.log(`[UHDMOVIES-RESOLVE] Converted PixelDrain URL to API format with download parameter`);
      }
    }

    console.log('[UHDMOVIES-RESOLVE] Successfully resolved to:', processedUrl.substring(0, 100) + '...');
    return processedUrl;
  } catch (error) {
    console.error('[UHDMOVIES-RESOLVE] Error resolving UHDMovies stream:', error.message);
    return null;
  }
}
