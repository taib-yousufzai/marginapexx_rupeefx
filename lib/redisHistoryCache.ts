import { getRedisClient } from './redis';

const HISTORY_CACHE_TTL_SEC = 3600; // 1 hour sliding TTL for historical records
const ACTIVE_CACHE_TTL_SEC = 30;    // 30s TTL for active/open orders

/**
 * Get cached user orders list from Redis
 */
export async function getCachedUserOrders(userId: string, isHistory = false): Promise<any[] | null> {
  try {
    const redis = getRedisClient();
    const key = isHistory ? `api:orders:${userId}:history` : `api:orders:${userId}:active`;
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.orders)) return parsed.orders;
    }
  } catch (err) {
    console.warn('[getCachedUserOrders] Redis read error:', err);
  }
  return null;
}

/**
 * Set cached user orders list in Redis
 */
export async function setCachedUserOrders(userId: string, orders: any[], isHistory = false): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = isHistory ? `api:orders:${userId}:history` : `api:orders:${userId}:active`;
    const ttl = isHistory ? HISTORY_CACHE_TTL_SEC : ACTIVE_CACHE_TTL_SEC;
    await redis.setex(key, ttl, JSON.stringify(orders));
  } catch (err) {
    console.warn('[setCachedUserOrders] Redis write error:', err);
  }
}

/**
 * Prepend or update a newly placed/executed order directly in the user's Redis orders cache
 */
export async function appendOrderToCache(userId: string, order: any): Promise<void> {
  try {
    const isHistory = ['EXECUTED', 'executed', 'REJECTED', 'rejected', 'CANCELLED', 'cancelled'].includes(order.status);
    const existing = await getCachedUserOrders(userId, isHistory);
    let updated: any[] = [];
    if (Array.isArray(existing) && existing.length > 0) {
      updated = [order, ...existing.filter((o: any) => o && o.id !== order.id)];
    } else {
      updated = [order];
    }
    if (updated.length > 500) updated = updated.slice(0, 500);
    await setCachedUserOrders(userId, updated, isHistory);
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
    // Secondary fallback
    if (keySuffix !== 'closed_all') {
      const fallback = await redis.get(`api:positions:${userId}:closed_all`);
      if (fallback) {
        const parsed = JSON.parse(fallback);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.positions)) return parsed.positions;
      }
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
 * Invalidate open/active positions cache in Redis without wiping closed history
 */
export async function invalidateUserOpenPositionsCache(userId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    // Explicitly delete known open position keys instead of using the potentially disabled/slow 'keys' command
    const keysToDelete = [
      `api:positions:${userId}:open:default:`,
      `api:positions:${userId}:open:all:`,
      `api:positions:${userId}:active:default:`,
      `api:positions:${userId}:active:all:`
    ];
    await redis.del(...keysToDelete);
  } catch (err) {
    console.warn('[invalidateUserOpenPositionsCache] Redis delete error:', err);
  }
}

/**
 * Invalidate active/pending orders cache in Redis without wiping historical orders
 */
export async function invalidateUserActiveOrdersCache(userId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    // Explicitly delete known order keys instead of using 'keys' command
    const keysToDelete = [
      `api:orders:${userId}:active`,
      `api:orders:${userId}:open`
    ];
    await redis.del(...keysToDelete);
  } catch (err) {
    console.warn('[invalidateUserActiveOrdersCache] Redis delete error:', err);
  }
}

/**
 * Invalidate all cached user order and position history in Redis
 */
export async function invalidateUserHistoryCache(userId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    // Explicitly delete known keys instead of using the potentially disabled/slow 'keys' command
    const keysToDelete = [
      `api:orders:${userId}:history`,
      `api:orders:${userId}:active`,
      `api:orders:${userId}:open`,
      `api:positions:${userId}:closed:all:`,
      `api:positions:${userId}:closed:default:`,
      `api:positions:${userId}:closed_all`,
      `api:positions:${userId}:open:all:`,
      `api:positions:${userId}:open:default:`,
      `api:positions:${userId}:active:all:`,
      `api:positions:${userId}:active:default:`
    ];
    await redis.del(...keysToDelete);
  } catch (err) {
    console.warn('[invalidateUserHistoryCache] Redis delete error:', err);
  }
}

export const invalidateUserPositionsCache = invalidateUserOpenPositionsCache;
export const invalidateUserOrdersCache = invalidateUserActiveOrdersCache;

