/**
 * VidSrc Debug Test - Comprehensive diagnostic tool
 *
 * Run with: node test-vidsrc-debug.js
 *
 * This script tests the complete VidSrc flow:
 * 1. Embed page fetching from vidsrc-embed.ru
 * 2. Server extraction from HTML
 * 3. RCP endpoint requests to cloudnestra.com
 * 4. Stream URL extraction
 * 5. m3u8 verification
 */

import { getStreamSrcStreams } from './lib/http-streams/providers/streamsrc/streams.js';
import {
    getStremsrcRandomizedHeaders,
    serversLoad,
    rcpGrabber,
    PRORCPhandler,
    getStreamSrcUrl,
    getStreamSrcBaseDom
} from './lib/http-streams/providers/streamsrc/api.js';
import { makeRequest } from './lib/http-streams/utils/http.js';

// Test configuration
const TEST_MOVIE_TMDB = '278';  // The Shawshank Redemption
const TEST_SERIES_TMDB = '1396:1:1';  // Breaking Bad S01E01

// Color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let color = colors.reset;
    let prefix = '';

    switch(level) {
        case 'success':
            color = colors.green;
            prefix = '✓';
            break;
        case 'error':
            color = colors.red;
            prefix = '✗';
            break;
        case 'warning':
            color = colors.yellow;
            prefix = '⚠';
            break;
        case 'info':
            color = colors.blue;
            prefix = 'ℹ';
            break;
        case 'step':
            color = colors.cyan;
            prefix = '→';
            break;
        default:
            color = colors.gray;
            prefix = ' ';
    }

    console.log(`${color}${prefix} ${message}${colors.reset}`);
    if (data) {
        console.log(`${colors.gray}  ${JSON.stringify(data, null, 2)}${colors.reset}`);
    }
}

function separator() {
    console.log(`${colors.gray}${'─'.repeat(80)}${colors.reset}`);
}

async function testEmbedPage(tmdbId, type) {
    separator();
    log('step', `TEST 1: Fetching embed page for ${type} ${tmdbId}`);

    try {
        const url = getStreamSrcUrl(tmdbId, type);
        log('info', `Generated URL: ${url}`);

        const response = await makeRequest(url, {
            headers: getStremsrcRandomizedHeaders()
        });

        if (response.statusCode === 200) {
            log('success', `Embed page fetched successfully (${response.statusCode})`);

            // Parse servers
            const { servers, title } = serversLoad(response.body);
            log('info', `Title: ${title}`);
            log('info', `Found ${servers.length} server(s)`);

            servers.forEach((server, idx) => {
                console.log(`  ${idx + 1}. ${server.name}`);
                console.log(`     Hash: ${server.dataHash ? server.dataHash.substring(0, 40) + '...' : 'MISSING'}`);
            });

            return { success: true, servers, title, url };
        } else {
            log('error', `Failed to fetch embed page (${response.statusCode})`);
            return { success: false, statusCode: response.statusCode };
        }
    } catch (error) {
        log('error', `Exception during embed page fetch: ${error.message}`);
        console.error(error.stack);
        return { success: false, error: error.message };
    }
}

async function testRCPEndpoint(server, serverName) {
    separator();
    log('step', `TEST 2: Fetching RCP data for server: ${serverName}`);

    try {
        const basedom = getStreamSrcBaseDom();
        const rcpUrl = `${basedom}/rcp/${server.dataHash}`;

        log('info', `RCP URL: ${rcpUrl.substring(0, 80)}...`);
        log('info', `Base domain: ${basedom}`);

        const headers = {
            ...getStremsrcRandomizedHeaders(),
            'Sec-Fetch-Dest': '',
        };

        log('info', 'Request headers:', headers);

        const response = await makeRequest(rcpUrl, { headers });

        log('info', `Response status: ${response.statusCode}`);
        log('info', `Response headers:`, response.headers);

        if (response.statusCode === 200) {
            log('success', 'RCP data fetched successfully');
            log('info', `Response body length: ${response.body.length} bytes`);
            log('info', `Response preview: ${response.body.substring(0, 200)}...`);

            return { success: true, body: response.body };
        } else if (response.statusCode === 404) {
            log('error', '404 Not Found - This indicates anti-scraping protection or invalid hash');
            log('warning', 'Possible causes:');
            console.log('  - Hash is session/time-based and expired');
            console.log('  - Cloudnestra.com blocking requests without proper cookies/session');
            console.log('  - Need to use proxy to bypass geo-blocking');
            log('info', `Response body: ${response.body.substring(0, 500)}`);
            return { success: false, statusCode: 404 };
        } else {
            log('error', `Unexpected status code: ${response.statusCode}`);
            return { success: false, statusCode: response.statusCode };
        }
    } catch (error) {
        log('error', `Exception during RCP fetch: ${error.message}`);
        console.error(error.stack);
        return { success: false, error: error.message };
    }
}

async function testStreamExtraction(rcpBody) {
    separator();
    log('step', 'TEST 3: Extracting stream URL from RCP response');

    try {
        const item = rcpGrabber(rcpBody);

        if (!item) {
            log('error', 'Failed to extract data from RCP response');
            log('info', 'RCP body preview:', rcpBody.substring(0, 500));
            return { success: false };
        }

        log('success', 'Data extracted from RCP response');
        log('info', `Extracted data: ${item.data}`);

        let streamUrl = null;

        if (item.data.substring(0, 8) === "/prorcp/") {
            log('step', 'Processing PRORCP...');
            const prorcpPath = item.data.replace("/prorcp/", "");
            log('info', `PRORCP path: ${prorcpPath.substring(0, 40)}...`);

            streamUrl = await PRORCPhandler(prorcpPath);

            if (streamUrl) {
                log('success', 'PRORCP processed successfully');
            } else {
                log('error', 'PRORCP processing failed');
                return { success: false };
            }
        } else if (item.data.startsWith('http')) {
            log('info', 'Direct URL found (no PRORCP processing needed)');
            streamUrl = item.data;
        } else {
            log('error', `Unexpected data format: ${item.data}`);
            return { success: false };
        }

        if (streamUrl) {
            log('success', 'Stream URL extracted!');
            log('info', `Stream URL: ${streamUrl}`);

            const isM3U8 = streamUrl.includes('.m3u8');
            if (isM3U8) {
                log('success', 'Stream is m3u8 format ✓');
            } else {
                log('warning', 'Stream is NOT m3u8 format');
            }

            return { success: true, streamUrl, isM3U8 };
        } else {
            log('error', 'No stream URL obtained');
            return { success: false };
        }
    } catch (error) {
        log('error', `Exception during stream extraction: ${error.message}`);
        console.error(error.stack);
        return { success: false, error: error.message };
    }
}

async function testFullIntegration(tmdbId, type) {
    separator();
    log('step', `TEST 4: Full integration test using getStreamSrcStreams()`);
    log('info', `TMDB: ${tmdbId}, Type: ${type}`);

    try {
        const startTime = Date.now();
        const streams = await getStreamSrcStreams(tmdbId, type, null, null, {});
        const duration = Date.now() - startTime;

        log('info', `Request completed in ${duration}ms`);
        log('info', `Total streams returned: ${streams.length}`);

        if (streams.length > 0) {
            log('success', 'Integration test PASSED - streams returned');

            console.log('\nStream details:');
            streams.forEach((stream, idx) => {
                console.log(`\n${idx + 1}. ${stream.name}`);
                console.log(`   Title: ${stream.title}`);
                console.log(`   URL: ${stream.url.substring(0, 100)}...`);
                console.log(`   Resolution: ${stream.resolution}`);
                console.log(`   Is m3u8: ${stream.url.includes('.m3u8') ? 'YES ✓' : 'NO'}`);
            });

            return { success: true, streams, duration };
        } else {
            log('warning', 'Integration test returned 0 streams');
            log('info', 'This suggests the RCP endpoints are being blocked');
            return { success: false, streams: [] };
        }
    } catch (error) {
        log('error', `Integration test failed: ${error.message}`);
        console.error(error.stack);
        return { success: false, error: error.message };
    }
}

async function checkEnvironment() {
    separator();
    log('step', 'ENVIRONMENT CHECK');

    // Check proxy configuration
    const proxyConfig = process.env.DEBRID_HTTP_PROXY;
    const proxyServices = process.env.DEBRID_PROXY_SERVICES;
    const perServiceProxies = process.env.DEBRID_PER_SERVICE_PROXIES;

    if (proxyConfig) {
        log('info', `Default proxy configured: ${proxyConfig}`);
    } else {
        log('warning', 'No default proxy configured (DEBRID_HTTP_PROXY not set)');
    }

    if (proxyServices) {
        log('info', `Proxy services: ${proxyServices}`);
    } else {
        log('info', 'DEBRID_PROXY_SERVICES not set');
    }

    if (perServiceProxies) {
        log('info', `Per-service proxies: ${perServiceProxies}`);
    }

    // Check timeout settings
    const timeout = process.env.REQUEST_TIMEOUT || '15000';
    const maxRetries = process.env.REQUEST_MAX_RETRIES || '2';

    log('info', `Request timeout: ${timeout}ms`);
    log('info', `Max retries: ${maxRetries}`);
}

async function runAllTests() {
    console.clear();
    console.log(`${colors.cyan}╔${'═'.repeat(78)}╗${colors.reset}`);
    console.log(`${colors.cyan}║${' '.repeat(25)}VIDSRC DEBUG TEST${' '.repeat(35)}║${colors.reset}`);
    console.log(`${colors.cyan}╚${'═'.repeat(78)}╝${colors.reset}\n`);

    await checkEnvironment();

    // Test 1: Embed page
    const embedResult = await testEmbedPage(TEST_MOVIE_TMDB, 'movie');

    if (!embedResult.success) {
        log('error', 'Cannot proceed - embed page fetch failed');
        process.exit(1);
    }

    // Test 2: RCP endpoint (try first server)
    if (embedResult.servers.length > 0) {
        const firstServer = embedResult.servers[0];
        const rcpResult = await testRCPEndpoint(firstServer, firstServer.name);

        // Test 3: Stream extraction (only if RCP succeeded)
        if (rcpResult.success) {
            await testStreamExtraction(rcpResult.body);
        } else {
            log('warning', 'Skipping stream extraction test - RCP fetch failed');
        }
    } else {
        log('warning', 'No servers found - skipping RCP tests');
    }

    // Test 4: Full integration
    await testFullIntegration(TEST_MOVIE_TMDB, 'movie');

    // Summary
    separator();
    log('step', 'TEST SUMMARY');
    console.log('\nIf you see 404 errors from cloudnestra.com:');
    console.log('1. Configure a proxy in your .env file:');
    console.log('   DEBRID_HTTP_PROXY=socks5h://your-proxy:1080');
    console.log('   DEBRID_PROXY_SERVICES=httpstreams:true');
    console.log('');
    console.log('2. Or use per-service proxy:');
    console.log('   DEBRID_PER_SERVICE_PROXIES=httpstreams:socks5h://proxy:1080');
    console.log('');
    console.log('3. Check if cloudnestra.com is blocking your IP/region');
    console.log('');
    separator();
}

// Run tests
runAllTests().catch(error => {
    log('error', 'Fatal error during tests');
    console.error(error);
    process.exit(1);
});
