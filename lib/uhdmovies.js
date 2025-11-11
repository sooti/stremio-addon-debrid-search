/**
 * UHDMovies Streaming Provider - Refactored
 *
 * This file has been refactored from a 2,895-line monolith into a modular structure.
 * The original file is backed up at lib/uhdmovies.js.backup
 *
 * New structure: lib/uhdmovies/
 *   - config/ (proxy, domains)
 *   - utils/ (http, encoding, quality, language, validation)
 *   - search/ (movie search)
 *   - extraction/ (TV and movie link extraction)
 *   - streams/ (stream generation)
 *   - resolvers/ (URL resolution)
 */

// Re-export all public APIs from the refactored modules
export * from './uhdmovies/index.js';
