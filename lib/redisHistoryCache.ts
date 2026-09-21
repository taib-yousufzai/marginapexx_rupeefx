import { getRedisClient } from './redis';

const HISTORY_CACHE_TTL_SEC = 3600; // 1 hour sliding TTL for history cache

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
 * Prepend or update a newly placed/executed order directly in the user's Redis orders cache
 */
export async function appendOrderToCache(userId: string, order: any): Promise<void> {
  try {
    const existing = await getCachedUserOrders(userId);
    let updated: any[] = [];
    if (Array.isArray(existing) && existing.length > 0) {
      updated = [order, ...existing.filter((o: any) => o && o.id !== order.id)];
    } else {
      updated = [order];
    }
    if (updated.length > 500) updated = updated.slice(0, 500);
    await setCachedUserOrders(userId, updated);
  } catch (err) {
    console.warn('[appendOrderToCache] Error:', err);
  }
}

/**
 * Get cached user closed positions list from Redis
 */
export async function getCachedUserPositions(userId: string, keySuffix: string = 'closed:all:'): Promise<any[] | null> {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(`api:positions:${userId}:${keySuffix}`);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.positions)) return parsed.positions;
    }
  } catch (err) {
    console.warn('[getCachedUserPositions] Redis read error:', err);
  }
  return null;
}

/**
 * Set cached user closed positions list in Redis
 */
export async function setCachedUserPositions(userId: string, positions: any[], keySuffix: string = 'closed:all:'): Promise<void> {
  try {
    const redis = getRedisClient();
    const payload = Array.isArray(positions) ? { positions } : positions;
    await redis.setex(
      `api:positions:${userId}:${keySuffix}`,
      HISTORY_CACHE_TTL_SEC,
      JSON.stringify(payload)
    );
  } catch (err) {
    console.warn('[setCachedUserPositions] Redis write error:', err);
  }
}

/**
 * Prepend or update a closed position directly in the user's Redis closed positions cache
 */
export async function appendClosedPositionToCache(userId: string, closedPosition: any): Promise<void> {
  try {
    const formatted = {
      ...closedPosition,
      status: 'closed',
      product_type: closedPosition.product_type || 'INTRADAY',
      kite_instrument: closedPosition.kite_instrument || closedPosition.symbol,
      brokerage: Number(closedPosition.brokerage || 0),
      locked_margin: 0,
    };
    for (const suffix of ['closed:all:', 'closed:default:', 'closed_all']) {
      const existing = await getCachedUserPositions(userId, suffix);
      let updated: any[] = [];
      if (Array.isArray(existing) && existing.length > 0) {
        updated = [formatted, ...existing.filter((p: any) => p && p.id !== formatted.id)];
      } else {
        updated = [formatted];
      }
      if (updated.length > 500) updated = updated.slice(0, 500);
      await setCachedUserPositions(userId, updated, suffix);
    }
  } catch (err) {
    console.warn('[appendClosedPositionToCache] Error:', err);
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
