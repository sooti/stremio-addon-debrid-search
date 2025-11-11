// Find and process season blocks in the HTML
export function findSeasonBlockContent($, season) {
  let inTargetSeason = false;
  let qualityText = '';
  const seasonElements = [];

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
      seasonElements.push($el);
    }
  });

  return { seasonElements, inTargetSeason };
}

// Parse quality headers within a season block
export function parseQualityHeader($el) {
  // Is this a quality header? (e.g., a <pre> or a <p> with <strong>)
  // It often contains resolution, release group, etc.
  const isQualityHeader = $el.is('pre, p:has(strong), p:has(b), h3, h4');
  if (isQualityHeader) {
    const headerText = $el.text().trim();
    // Filter out irrelevant headers. We can be more aggressive here.
    if (headerText.length > 5 && !/plot|download|screenshot|trailer|join|powered by|season/i.test(headerText) && !($el.find('a').length > 0)) {
      return headerText; // Store the most recent quality header
    }
  }
  return null;
}

// Check if requested season exists on the page
export function checkSeasonExists($, season) {
  let seasonExists = false;
  let actualSeasonsOnPage = new Set(); // Track what seasons actually have content

  // First pass: Look for actual episode content to see what seasons are available
  $('.entry-content').find('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"], a.maxbutton-gdrive-episode').each((index, element) => {
    const $el = $(element);
    const linkText = $el.text().trim();
    const episodeText = $el.find('.mb-text').text().trim() || linkText;

    // Look for season indicators in episode links
    const seasonMatches = [
      episodeText.match(/S(\d{1,2})/i), // S01, S02, etc.
      episodeText.match(/Season\s+(\d+)/i), // Season 1, Season 2, etc.
      episodeText.match(/S(\d{1,2})E(\d{1,3})/i) // S01E01 format
    ];

    for (const match of seasonMatches) {
      if (match && match[1]) {
        const foundSeason = parseInt(match[1], 10);
        actualSeasonsOnPage.add(foundSeason);
      }
    }
  });

  console.log(`[UHDMovies] Actual seasons found on page: ${Array.from(actualSeasonsOnPage).sort((a,b) => a-b).join(', ')}`);

  // Check if requested season is in the actual content
  if (actualSeasonsOnPage.has(season)) {
    seasonExists = true;
    console.log(`[UHDMovies] Season ${season} confirmed to exist in actual episode content`);
  } else {
    // Fallback: Check page descriptions/titles for season mentions
    $('.entry-content').find('*').each((index, element) => {
      const $el = $(element);
      const text = $el.text().trim();
      // Match various season formats: "SEASON 2", "Season 2", "(Season 1 – 2)", "Season 1-2", etc.
      const seasonMatches = [
        text.match(/^SEASON\s+(\d+)/i),
        text.match(/\bSeason\s+(\d+)/i),
        text.match(/\(Season\s+\d+\s*[–-]\s*(\d+)\)/i), // Matches "(Season 1 – 2)"
        text.match(/Season\s+\d+\s*[–-]\s*(\d+)/i), // Matches "Season 1-2"
        text.match(/\bS(\d+)/i) // Matches "S2", "S02", etc.
      ];

      for (const match of seasonMatches) {
        if (match) {
          const currentSeasonNum = parseInt(match[1], 10);
          if (currentSeasonNum == season) {
            seasonExists = true;
            console.log(`[UHDMovies] Season ${season} found in page description: "${text.substring(0, 100)}..."`);
            return false; // Exit .each() loop
          }
          // For range formats like "Season 1 – 2", check if requested season is in range
          if (match[0].includes('–') || match[0].includes('-')) {
            const rangeMatch = match[0].match(/Season\s+(\d+)\s*[–-]\s*(\d+)/i);
            if (rangeMatch) {
              const startSeason = parseInt(rangeMatch[1], 10);
              const endSeason = parseInt(rangeMatch[2], 10);
              if (season >= startSeason && season <= endSeason) {
                seasonExists = true;
                console.log(`[UHDMovies] Season ${season} found in range ${startSeason}-${endSeason} in page description`);
                return false; // Exit .each() loop
              }
            }
          }
        }
      }
    });
  }

  return seasonExists;
}
