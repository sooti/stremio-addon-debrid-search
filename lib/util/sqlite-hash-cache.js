// Lightweight SQLite cache helper. All calls are best-effort and no-op when
// not configured or when the driver is unavailable.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;
let initTried = false;
let debug = (process.env.DEBRID_DEBUG_LOGS === 'true' || process.env.RD_DEBUG_LOGS === 'true' || process.env.SQLITE_DEBUG_LOGS === 'true' || process.env.DEBUG_SQLITE === 'true');
let isClosing = false; // Track if we're shutting down

function isEnabled() {
  const enabledFlag = process.env.SQLITE_CACHE_ENABLED;
  return enabledFlag == null ? true : String(enabledFlag).toLowerCase() === 'true';
}

async function ensureConnected() {
  if (isClosing) {
    if (debug) console.log('[SQLITE-CACHE] Not connecting: shutting down in progress');
    return false; // Don't reconnect during shutdown
  }
  if (!isEnabled()) {
    if (!initTried) {
      console.log('[SQLITE-CACHE] SQLite cache disabled');
      initTried = true;
    }
    return false;
  }
  if (db) {
    if (debug) console.log('[SQLITE-CACHE] Already connected to SQLite');
    return true;
  }
  
  if (debug) console.log('[SQLITE-CACHE] Establishing new SQLite connection...');
  try {
    if (debug) console.log('[SQLITE-CACHE] SQLite connecting...');
    
    // Create database file in data directory
    const dataDir = join(__dirname, '..', '..', 'data');
    const dbPath = join(dataDir, 'hash-cache.db');
    
    if (debug) console.log(`[SQLITE-CACHE] Database path: ${dbPath}`);
    
    // Ensure data directory exists
    import('fs').then(fs => {
      if (!fs.existsSync(dataDir)) {
        if (debug) console.log(`[SQLITE-CACHE] Creating data directory: ${dataDir}`);
        fs.mkdirSync(dataDir, { recursive: true });
      }
    }).catch(() => {
      // If import fails, we'll proceed without checking
    });

    db = new Database(dbPath, { 
      // Enable WAL mode for better concurrency
      WAL: true 
    });

    if (debug) console.log('[SQLITE-CACHE] Database connection established');

    // Create table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS hash_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        hash TEXT NOT NULL,
        cached BOOLEAN DEFAULT FALSE,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    if (debug) console.log('[SQLITE-CACHE] Table created/verified');
    
    // Create index for performance
    db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_hash ON hash_cache(provider, hash)`);
    
    if (debug) console.log('[SQLITE-CACHE] Index created/verified');
    
    // Trigger to update updatedAt on each update
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_hash_cache_timestamp 
      AFTER UPDATE ON hash_cache
      BEGIN
        UPDATE hash_cache SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END
    `);

    if (!initTried) {
      console.log('[SQLITE-CACHE] SQLite cache enabled');
      initTried = true;
    }
    if (debug) {
      const ttlDays = parseInt(process.env.SQLITE_CACHE_TTL_DAYS || '0', 10);
      console.log(`[SQLITE-CACHE] SQLite ready: database="hash-cache.db" ttlDays=${ttlDays}`);
    }
    return true;
  } catch (e) {
    if (!initTried) {
      console.log(`[SQLITE-CACHE] SQLite init failed: ${e?.message || e}`);
      initTried = true;
    }

    // Close database if connection failed
    if (db) {
      try {
        db.close();
        console.log('[SQLITE-CACHE] Closed failed SQLite database to prevent leaks');
      } catch (closeError) {
        console.error(`[SQLITE-CACHE] Error closing failed SQLite database: ${closeError.message}`);
      }
    }

    db = null;
    return false;
  }
}

export async function checkHashesCached(provider, hashes = []) {
  if (debug) {
    console.log(`[SQLITE-CACHE] [${provider}] Starting hash check for ${hashes.length} hashes`);
  }
  
  const ok = await ensureConnected();
  if (!ok || !Array.isArray(hashes) || hashes.length === 0) {
    if (debug) {
      console.log(`[SQLITE-CACHE] [${provider}] Connection not OK (${!ok}) or no hashes (${hashes.length}), returning empty set`);
    }
    return new Set();
  }
  
  try {
    const lowered = hashes.map(h => String(h).toLowerCase());
    const placeholders = lowered.map(() => '?').join(',');
    const sql = `
      SELECT DISTINCT hash 
      FROM hash_cache 
      WHERE provider = ? 
        AND hash IN (${placeholders}) 
        AND cached = true
    `;
    
    const stmt = db.prepare(sql);
    
    const startTime = Date.now();
    const rows = stmt.all(String(provider).toLowerCase(), ...lowered);
    const duration = Date.now() - startTime;
    
    const hits = new Set(rows.map(row => String(row.hash).toLowerCase()));
    
    if (debug) {
      const sample = Array.from(hits).slice(0, 5);
      console.log(`[SQLITE-CACHE] [${provider}] DB hash check: asked=${lowered.length} hits=${hits.size} sample=[${sample.join(', ')}] took=${duration}ms`);
    }
    return hits;
  } catch (error) {
    if (debug) {
      console.error(`[SQLITE-CACHE] [${provider}] Error in hash check: ${error.message}`);
    }
    return new Set();
  }
}

export async function upsertHashes(provider, statuses = []) {
  if (debug) {
    console.log(`[SQLITE-CACHE] [${provider}] Starting bulk upsert for ${statuses.length} statuses`);
  }
  
  const ok = await ensureConnected();
  if (!ok || !Array.isArray(statuses) || statuses.length === 0) {
    if (debug) {
      console.log(`[SQLITE-CACHE] [${provider}] Connection not OK (${!ok}) or no statuses (${statuses.length}), returning false`);
    }
    return false;
  }
  
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO hash_cache 
      (provider, hash, cached, updatedAt)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);
    
    // Use transaction for better performance
    const transaction = db.transaction((provider, statuses) => {
      for (const s of statuses) {
        if (!s || !s.hash) {
          if (debug) console.log(`[SQLITE-CACHE] [${provider}] Skipping invalid status: ${JSON.stringify(s)}`);
          continue;
        }
        stmt.run(
          String(provider).toLowerCase(),
          String(s.hash).toLowerCase(),
          Boolean(s.cached)
        );
      }
    });
    
    const startTime = Date.now();
    transaction(provider, statuses);
    const duration = Date.now() - startTime;
    
    if (debug) {
      console.log(`[SQLITE-CACHE] [${provider}] DB upsert: wrote=${statuses.length} records in ${duration}ms`);
    }
    return true;
  } catch (error) {
    if (debug) {
      console.error(`[SQLITE-CACHE] [${provider}] Error in bulk upsert: ${error.message}`);
    }
    return false;
  }
}

// Clean up expired entries based on TTL (if configured)
function setupCleanupJob() {
  if (!db) return;
  
  if (debug) console.log('[SQLITE-CACHE] Setting up periodic cleanup job for expired hash cache entries');
  
  // Clean up records periodically based on TTL if configured
  const ttlDays = parseInt(process.env.SQLITE_CACHE_TTL_DAYS || '0', 10);
  if (ttlDays > 0) {
    if (debug) console.log(`[SQLITE-CACHE] TTL cleanup configured for ${ttlDays} days`);
    // Run cleanup every 30 minutes
    setInterval(() => {
      try {
        if (debug) console.log('[SQLITE-CACHE] Running periodic cleanup of expired hash cache entries');
        
        const cutoffDate = new Date(Date.now() - (ttlDays * 24 * 60 * 60 * 1000)).toISOString();
        const startTime = Date.now();
        const result = db.prepare(`
          DELETE FROM hash_cache 
          WHERE updatedAt < ?
        `).run(cutoffDate);
        const duration = Date.now() - startTime;
        
        const changes = db.prepare('SELECT changes()').get()['changes()'];
        if (changes > 0) {
          console.log(`[SQLITE-CACHE] Cleaned up ${changes} expired hash cache entries in ${duration}ms`);
        } else if (debug) {
          console.log(`[SQLITE-CACHE] No expired hash cache entries to clean up (checked in ${duration}ms)`);
        }
      } catch (error) {
        console.error(`[SQLITE-CACHE] Error cleaning up expired hash cache entries: ${error.message}`);
      }
    }, 30 * 60 * 1000); // 30 minutes
  } else if (debug) {
    console.log('[SQLITE-CACHE] TTL cleanup not configured (SQLITE_CACHE_TTL_DAYS is 0 or not set)');
  }
}

// Gracefully close SQLite connection
export async function closeConnection() {
  console.log('[SQLITE-CACHE] Closing SQLite connection...');
  isClosing = true;

  try {
    if (db) {
      db.close();
      console.log('[SQLITE-CACHE] SQLite database connection closed');
    }
  } catch (error) {
    console.error(`[SQLITE-CACHE] Error closing SQLite database: ${error.message}`);
  }

  // Reset all connection state
  db = null;
  initTried = false;
  isClosing = false;

  console.log('[SQLITE-CACHE] SQLite resources cleaned up');
}

// Initialize cleanup job if needed
export async function initCleanup() {
  if (await ensureConnected()) {
    setupCleanupJob();
  }
}

export { isEnabled };

export default { checkHashesCached, upsertHashes, closeConnection, initCleanup, isEnabled };