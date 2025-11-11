import * as cheerio from 'cheerio';
import { makeRequest } from '../utils/http.js';
import { getUHDMoviesDomain } from '../config/domains.js';

// Simple In-Memory Cache
export const uhdMoviesCache = {
  search: {},
  movie: {},
  show: {}
};

// Function to search for movies
export async function searchMovies(query) {
  try {
    const baseUrl = await getUHDMoviesDomain(makeRequest);
    console.log(`[UHDMovies] Searching for: ${query}`);
    const searchUrl = `${baseUrl}/search/${encodeURIComponent(query)}`;

    // Multiple search strategies to get more results
    const searchStrategies = [
      { query: query, name: 'primary' },
      { query: query.split(' ').slice(0, 3).join(' '), name: 'first-three-words' },
      { query: query.replace(/(20[0-9]{2}|19[0-9]{2})/, '').trim(), name: 'no-year' }, // Remove year pattern
      { query: query.replace(/:.*$/, '').trim(), name: 'no-subtitle' } // Remove after colon
    ];

    // Remove duplicate queries and filter empty ones
    const uniqueStrategies = [];
    const seenQueries = new Set();
    for (const strategy of searchStrategies) {
      const cleanQuery = strategy.query.trim().toLowerCase();
      if (cleanQuery && !seenQueries.has(cleanQuery)) {
        seenQueries.add(cleanQuery);
        uniqueStrategies.push(strategy);
      }
    }

    // PERFORMANCE FIX: Run all search strategies in parallel instead of sequentially
    console.log(`[UHDMovies] Executing ${uniqueStrategies.length} parallel searches...`);

    const searchPromises = uniqueStrategies.map(async (strategy) => {
      try {
        const strategySearchUrl = `${baseUrl}/search/${encodeURIComponent(strategy.query)}`;
        console.log(`[UHDMovies] Searching with ${strategy.name} query: "${strategy.query}"`);

        const response = await makeRequest(strategySearchUrl);
        const $ = cheerio.load(response.data);

        const strategyResults = [];

        // New logic for grid-based search results
        $('article.gridlove-post').each((index, element) => {
          const linkElement = $(element).find('a[href*="/download-"]');
          if (linkElement.length > 0) {
            const link = linkElement.first().attr('href');
            // Prefer the 'title' attribute, fallback to h1 text
            const title = linkElement.first().attr('title') || $(element).find('h1.sanket').text().trim();

            if (link && title && !strategyResults.some(item => item.link === link)) {
              strategyResults.push({
                title,
                link: link.startsWith('http') ? link : `${baseUrl}${link}`
              });
            }
          }
        });

        // Fallback for original list-based search if new logic fails
        if (strategyResults.length === 0) {
          console.log('[UHDMovies] Grid search logic found no results, trying original list-based logic...');
          $('a[href*="/download-"]').each((index, element) => {
            const link = $(element).attr('href');
            // Avoid duplicates by checking if link already exists in results
            if (link && !strategyResults.some(item => item.link === link)) {
              const title = $(element).text().trim();
              if (title) {
                strategyResults.push({
                  title,
                  link: link.startsWith('http') ? link : `${baseUrl}${link}`
                });
              }
            }
          });
        }

        console.log(`[UHDMovies] Found ${strategyResults.length} results with ${strategy.name} strategy`);
        return { strategyName: strategy.name, results: strategyResults };
      } catch (strategyError) {
        console.log(`[UHDMovies] Search strategy ${strategy.name} failed:`, strategyError.message);
        return { strategyName: strategy.name, results: [] };
      }
    });

    // Wait for all searches to complete
    const allStrategyResults = await Promise.all(searchPromises);

    // Combine all results
    let allResults = [];
    for (const { strategyName, results } of allStrategyResults) {
      if (results.length > 0) {
        console.log(`[UHDMovies] ${strategyName} strategy contributed ${results.length} results`);
        allResults = allResults.concat(results);
      }
    }

    // Remove duplicate results based on link
    const uniqueResults = [];
    const seenLinks = new Set();
    for (const result of allResults) {
      if (!seenLinks.has(result.link)) {
        seenLinks.add(result.link);
        uniqueResults.push(result);
      }
    }

    console.log(`[UHDMovies] Total unique results from all strategies: ${uniqueResults.length}`);
    return uniqueResults;
  } catch (error) {
    console.error(`[UHDMovies] Error searching movies: ${error.message}`);
    return [];
  }
}

// Compare media to find matching result
export function compareMedia(mediaInfo, searchResult) {
  // Number to word mapping for better title matching
  const numberToWord = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    '10': 'ten', '11': 'eleven', '12': 'twelve'
  };
  const wordToNumber = Object.fromEntries(Object.entries(numberToWord).map(([k, v]) => [v, k]));

  const normalizeString = (str) => {
    // First normalize to words with spaces, convert numbers to words, then remove all non-alpha
    const withSpaces = String(str || '').toLowerCase()
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = withSpaces.split(' ');
    const normalized = words.map(word => numberToWord[word] || word).join('');
    return normalized;
  };
  const normalizeForWordMatching = (str) => String(str || '').toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizeForTitleStartMatching = (str) => {
    const normalized = String(str || '').toLowerCase()
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(word => word.length > 0);

    // Normalize numbers to words for consistent matching
    return normalized.map(word => {
      // Convert number to word if it exists in our mapping
      if (numberToWord[word]) {
        return numberToWord[word];
      }
      // Convert word to number if it exists in our mapping, then back to word for consistency
      if (wordToNumber[word]) {
        return word; // Already a word, keep it
      }
      return word;
    });
  };

  const originalMediaTitleLower = mediaInfo.title.toLowerCase();
  const titleWithAnd = originalMediaTitleLower.replace(/\s*&\s*/g, ' and ');
  const normalizedMediaTitle = normalizeString(titleWithAnd);
  const normalizedResultTitle = normalizeString(searchResult.title);

  // Also create a word-based normalized version for better matching
  const wordNormalizedMediaTitle = normalizeForWordMatching(titleWithAnd);
  const wordNormalizedResultTitle = normalizeForWordMatching(searchResult.title);
  const mediaTitleWords = normalizeForTitleStartMatching(titleWithAnd);
  const resultTitleWords = normalizeForTitleStartMatching(searchResult.title);

  console.log(`[UHDMovies] Comparing: "${mediaInfo.title}" (${mediaInfo.year}) vs "${searchResult.title}"`);
  console.log(`[UHDMovies] Normalized: "${normalizedMediaTitle}" vs "${normalizedResultTitle}"`);
  console.log(`[UHDMovies] Word normalized: "${wordNormalizedMediaTitle}" vs "${wordNormalizedResultTitle}"`);
  console.log(`[UHDMovies] Title words: [${mediaTitleWords.join(', ')}] vs [${resultTitleWords.join(', ')}]`);

  // Check if titles match or result title contains media title
  let titleMatches = false;

  // Primary check: media title should appear as the starting portion of the result title
  // This is critical to fix the "FROM" vs "From Hero-King to Extraordinary Squire" issue
  if (mediaTitleWords.length > 0) {
    // Check if the result title starts with all the media title words in order
    if (resultTitleWords.length >= mediaTitleWords.length) {
      let startsWithTitle = true;
      for (let i = 0; i < mediaTitleWords.length; i++) {
        if (resultTitleWords[i] !== mediaTitleWords[i]) {
          startsWithTitle = false;
          break;
        }
      }

      if (startsWithTitle) {
        titleMatches = true;
      } else {
        // Alternative check: if the media title is a substring of the result title but starts at the beginning
        // For multi-word titles like "John Wick" should match "John Wick Chapter 2"
        // Also handles single word titles like "FROM" vs "FROM (2022)"
        // Check if the result text starts with the media words in order (after removing common prefixes)
        const resultTextLower = searchResult.title.toLowerCase();
        // Check if the media title appears at the beginning of the actual title part (after common prefixes)
        let cleanedResult = resultTextLower.replace(/^(download|watch|stream)\s+/i, '');
        // Normalize punctuation and convert numbers to words in cleaned result to match normalized media title
        const cleanedWords = cleanedResult
          .replace(/[^a-zA-Z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .split(' ')
          .map(word => numberToWord[word] || word);
        cleanedResult = cleanedWords.join(' ');

        // Look for media title at the start of the cleaned result
        const mediaTitleForPattern = mediaTitleWords.join(' ');
        if (cleanedResult.startsWith(mediaTitleForPattern + ' ') ||
            cleanedResult === mediaTitleForPattern) {
          titleMatches = true;
        }
        // For single words, also check if they appear as standalone words at the start
        else if (mediaTitleWords.length === 1) {
          const mediaWord = mediaTitleWords[0];
          if (cleanedResult.startsWith(mediaWord + ' ') ||
              cleanedResult === mediaWord) {
            titleMatches = true;
          }
        }
        // Check for franchise/sequel pattern: "Mission Impossible 7: Dead Reckoning" matching "Mission Impossible Dead Reckoning"
        // Extract the franchise name (first 2-3 words) and check if result contains it with optional number
        else if (mediaTitleWords.length >= 2) {
          // Try to match allowing for inserted sequel numbers/roman numerals
          const franchiseWords = mediaTitleWords.slice(0, 2); // e.g., "mission impossible"
          const franchisePattern = franchiseWords.join(' ');

          if (cleanedResult.startsWith(franchisePattern + ' ')) {
            // Check if remaining words after franchise also match (allowing for inserted numbers)
            const afterFranchise = cleanedResult.substring(franchisePattern.length + 1);
            const sequelNumPattern = /^(i{1,3}v?|i?v|i?x|xi{0,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+/i;
            const afterNumber = afterFranchise.replace(sequelNumPattern, '').trim();

            // Check if the remaining media title words appear after the number
            const remainingMediaWords = mediaTitleWords.slice(2);
            if (remainingMediaWords.length > 0) {
              const remainingPattern = remainingMediaWords.join(' ');
              if (afterNumber.startsWith(remainingPattern + ' ') ||
                  afterNumber.startsWith(remainingPattern) ||
                  afterNumber === remainingPattern) {
                titleMatches = true;
              }
            } else {
              // No remaining words to check, franchise match is enough
              titleMatches = true;
            }
          }
        }
      }
    } else {
      // If result is shorter than media title, all result words should appear in the media title
      if (resultTitleWords.length < 3) { // Too short to be a reliable match
          titleMatches = false;
      } else {
          let allResultWordsInMedia = true;
          for (const resultWord of resultTitleWords) {
            if (!mediaTitleWords.includes(resultWord)) {
              // Allow for year to be present in result but not in media title words
              if (/^(19|20)\d{2}$/.test(resultWord)) {
                continue;
              }
              allResultWordsInMedia = false;
              break;
            }
          }
          if (allResultWordsInMedia) {
            titleMatches = true;
          }
      }
    }
  }

  // If direct match fails, try checking for franchise/collection matches
  if (!titleMatches) {
    const mainTitle = normalizedMediaTitle.split('and')[0];
    const isCollection = normalizedResultTitle.includes('duology') ||
      normalizedResultTitle.includes('trilogy') ||
      normalizedResultTitle.includes('quadrilogy') ||
      normalizedResultTitle.includes('collection') ||
      normalizedResultTitle.includes('saga');

    if (isCollection && normalizedResultTitle.includes(mainTitle)) {
      console.log(`[UHDMovies] Found collection match: "${mainTitle}" in collection "${searchResult.title}"`);
      titleMatches = true;
    }
  }

  if (!titleMatches) {
    console.log(`[UHDMovies] Title mismatch: "${normalizedResultTitle}" does not contain "${normalizedMediaTitle}"`);
    return false;
  }

  // NEW: Negative keyword check for spinoffs
  const negativeKeywords = ['challenge', 'conversation', 'story', 'in conversation'];
  for (const keyword of negativeKeywords) {
    if (normalizedResultTitle.includes(keyword.replace(/\s/g, '')) && !originalMediaTitleLower.includes(keyword)) {
      console.log(`[UHDMovies] Rejecting spinoff due to keyword: "${keyword}"`);
      return false; // It's a spinoff, reject it.
    }
  }

  // Check year if both are available
  if (mediaInfo.year && searchResult.title) {
    const yearRegex = /\b(19[89]\d|20\d{2})\b/g; // Look for years 1980-2099
    const yearMatchesInResult = searchResult.title.match(yearRegex);
    const yearRangeMatch = searchResult.title.match(/(\d{4})\s*-\s*(\d{4})/);

    let hasMatchingYear = false;

    if (yearMatchesInResult) {
      console.log(`[UHDMovies] Found years in result: ${yearMatchesInResult.join(', ')}`);
      if (yearMatchesInResult.some(yearStr => Math.abs(parseInt(yearStr) - mediaInfo.year) <= 1)) {
        hasMatchingYear = true;
      }
    }

    if (!hasMatchingYear && yearRangeMatch) {
      console.log(`[UHDMovies] Found year range in result: ${yearRangeMatch[0]}`);
      const startYear = parseInt(yearRangeMatch[1]);
      const endYear = parseInt(yearRangeMatch[2]);
      if (mediaInfo.year >= startYear - 1 && mediaInfo.year <= endYear + 1) {
        hasMatchingYear = true;
      }
    }

    // If there are any years found in the title, one of them MUST match.
    if ((yearMatchesInResult || yearRangeMatch) && !hasMatchingYear) {
      console.log(`[UHDMovies] Year mismatch. Target: ${mediaInfo.year}, but no matching year found in result.`);
      return false;
    }
  }

  console.log(`[UHDMovies] Match successful!`);
  return true;
}

// Function to score search results based on quality keywords and season coverage
export function scoreResult(title, requestedSeason = null, mediaTitle = null) {
  let score = 0;
  const lowerTitle = title.toLowerCase();

  // Exact or close title matching bonus
  if (mediaTitle) {
    const normalizedMediaTitle = mediaTitle.toLowerCase().replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalizedResultTitle = lowerTitle.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // Check if the media title appears as a complete phrase in the result title
    if (normalizedResultTitle.includes(normalizedMediaTitle)) {
      // If the result title starts with the media title, it's likely the main title
      if (normalizedResultTitle.startsWith(normalizedMediaTitle)) {
        score += 50; // High bonus for exact match at start of title
      } else {
        score += 30; // Good bonus for containing the exact title
      }
    } else {
      // Check for partial word matches for cases where title has extra content
      const mediaWords = normalizedMediaTitle.split(' ');
      const resultWords = normalizedResultTitle.split(' ');

      let matchingWords = 0;
      for (const word of mediaWords) {
        if (resultWords.includes(word)) {
          matchingWords++;
        }
      }

      // If most words from media title are found in result, add score
      if (mediaWords.length > 0 && matchingWords >= Math.max(1, Math.floor(mediaWords.length * 0.7))) {
        score += 20 * (matchingWords / mediaWords.length);
      }
    }
  }

  // Quality scoring
  if (lowerTitle.includes('remux')) score += 10;
  if (lowerTitle.includes('bluray') || lowerTitle.includes('blu-ray')) score += 8;
  if (lowerTitle.includes('imax')) score += 6;
  if (lowerTitle.includes('4k') || lowerTitle.includes('2160p')) score += 5;
  if (lowerTitle.includes('dovi') || lowerTitle.includes('dolby vision') || /\bdv\b/.test(lowerTitle)) score += 4;
  if (lowerTitle.includes('hdr')) score += 3;
  if (lowerTitle.includes('1080p')) score += 2;
  if (lowerTitle.includes('hevc') || lowerTitle.includes('x265')) score += 1;

  // Season coverage scoring (for TV shows)
  if (requestedSeason !== null) {
    // Check for season range formats like "Season 1 – 2" or "Season 1-2"
    const seasonRangeMatch = lowerTitle.match(/season\s+(\d+)\s*[–-]\s*(\d+)/i);
    if (seasonRangeMatch) {
      const startSeason = parseInt(seasonRangeMatch[1], 10);
      const endSeason = parseInt(seasonRangeMatch[2], 10);
      if (requestedSeason >= startSeason && requestedSeason <= endSeason) {
        score += 50; // High bonus for season range that includes requested season
        console.log(`[UHDMovies] Season range bonus (+50): ${startSeason}-${endSeason} includes requested season ${requestedSeason}`);
      }
    }

    // Check for specific season mentions
    const specificSeasonMatch = lowerTitle.match(/season\s+(\d+)/i);
    if (specificSeasonMatch) {
      const mentionedSeason = parseInt(specificSeasonMatch[1], 10);
      if (mentionedSeason === requestedSeason) {
        score += 30; // Good bonus for exact season match
        console.log(`[UHDMovies] Exact season bonus (+30): Season ${mentionedSeason} matches requested season ${requestedSeason}`);
      } else if (mentionedSeason < requestedSeason) {
        score -= 20; // Penalty for older season when requesting newer season
        console.log(`[UHDMovies] Season penalty (-20): Season ${mentionedSeason} is older than requested season ${requestedSeason}`);
      }
    }

    // Check for "Season X Added" or similar indicators
    if (lowerTitle.includes('season') && lowerTitle.includes('added')) {
      const addedSeasonMatch = lowerTitle.match(/season\s+(\d+)\s+added/i);
      if (addedSeasonMatch) {
        const addedSeason = parseInt(addedSeasonMatch[1], 10);
        if (addedSeason === requestedSeason) {
          score += 40; // High bonus for newly added season
          console.log(`[UHDMovies] Added season bonus (+40): Season ${addedSeason} was recently added`);
        }
      }
    }
  }

  return score;
}

// Function to parse size string into MB
export function parseSize(sizeString) {
  if (!sizeString || typeof sizeString !== 'string') {
    return 0;
  }

  const upperCaseSizeString = sizeString.toUpperCase();

  // Regex to find a number (integer or float) followed by GB, MB, or KB
  const match = upperCaseSizeString.match(/([0-9.,]+)\s*(GB|MB|KB)/);

  if (!match) {
    return 0;
  }

  const sizeValue = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(sizeValue)) {
    return 0;
  }

  const unit = match[2];

  if (unit === 'GB') {
    return sizeValue * 1024;
  } else if (unit === 'MB') {
    return sizeValue;
  } else if (unit === 'KB') {
    return sizeValue / 1024;
  }

  return 0;
}
