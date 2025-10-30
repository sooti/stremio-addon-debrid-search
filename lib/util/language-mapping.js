// Centralized language mapping for the entire application
// Maps lowercase language names to their flag emojis or display text
const languageMapping = {
  'dubbed': 'Dubbed',
  'multi audio': 'Multi Audio',
  'multi subs': 'Multi Subs',
  'dual audio': 'Dual Audio',
  'english': '🇬🇧',
  'japanese': '🇯🇵',
  'russian': '🇷🇺',
  'italian': '🇮🇹',
  'portuguese': '🇵🇹',
  'spanish': '🇪🇸',
  'latino': '🇲🇽',
  'korean': '🇰🇷',
  'chinese': '🇨🇳',
  'taiwanese': '🇹🇼',
  'french': '🇫🇷',
  'german': '🇩🇪',
  'dutch': '🇳🇱',
  'hindi': '🇮🇳',
  'telugu': '🇮🇳',
  'tamil': '🇮🇳',
  'polish': '🇵🇱',
  'lithuanian': '🇱🇹',
  'latvian': '🇱🇻',
  'estonian': '🇪🇪',
  'czech': '🇨🇿',
  'slovakian': '🇸🇰',
  'slovenian': '🇸🇮',
  'hungarian': '🇭🇺',
  'romanian': '🇷🇴',
  'bulgarian': '🇧🇬',
  'serbian': '🇷🇸',
  'croatian': '🇭🇷',
  'ukrainian': '🇺🇦',
  'greek': '🇬🇷',
  'danish': '🇩🇰',
  'finnish': '🇫🇮',
  'swedish': '🇸🇪',
  'norwegian': '🇳🇴',
  'turkish': '🇹🇷',
  'arabic': '🇸🇦',
  'persian': '🇮🇷',
  'hebrew': '🇮🇱',
  'vietnamese': '🇻🇳',
  'indonesian': '🇮🇩',
  'malay': '🇲🇾',
  'thai': '🇹🇭'
};

// Export language options (excluding non-selectable meta options)
export const LanguageOptions = {
  key: 'language',
  options: Object.keys(languageMapping).slice(4).map(lang => ({
    key: lang,
    label: `${languageMapping[lang]} ${lang.charAt(0).toUpperCase()}${lang.slice(1)}`
  }))
};

/**
 * Maps language keys to their emoji/display representation
 * @param {string[]} languages - Array of language keys
 * @returns {string[]} Array of mapped emojis/display text
 */
export function mapLanguages(languages) {
  const mapped = languages
      .map(language => languageMapping[language])
      .filter(language => language)
      .sort((a, b) => Object.values(languageMapping).indexOf(a) - Object.values(languageMapping).indexOf(b));
  const unmapped = languages
      .filter(language => !languageMapping[language])
      .sort((a, b) => a.localeCompare(b))
  return [...new Set([].concat(mapped).concat(unmapped))];
}

/**
 * Check if a stream title contains any of the specified languages
 * @param {Object} stream - Stream object with title property
 * @param {string[]} languages - Array of language keys to check
 * @returns {boolean} True if stream contains any of the languages
 */
export function containsLanguage(stream, languages) {
  return languages.map(lang => languageMapping[lang]).some(lang => stream.title.includes(lang));
}

/**
 * Get language key from emoji code
 * @param {string} code - Emoji or display text
 * @returns {string|undefined} Language key or undefined
 */
export function languageFromCode(code) {
  const entry = Object.entries(languageMapping).find(entry => entry[1] === code);
  return entry?.[0];
}

/**
 * Detect languages from a stream title by looking for language keywords
 * @param {string} title - Stream title to analyze
 * @returns {string[]} Array of detected language keys
 */
export function detectLanguagesFromTitle(title) {
  if (!title) return [];

  const titleLower = title.toLowerCase();
  const detected = [];

  // Blacklist patterns that shouldn't be detected as languages
  // These are common false positives in torrent/stream titles
  const blacklistPatterns = [
    /\bno[\s._-]ads?\b/i,        // "No Ads", "No.Ads"
    /\bno[\s._-]logo\b/i,         // "No Logo", "No.Logo"
    /\bno[\s._-]watermark\b/i,   // "No Watermark"
    /\bno[\s._-]subs?\b/i,        // "No Sub", "No.Subs"
  ];

  // Check if title contains blacklisted patterns
  const hasBlacklistedNo = blacklistPatterns.some(pattern => pattern.test(titleLower));

  // Check each language in the mapping
  Object.entries(languageMapping).forEach(([key, value]) => {
    // Skip non-language meta options - handle multi-word phrases specially
    if (['dubbed', 'multi audio', 'multi subs', 'dual audio'].includes(key)) {
      // For multi-word phrases, replace spaces with regex to allow dots/dashes/spaces
      const flexiblePattern = key.replace(/\s+/g, '[\\s.\\-_]+');
      const regex = new RegExp(`\\b${flexiblePattern}\\b`, 'i');
      if (regex.test(titleLower)) {
        detected.push(key);
      }
      return;
    }

    // Skip Norwegian detection if blacklisted "no" patterns are found
    if (key === 'norwegian' && hasBlacklistedNo) {
      return;
    }

    // For actual languages, check both the key name and common variations
    const variations = getLanguageVariations(key);
    if (variations.some(variant => {
      // Escape special regex characters in the variant
      const escapedVariant = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Use word boundaries to avoid false matches
      // For very short codes (1-2 letters like 'en', 'fr', 'de'), require strict word boundary on both sides
      // These are too prone to false matches within words
      if (variant.length <= 2) {
        // Only match if surrounded by word boundaries or specific delimiters (including brackets)
        // Match patterns like: [EN], (FR), .DE., -IT-, _ES_, or spaces around
        const regex = new RegExp(`[\\s.\\-_\\[\\(]${escapedVariant}[\\s.\\-_\\]\\)]`, 'i');
        // Also check start/end of string with delimiter
        const startRegex = new RegExp(`^${escapedVariant}[\\s.\\-_\\]\\)]`, 'i');
        const endRegex = new RegExp(`[\\s.\\-_\\[\\(]${escapedVariant}$`, 'i');
        return regex.test(titleLower) || startRegex.test(titleLower) || endRegex.test(titleLower);
      }
      // For 3-letter codes (like 'eng', 'fin', 'ger'), require word boundary on both sides
      else if (variant.length === 3) {
        const regex = new RegExp(`\\b${escapedVariant}\\b`, 'i');
        return regex.test(titleLower);
      }
      // For longer names (4+ chars), use word boundary at start
      // For very common words that could be part of country names, require word boundary on both sides
      else if (['german', 'french', 'spanish', 'italian', 'russian', 'english', 'polish', 'finnish', 'turkish', 'dutch', 'danish', 'swedish', 'norwegian', 'greek'].includes(variant)) {
        // These full language names need exact word match to avoid "Germany", "Poland", "Russia" etc.
        const regex = new RegExp(`\\b${escapedVariant}\\b`, 'i');
        return regex.test(titleLower);
      }
      // For other variants (like "truefrench", "brasileiro", technical terms), use word boundary at start only
      else {
        const regex = new RegExp(`\\b${escapedVariant}`, 'i');
        return regex.test(titleLower);
      }
    })) {
      detected.push(key);
    }
  });

  return detected;
}

/**
 * Get common variations/spellings of a language name for detection
 * Includes torrent/usenet scene tags and common abbreviations
 * @param {string} language - Language key
 * @returns {string[]} Array of possible variations to search for
 */
function getLanguageVariations(language) {
  const variations = [language];

  // Add common variations, abbreviations, and torrent/usenet scene tags
  const variationMap = {
    'english': ['english', 'eng', 'en', 'anglais'],
    'spanish': ['spanish', 'español', 'espanol', 'esp', 'spa', 'es', 'castellano'],
    'latino': ['latino', 'latin', 'latam', 'lat', 'spanish latin', 'latin spanish', 'latinoamericano'],
    'french': ['french', 'français', 'francais', 'fre', 'fra', 'fr', 'vf', 'truefrench', 'vff', 'vfq', 'vfi'],
    'german': ['german', 'deutsch', 'ger', 'deu', 'de'],
    'italian': ['italian', 'italiano', 'ita', 'it'],
    'portuguese': ['portuguese', 'português', 'portugues', 'por', 'pt', 'pt-br', 'brazilian', 'brasil'],
    'russian': ['russian', 'русский', 'rus', 'ru'],
    'japanese': ['japanese', '日本語', 'jpn', 'jap', 'jp'],
    'korean': ['korean', '한국어', 'kor', 'kr'],
    'chinese': ['chinese', '中文', 'chi', 'zho', 'cn', 'mandarin', 'cantonese', 'zh'],
    'taiwanese': ['taiwanese', 'taiwan', 'tw'],
    'hindi': ['hindi', 'हिन्दी', 'hin', 'hi'],
    'tamil': ['tamil', 'தமிழ்', 'tam', 'ta'],
    'telugu': ['telugu', 'తెలుగు', 'tel', 'te'],
    'arabic': ['arabic', 'العربية', 'ara', 'ar'],
    'turkish': ['turkish', 'türkçe', 'turkce', 'tur', 'tr'],
    'dutch': ['dutch', 'nederlands', 'dut', 'nld', 'nl', 'flemish', 'vlaams'],
    'polish': ['polish', 'polski', 'pol', 'pl'],
    'czech': ['czech', 'čeština', 'cestina', 'cze', 'ces', 'cz'],
    'hungarian': ['hungarian', 'magyar', 'hun', 'hu'],
    'romanian': ['romanian', 'română', 'romana', 'rum', 'ron', 'ro'],
    'bulgarian': ['bulgarian', 'български', 'bul', 'bg'],
    'serbian': ['serbian', 'српски', 'srp', 'sr'],
    'croatian': ['croatian', 'hrvatski', 'hrv', 'hr'],
    'ukrainian': ['ukrainian', 'українська', 'ukr', 'uk'],
    'greek': ['greek', 'ελληνικά', 'gre', 'ell', 'gr'],
    'danish': ['danish', 'dansk', 'dan', 'da', 'dk'],
    'finnish': ['finnish', 'suomi', 'fin', 'fi'],
    'swedish': ['swedish', 'svenska', 'swe', 'sv', 'se'],
    'norwegian': ['norwegian', 'norsk', 'nor', 'no', 'nb', 'nn'],
    'hebrew': ['hebrew', 'עברית', 'heb', 'he', 'iw'],
    'persian': ['persian', 'فارسی', 'farsi', 'per', 'fas', 'fa'],
    'thai': ['thai', 'ไทย', 'tha', 'th'],
    'vietnamese': ['vietnamese', 'tiếng việt', 'vie', 'vi'],
    'indonesian': ['indonesian', 'bahasa indonesia', 'ind', 'id'],
    'malay': ['malay', 'bahasa melayu', 'may', 'msa', 'ms'],
    'lithuanian': ['lithuanian', 'lietuvių', 'lit', 'lt'],
    'latvian': ['latvian', 'latviešu', 'lav', 'lv'],
    'estonian': ['estonian', 'eesti', 'est', 'et'],
    'slovakian': ['slovakian', 'slovak', 'slovenčina', 'slo', 'slk', 'sk'],
    'slovenian': ['slovenian', 'slovenščina', 'slv', 'sl']
  };

  return variationMap[language] || variations;
}

/**
 * Filter streams by selected languages
 * @param {Object[]} streams - Array of stream objects with title property
 * @param {string[]} selectedLanguages - Array of language keys to filter by
 * @returns {Object[]} Filtered array of streams
 */
export function filterStreamsByLanguage(streams, selectedLanguages) {
  // If no languages selected, return all streams
  if (!selectedLanguages || selectedLanguages.length === 0) {
    return streams;
  }

  // Normalize selected languages to lowercase
  const selected = selectedLanguages.map(lang => String(lang).toLowerCase());

  // Special case: if only English is selected, include streams with no detected language
  const englishOnly = selected.length === 1 && selected[0] === 'english';

  return streams.filter(stream => {
    const detectedLanguages = detectLanguagesFromTitle(stream.title);

    // If English only is selected and no languages detected, keep it
    if (englishOnly && detectedLanguages.length === 0) {
      return true;
    }

    // Check if any selected language is in the detected languages
    return selected.some(lang => detectedLanguages.includes(lang));
  });
}

/**
 * Render language flags for display in stream titles
 * @param {string[]} languageKeys - Array of language keys
 * @returns {string} String of flag emojis with leading space, or empty string
 */
export function renderLanguageFlags(languageKeys) {
  if (!Array.isArray(languageKeys) || languageKeys.length === 0) return '';

  const unique = Array.from(new Set(languageKeys.map(x => String(x).toLowerCase())));
  const flags = unique
    .map(key => languageMapping[key])
    .filter(value => value && /\p{Emoji}/u.test(value)); // Only include actual emojis

  return flags.length ? ` ${flags.join('')}` : '';
}

export default languageMapping;
