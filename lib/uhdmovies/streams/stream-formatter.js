import { getResolutionFromName } from '../../common/torrent-utils.js';
import { STREAM_NAME_MAP } from '../../stream-provider.js';
import { extractCodecs } from '../utils/quality.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../util/language-mapping.js';
import { parseSize } from '../search/movie-search.js';

// Format streams with flags and metadata
// REFACTORED: Extracted from getUHDMoviesStreams (~150 lines)
export function formatStreamsWithFlags(cachedLinks) {
  if (!cachedLinks || cachedLinks.length === 0) {
    console.log('[UHDMovies] No SID URLs found after scraping/cache check.');
    return [];
  }

  // Process cached streams (they contain original SID URLs for lazy resolution)
  console.log(`[UHDMovies] Processing ${cachedLinks.length} cached stream(s) with SID URLs for lazy resolution`);

  const streams = cachedLinks.map((streamInfo) => {
    try {
      // Streams contain original SID URLs (not resolved - lazy resolution)
      if (!streamInfo.url) {
        console.log(`[UHDMovies] Stream has no URL, skipping`);
        return null;
      }

      const rawQuality = streamInfo.rawQuality || '';
      const codecs = extractCodecs(rawQuality);
      const cleanQuality = streamInfo.quality || 'Unknown';
      const size = streamInfo.size || 'Unknown';

      const resolution = getResolutionFromName(cleanQuality);
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
        resolutionLabel = resolution; // fallback for other values
      }

      const name = `${STREAM_NAME_MAP.httpstreaming}\n${resolutionLabel || 'N/A'}`;

      // Extract languages from quality/title string using centralized language mapping
      const detectedLanguages = detectLanguagesFromTitle(rawQuality);

      // Add languages detected from page content (if any)
      let combinedLanguages = [...detectedLanguages];
      if (streamInfo.languageInfo && Array.isArray(streamInfo.languageInfo) && streamInfo.languageInfo.length > 0) {
        // Merge page-detected languages with filename-detected languages
        combinedLanguages = [...new Set([...combinedLanguages, ...streamInfo.languageInfo])];
      }

      // Convert detected language keys to their flag representations
      const flagsSuffix = renderLanguageFlags(combinedLanguages);

      // Use rawQuality (full filename) instead of cleanQuality (parsed quality)
      const title = `${rawQuality}${flagsSuffix}\n💾 ${size} | UHDMovies`;

      return {
        name: name,
        title: title,
        url: streamInfo.url,  // Original SID URL (will be resolved on-demand)
        quality: streamInfo.quality,
        size: size,
        fullTitle: rawQuality,
        resolution: resolution,
        codecs: codecs,
        needsResolution: streamInfo.needsResolution,  // Flag for lazy resolution
        behaviorHints: { bingeGroup: `uhdmovies-${streamInfo.quality}` }
      };
    } catch (error) {
      console.error(`[UHDMovies] Error formatting stream: ${error.message}`);
      return null;
    }
  }).filter(Boolean);

  // Filter out streams with "Unknown Quality" - these are unparseable links with no metadata
  const validStreams = streams.filter(stream => {
    const isUnknown = stream.quality === 'Unknown Quality' ||
                      stream.fullTitle === 'Unknown Quality' ||
                      stream.size === 'Unknown';
    if (isUnknown) {
      console.log(`[UHDMovies] Filtering out unknown quality stream`);
      return false;
    }
    return true;
  });

  console.log(`[UHDMovies] Formatted ${validStreams.length} stream(s) (filtered ${streams.length - validStreams.length} unknown quality streams)`);
  console.log(`[UHDMovies] Final streams before sorting:`, validStreams);
  console.log(`[UHDMovies] Successfully processed ${validStreams.length} final stream links.`);

  // Sort by resolution first, then by size within each resolution group
  validStreams.sort((a, b) => {
    // Map resolution to numeric value for sorting (higher resolutions first)
    const resolutionPriority = {
      '2160p': 4,
      '1440p': 3,
      '1080p': 2,
      '720p': 1,
      '480p': 0,
      'other': -1
    };

    const resolutionA = resolutionPriority[a.resolution] || 0;
    const resolutionB = resolutionPriority[b.resolution] || 0;

    // If resolutions are different, sort by resolution (higher first)
    if (resolutionA !== resolutionB) {
      return resolutionB - resolutionA;
    }

    // If resolutions are the same, sort by size (larger first)
    const sizeA = parseSize(a.size);
    const sizeB = parseSize(b.size);
    return sizeB - sizeA;
  });

  return validStreams;
}
