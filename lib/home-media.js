import axios from 'axios';
import https from 'https';
import Cinemeta from './util/cinemeta.js';
import PTT from './util/parse-torrent-title.js';
import { getResolutionFromName, formatSize } from './common/torrent-utils.js';
import { processAndDeduplicate } from './common/scrapers.js';

const LOG_PREFIX = 'HM+';

/**
 * Home Media Server integration - search personal media library
 */

/**
 * Search for content on home media server
 * @param {string} homeMediaUrl - Home media server URL
 * @param {string} homeMediaApiKey - API key for authentication
 * @param {string} type - Content type (movie or series)
 * @param {string} id - IMDB ID or series ID
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of search results
 */
async function searchHomeMedia(homeMediaUrl, homeMediaApiKey, type, id, config) {
  try {
    let searchTitle = '';
    let season = null;
    let episode = null;
    let cinemetaDetails = null;

    // Get metadata for search
    if (type === 'movie') {
      cinemetaDetails = await Cinemeta.getMeta(type, id);
      searchTitle = cinemetaDetails.name.toLowerCase();
    } else if (type === 'series') {
      const [imdbId, seasonNum, episodeNum] = id.split(':');
      cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
      searchTitle = cinemetaDetails.name.toLowerCase();
      season = parseInt(seasonNum);
      episode = parseInt(episodeNum);
      console.log(`[${LOG_PREFIX}] Series info: ${cinemetaDetails.name} - Season ${season} Episode ${episode}`);
    }

    console.log(`[${LOG_PREFIX}] Searching home media for: "${searchTitle}"`);

    // Call file server API
    const headers = {};
    if (homeMediaApiKey) {
      headers['X-API-Key'] = homeMediaApiKey;
    }

    const requestConfig = {
      headers,
      timeout: 10000
    };

    // Add HTTPS agent if URL uses HTTPS (allows self-signed certs)
    if (homeMediaUrl.startsWith('https://')) {
      requestConfig.httpsAgent = new https.Agent({
        rejectUnauthorized: false
      });
    }

    const response = await axios.get(`${homeMediaUrl}/api/list`, requestConfig);

    if (!response.data || !response.data.files) {
      console.log(`[${LOG_PREFIX}] No files returned from server`);
      return [];
    }

    const files = response.data.files;
    console.log(`[${LOG_PREFIX}] Found ${files.length} total files on server`);

    // Filter and match files
    let matchedFiles = [];

    for (const file of files) {
      // Skip incomplete files
      if (!file.isComplete) {
        console.log(`[${LOG_PREFIX}] Skipping incomplete file: ${file.name}`);
        continue;
      }

      // Skip sample files
      const lowerName = file.name.toLowerCase();
      if (lowerName.includes('sample') || lowerName.includes('trailer') || file.size < 100 * 1024 * 1024) {
        console.log(`[${LOG_PREFIX}] Skipping sample/small file: ${file.name} (${formatSize(file.size)})`);
        continue;
      }

      // Parse file information
      const parsed = PTT.parse(file.name);
      const folderParsed = PTT.parse(file.folderName || '');

      // Create a combined title check (file name + folder name)
      const fileName = file.name.toLowerCase();
      const folderName = (file.folderName || '').toLowerCase();
      const combinedText = `${fileName} ${folderName}`;

      console.log(`[${LOG_PREFIX}] Checking file: ${file.name}`);
      console.log(`[${LOG_PREFIX}]   Parsed: season=${parsed.season}, episode=${parsed.episode}`);
      console.log(`[${LOG_PREFIX}]   Folder: ${file.folderName}, folderParsed: season=${folderParsed.season}`);

      // Check if this file matches our search
      let isMatch = false;
      let matchScore = 0;

      if (type === 'movie') {
        // For movies, check if title appears in file or folder
        const titleWords = searchTitle.split(/\s+/).filter(w => w.length > 2);
        const matchedWords = titleWords.filter(word => combinedText.includes(word));
        matchScore = matchedWords.length / titleWords.length;

        console.log(`[${LOG_PREFIX}]   Title match score: ${matchScore.toFixed(2)} (${matchedWords.length}/${titleWords.length} words)`);

        // Require at least 60% of words to match for movies (was 50%)
        if (matchScore < 0.6) {
          continue;
        }

        // Check year if available - very important for movies!
        if (cinemetaDetails.year) {
          const fileYear = parsed.year || folderParsed.year;

          if (fileYear) {
            const yearDiff = Math.abs(fileYear - cinemetaDetails.year);
            console.log(`[${LOG_PREFIX}]   Year check: file=${fileYear}, expected=${cinemetaDetails.year}, diff=${yearDiff}`);

            if (yearDiff <= 1) {
              matchScore += 0.5; // Strong bonus for matching year
              isMatch = true;
            } else {
              // Wrong year = not a match, even if title is similar
              console.log(`[${LOG_PREFIX}]   ✗ Skipping due to year mismatch`);
              continue;
            }
          } else {
            // No year in filename - only match if title match is very strong (80%+)
            console.log(`[${LOG_PREFIX}]   No year in filename, requiring 80%+ title match`);
            isMatch = matchScore >= 0.8;
          }
        } else {
          // No year available from Cinemeta - use title match only
          isMatch = matchScore >= 0.7;
        }
      } else if (type === 'series') {
        // For series, need to match title AND episode
        const titleWords = searchTitle.split(/\s+/).filter(w => w.length > 2);
        const matchedWords = titleWords.filter(word => combinedText.includes(word));
        const titleMatchScore = matchedWords.length / titleWords.length;

        console.log(`[${LOG_PREFIX}]   Title match score: ${titleMatchScore.toFixed(2)} (${matchedWords.length}/${titleWords.length} words)`);

        // Check episode match
        const fileHasSeason = parsed.season !== undefined || folderParsed.season !== undefined;
        const fileHasEpisode = parsed.episode !== undefined;

        console.log(`[${LOG_PREFIX}]   Has season: ${fileHasSeason}, Has episode: ${fileHasEpisode}`);

        if (titleMatchScore > 0.4 && fileHasSeason && fileHasEpisode) {
          // Use folder season if file doesn't have it (season pack case)
          const fileSeason = parsed.season !== undefined ? parsed.season : folderParsed.season;
          const fileEpisode = parsed.episode;

          console.log(`[${LOG_PREFIX}]   Looking for S${season}E${episode}, file has S${fileSeason}E${fileEpisode}`);

          if (fileSeason === season && fileEpisode === episode) {
            isMatch = true;
            matchScore = titleMatchScore + 1.0; // Bonus for exact episode match
            console.log(`[${LOG_PREFIX}]   ✓ MATCH FOUND!`);
          }
        }
      }

      if (isMatch) {
        // Build a proper title
        let displayTitle = file.name;

        // Check if filename looks like a hash (mostly alphanumeric, no spaces, < 32 chars)
        // If so, use folder name instead for better display
        const fileNameWithoutExt = file.name.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|m2ts)$/i, '');
        const looksLikeHash = /^[a-zA-Z0-9]{8,32}$/.test(fileNameWithoutExt);

        if (looksLikeHash && file.folderName) {
          console.log(`[${LOG_PREFIX}] Using folder name instead of hash filename: "${file.folderName}" (was: "${fileNameWithoutExt}")`);
          displayTitle = file.folderName;
        } else if (type === 'series' && folderParsed.season !== undefined && parsed.season === undefined) {
          // Season pack case - add season info to title
          displayTitle = `${file.folderName} - ${file.name}`;
        }

        matchedFiles.push({
          title: displayTitle,
          size: file.size,
          fileName: file.name,
          filePath: file.path,
          flatPath: file.flatPath,
          folderName: file.folderName,
          matchScore: matchScore,
          resolution: getResolutionFromName(file.name),
          parsed: parsed
        });
      }
    }

    console.log(`[${LOG_PREFIX}] Matched ${matchedFiles.length} files after filtering`);

    if (matchedFiles.length === 0) {
      return [];
    }

    // Apply junk filtering (same as other services)
    const resultsForFiltering = matchedFiles.map(f => ({
      Title: f.title,
      InfoHash: f.flatPath, // Use path as unique identifier
      Size: f.size,
      Seeders: null,
      Tracker: 'HomeMedia'
    }));

    const filteredFormatted = processAndDeduplicate(resultsForFiltering, config);

    // Map back to original format
    const titleToOriginal = new Map(matchedFiles.map(f => [f.title, f]));
    let filteredResults = filteredFormatted
      .map(f => titleToOriginal.get(f.Title))
      .filter(Boolean);

    console.log(`[${LOG_PREFIX}] Filtered ${matchedFiles.length} -> ${filteredResults.length} results (junk filtering applied)`);

    // Sort by match score and quality
    filteredResults.sort((a, b) => {
      // First by match score
      if (Math.abs(a.matchScore - b.matchScore) > 0.1) {
        return b.matchScore - a.matchScore;
      }
      // Then by resolution
      const resolutionOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
      const rankA = resolutionOrder[a.resolution] || 0;
      const rankB = resolutionOrder[b.resolution] || 0;
      if (rankA !== rankB) return rankB - rankA;
      // Finally by size
      return b.size - a.size;
    });

    return filteredResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Search error:`, error.message);
    return [];
  }
}

/**
 * Get stream URL for a file
 * @param {string} homeMediaUrl - Home media server URL
 * @param {string} homeMediaApiKey - API key for authentication
 * @param {string} filePath - Path to file (can be flatPath or full path)
 * @returns {string} - Stream URL
 */
function getStreamUrl(homeMediaUrl, homeMediaApiKey, filePath) {
  // Use flatPath (just filename) for simpler URLs
  const urlPath = encodeURIComponent(filePath);
  const baseUrl = `${homeMediaUrl}/${urlPath}`;

  if (homeMediaApiKey) {
    return `${baseUrl}?key=${encodeURIComponent(homeMediaApiKey)}`;
  }

  return baseUrl;
}

export default {
  searchHomeMedia,
  getStreamUrl
};
