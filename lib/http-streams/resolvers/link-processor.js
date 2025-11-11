/**
 * Link Processor Module
 * Handles decoding and processing of encrypted links
 */

import { base64Decode, rot13 } from '../utils/encoding.js';

/**
 * Decodes an encrypted string using multiple decoding layers
 * @param {string} encryptedString - Encrypted string to decode
 * @returns {Object|null} Decoded object or null on failure
 */
export function decodeString(encryptedString) {
    try {
        console.log('Starting decode with:', encryptedString);

        // First base64 decode
        let decoded = base64Decode(encryptedString);
        console.log('After first base64 decode:', decoded);

        // Second base64 decode
        decoded = base64Decode(decoded);
        console.log('After second base64 decode:', decoded);

        // ROT13 decode
        decoded = rot13(decoded);
        console.log('After ROT13 decode:', decoded);

        // Third base64 decode
        decoded = base64Decode(decoded);
        console.log('After third base64 decode:', decoded);

        // Parse JSON
        const result = JSON.parse(decoded);
        console.log('Final parsed result:', result);
        return result;
    } catch (error) {
        console.error('Error decoding string:', error);

        // Try alternative decoding approaches
        try {
            console.log('Trying alternative decode approach...');
            let altDecoded = base64Decode(encryptedString);
            altDecoded = base64Decode(altDecoded);
            const altResult = JSON.parse(altDecoded);
            console.log('Alternative decode successful:', altResult);
            return altResult;
        } catch (altError) {
            console.error('Alternative decode also failed:', altError);
            return null;
        }
    }
}
