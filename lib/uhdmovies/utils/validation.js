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

  // REMOVED: "Trusted host skip" was causing streams to fail when seeking!
  // ALL URLs must be validated for 206 range request support, regardless of host
  // Even "trusted" hosts like workers.dev need proper validation to ensure seeking works

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

    // STRICT 206 CHECK: Only accept if server supports range requests
    // We need either:
    // 1. Status 206 (Partial Content) - perfect, confirms range request support
    // 2. Status 200 with Accept-Ranges: bytes header - indicates range support
    const acceptRanges = response.headers && response.headers['accept-ranges'];
    const supportsRanges = response.status === 206 || (response.status === 200 && acceptRanges === 'bytes');

    if (supportsRanges) {
      console.log(`[UHDMovies] ✓ URL validation successful (${response.status}, Accept-Ranges: ${acceptRanges || 'none'})`);
      return true;
    } else {
      console.log(`[UHDMovies] ✗ URL validation failed - no range request support (status: ${response.status}, Accept-Ranges: ${acceptRanges || 'none'})`);
      // Fall through to GET retry
    }
  } catch (error) {
    console.log(`[UHDMovies] ✗ URL validation HEAD failed: ${error.message}`);
  }

  // Fallback 1: Treat some known statuses/domains as acceptable without HEAD support
  let getResponse;
  try {
    const lower = url.toLowerCase();
    if (lower.includes('workers.dev') || lower.includes('driveleech.net/d/')) {
      console.log('[UHDMovies] URL appears to be a direct download on workers.dev or driveleech; attempting GET fallback.');
    }

    // Fallback 2: Try GET with small range
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

    // STRICT 206 CHECK for GET fallback too
    const acceptRangesGet = getResponse.headers && getResponse.headers['accept-ranges'];
    const supportsRangesGet = getResponse.status === 206 || (getResponse.status === 200 && acceptRangesGet === 'bytes');

    // CRITICAL: Destroy the stream to prevent memory leak
    if (getResponse.data && typeof getResponse.data.destroy === 'function') {
      getResponse.data.destroy();
    }

    if (supportsRangesGet) {
      console.log(`[UHDMovies] ✓ GET fallback validation successful (${getResponse.status}, Accept-Ranges: ${acceptRangesGet || 'none'})`);
      return true;
    } else {
      console.log(`[UHDMovies] ✗ GET fallback failed - no range request support (status: ${getResponse.status}, Accept-Ranges: ${acceptRangesGet || 'none'})`);
    }
  } catch (err) {
    // CRITICAL: Destroy the stream on error to prevent memory leak
    if (getResponse?.data && typeof getResponse.data.destroy === 'function') {
      getResponse.data.destroy();
    }
    console.log(`[UHDMovies] ✗ GET fallback validation failed: ${err.message}`);
  }

  return false;
}
