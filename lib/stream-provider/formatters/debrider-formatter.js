/**
 * Stream formatting for Debrider.app and Personal Cloud
 * Handles NZB streams and personal cloud files
 */

import { getResolutionFromName, formatSize } from '../../common/torrent-utils.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../util/language-mapping.js';
import { STREAM_NAME_MAP } from '../config/stream-names.js';

const ADDON_HOST = process.env.ADDON_URL;

/**
 * Convert Debrider.app/Personal Cloud details into a Stremio stream object
 *
 * @param {Object} details - File details from Debrider.app or Personal Cloud
 * @param {string} type - Content type ('movie' or 'series')
 * @param {Object} config - User configuration
 * @returns {Object} - Stremio stream object
 */
export function toDebriderStream(details, type, config) {
    const resolution = getResolutionFromName(details.fileName || details.name);
    // Set resolution label properly - 2160p shows as "4k", 1080p shows as "1080p", etc.
    let resolutionLabel;
    if (resolution === '2160p') {
        resolutionLabel = '4k';
    } else if (resolution === '1080p') {
        resolutionLabel = '1080p';
    } else if (resolution === '720p') {
        resolutionLabel = '720p';
    } else if (resolution === '480p') {
        resolutionLabel = '480p';
    } else {
        resolutionLabel = resolution; // fallback for other values
    }

    // Personal files get cloud icon, NZBs get download icon
    const icon = details.isPersonal ? '☁️' : (details.source === 'newznab' ? '📡' : '💾');
    const trackerInfo = details.tracker ? ` | ${details.tracker}` : '';
    // Detect languages from the title and render flags
    const detectedLanguages = detectLanguagesFromTitle(details.name || details.fileName || '');
    const flagsSuffix = renderLanguageFlags(detectedLanguages);

    let title = details.name;
    if (details.fileName) {
        title = `${details.name}/${details.fileName}`;
    }
    title = `${title}\n${icon} ${formatSize(details.size)}${trackerInfo}${flagsSuffix}`;

    // Use appropriate stream name map
    const sourceName = details.source === 'personalcloud' ? STREAM_NAME_MAP.personalcloud : STREAM_NAME_MAP.debriderapp;
    const name = `${sourceName}\n${resolutionLabel}`;

    // For NZB URLs, route through resolver endpoint with config
    let streamUrl = details.url;
    if (details.url.startsWith('nzb:')) {
        const base = ADDON_HOST || '';
        const provider = details.source === 'personalcloud' ? 'personalcloud' : 'debriderapp';
        const encodedApiKey = encodeURIComponent(config.DebridApiKey || '');
        const encodedUrl = encodeURIComponent(details.url);

        // Find the service config for this provider
        let serviceConfig = {};
        if (Array.isArray(config.DebridServices)) {
            const service = config.DebridServices.find(s =>
                (s.provider === 'DebriderApp' || s.provider === 'PersonalCloud')
            );
            if (service) {
                serviceConfig = {
                    PersonalCloudUrl: service.baseUrl || 'https://debrider.app/api/v1',
                    PersonalCloudNewznabApiKey: service.newznabApiKey || '',
                    newznabApiKey: service.newznabApiKey || ''
                };
            }
        }

        const configParam = encodeURIComponent(JSON.stringify(serviceConfig));
        streamUrl = (base && base.startsWith('http'))
            ? `${base}/resolve/${provider}/${encodedApiKey}/${encodedUrl}?config=${configParam}`
            : details.url;
    }

    return {
        name: name,
        title: title,
        url: streamUrl,
        isPersonal: details.isPersonal, // Keep track of personal files for sorting
        _size: details.size || 0,  // Preserve size for filtering
        behaviorHints: {
            directLink: !details.url.startsWith('nzb:'), // NZB links need processing
            bingeGroup: details.bingeGroup || `debriderapp|${details.infoHash || details.nzbTitle || 'unknown'}`
        }
    };
}
