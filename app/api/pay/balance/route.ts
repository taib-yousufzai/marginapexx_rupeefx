/**
 * GET /api/pay/balance
 *
 * Returns the authenticated user's ledger balance, computed as the sum of all
 * DEPOSIT transaction amounts minus the sum of all WITHDRAWAL transaction amounts.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 19.2
 */

import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getRedisClient } from '@/lib/redis';
import { isRailwayDbConfigured, getRailwayUserBalanceAndSettlement } from '@/lib/railway-db';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const redis = getRedisClient();
    const cacheKey = `user_balance:${user.id}`;

    // 1. Try Railway Postgres FIRST (< 1ms in-cluster query)
    if (isRailwayDbConfigured()) {
      try {
        const railwayBalance = await getRailwayUserBalanceAndSettlement(user.id);
        if (railwayBalance !== null) {
          const { balance, settlementAmount } = railwayBalance;
          // Update Redis cache in background (TTL = 30s)
          redis.set(cacheKey, JSON.stringify({ balance, settlementAmount }), 'EX', 30).catch(() => {});
          return Response.json({ balance, settlementAmount }, { status: 200 });
        }
      } catch (rErr) {
        console.warn('[GET /api/pay/balance] Railway DB read failed, falling back to Supabase:', rErr);
      }
    }

    // 2. Fallback to Redis cache & Supabase Cloud
    const adminClient = getAdminClient();

    const [cachedRaw, dbResult] = await Promise.allSettled([
      redis.get(cacheKey),
      adminClient
        .from('profiles')
        .select('balance, settlement_amount')
        .eq('id', user.id)
        .single()
        .abortSignal(AbortSignal.timeout(4000)),
    ]);

    // Parse cache result
    let cachedBalance: number | null = null;
    let cachedSettlement: number | null = null;
    if (cachedRaw.status === 'fulfilled' && cachedRaw.value) {
      try {
        const parsed = JSON.parse(cachedRaw.value);
        if (typeof parsed?.balance === 'number') {
          cachedBalance = parsed.balance;
          cachedSettlement = parsed.settlementAmount ?? 0;
        }
      } catch {}
    }

    // Try to use Supabase DB result
    if (dbResult.status === 'fulfilled') {
      const { data: profile, error: profileError } = dbResult.value;
      if (!profileError && profile) {
        const balance = Number(profile.balance || 0);
        const settlementAmount = Math.abs(Number(profile.settlement_amount || 0));

        // Update Redis cache in the background (TTL = 30s)
        redis.set(cacheKey, JSON.stringify({ balance, settlementAmount }), 'EX', 30).catch(() => {});

        return Response.json({ balance, settlementAmount }, { status: 200 });
      }
    }

    // DB failed or timed out — serve stale cache if available (beats a 504)
    if (cachedBalance !== null) {
      return Response.json(
        { balance: cachedBalance, settlementAmount: cachedSettlement ?? 0, stale: true },
        { status: 200 },
      );
    }

    // Nothing worked
    console.error('[GET /api/pay/balance] DB failed and no cache available');
    return Response.json({ error: 'Balance query timeout' }, { status: 504 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
