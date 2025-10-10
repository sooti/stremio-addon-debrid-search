import axios from 'axios';
import FormData from 'form-data';

const LOG_PREFIX = 'SABNZBD';

/**
 * SABnzbd API integration for Usenet downloads
 * Implements SABnzbd API for submitting NZBs and monitoring downloads
 */

/**
 * Add NZB to SABnzbd queue
 * @param {string} serverUrl - SABnzbd server URL (e.g., http://localhost:8080)
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzbContent - NZB file content as string
 * @param {string} name - Name for the download
 * @returns {Promise<object>} - Response with NZO ID
 */
async function addNzb(serverUrl, apiKey, nzbContent, name) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    // Create form data with NZB file
    const form = new FormData();
    form.append('mode', 'addfile');
    form.append('output', 'json');
    form.append('apikey', apiKey);
    form.append('name', Buffer.from(nzbContent), {
      filename: `${name}.nzb`,
      contentType: 'application/x-nzb'
    });

    const response = await axios.post(`${baseUrl}/api`, form, {
      headers: {
        ...form.getHeaders(),
        'User-Agent': 'Sootio/1.0'
      },
      timeout: 30000
    });

    if (response.data?.status === false) {
      throw new Error(response.data?.error || 'Failed to add NZB');
    }

    const nzoId = response.data?.nzo_ids?.[0];
    if (!nzoId) {
      throw new Error('No NZO ID returned from SABnzbd');
    }

    console.log(`[${LOG_PREFIX}] Added NZB to queue: ${nzoId}`);
    return {
      success: true,
      nzoId: nzoId,
      name: name
    };

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error adding NZB:`, error.message);
    throw error;
  }
}

/**
 * Normalize SABnzbd URL to ensure it has protocol
 */
function normalizeUrl(serverUrl) {
  let url = serverUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }
  return url.replace(/\/$/, '');
}

/**
 * Add NZB by URL
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzbUrl - URL to NZB file
 * @param {string} name - Name for the download
 * @returns {Promise<object>} - Response with NZO ID
 */
async function addNzbByUrl(serverUrl, apiKey, nzbUrl, name) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'addurl',
      name: nzbUrl,
      output: 'json',
      apikey: apiKey,
      nzbname: name
    });

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    if (response.data?.status === false) {
      throw new Error(response.data?.error || 'Failed to add NZB URL');
    }

    const nzoId = response.data?.nzo_ids?.[0];
    if (!nzoId) {
      throw new Error('No NZO ID returned from SABnzbd');
    }

    console.log(`[${LOG_PREFIX}] Added NZB URL to queue: ${nzoId}`);
    return {
      success: true,
      nzoId: nzoId,
      name: name
    };

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error adding NZB URL:`, error.message);
    throw error;
  }
}

/**
 * Get download queue status
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - Optional NZO ID to get specific item
 * @returns {Promise<object>} - Queue status
 */
async function getQueue(serverUrl, apiKey, nzoId = null) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'queue',
      output: 'json',
      apikey: apiKey
    });

    if (nzoId) {
      params.append('nzo_ids', nzoId);
    }

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    return response.data?.queue || null;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting queue:`, error.message);
    return null;
  }
}

/**
 * Get history (completed downloads)
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - Optional NZO ID to get specific item
 * @returns {Promise<object>} - History data
 */
async function getHistory(serverUrl, apiKey, nzoId = null) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'history',
      output: 'json',
      apikey: apiKey
    });

    if (nzoId) {
      params.append('nzo_ids', nzoId);
    }

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    return response.data?.history || null;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting history:`, error.message);
    return null;
  }
}

/**
 * Get download status for a specific NZO
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to check
 * @returns {Promise<object>} - Download status
 */
async function getDownloadStatus(serverUrl, apiKey, nzoId) {
  try {
    // First check queue
    const queue = await getQueue(serverUrl, apiKey, nzoId);
    if (queue?.slots) {
      const slot = queue.slots.find(s => s.nzo_id === nzoId);
      if (slot) {
        // Get files info for the download
        const files = slot.files || [];

        // Parse percentage - SABnzbd returns it as a string like "45.2"
        let percentComplete = 0;
        if (slot.percentage !== undefined && slot.percentage !== null && slot.percentage !== '') {
          percentComplete = parseFloat(slot.percentage);
          if (isNaN(percentComplete)) {
            console.log(`[${LOG_PREFIX}] Warning: Invalid percentage value for ${nzoId}: "${slot.percentage}"`);
            percentComplete = 0;
          }
        } else {
          console.log(`[${LOG_PREFIX}] No percentage field for ${nzoId}, status: ${slot.status}, mb: ${slot.mb}, size: ${slot.size}`);
        }

        // Determine actual status - could be Paused, Downloading, Extracting, etc.
        let actualStatus = 'downloading';
        if (slot.status) {
          const statusLower = slot.status.toLowerCase();
          if (statusLower === 'paused') {
            actualStatus = 'Paused';
          } else if (statusLower.includes('extract')) {
            actualStatus = 'extracting';
          } else if (statusLower.includes('verif')) {
            actualStatus = 'verifying';
          }
        }

        return {
          status: actualStatus,
          nzoId: nzoId,
          name: slot.filename,
          percentComplete: percentComplete,
          bytesDownloaded: parseFloat(slot.mb) * 1024 * 1024 || 0,
          bytesTotal: parseFloat(slot.size) * 1024 * 1024 || 0,
          timeLeft: slot.timeleft || '0:00:00',
          eta: slot.eta || 'unknown',
          path: null,
          incompletePath: slot.storage || null, // Path to incomplete folder
          files: files,
          rawStatus: slot.status // Include raw status for debugging
        };
      }
    }

    // Check history for completed downloads
    const history = await getHistory(serverUrl, apiKey, nzoId);
    if (history?.slots) {
      const slot = history.slots.find(s => s.nzo_id === nzoId);
      if (slot) {
        // SABnzbd uses 'storage' for the final location, 'path' for incomplete
        // For completed downloads, use storage first (final location), fallback to path
        const actualPath = slot.storage || slot.path;
        return {
          status: slot.status === 'Completed' ? 'completed' : 'failed',
          nzoId: nzoId,
          name: slot.name,
          percentComplete: 100,
          bytesDownloaded: parseFloat(slot.bytes) || 0,
          bytesTotal: parseFloat(slot.bytes) || 0,
          path: actualPath,
          failMessage: slot.fail_message || null
        };
      }
    }

    return {
      status: 'notfound',
      nzoId: nzoId
    };

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting download status:`, error.message);
    return {
      status: 'error',
      nzoId: nzoId,
      error: error.message
    };
  }
}

/**
 * Get SABnzbd configuration including directory paths
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @returns {Promise<object>} - Configuration including download_dir and incomplete_dir
 */
async function getConfig(serverUrl, apiKey) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'get_config',
      output: 'json',
      apikey: apiKey
    });

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    const config = response.data?.config;
    if (config) {
      return {
        downloadDir: config.misc?.complete_dir || config.misc?.download_dir,
        incompleteDir: config.misc?.download_dir
      };
    }

    return null;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting config:`, error.message);
    return null;
  }
}

/**
 * Get list of video files from completed download
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} path - Path to completed download folder
 * @returns {Promise<Array>} - List of video files
 */
async function getVideoFiles(serverUrl, apiKey, path) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'get_files',
      output: 'json',
      apikey: apiKey,
      value: path
    });

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    const files = response.data?.files || [];

    // Filter for video files
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts'];
    const videoFiles = files.filter(file => {
      const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
      return videoExtensions.includes(ext);
    });

    console.log(`[${LOG_PREFIX}] Found ${videoFiles.length} video files in ${path}`);
    return videoFiles;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting video files:`, error.message);
    return [];
  }
}

/**
 * Delete item from queue or history
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to delete
 * @param {boolean} deleteFiles - Whether to delete downloaded files
 * @returns {Promise<boolean>} - Success status
 */
async function deleteItem(serverUrl, apiKey, nzoId, deleteFiles = false) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'queue',
      name: 'delete',
      output: 'json',
      apikey: apiKey,
      value: nzoId,
      del_files: deleteFiles ? '1' : '0'
    });

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    console.log(`[${LOG_PREFIX}] Deleted item: ${nzoId}`);
    return response.data?.status !== false;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error deleting item:`, error.message);
    return false;
  }
}

/**
 * Find existing download by name in queue or history
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} name - Download name to search for
 * @returns {Promise<object|null>} - Download info if found, null otherwise
 */
async function findDownloadByName(serverUrl, apiKey, name) {
  try {
    // Check queue first
    const queue = await getQueue(serverUrl, apiKey);
    if (queue?.slots) {
      const queueItem = queue.slots.find(s => s.filename === name || s.filename.includes(name));
      if (queueItem) {
        console.log(`[${LOG_PREFIX}] Found download in queue: ${queueItem.nzo_id}`);
        return {
          nzoId: queueItem.nzo_id,
          name: queueItem.filename,
          status: 'downloading',
          percentComplete: parseFloat(queueItem.percentage) || 0,
          location: 'queue'
        };
      }
    }

    // Check history
    const history = await getHistory(serverUrl, apiKey);
    if (history?.slots) {
      const historyItem = history.slots.find(s => s.name === name || s.name.includes(name));
      if (historyItem) {
        console.log(`[${LOG_PREFIX}] Found download in history: ${historyItem.nzo_id}`);
        return {
          nzoId: historyItem.nzo_id,
          name: historyItem.name,
          status: historyItem.status === 'Completed' ? 'completed' : 'failed',
          percentComplete: 100,
          path: historyItem.storage,
          location: 'history'
        };
      }
    }

    return null;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error finding download:`, error.message);
    return null;
  }
}

/**
 * Get disk space information
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @returns {Promise<object>} - Disk space info
 */
async function getDiskSpace(serverUrl, apiKey) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'queue',
      output: 'json',
      apikey: apiKey
    });

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    const queue = response.data?.queue;
    if (queue) {
      const diskspace1 = queue.diskspace1 || '0 GB'; // Complete dir space
      const diskspace2 = queue.diskspace2 || '0 GB'; // Incomplete dir space

      // Parse the diskspace strings (e.g., "123.45 GB" -> bytes)
      const parseSpace = (str) => {
        const match = str.match(/([\d.]+)\s*(\w+)?/);
        if (!match) return 0;
        const value = parseFloat(match[1]);
        const unit = match[2] ? match[2].toUpperCase() : 'GB'; // Default to GB if no unit
        const multipliers = {
          'B': 1,
          'KB': 1024,
          'MB': 1024 * 1024,
          'GB': 1024 * 1024 * 1024,
          'TB': 1024 * 1024 * 1024 * 1024
        };
        return value * (multipliers[unit] || 1);
      };

      const completeSpaceBytes = parseSpace(diskspace1);
      const incompleteSpaceBytes = parseSpace(diskspace2);

      return {
        completeDir: {
          available: diskspace1,
          availableBytes: completeSpaceBytes,
          lowSpace: completeSpaceBytes < 10 * 1024 * 1024 * 1024 // Less than 10GB
        },
        incompleteDir: {
          available: diskspace2,
          availableBytes: incompleteSpaceBytes,
          lowSpace: incompleteSpaceBytes < 10 * 1024 * 1024 * 1024 // Less than 10GB
        }
      };
    }

    return null;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error getting disk space:`, error.message);
    return null;
  }
}

/**
 * Pause all downloads except a specific one
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} exceptNzoId - NZO ID to keep running (optional)
 * @returns {Promise<number>} - Number of downloads paused
 */
async function pauseAllExcept(serverUrl, apiKey, exceptNzoId = null) {
  try {
    const baseUrl = normalizeUrl(serverUrl);
    const queue = await getQueue(serverUrl, apiKey);

    if (!queue?.slots) {
      return 0;
    }

    let pausedCount = 0;

    for (const slot of queue.slots) {
      if (slot.nzo_id === exceptNzoId) {
        continue; // Skip the one we want to keep running
      }

      if (slot.status !== 'Paused') {
        const params = new URLSearchParams({
          mode: 'queue',
          name: 'pause',
          output: 'json',
          apikey: apiKey,
          value: slot.nzo_id
        });

        await axios.get(`${baseUrl}/api?${params.toString()}`, {
          timeout: 10000,
          headers: { 'User-Agent': 'Sootio/1.0' }
        });

        pausedCount++;
        console.log(`[${LOG_PREFIX}] Paused download: ${slot.filename}`);
      }
    }

    return pausedCount;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error pausing downloads:`, error.message);
    return 0;
  }
}

/**
 * Delete all downloads except one
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} exceptNzoId - NZO ID to keep (optional)
 * @param {boolean} deleteFiles - Whether to delete downloaded files
 * @returns {Promise<number>} - Number of downloads deleted
 */
async function deleteAllExcept(serverUrl, apiKey, exceptNzoId = null, deleteFiles = true) {
  try {
    const baseUrl = normalizeUrl(serverUrl);
    const queue = await getQueue(serverUrl, apiKey);

    if (!queue?.slots) {
      return 0;
    }

    let deletedCount = 0;

    for (const slot of queue.slots) {
      if (slot.nzo_id === exceptNzoId) {
        continue; // Skip the one we want to keep
      }

      // Delete the download
      const params = new URLSearchParams({
        mode: 'queue',
        name: 'delete',
        output: 'json',
        apikey: apiKey,
        value: slot.nzo_id,
        del_files: deleteFiles ? '1' : '0'
      });

      await axios.get(`${baseUrl}/api?${params.toString()}`, {
        timeout: 10000,
        headers: { 'User-Agent': 'Sootio/1.0' }
      });

      deletedCount++;
      console.log(`[${LOG_PREFIX}] Deleted download: ${slot.filename} (${slot.nzo_id})`);
    }

    return deletedCount;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error deleting downloads:`, error.message);
    return 0;
  }
}

/**
 * Pause a specific download
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to pause
 * @returns {Promise<boolean>} - Success status
 */
async function pauseDownload(serverUrl, apiKey, nzoId) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'queue',
      name: 'pause',
      output: 'json',
      apikey: apiKey,
      value: nzoId
    });

    await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Sootio/1.0' }
    });

    console.log(`[${LOG_PREFIX}] Paused download: ${nzoId}`);
    return true;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error pausing download:`, error.message);
    return false;
  }
}

/**
 * Resume a paused download
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to resume
 * @returns {Promise<boolean>} - Success status
 */
async function resumeDownload(serverUrl, apiKey, nzoId) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'queue',
      name: 'resume',
      output: 'json',
      apikey: apiKey,
      value: nzoId
    });

    await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Sootio/1.0' }
    });

    console.log(`[${LOG_PREFIX}] Resumed download: ${nzoId}`);
    return true;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error resuming download:`, error.message);
    return false;
  }
}

/**
 * Move download to top of queue
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to prioritize
 * @returns {Promise<boolean>} - Success status
 */
async function moveToTop(serverUrl, apiKey, nzoId) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'queue',
      name: 'priority',
      output: 'json',
      apikey: apiKey,
      value: nzoId,
      value2: '-100' // Top priority
    });

    await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Sootio/1.0' }
    });

    console.log(`[${LOG_PREFIX}] Moved to top priority: ${nzoId}`);
    return true;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error setting priority:`, error.message);
    return false;
  }
}

/**
 * Prioritize a download: move it to top and pause all others
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @param {string} nzoId - NZO ID to prioritize
 * @returns {Promise<object>} - Status with number of paused downloads
 */
async function prioritizeDownload(serverUrl, apiKey, nzoId) {
  try {
    console.log(`[${LOG_PREFIX}] Prioritizing download: ${nzoId}`);

    // First, resume this download if it's paused
    await resumeDownload(serverUrl, apiKey, nzoId);

    // Move to top of queue
    await moveToTop(serverUrl, apiKey, nzoId);

    // Pause all other downloads
    const pausedCount = await pauseAllExcept(serverUrl, apiKey, nzoId);

    console.log(`[${LOG_PREFIX}] Prioritized ${nzoId}, paused ${pausedCount} other downloads`);

    return {
      success: true,
      prioritizedNzoId: nzoId,
      pausedCount: pausedCount
    };
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error prioritizing download:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Test SABnzbd connection and API key
 * @param {string} serverUrl - SABnzbd server URL
 * @param {string} apiKey - SABnzbd API key
 * @returns {Promise<boolean>} - True if connection is successful
 */
async function testConnection(serverUrl, apiKey) {
  try {
    const baseUrl = normalizeUrl(serverUrl);

    const params = new URLSearchParams({
      mode: 'version',
      output: 'json',
      apikey: apiKey
    });

    const response = await axios.get(`${baseUrl}/api?${params.toString()}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Sootio/1.0'
      }
    });

    const version = response.data?.version;
    if (version) {
      console.log(`[${LOG_PREFIX}] Connected to SABnzbd version: ${version}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Connection test failed:`, error.message);
    return false;
  }
}

export default {
  addNzb,
  addNzbByUrl,
  getQueue,
  getHistory,
  getDownloadStatus,
  getVideoFiles,
  getConfig,
  deleteItem,
  deleteAllExcept,
  findDownloadByName,
  getDiskSpace,
  pauseAllExcept,
  pauseDownload,
  resumeDownload,
  moveToTop,
  prioritizeDownload,
  testConnection
};
