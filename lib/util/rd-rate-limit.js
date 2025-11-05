// Token-bucket + concurrency limiter for Real-Debrid API calls
// Real-Debrid limits: 250 requests per minute
// Defaults can be tuned via env: RD_RATE_PER_MINUTE, RD_CONCURRENCY, RD_MAX_RETRIES

class RdRateLimiter {
  constructor({ ratePerMinute = 250, concurrency = 50, maxRetries = 5, maxQueueSize = 500 } = {}) {
    this.capacity = ratePerMinute;
    this.tokens = ratePerMinute;
    this.queue = [];
    this.running = 0;
    this.concurrency = Math.min(concurrency, 15); // Reduce concurrency to be more respectful
    this.maxRetries = maxRetries;
    this.maxQueueSize = maxQueueSize; // Prevent queue from growing indefinitely
    this.consecutive429s = 0; // Track consecutive 429 errors
    this.rateLimitAbort = false; // Flag to abort cache checking
    this.requestTimeout = 60000; // 60 second timeout per request

    // Gradual token refill: add 1 token every (60000/capacity) milliseconds
    // This distributes the rate evenly over the minute instead of bursting
    const refillRate = Math.max(100, Math.floor(60000 / this.capacity)); // e.g., 240ms for 250/min, minimum 100ms
    this.refillInterval = setInterval(() => {
      if (this.tokens < this.capacity) {
        this.tokens = Math.min(this.capacity, this.tokens + 1);
        this._drain();
      }
    }, refillRate);
  }

  isRateLimitAborted() {
    return this.rateLimitAbort;
  }

  resetRateLimitAbort() {
    this.consecutive429s = 0;
    this.rateLimitAbort = false;
  }

  async schedule(task, label = 'rd-call') {
    return new Promise((resolve, reject) => {
      // Check queue size to prevent memory issues
      if (this.queue.length >= this.maxQueueSize) {
        reject(new Error(`[RD LIMITER] Queue is full (${this.queue.length}/${this.maxQueueSize}), rejecting request`));
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
        reject(new Error(`[RD LIMITER] Request timeout after ${this.requestTimeout}ms (waited in queue: ${Date.now() - job.addedAt}ms)`));
      }, this.requestTimeout);

      job.timeoutId = timeoutId;
      this.queue.push(job);

      // Add a small delay to help prevent burst requests
      setTimeout(() => this._drain(), 1);
    });
  }

  _drain() {
    while (this.tokens > 0 && this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();

      // Clear the timeout since we're processing it now
      if (job.timeoutId) {
        clearTimeout(job.timeoutId);
      }

      this.tokens -= 1;
      this.running += 1;

      Promise.resolve()
        .then(() => job.task())
        .then(result => {
          this.running -= 1;
          this.consecutive429s = 0; // Reset on success
          job.resolve(result);
          this._drain();
        })
        .catch(err => {
          const status = err?.response?.status || err?.status;

          // Track consecutive 429s and abort after 2
          if (status === 429) {
            this.consecutive429s += 1;
            console.log(`[RD LIMITER] Rate limited (429), consecutive count: ${this.consecutive429s}`);

            if (this.consecutive429s >= 2) {
              this.rateLimitAbort = true;
              console.error(`[RD LIMITER] 2 consecutive 429 errors detected - aborting cache check`);
              this.running -= 1;
              job.reject(err);
              this._drain();
              return;
            }

            // Retry with a small delay to be more respectful of rate limits
            if (job.tries < this.maxRetries) {
              job.tries += 1;
              const delay = Math.min(1000 * job.tries, 5000); // Increasing delay: 1s, 2s, 3s... max 5s
              console.log(`[RD LIMITER] Retrying after ${delay}ms (${job.tries}/${this.maxRetries})...`);

              setTimeout(() => {
                this.queue.unshift(job); // Add back to front of queue
                this._drain();
              }, delay);
              return;
            }

            // Max retries exceeded
            console.error(`[RD LIMITER] Rate limit exhausted after ${job.tries} retries, giving up on request`);
          }

          this.running -= 1;
          job.reject(err);
          this._drain();
        });
    }
  }

  shutdown() {
    clearInterval(this.refillInterval);
  }
}

// Manager to create per-API-key rate limiters for user isolation
class RdRateLimiterManager {
  constructor() {
    this.limiters = new Map(); // Map of apiKey -> RdRateLimiter
    this.cleanupInterval = setInterval(() => this._cleanup(), 300000); // Cleanup every 5 minutes
    this.limiterMaxAge = 600000; // Remove limiters unused for 10 minutes
  }

  getLimiter(apiKey) {
    if (!apiKey) {
      throw new Error('[RD LIMITER] API key is required for rate limiting');
    }

    // Use a hash of the API key to avoid storing full keys in memory
    const keyHash = this._hashKey(apiKey);

    if (!this.limiters.has(keyHash)) {
      console.log(`[RD LIMITER] Creating new rate limiter for user (hash: ${keyHash.substring(0, 8)}...)`);
      const limiter = new RdRateLimiter({
        ratePerMinute: parseInt(process.env.RD_RATE_PER_MINUTE || '250', 10),
        concurrency: parseInt(process.env.RD_CONCURRENCY || '50', 10),
        maxRetries: parseInt(process.env.RD_MAX_RETRIES || '5', 10),
        maxQueueSize: parseInt(process.env.RD_MAX_QUEUE_SIZE || '500', 10)
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
      console.log(`[RD LIMITER] Cleaning up ${toRemove.length} unused rate limiters`);
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
        tokens: data.limiter.tokens,
        lastUsed: new Date(data.lastUsed).toISOString()
      }))
    };
  }
}

const manager = new RdRateLimiterManager();

// Export manager with backward-compatible interface
export default {
  schedule: (task, label, apiKey) => {
    if (!apiKey) {
      throw new Error('[RD LIMITER] API key is required. Update your code to pass apiKey as third parameter.');
    }
    const limiter = manager.getLimiter(apiKey);
    return limiter.schedule(task, label);
  },
  getLimiter: (apiKey) => manager.getLimiter(apiKey),
  getStats: () => manager.getStats(),
  shutdown: () => manager.shutdown()
};
