import * as config from '../config.js';
import { getResolutionFromName, getQualityCategory, formatSize, getCodec } from './torrent-utils.js';

const debugLogsEnabled = process.env.DEBRID_DEBUG_LOGS === 'true' || process.env.RD_DEBUG_LOGS === 'true';
const MAX_PACKS_TO_INSPECT = parseInt(process.env.MAX_PACKS_TO_INSPECT, 10) || 5;

/**
 * A generic, tiered torrent cache checking and filtering processor.
 *
 * - Normalizes incoming torrent objects to avoid missing properties/crashes.
 * - Groups and prioritizes torrents by quality category and resolution.
 * - Optionally performs batch season-pack inspection for episodes.
 * - Applies per-quality and per-resolution quotas and optional codec diversification.
 *
 * @param {Array<Object>} torrents - list of torrent objects (may have different shapes)
 * @param {Object} handler - must implement checkCachedHashes(allHashes) and may implement:
 *                           liveCheckHash(hash), batchCheckSeasonPacks(setOfHashes, season, episode),
 *                           cleanup(), getIdentifier()
 * @param {Object|null} episodeInfo - { season: Number, episode: Number } for episode-scoped checks (optional)
 * @returns {Promise<Array<Object>>} cachedResults - list of torrents that were confirmed cached / accepted
 */
export async function processAndFilterTorrents(torrents, handler, episodeInfo = null) {
    const LOG_PREFIX = (handler && typeof handler.getIdentifier === 'function') ? handler.getIdentifier() : 'DEBRID';

    if (!torrents || torrents.length === 0) {
        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} CACHE] No external torrents provided to check.`);
        return [];
    }

    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Received ${torrents.length} external torrents to process.`);

    // Build allHashes from incoming torrents in a resilient way
    const allHashes = torrents
        .map(t => (t.InfoHash || t.infoHash || t.hash || '').toString().toLowerCase())
        .filter(Boolean);
    const preCachedHashes = new Set();
    try {
        const preChecked = await (handler.checkCachedHashes ? handler.checkCachedHashes(allHashes) : new Set());
        // normalize result to Set
        if (preChecked instanceof Set) {
            for (const h of preChecked) preCachedHashes.add(String(h).toLowerCase());
        } else if (Array.isArray(preChecked)) {
            preChecked.forEach(h => preCachedHashes.add(String(h).toLowerCase()));
        } else if (preChecked && typeof preChecked === 'object') {
            // possibly a Map-like object
            try {
                for (const k of preChecked.keys ? preChecked.keys() : []) preCachedHashes.add(String(k).toLowerCase());
            } catch (e) { /* ignore */ }
        }
    } catch (err) {
        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] checkCachedHashes failed: ${err?.message || err}`);
    }
    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Pre-checked ${allHashes.length} hashes, found ${preCachedHashes.size} cached.`);

    const cachedResults = [];
    const categoryResolutionTracker = {}; // { category: { resolution: count } }
    const codecTracker = {};              // { resolution: { h265: n, h264: n } }
    const resolutionTotalTracker = {};    // { resolution: totalAccepted }

    const defaultMax = parseInt(process.env.MAX_RESULTS_PER_QUALITY, 10) || 2;
    const qualityLimits = {
        'Remux': parseInt(process.env.MAX_RESULTS_REMUX, 10) || defaultMax,
        'BluRay': parseInt(process.env.MAX_RESULTS_BLURAY, 10) || defaultMax,
        'WEB/WEB-DL': parseInt(process.env.MAX_RESULTS_WEBDL, 10) || defaultMax,
        'BRRip/WEBRip': parseInt(process.env.MAX_RESULTS_WEBRIP, 10) || 1,
        'Audio-Focused': parseInt(process.env.MAX_RESULTS_AUDIO, 10) || 1,
        'Other': parseInt(process.env.MAX_RESULTS_OTHER, 10) || 10
    };

    // --- NORMALIZE TORRENT OBJECTS TO PREVENT CRASHES & ENSURE CONSISTENCY ---
    const enrichedTorrents = torrents.map(raw => {
        // normalize common properties into stable keys
        const name = (raw.name || raw.Title || raw.title || '').toString();
        const infoHash = (raw.InfoHash || raw.infoHash || raw.hash || '').toString().toLowerCase();
        const size = Number(raw.Size || raw.size || raw.filesize || raw.fileSize || 0) || 0;

        // IMPORTANT: pass normalized name into getQualityCategory to avoid mismatches
        const category = getQualityCategory(name);
        const resolution = getResolutionFromName(name);

        return {
            ...raw,
            name,
            category,
            resolution,
            size,
            InfoHash: infoHash
        };
    }).filter(t => t.InfoHash && t.name); // keep only torrents with a hash and a name

    console.log(`[${LOG_PREFIX} CACHE] Grouping and prioritizing ${enrichedTorrents.length} potential torrents.`);

    // Group by category -> resolution -> [torrents]
    const groupedTorrents = enrichedTorrents.reduce((groups, torrent) => {
        const { category, resolution } = torrent;
        if (!groups[category]) groups[category] = {};
        if (!groups[category][resolution]) groups[category][resolution] = [];
        groups[category][resolution].push(torrent);
        return groups;
    }, {});

    // Sort each group by size desc (bigger first)
    for (const category in groupedTorrents) {
        for (const resolution in groupedTorrents[category]) {
            groupedTorrents[category][resolution].sort((a, b) => b.size - a.size);
        }
    }

    // Season-pack handling: batch-check prioritized season packs (if episodeInfo + handler support)
    let validSeasonPackHashes = new Map(); // InfoHash -> hint (fileIndex/filePath/fileBytes)
    if (episodeInfo && handler && typeof handler.batchCheckSeasonPacks === 'function') {
        const { season, episode } = episodeInfo;
        const paddedSeason = String(season).padStart(2, '0');
        const paddedEpisode = String(episode).padStart(2, '0');

        const allSeasonPacks = [];
        for (const torrent of enrichedTorrents) {
            const lname = torrent.name.toLowerCase();
            // season pack pattern: "season 01" or "s01" but avoid matching "s01e02" (episode markers)
            const anyOtherEpisodePattern = new RegExp(`[sS]${paddedSeason}[eE](?!${paddedEpisode})\\d+`, 'i');
            const seasonPackPattern = new RegExp(`\\b(season|s|saison)\\s*${paddedSeason}\\b(?!\\d|\\s*e|\\s*x)`, 'i');

            if (seasonPackPattern.test(lname) && !anyOtherEpisodePattern.test(lname)) {
                allSeasonPacks.push(torrent);
            }
        }

        if (allSeasonPacks.length > 0) {
            // dedupe by InfoHash, then sort by quality/resolution/size
            const uniqueSeasonPacks = Array.from(new Map(allSeasonPacks.map(p => [p.InfoHash, p])).values());

            const qualityScore = { 'Remux': 5, 'BluRay': 4, 'WEB/WEB-DL': 3, 'BRRip/WEBRip': 2, 'Other': 1, 'Audio-Focused': 0 };
            const resolutionScore = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };

            uniqueSeasonPacks.sort((a, b) => {
                const scoreA = qualityScore[a.category] || 0;
                const scoreB = qualityScore[b.category] || 0;
                if (scoreA !== scoreB) return scoreB - scoreA;
                const rsA = resolutionScore[a.resolution] || 0;
                const rsB = resolutionScore[b.resolution] || 0;
                if (rsA !== rsB) return rsB - rsA;
                return b.size - a.size;
            });

            const MAX_ROUNDS = parseInt(process.env.MAX_PACK_ROUNDS || '3', 10);
            let round = 0;
            let offset = 0;
            while (round < MAX_ROUNDS && offset < uniqueSeasonPacks.length && validSeasonPackHashes.size < MAX_PACKS_TO_INSPECT) {
                const packsToInspect = uniqueSeasonPacks.slice(offset, offset + MAX_PACKS_TO_INSPECT);
                const seasonPackHashesToInspect = new Set(packsToInspect.map(p => p.InfoHash));

                if (seasonPackHashesToInspect.size > 0) {
                    console.log(`[${LOG_PREFIX} CACHE] Prioritized and selected ${seasonPackHashesToInspect.size} season packs for inspection (target valid packs: ${MAX_PACKS_TO_INSPECT})... [Round ${round + 1}/${MAX_ROUNDS}]`);
                    try {
                        const foundPacks = await handler.batchCheckSeasonPacks(seasonPackHashesToInspect, season, episode);
                        // Normalize foundPacks -> Map
                        const foundMap = (foundPacks instanceof Map)
                            ? foundPacks
                            : new Map(Array.from(foundPacks || []).map(h => [h, null]));

                        for (const [k, v] of foundMap.entries()) {
                            validSeasonPackHashes.set(String(k).toLowerCase(), v);
                        }
                        console.log(`[${LOG_PREFIX} CACHE] Found ${foundMap.size} valid packs in this round; total valid so far: ${validSeasonPackHashes.size}/${MAX_PACKS_TO_INSPECT}.`);
                    } catch (err) {
                        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] batchCheckSeasonPacks failed: ${err?.message || err}`);
                    }
                }

                round += 1;
                offset += MAX_PACKS_TO_INSPECT;
            }
        }
    }

    // Helper to collect a list of torrents for a tier (given categories & resolutions)
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

    // Checks all torrents in a given tier. Returns true if an early-exit condition was met.
    const checkTorrentsInTiers = async (tier) => {
        const earlyExitCategories = ['Remux', 'BluRay'];

        for (const torrent of tier.torrents) {
            const { category, resolution, InfoHash } = torrent;
            const name = (torrent.name || '').toLowerCase();

            // If episode-scoped, ensure torrent is relevant
            if (episodeInfo && episodeInfo.season != null && episodeInfo.episode != null) {
                const { season, episode } = episodeInfo;
                const paddedSeason = String(season).padStart(2, '0');
                const paddedEpisode = String(episode).padStart(2, '0');

                const specificEpisodePattern = new RegExp(`(?:[sS][\\W_]*${paddedSeason}[\\W_]*[eE][\\W_]*${paddedEpisode})|\\b${season}[\\W_]*x[\\W_]*${paddedEpisode}\\b`, 'i');
                const anyOtherEpisodePattern = new RegExp(`[sS]${paddedSeason}[eE](?!${paddedEpisode})\\d+`, 'i');
                const seasonPackPattern = new RegExp(`\\b(season|s|saison)\\s*${paddedSeason}\\b(?!\\d|\\s*e|\\s*x)`, 'i');
                const multiSeasonPackPattern = new RegExp(`seasons?\\s*(\\d+)\\s*[,-]?\\s*(\\d+)|s(\\d+)[-]?s(\\d+)`, 'i');

                const isSpecificEpisode = specificEpisodePattern.test(name);
                const isSeasonPack = seasonPackPattern.test(name) && !anyOtherEpisodePattern.test(name);

                let isRelevantMultiSeasonPack = false;
                const multiSeasonMatch = name.match(multiSeasonPackPattern);
                if (multiSeasonMatch) {
                    const startSeason = parseInt(multiSeasonMatch[1] || multiSeasonMatch[3], 10);
                    const endSeason = parseInt(multiSeasonMatch[2] || multiSeasonMatch[4], 10);
                    if (!isNaN(startSeason) && !isNaN(endSeason) && season >= startSeason && season <= endSeason) {
                        isRelevantMultiSeasonPack = true;
                    }
                }

                if (!isSpecificEpisode && !isSeasonPack && !isRelevantMultiSeasonPack) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Irrelevant episode: not S${paddedSeason}E${paddedEpisode}) | "${torrent.name.substring(0, 50)}"`);
                    continue;
                }

                // If it's a season pack, only accept if batch check confirmed it contains episode
                if (isSeasonPack) {
                    if (validSeasonPackHashes.has(InfoHash)) {
                        // Enforce per-quality limit
                        const limit = qualityLimits[category] || defaultMax;
                        const currentCount = categoryResolutionTracker[category]?.[resolution] || 0;
                        if (currentCount >= limit) {
                            if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED PACK (Limit Reached: ${currentCount}/${limit})`);
                            continue;
                        }

                        // Per-resolution cap
                        const resolutionCap = parseInt(config.TARGET_CODEC_COUNT, 10) || 0;
                        if (resolutionCap > 0) {
                            const resTotal = resolutionTotalTracker[resolution] || 0;
                            if (resTotal >= resolutionCap) {
                                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED PACK (Resolution cap reached: ${resTotal}/${resolutionCap} for ${resolution})`);
                                continue;
                            }
                        }

                        if (config.PRIORITY_SKIP_WEBRIP_ENABLED && (name.includes('webrip') || name.includes('brrip'))) {
                            if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED PACK (WEBRip disabled)`);
                            continue;
                        }
                        if (config.PRIORITY_SKIP_AAC_OPUS_ENABLED && (name.includes(' aac') || name.includes(' opus'))) {
                            if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED PACK (AAC/Opus disabled)`);
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
                                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED PACK (Codec limit for ${codec.toUpperCase()} reached)`);
                                    continue;
                                }
                            }
                        }

                        const hint = validSeasonPackHashes.get(InfoHash) || null;
                        cachedResults.push({ ...torrent, source: LOG_PREFIX.toLowerCase(), isCached: true, from: 'Batch Pack Inspection', episodeFileHint: hint });

                        categoryResolutionTracker[category] = categoryResolutionTracker[category] || {};
                        categoryResolutionTracker[category][resolution] = (categoryResolutionTracker[category][resolution] || 0) + 1;
                        resolutionTotalTracker[resolution] = (resolutionTotalTracker[resolution] || 0) + 1;

                        if (config.DIVERSIFY_CODECS_ENABLED) {
                            const codec = getCodec(torrent);
                            if (codec !== 'unknown') {
                                codecTracker[resolution][codec] = (codecTracker[resolution][codec] || 0) + 1;
                            }
                        }

                        console.log(`[${LOG_PREFIX} CACHE] ✅ CACHED PACK [${category} ${resolution}] via Batch Pack Inspection: "${torrent.name.substring(0, 50)}"`);
                    } else {
                        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Pack does not contain episode based on batch check)`);
                    }
                    // whether found or not, skip further per-file checks for this pack entry
                    continue;
                }
            }

            // Global priority toggles
            if (config.PRIORITY_SKIP_WEBRIP_ENABLED && (name.includes('webrip') || name.includes('brrip'))) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (WEBRip disabled)`);
                continue;
            }
            if (config.PRIORITY_SKIP_AAC_OPUS_ENABLED && (name.includes(' aac') || name.includes(' opus'))) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (AAC/Opus disabled)`);
                continue;
            }

            // Codec diversification enforcement
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

            if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> Checking [${category} ${resolution}] | Size: ${formatSize(torrent.size)} | "${torrent.name.substring(0, 50)}"`);

            // Per-category + resolution limit
            const limit = qualityLimits[category] || defaultMax;
            const currentCount = categoryResolutionTracker[category]?.[resolution] || 0;
            if (currentCount >= limit) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Limit Reached: ${currentCount}/${limit})`);
                continue;
            }

            // Enforce per-resolution total cap before doing hash checks
            const resolutionCap = parseInt(config.TARGET_CODEC_COUNT, 10) || 0;
            if (resolutionCap > 0) {
                const resTotal = resolutionTotalTracker[resolution] || 0;
                if (resTotal >= resolutionCap) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Resolution cap reached: ${resTotal}/${resolutionCap} for ${resolution})`);
                    continue;
                }
            }

            // Early-exit: stop searching if both Remux and BluRay quotas are met for 2160p and 1080p
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
                return true; // signal caller to stop
            }

            // Check cache status (fast pre-checks above followed by optional live check)
            let isCached = false;
            let from = '';

            if (preCachedHashes.has(InfoHash)) {
                isCached = true;
                from = 'API Batch';
            } else if (handler && typeof handler.liveCheckHash === 'function') {
                try {
                    const live = await handler.liveCheckHash(InfoHash);
                    if (live) {
                        isCached = true;
                        from = 'API Live';
                    }
                } catch (err) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] liveCheckHash failed for ${InfoHash}: ${err?.message || err}`);
                }
            }

            if (isCached) {
                cachedResults.push({ ...torrent, source: LOG_PREFIX.toLowerCase(), isCached: true, from });
                categoryResolutionTracker[category] = categoryResolutionTracker[category] || {};
                categoryResolutionTracker[category][resolution] = (categoryResolutionTracker[category][resolution] || 0) + 1;
                resolutionTotalTracker[resolution] = (resolutionTotalTracker[resolution] || 0) + 1;

                if (config.DIVERSIFY_CODECS_ENABLED) {
                    const codec = getCodec(torrent);
                    if (codec !== 'unknown') {
                        codecTracker[resolution][codec] = (codecTracker[resolution][codec] || 0) + 1;
                    }
                }

                console.log(`[${LOG_PREFIX} CACHE] ✅ CACHED [${category} ${resolution}] via ${from}: "${torrent.name.substring(0, 50)}"`);
            } else {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> NOT CACHED`);
            }
        } // end for each torrent in tier

        return false; // no early stop triggered by this tier
    };

    // Main processing loop over tiers
    try {
        for (const tier of allTiers) {
            if (tier.torrents.length > 0) {
                console.log(`[${LOG_PREFIX} CACHE] ⚙️ Checking Tier: ${tier.name} (${tier.torrents.length} torrents)`);
                const shouldStop = await checkTorrentsInTiers(tier);
                if (shouldStop) break;
            } else {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Tier ${tier.name} has no torrents, skipping.`);
            }
        }
    } finally {
        if (handler && typeof handler.cleanup === 'function') {
            try { await handler.cleanup(); } catch (e) { /* ignore cleanup errors */ }
        }
    }

    return cachedResults;
}
