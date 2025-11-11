/**
 * URL validation utilities
 */

/**
 * Validates if a URL is valid and usable
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if valid
 */
export function isValidUrl(url) {
  return url &&
    typeof url === 'string' &&
    url !== 'undefined' &&
    url !== 'null' &&
    url.length > 0 &&
    (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:') || url.startsWith('/resolve/') || url.startsWith('/torbox/') || url.startsWith('realdebrid:') || url.startsWith('nzb:'));
}

/**
 * Checks if a filename is a video file
 * @param {string} filename - The filename to check
 * @returns {boolean} - True if it's a video file
 */
export function isVideo(filename) {
  if (!filename || typeof filename !== 'string') return false;
  const exts = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.mpg','.mpeg','.3gp','.ogv','.ts','.m2ts'];
  const i = filename.toLowerCase().lastIndexOf('.');
  if (i < 0) return false;
  return exts.includes(filename.toLowerCase().substring(i));
}

/**
 * Wrap HTTP streaming URLs with the resolver endpoint for lazy resolution
 * @param {Array} streams - Array of stream objects from HTTP sources
 * @param {string} addonHost - The addon host URL
 * @returns {Array} - Streams with URLs wrapped in resolver endpoint
 */
export function wrapHttpStreamsWithResolver(streams, addonHost) {
  const base = addonHost || '';

  console.log(`[wrapHttpStreamsWithResolver] Processing ${streams?.length || 0} streams`);

  if (!streams || !Array.isArray(streams)) {
    console.log(`[wrapHttpStreamsWithResolver] Invalid streams input:`, streams);
    return [];
  }

  const result = streams.map(stream => {
    // Check if this stream needs lazy resolution
    if (stream.needsResolution && stream.url) {
      const encodedUrl = encodeURIComponent(stream.url);
      const resolverUrl = (base && base.startsWith('http'))
        ? `${base}/resolve/httpstreaming/${encodedUrl}`
        : stream.url; // Fallback to original if no base URL

      return {
        ...stream,
        url: resolverUrl,
        needsResolution: undefined // Remove the flag
      };
    }

    return stream;
  });

  console.log(`[wrapHttpStreamsWithResolver] Returning ${result.length} streams`);
  return result;
}
