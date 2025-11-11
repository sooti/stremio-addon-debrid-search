// ---------------------------------------------------------------------------------
// Unique Timer Label Generation
// ---------------------------------------------------------------------------------
let timerCounter = 0;

/**
 * Generate a unique timer label to prevent conflicts with concurrent requests
 * @param {string} logPrefix - Log prefix (e.g., 'RD', 'TB')
 * @param {string} scraperName - Scraper name (e.g., 'Jackett', '1337x')
 * @param {string} suffix - Optional suffix (e.g., ':en', ':none')
 * @returns {string} Unique timer label
 */
export function createTimerLabel(logPrefix, scraperName, suffix = '') {
  const id = ++timerCounter;
  return `[${logPrefix} TIMER] ${scraperName}${suffix}#${id}`;
}
