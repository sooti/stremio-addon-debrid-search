/**
 * @fileoverview
 * General-purpose MongoDB caching utility for the application.
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
 * It uses a TTL (Time To Live) index in MongoDB to automatically expire stale documents.
 * The cache can be enabled/disabled via environment variables.
 */
import * as config from '../config.js';

let client = null;
let db = null;
let col = null;
let initPromise = null;

export function isEnabled() {
  return Boolean(config.MONGO_CACHE_ENABLED && config.MONGO_URI);
}

// Remove duplicate entries that might exist before creating a unique index
async function removeDuplicateEntries(collection) {
  try {
    console.log('[MONGO CACHE] Checking for duplicate entries before creating unique index...');
    
    // Count total documents first
    const totalDocs = await collection.countDocuments();
    console.log(`[MONGO CACHE] Total documents in collection: ${totalDocs}`);
    
    // Use aggregation to find duplicate service+hash combinations
    const duplicates = await collection.aggregate([
      {
        $group: {
          _id: { service: "$service", hash: "$hash" },
          count: { $sum: 1 },
          docs: { $push: { _id: "$_id", createdAt: "$createdAt", updatedAt: "$updatedAt" } }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]).toArray();

    if (duplicates.length > 0) {
      console.log(`[MONGO CACHE] Found ${duplicates.length} sets of duplicate entries, removing duplicates...`);
      
      let totalRemoved = 0;
      for (const dup of duplicates) {
        // Sort documents by date (most recent first) to keep the latest one
        const sortedDocs = dup.docs.sort((a, b) => {
          const dateA = new Date(b.updatedAt || b.createdAt || '1970-01-01');
          const dateB = new Date(a.updatedAt || a.createdAt || '1970-01-01');
          return dateA - dateB; // Descending order (most recent first)
        });

        // Remove all except the first one (most recent)
        const docsToRemove = sortedDocs.slice(1);
        for (const doc of docsToRemove) {
          await collection.deleteOne({ _id: doc._id });
          totalRemoved++;
        }
      }
      
      console.log(`[MONGO CACHE] Removed ${totalRemoved} duplicate documents.`);
    } else {
      console.log('[MONGO CACHE] No duplicate entries found.');
    }
  } catch (error) {
    console.error(`[MONGO CACHE] Error removing duplicate entries: ${error.message}`);
    console.error(`[MONGO CACHE] Stack trace: ${error.stack}`);
    // Don't throw the error since this is a cleanup operation
    // The unique index creation will still fail if there are still duplicates
  }
}

export async function initMongo() {
  if (!isEnabled()) return null;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const { MongoClient } = await import('mongodb');
      // Increase connection pool and optimize for performance
      client = new MongoClient(config.MONGO_URI, { 
        maxPoolSize: 20, // Increased from 5 to 20 for better concurrency
        minPoolSize: 5,  // Maintain minimum connections
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 30000,
        maxIdleTimeMS: 120000, // Close idle connections after 2 minutes
        // Enable compression for better network performance
        compressors: ['zlib'],
        zlibCompressionLevel: 6
      });
      await client.connect();
      db = client.db(config.MONGO_DB_NAME);
      col = db.collection(config.MONGO_CACHE_COLLECTION);
      
      // TTL index on expiresAt (per-document expiry)
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      
      // Check if unique index already exists before creating
      const indexName = 'service_1_hash_1';
      const indexes = await col.listIndexes().toArray();
      const existingIndex = indexes.find(idx => idx.name === indexName);
      
      if (existingIndex) {
        // If index exists, drop it first to be recreated with unique constraint
        console.log(`[CACHE] Dropping existing index '${indexName}' to apply new options.`);
        await col.dropIndex(indexName);
      }
      
      // Before creating the unique index, remove any existing duplicate entries
      await removeDuplicateEntries(col);
      
      // Create the unique index to prevent future duplicates
      await col.createIndex({ service: 1, hash: 1 }, { unique: true, sparse: true });
      // Release-level lookups - add compound indexes for faster queries
      await col.createIndex({ service: 1, releaseKey: 1 });
      await col.createIndex({ service: 1, releaseKey: 1, category: 1, resolution: 1 });
      
      // Add compound indexes for faster search cache lookups
      await col.createIndex({ _id: 1, expiresAt: 1 }); // For search cache with expiration
      await col.createIndex({ service: 1, releaseKey: 1, expiresAt: 1 }); // For time-based queries
      
      // For high-performance cache lookups - add more specific indexes
      await col.createIndex({ service: 1, hash: 1, expiresAt: 1 }, { unique: true, sparse: true }); // Include expiration in unique index
      
      console.log('[MONGO CACHE] Successfully connected to MongoDB with optimized configuration');
      return col;
    } catch (error) {
      console.warn(`[MONGO CACHE] Failed to connect to MongoDB: ${error.message}`);
      console.warn('[MONGO CACHE] Falling back to no-cache mode');
      // Reset connection state
      client = null;
      db = null;
      col = null;
      initPromise = null;
      return null;
    }
  })();
  return initPromise;
}

export async function getCollection() {
  if (!isEnabled()) return null;
  await initMongo();
  return col;
}

function ttlDate() {
  const days = Number(config.MONGO_CACHE_TTL_DAYS || 30);
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  return new Date(ms);
}

// Upsert a cached magnet record
// record: { service, hash, fileName?, size?, data? }
export async function upsertCachedMagnet(record) {
  if (!isEnabled()) {
    console.log(`[MONGO CACHE] MongoDB cache is not enabled, skipping upsert for hash ${record.hash}`);
    return false;
  }
  try {
    const c = await getCollection();
    if (!c) return false;
    const service = String(record.service || '').toLowerCase();
    const hash = String(record.hash || '').toLowerCase();
    if (!service || !hash) {
      console.log(`[MONGO CACHE] Invalid service (${service}) or hash (${hash}) for upsert`);
      return false;
    }
    const now = new Date();
    const expiresAt = ttlDate();
    const update = {
      $set: {
        service,
        hash,
        fileName: record.fileName || null,
        size: typeof record.size === 'number' ? record.size : null,
        data: record.data || null,
        // Optional release-level metadata
        releaseKey: record.releaseKey || null,
        category: record.category || null,
        resolution: record.resolution || null,
        updatedAt: now,
        expiresAt
      },
      $setOnInsert: { createdAt: now }
    };
    console.log(`[MONGO CACHE] Upserting magnet record for service ${service}, hash ${hash}`);
    await c.updateOne({ service, hash }, update, { upsert: true });
    
    // Update fast cache immediately
    const fastCacheKey = `record:${service}:${hash}`;
    FAST_CACHE.set(fastCacheKey, {
      data: {
        fileName: record.fileName || null,
        size: typeof record.size === 'number' ? record.size : null,
        data: record.data || null,
        releaseKey: record.releaseKey || null,
        category: record.category || null,
        resolution: record.resolution || null,
        updatedAt: now,
        expiresAt: expiresAt
      },
      expires: Date.now() + FAST_CACHE_TTL
    });
    
    // Also cache the individual hash existence
    const hashFastCacheKey = `hash:${service}:${hash}`;
    FAST_CACHE.set(hashFastCacheKey, {
      exists: true,
      expires: Date.now() + FAST_CACHE_TTL
    });
    
    manageFastCacheSize();
    
    console.log(`[MONGO CACHE] Successfully upserted magnet record for service ${service}, hash ${hash}`);
    return true;
  } catch (error) {
    console.error(`[MONGO CACHE] Error upserting magnet record: ${error.message}`);
    return false;
  }
}

// Upsert multiple cached magnet records - optimized for performance
export async function upsertCachedMagnets(records) {
  if (!isEnabled() || !Array.isArray(records) || records.length === 0) {
    return false;
  }
  try {
    const c = await getCollection();
    if (!c) return false;

    const now = new Date();
    const expiresAt = ttlDate();
    const operations = records.map(record => {
      const service = String(record.service || '').toLowerCase();
      const hash = String(record.hash || '').toLowerCase();
      if (!service || !hash) return null;

      return {
        updateOne: {
          filter: { service, hash },
          update: {
            $set: {
              service,
              hash,
              fileName: record.fileName || null,
              size: typeof record.size === 'number' ? record.size : null,
              data: record.data || null,
              releaseKey: record.releaseKey || null,
              category: record.category || null,
              resolution: record.resolution || null,
              updatedAt: now,
              expiresAt
            },
            $setOnInsert: { createdAt: now }
          },
          upsert: true
        }
      };
    }).filter(Boolean);

    if (operations.length > 0) {
      // Use ordered: false for better performance, allowing parallel execution
      await c.bulkWrite(operations, { 
        ordered: false,
        // Use write concern optimized for performance vs consistency for cache
        bypassDocumentValidation: false
      });
      
      // Update fast cache for all inserted records
      const nowTime = Date.now();
      for (const record of records) {
        const service = String(record.service || '').toLowerCase();
        const hash = String(record.hash || '').toLowerCase();
        if (service && hash) {
          // Update record cache
          const fastCacheKey = `record:${service}:${hash}`;
          FAST_CACHE.set(fastCacheKey, {
            data: {
              fileName: record.fileName || null,
              size: typeof record.size === 'number' ? record.size : null,
              data: record.data || null,
              releaseKey: record.releaseKey || null,
              category: record.category || null,
              resolution: record.resolution || null,
              updatedAt: now,
              expiresAt: expiresAt
            },
            expires: nowTime + FAST_CACHE_TTL
          });
          
          // Update hash existence cache
          const hashFastCacheKey = `hash:${service}:${hash}`;
          FAST_CACHE.set(hashFastCacheKey, {
            exists: true,
            expires: nowTime + FAST_CACHE_TTL
          });
        }
      }
      manageFastCacheSize();
    }
    return true;
  } catch (error) {
    console.error(`[MONGO CACHE] Error bulk upserting magnet records: ${error.message}`);
    return false;
  }
}

// Return Set of hashes known cached for the given service - optimized for performance
export async function getCachedHashes(service, hashes) {
  if (!isEnabled()) {
    console.log(`[MONGO CACHE] MongoDB cache is not enabled, skipping check for ${hashes?.length || 0} hashes`);
    return new Set();
  }
  try {
    const c = await getCollection();
    if (!c || !Array.isArray(hashes) || hashes.length === 0) {
      console.log(`[MONGO CACHE] No collection or empty hashes array, returning empty set`);
      return new Set();
    }
    const lower = hashes.map(h => String(h || '').toLowerCase()).filter(Boolean);
    if (lower.length === 0) {
      console.log(`[MONGO CACHE] No valid hashes after normalization, returning empty set`);
      return new Set();
    }
    
    // Use fast cache for individual lookups when checking many hashes
    const serviceKey = String(service || '').toLowerCase();
    const results = new Set();
    const hashesToCheck = [];
    
    // Check fast cache first for each hash
    for (const hash of lower) {
      const fastCacheKey = `hash:${serviceKey}:${hash}`;
      const fastCached = FAST_CACHE.get(fastCacheKey);
      if (fastCached && Date.now() < fastCached.expires) {
        results.add(hash);
      } else {
        hashesToCheck.push(hash);
      }
    }
    
    if (hashesToCheck.length === 0) {
      console.log(`[MONGO CACHE] All ${lower.length} hashes found in fast cache for service ${service}`);
      return results;
    }
    
    console.log(`[MONGO CACHE] Checking ${hashesToCheck.length} hashes for service ${service} (from ${lower.length} total)`);

    // Use find instead of aggregation for better performance with single field lookup
    const foundDocs = await c.find(
      { 
        service: serviceKey, 
        hash: { $in: hashesToCheck },
        expiresAt: { $gte: new Date() } // Only return non-expired documents
      },
      { projection: { hash: 1, _id: 0 } } // Only return the hash field
    ).toArray();

    const foundHashes = foundDocs.map(doc => doc.hash);
    
    // Update fast cache for found hashes
    const now = Date.now();
    for (const hash of foundHashes) {
      const fastCacheKey = `hash:${serviceKey}:${hash}`;
      FAST_CACHE.set(fastCacheKey, {
        exists: true,
        expires: now + FAST_CACHE_TTL
      });
      results.add(hash);
    }
    
    // Update fast cache for missing hashes too (to prevent repeated misses)
    for (const hash of hashesToCheck) {
      if (!foundHashes.includes(hash)) {
        const fastCacheKey = `hash:${serviceKey}:${hash}`;
        FAST_CACHE.set(fastCacheKey, {
          exists: false,
          expires: now + FAST_CACHE_TTL
        });
      }
    }
    
    manageFastCacheSize();
    
    console.log(`[MONGO CACHE] Found ${foundHashes.length} cached hashes for service ${service}`);
    return results;
  } catch (error) {
    console.warn(`[MONGO CACHE] Error checking cached hashes: ${error.message}`);
    console.warn('[MONGO CACHE] Falling back to no cache');
    return new Set();
  }
}

// Fast in-memory cache for frequently accessed items
const FAST_CACHE = new Map();
const FAST_CACHE_MAX_SIZE = 2000;
const FAST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper to manage fast cache size
function manageFastCacheSize() {
  if (FAST_CACHE.size > FAST_CACHE_MAX_SIZE) {
    // Remove oldest entries (FIFO)
    const firstKey = FAST_CACHE.keys().next().value;
    if (firstKey) {
      FAST_CACHE.delete(firstKey);
    }
  }
}

// Generate cache key for fast cache
function getFastCacheKey(service, hash) {
  return `record:${String(service || '').toLowerCase()}:${String(hash || '').toLowerCase()}`;
}

export async function getCachedRecord(service, hash) {
  if (!isEnabled()) {
    console.log(`[MONGO CACHE] MongoDB cache is not enabled, skipping single hash check for ${hash}`);
    return null;
  }
  try {
    const c = await getCollection();
    if (!c) return null;
    
    // Check fast cache first
    const fastCacheKey = getFastCacheKey(service, hash);
    const fastCached = FAST_CACHE.get(fastCacheKey);
    if (fastCached && Date.now() < fastCached.expires) {
      console.log(`[FAST CACHE] HIT for record: ${hash}`);
      return fastCached.data;
    }
    
    console.log(`[MONGO CACHE] Checking single hash ${hash} for service ${service}`);
    // Include expiration check in the query to leverage TTL index
    const result = await c.findOne(
      { 
        service: String(service || '').toLowerCase(), 
        hash: String(hash || '').toLowerCase(),
        expiresAt: { $gte: new Date() } // Only return non-expired documents
      },
      { projection: { _id: 0, service: 0 } } // Exclude _id and service from result since we know them
    );
    
    // Update fast cache if found
    if (result) {
      FAST_CACHE.set(fastCacheKey, {
        data: result,
        expires: Date.now() + FAST_CACHE_TTL
      });
      manageFastCacheSize();
    }
    
    console.log(`[MONGO CACHE] Found cached record for hash ${hash}: ${result ? 'YES' : 'NO'}`);
    return result;
  } catch (error) {
    console.warn(`[MONGO CACHE] Error checking cached record: ${error.message}`);
    console.warn('[MONGO CACHE] Falling back to no cache');
    return null;
  }
}

// Returns counts by category and by category+resolution for a given release key
// Shape: { byCategory: { Remux: n, BluRay: m, ... }, byCategoryResolution: { Remux: { '2160p': x, '1080p': y }, ... }, total: number }
export async function getReleaseCounts(service, releaseKey) {
  const empty = { byCategory: {}, byCategoryResolution: {}, total: 0 };
  if (!isEnabled()) return empty;
  const c = await getCollection();
  if (!c || !service || !releaseKey) return empty;
  const svc = String(service || '').toLowerCase();
  const rel = String(releaseKey);
  try {
    const cursor = c.find(
      { service: svc, releaseKey: rel },
      { projection: { _id: 0, category: 1, resolution: 1 } }
    );
    const byCategory = {};
    const byCategoryResolution = {};
    let total = 0;
    for await (const doc of cursor) {
      const cat = doc.category || 'Other';
      const res = doc.resolution || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      byCategoryResolution[cat] = byCategoryResolution[cat] || {};
      byCategoryResolution[cat][res] = (byCategoryResolution[cat][res] || 0) + 1;
      total += 1;
    }
    return { byCategory, byCategoryResolution, total };
  } catch (error) {
    console.error(`[MONGO CACHE] Error aggregating release counts for ${svc}/${rel}: ${error.message}`);
    return empty;
  }
}

export async function clearSearchCache() {
  if (!isEnabled()) {
    console.log('[MONGO CACHE] MongoDB cache is not enabled, skipping clear');
    return { success: false, message: 'MongoDB cache not enabled' };
  }
  try {
    const c = await getCollection();
    if (!c) return { success: false, message: 'Collection not available' };

    // Delete all documents with _id matching the search cache pattern (contains "-search:")
    const result = await c.deleteMany({ _id: { $regex: /-search:/ } });
    console.log(`[MONGO CACHE] Cleared ${result.deletedCount} search cache entries`);
    return { success: true, deletedCount: result.deletedCount };
  } catch (error) {
    console.error(`[MONGO CACHE] Error clearing search cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function clearTorrentCache(service = null) {
  if (!isEnabled()) {
    console.log('[MONGO CACHE] MongoDB cache is not enabled, skipping clear');
    return { success: false, message: 'MongoDB cache not enabled' };
  }
  try {
    const c = await getCollection();
    if (!c) return { success: false, message: 'Collection not available' };

    // Delete all documents that have a 'hash' field (torrent metadata)
    // and optionally filter by service
    const filter = { hash: { $exists: true } };
    if (service) {
      filter.service = service.toLowerCase();
    }

    const result = await c.deleteMany(filter);
    const msg = service
      ? `Cleared ${result.deletedCount} torrent cache entries for ${service}`
      : `Cleared ${result.deletedCount} torrent cache entries for all services`;
    console.log(`[MONGO CACHE] ${msg}`);
    return { success: true, deletedCount: result.deletedCount, message: msg };
  } catch (error) {
    console.error(`[MONGO CACHE] Error clearing torrent cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function clearAllCache() {
  if (!isEnabled()) {
    console.log('[MONGO CACHE] MongoDB cache is not enabled, skipping clear');
    return { success: false, message: 'MongoDB cache not enabled' };
  }
  try {
    const c = await getCollection();
    if (!c) return { success: false, message: 'Collection not available' };

    // Delete all documents in the collection
    const result = await c.deleteMany({});
    console.log(`[MONGO CACHE] Cleared ${result.deletedCount} total cache entries`);
    return { success: true, deletedCount: result.deletedCount };
  } catch (error) {
    console.error(`[MONGO CACHE] Error clearing all cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

// Clear the fast in-memory cache
export function clearFastCache() {
  FAST_CACHE.clear();
  console.log('[MONGO CACHE] Fast cache cleared');
}

// Periodic cleanup of expired fast cache entries
function initFastCacheCleanup() {
  // Clean up expired entries every 2 minutes
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of FAST_CACHE.entries()) {
      if (now >= value.expires) {
        FAST_CACHE.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[MONGO CACHE] Cleaned up ${cleaned} expired entries from fast cache`);
    }
  }, 2 * 60 * 1000); // Every 2 minutes
}

// Initialize cleanup when the module is loaded
initFastCacheCleanup();

export async function closeMongo() {
  try { 
    await client?.close(); 
  } catch (_) {}
  // Clear fast cache when closing MongoDB connection
  FAST_CACHE.clear();
  client = null; db = null; col = null; initPromise = null;
}

export default { upsertCachedMagnet, upsertCachedMagnets, getCachedHashes, getCachedRecord, getReleaseCounts, clearSearchCache, clearTorrentCache, clearAllCache, clearFastCache, closeMongo };