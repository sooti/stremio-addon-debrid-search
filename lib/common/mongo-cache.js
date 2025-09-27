import * as config from '../config.js';

let client = null;
let db = null;
let col = null;
let initPromise = null;

function isEnabled() {
  return Boolean(config.MONGO_CACHE_ENABLED && config.MONGO_URI);
}

async function initMongo() {
  if (!isEnabled()) return null;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { MongoClient } = await import('mongodb');
    client = new MongoClient(config.MONGO_URI, { maxPoolSize: 5 });
    await client.connect();
    db = client.db(config.MONGO_DB_NAME);
    col = db.collection(config.MONGO_CACHE_COLLECTION);
    // TTL index on expiresAt (per-document expiry)
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Fast lookup + ensure uniqueness per service/hash
    await col.createIndex({ service: 1, hash: 1 }, { unique: true });
    return col;
  })();
  return initPromise;
}

async function getCollection() {
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
  if (!isEnabled()) return false;
  try {
    const c = await getCollection();
    if (!c) return false;
    const service = String(record.service || '').toLowerCase();
    const hash = String(record.hash || '').toLowerCase();
    if (!service || !hash) return false;
    const now = new Date();
    const expiresAt = ttlDate();
    const update = {
      $set: {
        service,
        hash,
        fileName: record.fileName || null,
        size: typeof record.size === 'number' ? record.size : null,
        data: record.data || null,
        updatedAt: now,
        expiresAt
      },
      $setOnInsert: { createdAt: now }
    };
    await c.updateOne({ service, hash }, update, { upsert: true });
    return true;
  } catch (_) {
    return false;
  }
}

// Return Set of hashes known cached for the given service
export async function getCachedHashes(service, hashes) {
  if (!isEnabled()) return new Set();
  const c = await getCollection();
  if (!c || !Array.isArray(hashes) || hashes.length === 0) return new Set();
  const lower = hashes.map(h => String(h || '').toLowerCase()).filter(Boolean);
  if (lower.length === 0) return new Set();
  const cursor = c.find({ service: String(service || '').toLowerCase(), hash: { $in: lower } }, { projection: { hash: 1 } });
  const found = await cursor.toArray();
  return new Set(found.map(d => d.hash));
}

export async function getCachedRecord(service, hash) {
  if (!isEnabled()) return null;
  const c = await getCollection();
  if (!c) return null;
  return c.findOne({ service: String(service || '').toLowerCase(), hash: String(hash || '').toLowerCase() });
}

export async function closeMongo() {
  try { await client?.close(); } catch (_) {}
  client = null; db = null; col = null; initPromise = null;
}

export default { isEnabled, initMongo, upsertCachedMagnet, getCachedHashes, getCachedRecord, closeMongo };

