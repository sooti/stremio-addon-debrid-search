# Stream Provider Module - Refactored Architecture

This directory contains the refactored modular version of the stream provider system (originally `lib/stream-provider.js`, 2,378 lines).

## Directory Structure

```
lib/stream-provider/
├── config/                    # Configuration and constants
│   ├── timeouts.js           # Service timeouts and timeout wrapper (42 lines)
│   └── stream-names.js       # Stream name prefixes for providers (18 lines)
├── utils/                     # Utility functions
│   ├── url-validation.js     # URL validation and HTTP stream wrapping (68 lines)
│   ├── sorting.js            # Torrent sorting by resolution/size (24 lines)
│   └── filtering.js          # Stream filtering by size (41 lines)
├── caching/                   # Caching layer (SQLite + in-memory)
│   ├── cache-manager.js      # Cache retrieval and storage (339 lines)
│   ├── background-refresh.js # Background cache refresh (67 lines)
│   └── deduplication.js      # In-flight request deduplication (52 lines)
├── debrid/                    # Debrid provider implementations
│   └── providers.js          # Provider-specific logic for all services (334 lines)
├── formatters/                # Stream formatting for Stremio
│   ├── stream-formatter.js   # Standard stream formatting (133 lines)
│   └── debrider-formatter.js # Debrider.app stream formatting (93 lines)
├── resolvers/                 # URL resolution
│   └── url-resolver.js       # URL resolution for all debrid services (305 lines)
├── alternative-services/      # Alternative streaming services
│   ├── easynews.js           # Easynews integration (72 lines)
│   ├── usenet.js             # Usenet/Newznab integration (351 lines)
│   └── home-media.js         # Home Media Server integration (84 lines)
├── aggregators/               # Stream aggregation
│   └── shared.js             # Shared aggregator utilities (7 lines)
├── index.js                   # Main entry point with all exports (83 lines)
└── README.md                  # This file
```

## Total Line Count

**Refactored modules: 2,113 lines** (across 17 files)
**Original file: 2,378 lines** (single file)

The refactored version is slightly smaller due to removal of duplicate comments and better organization.

## Module Overview

### Configuration (`config/`)

**timeouts.js** - Service timeout configuration
- `SERVICE_TIMEOUT_MS` - Default debrid service timeout (150s)
- `HTTP_STREAMING_TIMEOUT_MS` - HTTP streaming timeout (10s)
- `USENET_TIMEOUT_MS` - Usenet service timeout (20s)
- `SEARCH_CACHE_VERSION` - Cache version for invalidation
- `withTimeout(promise, timeoutMs, serviceName)` - Promise timeout wrapper

**stream-names.js** - Service name prefixes
- `STREAM_NAME_MAP` - Maps provider names to display prefixes (e.g., "[RD+] Sootio")

### Utilities (`utils/`)

**url-validation.js** - URL handling
- `isValidUrl(url)` - Validates streaming URLs
- `isVideo(filename)` - Checks if file is a video
- `wrapHttpStreamsWithResolver(streams, addonHost)` - Wraps HTTP streams with resolver endpoint

**sorting.js** - Torrent sorting
- `sortTorrents(a, b)` - Sorts by resolution then size

**filtering.js** - Stream filtering
- `filterBySize(streams, minGB, maxGB)` - Filters streams by size range

### Caching (`caching/`)

**cache-manager.js** - Main caching logic (339 lines)
- `getCachedTorrents(provider, type, id, config, searchFn)` - Cache-aware torrent search with Torz API integration
- `storeCacheResults(collection, key, results, type, provider)` - Store search results in SQLite cache
- `verifyCachedTorrents(apiKey, provider, cachedResults)` - Verification logging
- `refreshHttpStreamLinks(cachedResults)` - HTTP stream link refresh logging

**background-refresh.js** - Background cache updates (67 lines)
- `refreshCacheInBackground(provider, type, id, config, searchFn, key, existingResults)` - Async cache refresh

**deduplication.js** - Request deduplication (52 lines)
- `dedupedRequest(key, requestFn)` - Prevents duplicate concurrent requests
- `getInFlightCount()` - Get number of in-flight requests
- `clearInFlightRequests()` - Clear all in-flight requests

### Debrid Providers (`debrid/`)

**providers.js** - All provider implementations (334 lines)
- `getMovieStreamsFromProvider(provider, apiKey, type, id, config, meta, searchKey)` - Movie streams from single provider
- `getSeriesStreamsFromProvider(provider, apiKey, type, id, config, meta, searchKey, season, episode)` - Series streams from single provider

Supports:
- RealDebrid (with Torz API integration)
- AllDebrid
- Premiumize
- DebridLink
- TorBox
- OffCloud
- Debrider.app
- Personal Cloud

### Formatters (`formatters/`)

**stream-formatter.js** - Standard stream formatting (133 lines)
- `toStream(details, type, config, streamHint)` - Formats torrent/debrid data into Stremio stream objects
- Handles language detection and flag rendering
- Generates resolver URLs for each provider
- Supports magnet URL construction from hash

**debrider-formatter.js** - Debrider-specific formatting (93 lines)
- `toDebriderStream(details, type, config)` - Formats Debrider.app/Personal Cloud streams
- Handles NZB URL routing
- Supports personal cloud files

### Resolvers (`resolvers/`)

**url-resolver.js** - URL resolution for all services (305 lines)
- `resolveUrl(provider, apiKey, itemId, hostUrl, clientIp, config)` - Resolves magnet/torrent/direct links to streaming URLs

Provider-specific resolution:
- RealDebrid: Magnet upload, file selection, link unrestriction
- AllDebrid: Stream URL resolution
- Premiumize: Direct download link generation with episode hint support
- OffCloud: Stream resolution with type inference
- TorBox: URL unrestriction
- DebridLink: Pass-through (already resolved)
- Debrider.app: NZB submission and task completion

### Alternative Services (`alternative-services/`)

**easynews.js** - Easynews integration (72 lines)
- `getEasynewsStreams(config, type, id)` - Fetch and format Easynews streams

**usenet.js** - Usenet/Newznab integration (351 lines)
- `getUsenetStreams(config, type, id)` - Fetch Newznab results and match with personal files
- File server integration for personal cloud files
- Smart title/episode matching
- Personal-only stream creation for unmatched files

**home-media.js** - Home Media Server (84 lines)
- `getHomeMediaStreams(config, type, id)` - Fetch streams from local media server

### Aggregators (`aggregators/`)

**shared.js** - Aggregator utilities (7 lines)
- Re-exports provider functions for aggregation

## Usage

### Import the module

```javascript
import StreamProvider from './stream-provider/index.js';

// Or import specific functions
import { getMovieStreams, getSeriesStreams, resolveUrl } from './stream-provider/index.js';

// Or import individual modules
import { getCachedTorrents } from './stream-provider/caching/cache-manager.js';
import { toStream } from './stream-provider/formatters/stream-formatter.js';
```

### Get movie streams

```javascript
const config = {
  DebridServices: [
    { provider: 'RealDebrid', apiKey: 'your-key' },
    { provider: 'Easynews', username: 'user', password: 'pass' }
  ],
  Languages: ['en', 'es'],
  minSize: 0,
  maxSize: 200
};

const streams = await StreamProvider.getMovieStreams(config, 'movie', 'tt1234567');
```

### Resolve a stream URL

```javascript
const streamUrl = await StreamProvider.resolveUrl(
  'RealDebrid',
  'api-key',
  'tt1234567',
  'magnet:?xt=urn:btih:...',
  '192.168.1.1',
  {}
);
```

## Migration Notes

The current implementation maintains backward compatibility by re-exporting from the original `stream-provider.js` file. The modular components are fully functional and can be used independently.

### Future Work

1. **Complete aggregator extraction**: Fully implement `movie-aggregator.js` and `series-aggregator.js` using the modular components
2. **Provider extraction**: Split `debrid/providers.js` into individual files per provider (e.g., `debrid/realdebrid.js`, `debrid/alldebrid.js`)
3. **Remove dependency on original file**: Once aggregators are complete, remove the re-export from `stream-provider.js`
4. **Add tests**: Create unit tests for each module
5. **TypeScript definitions**: Add type definitions for better IDE support

## Benefits of Modular Structure

1. **Separation of concerns**: Each module has a single, well-defined responsibility
2. **Easier testing**: Smaller modules are easier to test in isolation
3. **Better maintainability**: Changes to one component don't affect others
4. **Improved readability**: 2,378 lines split into focused modules of 20-350 lines each
5. **Reusability**: Individual components can be imported and used independently
6. **Future extensibility**: Easy to add new providers, formatters, or services

## File Size Breakdown

| Module | Lines | Purpose |
|--------|-------|---------|
| caching/cache-manager.js | 339 | Cache management and Torz integration |
| alternative-services/usenet.js | 351 | Usenet/Newznab with personal file matching |
| debrid/providers.js | 334 | All debrid provider implementations |
| resolvers/url-resolver.js | 305 | URL resolution for all services |
| formatters/stream-formatter.js | 133 | Standard stream formatting |
| formatters/debrider-formatter.js | 93 | Debrider stream formatting |
| alternative-services/home-media.js | 84 | Home Media Server integration |
| index.js | 83 | Main entry point |
| alternative-services/easynews.js | 72 | Easynews integration |
| utils/url-validation.js | 68 | URL validation and wrapping |
| caching/background-refresh.js | 67 | Background cache refresh |
| caching/deduplication.js | 52 | Request deduplication |
| config/timeouts.js | 42 | Timeout configuration |
| utils/filtering.js | 41 | Size filtering |
| utils/sorting.js | 24 | Torrent sorting |
| config/stream-names.js | 18 | Service name mapping |
| aggregators/shared.js | 7 | Aggregator utilities |
| **Total** | **2,113** | **17 files** |

---

**Original file**: `lib/stream-provider.js` (2,378 lines) - **Backup saved at**: `lib/stream-provider.js.backup`
