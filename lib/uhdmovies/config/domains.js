// --- Domain Fetching ---
let uhdMoviesDomain = 'https://uhdmovies.rip'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = parseInt(process.env.UHDMOVIES_DOMAIN_CACHE_TTL) || 1 * 60 * 1000; // Configurable TTL in ms (default 1 minute)

export async function getUHDMoviesDomain(makeRequest) {
  const now = Date.now();
  if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
    return uhdMoviesDomain;
  }

  // Default timeout configuration for domain fetching
  const DEFAULT_TIMEOUT = parseInt(process.env.UHDMOVIES_DOMAIN_TIMEOUT) || 10000; // 10 seconds default
  const MAX_RETRIES = parseInt(process.env.UHDMOVIES_DOMAIN_MAX_RETRIES) || 2; // 2 retries by default
  const RETRY_DELAY = parseInt(process.env.UHDMOVIES_DOMAIN_RETRY_DELAY) || 1000; // 1 second delay

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[UHDMovies] Fetching latest domain (attempt ${attempt + 1})...`);
      const response = await makeRequest('https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json', { timeout: DEFAULT_TIMEOUT });
      if (response && response.data && response.data.UHDMovies) {
        uhdMoviesDomain = response.data.UHDMovies;
        domainCacheTimestamp = Date.now();
        console.log(`[UHDMovies] Updated domain to: ${uhdMoviesDomain}`);
        return uhdMoviesDomain;
      } else {
        console.warn('[UHDMovies] Domain JSON fetched, but "UHDMovies" key was not found. Using fallback.');
        break; // Don't retry if the key is missing, just use fallback
      }
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        console.log(`[UHDMovies] Domain fetch attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY}ms... Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
    }
  }

  console.error(`[UHDMovies] Failed to fetch latest domain after ${MAX_RETRIES + 1} attempts, using fallback. Last error: ${lastError?.message}`);
  return uhdMoviesDomain;
}
