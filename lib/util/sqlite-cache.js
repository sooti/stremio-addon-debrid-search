/**
 * @fileoverview
 * General-purpose SQLite caching utility for the application.
 * 
 * This module provides a flexible caching layer with two primary uses:
 * 1. Scraper Search Result Caching:
 *    - Caches the entire list of torrents returned from a scraper for a specific media item (movie/series).
 *    - Keys are typically structured like `debrider-search:movie:tt123456:en,fr`.
 *    - Reduces latency for repeated searches by serving results from the cache.
 *    - Used in `lib/stream-provider.js`.
 * 
 * 2. Individual Torrent/Magnet Caching:
 *    - Caches metadata for individual torrents (magnets) identified by their info hash.
 *    - Avoids re-processing or re-fetching details for the same torrent across different debrid services.
 *    - Functions like `upsertCachedMagnet` and `getCachedHashes` support this.
 *
 * It uses automatic cleanup based on expiration time for cache expiration.
 */
import * as config from '../config.js';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory name for this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;
let initPromise = null;
const debug = process.env.SQLITE_DEBUG_LOGS === 'true' || process.env.DEBUG_SQLITE === 'true';

export function isEnabled() {
  return Boolean(config.SQLITE_CACHE_ENABLED);
}

// Initialize SQLite database
export async function initSqlite() {
  if (!isEnabled()) {
    if (debug) console.log('[SQLITE CACHE] SQLite cache is disabled by configuration');
    return null;
  }
  if (initPromise) {
    if (debug) console.log('[SQLITE CACHE] Using existing initialization promise');
    return initPromise;
  }
  
  if (debug) console.log('[SQLITE CACHE] Starting SQLite initialization');
  initPromise = (async () => {
    try {
      // Create database file in data directory
      const dataDir = join(__dirname, '..', '..', 'data');
      const dbPath = join(dataDir, 'cache.db');
      
      if (debug) console.log(`[SQLITE CACHE] Database path: ${dbPath}`);
      
      // Ensure data directory exists
      import('fs').then(fs => {
        if (!fs.existsSync(dataDir)) {
          if (debug) console.log(`[SQLITE CACHE] Creating data directory: ${dataDir}`);
          fs.mkdirSync(dataDir, { recursive: true });
        }
      }).catch(() => {
        // If import fails, we'll proceed without checking
      });

      db = new Database(dbPath, { 
        // Enable WAL mode for better concurrency
        WAL: true 
      });

      // Optimize SQLite for concurrent reads/writes
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = 10000');
      db.pragma('temp_store = memory');
      
      if (debug) console.log('[SQLITE CACHE] Database connection established');
      
      // Create tables if they don't exist
      await createTables();
      if (debug) console.log('[SQLITE CACHE] Tables created/verified');

      // Set up periodic cleanup of expired records
      setupCleanupJob();
      if (debug) console.log('[SQLITE CACHE] Cleanup job scheduled');

      console.log('[SQLITE CACHE] SQLite cache initialized successfully');
      return db;
    } catch (error) {
      console.warn(`[SQLITE CACHE] Failed to initialize SQLite: ${error.message}`);
      console.warn('[SQLITE CACHE] Falling back to no-cache mode');
      
      // Close database if initialization failed
      if (db) {
        try {
          db.close();
          console.log('[SQLITE CACHE] Closed failed SQLite connection');
        } catch (closeError) {
          console.error(`[SQLITE CACHE] Error closing failed SQLite connection: ${closeError.message}`);
        }
      }
      
      // Reset state
      db = null;
      initPromise = null;
      return null;
    }
  })();
  
  return initPromise;
}

// Create required tables
async function createTables() {
  if (!db) return;
  
  // Main cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT,
      hash TEXT,
      releaseKey TEXT,
      fileName TEXT,
      size INTEGER,
      data TEXT, -- JSON string
      category TEXT,
      resolution TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME -- Use DATETIME for TTL-like behavior
    )
  `);
  
  // Create indexes for performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_service_hash ON cache(service, hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_service_releaseKey ON cache(service, releaseKey)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expiresAt ON cache(expiresAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hash_service ON cache(hash, service)`);
  
  // Trigger to update updatedAt on each update
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS update_cache_timestamp 
    AFTER UPDATE ON cache
    BEGIN
      UPDATE cache SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END
  `);
}

// Set up periodic cleanup job for expired records
function setupCleanupJob() {
  if (!db) return;
  
  if (debug) {
    console.log('[SQLITE CACHE] Setting up periodic cleanup job for expired records');
  }
  
  // Clean up expired records every 30 minutes
  setInterval(() => {
    try {
      if (debug) {
        console.log('[SQLITE CACHE] Running periodic cleanup of expired cache entries');
      }
      
      const startTime = Date.now();
      const result = db.exec('DELETE FROM cache WHERE expiresAt <= CURRENT_TIMESTAMP');
      const changes = db.prepare('SELECT changes()').get()['changes()'];
      const duration = Date.now() - startTime;
      
      if (changes > 0) {
        console.log(`[SQLITE CACHE] Cleaned up ${changes} expired cache entries in ${duration}ms`);
      } else if (debug) {
        console.log(`[SQLITE CACHE] No expired cache entries to clean up (checked in ${duration}ms)`);
      }
    } catch (error) {
      console.error(`[SQLITE CACHE] Error cleaning up expired entries: ${error.message}`);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

function ttlDate() {
  const days = Number(config.SQLITE_CACHE_TTL_DAYS || 30);
  // Convert days to milliseconds and add to current time
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  // Return ISO string for SQLite DATETIME
  return new Date(ms).toISOString();
}

// Get database instance
export async function getDatabase() {
  if (!isEnabled()) {
    if (debug) console.log('[SQLITE CACHE] getDatabase: SQLite cache is not enabled');
    return null;
  }
  await initSqlite();
  if (debug && db) {
    console.log('[SQLITE CACHE] getDatabase: Database connection available');
  } else if (debug && !db) {
    console.log('[SQLITE CACHE] getDatabase: No database connection available');
  }
  return db;
}

// Upsert a cached magnet record
// record: { service, hash, fileName?, size?, data? }
export async function upsertCachedMagnet(record) {
  if (!isEnabled()) {
    console.log(`[SQLITE CACHE] SQLite cache is not enabled, skipping upsert for hash ${record.hash}`);
    return false;
  }
  try {
    if (debug) {
      console.log(`[SQLITE CACHE] Attempting upsert for service: ${record.service}, hash: ${record.hash}`);
    }
    
    const db = await getDatabase();
    if (!db) {
      if (debug) console.log('[SQLITE CACHE] No database connection available');
      return false;
    }
    
    const service = String(record.service || '').toLowerCase();
    const hash = String(record.hash || '').toLowerCase();
    
    if (!service || !hash) {
      console.log(`[SQLITE CACHE] Invalid service (${service}) or hash (${hash}) for upsert`);
      return false;
    }
    
    if (debug) {
      console.log(`[SQLITE CACHE] Preparing to upsert: service=${service}, hash=${hash}, fileName=${record.fileName}, size=${record.size}`);
    }
    
    const now = new Date().toISOString();
    const expiresAt = ttlDate();
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cache 
      (service, hash, fileName, size, data, releaseKey, category, resolution, createdAt, updatedAt, expiresAt)
      VALUES (@service, @hash, @fileName, @size, @data, @releaseKey, @category, @resolution, @createdAt, @updatedAt, @expiresAt)
    `);
    
    const startTime = Date.now();
    stmt.run({
      service,
      hash,
      fileName: record.fileName || null,
      size: typeof record.size === 'number' ? record.size : null,
      data: record.data ? JSON.stringify(record.data) : null,
      releaseKey: record.releaseKey || null,
      category: record.category || null,
      resolution: record.resolution || null,
      createdAt: now, // Will be ignored if record already exists due to INSERT OR REPLACE
      updatedAt: now,
      expiresAt
    });
    const duration = Date.now() - startTime;
    
    if (debug) {
      console.log(`[SQLITE CACHE] Upsert completed in ${duration}ms: service=${service}, hash=${hash}`);
    }
    
    console.log(`[SQLITE CACHE] Successfully upserted magnet record for service ${service}, hash ${hash}`);
    return true;
  } catch (error) {
    console.error(`[SQLITE CACHE] Error upserting magnet record: ${error.message}`);
    return false;
  }
}

// Upsert multiple cached magnet records (individual upserts for immediate saves)
export async function upsertCachedMagnets(records) {
  if (!isEnabled() || !Array.isArray(records) || records.length === 0) {
    if (debug) console.log(`[SQLITE CACHE] Bulk upsert skipped: enabled=${isEnabled()}, records length=${Array.isArray(records) ? records.length : 'N/A'}`);
    return false;
  }
  
  if (debug) {
    console.log(`[SQLITE CACHE] Starting individual upserts for ${records.length} records`);
  }
  
  try {
    const db = await getDatabase();
    if (!db) {
      if (debug) console.log('[SQLITE CACHE] No database connection available for bulk upsert');
      return false;
    }

    const now = new Date().toISOString();
    const expiresAt = ttlDate();
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cache 
      (service, hash, fileName, size, data, releaseKey, category, resolution, createdAt, updatedAt, expiresAt)
      VALUES (@service, @hash, @fileName, @size, @data, @releaseKey, @category, @resolution, @createdAt, @updatedAt, @expiresAt)
    `);
    
    let successCount = 0;
    const startTime = Date.now();
    
    // Process each record individually for immediate persistence
    for (const record of records) {
      const service = String(record.service || '').toLowerCase();
      const hash = String(record.hash || '').toLowerCase();
      if (!service || !hash) {
        if (debug) console.log(`[SQLITE CACHE] Skipping invalid record: service=${record.service}, hash=${record.hash}`);
        continue;
      }

      try {
        stmt.run({
          service,
          hash,
          fileName: record.fileName || null,
          size: typeof record.size === 'number' ? record.size : null,
          data: record.data ? JSON.stringify(record.data) : null,
          releaseKey: record.releaseKey || null,
          category: record.category || null,
          resolution: record.resolution || null,
          createdAt: now, // Will be ignored if record already exists due to INSERT OR REPLACE
          updatedAt: now,
          expiresAt
        });
        successCount++;
      } catch (recordError) {
        console.error(`[SQLITE CACHE] Error upserting individual record: ${recordError.message}, service=${service}, hash=${hash}`);
      }
    }
    
    const duration = Date.now() - startTime;
    
    if (debug) {
      console.log(`[SQLITE CACHE] Individual upserts completed in ${duration}ms for ${successCount}/${records.length} records`);
    }
    
    return successCount > 0;
  } catch (error) {
    console.error(`[SQLITE CACHE] Error upserting magnet records: ${error.message}`);
    return false;
  }
}

// Return Set of hashes known cached for the given service
export async function getCachedHashes(service, hashes) {
  if (!isEnabled()) {
    console.log(`[SQLITE CACHE] SQLite cache is not enabled, skipping check for ${hashes?.length || 0} hashes`);
    return new Set();
  }
  try {
    if (debug) {
      console.log(`[SQLITE CACHE] Getting cached hashes for service: ${service}, hash count: ${hashes?.length || 0}`);
    }
    
    const db = await getDatabase();
    if (!db || !Array.isArray(hashes) || hashes.length === 0) {
      console.log(`[SQLITE CACHE] No database or empty hashes array, returning empty set`);
      return new Set();
    }
    
    const lower = hashes.map(h => String(h || '').toLowerCase()).filter(Boolean);
    if (lower.length === 0) {
      console.log(`[SQLITE CACHE] No valid hashes after normalization, returning empty set`);
      return new Set();
    }
    
    const serviceKey = String(service || '').toLowerCase();
    
    if (debug) {
      console.log(`[SQLITE CACHE] Checking ${lower.length} hashes for service ${serviceKey}, first few: [${lower.slice(0, 3).join(', ')}...]`);
    }

    // Prepare a statement to check multiple hashes
    const placeholders = lower.map(() => '?').join(',');
    const sql = `
      SELECT DISTINCT hash 
      FROM cache 
      WHERE service = ? 
        AND hash IN (${placeholders}) 
        AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP)
    `;
    
    const stmt = db.prepare(sql);
    
    const startTime = Date.now();
    const results = stmt.all(serviceKey, ...lower);
    const duration = Date.now() - startTime;
    
    const foundHashes = results.map(row => row.hash);
    const result = new Set(foundHashes);
    
    console.log(`[SQLITE CACHE] Found ${foundHashes.length} cached hashes for service ${serviceKey} in ${duration}ms`);
    
    if (debug) {
      console.log(`[SQLITE CACHE] Cache hit rate: ${foundHashes.length}/${lower.length} (${foundHashes.length/ lower.length * 100}%)`);
    }
    
    return result;
  } catch (error) {
    console.warn(`[SQLITE CACHE] Error checking cached hashes: ${error.message}`);
    console.warn('[SQLITE CACHE] Falling back to no cache');
    return new Set();
  }
}

export async function getCachedRecord(service, hash) {
  if (!isEnabled()) {
    console.log(`[SQLITE CACHE] SQLite cache is not enabled, skipping single hash check for ${hash}`);
    return null;
  }
  try {
    if (debug) {
      console.log(`[SQLITE CACHE] Getting single cached record for service: ${service}, hash: ${hash}`);
    }
    
    const db = await getDatabase();
    if (!db) return null;
    
    console.log(`[SQLITE CACHE] Checking single hash ${hash} for service ${service}`);
    
    const stmt = db.prepare(`
      SELECT fileName, size, data, releaseKey, category, resolution, updatedAt, expiresAt
      FROM cache
      WHERE service = ? AND hash = ? AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP)
    `);
    
    const serviceKey = String(service || '').toLowerCase();
    const hashKey = String(hash || '').toLowerCase();
    
    const startTime = Date.now();
    const result = stmt.get(serviceKey, hashKey);
    const duration = Date.now() - startTime;
    
    if (result && result.data) {
      // Parse the JSON data
      try {
        result.data = JSON.parse(result.data);
      } catch (e) {
        console.warn(`[SQLITE CACHE] Error parsing cached data for hash ${hash}: ${e.message}`);
        // Keep the original string if parsing fails
      }
    }
    
    console.log(`[SQLITE CACHE] Found cached record for hash ${hash}: ${result ? 'YES' : 'NO'}`);
    
    if (debug) {
      console.log(`[SQLITE CACHE] Single hash lookup took ${duration}ms`);
      if (result) {
        console.log(`[SQLITE CACHE] Record details: fileName=${result.fileName}, size=${result.size}, category=${result.category}, resolution=${result.resolution}`);
      }
    }
    
    return result;
  } catch (error) {
    console.warn(`[SQLITE CACHE] Error checking cached record: ${error.message}`);
    console.warn('[SQLITE CACHE] Falling back to no cache');
    return null;
  }
}

// Returns counts by category and by category+resolution for a given release key
// Shape: { byCategory: { Remux: n, BluRay: m, ... }, byCategoryResolution: { Remux: { '2160p': x, '1080p': y }, ... }, total: number }
export async function getReleaseCounts(service, releaseKey) {
  const empty = { byCategory: {}, byCategoryResolution: {}, total: 0 };
  if (!isEnabled()) {
    if (debug) console.log(`[SQLITE CACHE] getReleaseCounts: SQLite cache is not enabled for service ${service}, releaseKey: ${releaseKey}`);
    return empty;
  }
  const db = await getDatabase();
  if (!db || !service || !releaseKey) {
    if (debug) console.log(`[SQLITE CACHE] getReleaseCounts: Missing db (${!!db}), service (${!!service}), or releaseKey (${!!releaseKey})`);
    return empty;
  }
  
  try {
    if (debug) {
      console.log(`[SQLITE CACHE] Aggregating release counts for service: ${service}, releaseKey: ${releaseKey}`);
    }
    
    const svc = String(service || '').toLowerCase();
    const rel = String(releaseKey);
    
    const stmt = db.prepare(`
      SELECT category, resolution
      FROM cache
      WHERE service = ? AND releaseKey = ? AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP)
    `);
    
    const startTime = Date.now();
    const results = stmt.all(svc, rel);
    const duration = Date.now() - startTime;
    
    const byCategory = {};
    const byCategoryResolution = {};
    let total = 0;
    
    for (const row of results) {
      const cat = row.category || 'Other';
      const res = row.resolution || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      byCategoryResolution[cat] = byCategoryResolution[cat] || {};
      byCategoryResolution[cat][res] = (byCategoryResolution[cat][res] || 0) + 1;
      total += 1;
    }
    
    if (debug) {
      console.log(`[SQLITE CACHE] Release count aggregation completed in ${duration}ms for ${results.length} records`);
      console.log(`[SQLITE CACHE] Results - total: ${total}, categories: [${Object.keys(byCategory).join(', ')}]`);
    }
    
    return { byCategory, byCategoryResolution, total };
  } catch (error) {
    console.error(`[SQLITE CACHE] Error aggregating release counts for ${service}/${releaseKey}: ${error.message}`);
    return empty;
  }
}

export async function clearSearchCache() {
  if (!isEnabled()) {
    console.log('[SQLITE CACHE] SQLite cache is not enabled, skipping clear');
    return { success: false, message: 'SQLite cache not enabled' };
  }
  try {
    if (debug) {
      console.log('[SQLITE CACHE] Starting clearSearchCache operation');
    }
    
    const db = await getDatabase();
    if (!db) return { success: false, message: 'Database not available' };

    // Delete all records with releaseKey containing "-search:"
    const startTime = Date.now();
    const result = db.prepare(`
      DELETE FROM cache 
      WHERE releaseKey LIKE ? AND releaseKey IS NOT NULL
    `).run('%-search:%');
    const duration = Date.now() - startTime;
    
    const deletedCount = db.prepare('SELECT changes()').get()['changes()'];
    console.log(`[SQLITE CACHE] Cleared ${deletedCount} search cache entries in ${duration}ms`);
    return { success: true, deletedCount };
  } catch (error) {
    console.error(`[SQLITE CACHE] Error clearing search cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function clearTorrentCache(service = null) {
  if (!isEnabled()) {
    console.log('[SQLITE CACHE] SQLite cache is not enabled, skipping clear');
    return { success: false, message: 'SQLite cache not enabled' };
  }
  try {
    if (debug) {
      const serviceMsg = service ? `for service: ${service}` : 'for all services';
      console.log(`[SQLITE CACHE] Starting clearTorrentCache operation ${serviceMsg}`);
    }
    
    const db = await getDatabase();
    if (!db) return { success: false, message: 'Database not available' };

    let result;
    const startTime = Date.now();
    if (service) {
      // Delete all records with a hash field for the specific service
      result = db.prepare(`
        DELETE FROM cache 
        WHERE hash IS NOT NULL AND service = ?
      `).run(service.toLowerCase());
    } else {
      // Delete all records with a hash field (torrent metadata)
      result = db.prepare(`
        DELETE FROM cache 
        WHERE hash IS NOT NULL
      `).run();
    }
    const duration = Date.now() - startTime;
    
    const deletedCount = db.prepare('SELECT changes()').get()['changes()'];
    const msg = service
      ? `Cleared ${deletedCount} torrent cache entries for ${service} in ${duration}ms`
      : `Cleared ${deletedCount} torrent cache entries for all services in ${duration}ms`;
    console.log(`[SQLITE CACHE] ${msg}`);
    return { success: true, deletedCount, message: msg };
  } catch (error) {
    console.error(`[SQLITE CACHE] Error clearing torrent cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function clearAllCache() {
  if (!isEnabled()) {
    console.log('[SQLITE CACHE] SQLite cache is not enabled, skipping clear');
    return { success: false, message: 'SQLite cache not enabled' };
  }
  try {
    if (debug) {
      console.log('[SQLITE CACHE] Starting clearAllCache operation');
    }
    
    const db = await getDatabase();
    if (!db) return { success: false, message: 'Database not available' };

    // Delete all records in the cache table
    const startTime = Date.now();
    const result = db.prepare('DELETE FROM cache').run();
    const duration = Date.now() - startTime;
    
    const deletedCount = db.prepare('SELECT changes()').get()['changes()'];
    console.log(`[SQLITE CACHE] Cleared ${deletedCount} total cache entries in ${duration}ms`);
    return { success: true, deletedCount };
  } catch (error) {
    console.error(`[SQLITE CACHE] Error clearing all cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function closeSqlite() {
  console.log('[SQLITE CACHE] Closing SQLite connection and cleaning up resources...');

  // Stop the upserts flush interval from debrid-helpers if needed
  try {
    if (debug) console.log('[SQLITE CACHE] Stopping upserts flush from debrid-helpers');
    const debridHelpers = await import('./debrid-helpers.js');
    if (debridHelpers.stopUpsertsFlush) {
      debridHelpers.stopUpsertsFlush();
      if (debug) console.log('[SQLITE CACHE] Upserts flush stopped');
    }
  } catch (err) {
    console.error(`[SQLITE CACHE] Error stopping upserts flush: ${err.message}`);
  }

  // Close SQLite database connection
  try {
    if (db) {
      if (debug) console.log('[SQLITE CACHE] Closing database connection');
      db.close();
      console.log('[SQLITE CACHE] SQLite database connection closed');
    } else if (debug) {
      console.log('[SQLITE CACHE] No database connection to close');
    }
  } catch (error) {
    console.error(`[SQLITE CACHE] Error closing SQLite database: ${error.message}`);
  }

  // Reset all connection state
  db = null;
  initPromise = null;

  console.log('[SQLITE CACHE] All SQLite resources cleaned up');
}

/**
 * Get cached search results for a specific query and service
 * @param {string} service - The debrid service (e.g., 'realdebrid', 'alldebrid')
 * @param {string} type - The media type ('movie', 'series')
 * @param {string} id - The media ID (e.g., 'tt1234567', 'tt1234567:1:5' for series)
 * @param {object} config - The user configuration object
 * @returns {object|null} The cached results or null if not found
 */
export async function getCachedSearchResults(service, type, id, config) {
  if (!isEnabled()) {
    if (debug) console.log(`[SQLITE CACHE] SQLite cache is not enabled, skipping search cache lookup for ${service}:${type}:${id}`);
    return null;
  }
  
  try {
    const db = await getDatabase();
    if (!db) return null;
    
    // Generate the same cache key as used in stream-provider.js
    const langKey = (config.Languages || []).join(',');
    const providerKey = String(service).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedId = type === 'series' ? id.replace(/:/g, '_') : id;
    const cacheKey = `${providerKey}-search-${'v2'}:${type}:${normalizedId}:${langKey}`;
    
    if (debug) {
      console.log(`[SQLITE CACHE] Getting cached search results for: ${cacheKey}`);
    }
    
    const stmt = db.prepare(`
      SELECT fileName, size, data, releaseKey, category, resolution, updatedAt, expiresAt
      FROM cache
      WHERE service = ? AND hash = ? AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP)
    `);
    
    const serviceKey = String(service || '').toLowerCase();
    const hashKey = String(cacheKey || '').toLowerCase();
    
    const startTime = Date.now();
    const result = stmt.get(serviceKey, hashKey);
    const duration = Date.now() - startTime;
    
    if (result && result.data) {
      // Parse the JSON data
      try {
        result.data = JSON.parse(result.data);
      } catch (e) {
        console.warn(`[SQLITE CACHE] Error parsing cached data for hash ${cacheKey}: ${e.message}`);
        // Keep the original string if parsing fails
      }
    }
    
    if (debug) {
      console.log(`[SQLITE CACHE] Single search cache lookup took ${duration}ms for ${cacheKey}`);
    }
    
    return result;
  } catch (error) {
    console.warn(`[SQLITE CACHE] Error checking cached search results: ${error.message}`);
    return null;
  }
}

export default { 
  upsertCachedMagnet, 
  upsertCachedMagnets, 
  getCachedHashes, 
  getCachedRecord, 
  getReleaseCounts, 
  clearSearchCache, 
  clearTorrentCache, 
  clearAllCache, 
  closeSqlite,
  isEnabled,
  getCachedSearchResults
};