import { deduplicateAndKeepLargest } from '../../common/torrent-utils.js';
import { isNotJunk, hasSimpleLanguageToken, hasAnyNonEnglishToken } from './filtering.js';

/**
 * NEW WRAPPER FUNCTION: Processes raw scraper results to filter junk and deduplicate.
 * @param {Array<Object>} results - The raw results from a scraper.
 * @param {Object} config - The user's configuration object.
 * @returns {Array<Object>} - The cleaned, filtered, and deduplicated results.
 */
export function processAndDeduplicate(results, config = {}) {
    if (!Array.isArray(results)) return [];
    // 1. Filter out null/boolean entries and junk titles
    let filtered = results.filter(Boolean).filter(r => isNotJunk(r.Title));

    // 2. Language filtering per selected languages
    try {
        const selected = Array.isArray(config?.Languages) ? config.Languages.filter(Boolean) : [];
        const lower = selected.map(s => String(s).toLowerCase());
        const englishOnly = (lower.length === 1 && lower[0] === 'en');
        const noneSelected = lower.length === 0;
        if (englishOnly) {
            filtered = filtered.filter(r => !hasAnyNonEnglishToken(r.Title));
        } else if (!noneSelected) {
            filtered = filtered.filter(r => hasSimpleLanguageToken(r.Title, selected));
        }
    } catch (_) {}

    // 3. Deduplicate the filtered results, keeping the largest size for each title
    return deduplicateAndKeepLargest(filtered);
}
