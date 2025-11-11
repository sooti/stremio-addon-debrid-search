/**
 * Memory usage monitoring and cache cleanup
 */

/**
 * Function to check memory usage and clear caches if needed
 * @returns {boolean} True if memory usage is high
 */
function checkMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    const rssInMB = memoryUsage.rss / 1024 / 1024;
    const heapUsedInMB = memoryUsage.heapUsed / 1024 / 1024;

    // If we're using more than 700MB RSS or 400MB heap, log a warning and consider cleanup
    if (rssInMB > 700 || heapUsedInMB > 400) {
        console.warn(`[MEMORY] High memory usage - RSS: ${rssInMB.toFixed(2)}MB, Heap: ${heapUsedInMB.toFixed(2)}MB`);
        return true; // Indicate high memory usage
    }
    return false; // Memory usage is OK
}

/**
 * Get current memory usage stats
 */
function getMemoryStats() {
    const memoryUsage = process.memoryUsage();
    return {
        rss: (memoryUsage.rss / 1024 / 1024).toFixed(2) + ' MB',
        heapUsed: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
        heapTotal: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
        external: (memoryUsage.external / 1024 / 1024).toFixed(2) + ' MB'
    };
}

export {
    checkMemoryUsage,
    getMemoryStats
};
