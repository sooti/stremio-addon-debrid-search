/**
 * URL resolution for all debrid services
 * Handles magnet links, torrent files, and direct links
 */

import RealDebrid from '../../real-debrid.js';
import RealDebridClient from 'real-debrid-api';
import AllDebrid from '../../all-debrid.js';
import Premiumize from '../../premiumize.js';
import OffCloud from '../../offcloud.js';
import TorBox from '../../torbox.js';
import DebriderApp from '../../debrider.app.js';
import PTT from '../../util/parse-torrent-title.js';
import { isValidUrl, isVideo } from '../utils/url-validation.js';

/**
 * Resolve a URL through a debrid service
 * Handles magnet links, torrent files, and direct downloads
 *
 * @param {string} debridProvider - Provider name (RealDebrid, AllDebrid, etc.)
 * @param {string} debridApiKey - API key for the provider
 * @param {string} itemId - Content ID (for context, e.g., tt123:1:5)
 * @param {string} hostUrl - URL to resolve (magnet, torrent, or direct link)
 * @param {string} clientIp - Client IP address (for some providers)
 * @param {Object} config - Additional configuration
 * @returns {Promise<string|null>} - Resolved streaming URL or null on error
 */
export async function resolveUrl(debridProvider, debridApiKey, itemId, hostUrl, clientIp, config = {}) {
  const provider = debridProvider.toLowerCase();

  // Validate hostUrl before attempting to use it
  if (!hostUrl || hostUrl === 'undefined') {
    console.error(`[RESOLVER] Invalid or missing hostUrl: ${hostUrl}`);
    return null;
  }

  console.log(`[RESOLVER] resolveUrl called with provider: ${provider}, hostUrl: ${hostUrl.substring(0, 100)}${hostUrl.length > 100 ? '...' : ''}`);

  // Handle NZB URLs for DebriderApp/PersonalCloud
  if (hostUrl.startsWith('nzb:') && (provider === 'debriderapp' || provider === 'personalcloud')) {
    const nzbUrl = hostUrl.substring(4); // Remove 'nzb:' prefix
    const newznabApiKey = config.PersonalCloudNewznabApiKey || config.newznabApiKey || '';
    const baseUrl = config.PersonalCloudUrl || 'https://debrider.app/api/v1';

    console.log(`[RESOLVER] Processing NZB download for ${provider}...`);

    try {
      // Submit NZB to Personal Cloud
      const taskInfo = await DebriderApp.submitNzb(debridApiKey, nzbUrl, newznabApiKey, baseUrl);
      console.log(`[RESOLVER] NZB task created: ${taskInfo.taskId}`);

      // Wait for task to complete and get video file
      const completedTask = await DebriderApp.waitForTaskCompletion(debridApiKey, taskInfo.taskId, baseUrl, 300000);

      if (completedTask.videoFiles && completedTask.videoFiles.length > 0) {
        // Return the largest video file
        const largestVideo = completedTask.videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
        const videoUrl = largestVideo.download_link || largestVideo.url;
        console.log(`[RESOLVER] NZB download complete, returning video URL`);
        return videoUrl;
      } else {
        throw new Error('No video files found in completed task');
      }
    } catch (error) {
      console.error(`[RESOLVER] NZB processing error: ${error.message}`);
      return null;
    }
  }

  if (!isValidUrl(hostUrl)) {
    console.error(`[RESOLVER] Invalid URL provided: ${hostUrl}`);
    return null;
  }
  try {
    if (provider === "realdebrid") {
      if (hostUrl.startsWith('magnet:') || hostUrl.includes('||HINT||')) {
        const maxRetries = 20; // Increase retries to allow more time for links to become available
        const retryInterval = 3000; // Reduce delay to allow more attempts
        let episodeHint = null;
        if (hostUrl.includes('||HINT||')) {
          try {
            const parts = hostUrl.split('||HINT||');
            hostUrl = parts[0];
            episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
          } catch (_) { episodeHint = null; }
        }

        // Import rate limiter dynamically to avoid circular dependencies
        const RdLimiter = (await import('../../util/rd-rate-limit.js')).default;
        const rdCall = (fn) => RdLimiter.schedule(fn, 'rd-call', debridApiKey);

        const RD = new RealDebridClient(debridApiKey);
        let torrentId = null;
        try {
          const addResponse = await rdCall(() => RD.torrents.addMagnet(hostUrl));
          if (!addResponse?.data?.id) throw new Error("Failed to add magnet.");
          torrentId = addResponse.data.id;
          await rdCall(() => RD.torrents.selectFiles(torrentId, 'all'));

          let torrentInfo = null;

          // First wait for the torrent to be processed and ready
          for (let i = 0; i < maxRetries; i++) {
            torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
            const status = torrentInfo?.data?.status;
            if (status === 'downloaded' || status === 'finished') break;
            if (['magnet_error','error','virus','dead'].includes(status)) throw new Error(`Torrent failed: ${status}`);
            if (i === maxRetries - 1) throw new Error(`Torrent not ready after ${Math.ceil((maxRetries*retryInterval)/1000)}s`);
            await new Promise(r => setTimeout(r, retryInterval));
          }

          // Now wait for links to become available (separate from download status)
          let links = torrentInfo?.data?.links || [];
          if (links.length === 0) {
            console.log(`[RESOLVER] Links not available yet, waiting for them to be generated...`);
            for (let i = 0; i < maxRetries; i++) {
              torrentInfo = await rdCall(() => RD.torrents.info(torrentId));
              links = torrentInfo?.data?.links || [];
              if (links.length > 0) {
                console.log(`[RESOLVER] Links are now available: ${links.length} links found`);
                break;
              }
              if (i === maxRetries - 1) throw new Error("No streamable links found after waiting");
              await new Promise(r => setTimeout(r, retryInterval));
            }
          }

          if (!links.length) throw new Error("No streamable links found.");

          const files = torrentInfo.data.files || [];
          const videoFiles = files.filter(f => f.selected);
          if (videoFiles.length === 0) throw new Error("No valid video files.");

          let chosen = null;
          if (episodeHint) {
            if (episodeHint.fileId != null) chosen = videoFiles.find(f => f.id === episodeHint.fileId) || null;
            if (!chosen && episodeHint.filePath) chosen = videoFiles.find(f => f.path === episodeHint.filePath) || null;
            if (!chosen && episodeHint.season && episodeHint.episode) {
              const s = String(episodeHint.season).padStart(2, '0');
              const e = String(episodeHint.episode).padStart(2, '0');
              const patterns = [
                new RegExp('[sS][\\W_]*' + s + '[\\W_]*[eE][\\W_]*' + e, 'i'),
                new RegExp('\\b' + Number(episodeHint.season) + '[\\W_]*x[\\W_]*' + e + '\\b', 'i'),
                new RegExp('\\b[eE]p?\\.?\\s*' + Number(episodeHint.episode) + '\\b', 'i'),
                new RegExp('episode\\s*' + Number(episodeHint.episode), 'i')
              ];
              chosen = videoFiles.find(f => patterns.some(p => p.test(f.path))) || null;
            }
          }
          if (!chosen) chosen = videoFiles.reduce((a, b) => (a.bytes > b.bytes ? a : b));

          // Find the correct link for the chosen file
          // RD API behavior: links[] array maps to files[] array (links[i] is for files[i])
          let directUrl = null;
          const chosenFileId = String(chosen.id);

          // Method 1: Check if file has its own links property (newer API format)
          if (chosen.links && Array.isArray(chosen.links) && chosen.links.length > 0) {
            directUrl = chosen.links[0];
            console.log(`[RESOLVER] Found direct URL using file.links property for file ${chosenFileId}`);
          }

          // Method 2: Find the file's index in ALL files, then use that to index into links array
          // This is the standard RD API mapping: links[i] corresponds to files[i]
          if (!directUrl) {
            const fileIndexInAll = files.findIndex(f => String(f.id) === chosenFileId);
            if (fileIndexInAll !== -1 && fileIndexInAll < links.length) {
              const potentialUrl = links[fileIndexInAll];
              if (potentialUrl && potentialUrl !== 'undefined') {
                directUrl = potentialUrl;
                console.log(`[RESOLVER] Found direct URL at index ${fileIndexInAll} for file ${chosenFileId}`);
              }
            } else {
              console.log(`[RESOLVER] Method 2 failed: File index: ${fileIndexInAll}, links length: ${links.length}, files length: ${files.length}`);
            }
          }

          // Method 3: Try finding among selected files only (fallback for edge cases)
          // Some RD API versions may only return links for selected files
          if (!directUrl) {
            const selectedFiles = files.filter(f => f.selected);
            const indexInSelected = selectedFiles.findIndex(f => String(f.id) === chosenFileId);
            if (indexInSelected !== -1 && indexInSelected < links.length) {
              const potentialUrl = links[indexInSelected];
              if (potentialUrl && potentialUrl !== 'undefined') {
                directUrl = potentialUrl;
                console.log(`[RESOLVER] Found direct URL at selected-index ${indexInSelected} for file ${chosenFileId}`);
              }
            } else {
              console.log(`[RESOLVER] Method 3 failed: Selected index: ${indexInSelected}, selected files: ${selectedFiles.length}`);
            }
          }

          if (!directUrl || directUrl === 'undefined') {
            // Enhanced debugging: show all files and their selection status
            console.error(`[RESOLVER] RD magnet error: Direct URL not found for torrent ${torrentId}, file ${chosenFileId}`);
            console.error(`[RESOLVER] Files info: ${files.length} total files, ${videoFiles.length} selected video files, ${links.length} links`);
            files.forEach((f, idx) => {
              console.error(`[RESOLVER]   File[${idx}]: id=${f.id}, selected=${f.selected}, path=${f.path}`);
            });
            links.forEach((link, idx) => {
              console.error(`[RESOLVER]   Link[${idx}]: ${link ? 'present' : 'missing'}`);
            });
            throw new Error("Direct URL not found.");
          }

          const unrestrictedUrl = await RealDebrid.unrestrictUrl(debridApiKey, directUrl, clientIp);
          if (!unrestrictedUrl) throw new Error("Unrestrict failed.");
          return unrestrictedUrl;
        } catch (error) {
          const status = error?.response?.status || error?.status;
          console.error(`[RESOLVER] RD magnet error: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
          if (torrentId) { try { await rdCall(() => RD.torrents.delete(torrentId)); } catch (_) {} }
          return null;
        }
      } else {
        return RealDebrid.unrestrictUrl(debridApiKey, hostUrl, clientIp);
      }
    } else if (provider === "offcloud") {
      let inferredType = null;
      if (itemId && typeof itemId === 'string') {
        const parts = itemId.split(':');
        inferredType = parts.length > 1 ? 'series' : 'movie';
      }
      const resolvedUrl = await OffCloud.resolveStream(debridApiKey, hostUrl, inferredType, itemId);
      if (!resolvedUrl) throw new Error("OffCloud resolve returned empty.");
      return resolvedUrl;
    } else if (provider === "debridlink") {
      return hostUrl;
    } else if (provider === "premiumize") {
        if (hostUrl.startsWith('magnet:')) {
            let episodeHint = null;
            if (hostUrl.includes('||HINT||')) {
                try {
                    const parts = hostUrl.split('||HINT||');
                    hostUrl = parts[0];
                    episodeHint = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
                } catch (_) { episodeHint = null; }
            }

            const directDownload = await Premiumize.getDirectDownloadLink(debridApiKey, hostUrl);
            if (!directDownload) {
                throw new Error("Failed to get direct download link from Premiumize.");
            }

            let videos = [];
            if (directDownload.content && Array.isArray(directDownload.content) && directDownload.content.length > 0) {
                // Multi-file torrent
                videos = directDownload.content
                    .filter(f => isVideo(f.path))
                    .map(f => ({ ...f, name: f.path })); // Normalize name for PTT
            } else if (directDownload.location && isVideo(directDownload.filename)) {
                // Single file torrent
                videos.push({
                    name: directDownload.filename,
                    size: directDownload.filesize,
                    stream_link: directDownload.stream_link || directDownload.location,
                    link: directDownload.location,
                });
            }

            if (videos.length === 0) {
                throw new Error("No video files found in direct download response.");
            }

            let chosenVideo = null;
            if (videos.length > 1 && episodeHint && episodeHint.season && episodeHint.episode) {
                const s = Number(episodeHint.season);
                const e = Number(episodeHint.episode);

                chosenVideo = videos.find(f => {
                    const pttInfo = PTT.parse(f.name);
                    return pttInfo.season === s && pttInfo.episode === e;
                });
            }

            if (!chosenVideo) {
                if (videos.length > 1) {
                    chosenVideo = videos.reduce((a, b) => (a.size > b.size ? a : b));
                } else {
                    chosenVideo = videos[0];
                }
            }

            const streamLink = chosenVideo.stream_link || chosenVideo.link;
            if (!streamLink) {
                throw new Error("No streamable link found for the chosen video file.");
            }

            return streamLink;
        }
        return hostUrl; // for non-magnet links
    } else if (provider === "alldebrid") {
      return AllDebrid.resolveStreamUrl(debridApiKey, hostUrl, clientIp);
    } else if (provider === "torbox") {
      return TorBox.unrestrictUrl(debridApiKey, itemId, hostUrl, clientIp);
    } else {
      throw new Error(`Unsupported debrid provider: ${debridProvider}`);
    }
  } catch (error) {
    console.error(`[RESOLVER] Critical error for ${debridProvider}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return null;
  }
}
