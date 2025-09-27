// Lightweight MongoDB cache helper. All calls are best-effort and no-op when
// not configured or when the driver is unavailable.

let client = null;
let db = null;
let coll = null;
let initTried = false;
let debug = (process.env.DEBRID_DEBUG_LOGS === 'true' || process.env.RD_DEBUG_LOGS === 'true');

function isEnabled() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const enabledFlag = process.env.MONGO_CACHE_ENABLED;
  if (!uri) return false;
  if (enabledFlag == null) return true; // default on when URI present
  return String(enabledFlag).toLowerCase() === 'true';
}

async function ensureConnected() {
  if (!isEnabled()) {
    if (!initTried) {
      console.log('[CACHE] MongoDB cache disabled');
      initTried = true;
    }
    return false;
  }
  if (db && coll) return true;
  try {
    if (debug) console.log('[CACHE] MongoDB connecting...');
    const mod = await import('mongodb').catch(() => null);
    if (!mod || !mod.MongoClient) {
      if (!initTried) {
        console.log('[CACHE] MongoDB driver not installed; disabling cache');
        initTried = true;
      }
      return false;
    }
    const { MongoClient } = mod;
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const dbName = process.env.MONGO_DB_NAME || 'sootio';
    const collName = process.env.MONGO_COLLECTION_NAME || process.env.MONGO_CACHE_COLLECTION || 'hashCache';
    client = new MongoClient(uri, { maxPoolSize: 5 });
    await client.connect();
    db = client.db(dbName);
    coll = db.collection(collName);
    await coll.createIndex({ provider: 1, hash: 1 }, { unique: true }).catch(() => {});
    const ttlDays = parseInt(process.env.MONGO_CACHE_TTL_DAYS || '0', 10);
    if (ttlDays > 0) {
      try { await coll.createIndex({ updatedAt: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 }); } catch {}
    }
    if (!initTried) {
      console.log('[CACHE] MongoDB cache enabled');
      initTried = true;
    }
    if (debug) console.log(`[CACHE] MongoDB ready: db="${dbName}" collection="${collName}" ttlDays=${isNaN(parseInt(process.env.MONGO_CACHE_TTL_DAYS || '0',10))?0:parseInt(process.env.MONGO_CACHE_TTL_DAYS || '0',10)}`);
    return true;
  } catch (e) {
    if (!initTried) {
      console.log(`[CACHE] MongoDB init failed: ${e?.message || e}`);
      initTried = true;
    }
    client = null; db = null; coll = null;
    return false;
  }
}

export async function checkHashesCached(provider, hashes = []) {
  const ok = await ensureConnected();
  if (!ok || !Array.isArray(hashes) || hashes.length === 0) return new Set();
  try {
    const lowered = hashes.map(h => String(h).toLowerCase());
    const query = { provider: String(provider).toLowerCase(), hash: { $in: lowered }, cached: true };
    const t0 = Date.now();
    const cursor = coll.find(query);
    const docs = await cursor.toArray();
    const hits = new Set(docs.map(d => String(d.hash).toLowerCase()));
    if (debug) {
      const sample = Array.from(hits).slice(0, 5);
      console.log(`[CACHE] [${provider}] DB pre-check: asked=${lowered.length} hits=${hits.size} time=${Date.now()-t0}ms sample=[${sample.join(', ')}]`);
    }
    return hits;
  } catch {
    return new Set();
  }
}

export async function upsertHashes(provider, statuses = []) {
  const ok = await ensureConnected();
  if (!ok || !Array.isArray(statuses) || statuses.length === 0) return false;
  try {
    const bulk = coll.initializeUnorderedBulkOp();
    let count = 0;
    for (const s of statuses) {
      if (!s || !s.hash) continue;
      count++;
      bulk.find({ provider: String(provider).toLowerCase(), hash: String(s.hash).toLowerCase() })
        .upsert().updateOne({
          $set: {
            provider: String(provider).toLowerCase(),
            hash: String(s.hash).toLowerCase(),
            cached: Boolean(s.cached),
            updatedAt: new Date()
          }
        });
    }
    if (count > 0) {
      const t0 = Date.now();
      const res = await bulk.execute();
      if (debug) {
        const nUpserted = res?.nUpserted ?? (res?.upserted?.length || 0);
        const nMatched = res?.nMatched ?? 0;
        const nModified = res?.nModified ?? 0;
        console.log(`[CACHE] [${provider}] DB upsert: wrote=${count} (upserted=${nUpserted} matched=${nMatched} modified=${nModified}) time=${Date.now()-t0}ms`);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export default { checkHashesCached, upsertHashes };
