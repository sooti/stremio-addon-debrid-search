// List of keywords to identify and filter out junk/bootleg files.
const JUNK_KEYWORDS = [
    'CAM', 'HDCAM', 'CAMRIP',
    'TS', 'HDTS', 'TELESYNC',
    'TC', 'HDTC', 'TELECINE',
    'SCR', 'SCREENER', 'DVDSCR', 'BDSCR',
    'R5', 'R6', 'WORKPRINT', 'WP', 'HDRIP'
];

// Regex to test for junk keywords as whole words (case-insensitive).
const JUNK_REGEX = new RegExp(`\\b(${JUNK_KEYWORDS.join('|')})\\b`, 'i');

/**
 * Checks if a torrent title is likely a junk/bootleg copy.
 * @param {string} title The title of the torrent.
 * @returns {boolean} True if the title is NOT junk, false otherwise.
 */
export function isNotJunk(title) {
    if (!title) return true; // Don't filter out items that have no title
    return !JUNK_REGEX.test(title);
}

// Simple language token check in the title using common markers
const SIMPLE_LANG_MAP = {
    en: ['en', 'eng', 'english'],
    ru: ['ru', 'rus', 'russian'],
    fr: ['fr', 'fra', 'french', 'vostfr', 'vf', 'vff', 'truefrench'],
    es: ['es', 'esp', 'spanish', 'lat', 'latam', 'cast', 'castellano', 'latino'],
    de: ['de', 'ger', 'german', 'deu'],
    it: ['it', 'ita', 'italian', 'italiano'],
    pt: ['pt', 'por', 'portuguese'],
    pl: ['pl']
};

export function detectSimpleLangs(title) {
    if (!title) return [];
    const sanitized = String(title).toLowerCase().replace(/[[\]()._-]+/g, ' ');
    const words = new Set(sanitized.split(/\s+/).filter(Boolean));
    const hits = new Set();
    for (const [code, tokens] of Object.entries(SIMPLE_LANG_MAP)) {
        for (const t of tokens) {
            if (words.has(t)) { hits.add(code); break; }
        }
    }
    return Array.from(hits);
}

export function hasSimpleLanguageToken(title, codes = []) {
    if (!title || !Array.isArray(codes) || codes.length === 0) return true;
    const nonEnglish = codes.filter(c => c && c.toLowerCase() !== 'en');
    if (nonEnglish.length === 0) return true;
    const sanitized = String(title).toLowerCase().replace(/[[\]()._-]+/g, ' ');
    const words = new Set(sanitized.split(/\s+/).filter(Boolean));
    for (const code of nonEnglish) {
        const key = String(code).toLowerCase();
        const tokens = SIMPLE_LANG_MAP[key] || [key];
        for (const t of tokens) {
            if (words.has(t.toLowerCase())) return true;
        }
    }
    return false;
}

export function hasAnyNonEnglishToken(title) {
    if (!title) return false;
    const sanitized = String(title).toLowerCase().replace(/[[\]()._-]+/g, ' ');
    const words = new Set(sanitized.split(/\s+/).filter(Boolean));
    for (const [code, tokens] of Object.entries(SIMPLE_LANG_MAP)) {
        if (code === 'en') continue;
        for (const t of tokens) {
            if (words.has(t)) return true;
        }
    }
    return false;
}
