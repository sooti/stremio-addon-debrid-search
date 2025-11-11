import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL, URLSearchParams } from 'url';
import { CookieJar } from 'tough-cookie';
import { UHDMOVIES_PROXY_URL, USE_HTTPSTREAMS_PROXY } from '../config/proxy.js';
import debridProxyManager from '../../util/debrid-proxy.js';

// Dynamic import for axios-cookiejar-support
let axiosCookieJarSupport = null;
const getAxiosCookieJarSupport = async () => {
  if (!axiosCookieJarSupport) {
    axiosCookieJarSupport = await import('axios-cookiejar-support');
  }
  return axiosCookieJarSupport;
};

// Helper function to extract cookies from jar for a specific URL
const getCookiesForUrl = async (jar, url) => {
  try {
    const cookies = await jar.getCookies(url);
    if (cookies && cookies.length > 0) {
      return cookies.map(cookie => cookie.toString()).join('; ');
    }
  } catch (error) {
    console.log(`[UHDMovies] Error extracting cookies for ${url}: ${error.message}`);
  }
  return null;
};

// Helper function to create a proxied session for SID resolution
const createProxiedSession = async (jar) => {
  const { wrapper } = await getAxiosCookieJarSupport();

  const sessionConfig = {
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
    }
  };

  // Use debrid-proxy system if httpstreams proxy is enabled, otherwise use legacy proxy
  if (!UHDMOVIES_PROXY_URL && USE_HTTPSTREAMS_PROXY) {
    // Apply debrid-proxy system to the session config
    const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
    if (proxyAgent) {
      sessionConfig.httpAgent = proxyAgent;
      sessionConfig.httpsAgent = proxyAgent;
      sessionConfig.proxy = false; // Disable axios built-in proxy handling
      console.log('[UHDMovies] Creating SID session with debrid-proxy system for httpstreams');

      // Create axios instance with proxy agent but without cookie jar wrapper
      // We'll handle cookies manually in the request functions
      const session = axios.create(sessionConfig);

      // Wrap the session methods to handle cookies manually
      const originalGet = session.get.bind(session);
      const originalPost = session.post.bind(session);

      session.get = async (url, options = {}) => {
        // Extract cookies from jar and add to headers
        const cookieString = await getCookiesForUrl(jar, url);
        if (cookieString) {
          console.log(`[UHDMovies] Adding cookies to request: ${cookieString}`);
          options.headers = {
            ...options.headers,
            'Cookie': cookieString
          };
        }

        const response = await originalGet(url, options);

        // Extract and store cookies from response
        if (response.headers && response.headers['set-cookie']) {
          for (const cookie of response.headers['set-cookie']) {
            try {
              await jar.setCookie(cookie, url);
            } catch (e) {
              console.log(`[UHDMovies] Failed to set cookie: ${e.message}`);
            }
          }
        }

        return response;
      };

      session.post = async (url, data, options = {}) => {
        // Extract cookies from jar and add to headers
        const cookieString = await getCookiesForUrl(jar, url);
        if (cookieString) {
          console.log(`[UHDMovies] Adding cookies to request: ${cookieString}`);
          options.headers = {
            ...options.headers,
            'Cookie': cookieString
          };
        }

        const response = await originalPost(url, data, options);

        // Extract and store cookies from response
        if (response.headers && response.headers['set-cookie']) {
          for (const cookie of response.headers['set-cookie']) {
            try {
              await jar.setCookie(cookie, url);
            } catch (e) {
              console.log(`[UHDMovies] Failed to set cookie: ${e.message}`);
            }
          }
        }

        return response;
      };

      // Also wrap the general request method
      session.request = async (config) => {
        // Extract cookies from jar and add to headers
        if (config.url) {
          const cookieString = await getCookiesForUrl(jar, config.url);
          if (cookieString) {
            console.log(`[UHDMovies] Adding cookies to request: ${cookieString}`);
            config.headers = {
              ...config.headers,
              'Cookie': cookieString
            };
          }
        }

        const response = await session(config);

        // Extract and store cookies from response
        if (response.headers && response.headers['set-cookie']) {
          for (const cookie of response.headers['set-cookie']) {
            try {
              await jar.setCookie(cookie, config.url);
            } catch (e) {
              console.log(`[UHDMovies] Failed to set cookie: ${e.message}`);
            }
          }
        }

        return response;
      };

      return session;
    }
  }

  // If we're not using httpstreams proxy, use cookie jar wrapper
  sessionConfig.jar = jar;
  const session = wrapper(axios.create(sessionConfig));

  // If legacy proxy is enabled, wrap the session methods to use legacy proxy
  if (UHDMOVIES_PROXY_URL) {
    console.log(`[UHDMovies] Creating SID session with legacy proxy: ${UHDMOVIES_PROXY_URL}`);
    const originalGet = session.get.bind(session);
    const originalPost = session.post.bind(session);

    session.get = async (url, options = {}) => {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making legacy proxied SID GET request to: ${url}`);

      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        console.log(`[UHDMovies] Adding cookies to proxied request: ${cookieString}`);
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }

      return originalGet(proxiedUrl, options);
    };

    session.post = async (url, data, options = {}) => {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      console.log(`[UHDMovies] Making legacy proxied SID POST request to: ${url}`);

      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        console.log(`[UHDMovies] Adding cookies to proxied request: ${cookieString}`);
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }

      return originalPost(proxiedUrl, data, options);
    };
  }

  return session;
};

// New function to resolve the tech.unblockedgames.world links
export async function resolveSidToDriveleech(sidUrl) {
  console.log(`[UHDMovies] Resolving SID link: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const jar = new CookieJar();

  // Configure retry parameters
  const MAX_RETRIES = parseInt(process.env.UHDMOVIES_SID_MAX_RETRIES) || 3;
  const RETRY_DELAY = parseInt(process.env.UHDMOVIES_SID_RETRY_DELAY) || 2000; // 2 seconds default
  const REQUEST_TIMEOUT = parseInt(process.env.UHDMOVIES_SID_TIMEOUT) || 30000; // 30 seconds default

  // Create session with proxy support
  const session = await createProxiedSession(jar);

  // Wrapper function to add timeout to requests
  const requestWithTimeout = async (requestFn, timeout = REQUEST_TIMEOUT) => {
    return Promise.race([
      requestFn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), timeout)
      )
    ]);
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`  [SID] Attempt ${attempt + 1}/${MAX_RETRIES + 1}: Starting SID resolution for ${sidUrl}`);

      // Step 0: Get the _wp_http value
      console.log("  [SID] Step 0: Fetching initial page...");
      const responseStep0 = await requestWithTimeout(() => session.get(sidUrl));
      let $ = cheerio.load(responseStep0.data);
      const initialForm = $('#landing');
      const wp_http_step1 = initialForm.find('input[name="_wp_http"]').val();
      const action_url_step1 = initialForm.attr('action');

      if (!wp_http_step1 || !action_url_step1) {
        console.error("  [SID] Error: Could not find _wp_http in initial form.");
        if (attempt < MAX_RETRIES) {
          console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        return null;
      }

      // Step 1: POST to the first form's action URL
      console.log("  [SID] Step 1: Submitting initial form...");
      const step1Data = new URLSearchParams({ '_wp_http': wp_http_step1 });
      const responseStep1 = await requestWithTimeout(() => session.post(action_url_step1, step1Data, {
        headers: {
          'Referer': sidUrl,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }));

      // Step 2: Parse verification page for second form
      console.log("  [SID] Step 2: Parsing verification page...");
      $ = cheerio.load(responseStep1.data);
      const verificationForm = $('#landing');
      const action_url_step2 = verificationForm.attr('action');
      const wp_http2 = verificationForm.find('input[name="_wp_http2"]').val();
      const token = verificationForm.find('input[name="token"]').val();

      if (!action_url_step2) {
        console.error("  [SID] Error: Could not find verification form.");
        if (attempt < MAX_RETRIES) {
          console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        return null;
      }

      // Step 3: POST to the verification URL
      console.log("  [SID] Step 3: Submitting verification...");
      const step2Data = new URLSearchParams({ '_wp_http2': wp_http2, token: token });
      const responseStep2 = await requestWithTimeout(() => session.post(action_url_step2, step2Data, {
        headers: {
          'Referer': responseStep1.request.res.responseUrl,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }));

      // Step 4: Find dynamic cookie and link from JavaScript
      console.log("  [SID] Step 4: Parsing final page for JS data...");
      let finalLinkPath = null;
      let cookieName = null;
      let cookieValue = null;

      const scriptContent = responseStep2.data;
      const cookieMatch = scriptContent.match(/s_343\('([^']+)',\s*'([^']+)'/);
      const linkMatch = scriptContent.match(/c\.setAttribute\(\"href\",\s*\"([^\"]+)\"\)/);

      if (cookieMatch) {
        cookieName = cookieMatch[1].trim();
        cookieValue = cookieMatch[2].trim();
      }
      if (linkMatch) {
        finalLinkPath = linkMatch[1].trim();
      }

      if (!finalLinkPath || !cookieName || !cookieValue) {
        console.error("  [SID] Error: Could not extract dynamic cookie/link from JS.");
        if (attempt < MAX_RETRIES) {
          console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        return null;
      }

      const finalUrl = new URL(finalLinkPath, origin).href;
      console.log(`  [SID] Dynamic link found: ${finalUrl}`);
      console.log(`  [SID] Dynamic cookie found: ${cookieName}`);

      // Step 5: Set cookie and make final request
      console.log("  [SID] Step 5: Setting cookie and making final request...");
      await jar.setCookie(`${cookieName}=${cookieValue}`, origin);

      const finalResponse = await requestWithTimeout(() => session.get(finalUrl, {
        headers: {
          'Referer': responseStep2.request.res.responseUrl,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }));

      // Step 6: Extract driveleech URL from meta refresh tag
      $ = cheerio.load(finalResponse.data);
      const metaRefresh = $('meta[http-equiv="refresh"]');
      if (metaRefresh.length > 0) {
        const content = metaRefresh.attr('content');
        const urlMatch = content.match(/url=(.*)/i);
        if (urlMatch && urlMatch[1]) {
          const driveleechUrl = urlMatch[1].replace(/"/g, "").replace(/'/g, "");
          console.log(`  [SID] SUCCESS! Resolved Driveleech URL: ${driveleechUrl}`);
          return driveleechUrl;
        }
      }

      console.error("  [SID] Error: Could not find meta refresh tag with Driveleech URL.");
      if (attempt < MAX_RETRIES) {
        console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      return null;

    } catch (error) {
      console.error(`  [SID] Error during SID resolution on attempt ${attempt + 1}: ${error.message}`);

      if (error.response) {
        console.error(`  [SID] Status: ${error.response.status}`);
        // Specific handling for 403 Forbidden errors
        if (error.response.status === 403) {
          console.log(`  [SID] 403 Forbidden - possibly blocked by anti-bot measures`);
          if (attempt < MAX_RETRIES) {
            console.log(`  [SID] Waiting longer for anti-bot cooldown... ${RETRY_DELAY * 2}ms`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * 2)); // Longer delay after 403
            continue;
          }
        } else if (error.response.status === 429) {
          console.log(`  [SID] 429 Too Many Requests - rate limited`);
          // Wait longer for rate limiting
          const rateLimitDelay = parseInt(process.env.UHDMOVIES_SID_RATE_LIMIT_DELAY) || 10000; // 10 seconds default
          if (attempt < MAX_RETRIES) {
            console.log(`  [SID] Waiting for rate limit cooldown... ${rateLimitDelay}ms`);
            await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
            continue;
          }
        }
      }

      if (attempt < MAX_RETRIES) {
        console.log(`  [SID] Retrying in ${RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }

      // Log the error but don't completely fail - just return null to signal failure
      console.error(`  [SID] Final failure after ${MAX_RETRIES + 1} attempts`);
      return null;
    }
  }
}
