import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/market/candles
 *
 * Railway-only chart candle endpoint. Queries historical_candles from Railway
 * Postgres for every instrument type — equity, index, F&O, MCX, CDS, forex,
 * COMEX, crypto, US stocks. No external API fallbacks.
 *
 * Query params:
 *   symbol   (required) — canonical ticker, e.g. "NSE:NIFTY 50", "COMEX:XAUUSD", "GBPUSD"
 *   interval (required) — TradingView UDF resolution: "1","5","15","60","D"
 *   from     (required) — epoch ms
 *   to       (required) — epoch ms
 *   segment  (optional) — segment hint (unused for routing, passed for logging)
 *   limit    (optional) — max bars returned (default 1000, max 1500)
 *
 * Response: { candles: [[isoTimestamp, open, high, low, close, volume], ...], source: "railway" }
 */

// ─── Interval mapping ─────────────────────────────────────────────────────────
// Railway historical_candles only stores: 1m, 5m, 15m, 1h
// Unmapped resolutions snap to the nearest stored interval.
const INTERVAL_MAP: Record<string, string> = {
  '1':   '1m',  '1m':  '1m',
  '2':   '1m',  '2m':  '1m',   // snap down → 1m
  '3':   '5m',  '3m':  '5m',   // snap up → 5m
  '5':   '5m',  '5m':  '5m',
  '10':  '15m', '10m': '15m',  // snap up → 15m
  '15':  '15m', '15m': '15m',
  '30':  '1h',  '30m': '1h',   // snap up → 1h
  '60':  '1h',  '60m': '1h',  '1h': '1h',
  'D':   '1h',  '1d':  '1h',  'day': '1h', // daily snaps to 1h (best available)
};

function toStorageInterval(udf: string): string {
  return INTERVAL_MAP[udf.trim()] ?? '5m';
}

// ─── Time parser ──────────────────────────────────────────────────────────────
function parseMs(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!isNaN(n) && n > 0) return n > 1e11 ? n : n * 1000;
  const d = new Date(raw).getTime();
  return isNaN(d) ? fallback : d;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);

  const symbol   = searchParams.get('symbol');
  const interval = searchParams.get('interval') || '5';
  const segment  = searchParams.get('segment') || '';
  const limit    = Math.min(parseInt(searchParams.get('limit') || '1000', 10), 1500);

  if (!symbol) {
    return NextResponse.json({ error: 'Missing required param: symbol' }, { status: 400 });
  }

  const toMs    = parseMs(searchParams.get('to'),   Date.now());
  const fromMs  = parseMs(searchParams.get('from'), toMs - 14 * 86400 * 1000);
  const fromISO = new Date(fromMs).toISOString();
  const toISO   = new Date(toMs).toISOString();
  const storedInterval = toStorageInterval(interval);

  // Build symbol variants — Railway may store the symbol with or without the exchange prefix
  const symbolVariants = Array.from(new Set([
    symbol,
    symbol.toUpperCase(),
    symbol.includes(':') ? symbol.split(':')[1] : null,
    symbol.includes(':') ? symbol.split(':')[1].toUpperCase() : null,
  ].filter(Boolean))) as string[];

  console.log(
    `[/api/market/candles] ${symbol} interval=${interval}→${storedInterval}` +
    ` from=${fromISO} to=${toISO} limit=${limit} segment=${segment}`
  );

  try {
    const { getCandlesFromRailway, isRailwayDbConfigured } = await import('@/lib/railway-db');

    if (!isRailwayDbConfigured()) {
      console.error('[/api/market/candles] Railway DB not configured — DATABASE_PUBLIC_URL missing?');
      return NextResponse.json(
        { error: 'Railway DB not configured', candles: [] },
        { status: 503 }
      );
    }

    const rows = await getCandlesFromRailway(symbolVariants, storedInterval, fromISO, toISO, limit);

    if (!rows || rows.length === 0) {
      console.warn(
        `[/api/market/candles] No data: symbol=${symbol} variants=[${symbolVariants.join(',')}]` +
        ` interval=${storedInterval} from=${fromISO} to=${toISO}`
      );
      return NextResponse.json({ candles: [], source: 'railway', count: 0 }, {
        headers: { 'Cache-Control': 'no-store', 'X-Candle-Source': 'railway-empty' },
      });
    }

    const candles = rows.map(r => [r.timestamp, r.open, r.high, r.low, r.close, r.volume]);

    console.log(`[/api/market/candles] OK: ${symbol} ${storedInterval} → ${candles.length} bars`);

    return NextResponse.json({ candles, source: 'railway', count: candles.length }, {
      headers: { 'Cache-Control': 'no-store', 'X-Candle-Source': 'railway' },
    });

  } catch (err: any) {
    console.error(`[/api/market/candles] Railway error for ${symbol}:`, err?.message);
    return NextResponse.json(
      { error: 'Railway query failed', message: err?.message, candles: [] },
      { status: 500 }
    );
  }
}
