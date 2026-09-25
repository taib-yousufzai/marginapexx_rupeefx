export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getRedisClient } from '@/lib/redis';
import { getCachedUserProfile } from '@/lib/redisSettingsCache';

/**
 * GET /api/positions
 * 
 * Returns all internal platform positions for the authenticated user.
 * product_type is pulled from the matching entry order (first EXECUTED order for that symbol+side).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const isClosedQuery = statusParam?.toLowerCase() === 'closed';
    const isFresh = searchParams.get('fresh') === 'true';
    const isAll = searchParams.get('all') === 'true';
    const fromDateParam = searchParams.get('from') || '';
    const cacheKeySuffix = `${statusParam || 'open'}:${isAll ? 'all' : 'default'}:${fromDateParam}`;
    const cacheKey = `api:positions:${user.id}:${cacheKeySuffix}`;

    // Fast Redis cache check (instant <5ms response unless fresh=true is requested)
    if (!isFresh) {
      try {
        const redis = getRedisClient();
        const cached = await redis.get(cacheKey);
        if (cached) {
          return NextResponse.json(JSON.parse(cached));
        }
        if (isClosedQuery) {
          const fallback = await redis.get(`api:positions:${user.id}:closed_all`);
          if (fallback) {
            return NextResponse.json(JSON.parse(fallback));
          }
        }
      } catch (_) {}
    }

    const admin = getAdminClient();

    // Fetch cached profile for history_reset_at (0 DB round trips on warm cache)
    const userProfile = await getCachedUserProfile(user.id, () => admin);
    const historyResetAt = userProfile?.history_reset_at;

    let positionsQuery = admin
      .from('positions')
      .select('*')
      .eq('user_id', user.id);

    if (statusParam) {
      if (statusParam === 'open') {
        // 'open' shorthand — include both 'open' and 'active' statuses (case-insensitive)
        positionsQuery = positionsQuery
          .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
          .order('created_at', { ascending: false });
      } else {
        // Case-insensitive matching for other status values (like 'closed')
        const lowerStatus = statusParam.toLowerCase();
        const upperStatus = statusParam.toUpperCase();
        positionsQuery = positionsQuery
          .in('status', [lowerStatus, upperStatus])
          .order('updated_at', { ascending: false });

        if (lowerStatus === 'closed' && historyResetAt) {
          const resetIso = new Date(historyResetAt).toISOString();
          positionsQuery = positionsQuery.or(`updated_at.gt.${resetIso},exit_time.gt.${resetIso},created_at.gt.${resetIso}`);
        } else if (lowerStatus === 'closed' && searchParams.get('from')) {
          const fromIso = `${searchParams.get('from')}T00:00:00+05:30`;
          positionsQuery = positionsQuery.or(`updated_at.gte.${fromIso},exit_time.gte.${fromIso},created_at.gte.${fromIso}`);
        }

        // Cap at 500 to prevent full-table scans on large accounts
        positionsQuery = positionsQuery.limit(500);
      }
    } else {
      // Default: only return open/active — closed positions are fetched explicitly (case-insensitive)
      positionsQuery = positionsQuery.in('status', ['open', 'OPEN', 'active', 'ACTIVE']).order('created_at', { ascending: false });
    }

    // Fetch positions with a 6s timeout wrapper
    const timeoutPromise = new Promise<any>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 6000)
    );

    const posResult = await Promise.race([positionsQuery, timeoutPromise]).catch(err => {
      console.warn('[Positions API] Query error:', err);
      return { timeout: true };
    });

    if (posResult?.timeout || posResult?.error) {
      console.warn('[Positions API] Query timed out (6s) or failed, returning fallback');
      // Attempt to return stale Redis cache if available before failing
      try {
        const redis = getRedisClient();
        const cached = await redis.get(cacheKey);
        if (cached) {
          return NextResponse.json(JSON.parse(cached));
        }
      } catch (_) {}
      return NextResponse.json({ positions: [] }, { status: 200 });
    }

    const rawRows = posResult.data ?? [];

    // For open positions only, resolve synthetic futures and compute locked_margin
    // Closed positions return immediately for maximum speed (<20ms)
    let positions: any[] = [];
    if (statusParam?.toLowerCase() === 'closed') {
      positions = rawRows.map((p: any) => ({
        ...p,
        status: 'closed',
        product_type: p.product_type || 'INTRADAY',
        kite_instrument: p.kite_instrument || p.symbol,
        brokerage: Number(p.brokerage || p.entry_brokerage || 0),
        locked_margin: 0,
      }));
    } else {
      positions = rawRows.map((p: any) => ({
        ...p,
        status: p.status ? p.status.toLowerCase() : 'open',
        product_type: p.product_type || 'INTRADAY',
        kite_instrument: p.kite_instrument || p.symbol,
        brokerage: Number(p.brokerage || p.entry_brokerage || 0),
      }));
    }

    const responsePayload = { positions };
    try {
      const redis = getRedisClient();
      const ttl = isClosedQuery ? 5 : 15;
      if (positions.length > 0) {
        await redis.setex(cacheKey, ttl, JSON.stringify(responsePayload));
        if (isClosedQuery) {
          await redis.setex(`api:positions:${user.id}:closed_all`, ttl, JSON.stringify(responsePayload));
        }
      }
    } catch (_) {}

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('[Positions API] Error:', error.message);
    return NextResponse.json({ positions: [] }, { status: 200 });
  }
}
