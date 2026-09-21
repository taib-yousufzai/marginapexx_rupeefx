import { getRedisClient } from './redis';

const HISTORY_CACHE_TTL_SEC = 30; // Short TTL for orders list cache

/**
 * Get cached user orders list from Redis
 */
export async function getCachedUserOrders(userId: string): Promise<any[] | null> {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(`api:orders:${userId}:full_history`);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[getCachedUserOrders] Redis read error:', err);
  }
  return null;
}

/**
 * Set cached user orders list in Redis
 */
export async function setCachedUserOrders(userId: string, orders: any[]): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.setex(
      `api:orders:${userId}:full_history`,
      HISTORY_CACHE_TTL_SEC,
      JSON.stringify(orders)
    );
  } catch (err) {
    console.warn('[setCachedUserOrders] Redis write error:', err);
  }
}

/**
 * Get cached user closed positions list from Redis
 */
export async function getCachedUserPositions(userId: string, keySuffix: string = 'closed_all'): Promise<any[] | null> {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(`api:positions:${userId}:${keySuffix}`);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[getCachedUserPositions] Redis read error:', err);
  }
  return null;
}

/**
 * Set cached user closed positions list in Redis
 */
export async function setCachedUserPositions(userId: string, positions: any[], keySuffix: string = 'closed_all'): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.setex(
      `api:positions:${userId}:${keySuffix}`,
      HISTORY_CACHE_TTL_SEC,
      JSON.stringify(positions)
    );
  } catch (err) {
    console.warn('[setCachedUserPositions] Redis write error:', err);
  }
}

/**
 * Invalidate all cached user order and position history in Redis
 */
export async function invalidateUserHistoryCache(userId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const orderKeys = (await redis.keys(`api:orders:${userId}:*`)) || [];
    const posKeys = (await redis.keys(`api:positions:${userId}:*`)) || [];
    const allKeys = [...orderKeys, ...posKeys, `api:orders:${userId}:full_history`];
    const uniqueKeys = Array.from(new Set(allKeys));
    if (uniqueKeys.length > 0) {
      await redis.del(...uniqueKeys);
    }
  } catch (err) {
    console.warn('[invalidateUserHistoryCache] Redis delete error:', err);
  }
}
