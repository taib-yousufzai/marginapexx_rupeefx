import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { getRedisClient, isRedisMock } from '@/lib/redis';
import { isContractExpired } from '@/lib/contractExpiry';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Resolve a symbol to an instrument_token.
 * Runs strategies in parallel for speed.
 */
interface ResolvedInstrument {
  token: number;
  /** The canonical DB id (e.g. "NSE:NIFTY 50"). Equals the input symbol when we can't determine it. */
  canonicalId: string;
}

/**
 * Process-lifetime in-memory cache for resolved instruments.
 * Survives across requests in the same Node.js worker.
 * Crucial when Redis is mocked (dev) or DB indexes are absent:
 * the TV widget calls getBars 5–15 times per chart open, each needing resolution.
 * After the first hit this map returns in < 1ms.
 */
const memCache = new Map<string, ResolvedInstrument>();

/**
 * Process-lifetime in-memory cache for historical candle responses.
 * Survives across requests in the same Node.js worker.
 * Eliminates redundant Kite API / DB network calls on chart load or timeframe switches.
 */
interface CachedCandles {
  data: any;
  expiry: number;
}
const candleMemCache = new Map<string, CachedCandles>();

/**
 * Statically known instrument tokens for the most-frequently viewed symbols.
 * These never change and eliminate any DB/Redis round-trip for common assets,
 * making resolution instant (<1ms) even on cold starts.
 */
const STATIC_TOKENS: Record<string, ResolvedInstrument> = {
  'NIFTY':              { token: 256265,  canonicalId: 'NSE:NIFTY 50' },
  'NIFTY 50':           { token: 256265,  canonicalId: 'NSE:NIFTY 50' },
  'NSE:NIFTY 50':       { token: 256265,  canonicalId: 'NSE:NIFTY 50' },
  'BANKNIFTY':          { token: 260105,  canonicalId: 'NSE:NIFTY BANK' },
  'NIFTY BANK':         { token: 260105,  canonicalId: 'NSE:NIFTY BANK' },
  'NSE:NIFTY BANK':     { token: 260105,  canonicalId: 'NSE:NIFTY BANK' },
  'FINNIFTY':           { token: 257801,  canonicalId: 'NSE:NIFTY FIN SERVICE' },
  'NSE:NIFTY FIN SERVICE': { token: 257801, canonicalId: 'NSE:NIFTY FIN SERVICE' },
  'MIDCPNIFTY':         { token: 288009,  canonicalId: 'NSE:NIFTY MID SELECT' },
  'NSE:NIFTY MID SELECT': { token: 288009, canonicalId: 'NSE:NIFTY MID SELECT' },
  'SENSEX':             { token: 265,     canonicalId: 'BSE:SENSEX' },
  'BSE:SENSEX':         { token: 265,     canonicalId: 'BSE:SENSEX' },
  'BANKEX':             { token: 274441,  canonicalId: 'BSE:BANKEX' },
  'BSE:BANKEX':         { token: 274441,  canonicalId: 'BSE:BANKEX' },
  'RELIANCE':           { token: 738561,  canonicalId: 'NSE:RELIANCE' },
  'NSE:RELIANCE':       { token: 738561,  canonicalId: 'NSE:RELIANCE' },
  'TCS':                { token: 2953217, canonicalId: 'NSE:TCS' },
  'NSE:TCS':            { token: 2953217, canonicalId: 'NSE:TCS' },
  'INFY':               { token: 408065,  canonicalId: 'NSE:INFY' },
  'NSE:INFY':           { token: 408065,  canonicalId: 'NSE:INFY' },
  'HDFCBANK':           { token: 341249,  canonicalId: 'NSE:HDFCBANK' },
  'NSE:HDFCBANK':       { token: 341249,  canonicalId: 'NSE:HDFCBANK' },
  'ICICIBANK':          { token: 1270529, canonicalId: 'NSE:ICICIBANK' },
  'NSE:ICICIBANK':      { token: 1270529, canonicalId: 'NSE:ICICIBANK' },
  'GOLD':               { token: 123668231, canonicalId: 'MCX:GOLD26OCTFUT' },
  'MCX:GOLD':           { token: 123668231, canonicalId: 'MCX:GOLD26OCTFUT' },
  'MCX:GOLD26OCTFUT':   { token: 123668231, canonicalId: 'MCX:GOLD26OCTFUT' },
  'SILVER':             { token: 126774791, canonicalId: 'MCX:SILVER26DECFUT' },
  'MCX:SILVER':         { token: 126774791, canonicalId: 'MCX:SILVER26DECFUT' },
  'MCX:SILVER26DECFUT': { token: 126774791, canonicalId: 'MCX:SILVER26DECFUT' },
  'SILVERM':            { token: 123668487, canonicalId: 'MCX:SILVERM26NOVFUT' },
  'MCX:SILVERM':        { token: 123668487, canonicalId: 'MCX:SILVERM26NOVFUT' },
  'MCX:SILVERM26NOVFUT':{ token: 123668487, canonicalId: 'MCX:SILVERM26NOVFUT' },
  'CRUDEOIL':           { token: 144870151, canonicalId: 'MCX:CRUDEOIL26SEPFUT' },
  'MCX:CRUDEOIL':       { token: 144870151, canonicalId: 'MCX:CRUDEOIL26SEPFUT' },
  'MCX:CRUDEOIL26SEPFUT':{ token: 144870151, canonicalId: 'MCX:CRUDEOIL26SEPFUT' },
  'NATURALGAS':         { token: 145470727, canonicalId: 'MCX:NATURALGAS26SEPFUT' },
  'MCX:NATURALGAS':     { token: 145470727, canonicalId: 'MCX:NATURALGAS26SEPFUT' },
  'MCX:NATURALGAS26SEPFUT': { token: 145470727, canonicalId: 'MCX:NATURALGAS26SEPFUT' },
  // Currency Futures (CDS) — eliminates any DB round-trip and instantly routes to active front-month
  'GBPINR':             { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'CDS:GBPINR':         { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'GBPINR_FUT':         { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'CDS:GBPINR_FUT':     { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'GBPINR26SEPFUT':     { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'CDS:GBPINR26SEPFUT': { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'GBPINR26AUGFUT':     { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'CDS:GBPINR26AUGFUT': { token: 451843,  canonicalId: 'CDS:GBPINR26SEPFUT' },
  'EURINR':             { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'CDS:EURINR':         { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'EURINR_FUT':         { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'CDS:EURINR_FUT':     { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'EURINR26SEPFUT':     { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'CDS:EURINR26SEPFUT': { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'EURINR26AUGFUT':     { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'CDS:EURINR26AUGFUT': { token: 451331,  canonicalId: 'CDS:EURINR26SEPFUT' },
  'JPYINR':             { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'CDS:JPYINR':         { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'JPYINR_FUT':         { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'CDS:JPYINR_FUT':     { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'JPYINR26SEPFUT':     { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'CDS:JPYINR26SEPFUT': { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'JPYINR26AUGFUT':     { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'CDS:JPYINR26AUGFUT': { token: 452611,  canonicalId: 'CDS:JPYINR26SEPFUT' },
  'USDINR':             { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
  'CDS:USDINR':         { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
  'USDINR_FUT':         { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
  'CDS:USDINR_FUT':     { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
  'USDINR26SEPFUT':     { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
  'CDS:USDINR26SEPFUT': { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
  'USDINR26AUGFUT':     { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
  'CDS:USDINR26AUGFUT': { token: 452867,  canonicalId: 'CDS:USDINR26SEPFUT' },
};

async function resolveInstrument(symbol: string): Promise<ResolvedInstrument | null> {
  const start = performance.now();
  // 0. Fastest path: compile-time static tokens (zero I/O, zero cache lookup)
  const staticHit = STATIC_TOKENS[symbol] ?? STATIC_TOKENS[symbol.toUpperCase().trim()];
  if (staticHit) {
    console.log(`[API PERF] resolveInstrument: STATIC HIT for ${symbol} (took ${(performance.now() - start).toFixed(1)}ms)`);
    memCache.set(symbol, staticHit); // backfill mem cache for subsequent paths
    return staticHit;
  }

  // 1. Fastest path: process-level in-memory cache (always checked first)
  const memHit = memCache.get(symbol);
  if (memHit) {
    console.log(`[API PERF] resolveInstrument: MEM HIT for ${symbol} (took ${(performance.now() - start).toFixed(1)}ms)`);
    return memHit;
  }

  const redis = getRedisClient();
  const cacheKey = `instrument_token:${symbol}`;
  
  if (!isRedisMock()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        // Cached value may be "token" or "token|canonicalId"
        const parts = cached.split('|');
        const result: ResolvedInstrument = { token: parseInt(parts[0], 10), canonicalId: parts[1] ?? symbol };
        console.log(`[API PERF] resolveInstrument: REDIS HIT for ${symbol} (took ${(performance.now() - start).toFixed(1)}ms)`);
        memCache.set(symbol, result); // backfill so next call skips Redis too
        return result;
      }
    } catch (e) {
      console.error('Redis cache error for instrument token:', e);
    }
  }

  const save = async (token: number, canonicalId: string): Promise<ResolvedInstrument> => {
    const result: ResolvedInstrument = { token, canonicalId };
    // Always write to process-level cache — survives across requests in same worker
    memCache.set(symbol, result);
    if (!isRedisMock()) {
      try {
        await redis.setex(cacheKey, 86400, `${token}|${canonicalId}`);
      } catch (e) {
        console.error('Redis cache set error for instrument token:', e);
      }
    }
    return result;
  };

  const rawSymbol = symbol;
  let normalizedSymbol = symbol;
  if (normalizedSymbol.startsWith('NCO:')) {
    normalizedSymbol = 'MCX:' + normalizedSymbol.slice(4);
  }

  const isOptSymbol = normalizedSymbol.endsWith('CE') || normalizedSymbol.endsWith('PE');
  if (isOptSymbol && !normalizedSymbol.includes(':')) {
    const upperOpt = normalizedSymbol.toUpperCase();
    const prefix = (upperOpt.includes('SENSEX') || upperOpt.includes('BANKEX')) ? 'BFO'
      : (upperOpt.includes('GOLD') || upperOpt.includes('SILVER') || upperOpt.includes('CRUDE') || upperOpt.includes('NATURALGAS') || upperOpt.includes('NATGAS')) ? 'MCX'
      : (upperOpt.includes('USDINR') || upperOpt.includes('EURINR') || upperOpt.includes('GBPINR') || upperOpt.includes('JPYINR')) ? 'CDS'
      : 'NFO';
    normalizedSymbol = `${prefix}:${normalizedSymbol}`;
  }

  // Fast path: symbol contains ':' (e.g. "MCX:GOLD26AUG161500CE") — exact id match
  if (normalizedSymbol.includes(':')) {
    const { data } = await getSupabase()
      .from('instruments')
      .select('instrument_token, expiry')
      .eq('id', normalizedSymbol)
      .single();
    if (data?.instrument_token) {
      const isOption = normalizedSymbol.endsWith('CE') || normalizedSymbol.endsWith('PE');
      const todayIso = new Date().toISOString().split('T')[0];
      // Only auto-roll futures contracts that have expired; options stay on their exact contract token
      const isExpiredFuture = !isOption && (isContractExpired(normalizedSymbol) || (data.expiry && data.expiry < todayIso));
      if (!isExpiredFuture) {
        return save(data.instrument_token, normalizedSymbol);
      }
      console.log(`[API PERF] resolveInstrument: Future ${normalizedSymbol} is EXPIRED (expiry=${data.expiry}). Auto-resolving to active contract.`);
    }
  }

  const cleanSymbol = (normalizedSymbol.includes(':') ? normalizedSymbol.split(':')[1] : normalizedSymbol).replace(/\//g, '');
  const upperSymbol = cleanSymbol.toUpperCase().trim();

  // Handle index shortcuts (e.g. NIFTY, BANKNIFTY)
  // Covered by STATIC_TOKENS above for the common cases. This branch now only
  // runs for unusual variants that didn't match the static map.
  const baseIndices: Record<string, string> = {
    'NIFTY': 'NSE:NIFTY 50',
    'NIFTY 50': 'NSE:NIFTY 50',
    'BANKNIFTY': 'NSE:NIFTY BANK',
    'NIFTY BANK': 'NSE:NIFTY BANK',
    'FINNIFTY': 'NSE:NIFTY FIN SERVICE',
    'SENSEX': 'BSE:SENSEX',
    'BANKEX': 'BSE:BANKEX',
  };
  if (baseIndices[upperSymbol]) {
    const resolvedSymbol = baseIndices[upperSymbol];
    const { data } = await getSupabase()
      .from('instruments')
      .select('instrument_token')
      .eq('id', resolvedSymbol)
      .single();
    if (data?.instrument_token) return save(data.instrument_token, resolvedSymbol);
  }

  // Handle base commodity and currency shortcuts or expired contracts to resolve to active front-month contracts
  const baseCommodities = ['GOLD', 'CRUDEOIL', 'SILVER', 'NATURALGAS', 'USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
  const isOption = upperSymbol.endsWith('CE') || upperSymbol.endsWith('PE');
  if (!isOption) {
    const matchedCommodity = baseCommodities.find(c => upperSymbol.includes(c));
    if (matchedCommodity) {
      const isCurrency = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'].includes(matchedCommodity);
      const exchange = isCurrency ? 'CDS' : 'MCX';
      const instrumentTypes = isCurrency ? ['FUT', 'MAPPED_FUT'] : ['FUTCOM', 'FUT', 'MAPPED_FUT'];
      
      const { data } = await getSupabase()
        .from('instruments')
        .select('instrument_token, tradingsymbol')
        .eq('name', matchedCommodity)
        .eq('exchange', exchange)
        .in('instrument_type', instrumentTypes)
        .gte('expiry', new Date().toISOString().split('T')[0])
        .order('expiry', { ascending: true })
        .limit(1)
        .maybeSingle();
        
      if (data?.instrument_token) {
        const canonicalId = `${exchange}:${data.tradingsymbol}`;
        return save(data.instrument_token, canonicalId);
      }
    }

    const baseIndicesFut = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
    if (upperSymbol.includes('FUT') || symbol.includes('_')) {
      const matchedIndex = baseIndicesFut.find(idx => upperSymbol.startsWith(idx));
      if (matchedIndex) {
        const exchange = (matchedIndex === 'SENSEX' || matchedIndex === 'BANKEX') ? 'BFO' : 'NFO';
        const { data } = await getSupabase()
          .from('instruments')
          .select('instrument_token, tradingsymbol')
          .eq('name', matchedIndex)
          .eq('exchange', exchange)
          .gte('expiry', new Date().toISOString().split('T')[0])
          .order('expiry', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (data?.instrument_token) {
          const canonicalId = `${exchange}:${data.tradingsymbol}`;
          return save(data.instrument_token, canonicalId);
        }
      }
    }
  }

  // Slow path: short symbol — run ALL strategies in parallel
  const exchanges = ['NSE', 'NFO', 'MCX', 'BSE', 'BFO', 'CDS'];
  const hasUnderscore = symbol.includes('_');
  const baseName = hasUnderscore ? symbol.split('_')[0] : symbol;

  const queries: PromiseLike<{ token: number; canonicalId: string } | null>[] = [];

  // Strategy 1: Exact id match
  queries.push(
    getSupabase().from('instruments').select('instrument_token').eq('id', symbol).limit(1)
      .then(r => r.data?.[0]?.instrument_token ? { token: r.data[0].instrument_token, canonicalId: symbol } : null)
  );

  // Strategy 2: tradingsymbol match (prioritize MCX / NFO over NCO / BFO)
  queries.push(
    getSupabase().from('instruments').select('instrument_token, exchange, tradingsymbol').eq('tradingsymbol', symbol).order('exchange', { ascending: true }).limit(1)
      .then(r => r.data?.[0]?.instrument_token ? { token: r.data[0].instrument_token, canonicalId: `${r.data[0].exchange}:${r.data[0].tradingsymbol}` } : null)
  );

  // Strategy 3: Exchange prefix matches (all in parallel)
  for (const exchange of exchanges) {
    const prefixed = `${exchange}:${symbol}`;
    queries.push(
      getSupabase().from('instruments').select('instrument_token').eq('id', prefixed).limit(1)
        .then(r => r.data?.[0]?.instrument_token ? { token: r.data[0].instrument_token, canonicalId: prefixed } : null)
    );
  }

  // Strategy 4a: Mapped continuous contracts (for underscored symbols)
  if (hasUnderscore) {
    for (const exchange of exchanges) {
      const prefixed = `${exchange}:${baseName}`;
      queries.push(
        getSupabase().from('instruments').select('instrument_token')
          .eq('id', prefixed).eq('instrument_type', 'MAPPED_FUT').limit(1)
          .then(r => r.data?.[0]?.instrument_token ? { token: r.data[0].instrument_token, canonicalId: prefixed } : null)
      );
    }
  }

  // Strategy 4b: Fuzzy tradingsymbol match (for underscored symbols)
  if (hasUnderscore) {
    const fuzzyPattern = symbol.replace(/_/g, '%');
    queries.push(
      getSupabase().from('instruments').select('instrument_token, instrument_type, exchange, tradingsymbol')
        .ilike('tradingsymbol', fuzzyPattern).in('exchange', exchanges)
        .order('instrument_type', { ascending: true }).limit(5)
        .then(r => {
          if (!r.data?.length) return null;
          const mapped = r.data.find((m: any) => m.instrument_type === 'MAPPED_FUT');
          const row = mapped || r.data[0];
          return { token: row.instrument_token, canonicalId: `${row.exchange}:${row.tradingsymbol}` };
        })
    );
  }

  const results = await Promise.all(queries);
  const resolved = results.find(r => r !== null) ?? null;
  if (resolved) return save(resolved.token, resolved.canonicalId);
  return null;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const rawInterval = searchParams.get('interval') || 'day';
    
    // Map standard chart interval codes to Zerodha Kite API compatible strings
    const mapInterval = (inter: string): string => {
      const normalized = inter.toLowerCase().trim();
      if (normalized === '1m' || normalized === '1min' || normalized === 'minute') return 'minute';
      if (normalized === '3m' || normalized === '3min' || normalized === '3minute') return '3minute';
      if (normalized === '5m' || normalized === '5min' || normalized === '5minute') return '5minute';
      if (normalized === '10m' || normalized === '10min' || normalized === '10minute') return '10minute';
      if (normalized === '15m' || normalized === '15min' || normalized === '15minute') return '15minute';
      if (normalized === '30m' || normalized === '30min' || normalized === '30minute') return '30minute';
      if (normalized === '60m' || normalized === '60min' || normalized === '60minute' || normalized === '1h' || normalized === 'hour') return '60minute';
      if (normalized === 'day' || normalized === 'd' || normalized === '1d') return 'day';
      return inter;
    };
    
    const interval = mapInterval(rawInterval);
    const toVal = searchParams.get('to') || new Date().toISOString().slice(0, 10);
    let fromVal = searchParams.get('from');
    if (!fromVal) {
      const fromDate = new Date();
      if (interval.includes('minute') || interval.includes('min') || interval === '60m' || interval === '30m' || interval === '15m' || interval === '5m' || interval === '1m') {
        fromDate.setDate(fromDate.getDate() - 7); // 7 days ago for intraday
      } else {
        fromDate.setFullYear(fromDate.getFullYear() - 1); // 1 year ago for daily/weekly
      }
      fromVal = fromDate.toISOString().slice(0, 10);
    }

    if (!symbol) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const fromMs = searchParams.get('from') ? new Date(searchParams.get('from')!).getTime() : (Date.now() - 7 * 86400 * 1000);
    const toMs = searchParams.get('to') ? new Date(searchParams.get('to')!).getTime() : Date.now();

    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();

    const formatKiteIST = (ms: number) => {
      const d = new Date(ms + 19800 * 1000);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const h = String(d.getUTCHours()).padStart(2, '0');
      const min = String(d.getUTCMinutes()).padStart(2, '0');
      const s = String(d.getUTCSeconds()).padStart(2, '0');
      return `${y}-${m}-${day} ${h}:${min}:${s}`;
    };
    const kiteFrom = formatKiteIST(fromMs);
    const kiteTo = formatKiteIST(toMs);

    const routeStart = performance.now();
    console.log(`[API PERF] /historical GET start: symbol=${symbol}, interval=${interval}, from=${from}, to=${to}`);

    // Run session fetch and symbol resolution in PARALLEL (they're independent)
    const [session, resolved] = await Promise.all([
      getSharedKiteSession(),
      resolveInstrument(symbol)
    ]);
    console.log(`[API PERF] /historical resolution & session complete (took ${(performance.now() - routeStart).toFixed(1)}ms)`);

    if (!session) {
      return NextResponse.json({ error: 'No active Kite session found' }, { status: 401 });
    }
    if (!resolved) {
      return NextResponse.json({ error: `Instrument not found for symbol: ${symbol}` }, { status: 404 });
    }

    const instrumentToken = resolved.token;
    // canonicalId comes directly from resolution — no extra round-trip needed.
    const canonicalSymbol = resolved.canonicalId;

    const cacheKey = `historical:${instrumentToken}:${interval}:${from}:${to}`;

    // 1. Process-level in-memory cache check (instant <1ms response)
    const memHit = candleMemCache.get(cacheKey);
    if (memHit && memHit.expiry > Date.now()) {
      console.log(`[API PERF] /historical CANDLE MEM CACHE HIT for ${cacheKey} (total ${(performance.now() - routeStart).toFixed(1)}ms)`);
      return NextResponse.json(memHit.data);
    }

    const redis = getRedisClient();

    if (!isRedisMock()) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          candleMemCache.set(cacheKey, { data: parsed, expiry: Date.now() + 30000 });
          console.log(`[API PERF] /historical CANDLE REDIS CACHE HIT for ${cacheKey} (total ${(performance.now() - routeStart).toFixed(1)}ms)`);
          return NextResponse.json(parsed);
        }
      } catch (e) {
        console.error('Redis cache error for historical data:', e);
      }
    }

    console.log(`[API PERF] /historical CANDLE CACHE MISS for ${cacheKey} -> Fetching from Kite API`);

    // Fetch from Kite Historical API
    let candlesData: any[] | null = null;
    let kiteError: string | null = null;
    const kiteStart = performance.now();
    
    try {
      const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(kiteFrom)}&to=${encodeURIComponent(kiteTo)}`;
      const response = await fetch(url, {
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${process.env.KITE_API_KEY || process.env.NEXT_PUBLIC_KITE_API_KEY}:${session.accessToken}`
        },
        signal: AbortSignal.timeout(3500)
      });
      const data = await response.json();
      console.log(`[API PERF] Kite historical API finished in ${(performance.now() - kiteStart).toFixed(1)}ms (ok=${response.ok})`);
      if (response.ok && data.status === 'success' && data.data && Array.isArray(data.data.candles)) {
        candlesData = data.data.candles;
      } else {
        kiteError = data.message || data.error_type || 'Kite API error';
      }
    } catch (err: any) {
      console.log(`[API PERF] Kite historical API exception/timeout after ${(performance.now() - kiteStart).toFixed(1)}ms: ${err.message}`);
      kiteError = err.message || 'Kite fetch exception';
    }

    // Fallback 1: Query local historical_candles DB table (highly useful for MCX Options and Kite outages)
    if (!candlesData || candlesData.length === 0) {
      console.warn(`[historical] Kite fetch unavailable or returned empty for ${canonicalSymbol} (Reason: ${kiteError}). Falling back to local DB historical_candles.`);
      try {
        const { data: dbData, error: dbError } = await getSupabase()
          .from('historical_candles')
          .select('timestamp, open, high, low, close, volume')
          .or(`symbol.eq.${canonicalSymbol},symbol.eq.${symbol}`)
          .eq('interval', interval)
          .gte('timestamp', from)
          .lte('timestamp', to)
          .order('timestamp', { ascending: true })
          .limit(1000);
        
        if (!dbError && dbData && dbData.length > 0) {
          candlesData = dbData.map((c: any) => [
            c.timestamp,
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume
          ]);
        }
      } catch (dbErr) {
        console.error('[historical] Failed to query local fallback candles:', dbErr);
      }
    }

    // Fallback 2: Synthesize a sequence of flat placeholder candles strictly bounded within [fromMs, toMs]
    if (!candlesData || candlesData.length === 0) {
      // If requested historical chunk is older than 30 days and has no data, return empty candles so TV chart stops backward paging loop
      if (toMs < Date.now() - 30 * 86400 * 1000) {
        return NextResponse.json({ candles: [] });
      }

      console.warn(`[historical] No historical data found in Kite or DB for ${canonicalSymbol}. Synthesizing flat-line placeholder candles bounded within requested timeframe.`);
      let lastPrice = 0;
      try {
        const keysToTry = [canonicalSymbol, symbol, String(instrumentToken)];
        for (const k of keysToTry) {
          const cachedQuote = await redis.hget('market:quotes', k);
          if (cachedQuote) {
            const parsed = JSON.parse(cachedQuote);
            const p = Number(parsed.last_price || parsed.close || parsed.lastPrice || 0);
            if (p > 0) { lastPrice = p; break; }
          }
        }
      } catch (e) {}

      if (lastPrice === 0) {
        try {
          const cleanSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
          const { data: instData } = await getSupabase()
            .from('instruments')
            .select('last_price')
            .or(`id.eq.${canonicalSymbol},id.eq.${symbol},tradingsymbol.eq.${cleanSymbol}`)
            .limit(1);
          if (instData?.[0]?.last_price) {
            lastPrice = Number(instData[0].last_price);
          }
        } catch (e) {}
      }

      // Default to minimum positive tick price if untraded / unknown
      if (lastPrice <= 0) {
        const isOption = symbol.match(/(?:CE|PE)$/i);
        const upperSym = symbol.toUpperCase();
        if (isOption) {
          lastPrice = 0.05;
        } else if (upperSym.includes('GBPINR')) {
          lastPrice = 128.75;
        } else if (upperSym.includes('EURINR')) {
          lastPrice = 92.5;
        } else if (upperSym.includes('USDINR')) {
          lastPrice = 83.9;
        } else if (upperSym.includes('JPYINR')) {
          lastPrice = 0.58;
        } else {
          lastPrice = 10.0;
        }
      }

      let spacingMs = 60 * 1000;
      const normalized = interval.toLowerCase();
      if (normalized.includes('3min')) spacingMs = 3 * 60 * 1000;
      else if (normalized.includes('5min')) spacingMs = 5 * 60 * 1000;
      else if (normalized.includes('10min')) spacingMs = 10 * 60 * 1000;
      else if (normalized.includes('15min')) spacingMs = 15 * 60 * 1000;
      else if (normalized.includes('30min')) spacingMs = 30 * 60 * 1000;
      else if (normalized.includes('60min') || normalized.includes('hour')) spacingMs = 60 * 60 * 1000;
      else if (normalized.includes('day') || normalized.includes('1d')) spacingMs = 24 * 60 * 60 * 1000;

      const endMs = Math.min(toMs, Date.now());
      const maxBars = 100;
      const startMs = Math.max(fromMs, endMs - maxBars * spacingMs);
      candlesData = [];
      for (let t = startMs; t <= endMs; t += spacingMs) {
        const roundedTime = Math.floor(t / spacingMs) * spacingMs;
        candlesData.push([
          new Date(roundedTime).toISOString(),
          lastPrice,
          lastPrice,
          lastPrice,
          lastPrice,
          0
        ]);
      }
    }

    const result = { candles: candlesData };

    if (candlesData && candlesData.length > 0) {
      const memTtl = (interval === 'day' || interval === 'week') ? 300_000 : 30_000;
      candleMemCache.set(cacheKey, { data: result, expiry: Date.now() + memTtl });
      if (!isRedisMock()) {
        try {
          const ttl = (interval === 'day' || interval === 'week') ? 3600 : (interval.includes('minute') || interval.includes('min') || ['1m','5m','15m','30m','60m'].includes(interval)) ? 60 : 300;
          await redis.setex(cacheKey, ttl, JSON.stringify(result));
        } catch (e) {
          console.error('Redis cache set error for historical data:', e);
        }
      }
    }

    return NextResponse.json(result);

  } catch (error: any) {
    console.error('Historical API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error', message: error.message }, { status: 500 });
  }
}
