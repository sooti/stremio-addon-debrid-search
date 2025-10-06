// Token-bucket + concurrency limiter for AllDebrid API calls
// AllDebrid limits: 600 requests per minute AND 12 requests per second
// Defaults can be tuned via env: AD_RATE_PER_MINUTE, AD_RATE_PER_SECOND, AD_CONCURRENCY, AD_MAX_RETRIES

class AdRateLimiter {
  constructor({ ratePerMinute = 600, ratePerSecond = 12, concurrency = 50, maxRetries = 5 } = {}) {
    this.minuteCapacity = ratePerMinute;
    this.minuteTokens = ratePerMinute;
    this.secondCapacity = ratePerSecond;
    this.secondTokens = ratePerSecond;
    this.queue = [];
    this.running = 0;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;

    // Refill per-minute tokens every minute
    this.minuteRefillInterval = setInterval(() => {
      this.minuteTokens = this.minuteCapacity;
      this._drain();
    }, 60 * 1000);

    // Refill per-second tokens every second
    this.secondRefillInterval = setInterval(() => {
      this.secondTokens = this.secondCapacity;
      this._drain();
    }, 1000);
  }

  async schedule(task, label = 'ad-call') {
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject, label, tries: 0, addedAt: Date.now() };
      this.queue.push(job);
      this._drain();
    });
  }

  _drain() {
    // Must have tokens for BOTH minute and second limits, plus available concurrency slot
    while (this.minuteTokens > 0 && this.secondTokens > 0 && this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
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
            console.log(`[AD LIMITER] Rate limited (429), retry ${job.tries}/${this.maxRetries} after ${delay}ms`);

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

const limiter = new AdRateLimiter({
  ratePerMinute: parseInt(process.env.AD_RATE_PER_MINUTE || '600', 10),
  ratePerSecond: parseInt(process.env.AD_RATE_PER_SECOND || '12', 10),
  concurrency: parseInt(process.env.AD_CONCURRENCY || '50', 10),
  maxRetries: parseInt(process.env.AD_MAX_RETRIES || '5', 10)
});

export default limiter;

