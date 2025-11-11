/**
 * Active Usenet stream tracking
 * Track active Usenet streams: nzoId -> { lastAccess, streamCount, config, videoFilePath, usenetConfig }
 */

// Track active Usenet streams: nzoId -> { lastAccess, streamCount, config, videoFilePath, usenetConfig }
const ACTIVE_USENET_STREAMS = new Map();

// Store Usenet configs globally (so auto-clean works even without active streams)
const USENET_CONFIGS = new Map(); // fileServerUrl -> config

// Cleanup interval for inactive streams (check every 2 minutes)
const STREAM_CLEANUP_INTERVAL = 2 * 60 * 1000;

// Delete downloads after 10 minutes of inactivity
// This is aggressive to save bandwidth and disk space
// If user was just paused/buffering, they can restart the stream
const STREAM_INACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity

// Monitor interval for streams (check every 30 seconds)
const STREAM_MONITOR_INTERVAL = 30 * 1000; // 30 seconds

/**
 * Get active streams
 */
export function getActiveStreams() {
    return ACTIVE_USENET_STREAMS;
}

/**
 * Get usenet configs
 */
export function getUsenetConfigs() {
    return USENET_CONFIGS;
}

/**
 * Get stream info
 * @param {string} nzoId - NZO ID
 */
export function getStreamInfo(nzoId) {
    return ACTIVE_USENET_STREAMS.get(nzoId);
}

/**
 * Set stream info
 * @param {string} nzoId - NZO ID
 * @param {object} streamInfo - Stream info
 */
export function setStreamInfo(nzoId, streamInfo) {
    ACTIVE_USENET_STREAMS.set(nzoId, streamInfo);
}

/**
 * Delete stream info
 * @param {string} nzoId - NZO ID
 */
export function deleteStreamInfo(nzoId) {
    ACTIVE_USENET_STREAMS.delete(nzoId);
}

/**
 * Check if stream exists
 * @param {string} nzoId - NZO ID
 */
export function hasStream(nzoId) {
    return ACTIVE_USENET_STREAMS.has(nzoId);
}

/**
 * Get stream stats
 */
export function getStreamStats() {
    return {
        activeStreams: ACTIVE_USENET_STREAMS.size,
        configs: USENET_CONFIGS.size,
        cleanupInterval: `${STREAM_CLEANUP_INTERVAL / 1000 / 60} minutes`,
        inactiveTimeout: `${STREAM_INACTIVE_TIMEOUT / 1000 / 60} minutes`,
        monitorInterval: `${STREAM_MONITOR_INTERVAL / 1000} seconds`
    };
}

export {
    ACTIVE_USENET_STREAMS,
    USENET_CONFIGS,
    STREAM_CLEANUP_INTERVAL,
    STREAM_INACTIVE_TIMEOUT,
    STREAM_MONITOR_INTERVAL
};
