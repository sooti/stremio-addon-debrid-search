// Token-bucket + concurrency limiter for Real-Debrid API calls
// Real-Debrid limits: 250 requests per minute
// Defaults can be tuned via env: RD_RATE_PER_MINUTE, RD_CONCURRENCY, RD_MAX_RETRIES

class RdRateLimiter {
  constructor({ ratePerMinute = 250, concurrency = 50, maxRetries = 5 } = {}) {
    this.capacity = ratePerMinute;
    this.tokens = ratePerMinute;
    this.queue = [];
    this.running = 0;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;

    // Gradual token refill: add 1 token every (60000/capacity) milliseconds
    // This distributes the rate evenly over the minute instead of bursting
    const refillRate = Math.max(1, Math.floor(60000 / this.capacity)); // e.g., 240ms for 250/min
    this.refillInterval = setInterval(() => {
      if (this.tokens < this.capacity) {
        this.tokens = Math.min(this.capacity, this.tokens + 1);
        this._drain();
      }
    }, refillRate);
  }

  async schedule(task, label = 'rd-call') {
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject, label, tries: 0, addedAt: Date.now() };
      this.queue.push(job);
      this._drain();
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
          job.resolve(result);
          this._drain();
        })
        .catch(err => {
          const status = err?.response?.status || err?.status;

          // Retry on 429 (rate limit) with exponential backoff
          if (status === 429 && job.tries < this.maxRetries) {
            job.tries += 1;
            const delay = Math.min(2000 * Math.pow(1.5, job.tries - 1), 10000); // Max 10s delay
            console.log(`[RD LIMITER] Rate limited (429), retry ${job.tries}/${this.maxRetries} after ${delay}ms`);

            setTimeout(() => {
              this.queue.unshift(job); // Add back to front of queue
              this.running -= 1;
              this._drain();
            }, delay);
            return;
          }

          // Max retries exceeded or other error
          if (status === 429) {
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
