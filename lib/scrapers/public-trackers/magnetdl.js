import * as config from '../../config.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const execPromise = promisify(exec);

export async function searchMagnetDL(query, signal, logPrefix, config) {
    const scraperName = 'MagnetDL';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.MAGNETDL_LIMIT || 200;
        const base = ((config?.MAGNETDL_URL || ENV.MAGNETDL_URL) || 'https://magnetdl.homes').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build the API URL for searching - using all categories by default
        const encodedQuery = encodeURIComponent(query).replace(/\%20/g, '+');
        const apiUrl = `${base}/api.php?url=/q.php?q=${encodedQuery}`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${apiUrl}`);

        // Use curl command to handle zstd compression properly
        // Escape single quotes in URLs by replacing ' with '\''
        const escapedApiUrl = apiUrl.replace(/'/g, "'\\''");
        const escapedBase = base.replace(/'/g, "'\\''");
        const curlCmd = `curl -s --compressed -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Referer: ${escapedBase}/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' '${escapedApiUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout: Math.max(timeout, 15000) });

        if (!stdout) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} received empty response.`);
            return [];
        }

        let resultsData;
        try {
            resultsData = JSON.parse(stdout);
        } catch (parseError) {
            console.error(`[${logPrefix} SCRAPER] ${scraperName} failed to parse JSON response:`, parseError.message);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} Response was:`, stdout.substring(0, 500));
            return [];
        }

        // Convert the response array/object to our standard format
        const resultArray = Array.isArray(resultsData) ? resultsData : Object.values(resultsData);
        const results = resultArray.slice(0, limit).map(item => {
            if (!item?.info_hash || !item?.name) return null;

            return {
                Title: item.name,
                InfoHash: item.info_hash.toLowerCase(), // Normalize to lowercase to match cache expectations
                Size: parseInt(item.size) || 0,
                Seeders: parseInt(item.seeders) || 0,
                Leechers: parseInt(item.leechers) || 0,
                Tracker: `${scraperName} | ${item.category ? `Cat:${item.category}` : 'Public'}`,
                Langs: detectSimpleLangs(item.name),
                Username: item.username,
                Added: item.added ? new Date(parseInt(item.added) * 1000).toISOString() : null
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchMagnetDLMovie(query, signal, logPrefix, config) {
    const scraperName = 'MagnetDL-Movie';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.MAGNETDL_LIMIT || 200;
        const base = ((config?.MAGNETDL_URL || ENV.MAGNETDL_URL) || 'https://magnetdl.homes').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build the API URL for searching with movie category (201)
        const encodedQuery = encodeURIComponent(query).replace(/\%20/g, '+');
        const apiUrl = `${base}/api.php?url=/q.php?q=${encodedQuery}&cat=201`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${apiUrl}`);

        // Use curl command to handle zstd compression properly
        // Escape single quotes in URLs by replacing ' with '\''
        const escapedApiUrl = apiUrl.replace(/'/g, "'\\''");
        const escapedBase = base.replace(/'/g, "'\\''");
        const curlCmd = `curl -s --compressed -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Referer: ${escapedBase}/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' '${escapedApiUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout: Math.max(timeout, 15000) });

        if (!stdout) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} received empty response.`);
            return [];
        }

        let resultsData;
        try {
            resultsData = JSON.parse(stdout);
        } catch (parseError) {
            console.error(`[${logPrefix} SCRAPER] ${scraperName} failed to parse JSON response:`, parseError.message);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} Response was:`, stdout.substring(0, 500));
            return [];
        }

        // Convert the response array/object to our standard format
        const resultArray = Array.isArray(resultsData) ? resultsData : Object.values(resultsData);
        const results = resultArray.slice(0, limit).map(item => {
            if (!item?.info_hash || !item?.name) return null;

            return {
                Title: item.name,
                InfoHash: item.info_hash.toLowerCase(), // Normalize to lowercase to match cache expectations
                Size: parseInt(item.size) || 0,
                Seeders: parseInt(item.seeders) || 0,
                Leechers: parseInt(item.leechers) || 0,
                Tracker: `${scraperName} | ${item.category ? `Cat:${item.category}` : 'Public'}`,
                Langs: detectSimpleLangs(item.name),
                Username: item.username,
                Added: item.added ? new Date(parseInt(item.added) * 1000).toISOString() : null
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}

export async function searchMagnetDLTV(query, signal, logPrefix, config) {
    const scraperName = 'MagnetDL-TV';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.MAGNETDL_LIMIT || 200;
        const base = ((config?.MAGNETDL_URL || ENV.MAGNETDL_URL) || 'https://magnetdl.homes').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build the API URL for searching with TV category (205)
        const encodedQuery = encodeURIComponent(query).replace(/\%20/g, '+');
        const apiUrl = `${base}/api.php?url=/q.php?q=${encodedQuery}&cat=205`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${apiUrl}`);

        // Use curl command to handle zstd compression properly
        // Escape single quotes in URLs by replacing ' with '\''
        const escapedApiUrl = apiUrl.replace(/'/g, "'\\''");
        const escapedBase = base.replace(/'/g, "'\\''");
        const curlCmd = `curl -s --compressed -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Referer: ${escapedBase}/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' '${escapedApiUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout: Math.max(timeout, 15000) });

        if (!stdout) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} received empty response.`);
            return [];
        }

        let resultsData;
        try {
            resultsData = JSON.parse(stdout);
        } catch (parseError) {
            console.error(`[${logPrefix} SCRAPER] ${scraperName} failed to parse JSON response:`, parseError.message);
            console.error(`[${logPrefix} SCRAPER] ${scraperName} Response was:`, stdout.substring(0, 500));
            return [];
        }

        // Convert the response array/object to our standard format
        const resultArray = Array.isArray(resultsData) ? resultsData : Object.values(resultsData);
        const results = resultArray.slice(0, limit).map(item => {
            if (!item?.info_hash || !item?.name) return null;

            return {
                Title: item.name,
                InfoHash: item.info_hash.toLowerCase(), // Normalize to lowercase to match cache expectations
                Size: parseInt(item.size) || 0,
                Seeders: parseInt(item.seeders) || 0,
                Leechers: parseInt(item.leechers) || 0,
                Tracker: `${scraperName} | ${item.category ? `Cat:${item.category}` : 'Public'}`,
                Langs: detectSimpleLangs(item.name),
                Username: item.username,
                Added: item.added ? new Date(parseInt(item.added) * 1000).toISOString() : null
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
