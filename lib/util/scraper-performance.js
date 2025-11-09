/**
 * Intelligent Scraper Performance Tracker & Selector
 *
 * Tracks scraper performance metrics and intelligently selects which scrapers
 * to use based on success rates, response times, error patterns, and penalties.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory name for this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;
let cleanupIntervalId = null; // MEMORY LEAK FIX: Track interval for cleanup

// Initialize SQLite database for performance tracking
function initPerformanceDb() {
  if (db) return db;
  
  try {
    // Create database file in data directory
    const dataDir = join(__dirname, '..', '..', 'data');
    const dbPath = join(dataDir, 'performance.db');
    
    // Ensure data directory exists - synchronously
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(dbPath, { WAL: true });

    // Optimize SQLite for performance
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = 1000');
    db.pragma('temp_store = memory');

    // Create tables if they don't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS performance_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS penalty_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);

    // Create indexes for performance
    db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_expires ON performance_cache(expires_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_penalty_expires ON penalty_cache(expires_at)`);

    // Schedule cleanup of expired records
    setupCleanupJob();

    return db;
  } catch (error) {
    console.error('[PERFORMANCE-CACHE] Failed to initialize SQLite:', error.message);
    return null;
  }
}

// Set up periodic cleanup job for expired records
function setupCleanupJob() {
  // MEMORY LEAK FIX: Clear any existing interval before creating a new one
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Clean up expired records every 5 minutes
  cleanupIntervalId = setInterval(() => {
    try {
      const db = initPerformanceDb();
      if (!db) return;

      const now = Date.now();
      const result1 = db.prepare('DELETE FROM performance_cache WHERE expires_at <= ?').run(now);
      const result2 = db.prepare('DELETE FROM penalty_cache WHERE expires_at <= ?').run(now);

      const changes = db.prepare('SELECT changes()').get()['changes()'];
      if (changes > 0) {
        console.log(`[PERFORMANCE-CACHE] Cleaned up ${changes} expired cache entries`);
      }
    } catch (error) {
      console.error(`[PERFORMANCE-CACHE] Error cleaning up expired entries: ${error.message}`);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

// Helper functions to interact with SQLite
function getFromDb(table, key) {
  const db = initPerformanceDb();
  if (!db) return null;
  
  const row = db.prepare(`SELECT value FROM ${table} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`).get(key, Date.now());
  return row ? JSON.parse(row.value) : null;
}

function setInDb(table, key, value, ttlSeconds = null) {
  const db = initPerformanceDb();
  if (!db) return false;
  
  const expiresAt = ttlSeconds ? (Date.now() + (ttlSeconds * 1000)) : null;
  const serializedValue = JSON.stringify(value);
  
  try {
    db.prepare(`
      INSERT OR REPLACE INTO ${table} (key, value, expires_at)
      VALUES (?, ?, ?)
    `).run(key, serializedValue, expiresAt);
    return true;
  } catch (error) {
    console.error(`[PERFORMANCE-CACHE] Error setting ${table} key ${key}:`, error.message);
    return false;
  }
}

function deleteFromDb(table, key) {
  const db = initPerformanceDb();
  if (!db) return false;
  
  try {
    db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
    return true;
  } catch (error) {
    console.error(`[PERFORMANCE-CACHE] Error deleting ${table} key ${key}:`, error.message);
    return false;
  }
}

function listKeysFromDb(table) {
  const db = initPerformanceDb();
  if (!db) return [];
  
  try {
    const rows = db.prepare(`SELECT key FROM ${table} WHERE expires_at IS NULL OR expires_at > ?`).all(Date.now());
    return rows.map(row => row.key);
  } catch (error) {
    console.error(`[PERFORMANCE-CACHE] Error listing ${table} keys:`, error.message);
    return [];
  }
}

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
        const db = initPerformanceDb();
        if (db) {
            db.exec("DELETE FROM performance_cache WHERE key LIKE 'scraper:%'");
        }
    }

    /**
     * Get or initialize performance data for a scraper
     */
    _getScraperData(scraperName) {
        let data = getFromDb('performance_cache', `scraper:${scraperName}`);
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
        setInDb('performance_cache', `scraper:${scraperName}`, data, 1800); // 30 minutes TTL
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

        setInDb('penalty_cache', `penalty:${scraperName}`, {
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
        const penalty = getFromDb('penalty_cache', `penalty:${scraperName}`);
        if (!penalty) return false;

        if (Date.now() >= penalty.expiresAt) {
            deleteFromDb('penalty_cache', `penalty:${scraperName}`);
            console.log(`[PERF TRACKER] ${scraperName}: PENALTY expired`);
            return false;
        }

        return true;
    }

    /**
     * Get penalty info for a scanner
     */
    getPenaltyInfo(scraperName) {
        const penalty = getFromDb('penalty_cache', `penalty:${scraperName}`);
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

        // 1. Success rate score (0-100)
        const successRate = (data.successCount / data.totalRequests) * 100;
        const successScore = successRate; // Already 0-100

        // 2. Result count score (0-100)
        // Average results per successful request
        const avgResults = data.successCount > 0
            ? data.totalResults / data.successCount
            : 0;
        // Scale: 0 results = 0, 50+ results = 100 (linear interpolation)
        const resultScore = Math.min((avgResults / 50) * 100, 100);

        // 3. Response time score (0-100, faster is better)
        const avgResponseTime = data.successCount > 0
            ? data.totalResponseTime / data.successCount
            : CONFIG.MAX_AVG_RESPONSE_TIME;
        // Scale: 0ms = 100, MAX_AVG_RESPONSE_TIME+ = 0
        const timeScore = Math.max(100 - (avgResponseTime / CONFIG.MAX_AVG_RESPONSE_TIME) * 100, 0);

        // 4. Error rate score (0-100, fewer errors is better)
        // Note: This is redundant with successScore since errorRate = 100 - successRate
        // We'll use a different metric: specific error penalties
        const totalErrors = data.timeoutCount + data.rateLimitCount + data.serverErrorCount + data.captchaCount;
        const errorRatio = data.totalRequests > 0 ? totalErrors / data.totalRequests : 0;
        const errorScore = Math.max(100 - (errorRatio * 200), 0); // Double weight for critical errors

        // Weighted average
        const baseScore = (
            successScore * CONFIG.WEIGHTS.SUCCESS_RATE +
            resultScore * CONFIG.WEIGHTS.RESULT_COUNT +
            timeScore * CONFIG.WEIGHTS.RESPONSE_TIME +
            errorScore * CONFIG.WEIGHTS.ERROR_RATE
        );

        // Penalty for consecutive failures (max -50% at 5+ failures)
        const penaltyMultiplier = Math.max(1 - (data.consecutiveFailures * 0.1), 0.5);

        const finalScore = baseScore * penaltyMultiplier;

        // Ensure score is between 0-100
        return Math.max(0, Math.min(100, finalScore));
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
        const allKeys = listKeysFromDb('performance_cache');
        const scraperKeys = allKeys.filter(key => key.startsWith('scraper:')).map(key => key.substring(8));
        const scrapers = scraperKeys.map(name => this.getStats(name));

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
        deleteFromDb('penalty_cache', `penalty:${scraperName}`);
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
            penalties: listKeysFromDb('penalty_cache').map(key => {
                if (!key.startsWith('penalty:')) return null;
                const name = key.substring(8);
                return {
                    name,
                    ...this.getPenaltyInfo(name),
                };
            }).filter(Boolean),
        };
    }
}

// Singleton instance
const performanceTracker = new ScraperPerformanceTracker();

/**
 * Shutdown function to clean up resources
 * MEMORY LEAK FIX: Clear cleanup interval and close database
 */
export function shutdown() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    console.log('[PERFORMANCE-CACHE] Cleanup interval stopped');
  }

  if (db) {
    try {
      db.close();
      db = null;
      console.log('[PERFORMANCE-CACHE] Database connection closed');
    } catch (error) {
      console.error(`[PERFORMANCE-CACHE] Error closing database: ${error.message}`);
    }
  }
}

export default performanceTracker;
export { ScraperPerformanceTracker, CONFIG };
