// Token-bucket + concurrency limiter for Real-Debrid API calls
// Real-Debrid limits: 250 requests per minute
// Defaults can be tuned via env: RD_RATE_PER_MINUTE, RD_CONCURRENCY, RD_MAX_RETRIES

class RdRateLimiter {
  constructor({ ratePerMinute = 250, concurrency = 50, maxRetries = 5 } = {}) {
    this.capacity = ratePerMinute;
    this.tokens = ratePerMinute;
    this.queue = [];
    this.running = 0;
    this.concurrency = Math.min(concurrency, 15); // Reduce concurrency to be more respectful
    this.maxRetries = maxRetries;
    this.consecutive429s = 0; // Track consecutive 429 errors
    this.rateLimitAbort = false; // Flag to abort cache checking

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
      const job = { task, resolve, reject, label, tries: 0, addedAt: Date.now() };
      this.queue.push(job);
      
      // Add a small delay to help prevent burst requests
      setTimeout(() => this._drain(), 1);
    });
  }

  _drain() {
    while (this.tokens > 0 && this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
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

const limiter = new RdRateLimiter({
  ratePerMinute: parseInt(process.env.RD_RATE_PER_MINUTE || '250', 10),
  concurrency: parseInt(process.env.RD_CONCURRENCY || '50', 10),
  maxRetries: parseInt(process.env.RD_MAX_RETRIES || '5', 10)
});

export default limiter;
