import * as cheerio from 'cheerio';
import { URL, URLSearchParams } from 'url';
import FormData from 'form-data';

// Shared helpers for resolving driveseed/driveleech style redirects and extracting final download URLs.
// This util is proxy-agnostic: providers must inject their own network functions and validators.
// All functions accept injected dependencies so proxy, cookies, and caching stay in provider code.

// --- Default extractors (can be used directly or replaced by providers) ---

async function defaultTryInstantDownload($, { post, origin, log = console }) {
  // Look for "Instant Download" text or btn-danger class
  const allInstant = $('a:contains("Instant Download"), a:contains("Instant"), a.btn-danger:contains("Download")');
  log.log(`[LinkResolver] defaultTryInstantDownload: found ${allInstant.length} matching anchor(s).`);
  
  // First check if the page URL has a 'url' parameter which might be the direct download link
  const currentUrl = origin; // origin in this context is likely the current page URL
  try {
    const urlObj = new URL(currentUrl);
    const urlParam = urlObj.searchParams.get('url');
    if (urlParam) {
      // Check if it's a valid direct download link
      if (urlParam.includes('googleusercontent.com') || urlParam.includes('workers.dev') || urlParam.includes('video-leech.pro')) {
        log.log('[LinkResolver] defaultTryInstantDownload: found direct link in URL parameter');
        return urlParam;
      }
    }
  } catch (error) {
    // If URL parsing fails, continue with normal processing
    log.log(`[LinkResolver] defaultTryInstantDownload: URL parsing failed: ${error.message}`);
  }
  
  const instantLink = allInstant.attr('href');
  if (!instantLink) {
    log.log('[LinkResolver] defaultTryInstantDownload: no href on element.');
    return null;
  }

  try {
    const urlObj = new URL(instantLink, origin);
    const keys = new URLSearchParams(urlObj.search).get('url');
    if (keys) {
      // Handle API-based download links
      const apiUrl = `${urlObj.origin}/api`;
      const formData = new FormData();
      formData.append('keys', keys);

      const resp = await post(apiUrl, formData, {
        headers: { ...formData.getHeaders(), 'x-token': urlObj.hostname }
      });

      if (resp && resp.data && resp.data.url) {
        let finalUrl = resp.data.url;
        if (typeof finalUrl === 'string' && finalUrl.includes('workers.dev')) {
          const parts = finalUrl.split('/');
          const fn = parts[parts.length - 1];
          parts[parts.length - 1] = fn.replace(/ /g, '%20');
          finalUrl = parts.join('/');
        }
        log.log('[LinkResolver] defaultTryInstantDownload: extracted API url');
        return finalUrl;
      }
    } else if (instantLink.includes('workers.dev') || instantLink.includes('googleusercontent.com') || instantLink.includes('video-leech.pro') || instantLink.includes('cdn.video-leech.pro')) {
      log.log('[LinkResolver] defaultTryInstantDownload: found direct link');
      return instantLink;
    }
    return null;
  } catch (e) {
    log.log(`[LinkResolver] defaultTryInstantDownload error: ${e.message}`);
    return null;
  }
}

async function defaultTryResumeCloud($, { origin, get, validate, log = console }) {
  // Look for "Resume Cloud" text or btn-warning class (which is what the current DriveSeed uses)
  let resumeAnchor = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download"), a:contains("Resume Worker Bot"), a:contains("Worker"), a.btn-warning:contains("Resume")');
  log.log(`[LinkResolver] defaultTryResumeCloud: found ${resumeAnchor.length} candidate button(s).`);

  if (resumeAnchor.length === 0) {
    // Try direct links on page - add more patterns to catch zfile links AND video-leech links
    const direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"], a[href*="/zfile/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"]').attr('href');
    log.log(`[LinkResolver] defaultTryResumeCloud: checking for direct links, found: ${direct ? direct.substring(0, 100) : 'none'}`);
    if (direct) {
      // Check if it's a video-seed.pro link with a 'url' parameter
      if (direct.includes('video-seed.pro') && direct.includes('?url=')) {
        try {
          const urlObj = new URL(direct);
          const urlParam = urlObj.searchParams.get('url');
          if (urlParam) {
            log.log('[LinkResolver] Extracted direct URL from video-seed.pro parameter');
            return urlParam;
          }
        } catch (e) {
          // If URL parsing fails, proceed with validation of original link
          log.log(`[LinkResolver] URL parsing failed for video-seed.pro: ${e.message}`);
        }
      }
      
      // Handle video-leech.pro links that redirect to video-seed.pro - either extract URL parameter or parse HTML
      if (direct.includes('video-leech.pro') || direct.includes('cdn.video-leech.pro')) {
        try {
          log.log(`[LinkResolver] Processing video-leech link to extract final URL: ${direct}`);
          
          // Make a request to follow redirect and get the final page content
          const response = await get(direct, { 
            maxRedirects: 5,  // Allow redirects to reach the final page
            headers: {
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
          });
          
          // If the final URL contains ?url= parameter, extract it
          if (response && response.request && response.request.res && response.request.res.responseUrl) {
            const finalUrl = response.request.res.responseUrl;
            if (finalUrl.includes('video-seed.pro') && finalUrl.includes('?url=')) {
              try {
                const urlObj = new URL(finalUrl);
                const urlParam = urlObj.searchParams.get('url');
                if (urlParam && urlParam.includes('googleusercontent.com')) {
                  log.log('[LinkResolver] Extracted Google URL from redirected video-seed.pro parameter');
                  return urlParam;
                }
              } catch (urlParseError) {
                log.log(`[LinkResolver] URL parsing failed for redirected video-seed.pro: ${urlParseError.message}`);
              }
            }
          }
          
          // If we got HTML content, try to extract the Google URL from the page
          if (response && response.data) {
            const html = response.data;
            // Look for the download button with Google URL in the HTML
            const downloadButtonMatch = html.match(/id=["']downloadBtn["'][^>]*href=["']([^"']*)["']/i);
            if (downloadButtonMatch && downloadButtonMatch[1]) {
              const extractedUrl = downloadButtonMatch[1];
              if (extractedUrl.includes('googleusercontent.com')) {
                log.log(`[LinkResolver] Extracted Google URL from video-seed page HTML: ${extractedUrl}`);
                return extractedUrl;
              }
            }
            
            // Alternative: Look for any Google URL in the HTML
            const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
            if (googleUrlMatch) {
              log.log(`[LinkResolver] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
              return googleUrlMatch[0];
            }
          }
        } catch (redirectError) {
          log.log(`[LinkResolver] Video-leech redirect processing failed: ${redirectError.message}`);
          // If redirect processing fails, continue with validation of original link
        }
      }
      
      const ok = validate ? await validate(direct) : true;
      if (ok) return direct;
    }
    return null;
  }

  const href = resumeAnchor.attr('href');
  if (!href) return null;

  if (href.startsWith('http') || href.includes('workers.dev') || href.includes('video-leech.pro')) {
    // If it's a video-seed.pro link with a 'url' parameter, extract the actual URL
    if (href.includes('video-seed.pro') && href.includes('?url=')) {
      try {
        const urlObj = new URL(href);
        const urlParam = urlObj.searchParams.get('url');
        if (urlParam) {
          log.log('[LinkResolver] Extracted direct URL from video-seed.pro parameter');
          return urlParam;
        }
      } catch (e) {
        // If URL parsing fails, proceed with the original link
        log.log(`[LinkResolver] URL parsing failed for video-seed.pro: ${e.message}`);
      }
    }
    
    // Handle video-leech.pro links that redirect to video-seed.pro - either extract URL parameter or parse HTML
    if (href.includes('video-leech.pro') || href.includes('cdn.video-leech.pro')) {
      try {
        log.log(`[LinkResolver] Processing video-leech link to extract final URL: ${href}`);
        
        // Make a request to follow redirect and get the final page content
        const response = await get(href, { 
          maxRedirects: 5,  // Allow redirects to reach the final page
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        });
        
        // If the final URL contains ?url= parameter, extract it
        if (response && response.request && response.request.res && response.request.res.responseUrl) {
          const finalUrl = response.request.res.responseUrl;
          if (finalUrl.includes('video-seed.pro') && finalUrl.includes('?url=')) {
            try {
              const urlObj = new URL(finalUrl);
              const urlParam = urlObj.searchParams.get('url');
              if (urlParam && urlParam.includes('googleusercontent.com')) {
                log.log('[LinkResolver] Extracted Google URL from redirected video-seed.pro parameter');
                return urlParam;
              }
            } catch (urlParseError) {
              log.log(`[LinkResolver] URL parsing failed for redirected video-seed.pro: ${urlParseError.message}`);
            }
          }
        }
        
        // If we got HTML content, try to extract the Google URL from the page
        if (response && response.data) {
          const html = response.data;
          // Look for the download button with Google URL in the HTML
          const downloadButtonMatch = html.match(/id=["']downloadBtn["'][^>]*href=["']([^"']*)["']/i);
          if (downloadButtonMatch && downloadButtonMatch[1]) {
            const extractedUrl = downloadButtonMatch[1];
            if (extractedUrl.includes('googleusercontent.com')) {
              log.log(`[LinkResolver] Extracted Google URL from video-seed page HTML: ${extractedUrl}`);
              return extractedUrl;
            }
          }
          
          // Alternative: Look for any Google URL in the HTML
          const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
          if (googleUrlMatch) {
            log.log(`[LinkResolver] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
            return googleUrlMatch[0];
          }
        }
      } catch (redirectError) {
        log.log(`[LinkResolver] Video-leech redirect processing failed: ${redirectError.message}`);
        // If redirect processing fails, continue with validation of original link
      }
    }
    
    const ok = validate ? await validate(href) : true;
    return ok ? href : null;
  }

  try {
    const resumeUrl = new URL(href, origin).href;
    const res = await get(resumeUrl, { maxRedirects: 10 });
    const $ = cheerio.load(res.data);
    
    // Look for various download patterns including zfile and video-leech.pro
    let finalDownloadLink = $('a.btn-success[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (!finalDownloadLink) {
      // Look for zfile and video-leech links which are common on these pages now
      finalDownloadLink = $('a[href*="/zfile/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"]').attr('href');
    }
    if (!finalDownloadLink) {
      finalDownloadLink = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').first().attr('href');
    }
    if (!finalDownloadLink) return null;
    
    // Check if it's a video-seed.pro link with a 'url' parameter
    if (finalDownloadLink.includes('video-seed.pro') && finalDownloadLink.includes('?url=')) {
      try {
        const urlObj = new URL(finalDownloadLink);
        const urlParam = urlObj.searchParams.get('url');
        if (urlParam) {
          log.log('[LinkResolver] Extracted direct URL from video-seed.pro parameter');
          return urlParam;
        }
      } catch (e) {
        // If URL parsing fails, proceed with validation of original link
        log.log(`[LinkResolver] URL parsing failed for video-seed.pro: ${e.message}`);
      }
    }
    
    // Handle video-leech.pro links that redirect to video-seed.pro - either extract URL parameter or parse HTML
    if (finalDownloadLink.includes('video-leech.pro') || finalDownloadLink.includes('cdn.video-leech.pro')) {
      try {
        log.log(`[LinkResolver] Processing video-leech link to extract final URL: ${finalDownloadLink}`);
        
        // Make a request to follow redirect and get the final page content
        const response = await get(finalDownloadLink, { 
          maxRedirects: 5,  // Allow redirects to reach the final page
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        });
        
        // If the final URL contains ?url= parameter, extract it
        if (response && response.request && response.request.res && response.request.res.responseUrl) {
          const finalUrl = response.request.res.responseUrl;
          if (finalUrl.includes('video-seed.pro') && finalUrl.includes('?url=')) {
            try {
              const urlObj = new URL(finalUrl);
              const urlParam = urlObj.searchParams.get('url');
              if (urlParam && urlParam.includes('googleusercontent.com')) {
                log.log('[LinkResolver] Extracted Google URL from redirected video-seed.pro parameter');
                return urlParam;
              }
            } catch (urlParseError) {
              log.log(`[LinkResolver] URL parsing failed for redirected video-seed.pro: ${urlParseError.message}`);
            }
          }
        }
        
        // If we got HTML content, try to extract the Google URL from the page
        if (response && response.data) {
          const html = response.data;
          // Look for the download button with Google URL in the HTML
          const downloadButtonMatch = html.match(/id=["']downloadBtn["'][^>]*href=["']([^"']*)["']/i);
          if (downloadButtonMatch && downloadButtonMatch[1]) {
            const extractedUrl = downloadButtonMatch[1];
            if (extractedUrl.includes('googleusercontent.com')) {
              log.log(`[LinkResolver] Extracted Google URL from video-seed page HTML: ${extractedUrl}`);
              return extractedUrl;
            }
          }
          
          // Alternative: Look for any Google URL in the HTML
          const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
          if (googleUrlMatch) {
            log.log(`[LinkResolver] Found Google URL in video-seed page HTML: ${googleUrlMatch[0]}`);
            return googleUrlMatch[0];
          }
        }
      } catch (redirectError) {
        log.log(`[LinkResolver] Video-leech redirect processing failed: ${redirectError.message}`);
        // If redirect processing fails, continue with validation of original link
      }
    }
    
    const ok = validate ? await validate(finalDownloadLink) : true;
    return ok ? finalDownloadLink : null;
  } catch (e) {
    log.log(`[LinkResolver] defaultTryResumeCloud error: ${e.message}`);
    return null;
  }
}

// --- Core steps ---

async function followRedirectToFilePage({ redirectUrl, get, log = console }) {
  const res = await get(redirectUrl, { maxRedirects: 10 });
  let $ = cheerio.load(res.data);
  const scriptContent = $('script').html() || '';

  // Try multiple JavaScript redirect patterns
  const patterns = [
    /window\.location\.replace\("([^"]+)"\)/,
    /window\.location\.href\s*=\s*"([^"]+)"/,
    /window\.location\s*=\s*"([^"]+)"/,
    /location\.href\s*=\s*"([^"]+)"/
  ];

  let match = null;
  for (const pattern of patterns) {
    match = scriptContent.match(pattern);
    if (match && match[1]) break;
  }

  let finalFilePageUrl = redirectUrl;
  if (match && match[1]) {
    const base = new URL(redirectUrl).origin;
    finalFilePageUrl = new URL(match[1], base).href;
    log.log(`[LinkResolver] Redirect resolved to final file page: ${finalFilePageUrl}`);
    const finalRes = await get(finalFilePageUrl, { maxRedirects: 10 });
    $ = cheerio.load(finalRes.data);
  }
  return { $, finalFilePageUrl };
}

async function extractFinalDownloadFromFilePage($, {
  origin,
  get,
  post,
  validate,
  log = console,
  tryResumeCloud = defaultTryResumeCloud,
  tryInstantDownload = defaultTryInstantDownload
}) {
  // Try known methods
  const methods = [
    async () => await tryResumeCloud($, { origin, get, validate, log }),
    async () => await tryInstantDownload($, { post, origin, log })
  ];

  for (const fn of methods) {
    try {
      const url = await fn();
      if (url) {
        const ok = validate ? await validate(url) : true;
        if (ok) return url;
      }
    } catch (e) {
      log.log(`[LinkResolver] method error: ${e.message}`);
    }
  }

  // Last resort: scan for plausible direct links
  let direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
  if (direct) {
    const ok = validate ? await validate(direct) : true;
    if (ok) return direct;
  }
  return null;
}

// Resolve SID (tech.unblockedgames.world etc.) to intermediate redirect (driveleech/driveseed)
// createSession(jar) must return an axios-like instance with get/post that respects proxy and cookie jar
async function resolveSidToRedirect({ sidUrl, createSession, jar, log = console }) {
  const session = await createSession(jar);
  // Step 0
  const step0 = await session.get(sidUrl);
  let $ = cheerio.load(step0.data);
  const form0 = $('#landing');
  const wp_http = form0.find('input[name="_wp_http"]').val();
  const action0 = form0.attr('action');
  if (!wp_http || !action0) return null;
  // Step 1
  const step1 = await session.post(action0, new URLSearchParams({ '_wp_http': wp_http }), {
    headers: { 'Referer': sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  // Step 2
  $ = cheerio.load(step1.data);
  const form1 = $('#landing');
  const action1 = form1.attr('action');
  const wp_http2 = form1.find('input[name="_wp_http2"]').val();
  const token = form1.find('input[name="token"]').val();
  if (!action1) return null;
  const step2 = await session.post(action1, new URLSearchParams({ '_wp_http2': wp_http2, token }), {
    headers: { 'Referer': step1.request?.res?.responseUrl || sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  // Step 3 - meta refresh
  $ = cheerio.load(step2.data);
  const meta = $('meta[http-equiv="refresh"]').attr('content') || '';
  const m = meta.match(/url=(.*)/i);
  if (!m || !m[1]) return null;
  const origin = new URL(sidUrl).origin;
  const redirectUrl = new URL(m[1].replace(/"/g, '').replace(/'/g, ''), origin).href;
  log.log(`[LinkResolver] SID resolved to redirect: ${redirectUrl}`);
  return redirectUrl;
}

export {
  defaultTryInstantDownload,
  defaultTryResumeCloud,
  followRedirectToFilePage,
  extractFinalDownloadFromFilePage,
  resolveSidToRedirect
};
