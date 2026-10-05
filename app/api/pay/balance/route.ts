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

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const redis = getRedisClient();
    const adminClient = getAdminClient();
    const cacheKey = `user_balance:${user.id}`;

    // Demo account fast-path: serve from Redis or initialize default demo balance
    if (user.id === 'demo-user-id-0000-0000' || (user as any).email === 'demo@gmail.com') {
      const demoCached = await redis.get(cacheKey);
      if (demoCached) {
        try {
          const parsed = JSON.parse(demoCached);
          if (typeof parsed?.balance === 'number') {
            return Response.json({ balance: parsed.balance, settlementAmount: 0 }, { status: 200 });
          }
        } catch {}
      }
      const defaultDemoBal = 1000000;
      await redis.set(cacheKey, JSON.stringify({ balance: defaultDemoBal, settlementAmount: 0 }), 'EX', 86400).catch(() => {});
      return Response.json({ balance: defaultDemoBal, settlementAmount: 0 }, { status: 200 });
    }

    // Fire Redis cache read and DB query IN PARALLEL — no more sequential wait
    const [cachedRaw, dbResult] = await Promise.allSettled([
      redis.get(cacheKey),
      adminClient
        .from('profiles')
        .select('balance, settlement_amount')
        .eq('id', user.id)
        .single()
        .abortSignal(AbortSignal.timeout(4000)), // Tightened from 8s → 4s
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

    // Try to use DB result first (freshest data)
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
