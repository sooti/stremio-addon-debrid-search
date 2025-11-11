# HTTP-Streams Refactoring Status

## Overview
Refactoring of `lib/http-streams.js` (3,261 lines) into a modular structure.

## Completed Work

### 1. Directory Structure Created
```
lib/http-streams/
├── utils/
│   ├── encoding.js ✅
│   ├── validation.js ✅
│   ├── http.js ✅
│   └── parsing.js ✅
├── providers/
│   ├── 4khdhub/
│   │   ├── extraction.js ✅
│   │   ├── search.js ⏳
│   │   └── streams.js ⏳
│   ├── streamsrc/
│   │   ├── api.js ⏳
│   │   ├── hls.js ⏳
│   │   └── streams.js ⏳
│   └── hdhub4u/
│       └── extraction.js ⏳
└── resolvers/
    ├── http-resolver.js ⏳
    └── link-processor.js ⏳
```

### 2. Files Created (1,628 lines extracted)

#### ✅ lib/http-streams/utils/encoding.js (94 lines)
**Functions:**
- `base64Decode(str)` - Decodes base64 strings
- `base64Encode(str)` - Encodes to base64
- `rot13(str)` - ROT13 cipher
- `tryDecodeBase64(str)` - Attempts base64 decoding
- `encodeUrlForStreaming(url)` - URL encoding for streaming

#### ✅ lib/http-streams/utils/validation.js (311 lines)
**Functions:**
- `extractFilenameFromHeader(contentDisposition)` - Extracts filenames from headers
- `validateUrl(url)` - Validates URL accessibility
- `validateSeekableUrl(url)` - Validates seekability (range requests)

**Dependencies:**
- Uses debridProxyManager for proxy support
- Checks trusted hosts (pixeldrain, workers.dev, etc.)

#### ✅ lib/http-streams/utils/http.js (172 lines)
**Functions:**
- `makeRequest(url, options)` - HTTP/HTTPS requests with retry logic
- `getDomains()` - Fetches and caches domain configuration

**Features:**
- Retry logic (configurable via env vars)
- Automatic redirect following
- Cheerio HTML parsing support
- Proxy agent support

#### ✅ lib/http-streams/utils/parsing.js (299 lines)
**Functions:**
- `getResolutionFromName(name)` - Extracts resolution from strings
- `formatSize(size)` - Formats bytes to human-readable
- `getIndexQuality(str)` - Extracts quality numbers
- `getBaseUrl(url)` - Extracts base URL
- `cleanTitle(title)` - Cleans titles extracting quality info
- `normalizeTitle(title)` - Normalizes for matching
- `calculateSimilarity(str1, str2)` - Levenshtein distance
- `containsWords(title, query)` - Word containment check
- `removeYear(title)` - Removes year from title
- `generateAlternativeQueries(title, originalTitle)` - Query variations
- `findBestMatch(results, query)` - Finds best match
- `getSortedMatches(results, query)` - Sorts by similarity score

#### ✅ lib/http-streams/providers/4khdhub/extraction.js (752 lines)
**Functions:**
- `extractHubCloudLinks(url, referer)` - Extracts HubCloud download links
- `extractHubDriveLinks(url)` - Extracts HubDrive links
- `processHubDriveLink(href)` - Processes HubDrive links
- `getRedirectLinks(url)` - Processes redirect URLs with complex decoding
- `extractStreamingLinks(downloadLinks)` - Extracts streaming links from downloads
- `processExtractorLinkWithAwait(link, linkNumber)` - Async link processor
- `processExtractorLink(link, resolve, linkNumber)` - Promise-based link processor

**Features:**
- Handles multiple CDN providers (PixelDrain, Workers.dev, HubCDN, etc.)
- Complex redirect chain following
- Parallel processing for performance
- Special handling for different server types

### 3. Backup Created
✅ `lib/http-streams.js.backup` - Original file preserved

## Remaining Work (1,633 lines to extract)

### ⏳ lib/http-streams/providers/4khdhub/search.js
**Functions to extract:**
- `scrape4KHDHubSearch(searchQuery)` - Main search function
- `parseMovieCards($, baseUrl)` - Parse search results
- `loadContent(url)` - Load content details (large ~180 lines)
- `normalizeImageUrl(url)` - Normalize image URLs
- `generateIdFromUrl(url)` - Generate IDs from URLs
- `determineContentType(formats)` - Determine movie vs series
- `validateMovieYear(content, expectedYear)` - Year validation

**Estimated size:** ~350 lines

### ⏳ lib/http-streams/providers/4khdhub/streams.js
**Functions to extract:**
- `get4KHDHubStreams(tmdbId, type, season, episode, config)` - Main entry point (large ~470 lines)

**Features:**
- TMDB integration via Cinemeta
- Parallel search strategies
- URL validation with seeking checks
- Language detection and filtering
- Resolution-based sorting

**Estimated size:** ~500 lines

### ⏳ lib/http-streams/providers/streamsrc/api.js
**Functions to extract:**
- `PRORCPhandler(prorcp)` - RCP handler
- `rcpGrabber(html)` - RCP grabber
- `getStremsrcSecChUa(userAgent)` - User agent header generation
- `getStremsrcSecChUaPlatform(userAgent)` - Platform header
- `getRandomStremsrcUserAgent()` - Random UA selection
- `getStremsrcRandomizedHeaders()` - Randomized headers
- `serversLoad(html)` - Server loader
- `getStreamSrcUrl(id, type)` - Build StreamSrc URLs
- `getObject(id)` - Get object by ID

**Estimated size:** ~200 lines

### ⏳ lib/http-streams/providers/stremsrc/hls.js
**Functions to extract:**
- `parseHLSMaster(masterPlaylistContent, baseUrl)` - Parse HLS master playlist
- `parseHLSAttributes(attributesLine)` - Parse HLS attributes
- `fetchAndParseHLS(url)` - Fetch and parse HLS

**Estimated size:** ~150 lines

### ⏳ lib/http-streams/providers/streamsrc/streams.js
**Functions to extract:**
- `getStreamSrcStreams(tmdbId, type, season, episode, config)` - Main entry point

**Estimated size:** ~300 lines

### ⏳ lib/http-streams/providers/hdhub4u/extraction.js
**Functions to extract:**
- `hdhub4uGetStream(link)` - Extract streams from HDHub4u
- `getRedirectLinksForStream(link)` - Get redirect links

**Estimated size:** ~200 lines

### ⏳ lib/http-streams/resolvers/http-resolver.js
**Functions to extract:**
- `resolveHttpStreamUrl(redirectUrl)` - Main HTTP stream resolver

**Estimated size:** ~100 lines

### ⏳ lib/http-streams/resolvers/link-processor.js
**Functions to extract:**
- `decodeString(encryptedString)` - Decode encrypted strings

**Estimated size:** ~80 lines

### ⏳ lib/http-streams/index.js
**Purpose:** Central export point
- Export all utility functions
- Export all provider functions
- Export all resolver functions

**Estimated size:** ~50 lines

### ⏳ lib/http-streams.js (new)
**Purpose:** Compatibility layer
- Re-export everything from index.js
- Maintains backward compatibility
- No breaking changes to existing imports

**Estimated size:** ~10 lines

## Line Count Comparison

### Current Status
- **Original file:** 3,261 lines (monolithic)
- **Extracted so far:** 1,628 lines across 5 files
- **Remaining to extract:** ~1,633 lines across 10 files
- **Progress:** 50% complete

### Projected Final Structure
```
Original:  lib/http-streams.js (3,261 lines)

New Structure (~3,300 lines total across 16 files):
├── utils/ (876 lines across 4 files)
│   ├── encoding.js (94 lines) ✅
│   ├── validation.js (311 lines) ✅
│   ├── http.js (172 lines) ✅
│   └── parsing.js (299 lines) ✅
├── providers/ (~1,952 lines across 9 files)
│   ├── 4khdhub/ (1,602 lines across 3 files)
│   │   ├── extraction.js (752 lines) ✅
│   │   ├── search.js (~350 lines) ⏳
│   │   └── streams.js (~500 lines) ⏳
│   ├── streamsrc/ (650 lines across 3 files)
│   │   ├── api.js (~200 lines) ⏳
│   │   ├── hls.js (~150 lines) ⏳
│   │   └── streams.js (~300 lines) ⏳
│   └── hdhub4u/ (200 lines across 1 file)
│       └── extraction.js (~200 lines) ⏳
├── resolvers/ (180 lines across 2 files)
│   ├── http-resolver.js (~100 lines) ⏳
│   └── link-processor.js (~80 lines) ⏳
├── index.js (~50 lines) ⏳
└── ../http-streams.js (~10 lines, compatibility) ⏳
```

## Benefits of This Structure

### 1. **Modularity**
- Each provider is self-contained
- Utilities are reusable across providers
- Easy to add new providers

### 2. **Maintainability**
- Smaller files are easier to understand
- Clear separation of concerns
- Related functions grouped together

### 3. **Testability**
- Each module can be tested independently
- Mock dependencies easily
- Clear function boundaries

### 4. **Performance**
- Tree-shaking friendly
- Import only what you need
- Smaller bundle sizes possible

### 5. **Developer Experience**
- Easy to locate functionality
- Clear file structure
- Better IDE navigation

## Next Steps

To complete the refactoring:

1. **Extract search module** (`4khdhub/search.js`)
   - Read lines 1290-1302, 1315-1320, 1563-1913, 2576-2600
   - Extract helper functions and main search logic

2. **Extract streams module** (`4khdhub/streams.js`)
   - Read lines 2103-2574
   - Extract main get4KHDHubStreams function

3. **Extract StreamSrc modules** (3 files)
   - Read lines 1322-1532 for API and HLS functions
   - Read lines 2605-2885 for main streams function

4. **Extract HDHub4u module**
   - Read lines 2886-3137
   - Extract hdhub4uGetStream and helper functions

5. **Extract resolvers**
   - Read lines 3138-3257
   - Extract decodeString and resolveHttpStreamUrl

6. **Create index files**
   - Create central export point
   - Create compatibility layer

## Functions Successfully Extracted

### Encoding (5 functions)
✅ base64Decode, base64Encode, rot13, tryDecodeBase64, encodeUrlForStreaming

### Validation (3 functions)
✅ extractFilenameFromHeader, validateUrl, validateSeekableUrl

### HTTP (2 functions)
✅ makeRequest, getDomains

### Parsing (11 functions)
✅ getResolutionFromName, formatSize, getIndexQuality, getBaseUrl, cleanTitle, 
normalizeTitle, calculateSimilarity, containsWords, removeYear, 
generateAlternativeQueries, findBestMatch, getSortedMatches

### 4KHDHub Extraction (7 functions)
✅ extractHubCloudLinks, extractHubDriveLinks, processHubDriveLink, 
getRedirectLinks, extractStreamingLinks, processExtractorLinkWithAwait, 
processExtractorLink

**Total extracted: 28 functions across 1,628 lines**

## Functions Remaining to Extract

### 4KHDHub Search (7 functions)
⏳ scrape4KHDHubSearch, parseMovieCards, loadContent, normalizeImageUrl, 
generateIdFromUrl, determineContentType, validateMovieYear

### 4KHDHub Streams (1 function)
⏳ get4KHDHubStreams

### StreamSrc (10 functions)
⏳ PRORCPhandler, rcpGrabber, getStremsrcSecChUa, getStremsrcSecChUaPlatform, 
getRandomStremsrcUserAgent, getStremsrcRandomizedHeaders, serversLoad, 
getStreamSrcUrl, getObject, getStreamSrcStreams

### HDHub4u (2 functions)
⏳ hdhub4uGetStream, getRedirectLinksForStream

### Resolvers (2 functions)
⏳ resolveHttpStreamUrl, decodeString

**Total remaining: 22 functions across ~1,633 lines**

## Known Dependencies

### External Dependencies
- `./util/cinemeta.js` - TMDB metadata
- `./util/language-mapping.js` - Language detection and flags
- `./util/debrid-proxy.js` - Proxy management
- `cheerio` - HTML parsing
- `https`, `http` - Node.js HTTP modules

### Internal Dependencies (created)
- `utils/encoding.js` - Used by extraction and search modules
- `utils/validation.js` - Used by streams module
- `utils/http.js` - Used by all provider modules
- `utils/parsing.js` - Used by search and streams modules

### Circular Dependency Note
- `4khdhub/extraction.js` dynamically imports `hdhub4u/extraction.js` to avoid circular dependency
- This is handled via dynamic `import()` in processExtractorLinkWithAwait

## Recommendations

1. **Complete remaining extractions in order:**
   - 4KHDHub (search.js, streams.js) - highest priority, most complex
   - StreamSrc modules - medium complexity
   - HDHub4u and resolvers - lower complexity
   - Index files - simple re-exports

2. **Testing strategy:**
   - Test each module independently as it's created
   - Verify imports work correctly
   - Check for any missing dependencies
   - Test main entry points (get4KHDHubStreams, getStreamSrcStreams)

3. **Migration path:**
   - Keep backup file until fully tested
   - Use new compatibility layer for gradual migration
   - Monitor for any runtime errors

## Environment Variables

The refactored code respects these environment variables:

### Validation
- `VALIDATION_TIMEOUT` (default: 8000ms)
- `DISABLE_URL_VALIDATION` (default: false)
- `DISABLE_SEEK_VALIDATION` (default: false)
- `DISABLE_4KHDHUB_URL_VALIDATION` (default: false)
- `DISABLE_4KHDHUB_SEEK_VALIDATION` (default: false)

### HTTP Requests
- `REQUEST_TIMEOUT` (default: 15000ms)
- `REQUEST_MAX_RETRIES` (default: 2)
- `REQUEST_RETRY_DELAY` (default: 1000ms)

### Domain Caching
- `DOMAIN_CACHE_TTL_MS` (default: 60000ms)

### 4KHDHub
- `MAX_4KHDHUB_LINKS` (default: 25)
- `BATCH_SIZE` (default: 8)

---

**Status:** 50% Complete (1,628/3,261 lines extracted)
**Created:** $(date)
**Original file backed up:** lib/http-streams.js.backup
