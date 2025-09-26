// lib/util/episodeMatcher.js
// Reusable series/episode matching utilities to be used by scrapers and debrid services
import { normalizeForMatch, hasEpisodeMarker } from './seriesTitleMatcher.js';

// Generic stopwords allowed to appear between title tokens without changing identity
const STOPWORDS = new Set([
  'the','a','an','and','of','&','with','on','at','in','for','to','from','by','-',
  'part','chapter','vol','volume','season','episode','special','series',
  'complete','collection','pack','boxset','box','set','remaster','remastered',
  // days/time words commonly present in show titles (generic handling)
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday','night','day','morning','afternoon'
]);

function parseSeasonEpisode(raw) {
  if (!raw) return { season: null, episode: null };
  const s = String(raw);
  // s01e02, S1E2, s 01 e 02
  let m = s.match(/\b[sS]\s*(\d{1,2})\s*[. _-]*\s*[eE]\s*(\d{1,3})\b/);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  // 1x02
  m = s.match(/\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  // Season 1 Episode 2 / Ep 2
  m = s.match(/season\s*(\d{1,2})\D+ep(?:isode)?\.?\s*(\d{1,3})/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  // E02 with implicit season (rare). We do not infer season here.
  m = s.match(/\b[eE]p?\.?\s*(\d{1,3})\b/);
  if (m) return { season: null, episode: parseInt(m[1], 10) };
  return { season: null, episode: null };
}

export function parseSeriesQuery(query) {
  const titlePart = (query || '').replace(/\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|season\s*\d+\D+ep(?:isode)?\.?\s*\d+/ig, '').trim();
  const { season, episode } = parseSeasonEpisode(query || '');
  return { title: titlePart, season, episode };
}
function tokenize(str) {
  return normalizeForMatch(str).split(' ').filter(Boolean);
}

function isYearToken(t) { return /^\d{4}$/.test(t) && Number(t) >= 1900 && Number(t) <= 2100; }
function isResolutionToken(t) { return /^(480p|720p|1080p|2160p|4k|uhd|hdr)$/.test(t); }
function isSeasonEpisodeToken(t) { return /^[sS]\d{1,2}[eE]\d{1,3}$/.test(t) || /^\d{1,2}x\d{1,3}$/.test(t); }
function hasSeasonOnlyMarker(str, season) {
  if (!Number.isFinite(season)) return false;
  const s = String(season).padStart(2, '0');
  const rx1 = new RegExp(`(?:^|[^a-z0-9])s\s*${s}(?!\s*[eE]\s*\d)`, 'i');
  const rx2 = new RegExp(`(?:^|[^a-z0-9])season\s*${Number(season)}(?:\b|\D)`, 'i');
  return rx1.test(str) || rx2.test(str);
}

function coreTitleTokens(str) {
  const all = tokenize(str);
  const core = [];
  for (const t of all) {
    if (isYearToken(t) || isResolutionToken(t) || isSeasonEpisodeToken(t)) break;
    core.push(t);
  }
  return core.length ? core : all;
}

export function buildSeriesContext({ search, cinemetaTitle = null } = {}) {
  const { title, season, episode } = parseSeriesQuery(search || '');
  const baseTitle = (cinemetaTitle || title || '').trim();
  const normBase = normalizeForMatch(baseTitle);
  const queryTokens = tokenize(baseTitle);
  return { title: baseTitle, normTitle: normBase, season, episode, queryTokens };
}

export function matchesCandidateTitle(candidate, ctx, opts = {}) {
  if (!candidate || !ctx) return true;
  const { maxExtraRatio = 1.0 } = opts;
  const values = [];
  if (typeof candidate === 'string') values.push(candidate);
  else if (typeof candidate === 'object') {
    ['Title', 'title', 'name', 'searchableName', 'path'].forEach(k => { if (candidate[k]) values.push(candidate[k]); });
    if (candidate.files && Array.isArray(candidate.files)) {
      for (let i = 0; i < Math.min(6, candidate.files.length); i++) {
        if (candidate.files[i].path) values.push(candidate.files[i].path);
        if (candidate.files[i].name) values.push(candidate.files[i].name);
      }
    }
  }

  const requireEpisode = Number.isFinite(ctx.season) && Number.isFinite(ctx.episode);

  for (const raw of values) {
    if (!raw) continue;
    const norm = normalizeForMatch(raw);

    // If episode requested, allow either exact episode marker or season-only packs
    if (requireEpisode) {
      const ok = hasEpisodeMarker(norm, ctx.season, ctx.episode) || hasSeasonOnlyMarker(norm, ctx.season);
      if (!ok) continue;
    }

    const candCore = coreTitleTokens(norm);
    const q = ctx.queryTokens || tokenize(ctx.title);
    if (q.length === 0) return true;

    // Greedy subsequence match with stopword-tolerant extras
    let i = 0, j = 0, matched = 0, lastMatchIndex = -1;
    while (i < candCore.length && j < q.length) {
      if (candCore[i] === q[j]) {
        matched++; lastMatchIndex = i; i++; j++;
      } else {
        i++;
      }
    }
    if (matched < Math.min(q.length, 1)) continue; // must match at least first token
    // Require full query token coverage if query tokens <= 3; otherwise allow 80%
    const coverage = matched / q.length;
    if ((q.length <= 3 && coverage < 1) || (q.length > 3 && coverage < 0.8)) continue;

    // Reject if core title has extra non-stopword tokens beyond query tokens
    const unmatchedTokens = candCore.filter(t => !q.includes(t));
    const hasNonStopwordExtra = unmatchedTokens.some(t => !STOPWORDS.has(t));
    if (hasNonStopwordExtra) continue;

    return true;
  }
  return false;
}
