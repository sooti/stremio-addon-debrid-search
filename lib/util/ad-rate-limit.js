// Token-bucket + concurrency limiter for AllDebrid API calls
// AllDebrid limits: 600 requests per minute AND 12 requests per second
// Defaults can be tuned via env: AD_RATE_PER_MINUTE, AD_RATE_PER_SECOND, AD_CONCURRENCY, AD_MAX_RETRIES

class AdRateLimiter {
  constructor({ ratePerMinute = 600, ratePerSecond = 12, concurrency = 50, maxRetries = 5, maxQueueSize = 500 } = {}) {
    this.minuteCapacity = ratePerMinute;
    this.minuteTokens = ratePerMinute;
    this.secondCapacity = ratePerSecond;
    this.secondTokens = ratePerSecond;
    this.queue = [];
    this.running = 0;
    this.concurrency = Math.min(concurrency, 10); // Reduce concurrency to be more respectful
    this.maxRetries = maxRetries;
    this.maxQueueSize = maxQueueSize; // Prevent queue from growing indefinitely
    this.requestTimeout = 60000; // 60 second timeout per request

    // Gradual token refill: add tokens at appropriate rates to spread requests over time
    // Add 1 token every (60000/ratePerMinute) milliseconds to distribute per-minute rate
    const minuteRefillRate = Math.max(100, Math.floor(60000 / ratePerMinute)); // At least 100ms between refills
    this.minuteRefillInterval = setInterval(() => {
      if (this.minuteTokens < this.minuteCapacity) {
        this.minuteTokens = Math.min(this.minuteCapacity, this.minuteTokens + 1);
        this._drain();
      }
    }, minuteRefillRate);

    // Add 1 token every (1000/ratePerSecond) milliseconds to distribute per-second rate
    const secondRefillRate = Math.max(50, Math.floor(1000 / ratePerSecond)); // At least 50ms between refills
    this.secondRefillInterval = setInterval(() => {
      if (this.secondTokens < this.secondCapacity) {
        this.secondTokens = Math.min(this.secondCapacity, this.secondTokens + 1);
        this._drain();
      }
    }, secondRefillRate);
  }

  async schedule(task, label = 'ad-call') {
    return new Promise((resolve, reject) => {
      // Check queue size to prevent memory issues
      if (this.queue.length >= this.maxQueueSize) {
        reject(new Error(`[AD LIMITER] Queue is full (${this.queue.length}/${this.maxQueueSize}), rejecting request`));
        return;
      }

      const job = { task, resolve, reject, label, tries: 0, addedAt: Date.now() };

      // Set a timeout for this specific job
      const timeoutId = setTimeout(() => {
        // Remove from queue if still waiting
        const index = this.queue.indexOf(job);
        if (index > -1) {
          this.queue.splice(index, 1);
        }
        reject(new Error(`[AD LIMITER] Request timeout after ${this.requestTimeout}ms (waited in queue: ${Date.now() - job.addedAt}ms)`));
      }, this.requestTimeout);

      job.timeoutId = timeoutId;
      this.queue.push(job);

      // Add a small delay to help prevent burst requests
      setTimeout(() => this._drain(), 1);
    });
  }

  _drain() {
    // Must have tokens for BOTH minute and second limits, plus available concurrency slot
    while (this.minuteTokens > 0 && this.secondTokens > 0 && this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();

      // Clear the timeout since we're processing it now
      if (job.timeoutId) {
        clearTimeout(job.timeoutId);
      }

      this.minuteTokens -= 1;
      this.secondTokens -= 1;
      this.running += 1;

      Promise.resolve()
        .then(() => job.task())
        .then(result => {
          this.running -= 1;
          job.resolve(result);
          this._drain();
        })
        .catch(err => {
          const status = err?.response?.status || err?.status;

          // Retry on 429 (rate limit) with exponential backoff
          if (status === 429 && job.tries < this.maxRetries) {
            job.tries += 1;
            const delay = Math.min(2000 * Math.pow(1.5, job.tries - 1), 10000); // Max 10s delay
            console.log(`[AD LIMITER] Retry ${job.tries}/${this.maxRetries} after ${delay}ms`);

            setTimeout(() => {
              this.queue.unshift(job); // Add back to front of queue
              this.running -= 1;
              this._drain();
            }, delay);
            return;
          }

          // Max retries exceeded or other error
          if (status === 429) {
            console.error(`[AD LIMITER] Rate limit exhausted after ${job.tries} retries, giving up on request`);
          }

          this.running -= 1;
          job.reject(err);
          this._drain();
        });
    }
  }

  shutdown() {
    clearInterval(this.minuteRefillInterval);
    clearInterval(this.secondRefillInterval);
  }
}

// Manager to create per-API-key rate limiters for user isolation
class AdRateLimiterManager {
  constructor() {
    this.limiters = new Map(); // Map of apiKey -> AdRateLimiter
    this.cleanupInterval = setInterval(() => this._cleanup(), 300000); // Cleanup every 5 minutes
    this.limiterMaxAge = 600000; // Remove limiters unused for 10 minutes
  }

  getLimiter(apiKey) {
    if (!apiKey) {
      throw new Error('[AD LIMITER] API key is required for rate limiting');
    }

    // Use a hash of the API key to avoid storing full keys in memory
    const keyHash = this._hashKey(apiKey);

    if (!this.limiters.has(keyHash)) {
      console.log(`[AD LIMITER] Creating new rate limiter for user (hash: ${keyHash.substring(0, 8)}...)`);
      const limiter = new AdRateLimiter({
        ratePerMinute: parseInt(process.env.AD_RATE_PER_MINUTE || '600', 10),
        ratePerSecond: parseInt(process.env.AD_RATE_PER_SECOND || '12', 10),
        concurrency: parseInt(process.env.AD_CONCURRENCY || '50', 10),
        maxRetries: parseInt(process.env.AD_MAX_RETRIES || '5', 10),
        maxQueueSize: parseInt(process.env.AD_MAX_QUEUE_SIZE || '500', 10)
      });
      this.limiters.set(keyHash, {
        limiter,
        lastUsed: Date.now()
      });
    } else {
      // Update last used timestamp
      this.limiters.get(keyHash).lastUsed = Date.now();
    }

    return this.limiters.get(keyHash).limiter;
  }

  _hashKey(apiKey) {
    // Simple hash function for API key
    let hash = 0;
    for (let i = 0; i < apiKey.length; i++) {
      const char = apiKey.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  _cleanup() {
    const now = Date.now();
    const toRemove = [];

    for (const [keyHash, data] of this.limiters.entries()) {
      if (now - data.lastUsed > this.limiterMaxAge) {
        toRemove.push(keyHash);
        data.limiter.shutdown();
      }
    }

    if (toRemove.length > 0) {
      console.log(`[AD LIMITER] Cleaning up ${toRemove.length} unused rate limiters`);
      toRemove.forEach(keyHash => this.limiters.delete(keyHash));
    }
  }

  shutdown() {
    clearInterval(this.cleanupInterval);
    for (const data of this.limiters.values()) {
      data.limiter.shutdown();
    }
    this.limiters.clear();
  }

  getStats() {
    return {
      activeLimiters: this.limiters.size,
      limiters: Array.from(this.limiters.entries()).map(([keyHash, data]) => ({
        keyHash: keyHash.substring(0, 8) + '...',
        queueLength: data.limiter.queue.length,
        running: data.limiter.running,
        minuteTokens: data.limiter.minuteTokens,
        secondTokens: data.limiter.secondTokens,
        lastUsed: new Date(data.lastUsed).toISOString()
      }))
    };
  }
}

const manager = new AdRateLimiterManager();

// Export manager with backward-compatible interface
export default {
  schedule: (task, label, apiKey) => {
    if (!apiKey) {
      throw new Error('[AD LIMITER] API key is required. Update your code to pass apiKey as third parameter.');
    }
    const limiter = manager.getLimiter(apiKey);
    return limiter.schedule(task, label);
  },
  getLimiter: (apiKey) => manager.getLimiter(apiKey),
  getStats: () => manager.getStats(),
  shutdown: () => manager.shutdown()
};

