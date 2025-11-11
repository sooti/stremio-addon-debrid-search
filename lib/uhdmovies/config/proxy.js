import debridProxyManager from '../../util/debrid-proxy.js';

// --- Proxy Configuration ---
export const UHDMOVIES_PROXY_URL = process.env.UHDMOVIES_PROXY_URL;

if (UHDMOVIES_PROXY_URL) {
  console.log(`[UHDMovies] Legacy proxy support enabled: ${UHDMOVIES_PROXY_URL}`);
} else {
  console.log('[UHDMovies] No legacy proxy configured, checking debrid-proxy system');
}

// Check if httpstreams should use proxy via debrid-proxy system
export const USE_HTTPSTREAMS_PROXY = debridProxyManager.shouldUseProxy('httpstreams');

if (USE_HTTPSTREAMS_PROXY) {
  console.log('[UHDMovies] httpstreams proxy enabled via debrid-proxy system');
}

export function getProxyAgent() {
  return debridProxyManager.getProxyAgent('httpstreams');
}
