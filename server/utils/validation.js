/**
 * Parameter validation utilities
 */

/**
 * Parse and validate config parameter from query string
 * @param {string} configParam - Config parameter from query string
 * @param {number} maxSize - Maximum allowed size in bytes (default 100KB)
 * @returns {object|null} Parsed config or null if invalid
 * @throws {Error} If config is too large or invalid
 */
export function parseConfigParam(configParam, maxSize = 100000) {
    if (!configParam) {
        return null;
    }

    try {
        // Safe parsing with memory and size limits
        const decodedConfigParam = decodeURIComponent(configParam);

        // Check size before parsing to prevent memory issues
        if (decodedConfigParam.length > maxSize) {
            throw new Error('Config parameter too large');
        }

        return JSON.parse(decodedConfigParam);
    } catch (e) {
        throw new Error(`Failed to parse config: ${e.message}`);
    }
}

/**
 * Validate Usenet configuration
 * @param {object} config - Configuration object
 * @returns {boolean} True if valid
 */
export function validateUsenetConfig(config) {
    if (!config) {
        return false;
    }

    return !!(
        config.newznabUrl &&
        config.newznabApiKey &&
        config.sabnzbdUrl &&
        config.sabnzbdApiKey
    );
}

/**
 * Validate required parameters are present
 * @param {object} params - Parameters object
 * @param {string[]} requiredParams - Array of required parameter names
 * @returns {object} { valid: boolean, missing: string[] }
 */
export function validateRequiredParams(params, requiredParams) {
    const missing = [];

    for (const param of requiredParams) {
        if (!params[param] || params[param] === 'undefined') {
            missing.push(param);
        }
    }

    return {
        valid: missing.length === 0,
        missing
    };
}

export default {
    parseConfigParam,
    validateUsenetConfig,
    validateRequiredParams
};
