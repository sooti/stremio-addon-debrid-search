/**
 * Authentication middleware for admin routes
 */

/**
 * Simple admin authentication middleware
 * Checks for ADMIN_PASSWORD environment variable
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Next middleware
 */
export function checkAdminAuth(req, res, next) {
    const password = req.query.password || req.headers['x-admin-password'];
    const expectedPassword = process.env.ADMIN_PASSWORD;

    if (!expectedPassword) {
        return res.status(501).send('Admin authentication not configured. Set ADMIN_PASSWORD environment variable.');
    }

    if (password !== expectedPassword) {
        return res.status(401).send('Unauthorized. Provide correct password via ?password= query parameter or X-Admin-Password header.');
    }

    next();
}

export default checkAdminAuth;
