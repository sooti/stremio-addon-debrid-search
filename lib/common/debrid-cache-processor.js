import * as config from '../config.js';
import { getResolutionFromName, formatSize, getCodec } from './torrent-utils.js';

const debugLogsEnabled = process.env.DEBRID_DEBUG_LOGS === 'true' || process.env.RD_DEBUG_LOGS === 'true';
const MAX_PACKS_TO_INSPECT = parseInt(process.env.MAX_PACKS_TO_INSPECT, 10) || 5;

// Corrected version of the function is now defined locally to ensure it's used
function getQualityCategory(torrentName) {
    const name = (torrentName || '').toLowerCase();

    if (config.PRIORITY_PENALTY_AAC_OPUS_ENABLED && /(\s|\.)(aac|opus)\b/.test(name)) {
        return 'Audio-Focused';
    }
    
    if (/\bremux\b/.test(name)) {
        return 'Remux';
    }

    if (/\b(web-?rip|brrip|dlrip|bluray\s*rip)\b/.test(name)) {
        return 'BRRip/WEBRip';
    }
    
    if (/\b(blu-?ray|bdrip)\b/.test(name)) {
        return 'BluRay';
    }

    if (/\b(web-?\.?dl|web\b)/.test(name)) {
        return 'WEB/WEB-DL';
    }

    return 'Other';
}


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
 * liveCheckHash(hash), batchCheckSeasonPacks(setOfHashes, season, episode),
 * cleanup(), getIdentifier()
 * @param {Object|null} episodeInfo - { season: Number, episode: Number } for episode-scoped checks (optional)
 * @param {Object} satisfiedQuotas - { [category]: count } of already satisfied quotas (optional)
 * @returns {Promise<Array<Object>>} cachedResults - list of torrents that were confirmed cached / accepted
 */
export async function processAndFilterTorrents(torrents, handler, episodeInfo = null, satisfiedQuotas = {}) {
    const LOG_PREFIX = (handler && typeof handler.getIdentifier === 'function') ? handler.getIdentifier() : 'DEBRID';

    if (!torrents || torrents.length === 0) {
        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} CACHE] No external torrents provided to check.`);
        return [];
    }

    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Received ${torrents.length} external torrents to process.`);

    const allHashes = torrents
        .map(t => (t.InfoHash || t.infoHash || t.hash || '').toString().toLowerCase())
        .filter(Boolean);
    
    const preCachedHashes = new Set();
    
    // Initialize quality limits before any references
    const defaultMax = parseInt(process.env.MAX_RESULTS_PER_QUALITY, 10) || 2;
    const qualityLimits = {
        'Remux': parseInt(process.env.MAX_RESULTS_REMUX, 10) || defaultMax,
        'BluRay': parseInt(process.env.MAX_RESULTS_BLURAY, 10) || defaultMax,
        'WEB/WEB-DL': parseInt(process.env.MAX_RESULTS_WEBDL, 10) || defaultMax,
        'BRRip/WEBRip': parseInt(process.env.MAX_RESULTS_WEBRIP, 10) || 1,
        'Audio-Focused': parseInt(process.env.MAX_RESULTS_AUDIO, 10) || 1,
        'Other': parseInt(process.env.MAX_RESULTS_OTHER, 10) || 10
    };

    // Support both legacy and new shapes for satisfied quotas
    // Legacy: { Remux: 1, BluRay: 0, ... }
    // New: { byCategory: { Remux: 1, ... }, byCategoryResolution: { Remux: { '2160p': 1, '1080p': 0 }, ... } }
    const sq = satisfiedQuotas || {};
    const sqByCategory = typeof sq.byCategory === 'object' ? (sq.byCategory || {}) : sq; // fallback to legacy shape
    const sqByCategoryRes = (sq.byCategoryResolution && typeof sq.byCategoryResolution === 'object') ? sq.byCategoryResolution : {};

    const getSatisfiedByCategory = (category) => {
        const val = sqByCategory?.[category];
        if (typeof val === 'number') return val;
        // If only by-resolution provided, sum it
        const byRes = sqByCategoryRes?.[category] || {};
        return Object.values(byRes).reduce((a, b) => a + (Number(b) || 0), 0);
    };
    const getSatisfiedByCategoryRes = (category, resolution) => {
        const byRes = sqByCategoryRes?.[category];
        if (byRes && typeof byRes === 'object') {
            return Number(byRes[resolution] || 0);
        }
        // Legacy shape does not contain per-resolution info
        return 0;
    };

    // Check if quality quotas have been satisfied by "DB" (personal files) by looking at satisfiedQuotas parameter
    // Calculate remaining quotas needed after "DB" (personal files) are counted
    const remainingQuotas = {};
    let anyQuotaRemaining = false;
    
    for (const [category, limit] of Object.entries(qualityLimits)) {
        const satisfiedCount = getSatisfiedByCategory(category);
        const remaining = Math.max(0, limit - satisfiedCount);
        remainingQuotas[category] = remaining;
        if (remaining > 0) anyQuotaRemaining = true;
    }
    
    if (!anyQuotaRemaining) {
        console.log(`[${LOG_PREFIX} CACHE] All quality quotas already satisfied by DB (personal files), skipping cache check for ${allHashes.length} external torrents`);
        return []; // No need to process external torrents if all quotas are satisfied
    }
    
    console.log(`[${LOG_PREFIX} CACHE] After DB accounting, need to fill remaining quotas:`, remainingQuotas);
    
    try {
        console.log(`[${LOG_PREFIX} CACHE] Checking ${allHashes.length} external torrents against cache (these are not in personal DB)`);
        const preChecked = await (handler.checkCachedHashes ? handler.checkCachedHashes(allHashes) : new Set());
        if (preChecked instanceof Set) {
            for (const h of preChecked) preCachedHashes.add(String(h).toLowerCase());
        } else if (Array.isArray(preChecked)) {
            preChecked.forEach(h => preCachedHashes.add(String(h).toLowerCase()));
        } else if (preChecked && typeof preChecked === 'object') {
            try {
                for (const k of preChecked.keys ? preChecked.keys() : []) preCachedHashes.add(String(k).toLowerCase());
            } catch (e) { /* ignore */ }
        }
    } catch (err) {
        if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] checkCachedHashes failed: ${err?.message || err}`);
    }
    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Pre-checked ${allHashes.length} hashes, found ${preCachedHashes.size} cached.`);

    const cachedResults = [];
    const categoryResolutionTracker = {};
    const codecTracker = {};
    const resolutionTotalTracker = {};

    // Initialize categoryResolutionTracker with already satisfied quotas from DB (we track only new external additions here)
    for (const [category, count] of Object.entries(sqByCategory)) {
        // Initialize this category's resolution tracking with 0s
        categoryResolutionTracker[category] = {};
        // This means we start counting from scratch for each resolution within each category
        // The count from 'satisfiedQuotas' represents what's already satisfied by DB (personal files)
        // but we'll track new additions from external sources separately
    }

    const enrichedTorrents = torrents.map(raw => {
        const name = (raw.name || raw.Title || raw.title || '').toString();
        const infoHash = (raw.InfoHash || raw.infoHash || raw.hash || '').toString().toLowerCase();
        const size = Number(raw.Size || raw.size || raw.filesize || raw.fileSize || 0) || 0;
        
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
    }).filter(t => t.InfoHash && t.name);

    console.log(`[${LOG_PREFIX} CACHE] Grouping and prioritizing ${enrichedTorrents.length} potential torrents.`);

    const groupedTorrents = enrichedTorrents.reduce((groups, torrent) => {
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
    
    const inspectAllSeasonPacks = async () => {
        if (!episodeInfo || !handler || typeof handler.batchCheckSeasonPacks !== 'function') {
            return;
        }

        const { season, episode } = episodeInfo;
        const paddedSeason = String(season).padStart(2, '0');
        const paddedEpisode = String(episode).padStart(2, '0');

        const allSeasonPacks = [];
        for (const torrent of enrichedTorrents) {
            const lname = torrent.name.toLowerCase();
            const anyOtherEpisodePattern = new RegExp(`[sS]${paddedSeason}[eE](?!${paddedEpisode})\\d+`, 'i');
            const seasonPackPattern = new RegExp(`\\b(season|s|saison)\\s*${paddedSeason}\\b(?!\\d|\\s*e|\\s*x)`, 'i');

            if (seasonPackPattern.test(lname) && !anyOtherEpisodePattern.test(lname)) {
                allSeasonPacks.push(torrent);
            }
        }

        if (allSeasonPacks.length === 0) {
            return;
        }

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

        let validSeasonPackHashes = new Map();
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

        for (const pack of uniqueSeasonPacks) {
            if (validSeasonPackHashes.has(pack.InfoHash)) {
                const { category, resolution, name } = pack;
                
                // Per-release-type per-resolution limit
                categoryResolutionTracker[category] = categoryResolutionTracker[category] || {};
                const limit = qualityLimits[category] || defaultMax;
                const satisfiedByDBRes = getSatisfiedByCategoryRes(category, resolution);
                const neededFromExternalRes = Math.max(0, limit - satisfiedByDBRes);
                const currentTotalInThisRes = categoryResolutionTracker[category][resolution] || 0;
                if (currentTotalInThisRes >= neededFromExternalRes) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED pack (Per-res limit reached for ${category} ${resolution}: ${currentTotalInThisRes}/${neededFromExternalRes} ext needed after DB)`);
                    continue;
                }
                
                if (config.DIVERSIFY_CODECS_ENABLED) {
                    const codec = getCodec(pack);
                    if (codec !== 'unknown') {
                        const maxForCodec = codec === 'h265' ? parseInt(config.MAX_H265_RESULTS_PER_QUALITY, 10) : parseInt(config.MAX_H264_RESULTS_PER_QUALITY, 10);
                        if ((codecTracker[resolution]?.[codec] || 0) >= maxForCodec) continue;
                    }
                }
                const hint = validSeasonPackHashes.get(pack.InfoHash) || null;
                cachedResults.push({ ...pack, source: LOG_PREFIX.toLowerCase(), isCached: true, from: 'Batch Pack Inspection', episodeFileHint: hint });
                categoryResolutionTracker[category][resolution] = (categoryResolutionTracker[category][resolution] || 0) + 1;
                resolutionTotalTracker[resolution] = (resolutionTotalTracker[resolution] || 0) + 1;
                if (config.DIVERSIFY_CODECS_ENABLED) {
                    const codec = getCodec(pack);
                    if (codec !== 'unknown') {
                        codecTracker[resolution] = codecTracker[resolution] || { h265: 0, h264: 0 };
                        codecTracker[resolution][codec] = (codecTracker[resolution][codec] || 0) + 1;
                    }
                }
                console.log(`[${LOG_PREFIX} CACHE] ✅ CACHED PACK [${category} ${resolution}] via Batch Pack Inspection: "${name.substring(0, 50)}"`);
            }
        }
    };

    const checkTorrentsInTiers = async (tier) => {
        const earlyExitCategories = ['Remux', 'BluRay'];
        const earlyExitResolutions = ['2160p', '1080p'];

        for (const torrent of tier.torrents) {
            const { category, resolution, InfoHash } = torrent;
            const name = (torrent.name || '').toLowerCase();

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

                if (isSeasonPack || isRelevantMultiSeasonPack) {
                    continue;
                }
            }

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

            if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> Checking [${category} ${resolution}] | Size: ${formatSize(torrent.size)} | "${torrent.name.substring(0, 50)}"`);

            // Enforce per-release-type per-resolution limits
            categoryResolutionTracker[category] = categoryResolutionTracker[category] || {};
            const limit = qualityLimits[category] || defaultMax;
            const satisfiedByDBRes = getSatisfiedByCategoryRes(category, resolution);
            const neededFromExternalRes = Math.max(0, limit - satisfiedByDBRes);
            const currentTotalInThisRes = categoryResolutionTracker[category][resolution] || 0;
            if (currentTotalInThisRes >= neededFromExternalRes) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Per-res limit reached for ${category} ${resolution}: ${currentTotalInThisRes}/${neededFromExternalRes} ext needed after DB)`);
                continue;
            }

            const resolutionCap = parseInt(config.TARGET_CODEC_COUNT, 10) || 0;
            if (resolutionCap > 0) {
                const resTotal = resolutionTotalTracker[resolution] || 0;
                if (resTotal >= resolutionCap) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Resolution cap reached: ${resTotal}/${resolutionCap} for ${resolution})`);
                    continue;
                }
            }

            let canEarlyExit = true;
            for (const exitCategory of earlyExitCategories) {
                const limitForExit = qualityLimits[exitCategory] || defaultMax;
                for (const res of earlyExitResolutions) {
                    const satisfiedByDBExitRes = getSatisfiedByCategoryRes(exitCategory, res);
                    const neededFromExternalExitRes = Math.max(0, limitForExit - satisfiedByDBExitRes);
                    const currentTotalExitRes = categoryResolutionTracker[exitCategory]?.[res] || 0;
                    if (currentTotalExitRes < neededFromExternalExitRes) {
                        canEarlyExit = false;
                        break;
                    }
                }
                if (!canEarlyExit) break;
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
                
                // Check again if we've now met the needed quota for this category+resolution after adding this result
                const newTotalInThisRes = categoryResolutionTracker[category][resolution] || 0;
                const neededForThisCategoryRes = Math.max(0, limit - getSatisfiedByCategoryRes(category, resolution));
                if (newTotalInThisRes >= neededForThisCategoryRes) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Category ${category} ${resolution} quota now satisfied (${newTotalInThisRes}/${neededForThisCategoryRes}) after adding this result`);
                }
            } else {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> NOT CACHED`);
            }
        }

        return false;
    };

    try {
        const highQualityCategories = ['Remux', 'BluRay', 'WEB/WEB-DL'];
        const lowQualityCategories = ['BRRip/WEBRip'];
        const lastResortCategories = ['Audio-Focused', 'Other'];

        const highResTiers = [
            { name: 'Golden (4K/1080p HQ)', torrents: getTier(highQualityCategories, ['2160p', '1080p']) },
            { name: 'Compromise (4K/1080p Rips)', torrents: getTier(lowQualityCategories, ['2160p', '1080p']) },
            { name: 'Last Resort (4K/1080p Other)', torrents: getTier(lastResortCategories, ['2160p', '1080p']) },
        ];

        const lowResTiers = [
            { name: 'Fallback (720p HQ)', torrents: getTier(highQualityCategories, ['720p']) },
            { name: 'Compromise (720p Rips)', torrents: getTier(lowQualityCategories, ['720p']) },
            { name: 'Last Resort (720p/480p Other)', torrents: getTier(lastResortCategories, ['720p', '480p']) }
        ];

        for (const tier of highResTiers) {
            if (tier.torrents.length > 0) {
                console.log(`[${LOG_PREFIX} CACHE] ⚙️ Checking Tier: ${tier.name} (${tier.torrents.length} torrents)`);
                
                // Check if all necessary quotas are already satisfied before processing this tier
                let allQuotasSatisfied = true;
                for (const [category, limit] of Object.entries(qualityLimits)) {
                    // Check only 2160p/1080p in the high-res phase
                    for (const res of ['2160p', '1080p']) {
                        const satisfiedByDBRes = getSatisfiedByCategoryRes(category, res);
                        const neededFromExternalRes = Math.max(0, limit - satisfiedByDBRes);
                        const currentTotalInRes = categoryResolutionTracker[category]?.[res] || 0;
                        if (currentTotalInRes < neededFromExternalRes) {
                            allQuotasSatisfied = false;
                            break;
                        }
                    }
                    if (!allQuotasSatisfied) break;
                }
                
                if (allQuotasSatisfied) {
                    console.log(`[${LOG_PREFIX} CACHE] All required quotas satisfied, skipping remaining tiers`);
                    break; // Stop processing tiers if all needed quotas are met
                }
                
                if (await checkTorrentsInTiers(tier)) return cachedResults;
            } else {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Tier ${tier.name} has no torrents, skipping.`);
            }
        }

        const checkLimitsAndExit = () => {
            // Keep original limit-based early-exit for packs+low-res
            let remuxCount = getSatisfiedByCategory('Remux');
            let blurayCount = getSatisfiedByCategory('BluRay');
            let webdlCount = getSatisfiedByCategory('WEB/WEB-DL');
            for (const r of cachedResults) {
                if (r.resolution === '2160p' || r.resolution === '1080p') {
                    if (r.category === 'Remux') remuxCount++;
                    else if (r.category === 'BluRay') blurayCount++;
                    else if (r.category === 'WEB/WEB-DL') webdlCount++;
                }
            }
            const remuxLimit = qualityLimits['Remux'] || defaultMax;
            const blurayLimit = qualityLimits['BluRay'] || defaultMax;
            const webdlLimit = qualityLimits['WEB/WEB-DL'] || defaultMax;
            if (remuxCount >= remuxLimit || blurayCount >= blurayLimit || webdlCount >= webdlLimit) {
                console.log(`[${LOG_PREFIX} CACHE] ✅ Sufficient high-quality results found (Remux: ${remuxCount}/${remuxLimit}, BluRay: ${blurayCount}/${blurayLimit}, WEB/WEB-DL: ${webdlCount}/${webdlLimit}). Skipping packs and lower resolutions.`);
                return true;
            }
            return false;
        };

        if (checkLimitsAndExit()) return cachedResults;

        await inspectAllSeasonPacks();

        if (checkLimitsAndExit()) return cachedResults;

        // Rule: If we have at least one 1080p+ WEB/WEB-DL/BluRay/Remux (from DB or found), skip 720p and lower
        const hasHQ1080pOrHigher = (
            (getSatisfiedByCategoryRes('Remux', '1080p') > 0) ||
            (getSatisfiedByCategoryRes('Remux', '2160p') > 0) ||
            (getSatisfiedByCategoryRes('BluRay', '1080p') > 0) ||
            (getSatisfiedByCategoryRes('BluRay', '2160p') > 0) ||
            (getSatisfiedByCategoryRes('WEB/WEB-DL', '1080p') > 0) ||
            (getSatisfiedByCategoryRes('WEB/WEB-DL', '2160p') > 0) ||
            cachedResults.some(r => (r.resolution === '1080p' || r.resolution === '2160p') && (r.category === 'Remux' || r.category === 'BluRay' || r.category === 'WEB/WEB-DL'))
        );
        if (hasHQ1080pOrHigher) {
            console.log(`[${LOG_PREFIX} CACHE] ✅ Found at least one 1080p+ WEB/WEB-DL/BluRay/Remux (incl. DB). Skipping 720p and lower tiers.`);
        } else {
            for (const tier of lowResTiers) {
                if (tier.torrents.length > 0) {
                    console.log(`[${LOG_PREFIX} CACHE] ⚙️ Checking Tier: ${tier.name} (${tier.torrents.length} torrents)`);
                    
                    // Check if all necessary quotas are already satisfied before processing this tier
                let allQuotasSatisfied = true;
                for (const [category, limit] of Object.entries(qualityLimits)) {
                    // Check for both 720p and 480p in low-res phase
                    for (const res of ['720p', '480p']) {
                        const satisfiedByDBRes = getSatisfiedByCategoryRes(category, res);
                        const neededFromExternalRes = Math.max(0, limit - satisfiedByDBRes);
                        const currentTotalInRes = categoryResolutionTracker[category]?.[res] || 0;
                        if (currentTotalInRes < neededFromExternalRes) {
                            allQuotasSatisfied = false;
                            break;
                        }
                    }
                    if (!allQuotasSatisfied) break;
                }
                
                if (allQuotasSatisfied) {
                    console.log(`[${LOG_PREFIX} CACHE] All required quotas satisfied, skipping remaining low-res tiers`);
                    break; // Stop processing tiers if all needed quotas are met
                }
                
                if (await checkTorrentsInTiers(tier)) break;
            } else {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Tier ${tier.name} has no torrents, skipping.`);
            }
            }
        }
    } finally {
        if (handler && typeof handler.cleanup === 'function') {
            try { await handler.cleanup(); } catch (e) { /* ignore cleanup errors */ }
        }
    }

    return cachedResults;
}
