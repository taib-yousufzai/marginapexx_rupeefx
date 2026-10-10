import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/market/candles
 *
 * Query historical OHLCV candles from the historical_candles table.
 *
 * Query params:
 *   symbol   (required) — e.g. "NIFTY 50", "BTCUSDT"
 *   interval (optional) — "1m" | "5m" | "15m" | "1h"  (default: "5m")
 *   from     (optional) — ISO timestamp, inclusive lower bound (default: 24h ago)
 *   to       (optional) — ISO timestamp, inclusive upper bound (default: now)
 *   limit    (optional) — max rows (default: 200, max: 1000)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const symbol   = searchParams.get('symbol');
  const interval = searchParams.get('interval') || '5m';
  const limit    = Math.min(parseInt(searchParams.get('limit') || '200', 10), 1000);
  const from     = searchParams.get('from') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to       = searchParams.get('to')   || new Date().toISOString();

  if (!symbol) {
    return NextResponse.json(
      { success: false, error: 'Missing required query param: symbol' },
      { status: 400 }
    );
  }

  const validIntervals = ['1m', '5m', '15m', '1h'];
  if (!validIntervals.includes(interval)) {
    return NextResponse.json(
      { success: false, error: `Invalid interval. Must be one of: ${validIntervals.join(', ')}` },
      { status: 400 }
    );
  }

  // 1. Try Railway Postgres first
  try {
    const { isRailwayDbConfigured, getCandlesFromRailway } = await import('@/lib/railway-db');
    if (isRailwayDbConfigured()) {
      const railwayCandles = await getCandlesFromRailway(symbol, interval, from, to, limit);
      if (railwayCandles && railwayCandles.length > 0) {
        return NextResponse.json({
          success: true,
          symbol,
          interval,
          count: railwayCandles.length,
          from,
          to,
          candles: railwayCandles,
          storage: 'railway',
        });
      }
    }
  } catch (railwayErr: any) {
    console.warn('[/api/market/candles] Railway lookup failed, falling back to Supabase:', railwayErr?.message);
  }

  // 2. Fallback to Supabase
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) {
    return NextResponse.json(
      { success: false, error: 'Server configuration error' },
      { status: 500 }
    );
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin
    .from('historical_candles')
    .select('symbol, timestamp, interval, open, high, low, close, volume')
    .eq('symbol', symbol)
    .eq('interval', interval)
    .gte('timestamp', from)
    .lte('timestamp', to)
    .order('timestamp', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[/api/market/candles] Supabase error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    symbol,
    interval,
    count: data?.length ?? 0,
    from,
    to,
    candles: data ?? [],
  });
}
