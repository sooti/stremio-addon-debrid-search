/**
 * Intelligent Scraper Wrapper
 *
 * Wraps scraper functions to automatically track performance and handle errors
 */

import performanceTracker from '../util/scraper-performance.js';
import axios from 'axios';

/**
 * Detect error type from error object
 */
function detectErrorType(error) {
    // Timeout errors
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        return 'timeout';
    }

    // Rate limiting
    if (error.response?.status === 429) {
        return 'rate_limit';
    }

    // Server errors (5xx)
    if (error.response?.status >= 500 && error.response?.status < 600) {
        return 'server_error';
    }

    // CAPTCHA detection
    if (
        error.message?.toLowerCase().includes('captcha') ||
        error.response?.data?.includes?.('captcha') ||
        error.response?.data?.includes?.('security check')
    ) {
        return 'captcha';
    }

    // Generic failure
    return 'error';
}

/**
 * Wrap a scraper function with performance tracking
 */
export function wrapScraper(scraperName, scraperFn) {
    return async function wrappedScraper(...args) {
        const startTime = Date.now();

        try {
            // Call the original scraper
            const results = await scraperFn(...args);
            const responseTime = Date.now() - startTime;

            // Record success
            const resultCount = Array.isArray(results) ? results.length : 0;
            performanceTracker.recordSuccess(scraperName, resultCount, responseTime);

            return results;
        } catch (error) {
            const responseTime = Date.now() - startTime;
            const errorType = detectErrorType(error);

            // Record failure
            performanceTracker.recordFailure(
                scraperName,
                errorType,
                responseTime,
                error.message
            );

            // Don't throw for canceled requests
            if (axios.isCancel(error)) {
                console.log(`[${scraperName}] Request canceled`);
                return [];
            }

            // Return empty results instead of throwing
            console.error(`[${scraperName}] Error (${errorType}): ${error.message}`);
            return [];
        }
    };
}

/**
 * Execute scrapers with intelligent selection
 *
 * @param {Object} scraperMap - Map of scraper names to functions
 * @param {Array} args - Arguments to pass to each scraper
 * @param {Object} options - Options for scraper selection
 * @returns {Promise<Array>} - Combined results from all selected scrapers
 */
export async function executeScrapersIntelligently(scraperMap, args, options = {}) {
    const availableScrapers = Object.keys(scraperMap);

    // Select best scrapers based on performance
    const selectedScrapers = performanceTracker.selectScrapers(availableScrapers, {
        topN: options.topN || 5,
        minScore: options.minScore || 30,
    });

    console.log(`[INTELLIGENT SCRAPER] Using ${selectedScrapers.length}/${availableScrapers.length} scrapers`);

    // Show penalized scrapers
    const penalized = availableScrapers.filter(name =>
        performanceTracker.isPenalized(name)
    );

    if (penalized.length > 0) {
        console.log(`[INTELLIGENT SCRAPER] Penalized scrapers (skipped): ${penalized.join(', ')}`);
        penalized.forEach(name => {
            const info = performanceTracker.getPenaltyInfo(name);
            console.log(`  - ${name}: ${info.type} (${info.remainingMinutes}min remaining)`);
        });
    }

    // Execute selected scrapers in parallel
    const promises = selectedScrapers.map(async (scraperName) => {
        try {
            const scraperFn = scraperMap[scraperName];
            const wrappedFn = wrapScraper(scraperName, scraperFn);
            return await wrappedFn(...args);
        } catch (error) {
            console.error(`[INTELLIGENT SCRAPER] ${scraperName} failed:`, error.message);
            return [];
        }
    });

    const results = await Promise.all(promises);

    // Flatten and deduplicate results
    const combined = results.flat();
    console.log(`[INTELLIGENT SCRAPER] Total results: ${combined.length}`);

    return combined;
}

export default {
    wrapScraper,
    executeScrapersIntelligently,
    performanceTracker,
};
