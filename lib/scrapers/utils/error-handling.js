import axios from 'axios';

/**
 * Handles scraper errors with consistent logging
 * @param {Error} error - The error object
 * @param {string} scraperName - Name of the scraper
 * @param {string} logPrefix - Log prefix (e.g., 'RD', 'TB')
 */
export async function handleScraperError(error, scraperName, logPrefix) {
    if (!axios.isCancel(error)) {
        console.error(`[${logPrefix} SCRAPER] ${scraperName} search failed: ${error.message}`);
    }
}
