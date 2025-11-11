/**
 * UHDMovies Streaming Provider - Refactored
 *
 * This module has been refactored from a single 2,895 line file into a modular structure:
 *
 * REFACTORING SUMMARY:
 * -------------------
 * 1. extractTvShowDownloadLinks: Reduced from ~300 lines to ~120 lines
 *    - Broken into season-parser.js, episode-parser.js, and links.js
 *
 * 2. getUHDMoviesStreams: Reduced from ~750 lines to ~80 lines
 *    - Broken into metadata-fetcher.js, link-validator.js, stream-formatter.js, stream-getter.js
 *
 * 3. Configuration: Extracted to config/ (proxy.js, domains.js)
 * 4. Utilities: Extracted to utils/ (http.js, encoding.js, quality.js, language.js, validation.js)
 * 5. Search: Extracted to search/ (movie-search.js)
 * 6. Extraction: Organized into extraction/tv/ and extraction/movie/
 * 7. Streams: Organized into streams/ with clear separation of concerns
 * 8. Resolvers: Extracted to resolvers/ (sid-resolver.js, url-resolver.js)
 */

// Main exports - the public API
export { getUHDMoviesStreams } from './streams/stream-getter.js';
export { resolveUHDMoviesUrl } from './resolvers/url-resolver.js';

// Additional exports for advanced use cases
export { searchMovies, compareMedia, scoreResult, parseSize } from './search/movie-search.js';
export { extractTvShowDownloadLinks } from './extraction/tv/links.js';
export { extractDownloadLinks } from './extraction/movie/links.js';
export { resolveSidToDriveleech } from './resolvers/sid-resolver.js';

// Config exports
export { getUHDMoviesDomain } from './config/domains.js';
export { UHDMOVIES_PROXY_URL, USE_HTTPSTREAMS_PROXY } from './config/proxy.js';

// Utility exports
export { makeRequest, axiosInstance, createAxiosInstance } from './utils/http.js';
export { encodeUrlForStreaming } from './utils/encoding.js';
export { extractCleanQuality, extractCodecs } from './utils/quality.js';
export { extractLanguageInfoFromHeader } from './utils/language.js';
export { validateVideoUrl } from './utils/validation.js';
