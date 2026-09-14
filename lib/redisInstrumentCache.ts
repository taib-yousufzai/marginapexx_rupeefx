import { getRedisClient, isRedisMock } from './redis';
import { isContractExpired, parseContractExpiry } from './contractExpiry';

export interface CachedInstrumentMeta {
  token: number;
  canonicalId: string;
  expiry?: string | null;
  isExpired: boolean;
}

/**
 * High-performance Redis caching layer for instrument mapping and contract expiry checks.
 * Eliminates redundant Supabase/PostgreSQL queries and regex parsing loops.
 */

const MEM_META_CACHE = new Map<string, CachedInstrumentMeta>();
const MAX_MEM_CACHE_SIZE = 2000;

function trimMemCacheIfNeeded() {
  if (MEM_META_CACHE.size > MAX_MEM_CACHE_SIZE) {
    const keysToDelete = Array.from(MEM_META_CACHE.keys()).slice(0, 500);
    keysToDelete.forEach(k => MEM_META_CACHE.delete(k));
  }
}

/**
 * Check whether a contract is expired using Redis + in-memory cache.
 * Falls back to deterministic rule parsing (contractExpiry.ts) and caches the result.
 */
export async function isContractExpiredRedis(symbol: string, dbExpiry?: string | null): Promise<boolean> {
  if (!symbol) return false;

  // 1. Process-level in-memory cache (0ms)
  const memHit = MEM_META_CACHE.get(symbol);
  if (memHit) {
    return memHit.isExpired;
  }

  const todayIso = new Date().toISOString().split('T')[0];

  // If explicit dbExpiry column is passed, check it first
  if (dbExpiry && dbExpiry < todayIso) {
    MEM_META_CACHE.set(symbol, { token: 0, canonicalId: symbol, expiry: dbExpiry, isExpired: true });
    return true;
  }

  // 2. Redis cache check
  const redis = getRedisClient();
  const redisExpiryKey = `instrument:expiry:${symbol}`;

  try {
    const cachedStatus = await redis.get(redisExpiryKey);
    if (cachedStatus !== null) {
      const isExpired = cachedStatus === '1';
      MEM_META_CACHE.set(symbol, { token: 0, canonicalId: symbol, expiry: dbExpiry, isExpired });
      return isExpired;
    }
  } catch (err) {
    // Redis unavailable, fallback to deterministic parser
  }

  // 3. Fallback deterministic parser check
  const isExpired = isContractExpired(symbol);

  // 4. Cache in Redis (24-hour TTL) & process memory
  try {
    await redis.setex(redisExpiryKey, 86400, isExpired ? '1' : '0');
  } catch (_) {}

  trimMemCacheIfNeeded();
  MEM_META_CACHE.set(symbol, { token: 0, canonicalId: symbol, expiry: dbExpiry, isExpired });
  return isExpired;
}

/**
 * Retrieve cached instrument token and metadata from Redis.
 */
export async function getRedisInstrumentMeta(symbol: string): Promise<CachedInstrumentMeta | null> {
  if (!symbol) return null;

  const memHit = MEM_META_CACHE.get(symbol);
  if (memHit && memHit.token > 0) {
    return memHit;
  }

  const redis = getRedisClient();
  const cacheKey = `instrument:meta:${symbol}`;

  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const parsed: CachedInstrumentMeta = JSON.parse(raw);
      MEM_META_CACHE.set(symbol, parsed);
      return parsed;
    }
  } catch (_) {}

  return null;
}

/**
 * Cache instrument token and metadata into Redis (24-hour TTL).
 */
export async function setRedisInstrumentMeta(
  symbol: string,
  data: { token: number; canonicalId: string; expiry?: string | null; isExpired?: boolean }
): Promise<void> {
  if (!symbol || !data.token) return;

  const todayIso = new Date().toISOString().split('T')[0];
  const isExpired = data.isExpired ?? (data.expiry ? data.expiry < todayIso : isContractExpired(symbol));

  const meta: CachedInstrumentMeta = {
    token: data.token,
    canonicalId: data.canonicalId || symbol,
    expiry: data.expiry ?? null,
    isExpired,
  };

  trimMemCacheIfNeeded();
  MEM_META_CACHE.set(symbol, meta);

  const redis = getRedisClient();
  try {
    await Promise.all([
      redis.setex(`instrument:meta:${symbol}`, 86400, JSON.stringify(meta)),
      redis.setex(`instrument_token:${symbol}`, 86400, `${data.token}|${data.canonicalId}`),
      redis.setex(`instrument:expiry:${symbol}`, 86400, isExpired ? '1' : '0'),
    ]);
  } catch (_) {}
}
