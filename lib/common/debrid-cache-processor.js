// lib/common/debrid-cache-processor.js

import * as config from '../config.js';
import { getResolutionFromName, getQualityCategory, formatSize, getCodec } from './torrent-utils.js';

const debugLogsEnabled = process.env.DEBRID_DEBUG_LOGS === 'true' || process.env.RD_DEBUG_LOGS === 'true';

/**
 * A generic, tiered torrent cache checking and filtering processor.
 * @param {Array<Object>} torrents - The list of external torrents to process.
 * @param {Object} handler - An object with service-specific implementations.
 * @param {() => string} handler.getIdentifier - Returns the log prefix (e.g., 'RD', 'OC').
 * @param {(hashes: string[]) => Promise<Set<string>>} handler.checkCachedHashes - Checks a batch of hashes and returns a Set of those that are cached.
 * @param {(hash: string) => Promise<boolean>} [handler.liveCheckHash] - (Optional) Checks a single hash live if not in the initial batch.
 * @param {() => Promise<void>} [handler.cleanup] - (Optional) Performs cleanup actions after processing.
 * @param {Object} [episodeInfo] - (Optional) Information about the specific episode being searched for.
 * @param {number} episodeInfo.season - The season number.
 * @param {number} episodeInfo.episode - The episode number.
 * @returns {Promise<Array<Object>>} A promise that resolves to the list of cached torrents.
 */
export async function processAndFilterTorrents(torrents, handler, episodeInfo = null) {
    const LOG_PREFIX = handler.getIdentifier();

    if (!torrents || torrents.length === 0) {
        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} CACHE] No external torrents provided to check.`);
        return [];
    }

    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Received ${torrents.length} external torrents to process.`);

    const allHashes = torrents.map(t => (t.InfoHash || t.infoHash || t.hash || '').toLowerCase()).filter(Boolean);
    const preCachedHashes = await handler.checkCachedHashes(allHashes);
    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Pre-checked ${allHashes.length} hashes, found ${preCachedHashes.size} cached.`);

    const cachedResults = [];
    const categoryResolutionTracker = {};
    const codecTracker = {}; 

    const defaultMax = parseInt(process.env.MAX_RESULTS_PER_QUALITY, 10) || 2;
    const qualityLimits = {
        'Remux': parseInt(process.env.MAX_RESULTS_REMUX, 10) || defaultMax,
        'BluRay': parseInt(process.env.MAX_RESULTS_BLURAY, 10) || defaultMax,
        'WEB/WEB-DL': parseInt(process.env.MAX_RESULTS_WEBDL, 10) || defaultMax,
        'BRRip/WEBRip': parseInt(process.env.MAX_RESULTS_WEBRIP, 10) || 1,
        'Audio-Focused': parseInt(process.env.MAX_RESULTS_AUDIO, 10) || 1,
        'Other': parseInt(process.env.MAX_RESULTS_OTHER, 10) || 1
    };
    
    console.log(`[${LOG_PREFIX} CACHE] Grouping and prioritizing ${torrents.length} potential torrents.`);
    const groupedTorrents = torrents
        .map(torrent => ({
            ...torrent,
            category: getQualityCategory(torrent),
            resolution: getResolutionFromName(torrent.name || torrent.Title || torrent.title),
            size: torrent.Size || torrent.size || torrent.filesize || 0,
            InfoHash: (torrent.InfoHash || torrent.infoHash || torrent.hash || '').toLowerCase()
        }))
        .filter(t => t.InfoHash)
        .reduce((groups, torrent) => {
            const { category, resolution } = torrent;
            if (!groups[category]) groups[category] = {};
            if (!groups[category][resolution]) groups[category][resolution] = [];
            groups[category][resolution].push(torrent);
            return groups;
        }, {});

    for (const category in groupedTorrents) {
        for (const resolution in groupedTorrents[category]) {
            groupedTorrents[category][resolution].sort((a, b) => b.size - a.size);
        }
    }
    
    const getTier = (categories, resolutions) => {
        let tierTorrents = [];
        for (const category of categories) {
            if (groupedTorrents[category]) {
                for (const resolution of resolutions) {
                    if (groupedTorrents[category][resolution]) {
                        tierTorrents.push(...groupedTorrents[category][resolution]);
                    }
                }
            }
        }
        tierTorrents.sort((a, b) => b.size - a.size);
        return tierTorrents;
    };
    
    const highQualityCategories = ['Remux', 'BluRay', 'WEB/WEB-DL'];
    const lowQualityCategories = ['BRRip/WEBRip'];
    const lastResortCategories = ['Audio-Focused', 'Other'];

    const tier1_Best = getTier(highQualityCategories, ['2160p', '1080p']);
    const tier2_Fallback = getTier(highQualityCategories, ['720p']);
    const tier3_Compromise = getTier(lowQualityCategories, ['2160p', '1080p', '720p']);
    const tier4_LastResort = getTier(lastResortCategories, ['2160p', '1080p', '720p', '480p']);

    const allTiers = [
        { name: 'Golden (4K/1080p HQ)', torrents: tier1_Best },
        { name: 'Fallback (720p HQ)', torrents: tier2_Fallback },
        { name: 'Compromise (Rips)', torrents: tier3_Compromise },
        { name: 'Last Resort (Other)', torrents: tier4_LastResort }
    ];

    const checkTorrentsInTiers = async (tier) => {
        const earlyExitCategories = ['Remux', 'BluRay'];

        for (const torrent of tier.torrents) {
            const { category, resolution, InfoHash } = torrent;
            const name = (torrent.name || torrent.Title || '').toLowerCase();

            // **START: EPISODE RELEVANCY CHECK**
            if (episodeInfo && episodeInfo.season && episodeInfo.episode) {
                const { season, episode } = episodeInfo;
                const paddedSeason = String(season).padStart(2, '0');
                const paddedEpisode = String(episode).padStart(2, '0');

                const specificEpisodePattern = new RegExp(`[sS]${paddedSeason}[eE]${paddedEpisode}|\\b${season}x${paddedEpisode}\\b`, 'i');
                const anyEpisodePattern = new RegExp(`[sS]${paddedSeason}[eE]\\d+`, 'i');
                const seasonPackPattern = new RegExp(`\\b(season|saison|s)\\s*${season}\\b(?!\\d|x\\d)`, 'i'); // e.g., S16, Season 16, but not S16E03 or 16x04
                const multiSeasonPackPattern = new RegExp(`seasons?\\s*(\\d+)\\s*[,-]?\\s*(\\d+)|s(\\d+)[-]?s(\\d+)`, 'i');

                const isSpecificEpisode = specificEpisodePattern.test(name);
                const isSeasonPack = seasonPackPattern.test(name) && !anyEpisodePattern.test(name);
                let isRelevantMultiSeasonPack = false;

                const multiSeasonMatch = name.match(multiSeasonPackPattern);
                if (multiSeasonMatch) {
                    const startSeason = parseInt(multiSeasonMatch[1] || multiSeasonMatch[3], 10);
                    const endSeason = parseInt(multiSeasonMatch[2] || multiSeasonMatch[4], 10);
                    if (season >= startSeason && season <= endSeason) {
                        isRelevantMultiSeasonPack = true;
                    }
                }
                
                if (!isSpecificEpisode && !isSeasonPack && !isRelevantMultiSeasonPack) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Irrelevant episode: not S${paddedSeason}E${paddedEpisode}) | "${(torrent.name || torrent.Title || '').substring(0, 50)}"`);
                    continue;
                }
            }
            // **END: EPISODE RELEVANCY CHECK**

            if (config.PRIORITY_SKIP_WEBRIP_ENABLED && (name.includes('webrip') || name.includes('brrip'))) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (WEBRip disabled)`);
                continue;
            }
            if (config.PRIORITY_SKIP_AAC_OPUS_ENABLED && (name.includes(' aac') || name.includes(' opus'))) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (AAC/Opus disabled)`);
                continue;
            }

            if (config.DIVERSIFY_CODECS_ENABLED) {
                const codec = getCodec(torrent);
                if (codec !== 'unknown') {
                    codecTracker[resolution] = codecTracker[resolution] || { h265: 0, h264: 0 };
                    const currentCodecCount = codecTracker[resolution][codec] || 0;
                    const maxForCodec = codec === 'h265' 
                        ? parseInt(config.MAX_H265_RESULTS_PER_QUALITY, 10) 
                        : parseInt(config.MAX_H264_RESULTS_PER_QUALITY, 10);

                    if (currentCodecCount >= maxForCodec) {
                        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Codec limit for ${codec.toUpperCase()} reached)`);
                        continue;
                    }
                }
            }

            if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> Checking [${category} ${resolution}] | Size: ${formatSize(torrent.size)} | "${(torrent.name || torrent.Title || '').substring(0, 50)}"`);
            
            const limit = qualityLimits[category] || defaultMax;
            const currentCount = categoryResolutionTracker[category]?.[resolution] || 0;
            if (currentCount >= limit) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Limit Reached: ${currentCount}/${limit})`);
                continue;
            }

            let canEarlyExit = true;
            for (const exitCategory of earlyExitCategories) {
                const limitForExit = qualityLimits[exitCategory] || defaultMax;
                const is2160pMet = (categoryResolutionTracker[exitCategory]?.['2160p'] || 0) >= limitForExit;
                const is1080pMet = (categoryResolutionTracker[exitCategory]?.['1080p'] || 0) >= limitForExit;
                
                if (!is2160pMet || !is1080pMet) {
                    canEarlyExit = false;
                    break;
                }
            }
            if (canEarlyExit) {
                console.log(`[${LOG_PREFIX} CACHE] ✅ Early exit condition met. Found max results for target categories: ${earlyExitCategories.join(', ')}`);
                return true; 
            }

            let isCached = false;
            let from = '';

            if (preCachedHashes.has(InfoHash)) {
                isCached = true;
                from = 'API Batch';
            } else if (handler.liveCheckHash) {
                isCached = await handler.liveCheckHash(InfoHash);
                if (isCached) from = 'API Live';
            }

            if (isCached) {
                cachedResults.push({ ...torrent, source: LOG_PREFIX.toLowerCase(), isCached: true, from });
                categoryResolutionTracker[category] = categoryResolutionTracker[category] || {};
                categoryResolutionTracker[category][resolution] = (categoryResolutionTracker[category][resolution] || 0) + 1;
                
                if (config.DIVERSIFY_CODECS_ENABLED) {
                    const codec = getCodec(torrent);
                    if (codec !== 'unknown') {
                        codecTracker[resolution][codec] = (codecTracker[resolution][codec] || 0) + 1;
                    }
                }

                console.log(`[${LOG_PREFIX} CACHE] ✅ CACHED [${category} ${resolution}] via ${from}: "${(torrent.name || torrent.Title).substring(0, 50)}"`);
            } else {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> NOT CACHED`);
            }
        }
        return false;
    };
    
    try {
        for (const tier of allTiers) {
            if (tier.torrents.length > 0) {
                console.log(`[${LOG_PREFIX} CACHE] ⚙️ Checking Tier: ${tier.name} (${tier.torrents.length} torrents)`);
                const shouldStop = await checkTorrentsInTiers(tier);
                if (shouldStop) break;
            }
        }
    } finally {
        if (handler.cleanup) {
            await handler.cleanup();
        }
    }
    
    return cachedResults;
}
