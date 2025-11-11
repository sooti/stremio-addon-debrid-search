import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { getHashFromMagnet, sizeToBytes } from '../../common/torrent-utils.js';
import proxyManager from '../../util/proxy-manager.js';
import * as SqliteCache from '../../util/sqlite-cache.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const execPromise = promisify(exec);

export async function searchBtdig(query, signal, logPrefix, config) {
    const scraperName = 'BTDigg';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, query, config);
    const cachedResult = await SqliteCache.getCachedRecord('scraper', cacheKey);
    const cached = cachedResult?.data || null;

    if (cached && Array.isArray(cached)) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    let cookieFile = null;
    try {
        const limit = config?.BTDIG_LIMIT ?? ENV.BTDIG_LIMIT ?? 50;
        const maxPages = config?.BTDIG_MAX_PAGES ?? ENV.BTDIG_MAX_PAGES ?? 5;
        const base = ((config?.BTDIG_URL || ENV.BTDIG_URL) || 'https://btdig.com').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const useProxies = config?.BTDIG_USE_PROXIES ?? ENV.BTDIG_USE_PROXIES ?? false;

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Log proxy usage
        if (useProxies) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} using rotating proxies`);
            const stats = proxyManager.getStats();
            console.log(`[${logPrefix} SCRAPER] ${scraperName} proxy stats:`, stats);
        }

        // Build URLs for all pages with order=0 parameter (sort by relevance)
        const pageUrls = Array.from({ length: maxPages }, (_, page) =>
            page === 0
                ? `${base}/search?q=${encodeURIComponent(query)}&order=0`
                : `${base}/search?q=${encodeURIComponent(query)}&p=${page}&order=0`
        );

        // Strategy: Fetch in smaller batches to avoid overwhelming the connection
        const batchSize = 2; // Fetch 2 pages at a time to avoid rate limiting
        const batchDelayMs = 1000; // 1 second delay between batches
        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${maxPages} pages in parallel (batches of ${batchSize})...`);

        // Generate random realistic User-Agents (Firefox-based for best BTDigg compatibility)
        function generateRandomUserAgent() {
            const firefoxVersions = ['138.0', '139.0', '140.0', '141.0'];
            const platforms = [
                'Macintosh; Intel Mac OS X 10.15',
                'Macintosh; Intel Mac OS X 14.1',
                'Windows NT 10.0; Win64; x64',
                'X11; Linux x86_64',
                'X11; Ubuntu; Linux x86_64'
            ];

            const version = firefoxVersions[Math.floor(Math.random() * firefoxVersions.length)];
            const platform = platforms[Math.floor(Math.random() * platforms.length)];

            return `Mozilla/5.0 (${platform}; rv:${version}) Gecko/20100101 Firefox/${version}`;
        }

        // Cookie file for persistence across requests
        cookieFile = `/tmp/btdig-cookies-${Date.now()}.txt`;

        // Fetch all pages in parallel using curl with rotating user agents and persistent cookies
        // Increase timeout for parallel requests: base timeout + 2s per page
        const perRequestTimeout = Math.max(timeout || 10000, maxPages * 2000);
        const execOptions = { timeout: perRequestTimeout };
        if (signal && !signal.aborted) {
            execOptions.signal = signal;
        }

        // Fetch pages in batches to avoid overwhelming the server
        const allPageResults = [];
        for (let batchStart = 0; batchStart < pageUrls.length; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, pageUrls.length);
            const batchUrls = pageUrls.slice(batchStart, batchEnd);

            // Add delay between batches (except for first batch)
            if (batchStart > 0) {
                await new Promise(resolve => setTimeout(resolve, batchDelayMs));
            }

            const batchPromises = batchUrls.map(async (url, batchIndex) => {
                const index = batchStart + batchIndex;

                // Add a small staggered delay between requests to avoid rate limiting
                // Each request in batch waits index * 800ms (0ms, 800ms)
                if (batchIndex > 0) {
                    await new Promise(resolve => setTimeout(resolve, batchIndex * 800));
                }

                // Generate random user agent for each page
                const userAgent = generateRandomUserAgent();

                // Get a proxy if enabled
                let proxy = null;
                if (useProxies) {
                    proxy = await proxyManager.getNextProxy();
                }

                // Use persistent cookies: -b to read, -c to write
                // Match Firefox browser headers exactly for best compatibility
                // Build proper referer URL matching the previous page's actual URL format
                const prevPageReferer = index === 1
                    ? `${base}/search?q=${encodeURIComponent(query)}&order=0`  // First page has no p parameter
                    : `${base}/search?q=${encodeURIComponent(query)}&p=${index - 1}&order=0`;

                // Build curl command with properly escaped single quotes
                // Escape single quotes in dynamic values by replacing ' with '\''
                const escapedUrl = url.replace(/'/g, "'\\''");
                const escapedUserAgent = userAgent.replace(/'/g, "'\\''");
                const escapedCookieFile = cookieFile.replace(/'/g, "'\\''");
                const escapedReferer = prevPageReferer.replace(/'/g, "'\\''");

                // Build proxy argument for curl
                let proxyArg = '';
                if (proxy) {
                    const escapedProxy = proxy.replace(/'/g, "'\\''");
                    if (proxy.startsWith('socks')) {
                        proxyArg = `--socks5 '${escapedProxy.replace('socks5://', '')}'`;
                    } else {
                        proxyArg = `-x '${escapedProxy}'`;
                    }
                }

                const curlCmd = index === 0
                    ? `curl -s -L ${proxyArg} -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`
                    : `curl -s -L ${proxyArg} -b '${escapedCookieFile}' -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Referer: ${escapedReferer}' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`;

                // Remove signal from execOptions to avoid interference with child_process
                const curlExecOptions = { timeout: execOptions.timeout };

                return execPromise(curlCmd, curlExecOptions)
                    .then(({ stdout }) => {
                        // Mark proxy as successful if used
                        if (proxy) proxyManager.markSuccess(proxy);
                        return { pageNum: index + 1, html: stdout };
                    })
                    .catch(async (error) => {
                        // Mark proxy as failed if used
                        if (proxy) proxyManager.markFailure(proxy);

                        // Log detailed error information including stderr and exit code
                        const stderr = error.stderr ? String(error.stderr).trim() : '';
                        const stdout = error.stdout ? String(error.stdout).trim() : '';
                        const exitCode = error.code || 'unknown';
                        const errorMsg = stderr || stdout || error.message || 'Unknown error';
                        const proxyInfo = proxy ? ` via proxy ${proxy}` : '';
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} failed${proxyInfo} (exit code: ${exitCode}): ${errorMsg}`);

                        // If proxy failed with connection error, retry without proxy
                        // Exit codes: 5=Couldn't resolve proxy, 7=Failed to connect, 28=Timeout, 35=SSL error, 56=Recv failure
                        if (proxy && (exitCode === 5 || exitCode === 7 || exitCode === 35 || exitCode === 28 || exitCode === 56)) {
                            console.log(`[${logPrefix} SCRAPER] ${scraperName} retrying page ${index + 1} without proxy...`);

                            // Build curl command without proxy
                            const curlCmdNoproxy = index === 0
                                ? `curl -s -L -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`
                                : `curl -s -L -b '${escapedCookieFile}' -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Referer: ${escapedReferer}' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`;

                            try {
                                const { stdout: retryStdout } = await execPromise(curlCmdNoproxy, curlExecOptions);
                                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} succeeded without proxy`);
                                return { pageNum: index + 1, html: retryStdout };
                            } catch (retryError) {
                                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} also failed without proxy`);
                                return { pageNum: index + 1, html: null };
                            }
                        }

                        return { pageNum: index + 1, html: null };
                    });
            });

            const batchResults = await Promise.all(batchPromises);
            allPageResults.push(...batchResults);
        }

        const pageResults = allPageResults;

        // Process all page results
        const results = [];
        const seen = new Set();
        let captchaDetected = false;

        for (const { pageNum, html } of pageResults) {
            if (!html || results.length >= limit) continue;

            const $ = cheerio.load(html);

            // Detect CAPTCHA page
            if (html.includes('security check') || html.includes('g-recaptcha') || html.includes('One more step')) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} CAPTCHA detected on page ${pageNum}. BTDigg has anti-bot protection enabled.`);
                captchaDetected = true;
                continue;
            }

            const resultDivs = $('.one_result');

            if (resultDivs.length === 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} no results found on page ${pageNum}.`);
                continue;
            }

            resultDivs.each((i, el) => {
                if (results.length >= limit) return false;

                try {
                    // Extract title
                    const titleLink = $(el).find('.torrent_name a');
                    const title = titleLink.text().trim();

                    // Extract magnet link
                    const magnetLink = $(el).find('.torrent_magnet a[href^="magnet:"]').attr('href');
                    if (!magnetLink) return;

                    // Decode HTML entities in magnet link
                    const decodedMagnet = magnetLink
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"');

                    const infoHash = getHashFromMagnet(decodedMagnet);
                    if (!infoHash) return;

                    // Skip if already seen
                    if (seen.has(infoHash)) return;
                    seen.add(infoHash);

                    // Extract size
                    const sizeText = $(el).find('.torrent_size').text().trim();
                    const size = sizeToBytes(sizeText);

                    // Extract seeders (not available on BTDigg)
                    const seeders = 0;

                    // Extract number of files
                    const filesText = $(el).find('.torrent_files').text().trim();
                    const fileCount = parseInt(filesText) || 0;

                    results.push({
                        Title: title,
                        InfoHash: infoHash,
                        Size: size,
                        Seeders: seeders,
                        Tracker: scraperName,
                        Langs: detectSimpleLangs(title),
                        Magnet: decodedMagnet,
                        FileCount: fileCount
                    });
                } catch (e) {
                    // Ignore individual parsing errors
                }
            });
        }

        if (captchaDetected && results.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} WARNING: BTDigg has enabled CAPTCHA/anti-bot protection. The scraper cannot bypass this automatically.`);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Consider: 1) Disabling BTDigg scraper 2) Using alternative scrapers 3) Waiting and trying again later`);
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Files: ${r.FileCount}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        // Clean up cookie file
        if (cookieFile) {
            try {
                await execPromise(`rm -f "${cookieFile}"`);
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        console.timeEnd(timerLabel);
    }
}
