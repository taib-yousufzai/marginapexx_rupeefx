export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRedisClient, isRedisMock } from '@/lib/redis';
import {
  loadStrikeConfig,
  applyExpiryFilter,
  applyStrikeRangeFilter,
  applyMcxStrikeRangeFilter,
  isExpiryDateExpired,
  type Instrument,
} from '@/lib/filterEngine';

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const MCX_SYMBOLS = new Set([
  'GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS',
  'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI',
]);

const INDEX_KITE_MAP: Record<string, string> = {
  'NIFTY':      'NSE:NIFTY 50',
  'BANKNIFTY':  'NSE:NIFTY BANK',
  'FINNIFTY':   'NSE:NIFTY FIN SERVICE',
  'MIDCPNIFTY': 'NSE:NIFTY MID SELECT',
  'SENSEX':     'BSE:SENSEX',
  'SENSEX50':   'BSE:SENSEX50',
  'BANKEX':     'BSE:BANKEX',
  'NIFTYNXT50': 'NSE:NIFTY NEXT 50',
};

const MCX_BASE_MAP: Record<string, string> = {
  GOLDM: 'GOLD', SILVERM: 'SILVER', CRUDEOILM: 'CRUDEOIL', NATGASMINI: 'NATURALGAS',
};

export async function GET(request: Request) {
  const supabase = getSupabase();
  try {
    const { searchParams } = new URL(request.url);
    let symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();
    if (symbol === 'MIDCAP') symbol = 'MIDCPNIFTY';

    const expiry    = searchParams.get('expiry');
    const spotParam = searchParams.get('spotPrice');
    const today     = new Date().toISOString().split('T')[0];
    const isMcx     = MCX_SYMBOLS.has(symbol);
    const targetExchanges = isMcx ? ['MCX'] : ['NFO', 'BFO'];

    const spotForBucket = parseFloat(spotParam || '0') || 0;
    const atmBucket = spotForBucket > 0
      ? Math.round(spotForBucket / (spotForBucket * 0.01)) * Math.round(spotForBucket * 0.01)
      : 0;
    const cacheKey = `optionChain:${symbol}_${expiry || 'default'}_${atmBucket}`;
    const redis = getRedisClient();

    // ── 1. Full response cache (10s TTL) ──────────────────────────────────────
    // Attempt Redis cache regardless of connection status — catch handles failures
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return NextResponse.json(JSON.parse(cached));
    } catch { /* Redis not ready or key missing — proceed to live fetch */ }

    // ── 2. Helper functions ───────────────────────────────────────────────────

    // Resolve MCX underlying → the future with a live Redis price
    async function resolveMcxUnderlyingId(): Promise<string> {
      const baseSymbol = MCX_BASE_MAP[symbol] ?? symbol;
      const cacheKeyMcx = `mcxUnderlyingCache:${baseSymbol}`;
      try {
        const cached = await redis.get(cacheKeyMcx);
        if (cached) return cached;
      } catch { /* ignore */ }
      try {
        const { data: futs } = await supabase
          .from('instruments')
          .select('tradingsymbol')
          .eq('name', baseSymbol)
          .eq('segment', 'MCX-FUT')
          .gte('expiry', today)
          .order('expiry', { ascending: true })
          .limit(5);
        if (!futs?.length) return `MCX:${symbol}`;
        const candidates = futs.map((f: any) => `MCX:${f.tradingsymbol}`);
        try {
          const prices = await redis.hmget('market:quotes', ...candidates);
          const live = candidates.find((_: string, i: number) => {
            try { return !!(prices[i] && JSON.parse(prices[i] as string).last_price > 0); }
            catch { return false; }
          });
          if (live) {
            redis.setex(cacheKeyMcx, 3600, live).catch(() => {});
            return live;
          }
        } catch { /* fall through to first candidate */ }
        redis.setex(cacheKeyMcx, 3600, candidates[0]).catch(() => {});
        return candidates[0];
      } catch { return `MCX:${symbol}`; }
    }

    // Fetch expiries (Redis 1h cache → Supabase)
    async function getExpiries(): Promise<string[]> {
      const k = `optionChainExpiries:${symbol}`;
      try {
        const cached = await redis.get(k);
        if (cached) return JSON.parse(cached);
      } catch { /* fall through */ }
      const { data, error } = await supabase
        .from('instruments')
        .select('expiry')
        .eq('name', symbol)
        .in('exchange', targetExchanges)
        .not('expiry', 'is', null)
        .gte('expiry', today)
        .in('option_type', ['CE', 'PE'])
        .order('expiry', { ascending: true });
      if (error) throw error;
      const expiries = Array.from(new Set(data.map((e: any) => e.expiry))) as string[];
      if (expiries.length > 0)
        redis.setex(k, 300, JSON.stringify(expiries)).catch(() => {}); // 5m cache to allow expiry transition
      return expiries;
    }

    // Fetch options for a given expiry (Redis 1h cache → Supabase)
    async function getOptions(forExpiry: string): Promise<any[]> {
      const k = `optionChainOptions:${symbol}_${forExpiry}`;
      try {
        const cached = await redis.get(k);
        if (cached) return JSON.parse(cached);
      } catch { /* fall through */ }
      const { data, error } = await supabase
        .from('instruments')
        .select('id, instrument_token, tradingsymbol, strike_price, option_type, exchange')
        .eq('name', symbol)
        .in('exchange', targetExchanges)
        .eq('expiry', forExpiry)
        .in('option_type', ['CE', 'PE'])
        .order('strike_price', { ascending: true });
      if (error) throw error;
      if (data?.length)
        redis.setex(k, 86400, JSON.stringify(data)).catch(() => {}); // 24h — instrument rows don't change intraday
      return data ?? [];
    }

    async function getStrikeConfig() {
      const k = 'strikeConfigCache';
      try {
        const cached = await redis.get(k);
        if (cached) return JSON.parse(cached);
      } catch { /* ignore */ }
      const cfg = await loadStrikeConfig(supabase);
      redis.setex(k, 300, JSON.stringify(cfg)).catch(() => {}); // 5 minutes cache
      return cfg;
    }

    // ── 3. Parallel fetch: expiries + strike config + MCX future resolver ─────
    let underlyingKiteId = INDEX_KITE_MAP[symbol] ?? `MCX:${symbol}`;

    const [allExpiries, strikeConfig, resolvedMcxId] = await Promise.all([
      getExpiries(),
      getStrikeConfig(),
      isMcx ? resolveMcxUnderlyingId() : Promise.resolve(''),
    ]);

    if (isMcx) underlyingKiteId = resolvedMcxId;

    const activeExpiries  = applyExpiryFilter(allExpiries, today, isMcx);
    const selectedExpiry  = (expiry && !isExpiryDateExpired(expiry, isMcx)) ? expiry : activeExpiries[0];

    if (!selectedExpiry) {
      return NextResponse.json({
        success: true, expiries: activeExpiries, strikes: [],
        message: 'No options found for this symbol',
      });
    }

    // ── 4. Parallel fetch: options rows + ATM price from Redis ────────────────
    const [options, atmRedisRaw] = await Promise.all([
      getOptions(selectedExpiry),
      redis.hget('market:quotes', underlyingKiteId).catch(() => null),
    ]);

    if (!options.length) {
      return NextResponse.json({
        success: true, expiries: activeExpiries, strikes: [],
        message: 'No options found for this symbol',
      });
    }

    // ── 5. Resolve ATM price ──────────────────────────────────────────────────
    let atmPrice = spotParam ? parseFloat(spotParam) || 0 : 0;
    let usedFallback = false;

    if (!atmPrice && atmRedisRaw) {
      try { atmPrice = JSON.parse(atmRedisRaw as string).last_price || 0; } catch { /* ignore */ }
    }

    // Try alternative Redis keys if primary underlyingKiteId had no price
    if (!atmPrice) {
      try {
        const altKeys = [
          symbol,
          underlyingKiteId.replace(/\s+/g, '_'),
          underlyingKiteId.split(':').pop() || '',
        ].filter(Boolean);
        const altQuotes = await redis.hmget('market:quotes', ...altKeys);
        for (const raw of altQuotes) {
          if (raw) {
            const parsed = JSON.parse(raw as string);
            if (parsed.last_price > 0) {
              atmPrice = parsed.last_price;
              break;
            }
          }
        }
      } catch { /* ignore */ }
    }

    if (!atmPrice) {
      console.warn(`[option-chain] No ATM price for ${symbol}, using median strike fallback`);
      usedFallback = true;
      atmPrice = options[Math.floor(options.length / 2)]?.strike_price || 0;
    }

    // ── 6. Apply strike range filter (minimum 31 strikes buffer so 5 strikes above and below ATM are always available) ───
    const baseRange = isMcx ? strikeConfig.mcxOptionsRange : strikeConfig.indexOptionsRange;
    const fetchRange = isMcx ? strikeConfig.mcxOptionsRange : Math.max(11, baseRange);
    const filteredOptions: any[] = atmPrice
      ? applyStrikeRangeFilter(options as Instrument[], atmPrice, fetchRange) as any[]
      : options;

    // ── 7. Group by strike ────────────────────────────────────────────────────
    const strikeMap: Record<number, any> = {};
    for (const opt of filteredOptions) {
      const strike = opt.strike_price;
      if (!strikeMap[strike]) strikeMap[strike] = { strike };
      const kiteId = `${opt.exchange}:${opt.tradingsymbol}`;
      if (opt.option_type === 'CE') {
        strikeMap[strike].ce = { token: opt.instrument_token, symbol: opt.tradingsymbol, id: kiteId };
      } else {
        strikeMap[strike].pe = { token: opt.instrument_token, symbol: opt.tradingsymbol, id: kiteId };
      }
    }
    const sortedStrikes = Object.values(strikeMap).sort((a: any, b: any) => a.strike - b.strike);

    // ── 8. Backfill Redis prices (single hmget with freshness check) ─────────
    try {
      const allKiteIds: string[] = [];
      sortedStrikes.forEach((row: any) => {
        if (row.ce?.id) allKiteIds.push(row.ce.id);
        if (row.pe?.id) allKiteIds.push(row.pe.id);
      });
      if (allKiteIds.length > 0) {
        const prices = await redis.hmget('market:quotes', ...allKiteIds);
        const priceMap: Record<string, number> = {};
        const now = Date.now();
        allKiteIds.forEach((id, i) => {
          try {
            if (!prices[i]) return;
            const q = JSON.parse(prices[i] as string);
            const rawTime = q.last_trade_time || q.timestamp || q.time || 0;
            const qTime = new Date(rawTime).getTime();
            // Strictly reject stale Redis cached ticks older than 60 seconds
            const isFresh = qTime > 0 && !isNaN(qTime) && (now - qTime < 60000);
            const ltp = Number(q.last_price ?? q.lastPrice ?? 0);
            if (isFresh && ltp > 0) {
              priceMap[id] = ltp;
            }
          } catch { /* malformed entry */ }
        });
        sortedStrikes.forEach((row: any) => {
          if (row.ce?.id && priceMap[row.ce.id]) {
            row.ce.price = priceMap[row.ce.id];
          }
          if (row.pe?.id && priceMap[row.pe.id]) {
            row.pe.price = priceMap[row.pe.id];
          }
        });
      }
    } catch { /* non-fatal — WebSocket will deliver live prices */ }

    // ── 9. Build response & cache (fire-and-forget, 60s TTL) ─────────────────
    const responseData = {
      success: true, symbol,
      expiry: selectedExpiry,
      expiries: activeExpiries,
      strikes: sortedStrikes,
      underlyingPrice: atmPrice,
      underlyingSymbol: underlyingKiteId,
      usedFallback,
    };

    if (!usedFallback) {
      // 60s TTL — longer than before so cold starts always hit cache
      redis.setex(cacheKey, 60, JSON.stringify(responseData)).catch(() => {});
      redis.setex(`optionChain:${symbol}_${selectedExpiry}`, 60, JSON.stringify(responseData)).catch(() => {});
    }

    return NextResponse.json(responseData);

  } catch (error: any) {
    console.error('[Option Chain API] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
