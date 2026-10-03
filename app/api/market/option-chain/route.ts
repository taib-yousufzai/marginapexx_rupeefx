export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRedisClient, isRedisMock } from '@/lib/redis';
import { getSharedKiteSession } from '@/lib/kiteSession';
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
  GOLD: 'GOLDM', SILVER: 'SILVERM', CRUDEOIL: 'CRUDEOILM', NATURALGAS: 'NATGASMINI',
};

// High-performance in-memory caches (shared across requests in the Node.js process)
const inMemoryExpiriesCache = new Map<string, { expiries: string[]; exp: number }>();
const inMemoryOptionsCache = new Map<string, { options: any[]; exp: number }>();
const inMemoryResponseCache = new Map<string, { data: any; exp: number }>();

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
    const targetExchanges = isMcx ? ['MCX', 'NCO'] : ['NFO', 'BFO'];

    const cacheKey = `optionChain:${symbol}_${expiry || 'default'}`;
    const nowMs = Date.now();
    const spotNum = spotParam ? parseFloat(spotParam) : 0;
    const strikeStep = symbol.includes('MIDCP') ? 25 : (symbol.includes('NIFTY') ? 50 : 100);

    // ── 1. In-Memory Process Response Cache (10s TTL — <1ms response) ────────
    const memCached = inMemoryResponseCache.get(cacheKey);
    if (memCached && memCached.exp > nowMs) {
      if (!spotNum || !memCached.data?.underlyingPrice || Math.abs(spotNum - memCached.data.underlyingPrice) <= strikeStep * 2) {
        return NextResponse.json(memCached.data);
      }
    }

    const redis = getRedisClient();

    // ── 2. Redis Shared Response Cache (20s TTL — <10ms response) ─────────────
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (!spotNum || !parsed.underlyingPrice || Math.abs(spotNum - parsed.underlyingPrice) <= strikeStep * 2) {
          inMemoryResponseCache.set(cacheKey, { data: parsed, exp: nowMs + 10000 });
          return NextResponse.json(parsed);
        }
      }
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
          .in('name', [symbol, baseSymbol])
          .in('segment', ['MCX-FUT', 'NCO-FUT'])
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
            redis.setex(cacheKeyMcx, 300, live).catch(() => {});
            return live;
          }
        } catch { /* fall through to first candidate */ }
        redis.setex(cacheKeyMcx, 300, candidates[0]).catch(() => {});
        return candidates[0];
      } catch { return `MCX:${symbol}`; }
    }

    // Fetch expiries (In-Memory 10m → Redis 5m → Supabase)
    async function getExpiries(): Promise<string[]> {
      const k = `optionChainExpiries:${symbol}`;
      const mem = inMemoryExpiriesCache.get(k);
      if (mem && mem.exp > Date.now()) return mem.expiries;

      try {
        const cached = await redis.get(k);
        if (cached) {
          const parsed = JSON.parse(cached);
          inMemoryExpiriesCache.set(k, { expiries: parsed, exp: Date.now() + 600000 });
          return parsed;
        }
      } catch { /* fall through */ }
      let { data, error } = await supabase
        .from('instruments')
        .select('expiry')
        .eq('name', symbol)
        .in('exchange', targetExchanges)
        .not('expiry', 'is', null)
        .gte('expiry', today)
        .in('option_type', ['CE', 'PE'])
        .order('expiry', { ascending: true });
      if (error) throw error;

      if ((!data || data.length === 0) && isMcx && MCX_BASE_MAP[symbol]) {
        const fallbackRes = await supabase
          .from('instruments')
          .select('expiry')
          .eq('name', MCX_BASE_MAP[symbol])
          .in('exchange', targetExchanges)
          .not('expiry', 'is', null)
          .gte('expiry', today)
          .in('option_type', ['CE', 'PE'])
          .order('expiry', { ascending: true });
        if (fallbackRes.data && fallbackRes.data.length > 0) {
          data = fallbackRes.data;
        }
      }

      const expiries = Array.from(new Set((data || []).map((e: any) => e.expiry))) as string[];
      if (expiries.length > 0) {
        inMemoryExpiriesCache.set(k, { expiries, exp: Date.now() + 600000 });
        redis.setex(k, 300, JSON.stringify(expiries)).catch(() => {});
      }
      return expiries;
    }

    // Fetch options for a given expiry (In-Memory 30m → Redis 24h → Supabase)
    async function getOptions(forExpiry: string): Promise<any[]> {
      const k = `optionChainOptions:${symbol}_${forExpiry}`;
      const mem = inMemoryOptionsCache.get(k);
      if (mem && mem.exp > Date.now()) return mem.options;

      try {
        const cached = await redis.get(k);
        if (cached) {
          const parsed = JSON.parse(cached);
          inMemoryOptionsCache.set(k, { options: parsed, exp: Date.now() + 1800000 });
          return parsed;
        }
      } catch { /* fall through */ }
      let { data, error } = await supabase
        .from('instruments')
        .select('id, instrument_token, tradingsymbol, strike_price, option_type, exchange')
        .eq('name', symbol)
        .in('exchange', targetExchanges)
        .eq('expiry', forExpiry)
        .in('option_type', ['CE', 'PE'])
        .order('strike_price', { ascending: true });
      if (error) throw error;

      if ((!data || data.length === 0) && isMcx && MCX_BASE_MAP[symbol]) {
        const fallbackRes = await supabase
          .from('instruments')
          .select('id, instrument_token, tradingsymbol, strike_price, option_type, exchange')
          .eq('name', MCX_BASE_MAP[symbol])
          .in('exchange', targetExchanges)
          .eq('expiry', forExpiry)
          .in('option_type', ['CE', 'PE'])
          .order('strike_price', { ascending: true });
        if (fallbackRes.data && fallbackRes.data.length > 0) {
          data = fallbackRes.data;
        }
      }

      const resOptions = data ?? [];
      if (resOptions.length) {
        inMemoryOptionsCache.set(k, { options: resOptions, exp: Date.now() + 1800000 });
        redis.setex(k, 86400, JSON.stringify(resOptions)).catch(() => {});
      }
      return resOptions;
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
    const selectedExpiry  = (expiry && activeExpiries.includes(expiry) && !isExpiryDateExpired(expiry, isMcx)) ? expiry : activeExpiries[0];

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
    const sortedOptionsStrikes = options.map((o: any) => o.strike_price).sort((a: number, b: number) => a - b);
    const minStrike = sortedOptionsStrikes[0] || 0;
    const maxStrike = sortedOptionsStrikes[sortedOptionsStrikes.length - 1] || 0;
    const medianStrike = sortedOptionsStrikes[Math.floor(sortedOptionsStrikes.length / 2)] || 0;

    let atmPrice = spotParam ? parseFloat(spotParam) || 0 : 0;
    let usedFallback = false;

    // Check if spotParam is realistic
    if (atmPrice > 0 && (atmPrice < minStrike * 0.4 || atmPrice > maxStrike * 2.5)) {
      atmPrice = 0;
    }

    if (!atmPrice && atmRedisRaw) {
      try {
        const parsedLp = JSON.parse(atmRedisRaw as string).last_price || 0;
        if (parsedLp >= minStrike * 0.4 && parsedLp <= maxStrike * 2.5) {
          atmPrice = parsedLp;
        }
      } catch { /* ignore */ }
    }

    // Try alternative Redis keys if primary underlyingKiteId had no valid price
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
            const lp = parsed.last_price || parsed.lastPrice || 0;
            if (lp >= minStrike * 0.4 && lp <= maxStrike * 2.5) {
              atmPrice = lp;
              break;
            }
          }
        }
      } catch { /* ignore */ }
    }

    // If still missing, query live Ticker daemon directly
    if (!atmPrice) {
      try {
        const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
        const res = await fetch(`${tickerUrl}/quotes?symbols=${underlyingKiteId}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) }).catch(() => null);
        if (res?.ok) {
          const json = await res.json();
          const tick = json?.data?.[underlyingKiteId];
          const tickLtp = Number(tick?.last_price || tick?.lastPrice || 0);
          if (tickLtp >= minStrike * 0.4 && tickLtp <= maxStrike * 2.5) {
            atmPrice = tickLtp;
            redis.hset('market:quotes', underlyingKiteId, JSON.stringify(tick)).catch(() => {});
          }
        }
      } catch { /* non-fatal */ }
    }

    // If still missing, query Kite REST API directly
    if (!atmPrice) {
      try {
        const sharedSession = await getSharedKiteSession();
        const apiKey = process.env.KITE_API_KEY;
        if (sharedSession?.accessToken && apiKey) {
          const kiteRes = await fetch(`https://api.kite.trade/quote?i=${encodeURIComponent(underlyingKiteId)}`, {
            headers: {
              'X-Kite-Version': '3',
              'Authorization': `token ${apiKey}:${sharedSession.accessToken}`,
            },
            cache: 'no-store',
            signal: AbortSignal.timeout(2000),
          });
          if (kiteRes.ok) {
            const kiteJson = await kiteRes.json();
            const q = kiteJson?.data?.[underlyingKiteId];
            const lp = Number(q?.last_price || 0);
            if (lp >= minStrike * 0.4 && lp <= maxStrike * 2.5) {
              atmPrice = lp;
              redis.hset('market:quotes', underlyingKiteId, JSON.stringify(q)).catch(() => {});
              const clean = underlyingKiteId.includes(':') ? underlyingKiteId.split(':')[1] : underlyingKiteId;
              redis.hset('market:quotes', clean, JSON.stringify(q)).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.warn('[option-chain] Direct Kite underlying fetch failed:', err);
      }
    }

    if (!atmPrice) {
      const upper = symbol.toUpperCase();
      let baseline = 0;
      if (upper.includes('CRUDE')) baseline = 5740;
      else if (upper.includes('GOLD')) baseline = 73450;
      else if (upper.includes('SILVER')) baseline = 85200;
      else if (upper.includes('NATURALGAS') || upper.includes('NATGAS')) baseline = 198.5;
      else if (upper.includes('SENSEX')) baseline = 73800;
      else if (upper.includes('BANKNIFTY') || upper.includes('BANK')) baseline = 48200;
      else if (upper.includes('MIDCP')) baseline = 11800;
      else if (upper.includes('NIFTY')) baseline = 22420;

      if (baseline > 0 && baseline >= minStrike * 0.4 && baseline <= maxStrike * 2.5) {
        atmPrice = baseline;
      } else {
        console.warn(`[option-chain] No valid ATM price for ${symbol}, using median strike fallback (${medianStrike})`);
        atmPrice = medianStrike;
      }
      usedFallback = true;
    }

    // ── 6. Apply strike range filter (31 strikes window: 15 above, ATM, 15 below for fast payload & client centering) ───
    const fetchRange = 31;
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

    // ── 8. Backfill Redis prices (single hmget with freshness check & Kite REST fallback) ─────────
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

        // If any option prices are missing from Redis, fetch them from Kite REST API
        const missingOptionIds = allKiteIds.filter(id => !priceMap[id]);
        if (missingOptionIds.length > 0) {
          try {
            const sharedSession = await getSharedKiteSession();
            const apiKey = process.env.KITE_API_KEY;
            if (sharedSession?.accessToken && apiKey) {
              const batchSize = 100;
              for (let i = 0; i < missingOptionIds.length; i += batchSize) {
                const batch = missingOptionIds.slice(i, i + batchSize);
                const params = new URLSearchParams();
                batch.forEach(b => params.append('i', b));
                const res = await fetch(`https://api.kite.trade/quote?${params.toString()}`, {
                  headers: {
                    'X-Kite-Version': '3',
                    'Authorization': `token ${apiKey}:${sharedSession.accessToken}`,
                  },
                  cache: 'no-store',
                  signal: AbortSignal.timeout(2500),
                });
                if (res.ok) {
                  const json = await res.json();
                  if (json?.data) {
                    for (const [id, q] of Object.entries(json.data as Record<string, any>)) {
                      const lp = Number(q.last_price ?? 0);
                      if (lp > 0) {
                        priceMap[id] = lp;
                        redis.hset('market:quotes', id, JSON.stringify(q)).catch(() => {});
                        const clean = id.includes(':') ? id.split(':')[1] : id;
                        redis.hset('market:quotes', clean, JSON.stringify(q)).catch(() => {});
                      }
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.warn('[option-chain] Kite quote backfill warning:', err);
          }
        }

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
