import DebridLink from './debrid-link.js'
import RealDebrid from './real-debrid.js'
import AllDebrid from './all-debrid.js'
import OffCloud from './offcloud.js'
import TorBox from './torbox.js'
import Premiumize from './premiumize.js'
import HomeMedia from './home-media.js'
import Cinemeta from './util/cinemeta.js'
import PTT from './util/parse-torrent-title.js'
import { BadRequestError } from './util/error-codes.js'
import fetch from 'node-fetch'

async function searchTorrents(config, searchKey) {
    let resultsPromise
    if (config.DebridLinkApiKey) {
        resultsPromise = DebridLink.searchTorrents(config.DebridLinkApiKey, searchKey)
    } else if (config.DebridProvider == "DebridLink") {
        resultsPromise = DebridLink.searchTorrents(config.DebridApiKey, searchKey)
    } else if (config.DebridProvider == "RealDebrid") {
        resultsPromise = RealDebrid.searchTorrents(config.DebridApiKey, searchKey)
    } else if (config.DebridProvider == "AllDebrid") {
        resultsPromise = AllDebrid.searchTorrents(config.DebridApiKey, searchKey)
    } else if (config.DebridProvider == "OffCloud") {
    resultsPromise = OffCloud.searchOffcloudTorrents(config.DebridApiKey, searchKey, 0.4)
    } else if (config.DebridProvider == "TorBox") {
        resultsPromise = Promise.resolve([])
    } else {
        return Promise.reject(BadRequestError)
    }

    return resultsPromise
        .then(torrents => torrents.map(torrent => toMeta(torrent)))
}

async function listTorrents(config, skip = 0, requestedType = null) {
    if (!config.ShowCatalog) {
        return Promise.resolve([])
    }

    let resultsPromise

    if (config.DebridLinkApiKey) {
        resultsPromise = DebridLink.listTorrents(config.DebridLinkApiKey, skip)
    } else if (config.DebridProvider == "DebridLink") {
        resultsPromise = DebridLink.listTorrents(config.DebridApiKey, skip)
    } else if (config.DebridProvider == "RealDebrid") {
        resultsPromise = RealDebrid.listTorrents(config.DebridApiKey, skip)
    } else if (config.DebridProvider == "AllDebrid") {
        resultsPromise = AllDebrid.listTorrents(config.DebridApiKey)
    } else if (config.DebridProvider == "OffCloud") {
        resultsPromise = OffCloud.listTorrents(config.DebridApiKey, skip)
    } else if (config.DebridProvider == "TorBox") {
        resultsPromise = Promise.resolve([])
    } else {
        return Promise.reject(BadRequestError)
    }

    let results = await resultsPromise;
    
    // Filter by requested type if specified
    if (requestedType && requestedType !== 'other') {
        results = results.filter(meta => meta.type === requestedType);
        console.log(`[CATALOG-PROVIDER] Filtered listTorrents to ${results.length} ${requestedType} items (requested type: ${requestedType})`);
    }
    
    return results;
}

async function listPersonalDownloads(config, serviceProvider = null, requestedType = null) {
    console.log('[CATALOG-PROVIDER] listPersonalDownloads called with serviceProvider:', serviceProvider);

    // Fetch personal downloads from all configured services or a specific service
    const services = [];

    // Check for HomeMedia service in main config
    if (config.HomeMediaUrl) {
        console.log('[CATALOG-PROVIDER] Found HomeMedia service in main config');
        if (!serviceProvider || serviceProvider.toLowerCase() === 'homemedia') {
            services.push({
                provider: 'HomeMedia',
                apiKey: config.HomeMediaApiKey,
                homeMediaUrl: config.HomeMediaUrl
            });
        }
    }

    // Filter to only supported providers for catalogs
    const supportedDebridProviders = ['realdebrid', 'alldebrid', 'torbox', 'offcloud', 'debridlink', 'premiumize'];

    if (config.DebridServices && Array.isArray(config.DebridServices)) {
        console.log('[CATALOG-PROVIDER] Found DebridServices:', config.DebridServices.map(s => s.provider));

        // Check for HomeMedia in DebridServices array
        const homeMediaService = config.DebridServices.find(s => s.provider.toLowerCase() === 'homemedia');
        if (homeMediaService && homeMediaService.homeMediaUrl) {
            console.log('[CATALOG-PROVIDER] Found HomeMedia in DebridServices with URL');
            if (!serviceProvider || serviceProvider.toLowerCase() === 'homemedia') {
                // Only add if not already added from config.HomeMediaUrl
                const alreadyAdded = services.some(s => s.provider.toLowerCase() === 'homemedia');
                if (!alreadyAdded) {
                    services.push({
                        provider: 'HomeMedia',
                        apiKey: homeMediaService.apiKey,
                        homeMediaUrl: homeMediaService.homeMediaUrl
                    });
                }
            }
        }

        // Add supported debrid services only
        config.DebridServices.forEach(service => {
            const normalizedProvider = service.provider.toLowerCase();

            // Skip if not a supported debrid provider or if it's HomeMedia (already handled above)
            if (!supportedDebridProviders.includes(normalizedProvider) || normalizedProvider === 'homemedia') {
                return;
            }

            // Case-insensitive comparison for service provider
            if (!serviceProvider || normalizedProvider === serviceProvider.toLowerCase()) {
                services.push({
                    provider: service.provider,
                    apiKey: service.apiKey
                });
            }
        });
    } else if (config.DebridProvider && config.DebridApiKey) {
        console.log('[CATALOG-PROVIDER] Found single DebridProvider:', config.DebridProvider);
        // Legacy single service format
        // Case-insensitive comparison for service provider
        if (!serviceProvider || config.DebridProvider.toLowerCase() === serviceProvider.toLowerCase()) {
            services.push({
                provider: config.DebridProvider,
                apiKey: config.DebridApiKey
            });
        }
    }

    console.log('[CATALOG-PROVIDER] Services to query:', services.map(s => s.provider));

    if (services.length === 0) {
        console.log('[CATALOG-PROVIDER] No debrid services configured for personal downloads');
        return [];
    }

    // Fetch downloads from all services in parallel
    const downloadPromises = services.map(async (service) => {
        try {
            console.log(`[CATALOG-PROVIDER] Fetching downloads from ${service.provider}...`);
            const downloads = await getServiceDownloads(service.provider, service.apiKey, service.homeMediaUrl);
            console.log(`[CATALOG-PROVIDER] Got ${downloads.length} downloads from ${service.provider}`);

            // Limit to last 50 downloads per service for performance (except HomeMedia)
            const isHomeMedia = service.provider.toLowerCase() === 'homemedia';
            let limitedDownloads = downloads;

            if (!isHomeMedia && downloads.length > 50) {
                limitedDownloads = downloads.slice(0, 50);
                console.log(`[CATALOG-PROVIDER] Limiting ${service.provider} from ${downloads.length} to 50 most recent downloads`);
            }

            return limitedDownloads.map(d => ({ ...d, service: service.provider }));
        } catch (error) {
            console.error(`[CATALOG-PROVIDER] Error fetching downloads from ${service.provider}: ${error.message}`);
            console.error(`[CATALOG-PROVIDER] Stack:`, error.stack);
            return [];
        }
    });

    const allDownloads = (await Promise.all(downloadPromises)).flat();
    console.log(`[CATALOG-PROVIDER] Total downloads from all services: ${allDownloads.length}`);

    // Enrich downloads with metadata matching
    console.log(`[CATALOG-PROVIDER] Starting metadata enrichment for ${allDownloads.length} downloads...`);
    const startTime = Date.now();

    const enrichedDownloads = await Promise.all(
        allDownloads.map(download => enrichDownloadWithMetadata(download))
    );

    const enrichmentTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[CATALOG-PROVIDER] Metadata enrichment completed in ${enrichmentTime}s`);

    // Convert to catalog metas
    let metas = enrichedDownloads.map(download => downloadToMeta(download));
    
    // Filter by requested type if specified
    if (requestedType && requestedType !== 'other') {
        metas = metas.filter(meta => meta.type === requestedType);
        console.log(`[CATALOG-PROVIDER] Filtered to ${metas.length} ${requestedType} items (requested type: ${requestedType})`);
    }
    
    console.log(`[CATALOG-PROVIDER] Returning ${metas.length} catalog metas`);

    return metas;
}

async function getServiceDownloads(provider, apiKey, homeMediaUrl = null) {
    const normalizedProvider = provider.toLowerCase();

    console.log(`[CATALOG-PROVIDER] getServiceDownloads called for provider: ${provider} (normalized: ${normalizedProvider})`);

    switch (normalizedProvider) {
        case 'homemedia':
            console.log(`[CATALOG-PROVIDER] Fetching HomeMedia files from: ${homeMediaUrl}`);
            const homeMediaFiles = await HomeMedia.listAllFiles(homeMediaUrl, apiKey) || [];
            console.log(`[CATALOG-PROVIDER] HomeMedia returned ${homeMediaFiles.length} files`);
            if (homeMediaFiles.length > 0) {
                console.log(`[CATALOG-PROVIDER] Sample HomeMedia file:`, JSON.stringify(homeMediaFiles[0]).substring(0, 200));
            }
            return homeMediaFiles;
        case 'realdebrid':
            return await RealDebrid.searchDownloads(apiKey, '', 1.0) || [];
        case 'alldebrid':
            return await AllDebrid.listTorrents(apiKey) || [];
        case 'debridlink':
            return await DebridLink.searchDownloads?.(apiKey, '', 1.0) || [];
        case 'offcloud':
            return await OffCloud.searchDownloads?.(apiKey, '', 1.0) || [];
        case 'premiumize':
            return await Premiumize.searchDownloads(apiKey, '', 1.0) || [];
        case 'torbox':
            console.log(`[CATALOG-PROVIDER] Fetching TorBox downloads with apiKey: ${apiKey ? '***' + apiKey.slice(-4) : 'undefined'}`);
            const torboxDownloads = await TorBox.searchDownloads(apiKey, '', 1.0) || [];
            console.log(`[CATALOG-PROVIDER] TorBox returned ${torboxDownloads.length} downloads`);
            if (torboxDownloads.length > 0) {
                console.log(`[CATALOG-PROVIDER] Sample TorBox download:`, JSON.stringify(torboxDownloads[0]).substring(0, 200));
            }
            return torboxDownloads;
        default:
            console.warn(`[CATALOG-PROVIDER] Unknown provider: ${provider}`);
            return [];
    }
}

async function enrichDownloadWithMetadata(download) {
    // Parse the filename to extract media information
    const parsed = PTT.parse(download.name || '');

    if (!parsed || !parsed.title) {
        return {
            ...download,
            enriched: false,
            displayTitle: download.name || 'Unknown',
            type: 'other'
        };
    }

    // Determine if it's a series or movie
    const isSeries = parsed.season !== undefined || parsed.episode !== undefined;
    const type = isSeries ? 'series' : 'movie';

    // Build display title with parsed info
    const displayTitle = isSeries
        ? `${parsed.title}${parsed.season ? ` S${String(parsed.season).padStart(2, '0')}` : ''}${parsed.episode ? `E${String(parsed.episode).padStart(2, '0')}` : ''}`
        : `${parsed.title}${parsed.year ? ` (${parsed.year})` : ''}`;

    // Try to find metadata from Cinemeta with timeout
    try {
        // Search Cinemeta catalog for matching title with 3 second timeout
        const searchQuery = encodeURIComponent(parsed.title);
        const catalogUrl = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${searchQuery}.json`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

        try {
            const response = await fetch(catalogUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();

                // Try to find best match based on title and year
                let bestMatch = null;
                if (data.metas && data.metas.length > 0) {
                    bestMatch = data.metas.find(meta => {
                        const titleMatch = meta.name.toLowerCase() === parsed.title.toLowerCase();
                        const yearMatch = !parsed.year || meta.year === String(parsed.year);
                        return titleMatch && yearMatch;
                    }) || data.metas[0]; // Fallback to first result

                    if (bestMatch) {
                        // Fetch full metadata with timeout
                        const metaController = new AbortController();
                        const metaTimeoutId = setTimeout(() => metaController.abort(), 2000); // 2 second timeout

                        try {
                            const fullMeta = await Cinemeta.getMeta(type, bestMatch.id);
                            clearTimeout(metaTimeoutId);

                            if (fullMeta) {
                                return {
                                    ...download,
                                    enriched: true,
                                    type,
                                    displayTitle: isSeries && parsed.season
                                        ? `${fullMeta.name} S${String(parsed.season).padStart(2, '0')}`
                                        : fullMeta.name,
                                    parsed,
                                    meta: fullMeta,
                                    imdbId: bestMatch.id,
                                    poster: fullMeta.poster,
                                    background: fullMeta.background
                                };
                            }
                        } catch (metaError) {
                            clearTimeout(metaTimeoutId);
                            // Fallback to basic match info without full metadata
                            return {
                                ...download,
                                enriched: true,
                                type,
                                displayTitle: isSeries && parsed.season
                                    ? `${bestMatch.name} S${String(parsed.season).padStart(2, '0')}`
                                    : bestMatch.name,
                                parsed,
                                imdbId: bestMatch.id,
                                poster: bestMatch.poster
                            };
                        }
                    }
                }
            }
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                // Timeout occurred, skip silently
            } else {
                throw fetchError;
            }
        }

        // If we couldn't find Cinemeta match, return with parsed info
        return {
            ...download,
            enriched: true,
            type,
            displayTitle,
            parsed
        };
    } catch (error) {
        // Log only non-network errors
        if (error.code !== 'ECONNRESET' && error.name !== 'FetchError') {
            console.error(`[CATALOG] Error enriching download "${download.name}": ${error.message}`);
        }
        return {
            ...download,
            enriched: true,
            type,
            displayTitle,
            parsed
        };
    }
}

function downloadToMeta(download) {
    const { service, displayTitle, type, parsed, enriched, poster, background, imdbId } = download;

    // Generate a unique ID for the download
    // Use IMDB ID if available for better integration with Stremio
    const id = imdbId || `${service}:download:${download.id || Buffer.from(download.name).toString('base64').substring(0, 20)}`;

    // Use poster from metadata if available
    const posterUrl = poster || null;
    const posterShape = 'poster';

    const meta = {
        id,
        name: displayTitle || download.name,
        type: type || 'other',
        poster: posterUrl,
        posterShape,
        description: `${service} • ${formatBytes(download.size)}`,
        // Store original download info for later retrieval
        _download: {
            service,
            originalName: download.name,
            size: download.size,
            url: download.url
        }
    };

    // Add background if available
    if (background) {
        meta.background = background;
    }

    // Add year if available from parsed data
    if (parsed && parsed.year) {
        meta.releaseInfo = String(parsed.year);
    }

    return meta;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function toMeta(torrent) {
    return {
        id: torrent.source + ':' + torrent.id,
        name: torrent.name,
        type: torrent.type,
        // poster: `https://img.icons8.com/ios/256/video--v1.png`,
        // posterShape: 'square'
    }
}



export default { searchTorrents, listTorrents, listPersonalDownloads }