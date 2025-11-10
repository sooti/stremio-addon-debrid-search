# Dizipall24 Integration - Summary

## What Was Done

I've successfully traced how dizipall24.com works and created a complete integration for your Stremio addon.

## Files Created

1. **`docs/dizipall24-integration.md`** - Complete technical documentation of the API flow
2. **`lib/dizipall24.js`** - Full implementation module ready to use
3. **`lib/dizipall24.test.js`** - Test file to verify the integration
4. **`docs/dizipall24-usage-example.md`** - Usage examples and integration guide

## How It Works

### The Flow

```
Search Query → Episode Page → Embed URL → Stream URL
     ↓              ↓              ↓            ↓
  POST API     Parse HTML    Fetch Embed   Extract m3u8
```

### Key Findings

1. **Search API**
   - Endpoint: `POST https://dizipall24.com/search`
   - Body: `query=search_term`
   - Returns: JSON or HTML with series results

2. **Episode Pages**
   - URL Format: `https://dizipall24.com/dizi/{series-slug}/sezon-{S}/bolum-{E}`
   - Contains: Multiple embed sources in `data-frame` attributes
   - Example: `data-frame="https://x.ag2m2.cfd/embed-izz3xcmh8zfn.html"`

3. **Embed Pages**
   - Contains PlayerJS configuration
   - Stream URL in `file:` parameter
   - Example: `file:"https://ka5m.uk-traffic-076.com/hls2/01/00027/izz3xcmh8zfn_n/master.m3u8?..."`

4. **Stream URLs**
   - Type: HLS (.m3u8 playlist)
   - **Expire after 12 hours** (parameter `e=43200`)
   - Requires proper headers (User-Agent, Referer)

## Quick Start

### Install Dependencies

The module uses `node-fetch` which should already be in your project.

### Basic Usage

```javascript
import dizipall24 from './lib/dizipall24.js';

// Get stream for a Turkish series
const streamInfo = await dizipall24.searchAndGetStream('gibi', 6, 13);

if (streamInfo) {
    console.log('Stream URL:', streamInfo.url);
    console.log('Expires in:', streamInfo.expiresIn / 60000, 'minutes');

    // Convert to Stremio format
    const stream = dizipall24.toStremioStream(streamInfo);
    // Use stream in your addon
}
```

### Integration with Your Addon

Add to your stream handler:

```javascript
import dizipall24 from './lib/dizipall24.js';

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== 'series') return { streams: [] };

    const [imdbId, season, episode] = id.split(':');

    // Map IMDB to Turkish name (you'll need this logic)
    const turkishName = mapToTurkishName(imdbId);

    if (turkishName) {
        const streamInfo = await dizipall24.searchAndGetStream(
            turkishName,
            parseInt(season),
            parseInt(episode)
        );

        if (streamInfo) {
            return {
                streams: [dizipall24.toStremioStream(streamInfo)]
            };
        }
    }

    return { streams: [] };
});
```

## Example Output

### Stream Info Object
```json
{
  "url": "https://ka5m.uk-traffic-076.com/hls2/01/00027/izz3xcmh8zfn_n/master.m3u8?t=...",
  "title": "Gibi S06E13 1080P EXXEN WEB-DL AAC TURG",
  "poster": "https://img.cdn77s.com/izz3xcmh8zfn.jpg",
  "duration": 3929.51,
  "type": "hls",
  "embedUrl": "https://x.ag2m2.cfd/embed-izz3xcmh8zfn.html",
  "expiresAt": "2025-11-11T08:36:08.000Z",
  "expiresIn": 43200000,
  "provider": "Dizipall24"
}
```

### Stremio Stream Object
```json
{
  "name": "Dizipall24",
  "title": "Gibi S06E13 1080P EXXEN WEB-DL AAC TURG (expires in 720min)",
  "url": "https://ka5m.uk-traffic-076.com/hls2/01/00027/izz3xcmh8zfn_n/master.m3u8?...",
  "behaviorHints": {
    "notWebReady": true,
    "bingeGroup": "dizipall24-izz3xcmh8zfn.html"
  }
}
```

## Testing

Run the test file to verify everything works:

```bash
cd /home/user/sootio-stremio-addon
node lib/dizipall24.test.js
```

Expected output:
```
=== Testing Search ===
Search results: [...]

=== Testing Episode Embeds ===
Episode URL: https://dizipall24.com/dizi/gibi-d24/sezon-6/bolum-13
Embed URLs: [...]

=== Testing Stream Extraction ===
Stream Info: {...}

=== Testing Full Flow ===
✅ Successfully found stream!
Stream URL: https://ka5m.uk...
Title: Gibi S06E13 1080P EXXEN WEB-DL AAC TURG
Expires in: 720 minutes

✅ All tests completed!
```

## Important Notes

### ⚠️ Stream Expiration
- Streams **expire after 12 hours**
- Implement caching with proper TTL
- Re-fetch streams when expired

### 🔒 Headers Required
- User-Agent: Must look like a real browser
- Referer: Should be `https://dizipall24.com/`
- These are already set in the module

### 🌍 Content Type
- Primarily **Turkish TV series**
- Need Turkish series names for search
- Create IMDB → Turkish name mapping

### ⚖️ Legal Considerations
- Verify legal status before production
- This appears to be an unofficial streaming site
- Check terms of service and licensing

## Next Steps

1. **Test the Integration**
   ```bash
   node lib/dizipall24.test.js
   ```

2. **Create IMDB Mapping**
   - Build a database of IMDB IDs → Turkish names
   - Or implement search-based mapping

3. **Add Caching**
   - Cache search results
   - Cache stream URLs (respect expiration)
   - Use Redis or in-memory cache

4. **Integrate into Addon**
   - Add to your stream handler
   - Handle errors gracefully
   - Add logging

5. **Monitor Performance**
   - Track success rate
   - Monitor expiration issues
   - Log failed requests

## API Reference

### Main Functions

```javascript
// Search for series
await dizipall24.searchDizipall(query)

// Build episode URL
dizipall24.buildEpisodeUrl(seriesSlug, season, episode)

// Get embed URLs from episode page
await dizipall24.getEmbedUrls(episodeUrl)

// Extract stream from embed
await dizipall24.getStreamFromEmbed(embedUrl)

// Get stream for episode (combines above steps)
await dizipall24.getStream(seriesSlug, season, episode)

// Search and get stream (easiest)
await dizipall24.searchAndGetStream(query, season, episode)

// Convert to Stremio format
dizipall24.toStremioStream(streamInfo)
```

## Troubleshooting

### No Results
- Check if series name is Turkish
- Try different spelling variations
- Verify site is accessible

### Stream Not Playing
- Check if URL is expired
- Verify headers are correct
- Test URL directly with VLC or ffmpeg

### Rate Limiting
- Add delays between requests
- Implement request queue
- Use caching to reduce requests

## Support

For more details, see:
- **Technical docs**: `docs/dizipall24-integration.md`
- **Usage examples**: `docs/dizipall24-usage-example.md`
- **Implementation**: `lib/dizipall24.js`
- **Tests**: `lib/dizipall24.test.js`

## Example Sites Using Similar Patterns

The same extraction pattern (search → episode page → embed → stream) works for many streaming sites:
- Search API (POST with query)
- Episode pages with data attributes
- Embed pages with PlayerJS or similar players
- HLS streams with expiration tokens

You can adapt this module for similar sites by:
1. Changing the base URL
2. Adjusting the HTML parsing regex
3. Modifying the player config extraction pattern
