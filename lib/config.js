// --- Debugging ---
export const DEBRID_DEBUG_LOGS = process.env.DEBRID_DEBUG_LOGS === 'true';
export const RD_DEBUG_LOGS = process.env.RD_DEBUG_LOGS === 'true';

// --- Service URLs & API Keys ---
export const BITMAGNET_URL = process.env.BITMAGNET_URL || 'http://YOUR_BITMAGNET_URL';
export const JACKETT_URL = process.env.JACKETT_URL || 'http://YOUR_JACKETT_IP:9117';
export const JACKETT_API_KEY = process.env.JACKETT_API_KEY || '';
export const TORRENTIO_URL = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
export const ZILEAN_URL = process.env.ZILEAN_URL || 'https://zilean.elfhosted.com';
export const COMET_URL = process.env.COMET_URL || 'https://comet.elfhosted.com';
export const STREMTHRU_URL = process.env.STREMTHRU_URL || 'https://stremthru.elfhosted.com';
export const BT4G_URL = process.env.BT4G_URL || 'https://bt4gprx.com';
// CORRECTED: Was using BT4G_URL variable by mistake
export const TORRENTGALAXY_URL = process.env.TORRENT_GALAXY_URL || 'https://torrentgalaxy.one';

// --- Scraper Settings ---
export const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT, 10) || 5000;
export const TORZNAB_LIMIT = parseInt(process.env.TORZNAB_LIMIT, 10) || 50;
export const ZILEAN_LIMIT = parseInt(process.env.ZILEAN_LIMIT, 10) || 75;

// --- Scraper Enable/Disable Flags ---
export const BITMAGNET_ENABLED = process.env.BITMAGNET_ENABLED === 'true';
export const JACKETT_ENABLED = process.env.JACKETT_ENABLED === 'true';
export const TORRENTIO_ENABLED = process.env.TORRENTIO_ENABLED === 'true';
export const ZILEAN_ENABLED = process.env.ZILEAN_ENABLED === 'true';
export const COMET_ENABLED = process.env.COMET_ENABLED === 'true';
export const STREMTHRU_ENABLED = process.env.STREMTHRU_ENABLED === 'true';
export const BT4G_ENABLED = process.env.BT4G_ENABLED === 'true';
export const TORRENT_GALAXY_ENABLED = process.env.TORRENT_GALAXY_ENABLED === 'true';
export const TORRENT_DOWNLOAD_ENABLED = process.env.TORRENT_DOWNLOAD_ENABLED === 'true';
export const SNOWFL_ENABLED = process.env.SNOWFL_ENABLED === 'true';

// --- Real-Debrid Specific Priority & Filtering Configuration ---

// General Skips
export const PRIORITY_SKIP_WEBRIP_ENABLED = process.env.PRIORITY_SKIP_WEBRIP_ENABLED === 'true';
export const PRIORITY_SKIP_AAC_OPUS_ENABLED = process.env.PRIORITY_SKIP_AAC_OPUS_ENABLED === 'true';

// Quality Quotas
export const MAX_RESULTS_PER_QUALITY = parseInt(process.env.MAX_RESULTS_PER_QUALITY, 10) || 2;
export const MAX_RESULTS_REMUX = parseInt(process.env.MAX_RESULTS_REMUX, 10) || MAX_RESULTS_PER_QUALITY;
export const MAX_RESULTS_BLURAY = parseInt(process.env.MAX_RESULTS_BLURAY, 10) || MAX_RESULTS_PER_QUALITY;
export const MAX_RESULTS_WEBDL = parseInt(process.env.MAX_RESULTS_WEBDL, 10) || MAX_RESULTS_PER_QUALITY;
export const MAX_RESULTS_WEBRIP = parseInt(process.env.MAX_RESULTS_WEBRIP, 10) || 1;
export const MAX_RESULTS_AUDIO = parseInt(process.env.MAX_RESULTS_AUDIO, 10) || 1;
export const MAX_RESULTS_OTHER = parseInt(process.env.MAX_RESULTS_OTHER, 10) || 10;

// Codec Diversity
export const DIVERSIFY_CODECS_ENABLED = process.env.DIVERSIFY_CODECS_ENABLED === 'true';
export const MAX_H265_RESULTS_PER_QUALITY = parseInt(process.env.MAX_H265_RESULTS_PER_QUALITY, 10) || 2;
export const MAX_H264_RESULTS_PER_QUALITY = parseInt(process.env.MAX_H264_RESULTS_PER_QUALITY, 10) || 2;

// Global Limits & Exit Conditions
export const TARGET_CODEC_COUNT = parseInt(process.env.TARGET_CODEC_COUNT, 10) || 10;
export const EARLY_EXIT_QUALITY_THRESHOLD = process.env.EARLY_EXIT_QUALITY_THRESHOLD || 'BluRay';

// --- Performance & Concurrency ---
export const RD_CONCURRENCY = parseInt(process.env.RD_CONCURRENCY, 10) || 10;

// --- Season Pack Inspection ---
export const MAX_PACKS_TO_INSPECT = parseInt(process.env.MAX_PACKS_TO_INSPECT, 10) || 5;
export const MAX_PACK_ROUNDS = parseInt(process.env.MAX_PACK_ROUNDS, 10) || 3;

// --- Real-Debrid File Caching Configuration ---
export const RD_HASH_CACHE_ENABLED = process.env.RD_HASH_CACHE_ENABLED === 'true';
export const RD_HASH_CACHE_PATH = process.env.RD_HASH_CACHE_PATH || './rd_hash_cache.json';
export const RD_HASH_CACHE_LIFETIME_DAYS = parseInt(process.env.RD_HASH_CACHE_LIFETIME_DAYS, 10) || 3;

// --- Mongo Cache (Optional, Global) ---
// Enable to use MongoDB-backed magnet cache for all debrid providers
export const MONGO_CACHE_ENABLED = process.env.MONGO_CACHE_ENABLED === 'true';
export const MONGO_URI = process.env.MONGO_URI || '';
export const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'sootio';
export const MONGO_CACHE_COLLECTION = process.env.MONGO_CACHE_COLLECTION || 'magnet_cache';
// Default TTL is 30 days unless overridden
export const MONGO_CACHE_TTL_DAYS = parseInt(process.env.MONGO_CACHE_TTL_DAYS, 10) || 30;
