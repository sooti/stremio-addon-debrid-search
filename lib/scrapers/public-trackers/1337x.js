import axios from 'axios';
import * as config from '../../config.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Helper function to extract year from title
function extractYear(title) {
    const yearMatch = title.match(/\b(19|20)\d{2}\b/);
    return yearMatch ? parseInt(yearMatch[0]) : null;
}

// Helper function to check if title matches search query with year more strictly
function titleMatchesQuery(title, query) {
    // Extract the year and name from the query
    const yearMatch = query.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? parseInt(yearMatch[0]) : null;
    const namePart = year ? query.replace(/\b(19|20)\d{2}\b/, '').trim() : query.trim();

    // Normalize title for comparison (also removing common word separators)
    const normalizedTitle = title.toLowerCase().replace(/[._\-:]/g, ' ').trim();

    if (year) {
        // If a year was specified in query, check if title has the exact same year
        const titleYear = extractYear(title);
        const yearMatches = titleYear === year;

        // For the name part, we need exact word matching to prevent "dudes" matching "dude"
        if (namePart) {
            // Create a regex pattern that looks for the name as a whole word
            const escapedNamePart = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const exactNamePattern = new RegExp(`\\b${escapedNamePart}\\b`, 'i');
            const nameMatches = exactNamePattern.test(normalizedTitle);
            return nameMatches && yearMatches;
        } else {
            // If no name part (only year in query), just match the year
            return yearMatches;
        }
    } else {
        // If no year in query, just check if the full query matches
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exactQueryPattern = new RegExp(`\\b${escapedQuery}\\b`, 'i');
        return exactQueryPattern.test(normalizedTitle);
    }
}

async function fetch1337xPage(base, query, page, timeout, signal, logPrefix, scraperName) {
    try {
        const searchUrl = page === 1
            ? `${base}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/`
            : `${base}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/?page=${page}`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching page ${page}: ${searchUrl}`);

        // When fetching pages in parallel, use a longer timeout to account for server load
        // But cap it to avoid hanging indefinitely
        const pageTimeout = Math.min(timeout * 2, 15000); // Double the timeout, max 15 seconds

        const response = await axios.get(searchUrl, {
            timeout: pageTimeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': `${base}/home/`,
                'Connection': 'keep-alive'
            }
        });

        const data = response.data;

        // Check if the response has the expected structure
        if (!data || !data.results || !Array.isArray(data.results)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no valid results found on page ${page}.`);
            return null;
        }

        return data;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} error fetching page ${page}: ${error.message}`);
        return null;
    }
}

export async function search1337x(query, signal, logPrefix, config) {
    const scraperName = '1337x';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.TORRENT_1337X_LIMIT || 200;
        const maxPages = config?.TORRENT_1337X_MAX_PAGES || 3;
        const base = ((config?.TORRENT_1337X_URL || ENV.TORRENT_1337X_URL) || 'https://1337x.bz').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        const results = [];
        const seen = new Set();

        // Determine how many pages to fetch based on limit and maxPages
        const pagesToFetch = Math.min(maxPages, Math.ceil(limit / 50)); // Assuming ~50 items per page

        // Create array of page numbers to fetch
        const pagePromises = [];
        for (let page = 1; page <= pagesToFetch; page++) {
            pagePromises.push(fetch1337xPage(base, query, page, timeout, signal, logPrefix, scraperName));
        }

        // Fetch all pages in parallel
        const allPageResults = await Promise.all(pagePromises);

        // Process all results from all pages
        for (const pageResult of allPageResults) {
            if (!pageResult) continue;

            const pageResults = pageResult.results;

            for (let i = 0; i < pageResults.length && results.length < limit; i++) {
                const item = pageResults[i];

                // Use the hash from the JSON if available, otherwise skip
                let infoHash = item.h; // Hash field from JSON response
                if (!infoHash) {
                    // If no hash in JSON, try to extract from pk (primary key)
                    infoHash = String(item.pk || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
                }

                if (!infoHash) continue; // Skip if no hash available

                // Normalize the hash to be sure it's a valid hex string
                infoHash = infoHash.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
                if (infoHash.length < 40) continue; // Info hashes should be 40 chars (20 bytes hex)

                // Skip if we've already seen this hash
                if (seen.has(infoHash)) continue;
                seen.add(infoHash);

                // Extract details from the JSON response
                const title = item.n || 'Unknown Title';  // Name field
                const seeders = parseInt(item.se) || 0;    // Seeders
                const leechers = parseInt(item.le) || 0;  // Leechers
                const size = parseInt(item.s) || 0;       // Size in bytes (already a number in the JSON)

                // Apply more strict filtering to match query terms and year
                if (config?.TORRENT_1337X_STRICT_MATCH && !titleMatchesQuery(title, query)) {
                    continue; // Skip results that don't match our query criteria more strictly
                }


                // Build magnet link using the hash from JSON
                const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;

                results.push({
                    Title: title,
                    InfoHash: infoHash,
                    Size: size,
                    Seeders: seeders,
                    Leechers: leechers,
                    Tracker: scraperName,
                    Langs: detectSimpleLangs(title),
                    Magnet: magnetLink
                });

                if (results.length >= limit) break;
            }
        }

        // If we hit the limit, we might have skipped some results, so we should re-check
        // to ensure we get as many results as possible while respecting the limit

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
