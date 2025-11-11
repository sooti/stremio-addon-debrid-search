/**
 * Compression middleware configuration
 * Import compression if available, otherwise provide a no-op middleware
 */

let compression = null;

try {
    compression = (await import('compression')).default;
} catch (e) {
    console.warn('Compression middleware not available, using no-op middleware');
    compression = () => (req, res, next) => next(); // No-op if compression not available
}

/**
 * Get configured compression middleware
 * Performance: Add compression for API responses
 * @returns {Function} Express middleware
 */
export function getCompressionMiddleware() {
    return compression({
        level: 6, // Balanced compression level
        threshold: 1024 // Only compress responses larger than 1KB
    });
}

export default getCompressionMiddleware;
