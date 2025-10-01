import PTT from 'parse-torrent-title'

const DomainNameRegex = /^www\.[a-zA-Z0-9]+\.[a-zA-Z]{2,}[ \-]+/i
const SourcePrefixRegex = /^\[[a-zA-Z0-9 ._]+\][ \-]*/

// Small memoization layer to avoid repeatedly parsing same titles under load
const CACHE_LIMIT = parseInt(process.env.PTT_CACHE_LIMIT || '2000', 10);
const cache = new Map();

function parse(title) {
    if (!title) return {};
    let key = String(title);
    // normalize key minimally to increase hit rates
    key = key.replace(DomainNameRegex, '').replace(SourcePrefixRegex, '');
    if (cache.has(key)) return cache.get(key);
    const parsed = PTT.parse(key);
    cache.set(key, parsed);
    if (cache.size > CACHE_LIMIT) {
        // drop oldest entry
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
    }
    return parsed;
}

export default { parse }
