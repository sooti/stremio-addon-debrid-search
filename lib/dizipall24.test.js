/**
 * Test file for Dizipall24 integration
 *
 * Run with: node lib/dizipall24.test.js
 */

import dizipall24 from './dizipall24.js';

async function testSearch() {
    console.log('\n=== Testing Search ===');
    const results = await dizipall24.searchDizipall('gibi');
    console.log('Search results:', JSON.stringify(results, null, 2));
    return results;
}

async function testEpisodeEmbeds() {
    console.log('\n=== Testing Episode Embeds ===');
    const episodeUrl = dizipall24.buildEpisodeUrl('gibi-d24', 6, 13);
    console.log('Episode URL:', episodeUrl);

    const embedUrls = await dizipall24.getEmbedUrls(episodeUrl);
    console.log('Embed URLs:', embedUrls);
    return embedUrls;
}

async function testStreamExtraction() {
    console.log('\n=== Testing Stream Extraction ===');
    const embedUrls = await testEpisodeEmbeds();

    if (embedUrls.length > 0) {
        const streamInfo = await dizipall24.getStreamFromEmbed(embedUrls[0]);
        console.log('Stream Info:', JSON.stringify(streamInfo, null, 2));

        if (streamInfo) {
            const stremioStream = dizipall24.toStremioStream(streamInfo);
            console.log('Stremio Stream:', JSON.stringify(stremioStream, null, 2));
        }
    }
}

async function testFullFlow() {
    console.log('\n=== Testing Full Flow ===');
    const streamInfo = await dizipall24.searchAndGetStream('gibi', 6, 13);

    if (streamInfo) {
        console.log('✅ Successfully found stream!');
        console.log('Stream URL:', streamInfo.url);
        console.log('Title:', streamInfo.title);
        console.log('Expires in:', Math.round(streamInfo.expiresIn / 1000 / 60), 'minutes');

        const stremioStream = dizipall24.toStremioStream(streamInfo);
        console.log('\nStremio Stream Object:', JSON.stringify(stremioStream, null, 2));
    } else {
        console.log('❌ No stream found');
    }
}

async function runTests() {
    console.log('Starting Dizipall24 Tests...\n');

    try {
        // Run each test
        await testSearch();
        await testEpisodeEmbeds();
        await testStreamExtraction();
        await testFullFlow();

        console.log('\n✅ All tests completed!');
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        console.error(error.stack);
    }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runTests();
}

export { runTests };
