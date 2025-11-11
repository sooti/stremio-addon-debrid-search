# Dizipall24 Integration Usage Example

## Quick Start

### 1. Import the Module

```javascript
import dizipall24 from './lib/dizipall24.js';
```

### 2. Simple Usage - Get Stream for Episode

```javascript
// Get stream for Gibi Season 6 Episode 13
const streamInfo = await dizipall24.searchAndGetStream('gibi', 6, 13);

if (streamInfo) {
    console.log('Stream URL:', streamInfo.url);
    console.log('Expires in:', streamInfo.expiresIn / 1000 / 60, 'minutes');

    // Convert to Stremio stream format
    const stremioStream = dizipall24.toStremioStream(streamInfo);
    console.log('Stremio Stream:', stremioStream);
}
```

### 3. Integration with Stremio Addon

Here's how to integrate Dizipall24 into your Stremio addon's stream handler:

```javascript
import dizipall24 from './lib/dizipall24.js';

// In your stream handler
builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== 'series') {
        return { streams: [] };
    }

    // Parse id - format is usually "imdb_id:season:episode"
    const [imdbId, season, episode] = id.split(':');

    // Map IMDB ID to Turkish series name (you'll need a mapping service)
    const turkishName = await mapImdbToTurkishName(imdbId);

    if (!turkishName) {
        return { streams: [] };
    }

    try {
        // Get stream from Dizipall24
        const streamInfo = await dizipall24.searchAndGetStream(
            turkishName,
            parseInt(season),
            parseInt(episode)
        );

        if (!streamInfo) {
            return { streams: [] };
        }

        // Convert to Stremio format
        const stream = dizipall24.toStremioStream(streamInfo);

        return {
            streams: stream ? [stream] : []
        };
    } catch (error) {
        console.error('[DIZIPALL24] Error getting stream:', error);
        return { streams: [] };
    }
});
```

## Advanced Usage

### Manual Step-by-Step Process

```javascript
// Step 1: Search for series
const searchResults = await dizipall24.searchDizipall('gibi');
console.log('Found series:', searchResults);

// Step 2: Build episode URL
const seriesSlug = searchResults[0].slug; // 'gibi-d24'
const episodeUrl = dizipall24.buildEpisodeUrl(seriesSlug, 6, 13);
console.log('Episode URL:', episodeUrl);

// Step 3: Get embed URLs from episode page
const embedUrls = await dizipall24.getEmbedUrls(episodeUrl);
console.log('Embed URLs:', embedUrls);

// Step 4: Extract stream from embed
const streamInfo = await dizipall24.getStreamFromEmbed(embedUrls[0]);
console.log('Stream Info:', streamInfo);

// Step 5: Convert to Stremio format
const stremioStream = dizipall24.toStremioStream(streamInfo);
console.log('Stremio Stream:', stremioStream);
```

### Direct Series Slug Usage (Faster)

If you already know the series slug:

```javascript
// Direct usage with known slug
const streamInfo = await dizipall24.getStream('gibi-d24', 6, 13);

if (streamInfo) {
    const stream = dizipall24.toStremioStream(streamInfo);
    return { streams: [stream] };
}
```

### Handling Multiple Embed Sources

```javascript
const embedUrls = await dizipall24.getEmbedUrls(episodeUrl);

// Try each embed as fallback
for (const embedUrl of embedUrls) {
    const streamInfo = await dizipall24.getStreamFromEmbed(embedUrl);

    if (streamInfo && !streamInfo.isExpired) {
        console.log('Found working stream!');
        return dizipall24.toStremioStream(streamInfo);
    }
}
```

## Caching Strategy

Since stream URLs expire after 12 hours, implement caching:

```javascript
import NodeCache from 'node-cache';

// Cache for 11 hours (39600 seconds)
const streamCache = new NodeCache({ stdTTL: 39600 });

async function getCachedStream(seriesSlug, season, episode) {
    const cacheKey = `dizipall24:${seriesSlug}:${season}:${episode}`;

    // Check cache
    let streamInfo = streamCache.get(cacheKey);

    if (streamInfo && !streamInfo.isExpired) {
        console.log('[CACHE] Using cached stream');
        return streamInfo;
    }

    // Fetch new stream
    streamInfo = await dizipall24.getStream(seriesSlug, season, episode);

    if (streamInfo) {
        // Cache it
        const ttl = streamInfo.expiresIn
            ? Math.min(streamInfo.expiresIn / 1000, 39600)
            : 39600;

        streamCache.set(cacheKey, streamInfo, ttl);
    }

    return streamInfo;
}
```

## IMDB to Turkish Name Mapping

You'll need to create a mapping service:

```javascript
// Simple mapping table
const IMDB_TO_TURKISH = {
    'tt16383386': 'gibi', // Gibi series
    // Add more mappings
};

async function mapImdbToTurkishName(imdbId) {
    // Check static mapping first
    if (IMDB_TO_TURKISH[imdbId]) {
        return IMDB_TO_TURKISH[imdbId];
    }

    // Fallback: Use Cinemeta to get English title
    // Then search Dizipall24 for Turkish equivalent
    try {
        const metadata = await getCinemetaMetadata(imdbId);
        const englishName = metadata.name;

        // Search Dizipall24 with English name
        const results = await dizipall24.searchDizipall(englishName);

        if (results.length > 0) {
            return results[0].slug;
        }
    } catch (error) {
        console.error('Error mapping IMDB to Turkish:', error);
    }

    return null;
}
```

## Error Handling

```javascript
async function getSafeStream(seriesName, season, episode) {
    try {
        const streamInfo = await dizipall24.searchAndGetStream(
            seriesName,
            season,
            episode
        );

        if (!streamInfo) {
            console.log('[DIZIPALL24] Stream not found');
            return null;
        }

        // Check if stream is about to expire (less than 1 hour)
        if (streamInfo.expiresIn && streamInfo.expiresIn < 3600000) {
            console.warn('[DIZIPALL24] Stream expires soon, consider refreshing');
        }

        return dizipall24.toStremioStream(streamInfo);
    } catch (error) {
        console.error('[DIZIPALL24] Error:', error.message);
        return null;
    }
}
```

## Testing

Run the test file:

```bash
node lib/dizipall24.test.js
```

Or import specific tests:

```javascript
import { runTests } from './lib/dizipall24.test.js';
await runTests();
```

## Configuration

Add to your `.env` file:

```bash
# Dizipall24 Configuration
DIZIPALL24_ENABLED=true
DIZIPALL24_TIMEOUT=10000  # Request timeout in ms
DIZIPALL24_MAX_RETRIES=3  # Max retry attempts
```

## Performance Tips

1. **Use Direct Slugs When Possible**
   - Avoid searching if you know the slug
   - Maintain a slug mapping database

2. **Cache Aggressively**
   - Cache search results
   - Cache embed URLs
   - Cache stream URLs (respect expiration)

3. **Parallel Requests**
   ```javascript
   // Try multiple embeds in parallel
   const streamPromises = embedUrls.map(url =>
       dizipall24.getStreamFromEmbed(url)
   );
   const streams = await Promise.all(streamPromises);
   const validStream = streams.find(s => s && !s.isExpired);
   ```

4. **Request Timeouts**
   ```javascript
   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 10000);

   try {
       const response = await fetch(url, {
           signal: controller.signal
       });
   } finally {
       clearTimeout(timeout);
   }
   ```

## Limitations

1. **Content Language**: Primarily Turkish content
2. **URL Expiration**: Streams expire after 12 hours
3. **Rate Limiting**: Site may implement rate limiting
4. **Availability**: Content availability varies
5. **Legal**: Verify legal status before production use

## Troubleshooting

### No Search Results
- Verify search query is in Turkish
- Try alternative spellings
- Check if site is accessible

### Empty Embed URLs
- Episode may not be available
- Check season/episode numbers
- Verify URL format

### Stream Extraction Fails
- Embed may have changed format
- Check Player.js configuration pattern
- Try different embed sources

### Expired Streams
- Implement refresh mechanism
- Cache with proper TTL
- Re-fetch when needed
