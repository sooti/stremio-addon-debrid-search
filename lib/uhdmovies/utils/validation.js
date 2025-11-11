import { URL } from 'url';
import { UHDMOVIES_PROXY_URL, USE_HTTPSTREAMS_PROXY } from '../config/proxy.js';
import { axiosInstance } from './http.js';

// Environment variable to control URL validation
const URL_VALIDATION_ENABLED = process.env.DISABLE_URL_VALIDATION !== 'true';
const VALIDATION_TIMEOUT = parseInt(process.env.UHDMOVIES_VALIDATION_TIMEOUT) || 8000; // Configurable timeout, default 8 seconds

console.log(`[UHDMovies] URL validation is ${URL_VALIDATION_ENABLED ? 'enabled' : 'disabled'}.`);
console.log(`[UHDMovies] URL validation timeout is set to ${VALIDATION_TIMEOUT}ms.`);

// Validate if a video URL is working (not 404 or broken)
export async function validateVideoUrl(url, timeout = VALIDATION_TIMEOUT) {
  // Skip validation if disabled via environment variable
  if (!URL_VALIDATION_ENABLED) {
    console.log(`[UHDMovies] URL validation disabled, skipping validation for: ${url.substring(0, 100)}...`);
    return true;
  }

  // Skip validation for video-leech.pro links as they need post-processing first
  if (url.includes('video-leech.pro') || url.includes('cdn.video-leech.pro')) {
    console.log(`[UHDMovies] Skipping validation for video-leech link (requires post-processing): ${url.substring(0, 100)}...`);
    return true;
  }

  // Skip validation for known reliable hosting services
  const trustedHosts = [
    'video-downloads.googleusercontent.com',
    'pixeldrain.dev',
    'pixeldrain.com',
    'r2.dev',
    'workers.dev',
    'hubcdn.fans',
    'driveleech.net',
    'driveseed.org'
  ];

  const urlObj = new URL(url);
  const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));
  if (isTrustedHost) {
    console.log(`[UHDMovies] Skipping validation for trusted host: ${urlObj.hostname}`);
    return true;
  }

  try {
    console.log(`[UHDMovies] Validating URL: ${url.substring(0, 100)}...`);

    // Use proxy for URL validation if enabled
    let response;
    if (UHDMOVIES_PROXY_URL) {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making legacy proxied HEAD request for validation to: ${url}`);
      response = await axiosInstance.head(proxiedUrl, {
        timeout,
        headers: {
          'Range': 'bytes=0-1' // Just request first byte to test
        }
      });
    } else if (USE_HTTPSTREAMS_PROXY) {
      console.log(`[UHDMovies] Making proxied HEAD request via debrid-proxy for validation to: ${url}`);
      response = await axiosInstance.head(url, {
        timeout,
        headers: {
          'Range': 'bytes=0-1' // Just request first byte to test
        }
      });
    } else {
      response = await axiosInstance.head(url, {
        timeout,
        headers: {
          'Range': 'bytes=0-1' // Just request first byte to test
        }
      });
    }

    // Check if status is OK (200-299), partial content (206), or redirects (300-399)
    // 206 Partial Content is valid for video streaming with range requests
    // 3xx redirects are also acceptable as they indicate the resource exists and redirects to it
    if (response.status >= 200 && response.status < 400) {
      console.log(`[UHDMovies] ✓ URL validation successful (${response.status})`);
      return true;
    } else {
      console.log(`[UHDMovies] ✗ URL validation failed with status: ${response.status}`);
      // Fall through to GET retry
    }
  } catch (error) {
    console.log(`[UHDMovies] ✗ URL validation HEAD failed: ${error.message}`);
  }

  // Fallback 1: Treat some known statuses/domains as acceptable without HEAD support
  try {
    const lower = url.toLowerCase();
    if (lower.includes('workers.dev') || lower.includes('driveleech.net/d/')) {
      console.log('[UHDMovies] URL appears to be a direct download on workers.dev or driveleech; attempting GET fallback.');
    }

    // Fallback 2: Try GET with small range
    let getResponse;
    if (UHDMOVIES_PROXY_URL) {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making legacy proxied GET fallback request for validation to: ${url}`);
      getResponse = await axiosInstance.get(proxiedUrl, {
        timeout,
        responseType: 'stream',
        headers: { 'Range': 'bytes=0-1' }
      });
    } else if (USE_HTTPSTREAMS_PROXY) {
      console.log(`[UHDMovies] Making proxied GET fallback request via debrid-proxy for validation to: ${url}`);
      getResponse = await axiosInstance.get(url, {
        timeout,
        responseType: 'stream',
        headers: { 'Range': 'bytes=0-1' }
      });
    } else {
      getResponse = await axiosInstance.get(url, {
        timeout,
        responseType: 'stream',
        headers: { 'Range': 'bytes=0-1' }
      });
    }

    if ((getResponse.status >= 200 && getResponse.status < 500) || getResponse.status === 206) {
      console.log(`[UHDMovies] ✓ GET fallback validation accepted (${getResponse.status}).`);
      return true;
    }
  } catch (err) {
    console.log(`[UHDMovies] ✗ GET fallback validation failed: ${err.message}`);
  }

  return false;
}
