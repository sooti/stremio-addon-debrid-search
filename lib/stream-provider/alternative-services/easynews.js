/**
 * Easynews stream provider
 * Fetches and formats streams from Easynews service
 */

import Easynews from '../../easynews.js';
import { getResolutionFromName, formatSize } from '../../common/torrent-utils.js';
import { STREAM_NAME_MAP } from '../config/stream-names.js';

/**
 * Get streams from Easynews
 *
 * @param {Object} config - User configuration with Easynews credentials
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Content ID (IMDB ID or IMDB:season:episode)
 * @returns {Promise<Array>} - Array of stream objects
 */
export async function getEasynewsStreams(config, type, id) {
  try {
    console.log('[EN+] getEasynewsStreams called');
    console.log('[EN+] Username:', config.EasynewsUsername ? '***' : 'not set');

    const results = await Easynews.searchEasynewsStreams(
      config.EasynewsUsername,
      config.EasynewsPassword,
      type,
      id,
      config
    );

    if (!results || results.length === 0) {
      console.log('[EN+] No results found');
      return [];
    }

    console.log(`[EN+] Got ${results.length} results from Easynews`);

    // Format results for Stremio
    const formattedStreams = results.map(result => {
      const resolution = getResolutionFromName(result.name);
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
        resolutionLabel = resolution || 'N/A';
      }

      return {
        name: `${STREAM_NAME_MAP.easynews}\n${resolutionLabel}`,
        title: `${result.name}\n📡 ${formatSize(result.size)}`,
        url: result.url,
        _size: result.size || 0,
        behaviorHints: {
          bingeGroup: `easynews|${result.hash || 'unknown'}`
        }
      };
    });

    return formattedStreams;

  } catch (error) {
    console.error('[EN+] Error getting Easynews streams:', error);
    return [];
  }
}
