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

    // Fast Redis cache check
    if (!isFresh) {
      try {
        const redis = getRedisClient();
        const cached = await redis.get(cacheKey);
        if (cached) {
          return NextResponse.json(JSON.parse(cached));
        }
      } catch (_) {}
    }

    const admin = getAdminClient();

    // Fetch cached profile for history_reset_at (0 DB round trips on warm cache)
    const userProfile = await getCachedUserProfile(user.id, () => admin);
    const historyResetAt = userProfile?.history_reset_at;

    let positionsQuery = admin.from('positions').select('*').eq('user_id', user.id);
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
          positionsQuery = positionsQuery.gt('updated_at', new Date(historyResetAt).toISOString());
        }

        // For closed positions, default to today-only unless 'all' param or 'from' date is passed
        if (lowerStatus === 'closed' && !searchParams.get('all') && !searchParams.get('from')) {
          const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
          const istDateStr = formatter.format(new Date());
          const utcMidnight = new Date(`${istDateStr}T00:00:00+05:30`);
          positionsQuery = positionsQuery.gte('updated_at', utcMidnight.toISOString());
        } else if (lowerStatus === 'closed' && searchParams.get('from')) {
          positionsQuery = positionsQuery.gte('updated_at', `${searchParams.get('from')}T00:00:00+05:30`);
        }
        // Cap at 500 to prevent full-table scans on large accounts
        positionsQuery = positionsQuery.limit(500);
      }
    } else {
      // Default: only return open/active — closed positions are fetched explicitly (case-insensitive)
      positionsQuery = positionsQuery.in('status', ['open', 'OPEN', 'active', 'ACTIVE']).order('created_at', { ascending: false });
    }

    // Fetch positions with an 8s timeout wrapper
    const timeoutPromise = new Promise<any>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 8000)
    );

    const posResult = await Promise.race([positionsQuery, timeoutPromise]).catch(err => {
      console.warn('[Positions API] Query error:', err);
      return { timeout: true };
    });

    if (posResult?.timeout || posResult?.error) {
      console.warn('[Positions API] Query timed out (8s) or failed');
      // Attempt to return stale Redis cache if available before failing
      try {
        const redis = getRedisClient();
        const cached = await redis.get(cacheKey);
        if (cached) {
          return NextResponse.json(JSON.parse(cached));
        }
      } catch (_) {}
      return NextResponse.json({ error: 'Positions query timed out' }, { status: 504 });
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
        brokerage: Number(p.brokerage || 0),
        locked_margin: 0,
      }));
    } else {
      positions = rawRows.map((p: any) => ({
        ...p,
        status: p.status ? p.status.toLowerCase() : 'open',
        product_type: p.product_type || 'INTRADAY',
        kite_instrument: p.kite_instrument || p.symbol,
        brokerage: Number(p.brokerage || 0),
      }));
    }

    const responsePayload = { positions };
    try {
      const redis = getRedisClient();
      const ttl = isClosedQuery ? 3600 : 3;
      await redis.setex(cacheKey, ttl, JSON.stringify(responsePayload));
    } catch (_) {}

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('[Positions API] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
