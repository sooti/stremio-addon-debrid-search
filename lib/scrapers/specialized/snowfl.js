import { Snowfl } from 'snowfl-api';
import { getHashFromMagnet, sizeToBytes } from '../../common/torrent-utils.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';

export async function searchSnowfl(query, signal, logPrefix, config) {
    const scraperName = 'Snowfl';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    // Instantiate the Snowfl client
    const snowfl = new Snowfl();

    // Define abortHandler in function scope to be accessible in finally block
    let abortHandler = null;

    try {
        // --- REFACTORED LOGIC USING snowfl-api ---
        // Create a promise that rejects when the signal is aborted
        // Use an executor function that can be called to reject the promise
        let abortReject = null;
        const abortPromise = new Promise((_, reject) => {
            abortReject = reject;
        });

        // Set up the abort listener properly but with a mechanism to remove it
        abortHandler = () => {
            abortReject(new DOMException('Aborted', 'AbortError'));
        };

        signal.addEventListener('abort', abortHandler);

        // Race the API call against the abort promise
        const response = await Promise.race([
            snowfl.parse(query), // Default sort is 'NONE', matching the original logic
            abortPromise
        ]);

        // --- END OF REFACTORED LOGIC ---

        if (response.status !== 200 || !Array.isArray(response.data)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} returned a non-successful status or invalid data.`);
            return [];
        }

        // Map the API response to your standard torrent object format.
        const results = response.data.map(torrent => {
            if (!torrent.magnet) return null;

            const infoHash = getHashFromMagnet(torrent.magnet);
            if (!infoHash) return null;

            return {
                Title: torrent.name,
                InfoHash: infoHash,
                Size: sizeToBytes(torrent.size || '0 MB'),
                Seeders: parseInt(torrent.seeder) || 0,
                Tracker: `${scraperName} | ${torrent.site}`,
                Langs: detectSimpleLangs(torrent.name),
            };
        }).filter(Boolean); // Filter out any null entries

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        console.log('the torrents we found:  ', processedResults);
        return processedResults;

    } catch (error) {
        // The centralized error handler will catch AbortError as well
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        // Clean up the event listener to prevent memory leaks
        if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
        }
        console.timeEnd(timerLabel);
    }
}
