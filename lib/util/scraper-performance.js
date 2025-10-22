/**
 * Intelligent Scraper Performance Tracker & Selector
 *
 * Tracks scraper performance metrics and intelligently selects which scrapers
 * to use based on success rates, response times, error patterns, and penalties.
 */

import NodeCache from 'node-cache';

// Performance metrics cache (TTL: 30 minutes)
const performanceCache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });

// Penalty tracking (temporary bans)
const penaltyCache = new NodeCache({ checkperiod: 60 });

// Configuration
const CONFIG = {
    // Minimum success rate to keep scraper enabled (50%)
    MIN_SUCCESS_RATE: 0.5,

    // Maximum acceptable average response time (10 seconds)
    MAX_AVG_RESPONSE_TIME: 10000,

    // Minimum results to consider scraper useful
    MIN_USEFUL_RESULTS: 1,

    // Sample size for calculating metrics
    SAMPLE_SIZE: 10,

    // Penalty durations (in minutes)
    PENALTIES: {
        TIMEOUT: 5,           // 5 minutes for timeouts
        RATE_LIMIT: 15,       // 15 minutes for 429 errors
        SERVER_ERROR: 10,     // 10 minutes for 5xx errors
        REPEATED_FAILURE: 20, // 20 minutes for 3+ consecutive failures
        CAPTCHA: 30,          // 30 minutes for CAPTCHA detection
    },

    // Performance scoring weights
    WEIGHTS: {
        SUCCESS_RATE: 0.35,
        RESULT_COUNT: 0.25,
        RESPONSE_TIME: 0.20,
        ERROR_RATE: 0.20,
    },

    // Top N scrapers to select
    TOP_SCRAPERS_COUNT: 5,
};

class ScraperPerformanceTracker {
    constructor() {
        this.reset();
    }

    reset() {
        // Initialize or reset all metrics
        performanceCache.flushAll();
    }

    /**
     * Get or initialize performance data for a scraper
     */
    _getScraperData(scraperName) {
        let data = performanceCache.get(scraperName);
        if (!data) {
            data = {
                name: scraperName,
                totalRequests: 0,
                successCount: 0,
                failureCount: 0,
                timeoutCount: 0,
                rateLimitCount: 0,
                serverErrorCount: 0,
                captchaCount: 0,
                totalResults: 0,
                totalResponseTime: 0,
                recentResults: [],      // Last N results
                recentResponseTimes: [], // Last N response times
                recentStatuses: [],      // Last N success/failure
                consecutiveFailures: 0,
                lastSuccess: null,
                lastFailure: null,
                score: 100,
            };
        }
        return data;
    }

    /**
     * Save scraper data back to cache
     */
    _saveScraperData(scraperName, data) {
        performanceCache.set(scraperName, data);
    }

    /**
     * Record a successful scraper execution
     */
    recordSuccess(scraperName, resultCount, responseTime) {
        const data = this._getScraperData(scraperName);

        data.totalRequests++;
        data.successCount++;
        data.totalResults += resultCount;
        data.totalResponseTime += responseTime;
        data.consecutiveFailures = 0;
        data.lastSuccess = Date.now();

        // Track recent results (sliding window)
        data.recentResults.push(resultCount);
        data.recentResponseTimes.push(responseTime);
        data.recentStatuses.push('success');

        // Keep only last N samples
        if (data.recentResults.length > CONFIG.SAMPLE_SIZE) {
            data.recentResults.shift();
            data.recentResponseTimes.shift();
            data.recentStatuses.shift();
        }

        data.score = this._calculateScore(data);
        this._saveScraperData(scraperName, data);

        console.log(`[PERF TRACKER] ${scraperName}: SUCCESS (+score) - ${resultCount} results in ${responseTime}ms, score: ${data.score.toFixed(1)}`);
    }

    /**
     * Record a failed scraper execution
     */
    recordFailure(scraperName, errorType, responseTime = 0, errorMessage = '') {
        const data = this._getScraperData(scraperName);

        data.totalRequests++;
        data.failureCount++;
        data.consecutiveFailures++;
        data.lastFailure = Date.now();

        // Track error types
        switch (errorType) {
            case 'timeout':
                data.timeoutCount++;
                this._applyPenalty(scraperName, 'TIMEOUT');
                break;
            case 'rate_limit':
            case '429':
                data.rateLimitCount++;
                this._applyPenalty(scraperName, 'RATE_LIMIT');
                break;
            case 'server_error':
            case '5xx':
                data.serverErrorCount++;
                this._applyPenalty(scraperName, 'SERVER_ERROR');
                break;
            case 'captcha':
                data.captchaCount++;
                this._applyPenalty(scraperName, 'CAPTCHA');
                break;
        }

        // Track recent activity
        data.recentResults.push(0);
        data.recentResponseTimes.push(responseTime);
        data.recentStatuses.push('failure');

        if (data.recentResults.length > CONFIG.SAMPLE_SIZE) {
            data.recentResults.shift();
            data.recentResponseTimes.shift();
            data.recentStatuses.shift();
        }

        // Apply repeated failure penalty
        if (data.consecutiveFailures >= 3) {
            this._applyPenalty(scraperName, 'REPEATED_FAILURE');
        }

        data.score = this._calculateScore(data);
        this._saveScraperData(scraperName, data);

        console.log(`[PERF TRACKER] ${scraperName}: FAILURE (-score) - ${errorType}, consecutive: ${data.consecutiveFailures}, score: ${data.score.toFixed(1)}`);
    }

    /**
     * Apply a temporary penalty (timeout) to a scraper
     */
    _applyPenalty(scraperName, penaltyType) {
        const durationMinutes = CONFIG.PENALTIES[penaltyType];
        const durationMs = durationMinutes * 60 * 1000;
        const expiresAt = Date.now() + durationMs;

        penaltyCache.set(scraperName, {
            type: penaltyType,
            appliedAt: Date.now(),
            expiresAt,
            durationMinutes,
        }, durationMinutes * 60);

        console.log(`[PERF TRACKER] ${scraperName}: PENALTY applied - ${penaltyType} for ${durationMinutes} minutes`);
    }

    /**
     * Check if a scraper is currently penalized
     */
    isPenalized(scraperName) {
        const penalty = penaltyCache.get(scraperName);
        if (!penalty) return false;

        if (Date.now() >= penalty.expiresAt) {
            penaltyCache.del(scraperName);
            console.log(`[PERF TRACKER] ${scraperName}: PENALTY expired`);
            return false;
        }

        return true;
    }

    /**
     * Get penalty info for a scraper
     */
    getPenaltyInfo(scraperName) {
        const penalty = penaltyCache.get(scraperName);
        if (!penalty) return null;

        const remainingMs = penalty.expiresAt - Date.now();
        const remainingMinutes = Math.ceil(remainingMs / 60000);

        return {
            ...penalty,
            remainingMinutes,
            remainingMs,
        };
    }

    /**
     * Calculate performance score for a scraper (0-100)
     */
    _calculateScore(data) {
        if (data.totalRequests === 0) return 100;

        // Success rate (0-100)
        const successRate = (data.successCount / data.totalRequests) * 100;

        // Average results per request (normalize to 0-100)
        const avgResults = data.totalResults / Math.max(data.successCount, 1);
        const resultScore = Math.min((avgResults / 50) * 100, 100); // Cap at 50 results = 100 score

        // Response time score (0-100, lower is better)
        const avgResponseTime = data.totalResponseTime / Math.max(data.successCount, 1);
        const timeScore = Math.max(100 - (avgResponseTime / CONFIG.MAX_AVG_RESPONSE_TIME) * 100, 0);

        // Error rate score (inverse of error rate)
        const errorRate = (data.failureCount / data.totalRequests) * 100;
        const errorScore = 100 - errorRate;

        // Weighted average
        const score = (
            successRate * CONFIG.WEIGHTS.SUCCESS_RATE +
            resultScore * CONFIG.WEIGHTS.RESULT_COUNT +
            timeScore * CONFIG.WEIGHTS.RESPONSE_TIME +
            errorScore * CONFIG.WEIGHTS.ERROR_RATE
        );

        // Penalty for consecutive failures
        const penaltyMultiplier = Math.max(1 - (data.consecutiveFailures * 0.1), 0.5);

        return score * penaltyMultiplier;
    }

    /**
     * Get performance stats for a scraper
     */
    getStats(scraperName) {
        const data = this._getScraperData(scraperName);
        const penalty = this.getPenaltyInfo(scraperName);

        const avgResults = data.successCount > 0
            ? data.totalResults / data.successCount
            : 0;

        const avgResponseTime = data.successCount > 0
            ? data.totalResponseTime / data.successCount
            : 0;

        const successRate = data.totalRequests > 0
            ? (data.successCount / data.totalRequests) * 100
            : 0;

        return {
            name: scraperName,
            score: data.score,
            totalRequests: data.totalRequests,
            successCount: data.successCount,
            failureCount: data.failureCount,
            successRate,
            avgResults,
            avgResponseTime,
            consecutiveFailures: data.consecutiveFailures,
            penalty,
            errors: {
                timeout: data.timeoutCount,
                rateLimit: data.rateLimitCount,
                serverError: data.serverErrorCount,
                captcha: data.captchaCount,
            },
        };
    }

    /**
     * Get all scrapers sorted by performance score
     */
    getRankedScrapers() {
        const allKeys = performanceCache.keys();
        const scrapers = allKeys.map(name => this.getStats(name));

        return scrapers.sort((a, b) => b.score - a.score);
    }

    /**
     * Select the best scrapers to use for the next request
     */
    selectScrapers(availableScrapers, config = {}) {
        const topN = config.topN || CONFIG.TOP_SCRAPERS_COUNT;
        const minScore = config.minScore || 30;

        // Filter out penalized scrapers
        const eligible = availableScrapers.filter(name => !this.isPenalized(name));

        if (eligible.length === 0) {
            console.warn('[PERF TRACKER] All scrapers are penalized! Using all scrapers as fallback.');
            return availableScrapers;
        }

        // Get stats and score for each eligible scraper
        const scored = eligible.map(name => ({
            name,
            stats: this.getStats(name),
        }));

        // Sort by score (descending)
        scored.sort((a, b) => b.stats.score - a.stats.score);

        // Filter by minimum score and take top N
        const selected = scored
            .filter(s => s.stats.score >= minScore)
            .slice(0, topN)
            .map(s => s.name);

        // If no scrapers meet minimum score, take top N anyway
        if (selected.length === 0) {
            console.warn(`[PERF TRACKER] No scrapers meet minimum score ${minScore}. Using top ${topN} anyway.`);
            return scored.slice(0, topN).map(s => s.name);
        }

        console.log(`[PERF TRACKER] Selected ${selected.length} scrapers: ${selected.join(', ')}`);
        return selected;
    }

    /**
     * Clear penalty for a scraper (manual override)
     */
    clearPenalty(scraperName) {
        penaltyCache.del(scraperName);
        console.log(`[PERF TRACKER] ${scraperName}: PENALTY cleared manually`);
    }

    /**
     * Get a summary report of all scrapers
     */
    getSummaryReport() {
        const ranked = this.getRankedScrapers();

        return {
            timestamp: new Date().toISOString(),
            totalScrapers: ranked.length,
            scrapers: ranked,
            penalties: penaltyCache.keys().map(name => ({
                name,
                ...this.getPenaltyInfo(name),
            })),
        };
    }
}

// Singleton instance
const performanceTracker = new ScraperPerformanceTracker();

export default performanceTracker;
export { ScraperPerformanceTracker, CONFIG };
