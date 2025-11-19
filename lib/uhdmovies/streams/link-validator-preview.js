/**
 * Preview Mode Link Validator for UHDMovies
 * Returns links without expensive SID validation (8s per link!)
 * Validation happens on-click via resolveUHDMoviesUrl
 */

/**
 * Extract and return links without validation (preview mode)
 * FAST: No SID resolution, no HTTP validation
 */
export async function extractLinksWithoutValidation(
  matchingResult,
  matchingResults,
  scoredResults,
  downloadInfo,
  mediaType,
  season,
  episode,
  year,
  extractTvShowDownloadLinks,
  extractDownloadLinks
) {
  const extractTimerId = `[UHDMovies-${Math.random().toString(36).substring(7)}] extractDownloadLinks (preview mode)`;

  console.time(extractTimerId);
  let linkData = await (mediaType === 'tv'
    ? extractTvShowDownloadLinks(matchingResult.link, season, episode)
    : extractDownloadLinks(matchingResult.link, year));
  try { console.timeEnd(extractTimerId); } catch {}
  console.log(`[UHDMovies] Download info (preview mode):`, linkData);

  // Check if season was not found or episode extraction failed, and we have multiple results to try
  if (linkData.links.length === 0 && matchingResults.length > 1 && scoredResults &&
      (linkData.seasonNotFound || (mediaType === 'tv' && linkData.title))) {
    console.log(`[UHDMovies] Season ${season} not found or episode extraction failed on best match. Trying next best match...`);

    // Try the next best match
    const nextBestMatch = scoredResults[1];
    console.log(`[UHDMovies] Trying next best match: "${nextBestMatch.title}"`);

    linkData = await (mediaType === 'tv'
      ? extractTvShowDownloadLinks(nextBestMatch.link, season, episode)
      : extractDownloadLinks(nextBestMatch.link, year));

    if (linkData.links.length > 0) {
      console.log(`[UHDMovies] Successfully found links on next best match!`);
    } else {
      console.log(`[UHDMovies] Next best match also failed. No download links found.`);
    }
  }

  if (linkData.links.length === 0) {
    console.log('[UHDMovies] No download links found on page.');
    return [];
  }

  // Return links WITHOUT validation (preview mode)
  console.log(`[UHDMovies] Found ${linkData.links.length} SID links - returning without validation (preview mode)`);

  const maxLinksToReturn = Math.min(10, linkData.links.length);
  const candidateLinks = linkData.links.slice(0, maxLinksToReturn);

  // Transform links to the expected format WITHOUT validation
  const previewLinks = candidateLinks.map(linkInfo => ({
    quality: linkInfo.quality,
    rawQuality: linkInfo.rawQuality,
    url: linkInfo.link,  // Original SID URL
    size: linkInfo.size || 'Unknown',
    languageInfo: linkInfo.languageInfo || [],
    needsResolution: true,
    isPreview: true  // Flag to indicate this is a preview
  }));

  // Deduplicate based on quality and size
  const seen = new Set();
  const originalCount = previewLinks.length;
  const deduped = previewLinks.filter(link => {
    const key = `${link.quality}_${link.size}_${link.rawQuality}`;
    if (seen.has(key)) {
      console.log(`[UHDMovies] Removing duplicate preview: ${link.rawQuality?.substring(0, 60) || link.quality}`);
      return false;
    }
    seen.add(key);
    return true;
  });

  if (originalCount > deduped.length) {
    console.log(`[UHDMovies] Removed ${originalCount - deduped.length} duplicate preview stream(s)`);
  }

  console.log(`[UHDMovies] Returning ${deduped.length} preview links (no validation - instant response!)`);
  return deduped;
}
