// lib/util/cinemeta.js
import fetch from 'node-fetch';

// Manual metadata overrides for cases where Cinemeta has incorrect data
const METADATA_OVERRIDES = {
    'tt15416342': {
        name: 'The Bengal Files',
        year: '2025',
        imdb_id: 'tt15416342'
    }
};

async function getMeta(type, imdbId) {
    try {
        // Check for manual override first
        if (METADATA_OVERRIDES[imdbId]) {
            console.log(`[Cinemeta] Using manual override for ${imdbId}: ${METADATA_OVERRIDES[imdbId].name} (${METADATA_OVERRIDES[imdbId].year})`);
            return METADATA_OVERRIDES[imdbId];
        }

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
