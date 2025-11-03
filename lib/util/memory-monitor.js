import logger from './logger.js';

// Memory monitoring utility that checks memory usage and logs errors when thresholds are exceeded
class MemoryMonitor {
  constructor(options = {}) {
    this.maxRssThreshold = options.maxRssThreshold || 1024 * 1024 * 1024; // 1GB in bytes
    this.maxHeapThreshold = options.maxHeapThreshold || 512 * 1024 * 1024; // 512MB in bytes
    this.checkInterval = options.checkInterval || 30000; // 30 seconds
    this.monitorInterval = null;
    this.isEnabled = true;
  }

  // Format bytes to human-readable format
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Get current memory usage
  getMemoryUsage() {
    const usage = process.memoryUsage();
    const rss = usage.rss;
    const heapUsed = usage.heapUsed;
    const heapTotal = usage.heapTotal;
    
    return {
      timestamp: new Date().toISOString(),
      rss: {
        bytes: rss,
        formatted: this.formatBytes(rss),
        isExceeded: rss > this.maxRssThreshold
      },
      heap: {
        used: {
          bytes: heapUsed,
          formatted: this.formatBytes(heapUsed),
          isExceeded: heapUsed > this.maxHeapThreshold
        },
        total: {
          bytes: heapTotal,
          formatted: this.formatBytes(heapTotal)
        },
        utilization: (heapUsed / heapTotal * 100).toFixed(2) + '%'
      }
    };
  }

  // Log memory usage with configurable log level
  logMemoryUsage(level = 'info', message = 'Memory usage check') {
    const memory = this.getMemoryUsage();

    // Check if any threshold is exceeded
    const isRssExceeded = memory.rss.isExceeded;
    const isHeapExceeded = memory.heap.used.isExceeded;
    
    if (isRssExceeded || isHeapExceeded) {
      // Log as error when thresholds are exceeded
      logger.error(`[MEMORY] ⚠️ ${message}`);
      logger.error(`[MEMORY] RSS: ${memory.rss.formatted} (${isRssExceeded ? 'EXCEEDED' : 'OK'}) - Threshold: ${this.formatBytes(this.maxRssThreshold)}`);
      logger.error(`[MEMORY] Heap Used: ${memory.heap.used.formatted} (${isHeapExceeded ? 'EXCEEDED' : 'OK'}) - Threshold: ${this.formatBytes(this.maxHeapThreshold)}`);
      logger.error(`[MEMORY] Heap Total: ${memory.heap.total.formatted} | Utilization: ${memory.heap.utilization}`);
      logger.error(`[MEMORY] Timestamp: ${memory.timestamp}`);
      
      // Additional debugging info
      this.logMemoryDetails();
    } else if (level === 'debug') {
      // Only log detailed info if debug level requested and no thresholds exceeded
      logger.debug(`[MEMORY] ${message}`);
      logger.debug(`[MEMORY] RSS: ${memory.rss.formatted} | Heap Used: ${memory.heap.used.formatted} | Total: ${memory.heap.total.formatted} | Util: ${memory.heap.utilization}`);
    } else {
      // Always log basic info if not debug level
      logger.info(`[MEMORY] ${message}`);
      logger.info(`[MEMORY] RSS: ${memory.rss.formatted} | Heap Used: ${memory.heap.used.formatted} | Utilization: ${memory.heap.utilization}`);
    }
  }

  // Log detailed memory information for debugging
  logMemoryDetails() {
    const memory = process.memoryUsage();
    
    logger.error(`[MEMORY] Detailed Usage:`);
    logger.error(`[MEMORY]   external: ${this.formatBytes(memory.external)}`);
    logger.error(`[MEMORY]   rss: ${this.formatBytes(memory.rss)}`);
    logger.error(`[MEMORY]   heapTotal: ${this.formatBytes(memory.heapTotal)}`);
    logger.error(`[MEMORY]   heapUsed: ${this.formatBytes(memory.heapUsed)}`);
    logger.error(`[MEMORY]   arrayBuffers: ${this.formatBytes(memory.arrayBuffers)}`);
  }

  // Start periodic memory monitoring
  startMonitoring() {
    if (this.monitorInterval) {
      logger.warn('[MEMORY] Memory monitoring is already running');
      return;
    }

    this.isEnabled = true;
    
    // Log initial memory usage
    this.logMemoryUsage('info', 'Memory monitoring started');
    
    // Set up periodic monitoring
    this.monitorInterval = setInterval(() => {
      this.logMemoryUsage('info', 'Periodic memory check');
    }, this.checkInterval);

    // Don't keep Node.js process running because of this interval
    this.monitorInterval.unref();
    
    logger.info(`[MEMORY] Memory monitoring started - checking every ${this.checkInterval/1000}s`);
    logger.info(`[MEMORY] RSS Threshold: ${this.formatBytes(this.maxRssThreshold)}`);
    logger.info(`[MEMORY] Heap Threshold: ${this.formatBytes(this.maxHeapThreshold)}`);
  }

  // Stop periodic memory monitoring
  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      this.isEnabled = false;
      logger.info('[MEMORY] Memory monitoring stopped');
    }
  }

  // One-time check and log if thresholds are exceeded
  checkMemory() {
    if (!this.isEnabled) return;
    
    const memory = this.getMemoryUsage();
    const isRssExceeded = memory.rss.isExceeded;
    const isHeapExceeded = memory.heap.used.isExceeded;
    
    if (isRssExceeded || isHeapExceeded) {
      logger.error(`[MEMORY] ⚠️ Memory threshold exceeded!`);
      logger.error(`[MEMORY] RSS: ${memory.rss.formatted} - Heap Used: ${memory.heap.used.formatted}`);
      logger.error(`[MEMORY] RSS Exceeded: ${isRssExceeded ? 'YES' : 'NO'} | Heap Exceeded: ${isHeapExceeded ? 'YES' : 'NO'}`);
      
      // Log more details when thresholds are exceeded
      this.logMemoryDetails();
    }
  }
}

// Create a default instance with environment-configurable thresholds
const memoryMonitor = new MemoryMonitor({
  maxRssThreshold: parseInt(process.env.MEMORY_RSS_THRESHOLD || '1073741824'), // 1GB by default
  maxHeapThreshold: parseInt(process.env.MEMORY_HEAP_THRESHOLD || '536870912'), // 512MB by default
  checkInterval: parseInt(process.env.MEMORY_CHECK_INTERVAL || '30000') // 30s by default
});

export { MemoryMonitor, memoryMonitor };
export default memoryMonitor;