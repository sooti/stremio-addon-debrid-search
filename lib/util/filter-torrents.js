import PTT from './parse-torrent-title.js';

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleMatches(objTitle, metaName) {
  if (!objTitle || !metaName) return true;
  return normalizeTitle(objTitle) === normalizeTitle(metaName);
}

const KNOWN_SERIES_ALIASES = {
    'star trek': [
        'star trek discovery',
        'star trek picard',
        'star trek lower decks',
        'star trek prodigy',
        'star trek the next generation',
        'star trek voyager',
        'star trek enterprise',
        'star trek the original series',
        'star trek strange new worlds',
    ]
};

function isDifferentSeries(torrentTitle, seriesTitle) {
    const normalizedTorrentTitle = normalizeTitle(torrentTitle);
    const normalizedSeriesTitle = normalizeTitle(seriesTitle);

    for (const key in KNOWN_SERIES_ALIASES) {
        if (normalizedSeriesTitle.includes(key)) {
            const otherSeries = KNOWN_SERIES_ALIASES[key].filter(series => series !== normalizedSeriesTitle);
            if (otherSeries.some(series => normalizedTorrentTitle.includes(series))) {
                return true;
            }
        }
    }

    return false;
}

function matchesSeriesTitle(torrent, seriesTitle) {
    const torrentTitle = torrent.Title || torrent.name || '';
    const pttInfo = PTT.parse(torrentTitle);
    const pttTitle = pttInfo.title || '';

    const normalizedTorrentTitle = normalizeTitle(torrentTitle);
    const normalizedPttTitle = normalizeTitle(pttTitle);
    const normalizedSeriesTitle = normalizeTitle(seriesTitle);

    if (normalizedPttTitle === normalizedSeriesTitle) {
        return true;
    }

    if (isDifferentSeries(torrentTitle, seriesTitle)) {
        return false;
    }

    const seriesTitleWords = normalizedSeriesTitle.split(' ');
    if (seriesTitleWords.every(word => normalizedTorrentTitle.includes(word))) {
        return true;
    }

    return false;
}

function hasEpisodeMarker(torrentName, season, episode) {
    if (!torrentName) return false;

    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');

    const patterns = [
        new RegExp(`[sS]${s}[eE]${e}`, 'i'),
        new RegExp(`season ${season} episode ${episode}`, 'i'),
        new RegExp(`\\b${season}x${episode}\\b`, 'i'),
    ];

    return patterns.some(p => p.test(torrentName));
}

function filterSeason(torrent, season, cinemetaDetails) {
  const s = Number(season);
  if (torrent?.info?.season != null && Number(torrent.info.season) === s) return true;
  if (Array.isArray(torrent?.info?.seasons) && torrent.info.seasons.map(Number).includes(s)) return true;
  if (cinemetaDetails?.name) {
    const candidate = torrent?.info?.title || torrent?.title || torrent?.name || torrent?.searchableName || torrent?.path;
    if (!titleMatches(candidate, cinemetaDetails.name)) return false;
  }
  return true;
}

function isSeasonPack(torrentName, season) {
    if (!torrentName) return false;

    const normalizedTorrentName = normalizeTitle(torrentName);
    const seasonPattern = new RegExp(`season ${season}\\b`, 'i');
    const sPattern = new RegExp(`s${String(season).padStart(2, '0')}\\b`, 'i');

    return (seasonPattern.test(normalizedTorrentName) || sPattern.test(normalizedTorrentName)) && !/[eE]\d{2}/.test(normalizedTorrentName);
}

function filterEpisode(torrentDetails, season, episode, cinemetaDetails) {
    if (!matchesSeriesTitle(torrentDetails, cinemetaDetails.name)) {
        return false;
    }

    const torrentTitle = torrentDetails.Title || torrentDetails.name || '';
    if (isSeasonPack(torrentTitle, season)) {
        return true;
    }
    
    const pttInfo = PTT.parse(torrentTitle);

    if (pttInfo.season === Number(season) && pttInfo.episode === Number(episode)) {
        if (cinemetaDetails.year && pttInfo.year && cinemetaDetails.year !== pttInfo.year) {
            return false;
        }
        return true;
    }

    if (torrentDetails.videos && Array.isArray(torrentDetails.videos)) {
        const matched = torrentDetails.videos
            .filter(v => String(season) == String(v.info.season) && String(episode) == String(v.info.episode));
        if (matched.length > 0) {
            return true;
        }
    }

    const candidates = [];
    ['name', 'title', 'searchableName', 'path'].forEach(f => {
        if (torrentDetails[f]) candidates.push(torrentDetails[f]);
    });
    if (torrentDetails.files && Array.isArray(torrentDetails.files)) {
        for (const f of torrentDetails.files) {
            if (f.path) candidates.push(f.path);
            if (f.name) candidates.push(f.name);
        }
    }
    for (const c of candidates) {
        if (c && hasEpisodeMarker(c, season, episode)) return true;
    }

    return false;
}

function filterYear(torrent, cinemetaDetails) {
  if (torrent?.info?.year && cinemetaDetails?.year) return torrent.info.year == cinemetaDetails.year;
  return true;
}

export {
    normalizeTitle,
    titleMatches,
    matchesSeriesTitle,
    hasEpisodeMarker,
    filterSeason,
    filterEpisode,
    filterYear
};
