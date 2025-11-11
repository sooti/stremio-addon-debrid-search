import * as cheerio from 'cheerio';
import { makeRequest } from '../utils/http.js';

// Validate and filter SID links
// REFACTORED: Extracted from getUHDMoviesStreams (~300 lines)
export async function extractAndValidateLinks(matchingResult, matchingResults, scoredResults, downloadInfo, mediaType, season, episode, year, extractTvShowDownloadLinks, extractDownloadLinks) {
  const extractTimerId = `[UHDMovies-${Math.random().toString(36).substring(7)}] extractDownloadLinks`;

  console.time(extractTimerId);
  let linkData = await (mediaType === 'tv' ? extractTvShowDownloadLinks(matchingResult.link, season, episode) : extractDownloadLinks(matchingResult.link, year));
  try { console.timeEnd(extractTimerId); } catch {}
  console.log(`[UHDMovies] Download info:`, linkData);

  // Check if season was not found or episode extraction failed, and we have multiple results to try
  if (linkData.links.length === 0 && matchingResults.length > 1 && scoredResults &&
      (linkData.seasonNotFound || (mediaType === 'tv' && linkData.title))) {
    console.log(`[UHDMovies] Season ${season} not found or episode extraction failed on best match. Trying next best match...`);

    // Try the next best match
    const nextBestMatch = scoredResults[1];
    console.log(`[UHDMovies] Trying next best match: "${nextBestMatch.title}"`);

    linkData = await (mediaType === 'tv' ? extractTvShowDownloadLinks(nextBestMatch.link, season, episode) : extractDownloadLinks(nextBestMatch.link, year));

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

  // Validate SID links
  console.log(`[UHDMovies] Found ${linkData.links.length} SID links - validating before storing`);

  const maxLinksToProcess = Math.min(10, linkData.links.length);
  const candidateLinks = linkData.links.slice(0, maxLinksToProcess);
  let cachedLinks = [];

  // Validate each SID URL individually to filter out dead links
  // Process in parallel with timeout to keep scraping fast
  if (candidateLinks.length > 0) {
    console.log(`[UHDMovies] Validating ${candidateLinks.length} SID URLs to filter out dead links...`);

    const VALIDATION_TIMEOUT = 8000; // 8 seconds per SID validation
    const validatedLinks = [];

    // Validate all links in parallel
    const validationPromises = candidateLinks.map(async (linkInfo) => {
      if (!linkInfo.link) return null;

      try {
        // Import resolveSidToDriveleech dynamically to avoid circular dependencies
        const { resolveSidToDriveleech } = await import('../resolvers/sid-resolver.js');

        // Race the validation against a timeout
        const validationPromise = resolveSidToDriveleech(linkInfo.link);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Validation timeout')), VALIDATION_TIMEOUT)
        );

        const driveleechUrl = await Promise.race([validationPromise, timeoutPromise]);

        // Check if it resolves to a dead/invalid/category URL
        // Be more specific: category URLs typically point to directories, while file URLs point to specific files
        const invalidPatterns = [
          'uhdmovies.eu/4k-hdr/',
          'uhdmovies.rip/4k-hdr/',
          'uhdmovies.eu/movies/',
          'uhdmovies.rip/movies/',
          'uhdmovies.eu/1080p-uhd/',
          'uhdmovies.rip/1080p-uhd/',
          'uhdmovies.eu/1080p-60fps/',
          'uhdmovies.rip/1080p-60fps/',
          'uhdmovies.eu/1080p-10bit/',
          'uhdmovies.rip/1080p-10bit/',
          'uhdmovies.eu/2160p-movies/',
          'uhdmovies.rip/2160p-movies/',
          'uhdmovies.eu/3d-movies/',
          'uhdmovies.rip/3d-movies/'
        ];

        // Check if URL ends with / which typically indicates a category/directory page
        // Exception: zfile URLs which are valid file URLs that end with /
        const isCategoryPage = (!driveleechUrl.includes('/zfile/') && driveleechUrl.endsWith('/')) ||
                             invalidPatterns.some(pattern => driveleechUrl.includes(pattern));

        const isInvalid = !driveleechUrl ||
                         driveleechUrl === linkInfo.link ||
                         isCategoryPage;

        if (isInvalid) {
          console.log(`[UHDMovies] ❌ SID resolved to invalid/category URL: ${driveleechUrl?.substring(0, 50) || 'null'}, skipping`);
          return null;
        }

        // Additionally validate that the resolved driveleech URL itself is not dead
        // by checking if it redirects to a valid file page
        try {
          // Follow redirects to get to the actual file page - allow more redirects
          const driveleechValidation = await makeRequest(driveleechUrl, {
            maxRedirects: 8, // Allow more redirects to reach file page
            timeout: 8000 // Slightly longer timeout for complex redirects
          });

          // Check if final page is a valid file page by looking for expected elements
          if (driveleechValidation && driveleechValidation.data) {
            const $test = cheerio.load(driveleechValidation.data);

            // Check for common elements in valid file pages on final redirected page
            // Specifically look for zfile/ links which are the valid cloud resume links
            const hasFileElements = $test('li.list-group-item:contains("Size")').length > 0 ||
                                   $test('a[href*="workers.dev"]').length > 0 ||
                                   $test('a[href*="googleusercontent"]').length > 0 ||
                                   $test('a:contains("Resume Cloud")').length > 0 ||
                                   $test('a:contains("Cloud Resume Download")').length > 0 ||
                                   $test('a:contains("Instant Download")').length > 0 ||
                                   $test('a:contains("Resume Worker Bot")').length > 0 ||
                                   $test('a.btn-success:contains("Download")').length > 0 ||
                                   $test('a.btn-warning:contains("Resume")').length > 0 ||
                                   // Most importantly, look for zfile links which are the valid cloud resume links
                                   $test('a[href*="/zfile/"]').length > 0 ||
                                   driveleechValidation.data.includes('video-downloads.googleusercontent') ||
                                   driveleechValidation.data.includes('/zfile/') ||
                                   driveleechValidation.data.includes('Resume Cloud') ||
                                   driveleechValidation.data.includes('Cloud Resume') ||
                                   driveleechValidation.data.includes('Instant Download') ||
                                   driveleechValidation.data.includes('Resume Worker Bot') ||
                                   driveleechValidation.data.includes('downloadBtn') ||
                                   // Check for JavaScript redirects which indicate valid links
                                   driveleechValidation.data.includes('window.location.replace') ||
                                   driveleechValidation.data.includes('window.location.href') ||
                                   driveleechValidation.data.includes('/file/');

            // Enhanced validation: specifically check for zfile links which are the gold standard
            const hasZfileLinks = $test('a[href*="/zfile/"]').length > 0 ||
                                 driveleechValidation.data.includes('/zfile/') ||
                                 // Look for the specific pattern in JavaScript redirects
                                 (driveleechValidation.data.includes('window.location.replace') &&
                                  driveleechValidation.data.includes('/file/'));

            if (!hasFileElements) {
              console.log(`[UHDMovies] ❌ Resolved driveleech URL appears to be dead/invalid page: ${driveleechUrl.substring(0, 100)}..., skipping`);
              console.log(`[UHDMovies]     Final redirected URL: ${driveleechValidation.request.res.responseUrl || 'unknown'}`);
              console.log(`[UHDMovies]     Page content snippet: ${driveleechValidation.data.substring(0, 500)}`);
              return null;
            } else {
              console.log(`[UHDMovies] ✅ Valid file page detected for: ${driveleechUrl.substring(0, 100)}...`);
              // If we found zfile links, this is especially good
              if (hasZfileLinks) {
                console.log(`[UHDMovies] 🎯 High-quality zfile link detected, prioritizing this result`);
              }
            }
          }
        } catch (validationError) {
          // If DNS resolution fails, but the SID link itself resolved correctly to a driveleech URL,
          // we should still consider it potentially valid since the issue might be temporary
          const errorMessage = validationError.message.toLowerCase();
          if (errorMessage.includes('enotfound') || errorMessage.includes('dns')) {
            console.log(`[UHDMovies] ⚠️ DNS resolution failed for driveleech URL: ${validationError.message}, but SID resolution was successful. Considering as potentially valid.`);
            console.log(`[UHDMovies] ✅ Accepting driveleech URL despite DNS issues: ${driveleechUrl.substring(0, 100)}...`);
            // Still consider it valid since SID resolution succeeded
          } else {
            console.log(`[UHDMovies] ❌ Driveleech URL validation failed: ${validationError.message}, skipping`);
            return null;
          }
        }

        console.log(`[UHDMovies] ✅ SID validated: ${linkInfo.rawQuality?.substring(0, 60) || linkInfo.quality}`);
        return {
          quality: linkInfo.quality,
          rawQuality: linkInfo.rawQuality,
          url: linkInfo.link,  // Original SID URL, not resolved!
          size: linkInfo.size || 'Unknown',
          languageInfo: linkInfo.languageInfo || [], // Include language info from page content
          needsResolution: true
        };
      } catch (validationError) {
        console.log(`[UHDMovies] ❌ SID validation failed: ${validationError.message}, skipping`);
        return null;
      }
    });

    // Wait for all validations to complete
    const results = await Promise.all(validationPromises);
    cachedLinks = results.filter(Boolean);

    console.log(`[UHDMovies] Validation complete: ${cachedLinks.length}/${candidateLinks.length} links are valid`);

    // Deduplicate streams based on quality and size (keep first occurrence)
    const seen = new Set();
    const originalCount = cachedLinks.length;
    cachedLinks = cachedLinks.filter(link => {
      const key = `${link.quality}_${link.size}_${link.rawQuality}`;
      if (seen.has(key)) {
        console.log(`[UHDMovies] Removing duplicate: ${link.rawQuality?.substring(0, 60) || link.quality}`);
        return false;
      }
      seen.add(key);
      return true;
    });

    if (originalCount > cachedLinks.length) {
      console.log(`[UHDMovies] Removed ${originalCount - cachedLinks.length} duplicate stream(s)`);
    }
  } else {
    cachedLinks = [];
  }

  return cachedLinks;
}
