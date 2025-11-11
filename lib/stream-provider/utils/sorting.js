/**
 * Torrent sorting utilities
 */

import { getResolutionFromName, resolutionOrder } from '../../common/torrent-utils.js';

/**
 * Sorts torrents by resolution (higher first) and then by size (larger first)
 * @param {Object} a - First torrent
 * @param {Object} b - Second torrent
 * @returns {number} - Sort order
 */
export function sortTorrents(a, b) {
  const nameA = a.name || a.title || '';
  const nameB = b.name || b.title || '';
  const resA = getResolutionFromName(nameA);
  const resB = getResolutionFromName(nameB);
  const rankA = resolutionOrder[resA] || 0;
  const rankB = resolutionOrder[resB] || 0;
  if (rankA !== rankB) return rankB - rankA;
  const sizeA = a.size || 0;
  const sizeB = b.size || 0;
  return sizeB - sizeA;
}
