import Cinemeta from '../../util/cinemeta.js';
import { searchMovies, compareMedia, scoreResult } from '../search/movie-search.js';

// Fetch metadata from Cinemeta and search UHDMovies
// REFACTORED: Extracted from getUHDMoviesStreams (~150 lines)
export async function fetchAndSearchMetadata(imdbId, tmdbId, mediaType, season, requestId) {
  const cinemetaTimerId = `[UHDMovies-${requestId}] Cinemeta lookup`;
  const searchTimerId = `[UHDMovies-${requestId}] searchMovies`;

  // Get Cinemeta info to perform search
  // Note: Cinemeta uses 'series' type for TV shows, not 'tv'
  const cinemetaType = mediaType === 'tv' ? 'series' : mediaType;
  console.time(cinemetaTimerId);
  const cinemetaDetails = await Cinemeta.getMeta(cinemetaType, imdbId);
  try { console.timeEnd(cinemetaTimerId); } catch {}

  if (!cinemetaDetails) {
    throw new Error('Could not extract title from Cinemeta response.');
  }

  const mediaInfo = {
    title: cinemetaDetails.name,
    year: parseInt((cinemetaDetails.year || '').split('–')[0], 10)
  };

  if (!mediaInfo.title) {
    throw new Error('Could not extract title from Cinemeta response.');
  }

  console.log(`[UHDMovies] Cinemeta Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);

  // Search for the media on UHDMovies
  let searchTitle = mediaInfo.title.replace(/:/g, '').replace(/\s*&\s*/g, ' and ');
  console.log(`[UHDMovies] Search title: ${searchTitle}`);
  console.time(searchTimerId);
  let searchResults = await searchMovies(searchTitle);
  try { console.timeEnd(searchTimerId); } catch {}
  console.log(`[UHDMovies] Search results:`, searchResults);

  // If no results or only wrong year results, try fallback search with just main title
  if (searchResults.length === 0 || !searchResults.some(result => compareMedia(mediaInfo, result))) {
    console.log(`[UHDMovies] Primary search failed or no matches. Trying fallback search...`);

    // Extract main title (remove subtitles after colon, "and the", etc.)
    let fallbackTitle = mediaInfo.title.split(':')[0].trim();
    if (fallbackTitle.includes('and the')) {
      fallbackTitle = fallbackTitle.split('and the')[0].trim();
    }
    if (fallbackTitle !== searchTitle) {
      console.log(`[UHDMovies] Fallback search with: "${fallbackTitle}"`);
      const fallbackResults = await searchMovies(fallbackTitle);
      if (fallbackResults.length > 0) {
        searchResults = fallbackResults;
      }
    }
  }

  if (searchResults.length === 0) {
    console.log(`[UHDMovies] No search results found for "${mediaInfo.title}".`);
    return { mediaInfo, matchingResult: null, scoredResults: null };
  }

  // Find the best matching result
  const matchingResults = searchResults.filter(result => compareMedia(mediaInfo, result));
  console.log(`[UHDMovies] Matching results:`, matchingResults);

  if (matchingResults.length === 0) {
    console.log(`[UHDMovies] No matching content found for "${mediaInfo.title}" (${mediaInfo.year}).`);
    return { mediaInfo, matchingResult: null, scoredResults: null };
  }

  let matchingResult;
  let scoredResults = null;

  if (matchingResults.length === 1) {
    matchingResult = matchingResults[0];
  } else {
    console.log(`[UHDMovies] Found ${matchingResults.length} matching results. Scoring to find the best...`);

    scoredResults = matchingResults.map(result => {
      const score = scoreResult(result.title, mediaType === 'tv' ? season : null, mediaInfo.title);
      console.log(`  - Score ${score}: ${result.title}`);
      return { ...result, score };
    }).sort((a, b) => b.score - a.score);

    matchingResult = scoredResults[0];
    console.log(`[UHDMovies] Best match selected with score ${matchingResult.score}: "${matchingResult.title}"`);
  }

  console.log(`[UHDMovies] Found matching content: "${matchingResult.title}"`);

  return { mediaInfo, matchingResult, scoredResults, matchingResults };
}
