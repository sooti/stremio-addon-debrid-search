import axios from 'axios';
import { UHDMOVIES_PROXY_URL, USE_HTTPSTREAMS_PROXY, getProxyAgent } from '../config/proxy.js';

// Configure axios instance with optional proxy support
export const createAxiosInstance = () => {
  // Default timeout configuration
  const DEFAULT_TIMEOUT = parseInt(process.env.UHDMOVIES_REQUEST_TIMEOUT) || 60000; // 60 seconds default

  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0'
    },
    timeout: DEFAULT_TIMEOUT
  };

  // Add proxy configuration if UHDMOVIES_PROXY_URL is set (legacy)
  if (UHDMOVIES_PROXY_URL) {
    console.log(`[UHDMovies] Using legacy proxy: ${UHDMOVIES_PROXY_URL}`);
    // For proxy URLs that expect the destination URL as a parameter
    config.transformRequest = [(data, headers) => {
      return data;
    }];
  } else {
    // Use debrid-proxy system if httpstreams proxy is enabled
    const proxyAgent = getProxyAgent();
    if (proxyAgent) {
      config.httpAgent = proxyAgent;
      config.httpsAgent = proxyAgent;
      config.proxy = false; // Disable axios built-in proxy handling
      console.log('[UHDMovies] Using debrid-proxy system for httpstreams');
    }
  }

  return axios.create(config);
};

export const axiosInstance = createAxiosInstance();

// Proxy wrapper function with retry mechanism
export const makeRequest = async (url, options = {}) => {
  // Default timeout configuration
  const DEFAULT_TIMEOUT = parseInt(process.env.UHDMOVIES_REQUEST_TIMEOUT) || 60000; // 60 seconds default
  const MAX_RETRIES = parseInt(process.env.UHDMOVIES_REQUEST_MAX_RETRIES) || 2; // 2 retries by default
  const RETRY_DELAY = parseInt(process.env.UHDMOVIES_REQUEST_RETRY_DELAY) || 1000; // 1 second delay

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (UHDMOVIES_PROXY_URL) {
        // Route through legacy proxy
        const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
        console.log(`[UHDMovies] Making legacy proxied request to: ${url} (attempt ${attempt + 1})`);
        return await axiosInstance.get(proxiedUrl, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      } else if (USE_HTTPSTREAMS_PROXY) {
        // Using debrid-proxy system, no need to modify URL - agent handles it
        console.log(`[UHDMovies] Making proxied request via debrid-proxy to: ${url} (attempt ${attempt + 1})`);
        return await axiosInstance.get(url, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      } else {
        // Direct request
        console.log(`[UHDMovies] Making direct request to: ${url} (attempt ${attempt + 1})`);
        return await axiosInstance.get(url, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      }
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        console.log(`[UHDMovies] Request attempt ${attempt + 1} failed for ${url}, retrying in ${RETRY_DELAY}ms... Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
    }
  }

  // If we exhausted all retries, throw the last error
  throw lastError;
};
