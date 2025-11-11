/**
 * Home Media Server stream provider
 * Fetches and formats streams from user's home media server
 */

import HomeMedia from '../../home-media.js';
import { getResolutionFromName, formatSize } from '../../common/torrent-utils.js';

const ADDON_HOST = process.env.ADDON_URL;

/**
 * Get streams from Home Media Server
 *
 * @param {Object} config - User configuration with Home Media Server settings
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Content ID (IMDB ID or IMDB:season:episode)
 * @returns {Promise<Array>} - Array of stream objects
 */
export async function getHomeMediaStreams(config, type, id) {
  try {
    console.log('[HM+] getHomeMediaStreams called');
    console.log('[HM+] Config HomeMediaUrl:', config.HomeMediaUrl);

    const results = await HomeMedia.searchHomeMedia(
      config.HomeMediaUrl,
      config.HomeMediaApiKey,
      type,
      id,
      config
    );

    if (!results || results.length === 0) {
      console.log('[HM+] No files found on home media server');
      return [];
    }

    console.log(`[HM+] Got ${results.length} results from home media server`);

    const base = ADDON_HOST || '';

    // Convert Home Media results to stream objects
    const streams = results.map(result => {
      const resolution = result.resolution || getResolutionFromName(result.title);
      // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
      let resolutionLabel;
      if (resolution === '2160p') {
          resolutionLabel = '4k';
      } else if (resolution === '1080p') {
          resolutionLabel = '1080p';
      } else if (resolution === '720p') {
          resolutionLabel = '720p';
      } else if (resolution === '480p') {
          resolutionLabel = '480p';
      } else {
          resolutionLabel = resolution; // fallback for other values
      }

      // Generate stream URL
      const streamUrl = HomeMedia.getStreamUrl(
        config.HomeMediaUrl,
        config.HomeMediaApiKey,
        result.flatPath || result.fileName
      );

      console.log(`[HM+] ✓ Creating stream for: "${result.title}"`);

      return {
        name: `☁️ Personal\n${resolutionLabel || 'N/A'}`,
        title: `${result.title}\n☁️ ${formatSize(result.size)} (Home Media)`,
        url: streamUrl,
        _size: result.size || 0,  // Preserve size for filtering
        behaviorHints: {
          bingeGroup: `homemedia|${result.fileName}`
        }
      };
    });

    return streams;

  } catch (error) {
    console.error('[HM+] Error getting streams:', error.message);
    return [];
  }
}
