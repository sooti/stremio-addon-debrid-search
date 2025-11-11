/**
 * CORS middleware configuration
 */

import cors from 'cors';

/**
 * Get configured CORS middleware
 * @returns {Function} Express middleware
 */
export function getCorsMiddleware() {
    return cors();
}

export default getCorsMiddleware;
