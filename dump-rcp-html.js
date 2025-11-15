/**
 * Dump full RCP HTML response to analyze
 */

import { makeRequest } from './lib/http-streams/utils/http.js';
import { getStremsrcRandomizedHeaders, serversLoad, getStreamSrcUrl } from './lib/http-streams/providers/streamsrc/api.js';
import { writeFileSync } from 'fs';

async function dumpRCPHtml() {
    // Get embed page
    const url = getStreamSrcUrl('278', 'movie');
    console.log('Fetching embed page:', url);

    const embedResponse = await makeRequest(url, {
        headers: getStremsrcRandomizedHeaders()
    });

    const { servers } = serversLoad(embedResponse.body);
    console.log(`Found ${servers.length} servers`);

    if (servers.length === 0) {
        console.log('No servers found!');
        return;
    }

    // Try all servers
    for (let i = 0; i < Math.min(3, servers.length); i++) {
        const server = servers[i];
        console.log(`\n=== Server ${i + 1}: ${server.name} ===`);

        const rcpUrl = `https://cloudnestra.com/rcp/${server.dataHash}`;
        console.log(`Fetching: ${rcpUrl.substring(0, 80)}...`);

        const rcpResponse = await makeRequest(rcpUrl, {
            headers: {
                ...getStremsrcRandomizedHeaders(),
                'Sec-Fetch-Dest': '',
            }
        });

        console.log(`Status: ${rcpResponse.statusCode}`);
        console.log(`Length: ${rcpResponse.body.length} bytes`);

        // Save to file
        const filename = `rcp-response-${server.name.replace(/\s+/g, '-')}.html`;
        writeFileSync(filename, rcpResponse.body);
        console.log(`✓ Saved to: ${filename}`);

        // Search for key patterns
        console.log('\n--- Searching for stream URLs ---');

        const searches = [
            { name: 'JavaScript files', pattern: /<script[^>]*src=["']([^"']+\.js[^"']*)["']/gi },
            { name: 'iframe elements', pattern: /<iframe[^>]*>/gi },
            { name: 'video elements', pattern: /<video[^>]*>/gi },
            { name: 'Any .m3u8 URLs', pattern: /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi },
            { name: 'Script tags', pattern: /<script[^>]*>([\s\S]*?)<\/script>/gi },
        ];

        searches.forEach(({ name, pattern }) => {
            const matches = [...rcpResponse.body.matchAll(pattern)];
            if (matches.length > 0) {
                console.log(`\n${name} (${matches.length} found):`);
                matches.slice(0, 5).forEach((match, idx) => {
                    const display = match[0].length > 150 ? match[0].substring(0, 150) + '...' : match[0];
                    console.log(`  ${idx + 1}. ${display}`);
                });
            }
        });

        console.log('\n' + '='.repeat(80));
    }

    console.log('\n✓ Done! Check the HTML files to see the full response.');
}

dumpRCPHtml().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
