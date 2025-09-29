import { readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { STREAM_NAME_MAP } from '../stream-provider.js';

function readPackageVersion() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(__dirname + '/../../package.json', 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
function normalizeKey(val) {
  if (!val) return '';
  return String(val).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function getManifest(config = {}) {
  const rootName = "Sootio";

  // Helper: extract bracketed abbreviation (e.g. "[OC+]" -> "OC+")
  const extractAbbrev = (streamName) => {
    if (!streamName) return null;
    const m = streamName.match(/\[([^\]]+)\]/);
    return m ? m[1] : null;
  };

  // 1) If landing page sent a single provider in config.DebridProvider (recommended)
  let manifestName = rootName;
  const provided = config.DebridProvider;
  if (provided) {
    const key = normalizeKey(provided);
    if (key && STREAM_NAME_MAP?.[key]) {
      manifestName = STREAM_NAME_MAP[key];
    } else if (key) {
      // unknown provider — make a sensible fallback using the key
      manifestName = `[${key.toUpperCase()}+] ${rootName}`;
    }
  } else {
    // 2) Fallback — check for boolean flags in config matching STREAM_NAME_MAP keys
    const enabledKeys = Object.keys(STREAM_NAME_MAP || {}).filter(k => !!config[k]);
    if (enabledKeys.length === 1) {
      manifestName = STREAM_NAME_MAP[enabledKeys[0]];
    } else if (enabledKeys.length > 1) {
      // build "[OC+ RD+] Sootio"
      const abbrevs = enabledKeys
        .map(k => extractAbbrev(STREAM_NAME_MAP[k]) || `${k.toUpperCase()}+`)
        .join(' ');
      manifestName = `[${abbrevs}] ${rootName}`;
    } else {
      // nothing selected, keep default "Sootio"
      manifestName = rootName;
    }
  }

  const manifest = {
    // --- BRANDING UPDATE ---
    id: "com.sootio.debrid-search",
    version: readPackageVersion(),
    name: manifestName,
    description: "Your ultimate debrid companion. Sootio intelligently searches your debrid services for cached torrents, using a smart, tiered scoring system to prioritize the highest quality streams first.",
    background: `https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?q=80&w=2071&auto=format&fit=crop&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D`,
    logo: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%2364ffda;stop-opacity:1' /%3E%3Cstop offset='100%25' style='stop-color:%2300A7B5;stop-opacity:1' /%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath fill='url(%23grad)' d='M50,5 C74.85,5 95,25.15 95,50 C95,74.85 74.85,95 50,95 C35,95 22.33,87.6 15,76 C25,85 40,85 50,80 C60,75 65,65 65,50 C65,35 55,25 40,25 C25,25 15,40 15,50 C15,55 16,60 18,64 C8.5,58 5,45 5,50 C5,25.15 25.15,5 50,5 Z'/%3E%3C/svg%3E`,
    
    // --- CORE FUNCTIONALITY (Unchanged) ---
    catalogs: getCatalogs(config),
    resources: [
      "catalog",
      "stream"
    ],
    types: [
      "movie",
      "series",
      "anime",
      "other"
    ],
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: true,
      configurationRequired: isConfigurationRequired(config)
    },
  };

  return manifest;
}

function getCatalogs(config) {
    return []
}

function isConfigurationRequired(config) {
    return !(config && config.DebridProvider)
}

export { getManifest }
