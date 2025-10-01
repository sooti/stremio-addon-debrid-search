// Token-bucket + concurrency limiter for AllDebrid API calls
// Defaults can be tuned via env: AD_RATE_PER_MINUTE, AD_CONCURRENCY

class AdRateLimiter {
  constructor({ ratePerMinute = 600, concurrency = 10 } = {}) {
    this.capacity = ratePerMinute;
    this.tokens = ratePerMinute;
    this.queue = [];
    this.running = 0;
    this.concurrency = concurrency;
    this.refillInterval = setInterval(() => {
      this.tokens = this.capacity;
      this._drain();
    }, 60 * 1000);
  }

  async schedule(task, label = 'ad-call') {
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject, label, tries: 0 };
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
          if (status === 429 && job.tries < 2) {
            job.tries += 1;
            setTimeout(() => {
              this.queue.push(job);
              this.running -= 1;
              this._drain();
            }, 1000 * job.tries);
            return;
          }
          this.running -= 1;
          job.reject(err);
          this._drain();
        });
    }
  }
}

const limiter = new AdRateLimiter({
  ratePerMinute: parseInt(process.env.AD_RATE_PER_MINUTE || '600', 10),
  concurrency: parseInt(process.env.AD_CONCURRENCY || '10', 10)
});

export default limiter;

