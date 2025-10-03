// Wrapper around scrapers.js that applies a global porn filter to reduce
// irrelevant/explicit results as early as possible across all providers.

import * as base from './scrapers.js';
import { isPornTitle } from './torrent-utils.js';

function applyPornFilter(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(item => !isPornTitle(item?.Title || item?.name || item?.title || ''));
}

export async function searchBitmagnet(query, signal, logPrefix, config) {
  const res = await base.searchBitmagnet(query, signal, logPrefix, config);
  return applyPornFilter(res);
}

export async function searchJackett(query, signal, logPrefix, config) {
  const res = await base.searchJackett(query, signal, logPrefix, config);
  return applyPornFilter(res);
}

export async function searchZilean(title, season, episode, signal, logPrefix, config) {
  const res = await base.searchZilean(title, season, episode, signal, logPrefix, config);
  return applyPornFilter(res);
}

export async function searchTorrentio(mediaType, mediaId, signal, logPrefix, config) {
  const res = await base.searchTorrentio(mediaType, mediaId, signal, logPrefix, config);
  return applyPornFilter(res);
}

export async function searchStremthru(query, signal, logPrefix, config) {
  const res = await base.searchStremthru(query, signal, logPrefix, config);
  return applyPornFilter(res);
}

export async function searchBt4g(query, signal, logPrefix, config) {
  const res = await base.searchBt4g(query, signal, logPrefix, config);
  return applyPornFilter(res);
}

export async function searchTorrentGalaxy(searchKey, signal, logPrefix, config) {
  const res = await base.searchTorrentGalaxy(searchKey, signal, logPrefix, config);
  return applyPornFilter(res);
}

export async function searchComet(mediaType, mediaId, signal, season, episode, logPrefix, config) {
  if (typeof base.searchComet !== 'function') return [];
  const res = await base.searchComet(mediaType, mediaId, signal, season, episode, logPrefix, config);
  return applyPornFilter(res);
}

// Re-export anything else (if added later) without filtering to avoid breakage
export default { ...base };

