import { fetchAndSearchMetadata } from './metadata-fetcher.js';
import { extractAndValidateLinks } from './link-validator.js';
import { formatStreamsWithFlags } from './stream-formatter.js';
import { extractTvShowDownloadLinks } from '../extraction/tv/links.js';
import { extractDownloadLinks } from '../extraction/movie/links.js';

// Main function to get streams for TMDB content
// REFACTORED: Broken down from ~750 lines to ~80 lines with helper modules
export async function getUHDMoviesStreams(imdbId, tmdbId, mediaType = 'movie', season = null, episode = null, config = {}) {
  console.log(`[UHDMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);

  // Create unique timer IDs to prevent duplicates when concurrent requests for same content
  const requestId = Math.random().toString(36).substring(7);

  try {
    // 1. Fetch metadata from Cinemeta and search UHDMovies
    const { mediaInfo, matchingResult, scoredResults, matchingResults } = await fetchAndSearchMetadata(
      imdbId,
      tmdbId,
      mediaType,
      season,
      requestId
    );

    // Check if we found a match
    if (!matchingResult) {
      console.log(`[UHDMovies] No matching content found.`);
      return [];
    }

    // 2. Extract and validate SID links from the matched page
    const cachedLinks = await extractAndValidateLinks(
      matchingResult,
      matchingResults,
      scoredResults,
      null, // downloadInfo - not needed anymore
      mediaType,
      season,
      episode,
      mediaInfo.year,
      extractTvShowDownloadLinks,
      extractDownloadLinks
    );

    // Check if we have any valid links
    if (!cachedLinks || cachedLinks.length === 0) {
      console.log('[UHDMovies] No valid SID URLs found after validation.');
      return [];
    }

    // 3. Format streams with flags and metadata
    const validStreams = formatStreamsWithFlags(cachedLinks);

    return validStreams;

  } catch (error) {
    console.error(`[UHDMovies] A critical error occurred in getUHDMoviesStreams for ${tmdbId}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return [];
  }
}
