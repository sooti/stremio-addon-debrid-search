// lib/util/cinemeta.js
import fetch from 'node-fetch';

async function getMeta(type, imdbId) {
    try {
        const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);

        // Check if the request was successful
        if (!response.ok) {
            console.error(`[Cinemeta] Received a ${response.status} response for ${type}:${imdbId}`);
            // Return null or a fallback object if meta is not found
            return null; 
        }

        const body = await response.json();
        return body && body.meta;

    } catch (err) {
        console.error(`[Cinemeta] A network or parsing error occurred:`, err);
        // Throwing an error here is okay, but we can also return null
        return null;
    }
}

export default { getMeta };
