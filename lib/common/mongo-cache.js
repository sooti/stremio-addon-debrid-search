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

// Remove duplicate entries - only run if MONGO_FORCE_CLEANUP env var is set
async function removeDuplicateEntries(collection) {
  // Skip this expensive operation unless explicitly requested
  if (process.env.MONGO_FORCE_CLEANUP !== 'true') {
    console.log('[MONGO CACHE] Skipping duplicate cleanup (set MONGO_FORCE_CLEANUP=true to enable)');
    return;
  }

  try {
    console.log('[MONGO CACHE] Running duplicate cleanup (this may take a while)...');

    // Use more efficient aggregation with sampling for large collections
    const sampleSize = 10000; // Sample first to check if cleanup is needed
    const duplicates = await collection.aggregate([
      { $sample: { size: sampleSize } },
      {
        $group: {
          _id: { service: "$service", hash: "$hash" },
          count: { $sum: 1 },
          ids: { $push: "$_id" }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();

    if (duplicates.length > 0) {
      console.log(`[MONGO CACHE] Found duplicates in sample, running full cleanup...`);

      // Use bulk operations for better performance
      const bulkOps = [];
      for (const dup of duplicates) {
        // Keep first, remove rest
        const idsToRemove = dup.ids.slice(1);
        for (const id of idsToRemove) {
          bulkOps.push({ deleteOne: { filter: { _id: id } } });
        }
      }

      if (bulkOps.length > 0) {
        const result = await collection.bulkWrite(bulkOps, { ordered: false });
        console.log(`[MONGO CACHE] Removed ${result.deletedCount} duplicate documents.`);
      }
    } else {
      console.log('[MONGO CACHE] No duplicate entries found in sample.');
    }
  } catch (error) {
    console.error(`[MONGO CACHE] Error removing duplicate entries: ${error.message}`);
    // Don't throw - continue with initialization
  }
}

export async function initMongo() {
  if (!isEnabled()) return null;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let tempClient = null;
    try {
      const { MongoClient } = await import('mongodb');
      // Optimized connection pool for multi-user scalability
      tempClient = new MongoClient(config.MONGO_URI, {
        maxPoolSize: 30, // Further increased for better multi-user support (was 15)
        minPoolSize: 10,  // Further increased to maintain warm connections (was 5)
        serverSelectionTimeoutMS: 10000, // Increased for better resilience under load (was 5000)
        socketTimeoutMS: 60000, // Increased for better performance during peak loads (was 30000)
        maxIdleTimeMS: 300000, // 5 minutes for idle connections (was 180000)
        maxConnecting: 10, // Limit concurrent connection attempts
        // Enable compression for better network performance
        compressors: ['zlib'], // Using zlib to avoid potential zstd issues
        zlibCompressionLevel: 6, // Increased compression level for better network efficiency
        // Connection monitoring
        monitorCommands: false, // Disable for better performance
        ignoreUndefined: true, // Ignore undefined values in queries
        // Retry settings for better resilience
        retryWrites: true,
        retryReads: true,
      });
      await tempClient.connect();

      // Only assign to module-level variables after successful connection
      client = tempClient;
      db = client.db(config.MONGO_DB_NAME);
      col = db.collection(config.MONGO_CACHE_COLLECTION);

      // Check which indexes already exist
      // Note: listIndexes() fails if collection doesn't exist yet, which is fine
      let existingIndexNames = new Set();
      try {
        const indexes = await col.listIndexes().toArray();
        existingIndexNames = new Set(indexes.map(idx => idx.name));
      } catch (err) {
        // Collection doesn't exist yet - this is fine, it will be created on first write
        if (err.code === 26 || err.message.includes('ns does not exist')) {
          console.log(`[MONGO CACHE] Collection doesn't exist yet, will be created on first write`);
        } else {
          throw err; // Re-throw unexpected errors
        }
      }

      // Only create indexes if they don't exist (avoid unnecessary rebuilds)
      const indexesToCreate = [];

      if (!existingIndexNames.has('expiresAt_1')) {
        indexesToCreate.push({ key: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'expiresAt_1' } });
      }

      if (!existingIndexNames.has('service_1_hash_1')) {
        // Before creating unique index, optionally remove duplicates
        await removeDuplicateEntries(col);
        indexesToCreate.push({
          key: { service: 1, hash: 1 },
          options: { unique: true, sparse: true, name: 'service_1_hash_1' }
        });
      }

      if (!existingIndexNames.has('service_1_releaseKey_1')) {
        indexesToCreate.push({
          key: { service: 1, releaseKey: 1 },
          options: { sparse: true, name: 'service_1_releaseKey_1' }
        });
      }

      if (!existingIndexNames.has('service_1_releaseKey_1_expiresAt_1')) {
        indexesToCreate.push({
          key: { service: 1, releaseKey: 1, expiresAt: 1 },
          options: { sparse: true, name: 'service_1_releaseKey_1_expiresAt_1' }
        });
      }

      // Add compound indexes for better performance on common queries
      if (!existingIndexNames.has('service_1_hash_1_expiresAt_1')) {
        indexesToCreate.push({
          key: { service: 1, hash: 1, expiresAt: 1 },
          options: { name: 'service_1_hash_1_expiresAt_1' }
        });
      }

      if (!existingIndexNames.has('hash_1_service_1')) {
        indexesToCreate.push({
          key: { hash: 1, service: 1 },
          options: { name: 'hash_1_service_1' }
        });
      }

      // Create all indexes in parallel for faster startup
      if (indexesToCreate.length > 0) {
        console.log(`[MONGO CACHE] Creating ${indexesToCreate.length} missing indexes...`);
        await Promise.all(
          indexesToCreate.map(({ key, options }) =>
            col.createIndex(key, options).catch(err => {
              console.warn(`[MONGO CACHE] Index creation warning: ${err.message}`);
            })
          )
        );
      }

      console.log('[MONGO CACHE] Successfully connected to MongoDB with optimized configuration');
      return col;
    } catch (error) {
      console.warn(`[MONGO CACHE] Failed to connect to MongoDB: ${error.message}`);
      console.warn('[MONGO CACHE] Falling back to no-cache mode');

      // CRITICAL FIX: Close the client if it was created but connection failed
      if (tempClient) {
        try {
          await tempClient.close();
          console.log('[MONGO CACHE] Closed failed MongoDB client to prevent connection leak');
        } catch (closeError) {
          console.error(`[MONGO CACHE] Error closing failed client: ${closeError.message}`);
        }
      }

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
    
    const serviceKey = String(service || '').toLowerCase();
    const results = new Set();
    const hashesToCheck = lower;
    
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
    foundHashes.forEach(hash => results.add(hash));
    
    console.log(`[MONGO CACHE] Found ${foundHashes.length} cached hashes for service ${service}`);
    return results;
  } catch (error) {
    console.warn(`[MONGO CACHE] Error checking cached hashes: ${error.message}`);
    console.warn('[MONGO CACHE] Falling back to no cache');
    return new Set();
  }
}





export async function getCachedRecord(service, hash) {
  if (!isEnabled()) {
    console.log(`[MONGO CACHE] MongoDB cache is not enabled, skipping single hash check for ${hash}`);
    return null;
  }
  try {
    const c = await getCollection();
    if (!c) return null;
    

    
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
  let cursor = null;
  try {
    cursor = c.find(
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
  } finally {
    // Ensure cursor is closed even if an error occurs
    if (cursor) {
      try {
        await cursor.close();
      } catch (closeError) {
        // Ignore cursor close errors
      }
    }
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



export async function closeMongo() {
  console.log('[MONGO CACHE] Closing MongoDB connection and cleaning up resources...');



  // Stop the upserts flush interval from debrid-helpers
  try {
    const debridHelpers = await import('../util/debrid-helpers.js');
    if (debridHelpers.stopUpsertsFlush) {
      debridHelpers.stopUpsertsFlush();
    }
  } catch (err) {
    console.error(`[MONGO CACHE] Error stopping upserts flush: ${err.message}`);
  }

  // Close MongoDB client connection
  try {
    if (client) {
      await client.close();
      console.log('[MONGO CACHE] MongoDB client connection closed');
    }
  } catch (error) {
    console.error(`[MONGO CACHE] Error closing MongoDB client: ${error.message}`);
  }



  // Reset all connection state
  client = null;
  db = null;
  col = null;
  initPromise = null;

  console.log('[MONGO CACHE] All MongoDB resources cleaned up');
}

export default { upsertCachedMagnet, upsertCachedMagnets, getCachedHashes, getCachedRecord, getReleaseCounts, clearSearchCache, clearTorrentCache, clearAllCache, closeMongo };