/**
 * HTTP Streams Main Module
 * Central export point for all HTTP streaming functionality
 */

// Provider exports - 4KHDHub
export { get4KHDHubStreams } from './providers/4khdhub/streams.js';
export { scrape4KHDHubSearch, loadContent } from './providers/4khdhub/search.js';
export {
    extractHubCloudLinks,
    extractHubDriveLinks,
    processHubDriveLink,
    getRedirectLinks,
    extractStreamingLinks,
    processExtractorLinkWithAwait,
    processExtractorLink
} from './providers/4khdhub/extraction.js';

// Provider exports - StreamSrc
export { getStreamSrcStreams } from './providers/streamsrc/streams.js';
export {
    getStremsrcRandomizedHeaders,
    serversLoad,
    PRORCPhandler,
    rcpGrabber,
    getStreamSrcUrl,
    getObject,
    getStreamSrcBaseDom
} from './providers/streamsrc/api.js';
export { parseHLSMaster, fetchAndParseHLS } from './providers/streamsrc/hls.js';

// Provider exports - HDHub4u
export { getRedirectLinksForStream, hdhub4uGetStream } from './providers/hdhub4u/extraction.js';

// Provider exports - Hydraflix
export { getHydraflixStreams } from './providers/hydraflix/streams.js';
export { scrapeHydraflixSearch, loadContent as loadHydraflixContent } from './providers/hydraflix/search.js';

// Resolver exports
export { resolveHttpStreamUrl } from './resolvers/http-resolver.js';
export { decodeString } from './resolvers/link-processor.js';

// Utility exports
export {
    base64Decode,
    base64Encode,
    rot13,
    tryDecodeBase64,
    encodeUrlForStreaming
} from './utils/encoding.js';

export {
    makeRequest,
    getDomains
} from './utils/http.js';

export {
    getResolutionFromName,
    formatSize,
    getIndexQuality,
    getBaseUrl,
    cleanTitle,
    normalizeTitle,
    calculateSimilarity,
    containsWords,
    removeYear,
    generateAlternativeQueries,
    findBestMatch,
    getSortedMatches
} from './utils/parsing.js';

export {
    extractFilenameFromHeader,
    validateUrl,
    validateSeekableUrl
} from './utils/validation.js';
