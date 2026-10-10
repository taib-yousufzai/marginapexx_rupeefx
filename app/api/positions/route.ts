export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getRedisClient } from '@/lib/redis';
import { getCachedUserProfile } from '@/lib/redisSettingsCache';
import { isRailwayDbConfigured, getRailwayUserPositions } from '@/lib/railway-db';


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

    // Redis micro-caching (3s TTL): serves rapid repeated client polls without DB round-trips
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

    let rawRows: any[] = [];
    let queryResolved = false;

    // 1. RAILWAY POSTGRES FIRST (< 1ms In-Cluster DB)
    if (isRailwayDbConfigured()) {
      try {
        const railwayPositions = await getRailwayUserPositions(user.id, {
          status: statusParam,
          historyResetAt,
          fromDate: searchParams.get('from'),
          limit: 500,
        });
        if (railwayPositions !== null) {
          rawRows = railwayPositions;
          queryResolved = true;
        }
      } catch (railwayErr) {
        console.warn('[Positions API] Railway DB query failed, falling back to Supabase:', railwayErr);
      }
    }

    // 2. SUPABASE FALLBACK (Only if Railway is unconfigured or failed)
    if (!queryResolved) {
      let positionsQuery = admin
        .from('positions')
        .select('*')
        .eq('user_id', user.id);

      if (statusParam) {
        if (statusParam === 'open') {
          positionsQuery = positionsQuery
            .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
            .gt('qty_open', 0)
            .order('created_at', { ascending: false });
        } else {
          const lowerStatus = statusParam.toLowerCase();
          const upperStatus = statusParam.toUpperCase();
          positionsQuery = positionsQuery
            .in('status', [lowerStatus, upperStatus])
            .order('updated_at', { ascending: false })
            .limit(500);
        }
      } else {
        positionsQuery = positionsQuery
          .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
          .gt('qty_open', 0)
          .order('created_at', { ascending: false });
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
        if (isClosedQuery) {
          try {
            const redis = getRedisClient();
            const cached = await redis.get(cacheKey);
            if (cached) {
              return NextResponse.json(JSON.parse(cached));
            }
          } catch (_) {}
        }
        return NextResponse.json({ positions: [] }, { status: 200 });
      }

      rawRows = posResult.data ?? [];
    }

    // Filter closed positions in-memory for historyResetAt and date filters (prevents PostgREST OR syntax errors)
    if (statusParam?.toLowerCase() === 'closed') {
      if (historyResetAt) {
        const resetTs = new Date(historyResetAt).getTime();
        rawRows = rawRows.filter((p: any) => {
          const updatedTs = p.updated_at ? new Date(p.updated_at).getTime() : 0;
          const exitTs = p.exit_time ? new Date(p.exit_time).getTime() : 0;
          const createdTs = p.created_at ? new Date(p.created_at).getTime() : 0;
          return updatedTs > resetTs || exitTs > resetTs || createdTs > resetTs;
        });
      }
      if (searchParams.get('from')) {
        const fromTs = new Date(`${searchParams.get('from')}T00:00:00+05:30`).getTime();
        rawRows = rawRows.filter((p: any) => {
          const updatedTs = p.updated_at ? new Date(p.updated_at).getTime() : 0;
          const exitTs = p.exit_time ? new Date(p.exit_time).getTime() : 0;
          const createdTs = p.created_at ? new Date(p.created_at).getTime() : 0;
          return updatedTs >= fromTs || exitTs >= fromTs || createdTs >= fromTs;
        });
      }
    }

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
      // Sort newest exit first
      positions.sort((a, b) => {
        const aTs = new Date(a.exit_time || a.updated_at || a.created_at || 0).getTime();
        const bTs = new Date(b.exit_time || b.updated_at || b.created_at || 0).getTime();
        return bTs - aTs;
      });
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
      // Open positions: 3s TTL — ensures exit actions reflect within seconds on refresh
      // Closed positions: 3s TTL
      const ttl = 3;
      // Always write cache (even empty list) so stale open-position cache is immediately overwritten
      await redis.setex(cacheKey, ttl, JSON.stringify(responsePayload));
      if (isClosedQuery) {
        await redis.setex(`api:positions:${user.id}:closed_all`, ttl, JSON.stringify(responsePayload));
      }
    } catch (_) {}

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('[Positions API] Error:', error.message);
    return NextResponse.json({ positions: [] }, { status: 200 });
  }
}
