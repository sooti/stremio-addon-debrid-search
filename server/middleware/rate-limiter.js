/**
 * Rate limiter middleware configuration
 */

import rateLimit from 'express-rate-limit';
import requestIp from 'request-ip';

/**
 * Get configured rate limiter middleware
 * @returns {Function} Express middleware
 */
export function getRateLimiter() {
    return rateLimit({
        windowMs: 120 * 120 * 1000,
        limit: 1000,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => requestIp.getClientIp(req)
    });
}

export default getRateLimiter;
