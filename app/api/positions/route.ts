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

    // Fast Redis cache check (3s TTL for active position polls)
    const cacheKey = `api:positions:${user.id}:${statusParam || 'open'}:${searchParams.get('all') || ''}:${searchParams.get('from') || ''}`;
    try {
      const redis = getRedisClient();
      const cached = await redis.get(cacheKey);
      if (cached) {
        return NextResponse.json(JSON.parse(cached));
      }
    } catch (_) {}

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
      return NextResponse.json({ error: 'Positions query timed out' }, { status: 504 });
    }

    // For closed positions, locked_margin is 0 after close. Recover the original margin
    // from the MARGIN_CREDIT ledger entry written by close_position_v2 (ref_id = 'MRG_RET_<position_id>').
    let marginByPositionId: Record<string, number> = {};
    if (statusParam?.toLowerCase() === 'closed' && (posResult.data?.length ?? 0) > 0) {
      const positionIds = (posResult.data ?? []).map((p: any) => `MRG_RET_${p.id}`);
      const { data: marginRows } = await admin
        .from('transactions')
        .select('ref_id, amount')
        .eq('user_id', user.id)
        .eq('type', 'MARGIN_CREDIT')
        .in('ref_id', positionIds);
      for (const row of marginRows ?? []) {
        const posId = (row.ref_id as string).replace('MRG_RET_', '');
        marginByPositionId[posId] = Number(row.amount);
      }
    }

    // Resolve synthetic futures symbols to their nearest active contract trading symbols (e.g. CRUDEOIL_FUT -> MCX:CRUDEOIL26JULFUT)
    const positions = await Promise.all((posResult.data ?? []).map(async (p) => {
      let resolvedKite = p.symbol;
      if (p.symbol && p.symbol.endsWith('_FUT')) {
        const segUpper = (p.settlement || '').toUpperCase();
        const prefix = segUpper.includes('MCX') ? 'MCX' : (segUpper.includes('CDS') || segUpper.includes('FOREX') ? 'CDS' : 'NSE');
        let baseName = p.symbol.toUpperCase();
        if (baseName.endsWith('_FUT')) baseName = baseName.slice(0, -4);

        const cacheKey = `nearest_fut_${prefix}_${baseName}`;
        try {
          const { getRedisClient } = require('@/lib/redis');
          const redis = getRedisClient();
          let cachedSymbol = await redis.get(cacheKey);
          if (!cachedSymbol) {
            const { data: nearestFut } = await admin
              .from('instruments')
              .select('tradingsymbol')
              .eq('name', baseName)
              .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
              .gte('expiry', new Date().toISOString().split('T')[0])
              .order('expiry', { ascending: true })
              .limit(1)
              .maybeSingle();

            if (nearestFut?.tradingsymbol) {
              cachedSymbol = nearestFut.tradingsymbol;
              await redis.setex(cacheKey, 3600, cachedSymbol);
            }
          }
          if (cachedSymbol) {
            resolvedKite = `${prefix}:${cachedSymbol}`;
          }
        } catch (e) {
          console.error('[Positions API] Failed to resolve future symbol:', e);
        }
      }

      return {
        ...p,
        status: p.status ? p.status.toLowerCase() : 'open',
        product_type: p.product_type || 'INTRADAY',
        kite_instrument: resolvedKite,
        brokerage: p.brokerage || 0,
        // For closed positions, restore the original locked_margin from the ledger
        // (close_position_v2 zeros it out; we recover it via the MARGIN_CREDIT transaction)
        locked_margin: marginByPositionId[p.id] ?? p.locked_margin ?? 0,
      };
    }));

    const responsePayload = { positions };
    try {
      const redis = getRedisClient();
      await redis.setex(cacheKey, 3, JSON.stringify(responsePayload));
    } catch (_) {}

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('[Positions API] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
