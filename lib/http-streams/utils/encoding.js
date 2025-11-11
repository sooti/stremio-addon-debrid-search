/**
 * Encoding utilities for HTTP streams
 * Handles base64, rot13, and URL encoding operations
 */

import { URL } from 'url';

/**
 * Decodes a base64 encoded string
 * @param {string} str - Base64 encoded string
 * @returns {string} Decoded string
 */
export function base64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf-8');
}

/**
 * Encodes a string to base64
 * @param {string} str - String to encode
 * @returns {string} Base64 encoded string
 */
export function base64Encode(str) {
    return Buffer.from(str, 'utf-8').toString('base64');
}

/**
 * Applies ROT13 cipher to a string
 * @param {string} str - String to encode/decode
 * @returns {string} ROT13 encoded/decoded string
 */
export function rot13(str) {
    return str.replace(/[A-Za-z]/g, function(char) {
        const start = char <= 'Z' ? 65 : 97;
        return String.fromCharCode(((char.charCodeAt(0) - start + 13) % 26) + start);
    });
}

/**
 * Attempts to decode a string if it appears to be base64 encoded
 * @param {string} str - Potentially base64 encoded string
 * @returns {string} Decoded string if valid base64, original string otherwise
 */
export function tryDecodeBase64(str) {
    try {
        if (str && str.length > 20 && /^[A-Za-z0-9+/=]+$/.test(str) && !str.includes(' ')) {
            const decoded = base64Decode(str);
            if (!/[^\x20-\x7E]/.test(decoded)) {
                return decoded;
            }
        }
    } catch (e) {
        // Not a valid base64 string
    }
    return str;
}

/**
 * Encodes URLs for streaming, being careful not to over-encode existing encoded URLs
 * @param {string} url - URL to encode
 * @returns {string} Encoded URL
 */
export function encodeUrlForStreaming(url) {
    if (!url) return url;

    // Don't re-encode already encoded URLs
    if (url.includes('%')) {
        // If it's already partially encoded, return as-is to avoid double encoding
        return url;
    }

    // For URLs with special characters that need encoding
    try {
        // Use URL constructor to handle the encoding properly
        const urlObj = new URL(url);
        // The URL constructor already handles proper encoding
        return urlObj.toString();
    } catch (e) {
        // If URL is malformed, do selective encoding
        return url
            .replace(/ /g, '%20')  // Encode spaces
            .replace(/#/g, '%23')  // Encode hash (fragment identifier)
            .replace(/\[/g, '%5B') // Encode brackets
            .replace(/\]/g, '%5D')
            .replace(/{/g, '%7B') // Encode braces
            .replace(/}/g, '%7D');
    }
}
