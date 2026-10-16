import { NextRequest, NextResponse } from 'next/server';
import { isForexSymbol, isUsSymbol } from '@/lib/datafeed/symbolResolver';
import { fetchMT5HistoricalBars, isMT5Configured } from '@/lib/datafeed/MT5StockService';
import { getUSStockBasePrice } from '@/lib/datafeed/USStockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/market/candles
 *
 * Unified chart-candle endpoint. Tries Railway Postgres first for every instrument type,
 * then falls back to the appropriate live source (Kite / Binance / MT5 / NASDAQ).
 *
 * Query params:
 *   symbol   (required) — canonical ticker, e.g. "NSE:NIFTY 50", "COMEX:XAUUSD", "GBPUSD"
 *   interval (required) — TradingView UDF resolution: "1","3","5","10","15","30","60","D"
 *   from     (required) — epoch ms
 *   to       (required) — epoch ms
 *   segment  (optional) — hint: "EQUITY"|"FOREX"|"COMEX"|"CRYPTO"|"CDS"|"MCX" etc.
 *   limit    (optional) — max bars (default 1000)
 *
 * Response: { candles: [[isoTimestamp, open, high, low, close, volume], ...] }
 */

// ─── Interval normalisation ───────────────────────────────────────────────────

/** TradingView UDF resolution → Railway/Supabase interval key */
function udfToStorageInterval(r: string): string {
  switch (r.trim()) {
    case '1':  case '1m':  return '1m';
    case '2':  case '2m':  return '2m';
    case '3':  case '3m':  return '3m';
    case '5':  case '5m':  return '5m';
    case '10': case '10m': return '10m';
    case '15': case '15m': return '15m';
    case '30': case '30m': return '30m';
    case '60': case '60m': case '1h': return '60m';
    case 'D':  case '1d':  case 'day': return '1d';
    default:   return '5m';
  }
}

/** TradingView UDF resolution → Kite API interval string */
function udfToKiteInterval(r: string): string {
  switch (r.trim()) {
    case '1':  case '1m':  return 'minute';
    case '3':  case '3m':  return '3minute';
    case '5':  case '5m':  return '5minute';
    case '10': case '10m': return '10minute';
    case '15': case '15m': return '15minute';
    case '30': case '30m': return '30minute';
    case '60': case '60m': case '1h': return '60minute';
    case 'D':  case '1d':  case 'day': return 'day';
    default:   return '5minute';
  }
}

/** TradingView UDF resolution → Binance klines interval */
function udfToBinanceInterval(r: string): string {
  switch (r.trim()) {
    case '1':  case '1m':  return '1m';
    case '3':  case '3m':  return '3m';
    case '5':  case '5m':  return '5m';
    case '10': case '10m': return '5m';   // no 10m on Binance
    case '15': case '15m': return '15m';
    case '30': case '30m': return '30m';
    case '60': case '60m': case '1h': return '1h';
    case 'D':  case '1d':  case 'day': return '1d';
    default:   return '5m';
  }
}

// ─── Instrument type detection ────────────────────────────────────────────────

function detectType(symbol: string, segment: string): 'CRYPTO' | 'FOREX' | 'US_COMEX' | 'INDIAN' {
  const up = symbol.toUpperCase();
  const seg = segment.toUpperCase();

  // Crypto
  if (up.endsWith('USDT') || seg.includes('CRYPTO')) return 'CRYPTO';

  // COMEX / US
  if (
    isUsSymbol(symbol, segment) ||
    up.startsWith('COMEX:') ||
    up.startsWith('US:') ||
    seg.includes('COMEX') ||
    seg.includes('US-EQ') ||
    seg.includes('US FUTURES') ||
    seg.includes('US EQUITIES')
  ) return 'US_COMEX';

  // Global Forex (not INR pairs — those are Indian CDS futures)
  if (
    isForexSymbol(symbol) ||
    (seg.includes('FOREX') && !up.includes('INR') && !up.endsWith('FUT') && !up.startsWith('CDS:'))
  ) return 'FOREX';

  // Everything else: Indian equity, index, F&O, MCX, CDS currency futures
  return 'INDIAN';
}

// ─── Fallback candle generator (keeps charts from going blank) ────────────────

function generateFallback(symbol: string, interval: string, fromSec: number, toSec: number, anchor?: number): any[][] {
  const basePrice = (anchor && anchor > 0) ? anchor : getUSStockBasePrice(symbol);
  const normInt = interval.toLowerCase().trim();
  const stepSec =
    (normInt === '1' || normInt === '1m') ? 60 :
    (normInt === '3' || normInt === '3m') ? 180 :
    (normInt === '5' || normInt === '5m') ? 300 :
    (normInt === '10' || normInt === '10m') ? 600 :
    (normInt === '15' || normInt === '15m') ? 900 :
    (normInt === '30' || normInt === '30m') ? 1800 :
    (normInt === '60' || normInt === '60m' || normInt === '1h') ? 3600 :
    (normInt === 'd' || normInt === '1d' || normInt === 'D') ? 86400 : 300;

  const maxBars = 300;
  const decimals = basePrice < 10 ? 4 : 2;
  const maxDev = basePrice * 0.006;
  const raw: any[][] = [];
  let cur = basePrice;
  let t = toSec;

  while (raw.length < maxBars && t >= fromSec - maxBars * stepSec * 3) {
    const d = new Date(t * 1000);
    const day = d.getUTCDay();
    const hour = d.getUTCHours();
    const isWeekendClosed = day === 6 || (day === 0 && hour < 22);
    if (!isWeekendClosed || normInt === 'd' || normInt === '1d' || normInt === 'D') {
      const pull = (basePrice - cur) * 0.08;
      const noise = (Math.random() - 0.5) * basePrice * 0.0015;
      let open = Number((cur + pull + noise).toFixed(decimals));
      if (open > basePrice + maxDev) open = Number((basePrice + maxDev).toFixed(decimals));
      if (open < basePrice - maxDev) open = Number((basePrice - maxDev).toFixed(decimals));
      const maxOC = Math.max(open, cur);
      const minOC = Math.min(open, cur);
      const high = Number((maxOC + Math.random() * basePrice * 0.001).toFixed(decimals));
      const low = Number(Math.max(0.0001, minOC - Math.random() * basePrice * 0.001).toFixed(decimals));
      raw.push([d.toISOString(), open, high, low, Number(cur.toFixed(decimals)), Math.floor(1500 + Math.random() * 3500)]);
      cur = open;
    }
    t -= stepSec;
  }
  return raw.reverse();
}

// ─── Live-data sources ────────────────────────────────────────────────────────

const BINANCE_MAP: Record<string, string> = {
  'XAUUSD': 'PAXGUSDT', 'GOLD': 'PAXGUSDT', 'GC=F': 'PAXGUSDT', 'GC': 'PAXGUSDT',
  'EURUSD': 'EURUSDT',  'EURUSD=X': 'EURUSDT',
  'GBPUSD': 'GBPUSDT',  'GBPUSD=X': 'GBPUSDT',
  'AUDUSD': 'AUDUSDT',  'AUDUSD=X': 'AUDUSDT',
  'NZDUSD': 'NZDUSDT',  'NZDUSD=X': 'NZDUSDT',
  'BTCUSD': 'BTCUSDT',  'ETHUSD': 'ETHUSDT',
  'DOGEUSD': 'DOGEUSDT','SOLUSD': 'SOLUSDT', 'XRPUSD': 'XRPUSDT',
};

async function fetchBinance(symbol: string, udfInterval: string, fromSec: number, toSec: number): Promise<any[][]> {
  const clean = symbol.replace(/^(US:|FOREX:|COMEX:|CRYPTO:)/i, '').toUpperCase().trim();
  const bSymbol = BINANCE_MAP[clean] || (clean.endsWith('USDT') ? clean : null);
  if (!bSymbol) return [];

  const interval = udfToBinanceInterval(udfInterval);
  const endpoints = [
    'https://data-api.binance.vision',
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
  ];

  for (const base of endpoints) {
    const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(bSymbol)}&interval=${encodeURIComponent(interval)}&startTime=${fromSec * 1000}&endTime=${toSec * 1000}&limit=500`;
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3500) });
      if (!res.ok) continue;
      const klines: any[][] = await res.json();
      if (!Array.isArray(klines) || !klines.length) continue;
      return klines.map(k => [
        new Date(k[0]).toISOString(),
        parseFloat(k[1]),
        parseFloat(k[2]),
        parseFloat(k[3]),
        parseFloat(k[4]),
        parseFloat(k[5] ?? '0'),
      ]);
    } catch {
      continue;
    }
  }
  return [];
}

async function fetchNasdaq(symbol: string): Promise<any[][]> {
  try {
    const clean = symbol.replace(/^(US:|FOREX:)/i, '').toUpperCase().trim();
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(clean)}/chart?assetclass=stocks`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const chart: any[] = json?.data?.chart || [];
    if (!chart.length) return [];

    const points = chart
      .filter(i => i?.x && typeof i.y === 'number' && i.y > 0)
      .map(i => ({ time: new Date(i.x).toISOString(), price: Number(i.y.toFixed(2)) }));
    if (!points.length) return [];

    const sorted = [...points.map(p => p.price)].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const clean2 = points.filter(p => Math.abs(p.price - median) / median < 0.03);

    const bars: any[][] = [];
    let prev = clean2[0].price;
    for (const p of clean2) {
      const maxOC = Math.max(prev, p.price);
      const minOC = Math.min(prev, p.price);
      const wick = Number((median * 0.0005).toFixed(2));
      bars.push([p.time, prev, maxOC + wick, Math.max(0.01, minOC - wick), p.price, 1500]);
      prev = p.price;
    }
    return bars;
  } catch { return []; }
}

/** Kite IST-format date string (Kite requires IST, not UTC) */
function toKiteIST(ms: number): string {
  const d = new Date(ms + 19800 * 1000); // +5:30
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

async function fetchKite(symbol: string, udfInterval: string, fromMs: number, toMs: number): Promise<any[][]> {
  try {
    const { getSharedKiteSession } = await import('@/lib/kiteSession');
    const { createClient } = await import('@supabase/supabase-js');

    const session = await getSharedKiteSession();
    if (!session) return [];

    // Resolve instrument token from Supabase
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Try to resolve token: prefixed id first, then tradingsymbol
    let token: number | null = null;
    const tryId = async (id: string) => {
      const { data } = await supabase.from('instruments').select('instrument_token').eq('id', id).single();
      return data?.instrument_token ?? null;
    };

    if (symbol.includes(':')) {
      token = await tryId(symbol);
    }
    if (!token) {
      const clean = symbol.includes(':') ? symbol.split(':')[1] : symbol;
      const { data } = await supabase
        .from('instruments')
        .select('instrument_token')
        .eq('tradingsymbol', clean)
        .limit(1);
      token = data?.[0]?.instrument_token ?? null;
    }
    if (!token) return [];

    const kiteInterval = udfToKiteInterval(udfInterval);
    const kiteFrom = toKiteIST(fromMs);
    const kiteTo = toKiteIST(toMs);
    const url = `https://api.kite.trade/instruments/historical/${token}/${kiteInterval}?from=${encodeURIComponent(kiteFrom)}&to=${encodeURIComponent(kiteTo)}`;
    const resp = await fetch(url, {
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${process.env.KITE_API_KEY || process.env.NEXT_PUBLIC_KITE_API_KEY}:${session.accessToken}`,
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    if (json.status !== 'success' || !Array.isArray(json.data?.candles)) return [];
    // Kite returns [timestamp, open, high, low, close, volume, oi]
    return json.data.candles.map((c: any[]) => [c[0], c[1], c[2], c[3], c[4], c[5] ?? 0]);
  } catch { return []; }
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

  // Parse from/to — accept either epoch-ms (large number) or ISO string
  const parseTime = (raw: string | null, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number(raw);
    if (!isNaN(n) && n > 0) return n > 1e11 ? n : n * 1000; // already ms or seconds
    const d = new Date(raw).getTime();
    return isNaN(d) ? fallback : d;
  };
  const toMs   = parseTime(searchParams.get('to'),   Date.now());
  const fromMs = parseTime(searchParams.get('from'), toMs - 14 * 86400 * 1000);
  const fromISO = new Date(fromMs).toISOString();
  const toISO   = new Date(toMs).toISOString();

  const storageInterval = udfToStorageInterval(interval);
  const type = detectType(symbol, segment);

  // Build a list of symbol variants to query Railway with
  // (the stored symbol might be "COMEX:XAUUSD", "XAUUSD", "NSE:NIFTY 50", etc.)
  const symbolVariants = Array.from(new Set([
    symbol,
    symbol.toUpperCase(),
    symbol.includes(':') ? symbol.split(':')[1] : null,
    symbol.includes(':') ? symbol.split(':')[1].toUpperCase() : null,
  ].filter(Boolean))) as string[];

  // ── 1. Railway Postgres (primary source for ALL instrument types) ────────────
  let candles: any[][] = [];
  try {
    const { isRailwayDbConfigured, getCandlesFromRailway } = await import('@/lib/railway-db');
    if (isRailwayDbConfigured()) {
      const rows = await getCandlesFromRailway(symbolVariants, storageInterval, fromISO, toISO, limit);
      if (rows && rows.length > 0) {
        candles = rows.map(r => [r.timestamp, r.open, r.high, r.low, r.close, r.volume]);
        console.log(`[/api/market/candles] Railway HIT: ${symbol} ${storageInterval} → ${candles.length} bars`);
        return NextResponse.json({ candles }, {
          headers: { 'Cache-Control': 'no-store', 'X-Candle-Source': 'railway' },
        });
      }
      console.log(`[/api/market/candles] Railway MISS: ${symbol} ${storageInterval} (no rows)`);
    } else {
      console.log(`[/api/market/candles] Railway not configured, skipping`);
    }
  } catch (err: any) {
    console.warn(`[/api/market/candles] Railway error for ${symbol}:`, err?.message);
  }

  // ── 2. Live fallback — pick source based on instrument type ──────────────────
  console.log(`[/api/market/candles] Falling back to live source (type=${type}) for ${symbol}`);

  if (type === 'CRYPTO' || type === 'FOREX' || type === 'US_COMEX') {
    // Try Binance first (gold, EUR/USD, GBP/USD, AUD/USD, NZD/USD, crypto pairs)
    candles = await fetchBinance(symbol, interval, Math.floor(fromMs / 1000), Math.floor(toMs / 1000));

    // MT5 next (broker feed for forex and COMEX)
    if (!candles.length && isMT5Configured()) {
      try {
        candles = await fetchMT5HistoricalBars(symbol, interval, Math.floor(fromMs / 1000), Math.floor(toMs / 1000));
      } catch { /* continue */ }
    }

    // NASDAQ for US stocks
    if (!candles.length && type === 'US_COMEX') {
      const nasdaqBars = await fetchNasdaq(symbol);
      if (nasdaqBars.length) {
        const filtered = nasdaqBars.filter(b => {
          const sec = Math.floor(new Date(b[0]).getTime() / 1000);
          return sec >= fromMs / 1000 && sec <= toMs / 1000;
        });
        candles = filtered.length ? filtered : nasdaqBars;
      }
    }

    // Fallback synthetic candles
    if (!candles.length) {
      candles = generateFallback(symbol, interval, Math.floor(fromMs / 1000), Math.floor(toMs / 1000));
    }
  } else {
    // INDIAN: Kite API
    candles = await fetchKite(symbol, interval, fromMs, toMs);

    // Supabase historical_candles as secondary fallback
    if (!candles.length) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
        const { data } = await supabase
          .from('historical_candles')
          .select('timestamp, open, high, low, close, volume')
          .in('symbol', symbolVariants)
          .eq('interval', storageInterval)
          .gte('timestamp', fromISO)
          .lte('timestamp', toISO)
          .order('timestamp', { ascending: true })
          .limit(limit);
        if (data?.length) {
          candles = data.map(r => [r.timestamp, r.open, r.high, r.low, r.close, r.volume]);
        }
      } catch { /* continue */ }
    }

    // Final fallback — don't generate placeholders for very old ranges
    if (!candles.length) {
      if (toMs < Date.now() - 30 * 86400 * 1000) {
        return NextResponse.json({ candles: [] }, {
          headers: { 'Cache-Control': 'no-store', 'X-Candle-Source': 'none' },
        });
      }
      candles = generateFallback(symbol, interval, Math.floor(fromMs / 1000), Math.floor(toMs / 1000));
    }
  }

  return NextResponse.json({ candles }, {
    headers: { 'Cache-Control': 'no-store', 'X-Candle-Source': 'live-fallback' },
  });
}
