# Dizipall24.com Integration Guide

## Overview
Dizipall24.com is a Turkish streaming site that provides TV series and movies. This guide documents how to integrate it as a source.

## Stream Source Flow

### 1. Search API
**Endpoint:** `https://dizipall24.com/search`
**Method:** POST
**Content-Type:** `application/x-www-form-urlencoded`

**Request:**
```bash
curl 'https://dizipall24.com/search' \
  -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' \
  --data 'query=gibi'
```

**Response:** JSON array of search results (HTML fragments or JSON objects)

### 2. Episode Page Structure
From the search results, you get episode page URLs like:
`https://dizipall24.com/dizi/gibi-d24/sezon-6/bolum-13`

The episode page contains:
- Video alternatives in `<li>` elements with data attributes
- Each alternative has:
  - `data-frame`: The embed URL
  - `data-hash`: Some encoded data
  - Button with provider name (e.g., "Dizipal")

**HTML Structure:**
```html
<li class="series-alter-active">
  <button class="focus:outline-none flex items-center"
    data-hhs="https://x.ag2m2.cfd/embed-izz3xcmh8zfn.html"
    data-download=""
    data-cover=""
    data-frame="https://x.ag2m2.cfd/embed-izz3xcmh8zfn.html"
    data-hash="pdg7TAAw1e8Y6r3UroYTyevBdwenZY62d/H85rZ0qH+..."
    title="Dizipal">
    Dizipal
  </button>
</li>
```

### 3. Embed Page
**URL Pattern:** `https://x.ag2m2.cfd/embed-{file_id}.html`

The embed page contains a PlayerJS player configuration in a `<script>` tag:

```javascript
var player = new Playerjs({
  id:"playerjs",
  ready:"PlayerReady",
  duration:"3929.51",
  poster:"https://img.cdn77s.com/izz3xcmh8zfn.jpg",
  file:"https://ka5m.uk-traffic-076.com/hls2/01/00027/izz3xcmh8zfn_n/master.m3u8?t=...",
  title:"Gibi S06E13 1080P EXXEN WEB-DL AAC TURG"
});
```

### 4. Stream URL Extraction
The actual stream URL is in the `file` parameter of the PlayerJS configuration.

**Stream Type:** HLS (HTTP Live Streaming) - `.m3u8` playlist
**Example:**
```
https://ka5m.uk-traffic-076.com/hls2/01/00027/izz3xcmh8zfn_n/master.m3u8?t=XY_AzWCU-MgUx5ZOqB546eUUzF3apfABAvqJBL9n33A&s=1762806968&e=43200&f=137840&srv=x2&i=0.0&sp=5000&p1=ka5m&p2=ka5m
```

**URL Parameters:**
- `t`: Token (probably for authentication)
- `s`: Start time (Unix timestamp)
- `e`: Expiration time (seconds from start)
- `f`: File ID
- `srv`: Server identifier
- `i`: Unknown (0.0)
- `sp`: Speed parameter (5000)
- `p1`, `p2`: Provider parameters

## Integration Steps

### Step 1: Search for Content
```javascript
async function searchDizipall(query) {
  const response = await fetch('https://dizipall24.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: `query=${encodeURIComponent(query)}`
  });

  return await response.json(); // or response.text() if HTML
}
```

### Step 2: Parse Episode Page
```javascript
async function getEpisodePage(episodeUrl) {
  const response = await fetch(episodeUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  const html = await response.text();

  // Extract embed URLs from data-frame attributes
  const embedUrlRegex = /data-frame="([^"]+)"/g;
  const embedUrls = [];
  let match;

  while ((match = embedUrlRegex.exec(html)) !== null) {
    embedUrls.push(match[1]);
  }

  return embedUrls;
}
```

### Step 3: Extract Stream URL from Embed
```javascript
async function getStreamUrl(embedUrl) {
  const response = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://dizipall24.com/'
    }
  });

  const html = await response.text();

  // Extract the file URL from PlayerJS config
  const fileMatch = html.match(/file:"([^"]+)"/);
  const titleMatch = html.match(/title:"([^"]+)"/);
  const posterMatch = html.match(/poster:"([^"]+)"/);

  if (fileMatch) {
    return {
      url: fileMatch[1],
      title: titleMatch ? titleMatch[1] : '',
      poster: posterMatch ? posterMatch[1] : '',
      type: 'hls' // .m3u8 stream
    };
  }

  return null;
}
```

### Complete Flow Example
```javascript
async function getDizipallStream(query, season, episode) {
  // 1. Search for the series
  const searchResults = await searchDizipall(query);

  // 2. Find the specific episode page URL
  const episodePageUrl = findEpisodeUrl(searchResults, season, episode);

  // 3. Get embed URLs from episode page
  const embedUrls = await getEpisodePage(episodePageUrl);

  // 4. Get stream URL from first available embed
  for (const embedUrl of embedUrls) {
    const streamInfo = await getStreamUrl(embedUrl);
    if (streamInfo) {
      return streamInfo;
    }
  }

  return null;
}
```

## Important Notes

### URL Expiration
The stream URLs contain expiration parameters:
- `s`: Start timestamp
- `e`: Expiration duration (43200 seconds = 12 hours)

**This means URLs expire after 12 hours and need to be refreshed.**

### Rate Limiting
The site may have rate limiting or require:
- Session cookies
- Proper User-Agent headers
- Referer headers

### Content Availability
- Content is primarily Turkish TV series
- Quality labels indicate source (e.g., "1080P EXXEN WEB-DL")
- Multiple embed providers may be available per episode

### Legal Considerations
- This appears to be an unofficial streaming site
- Verify legal status and terms of service before integration
- Consider geo-restrictions and licensing

## Integration Recommendations

1. **Cache Stream URLs** but respect expiration times
2. **Implement retry logic** for failed embed fetches
3. **Handle multiple embed sources** as fallbacks
4. **Add proper error handling** for:
   - Search failures
   - Missing episodes
   - Expired URLs
   - Blocked embeds
5. **Consider adding a refresh mechanism** for expired streams

## Example Stremio Addon Implementation

```javascript
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'series') return { streams: [] };

  const [imdbId, season, episode] = id.split(':');

  // Map IMDB ID to Turkish series name
  const turkishName = await mapToTurkishName(imdbId);

  if (!turkishName) return { streams: [] };

  const streamInfo = await getDizipallStream(turkishName, season, episode);

  if (!streamInfo) return { streams: [] };

  return {
    streams: [{
      name: 'Dizipall24',
      title: streamInfo.title,
      url: streamInfo.url,
      behaviorHints: {
        notWebReady: true // HLS streams work better in native players
      }
    }]
  };
});
```

## Testing

You can test the stream extraction with:
```bash
# Get embed page
curl -L 'https://x.ag2m2.cfd/embed-izz3xcmh8zfn.html' \
  -H 'User-Agent: Mozilla/5.0' | grep -oP 'file:"([^"]+)"'

# Test stream (replace with actual URL)
ffprobe "https://ka5m.uk-traffic-076.com/hls2/01/00027/izz3xcmh8zfn_n/master.m3u8?..."
```
