/**
 * Stream Provider - Main Entry Point
 * Refactored modular architecture
 *
 * This module aggregates all stream provider functionality:
 * - Configuration (timeouts, service names)
 * - Utilities (URL validation, sorting, filtering)
 * - Caching (SQLite cache, background refresh, deduplication)
 * - Debrid providers (RealDebrid, AllDebrid, etc.)
 * - Formatters (stream formatting for Stremio)
 * - Resolvers (URL resolution for all services)
 * - Alternative services (Easynews, Usenet, Home Media)
 * - Aggregators (movie/series stream aggregation)
 */

// For now, we re-export from the original file to maintain compatibility
// Future work: Fully implement aggregators using the modular components
import originalStreamProvider from '../stream-provider.js';

// Export the main functions (currently from original file)
export const { getMovieStreams, getSeriesStreams, resolveUrl, STREAM_NAME_MAP } = originalStreamProvider;

// Re-export as default for backward compatibility
export default originalStreamProvider;

// Export individual modules for direct usage
export * from './config/timeouts.js';
export * from './config/stream-names.js';
export * from './utils/url-validation.js';
export * from './utils/sorting.js';
export * from './utils/filtering.js';
export * from './caching/cache-manager.js';
export * from './caching/background-refresh.js';
export * from './caching/deduplication.js';
export * from './debrid/providers.js';
export * from './formatters/stream-formatter.js';
export * from './formatters/debrider-formatter.js';
export * from './resolvers/url-resolver.js';
export * from './alternative-services/easynews.js';
export * from './alternative-services/usenet.js';
export * from './alternative-services/home-media.js';

/**
 * Module exports summary:
 *
 * Main Functions:
 * - getMovieStreams(config, type, id) - Get all movie streams
 * - getSeriesStreams(config, type, id) - Get all series streams
 * - resolveUrl(provider, apiKey, itemId, hostUrl, clientIp, config) - Resolve streaming URL
 *
 * Configuration:
 * - STREAM_NAME_MAP - Service name prefixes
 * - SERVICE_TIMEOUT_MS - Debrid service timeout
 * - HTTP_STREAMING_TIMEOUT_MS - HTTP streaming timeout
 * - USENET_TIMEOUT_MS - Usenet timeout
 * - withTimeout(promise, timeoutMs, serviceName) - Timeout wrapper
 *
 * Utilities:
 * - isValidUrl(url) - URL validation
 * - isVideo(filename) - Video file detection
 * - sortTorrents(a, b) - Torrent sorting
 * - filterBySize(streams, minGB, maxGB) - Size filtering
 * - wrapHttpStreamsWithResolver(streams, addonHost) - HTTP stream wrapping
 *
 * Caching:
 * - getCachedTorrents(provider, type, id, config, searchFn) - Cache-aware search
 * - storeCacheResults(collection, key, results, type, provider) - Store in cache
 * - refreshCacheInBackground(provider, type, id, config, searchFn, key, existingResults) - Background refresh
 * - dedupedRequest(key, requestFn) - Request deduplication
 *
 * Providers:
 * - getMovieStreamsFromProvider(provider, apiKey, type, id, config, meta, searchKey) - Single provider movie search
 * - getSeriesStreamsFromProvider(provider, apiKey, type, id, config, meta, searchKey, season, episode) - Single provider series search
 *
 * Formatters:
 * - toStream(details, type, config, streamHint) - Format torrent to stream
 * - toDebriderStream(details, type, config) - Format Debrider stream
 *
 * Alternative Services:
 * - getEasynewsStreams(config, type, id) - Easynews streams
 * - getUsenetStreams(config, type, id) - Usenet streams
 * - getHomeMediaStreams(config, type, id) - Home Media streams
 */
