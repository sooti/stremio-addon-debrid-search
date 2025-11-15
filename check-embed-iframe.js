/**
 * Check if the embed page has a direct iframe we can use
 */

import { makeRequest } from './lib/http-streams/utils/http.js';
import { getStremsrcRandomizedHeaders, getStreamSrcUrl } from './lib/http-streams/providers/streamsrc/api.js';
import { writeFileSync } from 'fs';

async function checkEmbedIframe() {
    const url = getStreamSrcUrl('278', 'movie');
    console.log('Fetching embed page:', url);

    const response = await makeRequest(url, {
        headers: getStremsrcRandomizedHeaders()
    });

    console.log(`Status: ${response.statusCode}`);
    console.log(`Length: ${response.body.length} bytes\n`);

    // Save full HTML
    writeFileSync('embed-page.html', response.body);
    console.log('✓ Saved to: embed-page.html\n');

    // Look for iframes
    console.log('=== Searching for iframes ===');
    const iframeRegex = /<iframe[^>]*>/gi;
    const iframes = [...response.body.matchAll(iframeRegex)];

    if (iframes.length > 0) {
        console.log(`Found ${iframes.length} iframe(s):\n`);
        iframes.forEach((match, idx) => {
            console.log(`${idx + 1}. ${match[0]}\n`);

            // Extract src
            const srcMatch = match[0].match(/src=["']([^"']+)["']/);
            if (srcMatch) {
                console.log(`   Full src: ${srcMatch[1]}\n`);
            }
        });
    } else {
        console.log('No iframes found in embed page.');
    }

    // Check for any direct stream URLs or player configs
    console.log('\n=== Checking for player configs ===');
    const patterns = [
        { name: 'Player iframe src', regex: /player_iframe[^>]*src=["']([^"']+)["']/i },
        { name: 'Direct m3u8', regex: /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/g },
        { name: 'Data attributes', regex: /data-[a-z]+\s*=\s*["']([^"']{30,})["']/gi },
    ];

    patterns.forEach(({ name, regex }) => {
        const matches = [...response.body.matchAll(regex)];
        if (matches.length > 0) {
            console.log(`\n${name} (${matches.length} found):`);
            matches.slice(0, 3).forEach((match, idx) => {
                console.log(`  ${idx + 1}. ${match[1]}`);
            });
        }
    });
}

checkEmbedIframe().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
