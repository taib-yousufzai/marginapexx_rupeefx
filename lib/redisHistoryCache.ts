/**
 * lib/redisHistoryCache.ts
 *
 * Cross-device persistent Redis cache helper for user closed positions & order history.
 * Pre-fetches on login, serves in < 5ms, and appends closed positions / executed orders
 * incrementally on trade execution.
 */

import { getRedisClient } from '@/lib/redis';

const HISTORY_CACHE_TTL = 86400; // 24 hours

export async function getCachedClosedPositions(userId: string): Promise<any[] | null> {
  if (!userId) return null;
  try {
    const redis = getRedisClient();
    const cached = await redis.get(`cache:positions:closed:${userId}`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.warn('[RedisHistoryCache] getCachedClosedPositions error:', err);
  }
  return null;
}

export async function setCachedClosedPositions(userId: string, positions: any[]): Promise<void> {
  if (!userId) return;
  try {
    const redis = getRedisClient();
    await redis.setex(`cache:positions:closed:${userId}`, HISTORY_CACHE_TTL, JSON.stringify(positions));
  } catch (err) {
    console.warn('[RedisHistoryCache] setCachedClosedPositions error:', err);
  }
}

export async function appendClosedPosition(userId: string, position: any): Promise<void> {
  if (!userId || !position) return;
  try {
    const existing = await getCachedClosedPositions(userId);
    const updated = existing ? [position, ...existing.filter(p => p.id !== position.id)] : [position];
    await setCachedClosedPositions(userId, updated);
  } catch (err) {
    console.warn('[RedisHistoryCache] appendClosedPosition error:', err);
  }
}

export async function getCachedUserOrders(userId: string): Promise<any[] | null> {
  if (!userId) return null;
  try {
    const redis = getRedisClient();
    const cached = await redis.get(`cache:orders:${userId}`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.warn('[RedisHistoryCache] getCachedUserOrders error:', err);
  }
  return null;
}

export async function setCachedUserOrders(userId: string, orders: any[]): Promise<void> {
  if (!userId) return;
  try {
    const redis = getRedisClient();
    await redis.setex(`cache:orders:${userId}`, HISTORY_CACHE_TTL, JSON.stringify(orders));
  } catch (err) {
    console.warn('[RedisHistoryCache] setCachedUserOrders error:', err);
  }
}

export async function appendUserOrder(userId: string, order: any): Promise<void> {
  if (!userId || !order) return;
  try {
    const existing = await getCachedUserOrders(userId);
    const updated = existing ? [order, ...existing.filter(o => o.id !== order.id)] : [order];
    await setCachedUserOrders(userId, updated);
  } catch (err) {
    console.warn('[RedisHistoryCache] appendUserOrder error:', err);
  }
}

export async function invalidateUserHistoryCache(userId: string): Promise<void> {
  if (!userId) return;
  try {
    const redis = getRedisClient();
    await Promise.all([
      redis.del?.(`cache:positions:closed:${userId}`),
      redis.del?.(`cache:orders:${userId}`),
    ]);
  } catch (err) {
    console.warn('[RedisHistoryCache] invalidateUserHistoryCache error:', err);
  }
}
