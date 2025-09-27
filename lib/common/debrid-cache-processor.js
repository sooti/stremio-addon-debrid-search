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

    // Check if quality quotas have been satisfied by "DB" (personal files) by looking at satisfiedQuotas parameter
    // Calculate remaining quotas needed after "DB" (personal files) are counted
    const remainingQuotas = {};
    let anyQuotaRemaining = false;
    
    for (const [category, limit] of Object.entries(qualityLimits)) {
        const satisfiedCount = satisfiedQuotas[category] || 0;
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

    // Initialize categoryResolutionTracker with already satisfied quotas from DB
    for (const [category, count] of Object.entries(satisfiedQuotas)) {
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
                
                // Check current totals across all resolutions for this category (not just this resolution)
                categoryResolutionTracker[category] = categoryResolutionTracker[category] || {};
                let currentTotalInCategory = 0;
                for (const res in categoryResolutionTracker[category]) {
                    currentTotalInCategory += categoryResolutionTracker[category][res];
                }
                
                // Calculate how many are still needed after DB (personal files) are counted
                const limit = qualityLimits[category] || defaultMax;
                const satisfiedByDB = satisfiedQuotas[category] || 0;
                const neededFromExternal = Math.max(0, limit - satisfiedByDB);
                
                if (currentTotalInCategory >= neededFromExternal) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED pack (Category limit reached: ${currentTotalInCategory}/${neededFromExternal} needed from external after DB accounted)`);
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

            // Check current totals across all resolutions for this category (not just this resolution)
            categoryResolutionTracker[category] = categoryResolutionTracker[category] || {};
            let currentTotalInCategory = 0;
            for (const res in categoryResolutionTracker[category]) {
                currentTotalInCategory += categoryResolutionTracker[category][res];
            }
            
            const limit = qualityLimits[category] || defaultMax;
            // Calculate how many are still needed after DB (personal files) are counted
            const satisfiedByDB = satisfiedQuotas[category] || 0;
            const neededFromExternal = Math.max(0, limit - satisfiedByDB);
            
            if (currentTotalInCategory >= neededFromExternal) {
                if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] -> SKIPPED (Category limit reached: ${currentTotalInCategory}/${neededFromExternal} needed from external after DB accounted)`);
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
                const satisfiedByDBExit = satisfiedQuotas[exitCategory] || 0;
                const neededFromExternalExit = Math.max(0, limitForExit - satisfiedByDBExit);
                
                // Count current totals for this category
                let currentTotalExit = 0;
                if (categoryResolutionTracker[exitCategory]) {
                    for (const res in categoryResolutionTracker[exitCategory]) {
                        currentTotalExit += categoryResolutionTracker[exitCategory][res];
                    }
                }
                
                if (currentTotalExit < neededFromExternalExit) {
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
                
                // Check again if we've now met the needed quota after adding this result
                let newTotalInCategory = 0;
                for (const res in categoryResolutionTracker[category]) {
                    newTotalInCategory += categoryResolutionTracker[category][res];
                }
                const neededForThisCategory = Math.max(0, limit - (satisfiedQuotas[category] || 0));
                
                if (newTotalInCategory >= neededForThisCategory) {
                    if (debugLogsEnabled) console.log(`[${LOG_PREFIX} DBG] Category ${category} quota now satisfied (${newTotalInCategory}/${neededForThisCategory}) after adding this result`);
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
                    const satisfiedByDB = satisfiedQuotas[category] || 0;
                    const neededFromExternal = Math.max(0, limit - satisfiedByDB);
                    
                    let currentTotalInCategory = 0;
                    if (categoryResolutionTracker[category]) {
                        for (const res in categoryResolutionTracker[category]) {
                            currentTotalInCategory += categoryResolutionTracker[category][res];
                        }
                    }
                    
                    if (currentTotalInCategory < neededFromExternal) {
                        allQuotasSatisfied = false;
                        break;
                    }
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
            // Calculate counts including what was satisfied by DB (personal files)
            let remuxCount = satisfiedQuotas['Remux'] || 0;
            let blurayCount = satisfiedQuotas['BluRay'] || 0;
            let webdlCount = satisfiedQuotas['WEB/WEB-DL'] || 0;
            
            // Add counts from our cached results
            for (const r of cachedResults) {
                if (r.category === 'Remux' && (r.resolution === '2160p' || r.resolution === '1080p')) {
                    remuxCount++;
                } else if (r.category === 'BluRay' && (r.resolution === '2160p' || r.resolution === '1080p')) {
                    blurayCount++;
                } else if (r.category === 'WEB/WEB-DL' && (r.resolution === '2160p' || r.resolution === '1080p')) {
                    webdlCount++;
                }
            }
            
            const remuxLimit = qualityLimits['Remux'] || defaultMax;
            const blurayLimit = qualityLimits['BluRay'] || defaultMax;
            const webdlLimit = qualityLimits['WEB/WEB-DL'] || defaultMax;

            if (remuxCount >= remuxLimit || blurayCount >= blurayLimit || webdlCount >= webdlLimit) {
                 console.log(`[${LOG_PREFIX} CACHE] ✅ Sufficient high-quality results found (Remux: ${remuxCount}/${remuxLimit} incl. DB: ${satisfiedQuotas['Remux'] || 0}), BluRay: ${blurayCount}/${blurayLimit} incl. DB: ${satisfiedQuotas['BluRay'] || 0}), WEB/WEB-DL: ${webdlCount}/${webdlLimit} incl. DB: ${satisfiedQuotas['WEB/WEB-DL'] || 0}). Skipping packs and lower resolutions.`);
                 return true;
            }
            return false;
        };

        if (checkLimitsAndExit()) return cachedResults;

        await inspectAllSeasonPacks();

        if (checkLimitsAndExit()) return cachedResults;

        for (const tier of lowResTiers) {
            if (tier.torrents.length > 0) {
                console.log(`[${LOG_PREFIX} CACHE] ⚙️ Checking Tier: ${tier.name} (${tier.torrents.length} torrents)`);
                
                // Check if all necessary quotas are already satisfied before processing this tier
                let allQuotasSatisfied = true;
                for (const [category, limit] of Object.entries(qualityLimits)) {
                    const satisfiedByDB = satisfiedQuotas[category] || 0;
                    const neededFromExternal = Math.max(0, limit - satisfiedByDB);
                    
                    let currentTotalInCategory = 0;
                    if (categoryResolutionTracker[category]) {
                        for (const res in categoryResolutionTracker[category]) {
                            currentTotalInCategory += categoryResolutionTracker[category][res];
                        }
                    }
                    
                    if (currentTotalInCategory < neededFromExternal) {
                        allQuotasSatisfied = false;
                        break;
                    }
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

    } finally {
        if (handler && typeof handler.cleanup === 'function') {
            try { await handler.cleanup(); } catch (e) { /* ignore cleanup errors */ }
        }
    }

    return cachedResults;
}
