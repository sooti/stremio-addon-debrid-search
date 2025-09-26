// util/seriesTitleMatcher.js
export function normalizeForMatch(str) {
  if (!str || typeof str !== 'string') return '';
  try {
    str = str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  } catch (e) {
    str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  // Replace any sequence of non-alphanumeric characters with a space to
  // avoid mismatches on punctuation (e.g., "Smackdown!" vs "Smackdown").
  // This keeps matching behavior consistent with other normalizers in the codebase.
  return str.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}

function escapeToken(t) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeSeriesTitleRegex(title) {
  if (!title || typeof title !== 'string') return null;
  const norm = normalizeForMatch(title);
  if (!norm) return null;
  const tokens = norm.split(' ').map(escapeToken);
  const tokenPattern = tokens.join('[\\s._\\-:\/\\\\]+');
  const lookahead =
    '(?=(?:[\\s._\\-:\/\\\\]*' +
      '(?:' +
        's\\d{1,2}e\\d{1,2}' +
        '|\\d{1,2}x\\d{1,2}' +
        '|ep\\.?\\s?\\d{1,3}' +
        '|\\b\\d{4}\\b' +
        '|\\b(?:720p|1080p|2160p|2160p|480p)\\b' +
        '|\\(|\\[|$' +
      ')' +
    '))';
  return new RegExp(`(?:^|[^a-z0-9])${tokenPattern}${lookahead}`, 'i');
}

export function matchesSeriesTitle(candidate, canonicalTitle) {
  if (!canonicalTitle) return true;
  const rx = makeSeriesTitleRegex(canonicalTitle);
  if (!rx) return true;
  const values = [];
  if (!candidate) return false;
  if (typeof candidate === 'string') values.push(candidate);
  else if (typeof candidate === 'object') {
    ['name', 'title', 'searchableName', 'path'].forEach(k => {
      if (candidate[k]) values.push(candidate[k]);
    });
    if (candidate.searchableName && candidate.name) {
      values.push(`${candidate.searchableName} ${candidate.name}`, `${candidate.name} ${candidate.searchableName}`);
    }
    if (candidate.files && Array.isArray(candidate.files)) {
      for (let i = 0; i < Math.min(6, candidate.files.length); i++) {
        if (candidate.files[i].path) values.push(candidate.files[i].path);
        if (candidate.files[i].name) values.push(candidate.files[i].name);
      }
    }
  }
  for (const raw of values) {
    if (!raw) continue;
    const norm = normalizeForMatch(raw);
    if (rx.test(norm)) return true;
  }
  return false;
}

export function hasEpisodeMarker(str, season, episode) {
  if (!str) return false;
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const patterns = [
    new RegExp(`[sS][\\W_]*${s}[\\W_]*[eE][\\W_]*${e}`),
    new RegExp(`\\b${Number(season)}[\\W_]*x[\\W_]*${e}\\b`, 'i'),
    new RegExp(`\\b[eE]p?\\.?\\s*${Number(episode)}\\b`, 'i'),
    new RegExp(`${s}[\\W_]*[eE][\\W_]*${e}`, 'i')
  ];
  return patterns.some(rx => rx.test(str));
}
