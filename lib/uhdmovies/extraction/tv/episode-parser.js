import { extractCleanQuality } from '../../utils/quality.js';
import { extractLanguageInfoFromHeader } from '../../utils/language.js';

// Extract episode links for tech.unblockedgames.world and tech.examzculture.in patterns
export function extractEpisodeLinksStandard($el, episode, qualityText, downloadLinks) {
  // Is this a paragraph with episode links?
  if ($el.is('p') && $el.find('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"]').length > 0) {
    const linksParagraph = $el;
    const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');
    const targetEpisodeLink = linksParagraph.find('a').filter((i, el) => {
      return episodeRegex.test($(el).text().trim());
    }).first();

    if (targetEpisodeLink.length > 0) {
      const link = targetEpisodeLink.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        const sizeMatch = qualityText.match(/[[\]\s]*([0-9.,]+\s*[KMGT]B)/i);
        const size = sizeMatch ? sizeMatch[1] : 'Unknown';

        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match: Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  }
}

// Extract episode links for maxbutton-gdrive-episode structure
export function extractEpisodeLinksMaxButton($el, episode, qualityText, downloadLinks) {
  if ($el.is('p') && $el.find('a.maxbutton-gdrive-episode').length > 0) {
    const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');
    const targetEpisodeLink = $el.find('a.maxbutton-gdrive-episode').filter((i, el) => {
      const episodeText = $(el).find('.mb-text').text().trim();
      return episodeRegex.test(episodeText);
    }).first();

    if (targetEpisodeLink.length > 0) {
      const link = targetEpisodeLink.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        const sizeMatch = qualityText.match(/[[\]\s]*([0-9.,]+\s*[KMGT]B)/i);
        const size = sizeMatch ? sizeMatch[1] : 'Unknown';

        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match (maxbutton): Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  }
}

// Fallback: Extract episode links using maxbutton structure with season filtering
export function extractEpisodeLinksMaxButtonFallback($, season, episode, downloadLinks) {
  $('.entry-content').find('a.maxbutton-gdrive-episode').each((i, el) => {
    const linkElement = $(el);
    const episodeText = linkElement.find('.mb-text').text().trim();
    const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');

    if (episodeRegex.test(episodeText)) {
      const link = linkElement.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        let qualityText = 'Unknown Quality';

        // Look for quality info in the preceding paragraph or heading
        const parentP = linkElement.closest('p, div');
        const prevElement = parentP.prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
            qualityText = prevText;
          }
        }

        // Check if this episode belongs to the correct season
        // Enhanced season check - look for various season formats
        const seasonCheckRegexes = [
          new RegExp(`\.S0*${season}[\.]`, 'i'),  // .S01.
          new RegExp(`S0*${season}[\.]`, 'i'),     // S01.
          new RegExp(`S0*${season}\b`, 'i'),       // S01 (word boundary)
          new RegExp(`Season\s+0*${season}\b`, 'i'), // Season 1
          new RegExp(`S0*${season}`, 'i')           // S01 anywhere
        ];

        const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
        if (!seasonMatch) {
          console.log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
          return; // Skip this episode as it's from a different season
        }

        const sizeMatch = qualityText.match(/[[\]]([0-9.,]+[KMGT]B[^`\]]*)[[\]]/i);
        const size = sizeMatch ? sizeMatch[1] : 'Unknown';
        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match via enhanced fallback (maxbutton): Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  });
}

// Fallback: Extract episode links using standard structure with season filtering
export function extractEpisodeLinksStandardFallback($, season, episode, downloadLinks) {
  $('.entry-content').find('a[href*="tech.unblockedgames.world"], a[href*="tech.examzculture.in"]').each((i, el) => {
    const linkElement = $(el);
    const episodeRegex = new RegExp(`^Episode\s+0*${episode}(?!\d)`, 'i');

    if (episodeRegex.test(linkElement.text().trim())) {
      const link = linkElement.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        let qualityText = 'Unknown Quality';
        const parentP = linkElement.closest('p, div');
        const prevElement = parentP.prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
            qualityText = prevText;
          }
        }

        // Check if this episode belongs to the correct season
        // Enhanced season check - look for various season formats
        const seasonCheckRegexes = [
          new RegExp(`\.S0*${season}[\.]`, 'i'),  // .S01.
          new RegExp(`S0*${season}[\.]`, 'i'),     // S01.
          new RegExp(`S0*${season}\b`, 'i'),       // S01 (word boundary)
          new RegExp(`Season\s+0*${season}\b`, 'i'), // Season 1
          new RegExp(`S0*${season}`, 'i')           // S01 anywhere
        ];

        const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
        if (!seasonMatch) {
          console.log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
          return; // Skip this episode as it's from a different season
        }

        const sizeMatch = qualityText.match(/[[\]]([0-9.,]+[KMGT]B[^`\]]*)[[\]]/i);
        const size = sizeMatch ? sizeMatch[1] : 'Unknown';
        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match via original fallback: Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  });
}
