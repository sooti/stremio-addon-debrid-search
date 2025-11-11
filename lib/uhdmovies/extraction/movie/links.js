import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { extractCleanQuality } from '../../utils/quality.js';
import { extractLanguageInfoFromHeader } from '../../utils/language.js';

// Function to extract download links from a movie page
export async function extractDownloadLinks(moviePageUrl, targetYear = null) {
  try {
    console.log(`[UHDMovies] Extracting links from: ${moviePageUrl}`);
    const response = await makeRequest(moviePageUrl);
    const $ = cheerio.load(response.data);

    const movieTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // Find all download links (the new SID links) and their associated quality information
    $('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"]').each((index, element) => {
      const link = $(element).attr('href');

      if (link && !downloadLinks.some(item => item.link === link)) {
        let quality = 'Unknown Quality';
        let size = 'Unknown';

        // Method 1: Look for quality in the closest preceding paragraph or heading
        const prevElement = $(element).closest('p').prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 20 && !prevText.includes('Download')) {
            quality = prevText;
          }
        }

        // Method 2: Look for quality in parent's siblings
        if (quality === 'Unknown Quality') {
          const parentSiblings = $(element).parent().prevAll().first().text().trim();
          if (parentSiblings && parentSiblings.length > 20) {
            quality = parentSiblings;
          }
        }

        // Method 3: Look for bold/strong text above the link
        if (quality === 'Unknown Quality') {
          const strongText = $(element).closest('p').prevAll().find('strong, b').last().text().trim();
          if (strongText && strongText.length > 20) {
            quality = strongText;
          }
        }

        // Method 4: Look for the entire paragraph containing quality info
        if (quality === 'Unknown Quality') {
          let currentElement = $(element).parent();
          for (let i = 0; i < 5; i++) {
            currentElement = currentElement.prev();
            if (currentElement.length === 0) break;

            const text = currentElement.text().trim();
            if (text && text.length > 30 &&
              (text.includes('1080p') || text.includes('720p') || text.includes('2160p') ||
                text.includes('4K') || text.includes('HEVC') || text.includes('x264') || text.includes('x265'))) {
              quality = text;
              break;
            }
          }
        }

        // Year-based filtering for collections
        if (targetYear && quality !== 'Unknown Quality') {
          // Check for years in quality text
          const yearMatches = quality.match(/(\d{4})/g);
          let hasMatchingYear = false;

          if (yearMatches && yearMatches.length > 0) {
            for (const yearMatch of yearMatches) {
              const year = parseInt(yearMatch.replace(/[()]/g, ''));
              if (year === targetYear) {
                hasMatchingYear = true;
                break;
              }
            }
            if (!hasMatchingYear) {
              console.log(`[UHDMovies] Skipping link due to year mismatch. Target: ${targetYear}, Found: ${yearMatches.join(', ')} in "${quality}"`);
              return; // Skip this link
            }
          } else {
            // If no year in quality text, check filename and other indicators
            const linkText = $(element).text().trim();
            const parentText = $(element).parent().text().trim();
            const combinedText = `${quality} ${linkText} ${parentText}`;

            // Look for years in combined text
            const allYearMatches = combinedText.match(/(\d{4})/g);
            if (allYearMatches) {
              let foundTargetYear = false;
              for (const yearMatch of allYearMatches) {
                const year = parseInt(yearMatch.replace(/[()]/g, ''));
                if (year >= 1900 && year <= 2030) { // Valid movie year range
                  if (year === targetYear) {
                    foundTargetYear = true;
                    break;
                  }
                }
              }
              if (!foundTargetYear && allYearMatches.length > 0) {
                console.log(`[UHDMovies] Skipping link due to no matching year found. Target: ${targetYear}, Found years: ${allYearMatches.join(', ')} in combined text`);
                return; // Skip this link
              }
            }

            // Additional check: if quality contains movie names that don't match target year
            const lowerQuality = quality.toLowerCase();
            if (targetYear === 2015) {
              if (lowerQuality.includes('wasp') || lowerQuality.includes('quantumania')) {
                console.log(`[UHDMovies] Skipping link for 2015 target as it contains 'wasp' or 'quantumania': "${quality}"`);
                return; // Skip this link
              }
            }
          }
        }

        // Extract size from quality text if present
        const sizeMatch = quality.match(/[[\]]([0-9.,]+\s*[KMGT]B[^`\]]*)[[\]]/);
        if (sizeMatch) {
          size = sizeMatch[1];
        }

        // Clean up the quality information
        const cleanQuality = extractCleanQuality(quality);

        downloadLinks.push({
          quality: cleanQuality,
          size: size,
          link: link,
          rawQuality: quality.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim(),
          languageInfo: extractLanguageInfoFromHeader(quality)
        });
      }
    });

    return {
      title: movieTitle,
      links: downloadLinks
    };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}
