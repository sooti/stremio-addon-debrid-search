// Export all scraper utility functions
export { createTimerLabel } from './utils/timing.js';
export { isNotJunk, detectSimpleLangs, hasSimpleLanguageToken, hasAnyNonEnglishToken } from './utils/filtering.js';
export { processAndDeduplicate } from './utils/deduplication.js';
export { generateScraperCacheKey } from './utils/caching.js';
export { handleScraperError } from './utils/error-handling.js';

// Export background functions
export { performBackgroundCacheCheck } from './background/cache-checker.js';

// Export Torznab scrapers
export { searchBitmagnet } from './torznab/bitmagnet.js';
export { searchJackett } from './torznab/jackett.js';
export { searchZilean } from './torznab/zilean.js';

// Export Stremio addon scrapers
export { searchTorrentio } from './stremio-addons/torrentio.js';
export { searchComet } from './stremio-addons/comet.js';
export { searchStremthru } from './stremio-addons/stremthru.js';

// Export public tracker scrapers
export { search1337x } from './public-trackers/1337x.js';
export { searchTorrent9 } from './public-trackers/torrent9.js';
export { searchBtdig } from './public-trackers/btdig.js';
export { searchMagnetDL, searchMagnetDLMovie, searchMagnetDLTV } from './public-trackers/magnetdl.js';
export { searchTorrentGalaxy } from './public-trackers/torrentgalaxy.js';
export { searchKnaben } from './public-trackers/knaben.js';
export { searchIlCorsaroNero } from './public-trackers/ilcorsaronero.js';

// Export specialized scrapers
export { searchSnowfl } from './specialized/snowfl.js';
export { searchWolfmax4K } from './specialized/wolfmax4k.js';
export { searchBluDV } from './specialized/bludv.js';
