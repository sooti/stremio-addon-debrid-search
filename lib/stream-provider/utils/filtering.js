/**
 * Stream filtering utilities
 */

import { sizeToBytes } from '../../common/torrent-utils.js';

/**
 * Filters streams by size range
 * @param {Array} streams - Array of stream objects
 * @param {number} minSizeGB - Minimum size in GB
 * @param {number} maxSizeGB - Maximum size in GB
 * @returns {Array} - Filtered streams
 */
export function filterBySize(streams, minSizeGB, maxSizeGB) {
  // If both are at defaults (0 and 200), no filtering
  if (minSizeGB === 0 && maxSizeGB === 200) {
    return streams;
  }

  const minSizeBytes = minSizeGB * 1024 * 1024 * 1024;
  const maxSizeBytes = maxSizeGB * 1024 * 1024 * 1024;

  return streams.filter(stream => {
    // Extract size from the stream object
    // Size could be in the original details or we need to parse from title
    // It could be a number (bytes) or a formatted string (like "6.91GB")
    let size = stream.size || stream._size || 0;

    // If size is a string (like "6.91GB"), convert it to bytes
    if (typeof size === 'string') {
      size = sizeToBytes(size);
    }

    if (size === 0) {
      // If no size info, keep the stream (don't filter unknown sizes)
      return true;
    }

    return size >= minSizeBytes && size <= maxSizeBytes;
  });
}
