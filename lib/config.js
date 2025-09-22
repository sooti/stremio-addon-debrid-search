// src/config.js

// --- Service URLs & API Keys ---
export const BITMAGNET_URL = process.env.BITMAGNET_URL || 'http://YOUR_BITMAGNET_URL';
export const JACKETT_URL = process.env.JACKETT_URL || 'http://YOUR_JACKETT_IP:9117';
export const JACKETT_API_KEY = process.env.JACKETT_API_KEY || '';
export const TORRENTIO_URL = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
export const ZILEAN_URL = process.env.ZILEAN_URL || 'https://zilean.elfhosted.com';
export const COMET_URL = process.env.COMET_URL || 'https://comet.elfhosted.com';
export const STREMTHRU_URL = process.env.STREMTHRU_URL || 'https://stremthru.elfhosted.com';
export const BT4G_URL = process.env.BT4G_URL || 'https://bt4gprx.com';
export const TORRENT_GALAXY_URL = process.env.BT4G_URL || 'https://torrentgalaxy.space';

// --- Scraper Settings ---
export const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT) || 5000;
export const TORZNAB_LIMIT = parseInt(process.env.TORZNAB_LIMIT) || 50;
export const ZILEAN_LIMIT = parseInt(process.env.ZILEAN_LIMIT) || 75;

// --- Scraper Enable/Disable Flags ---
export const BITMAGNET_ENABLED = process.env.BITMAGNET_ENABLED === 'true';
export const JACKETT_ENABLED = process.env.JACKETT_ENABLED === 'true';
export const TORRENTIO_ENABLED = process.env.TORRENTIO_ENABLED === 'true';
export const ZILEAN_ENABLED = process.env.ZILEAN_ENABLED === 'true';
export const COMET_ENABLED = process.env.COMET_ENABLED === 'true';
export const STREMTHRU_ENABLED = process.env.STREMTHRU_ENABLED === 'true';
export const BT4G_ENABLED = process.env.BT4G_ENABLED === 'true';
export const TORRENT_GALAXY_ENABLED = process.env.TORRENT_GALAXY_ENABLED === 'true';

// --- Real-Debrid Specific Priority & Filtering Configuration ---
export const PRIORITY_PENALTY_AAC_OPUS_ENABLED = process.env.PRIORITY_PENALTY_AAC_OPUS_ENABLED === 'true';
export const PRIORITY_SKIP_WEBRIP_ENABLED = process.env.PRIORITY_SKIP_WEBRIP_ENABLED === 'true';
export const PRIORITY_SKIP_LOW_RESOLUTION_ENABLED = process.env.PRIORITY_SKIP_LOW_RESOLUTION_ENABLED === 'true';
export const PRIORITY_SKIP_AAC_OPUS_ENABLED = process.env.PRIORITY_SKIP_AAC_OPUS_ENABLED === 'true';
export const DIVERSIFY_CODECS_ENABLED = process.env.DIVERSIFY_CODECS_ENABLED === 'true';
export const TARGET_CODEC_COUNT = parseInt(process.env.TARGET_CODEC_COUNT) || 2;

// --- Real-Debrid File Caching Configuration ---
export const RD_HASH_CACHE_ENABLED = process.env.RD_HASH_CACHE_ENABLED === 'true';
export const RD_HASH_CACHE_PATH = process.env.RD_HASH_CACHE_PATH || './rd_hash_cache.json';
export const RD_HASH_CACHE_LIFETIME_DAYS = parseInt(process.env.RD_HASH_CACHE_LIFETIME_DAYS) || 3;
