import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { parseQualityHeader, checkSeasonExists } from './season-parser.js';
import {
  extractEpisodeLinksStandard,
  extractEpisodeLinksMaxButton,
  extractEpisodeLinksMaxButtonFallback,
  extractEpisodeLinksStandardFallback
} from './episode-parser.js';

// Function to extract download links for TV shows from a page
// REFACTORED: Broken down from ~300 lines to ~120 lines with helper functions
export async function extractTvShowDownloadLinks(showPageUrl, season, episode) {
  try {
    console.log(`[UHDMovies] Extracting TV show links from: ${showPageUrl} for S${season}E${episode}`);
    const response = await makeRequest(showPageUrl);
    const $ = cheerio.load(response.data);

    const showTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // --- NEW LOGIC TO SCOPE SEARCH TO THE CORRECT SEASON ---
    let inTargetSeason = false;
    let qualityText = '';

    $('.entry-content').find('*').each((index, element) => {
      const $el = $(element);
      const text = $el.text().trim();
      const seasonMatch = text.match(/^SEASON\s+(\d+)/i);

      // Check if we are entering a new season block
      if (seasonMatch) {
        const currentSeasonNum = parseInt(seasonMatch[1], 10);
        if (currentSeasonNum == season) {
          inTargetSeason = true;
          console.log(`[UHDMovies] Entering Season ${season} block.`);
        } else if (inTargetSeason) {
          // We've hit the next season, so we stop.
          console.log(`[UHDMovies] Exiting Season ${season} block, now in Season ${currentSeasonNum}.`);
          inTargetSeason = false;
          return false; // Exit .each() loop
        }
      }

      if (inTargetSeason) {
        // This element is within the correct season's block.

        // Try to extract quality header
        const header = parseQualityHeader($el);
        if (header) {
          qualityText = header;
        }

        // Try to extract episode links using various patterns
        extractEpisodeLinksStandard($el, episode, qualityText, downloadLinks);
        extractEpisodeLinksMaxButton($el, episode, qualityText, downloadLinks);
      }
    });

    if (downloadLinks.length === 0) {
      console.log('[UHDMovies] Main extraction logic failed. Checking if requested season exists on page before fallback.');

      // Check if the requested season exists on the page at all
      const seasonExists = checkSeasonExists($, season);

      if (!seasonExists) {
        console.log(`[UHDMovies] Season ${season} not found on page. Available seasons may not include the requested season.`);
        // Don't use fallback if the season doesn't exist to avoid wrong episodes
        return { title: showTitle, links: [], seasonNotFound: true };
      }

      console.log(`[UHDMovies] Season ${season} exists on page but episode extraction failed. Trying fallback method with season filtering.`);

      // --- ENHANCED FALLBACK LOGIC FOR NEW HTML STRUCTURE ---
      // Try the new maxbutton-gdrive-episode structure first
      extractEpisodeLinksMaxButtonFallback($, season, episode, downloadLinks);

      // If still no results, try the original fallback logic
      if (downloadLinks.length === 0) {
        console.log(`[UHDMovies] Enhanced fallback failed, trying original fallback logic.`);
        extractEpisodeLinksStandardFallback($, season, episode, downloadLinks);
      }
    }

    if (downloadLinks.length > 0) {
      console.log(`[UHDMovies] Found ${downloadLinks.length} links for S${season}E${episode}.`);
    } else {
      console.log(`[UHDMovies] Could not find links for S${season}E${episode}. It's possible the logic needs adjustment or the links aren't on the page.`);
    }

    return { title: showTitle, links: downloadLinks };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting TV show download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}
