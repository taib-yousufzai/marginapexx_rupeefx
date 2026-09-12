/**
 * GET /api/market/instruments/search?q=<query>
 *
 * Public endpoint — searches the instruments table for live market instruments.
 * Used by the watchlist search to surface real option chain strikes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getUserFromRequest, getAdminClient } from '@/lib/adminClient';
import { fetchKiteQuotes } from '@/lib/datafeed/MarketDataService';
import { getRedisClient, isRedisMock } from '@/lib/redis';
import { getSharedKiteSession } from '@/lib/kiteSession';
import {
  applyForexFilter,
  applyCryptoWhitelist,
  applyExpiryFilter,
  applyStrikeRangeFilter,
  loadStrikeConfig,
  type Instrument,
} from '@/lib/filterEngine';

import { parseOptionSymbol } from '@/lib/positionStore';
import { fetchUSStockQuotes, getUSStockBasePrice } from '@/lib/datafeed/USStockService';
import { getCurrentFuturesSymbol } from '@/lib/contractExpiry';

const US_STOCK_ITEMS = [
  { name: 'Apple Inc.', symbol: 'AAPL', segment: 'US - Equity' },
  { name: 'Tesla, Inc.', symbol: 'TSLA', segment: 'US - Equity' },
  { name: 'NVIDIA Corporation', symbol: 'NVDA', segment: 'US - Equity' },
  { name: 'Microsoft Corporation', symbol: 'MSFT', segment: 'US - Equity' },
  { name: 'Amazon.com, Inc.', symbol: 'AMZN', segment: 'US - Equity' },
  { name: 'Alphabet Inc.', symbol: 'GOOGL', segment: 'US - Equity' },
  { name: 'Meta Platforms, Inc.', symbol: 'META', segment: 'US - Equity' },
  { name: 'Netflix, Inc.', symbol: 'NFLX', segment: 'US - Equity' },
  { name: 'Advanced Micro Devices', symbol: 'AMD', segment: 'US - Equity' },
  { name: 'Intel Corporation', symbol: 'INTC', segment: 'US - Equity' },
  { name: 'SPDR S&P 500 ETF Trust (S&P 500)', symbol: 'SPY', segment: 'US - Equity' },
  { name: 'Invesco QQQ Trust (Nasdaq 100)', symbol: 'QQQ', segment: 'US - Equity' },
  { name: 'SPDR Dow Jones Industrial Average ETF (Dow Jones)', symbol: 'DIA', segment: 'US - Equity' },
  { name: 'S&P 500 E-mini Futures', symbol: 'ES=F', segment: 'US - Equity' },
  { name: 'Nasdaq 100 E-mini Futures', symbol: 'NQ=F', segment: 'US - Equity' },
  { name: 'Dow Jones E-mini Futures', symbol: 'YM=F', segment: 'US - Equity' },
];

const US_STOCK_SYMBOLS = new Set(US_STOCK_ITEMS.map(i => i.symbol));

// MCX commodity underlyings — these trade on MCX, not NSE
const MCX_UNDERLYINGS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC',
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
  'COPPER', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI',
  'ALUMINIUM', 'ALUMINI',
]);

// Mini/variant → base commodity for MCX futures lookup
const MCX_BASE_MAP: Record<string, string> = {
  'GOLDM': 'GOLD', 'SILVERM': 'SILVER', 'SILVERMIC': 'SILVER',
  'CRUDEOILM': 'CRUDEOIL', 'NATGASMINI': 'NATURALGAS',
  'ALUMINI': 'ALUMINIUM', 'ZINCMINI': 'ZINC', 'LEADMINI': 'LEAD',
};

/**
 * Resolve MCX underlying names → their nearest LIVE futures kite ID.
 * Prefers the future that has a recent live price in Redis over the
 * nearest-expiry future (which may be rolling off and have stale data).
 * e.g. ['GOLD', 'GOLDM'] → { GOLD: 'MCX:GOLD26OCTFUT', GOLDM: 'MCX:GOLD26OCTFUT' }
 */
async function resolveMcxKiteIds(names: string[], today: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (names.length === 0) return result;

  const baseNames = Array.from(new Set(names.map(n => MCX_BASE_MAP[n] || n)));

  try {
    const { data: futs } = await getSupabase()
      .from('instruments')
      .select('tradingsymbol, name, exchange, expiry')
      .eq('exchange', 'MCX')
      .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
      .in('name', baseNames)
      .gte('expiry', today)
      .order('expiry', { ascending: true });

    if (!futs?.length) return result;

    // Group candidates by base name (all expiries)
    const byName = new Map<string, string[]>();
    for (const f of futs) {
      const kiteId = `${f.exchange}:${f.tradingsymbol}`;
      if (!byName.has(f.name)) byName.set(f.name, []);
      byName.get(f.name)!.push(kiteId);
    }

    // For each base name, pick the future with a live Redis price.
    // Fall back to nearest expiry if Redis has no data for any of them.
    const allCandidates = Array.from(byName.values()).flat();

    let redisPrices: Record<string, number> = {};
    if (!isRedisMock() && allCandidates.length > 0) {
      try {
        const redis = getRedisClient();
        const cached = await redis.hmget('market:quotes', ...allCandidates);
        allCandidates.forEach((kiteId, i) => {
          const raw = cached[i];
          if (raw) {
            try {
              const q = JSON.parse(raw as string);
              const lp = q.last_price || 0;
              if (lp > 0) redisPrices[kiteId] = lp;
            } catch { /* ignore */ }
          }
        });
      } catch { /* Redis unavailable */ }
    }

    for (const [baseName, candidates] of byName.entries()) {
      // Prefer the candidate with a live Redis price; fall back to first (nearest expiry)
      const live = candidates.find(k => redisPrices[k] > 0);
      const chosen = live ?? candidates[0];
      // Map back to all original names that resolve to this base
      for (const name of names) {
        if ((MCX_BASE_MAP[name] || name) === baseName) {
          result[name] = chosen;
        }
      }
    }
  } catch { /* fail silently */ }

  return result;
}

function getUnderlyingId(symbol: string): string {
  const parsed = parseOptionSymbol(symbol);
  const u = parsed?.underlying || 'NIFTY';
  if (u === 'BANKNIFTY') return 'NSE:NIFTY BANK';
  if (u === 'FINNIFTY') return 'NSE:NIFTY FIN SERVICE';
  if (u === 'SENSEX') return 'BSE:SENSEX';
  if (u === 'SENSEX50') return 'BSE:SENSEX50';
  if (u === 'BANKEX') return 'BSE:BANKEX';
  if (u === 'MIDCPNIFTY') return 'NSE:NIFTY MID SELECT';
  if (u === 'NIFTYNXT50') return 'NSE:NIFTY NEXT 50';
  if (u === 'NIFTY') return 'NSE:NIFTY 50';
  if (MCX_UNDERLYINGS.has(u)) return `MCX:${u}`; // resolved to actual fut before price lookup
  return `NSE:${u}`;
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// Known underlying symbols for smart parsing
const UNDERLYINGS = ['MIDCPNIFTY', 'BANKNIFTY', 'FINNIFTY', 'NIFTY', 'SENSEX', 'SENSEX50', 'BANKEX', 'NIFTYNXT50', 'CRUDEOILM', 'CRUDEOIL', 'NATGASMINI', 'NATURALGAS', 'SILVERM', 'SILVER', 'GOLDM', 'GOLD'];

const mapSegmentToDbSegment = (s: string): string => {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed === 'NSE - Futures' || trimmed === 'BSE - Futures') return 'INDEX-FUT';
  if (trimmed === 'NSE - Options' || trimmed === 'BSE - Options') return 'INDEX-OPT';
  if (trimmed === 'NSE - Stock Futures' || trimmed === 'BSE - Stock Futures') return 'STOCK-FUT';
  if (trimmed === 'NSE - Stock Options' || trimmed === 'BSE - Stock Options') return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures') return 'MCX-FUT';
  if (trimmed === 'MCX - Options') return 'MCX-OPT';
  if (trimmed === 'NSE - Equity' || trimmed === 'BSE - Equity' || trimmed === 'Equity' || trimmed === 'EQUITY' || trimmed === 'STOCKS' || trimmed === 'Stocks') return 'STOCKS';
  if (trimmed === 'Crypto' || trimmed === 'CRYPTO') return 'CRYPTO';
  if (trimmed === 'Forex' || trimmed === 'FOREX' || trimmed === 'CDS - Futures' || trimmed === 'CDS - Options') return 'FOREX';
  if (trimmed === 'COMEX - Futures' || trimmed === 'COMEX - Options' || trimmed === 'COMEX' || trimmed === 'COI') return 'COMEX';
  if (trimmed === 'US - Equity' || trimmed === 'US-EQ' || trimmed === 'US Equity' || trimmed === 'US') return 'US-EQ';
  return trimmed;
};

/**
 * Try to parse a query like "nifty 24040" or "banknifty 48500 ce"
 * into { underlying, strike, optionType }
 */
function parseOptionQuery(q: string): { underlying: string; strike: number; optionType?: string } | null {
  const upper = q.toUpperCase().replace(/\s+/g, ' ').trim();

  // Smart guesser for pure numeric queries like "23600" or "48500 ce"
  const numOnlyMatch = upper.match(/^(\d+(?:\.\d+)?)\s*(CE|PE)?$/);
  if (numOnlyMatch) {
    const num = parseFloat(numOnlyMatch[1]);
    const optType = numOnlyMatch[2];

    let guessed = '';
    // Nifty is around 21k - 29k
    if (num >= 20000 && num <= 29000) guessed = 'NIFTY';
    // BankNifty is around 40k - 62k
    else if (num >= 40000 && num <= 62000) guessed = 'BANKNIFTY';
    // Sensex is around 70k - 95k
    else if (num >= 70000 && num <= 95000) guessed = 'SENSEX';
    // Midcap Nifty is around 9k - 20k
    else if (num >= 9000 && num <= 19999) guessed = 'MIDCPNIFTY';

    if (guessed) {
      return {
        underlying: guessed,
        strike: num,
        optionType: optType || undefined,
      };
    }
  }

  const underlying = UNDERLYINGS.find(u => upper.startsWith(u));
  if (!underlying) return null;
  const rest = upper.slice(underlying.length).trim();
  if (!rest) return null;
  const match = rest.match(/^(\d+(?:\.\d+)?)\s*(CE|PE)?$/);
  if (!match) return null;
  return {
    underlying,
    strike: parseFloat(match[1]),
    optionType: match[2] || undefined,
  };
}

/**
 * Format YYYY-MM-DD date to DD MMM YYYY (e.g. 26 Jun 2026)
 */
function formatUIExpiry(dateStr: string | null): string {
  if (!dateStr) return '';
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return dateStr;
  
  const [, year, month, day] = match;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = monthNames[parseInt(month, 10) - 1];
  
  return `${parseInt(day, 10)} ${monthName} ${year}`;
}

/**
 * Build a human-readable display name from a Zerodha tradingsymbol.
 * e.g. NIFTY26MAY24050CE  →  NIFTY 24050 CE  (19 May 26)
 *      NIFTY2651924050CE  →  NIFTY 24050 CE  (19 May 26)
 */
function buildDisplayName(tradingsymbol: string, underlying: string, strike: number | null, optionType: string | null, expiry: string | null): string {
  const isRealValue = (v: any) => v !== null && v !== undefined && String(v).toLowerCase() !== 'null' && String(v).trim() !== '';

  let derivedExpiry = isRealValue(expiry) ? expiry : null;
  if (!derivedExpiry && isRealValue(tradingsymbol)) {
    const m = tradingsymbol.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i);
    if (m) {
      const monthNames: Record<string, string> = {
        JAN: 'Jan', FEB: 'Feb', MAR: 'Mar', APR: 'Apr', MAY: 'May', JUN: 'Jun',
        JUL: 'Jul', AUG: 'Aug', SEP: 'Sep', OCT: 'Oct', NOV: 'Nov', DEC: 'Dec',
      };
      derivedExpiry = `${monthNames[m[2].toUpperCase()] || m[2]} 20${m[1]}`;
    }
  }

  const cleanSym = isRealValue(tradingsymbol) ? tradingsymbol : '';
  const safeUnderlying = isRealValue(underlying) && !['SILVER','GOLD','CRUDEOIL','COPPER','NATURALGAS'].includes(underlying.toUpperCase())
    ? underlying
    : (cleanSym || underlying || '');

  if (isRealValue(strike) && isRealValue(optionType)) {
    const expLabel = derivedExpiry ? ` (${derivedExpiry})` : '';
    return `${safeUnderlying} ${strike} ${optionType}${expLabel}`.trim();
  } else if (derivedExpiry) {
    const base = isRealValue(underlying) ? underlying : safeUnderlying;
    return `${base} FUT (${derivedExpiry})`.trim();
  }
  return cleanSym || 'Unknown';
}

/**
 * Fetch live last_price for a list of kite IDs like "NFO:NIFTY26MAY24050CE"
 * Checks local database cache first, and falls back to Kite REST on-demand for missing.
 */
async function fetchLivePrices(
  kiteIds: string[],
  request: NextRequest
): Promise<Record<string, { price: number; high: number; low: number }>> {
  if (kiteIds.length === 0) return {};
  const quoteMap: Record<string, { price: number; high: number; low: number }> = {};
  const foundKiteIds = new Set<string>();

  try {
    // 1. Fetch from Ticker Daemon in-memory quotes API
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);
      const params = new URLSearchParams({ symbols: kiteIds.join(',') });
      if (!tickerUrl) throw new Error('No tickerUrl');
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(50) });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data) {
          for (const [key, val] of Object.entries(json.data)) {
            const v = val as any;
            quoteMap[key] = {
              price: v.last_price ?? 0,
              high: v.ohlc?.high ?? v.high ?? 0,
              low: v.ohlc?.low ?? v.low ?? 0,
            };
            foundKiteIds.add(key);
          }
        }
      }
    } catch (tickerErr) {
      console.warn('[fetchLivePrices] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
    }

    // 2. Identify missing instruments
    const missingKiteIds = kiteIds.filter(id => !foundKiteIds.has(id));

    // 3. Fallback on-demand fetch from Kite REST API for missing instruments
      const apiKey = process.env.KITE_API_KEY;
      let accessToken = request?.cookies?.get?.('kite_access_token')?.value;
      if (!accessToken) {
        const session = await getSharedKiteSession();
        accessToken = session?.accessToken;
      }

      if (apiKey && accessToken) {
        const batchSize = 100;
        const batches: string[][] = [];
        for (let i = 0; i < missingKiteIds.length; i += batchSize) {
          batches.push(missingKiteIds.slice(i, i + batchSize));
        }

      const results = await Promise.all(
        batches.map(async (batch) => {
          const params = new URLSearchParams();
          batch.forEach(id => params.append('i', id));

          try {
            const res = await fetch(`https://api.kite.trade/quote?${params.toString()}`, {
              headers: {
                'X-Kite-Version': '3',
                'Authorization': `token ${apiKey}:${accessToken}`,
              },
              cache: 'no-store',
              signal: AbortSignal.timeout(2000),
            });

            if (res.ok) {
              const json = await res.json();
              return json.data || {};
            }
          } catch (err) {
            console.error('[Search Quotes Fallback] error:', err);
          }
          return {};
        })
      );

      const instrumentUpserts: any[] = [];

      for (const resData of results) {
        for (const [id, quote] of Object.entries(resData)) {
          if (!quote) continue;
          const q = quote as any;
          quoteMap[id] = {
            price: q.last_price ?? 0,
            high: q.ohlc?.high ?? 0,
            low: q.ohlc?.low ?? 0,
          };

          const parts = id.split(':');
          const exchange = parts[0] || 'NSE';
          const tradingsymbol = parts[1] || '';

          instrumentUpserts.push({
            id,
            instrument_token: q.instrument_token || 0,
            tradingsymbol,
            exchange,
            instrument_type: exchange === 'NFO' || exchange === 'MCX' || exchange === 'CDS' ? 'FUTOPT' : 'EQ',
            segment: exchange,
            updated_at: new Date().toISOString()
          });
        }
      }

      // Cache missing instruments in background
      if (instrumentUpserts.length > 0) {
        (async () => {
          try {
            await getSupabase().from('instruments').upsert(instrumentUpserts, { onConflict: 'id' });
          } catch (err) {
            console.error('[fetchLivePrices] Background cache error:', err);
          }
        })();
      }
    }

    // 4. Fetch missing Binance / Forex quotes in parallel
    const usdInrRate = 1;
    await Promise.all(
      missingKiteIds.map(async (id) => {
        const cleanSym = id.split(':').pop() || id;
        if (['GBPUSD', 'EURUSD', 'USDJPY', 'BTCUSDT', 'ETHUSDT', 'DOGEUSDT'].includes(cleanSym) || cleanSym.endsWith('USDT')) {
          try {
            const binanceSym = cleanSym.endsWith('USDT') ? cleanSym : `${cleanSym}USDT`;
            const bRes = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`, { signal: AbortSignal.timeout(800) });
            if (bRes.ok) {
              const bJson = await bRes.json();
              let lastP = parseFloat(bJson.lastPrice || '0');
              let highP = parseFloat(bJson.highPrice || '0');
              let lowP = parseFloat(bJson.lowPrice || '0');

              if (['GBPUSD', 'EURUSD'].includes(cleanSym)) {
                lastP *= usdInrRate;
                highP *= usdInrRate;
                lowP *= usdInrRate;
              } else if (cleanSym === 'USDJPY') {
                lastP = usdInrRate / (lastP || 1);
                highP = usdInrRate / (highP || 1);
                lowP = usdInrRate / (lowP || 1);
              }

              quoteMap[id] = { price: lastP, high: highP, low: lowP };
              quoteMap[cleanSym] = { price: lastP, high: highP, low: lowP };
              quoteMap[binanceSym] = { price: lastP, high: highP, low: lowP };
            }
          } catch {
            // ignore fallback error
          }
        }
      })
    );

    return quoteMap;
  } catch (err) {
    console.error('[fetchLivePrices] Unexpected error:', err);
    return quoteMap;
  }
}

interface SearchCacheEntry {
  results: any[];
  cachedAt: number;
}
const searchCache = new Map<string, SearchCacheEntry>();
const MAX_SEARCH_CACHE_SIZE = 500;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawQ = searchParams.get('q') || '';
    // Normalize: remove multiple spaces, trim
    const q = rawQ.replace(/\s+/g, ' ').trim();
    const tab = searchParams.get('tab') || 'All';

    if (q.length < 1) {
      return NextResponse.json([]);
    }

    const isEquityTab = tab === 'NSE-EQ' || tab === 'Equity' || tab === 'EQUITY' || tab === 'Stocks';
    const authHeader = request.headers.get('Authorization') || 'anon';
    const cacheKey = `${authHeader.slice(-16)}:${tab}:${q.toUpperCase()}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt < 5000)) {
      return NextResponse.json(cached.results);
    }

    let data: any[] | null = null;
    let error: any = null;

    const parsed = parseOptionQuery(q);

    let allowedSymbols: string[] | null = null;
    let userSegSettings: any[] = [];
    const user = await getUserFromRequest(request);
    if (user) {
      const adminClient = getAdminClient();
      const { data: profile } = await adminClient.from('profiles').select('template_id, parent_id, trading_mode').eq('id', user.id).single();
      if (profile) {
        if (profile.template_id) {
          const { data: scripts } = await adminClient.from('template_scripts').select('symbol').eq('template_id', profile.template_id);
          if (scripts && scripts.length > 0) {
            allowedSymbols = scripts.map(s => s.symbol);
          }
        }
        const lookupId = profile.parent_id ?? user.id;
        const targetTable = profile.trading_mode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';
        const { data: segSettings } = await adminClient.from(targetTable)
          .select('segment, side, strike_range')
          .eq('user_id', lookupId);
        if (segSettings) {
          userSegSettings = segSettings;
        }
      }
    }

    const applyTabFilter = (query: any) => {
      if (allowedSymbols) {
        query = query.in('tradingsymbol', allowedSymbols);
      }
      if (tab === 'All') return query;
      if (tab === 'INDEX-FUT') return query.is('option_type', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'STOCK-FUT') return query.is('option_type', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'INDEX-OPT') return query.not('option_type', 'is', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'STOCK-OPT') return query.not('option_type', 'is', null).in('exchange', ['NFO', 'BFO', 'NSE', 'BSE']);
      if (tab === 'MCX-FUT') return query.is('option_type', null).eq('exchange', 'MCX');
      if (tab === 'MCX-OPT') return query.not('option_type', 'is', null).eq('exchange', 'MCX');
      if (tab === 'STOCKS' || tab === 'NSE-EQ' || tab === 'Equity' || tab === 'EQUITY' || tab === 'Stocks') return query.eq('instrument_type', 'EQ').is('option_type', null).in('exchange', ['NSE', 'BSE']);
      if (tab === 'CRYPTO') return query.eq('segment', 'CRYPTO');
      if (tab === 'FOREX') return query.or('exchange.eq.CDS,exchange.eq.FOREX,segment.eq.FOREX');
      if (tab === 'COMEX') return query.eq('segment', 'COMEX');
      if (tab === 'US-EQ' || tab === 'US Equity' || tab === 'US') return query.eq('segment', 'US-EQ');
      return query;
    };

    const today = new Date().toISOString().split('T')[0];

    if (parsed) {
      // Try fetching active expiries directly matching the underlying and strike
      let qry = getSupabase()
        .from('instruments')
        .select('tradingsymbol, name, exchange, instrument_type, segment, strike_price, option_type, expiry, underlying_symbol')
        .eq('strike_price', parsed.strike)
        .gte('expiry', today)
        .neq('exchange', 'NCO')
        .order('expiry', { ascending: true })
        .order('strike_price', { ascending: true })
        .limit(500);

      if (parsed.optionType) qry = qry.eq('option_type', parsed.optionType);

      let q1 = applyTabFilter(qry.eq('name', parsed.underlying));
      ({ data, error } = await q1);

      if (!error && (!data || data.length === 0)) {
        let q2 = applyTabFilter(qry.eq('underlying_symbol', parsed.underlying));
        ({ data, error } = await q2);
      }
    }

    // Fast path: if pure Forex query or Forex tab, skip expensive DB full-table scans
    // In-memory forexSearchItems covers all Forex pairs (CDS currency futures & global pairs) with active contracts instantly (<1ms).
    const qNoSpace = q.replace(/[\s\/]+/g, '').toUpperCase();
    const isForexPairQuery = tab === 'FOREX' || ['USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD', 'FOREX'].some(p => qNoSpace.startsWith(p) || qNoSpace.includes(p));

    if (isForexPairQuery) {
      data = [];
    } else if (!data || data.length === 0) {
      // 1. Dedicated Spot Index Query (NSE/BSE INDEX) to guarantee real spot indices (e.g. NIFTY 50, BANKNIFTY, SENSEX) load at top priority
      let eqPromise = Promise.resolve<{ data: any[] | null; error: any }>({ data: [], error: null });
      if (tab === 'All' || isEquityTab) {
        let eqQry = getSupabase()
          .from('instruments')
          .select('tradingsymbol, name, exchange, instrument_type, segment, strike_price, option_type, expiry, underlying_symbol')
          .in('instrument_type', isEquityTab ? ['EQ', 'INDEX'] : ['INDEX'])
          .in('exchange', ['NSE', 'BSE']);

        if (/^\d+(\.\d+)?$/.test(q)) {
          eqQry = eqQry.or(`tradingsymbol.ilike.%${qNoSpace}%,name.ilike.%${q}%`);
        } else if (qNoSpace.length <= 2) {
          // For 1-2 char queries (e.g. "a", "re"), strictly query ticker prefix matches
          eqQry = eqQry.ilike('tradingsymbol', `${qNoSpace}%`);
        } else {
          eqQry = eqQry.or(`tradingsymbol.ilike.${qNoSpace}%,name.ilike.${q}%,name.ilike.% ${q}%,underlying_symbol.ilike.${qNoSpace}%`);
        }

        eqQry = eqQry.order('tradingsymbol', { ascending: true }).limit(200);
        eqPromise = eqQry as any;
      }

      // 2. Dedicated Futures Query (is('option_type', null)) to guarantee futures (e.g. MCX SILVER/GOLD/CRUDE futures, NSE index/stock futures) are never crowded out by 300+ option strikes
      let futPromise = Promise.resolve<{ data: any[] | null; error: any }>({ data: [], error: null });
      if (tab === 'All' || tab.includes('FUT') || tab === 'MCX' || tab === 'COMEX') {
        let futQry = getSupabase()
          .from('instruments')
          .select('tradingsymbol, name, exchange, instrument_type, segment, strike_price, option_type, expiry, underlying_symbol')
          .neq('exchange', 'NCO')
          .is('option_type', null)
          .not('instrument_type', 'in', '("EQ","INDEX")');

        if (/^\d+(\.\d+)?$/.test(q)) {
          futQry = futQry.or(`tradingsymbol.ilike.%${qNoSpace}%,name.ilike.%${q}%`);
        } else if (qNoSpace.length <= 2) {
          futQry = futQry.or(`tradingsymbol.ilike.${qNoSpace}%,name.ilike.${q}%,name.ilike.% ${q}%,underlying_symbol.ilike.${qNoSpace}%`);
        } else {
          futQry = futQry.or(`tradingsymbol.ilike.${qNoSpace}%,name.ilike.${q}%,name.ilike.% ${q}%,underlying_symbol.ilike.%${qNoSpace}%,tradingsymbol.ilike.%${qNoSpace}%`);
        }

        futQry = futQry.or(`expiry.gte.${today},expiry.is.null`).order('expiry', { ascending: true }).limit(100);
        futPromise = applyTabFilter(futQry) as any;
      }

      // 3. Base Query for non-equity & derivatives
      let buildBaseFallbackQuery = () => {
        let qry = getSupabase()
          .from('instruments')
          .select('tradingsymbol, name, exchange, instrument_type, segment, strike_price, option_type, expiry, underlying_symbol')
          .neq('exchange', 'NCO'); // NCO has sub-interval strike rows that pollute results
          
        let orParts = [];

        if (/^\d+(\.\d+)?$/.test(q)) {
          // Pure numeric query — search exact strike_price, but also allow partial text matches
          orParts.push(`strike_price.eq.${q}`);
          orParts.push(`tradingsymbol.ilike.%${qNoSpace}%`);
          orParts.push(`name.ilike.%${q}%`);
        } else if (qNoSpace.length <= 2) {
          // Short text query (1-2 chars e.g. "A", "AA", "RE")
          // Strict prefix and word-start search like Zerodha/TradingView to prioritize direct equity/symbols
          orParts.push(`tradingsymbol.ilike.${qNoSpace}%`);
          orParts.push(`name.ilike.${q}%`);
          orParts.push(`name.ilike.% ${q}%`);
          orParts.push(`underlying_symbol.ilike.${qNoSpace}%`);
        } else {
          // Text query — search by prefix, word start, and contains
          orParts.push(`tradingsymbol.ilike.${qNoSpace}%`);
          orParts.push(`name.ilike.${q}%`);
          orParts.push(`name.ilike.% ${q}%`);
          orParts.push(`underlying_symbol.ilike.%${qNoSpace}%`);
          orParts.push(`tradingsymbol.ilike.%${qNoSpace}%`);
        }

        qry = qry.or(orParts.join(','));
        // CRITICAL FIX: Only fetch live options to not exhaust the limit on dead contracts
        qry = qry.or(`expiry.gte.${today},expiry.is.null`);

        qry = qry
          .order('expiry', { ascending: true })
          .order('strike_price', { ascending: true })
          .limit(300); // must exceed largest single-expiry row count (GOLD has 348)

        return applyTabFilter(qry);
      };

      const timeoutPromise = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))
        ]);

      const [eqRes, futRes, othRes] = await Promise.all([
        timeoutPromise(eqPromise, 4000, { data: [], error: null }),
        timeoutPromise(futPromise, 4000, { data: [], error: null }),
        timeoutPromise(buildBaseFallbackQuery(), 4000, { data: [], error: null })
      ]);

      error = eqRes.error || futRes.error || othRes.error;
      const rawEq = (eqRes.data ?? []).filter((r: any) => {
        const sym = r.tradingsymbol || '';
        if (/^[0-9]/.test(sym)) return false;
        if (/-N[0-9]|-NC|-Z[0-9]|-SG|-BE|-GB|-GS|-TB|-Y[0-9]/.test(sym)) return false;
        return true;
      });
      const rawFut = futRes.data ?? [];

      data = [...rawEq, ...rawFut, ...(othRes.data ?? [])];
    }

    if (error) {
      console.error('[GET /api/market/instruments/search] Error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    let rows: any[] = data ?? [];

    // Ensure index/stock segregation for generic FUT/OPT types
    const indexNames = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
    if (tab === 'INDEX-FUT' || tab === 'INDEX-OPT') {
      rows = rows.filter(r => indexNames.includes(r.name) || r.instrument_type === 'FUTIDX' || r.instrument_type === 'OPTIDX');
    } else if (tab === 'STOCK-FUT' || tab === 'STOCK-OPT') {
      rows = rows.filter(r => !indexNames.includes(r.name) && r.instrument_type !== 'FUTIDX' && r.instrument_type !== 'OPTIDX');
    }

    // Filter rows to ensure they actually match the search terms in a meaningful way.
    let searchTerms = q.toLowerCase().split(/\s+/);
    if (parsed) {
      const newQ = `${parsed.underlying} ${parsed.strike} ${parsed.optionType || ''}`.toLowerCase().trim();
      searchTerms = newQ.split(/\s+/);
    }

    function wordStartMatch(text: string, term: string): boolean {
      if (!text) return false;
      const t = text.toLowerCase();
      if (t.startsWith(term)) return true;
      const words = t.split(/[\s\-_\/]/);
      return words.some(w => w.startsWith(term));
    }

    rows = rows.filter((r: any) => {
      const dispName = buildDisplayName(
        r.tradingsymbol,
        r.underlying_symbol || r.name || r.tradingsymbol,
        r.strike_price ?? null,
        r.option_type ?? null,
        null
      ).toLowerCase();
      const symbol = (r.tradingsymbol || '').toLowerCase();
      const name = (r.name || '').toLowerCase();

      return searchTerms.every(term => {
        if (/^\d+(\.\d+)?$/.test(term)) {
          if (r.strike_price !== null && String(r.strike_price).startsWith(term)) return true;
          // Allow numeric term to match inside the symbol as well (e.g., '21' in NIFTY21...)
          return symbol.includes(term) || wordStartMatch(dispName, term) || wordStartMatch(name, term);
        }
        return wordStartMatch(dispName, term) || wordStartMatch(name, term) || wordStartMatch(symbol, term);
      });
    });

    // Apply Filter Engine rules server-side before returning results
    const forexRows = rows.filter((r: any) => r.exchange === 'CDS' || r.segment === 'CDS' || r.exchange === 'FOREX' || r.segment === 'FOREX');
    const cryptoRows = rows.filter((r: any) => r.segment === 'CRYPTO');
    const optionRows = rows.filter((r: any) => {
      if (r.exchange === 'CDS' || r.segment === 'CDS' || r.segment === 'CRYPTO') return false;
      const sym = (r.tradingsymbol || '').toUpperCase();
      return r.option_type === 'CE' || r.option_type === 'PE' || r.instrument_type === 'CE' || r.instrument_type === 'PE' || /\d+(CE|PE)$/i.test(sym);
    });
    const otherRows = rows.filter((r: any) => {
      if (r.exchange === 'CDS' || r.segment === 'CDS' || r.segment === 'CRYPTO') return false;
      if (r.exchange === 'COMEX' || r.segment === 'COMEX' || r.instrument_type === 'COMEX') return false; // Handled by static comexSearchItems
      if (r.instrument_type === 'EQ' && !isEquityTab) return false;
      const sym = (r.tradingsymbol || '').toUpperCase();
      if (r.option_type === 'CE' || r.option_type === 'PE') return false;
      if (r.instrument_type === 'CE' || r.instrument_type === 'PE') return false;
      if (/\d+(CE|PE)$/i.test(sym)) return false;
      return true;
    });

    const filteredForex = applyForexFilter(forexRows as Instrument[]);
    const filteredCrypto = applyCryptoWhitelist(cryptoRows as Instrument[]);
    let filteredOptions = optionRows as Instrument[];

    // ── Per-underlying ATM window filter ─────────────────────────────────────
    // Mirrors exactly what the option-chain API does:
    //   1. Pin to nearest active expiry per underlying
    //   2. Find the modal (dominant) strike step to drop sub-interval rows
    //   3. Apply applyStrikeRangeFilter (11-strike ATM window) from filterEngine
    if (filteredOptions.length > 0) {
      try {
        const today2 = new Date().toISOString().split('T')[0];
        const strikeConfig = await loadStrikeConfig(getSupabase());

        // Collect unique underlying names
        const underlyingNames = Array.from(new Set(
          filteredOptions.map((r: any) => (r.name || r.underlying_symbol || '').toUpperCase()).filter(Boolean)
        ));
        const mcxNames = underlyingNames.filter(n => MCX_UNDERLYINGS.has(n));
        const nonMcxNames = underlyingNames.filter(n => !MCX_UNDERLYINGS.has(n));

        // Resolve MCX underlyings → nearest futures kite ID for price lookup
        const mcxKiteIdMap = await resolveMcxKiteIds(mcxNames, today2);

        // Resolve non-MCX underlyings → kite ID
        const nonMcxKiteIds = Array.from(new Set(
          nonMcxNames.map(name => {
            const rep = filteredOptions.find((r: any) => (r.name || r.underlying_symbol || '').toUpperCase() === name);
            return rep ? getUnderlyingId(rep.tradingsymbol) : null;
          }).filter(Boolean) as string[]
        ));

        // ── Price lookup: Redis first (same as option-chain API), then Kite fallback ──
        const allKiteIds = [...nonMcxKiteIds, ...Object.values(mcxKiteIdMap)];
        const priceByName: Record<string, number> = {};

        if (allKiteIds.length > 0) {
          // 1. Try Redis batch lookup — fastest, same source as option chain
          const redisHitIds = new Set<string>();
          if (!isRedisMock()) {
            try {
              const redis = getRedisClient();
              const cached = await redis.hmget('market:quotes', ...allKiteIds);
              allKiteIds.forEach((kiteId, i) => {
                const raw = cached[i];
                if (raw) {
                  try {
                    const q = JSON.parse(raw as string);
                    const lp = q.last_price || q.lastPrice || q.ltp || 0;
                    if (lp > 0) {
                      redisHitIds.add(kiteId);
                      // Map kiteId back to underlying name
                      for (const [name, kid] of Object.entries(mcxKiteIdMap)) {
                        if (kid === kiteId) priceByName[name] = lp;
                      }
                      // Non-MCX: kiteId is directly the underlying kiteId
                      for (const opt of filteredOptions) {
                        const n = (opt.name || opt.underlying_symbol || '').toUpperCase();
                        if (MCX_UNDERLYINGS.has(n)) continue;
                        if (getUnderlyingId((opt as any).tradingsymbol) === kiteId && !priceByName[n]) {
                          priceByName[n] = lp;
                        }
                      }
                    }
                  } catch { /* malformed cache entry */ }
                }
              });
            } catch { /* Redis unavailable */ }
          }

          // 2. Kite REST fallback for anything Redis missed
          const missingIds = allKiteIds.filter(id => !redisHitIds.has(id));
          if (missingIds.length > 0) {
            const kiteIdPriceMap = await fetchKiteQuotes(missingIds);
            for (const [name, kiteId] of Object.entries(mcxKiteIdMap)) {
              if (!priceByName[name] && kiteIdPriceMap[kiteId] > 0) priceByName[name] = kiteIdPriceMap[kiteId];
            }
            for (const opt of filteredOptions) {
              const n = (opt.name || opt.underlying_symbol || '').toUpperCase();
              if (MCX_UNDERLYINGS.has(n)) continue;
              const kiteId = getUnderlyingId((opt as any).tradingsymbol);
              if (!priceByName[n] && kiteIdPriceMap[kiteId] > 0) priceByName[n] = kiteIdPriceMap[kiteId];
            }
          }
        }

        // Group by underlying name.
        // For MCX underlyings, skip non-MCX exchange rows (e.g. NCO has sub-interval strikes).
        const grouped: Record<string, any[]> = {};
        for (const opt of filteredOptions) {
          const n = (opt.name || opt.underlying_symbol || '').toUpperCase();
          if (MCX_UNDERLYINGS.has(n) && (opt as any).exchange !== 'MCX') continue;
          if (!grouped[n]) grouped[n] = [];
          grouped[n].push(opt);
        }

        const kept: any[] = [];
        for (const [name, opts] of Object.entries(grouped)) {
          // Step 1: pin to nearest active expiry for this underlying
          const expiriesForName = Array.from(new Set(
            opts.map(o => (o as any).expiry).filter(Boolean)
          )).sort() as string[];
          const activeForName = applyExpiryFilter(expiriesForName, today2);
          const nearestExpiry = activeForName[0] ?? expiriesForName[0] ?? null;
          const nearestOpts = nearestExpiry
            ? opts.filter(o => (o as any).expiry === nearestExpiry)
            : opts;
          if (nearestOpts.length === 0) continue;

          // Step 2: resolve ATM price (live price preferred, median fallback)
          let ltp = priceByName[name] ?? 0;
          if (ltp <= 0) {
            const strikes = nearestOpts
              .map(o => Number((o as any).strike_price || 0))
              .filter(s => s > 0)
              .sort((a, b) => a - b);
            ltp = strikes.length > 0 ? strikes[Math.floor(strikes.length / 2)] : 0;
          }
          if (ltp <= 0) continue;

          // Step 3: find modal strike step and drop sub-interval rows
          const sortedStrikes = Array.from(new Set(
            nearestOpts.map(o => Number((o as any).strike_price || 0)).filter(s => s > 0)
          )).sort((a, b) => a - b);

          let dominantStep = 0;
          if (sortedStrikes.length > 1) {
            const freq: Record<number, number> = {};
            for (let i = 1; i < sortedStrikes.length; i++) {
              const step = sortedStrikes[i] - sortedStrikes[i - 1];
              freq[step] = (freq[step] || 0) + 1;
            }
            dominantStep = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
          }

          const stepOpts = dominantStep > 0
            ? nearestOpts.filter(o => Number((o as any).strike_price || 0) % dominantStep === 0)
            : nearestOpts;
          const optsToFilter = stepOpts.length > 0 ? stepOpts : nearestOpts;

          // Step 4: Apply 11-strike range filter centered around live spot price ltp
          const centeredOpts = ltp > 0
            ? applyStrikeRangeFilter(optsToFilter as any[], ltp, 11)
            : optsToFilter;
          kept.push(...centeredOpts);
        }

        filteredOptions = kept as Instrument[];
      } catch (e) {
        console.error('[search] strike range filter error:', e);
        // Do NOT fall through to unfiltered options — return empty to avoid bad data
        filteredOptions = [];
      }
    }

    // Check if user explicitly intends to search options (contains digits or CE/PE keywords or tab is OPT)
    const hasOptionIntent = /\b(ce|pe|call|put|opt)\b/i.test(q) || /\d+/.test(q) || tab.includes('OPT');

    // In 'All' tab, if no option intent is present, exclude option contracts to prevent 50+ strike rows from hiding equity stocks
    const activeOptions = (tab === 'All' && !hasOptionIntent) ? [] : filteredOptions;

    // Combine all valid rows
    let validRows = [...otherRows, ...filteredCrypto, ...filteredForex, ...activeOptions];

    // Remove duplicates based on exchange:tradingsymbol
    const uniqueMap = new Map();
    for (const r of validRows) {
      const key = `${r.exchange}:${r.tradingsymbol}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, r);
      }
    }
    validRows = Array.from(uniqueMap.values());

    // Remove future contracts with null expiry if dated versions exist
    const futMap = new Map<string, any[]>();
    for (const r of validRows) {
      if (r.instrument_type?.startsWith('FUT') || ['FUT', 'MAPPED_FUT'].includes(r.instrument_type)) {
        const key = r.name || r.underlying_symbol || r.tradingsymbol;
        if (!futMap.has(key)) futMap.set(key, []);
        futMap.get(key)!.push(r);
      }
    }
    for (const [key, futs] of futMap.entries()) {
      const hasDated = futs.some(f => f.expiry !== null && f.expiry !== undefined);
      if (hasDated) {
        validRows = validRows.filter(r => {
          if ((r.name || r.underlying_symbol || r.tradingsymbol) === key && (r.instrument_type?.startsWith('FUT') || ['FUT', 'MAPPED_FUT'].includes(r.instrument_type))) {
            return r.expiry !== null && r.expiry !== undefined;
          }
          return true;
        });
      }
    }

    // Ranking algorithm
    const qLower = q.toLowerCase();
    
    function scoreInstrument(r: any): number {
      const sym = (r.tradingsymbol || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      const dispName = buildDisplayName(
        r.tradingsymbol,
        r.underlying_symbol || r.name || r.tradingsymbol,
        r.strike_price ?? null,
        r.option_type ?? null,
        null
      ).toLowerCase();

      const isEqOrSpot = r.instrument_type === 'EQ' || r.instrument_type === 'INDEX' || (!r.option_type && !r.expiry);

      // Rank 1: Exact match on TradingSymbol (e.g. RELIANCE, NIFTY 50) or exact name on Stock/Spot Index
      if (sym === qLower || (isEqOrSpot && (name === qLower || dispName === qLower))) return 1;
      
      // Rank 2: Ticker / TradingSymbol prefix match on Stock / Spot Index (e.g. RELIANCE, RELAXO, AARTIIND)
      if (sym.startsWith(qLower)) return isEqOrSpot ? 2 : 3;

      // Rank 4: Name or Display Name prefix match (e.g. RELIGARAMC)
      if (name.startsWith(qLower) || dispName.startsWith(qLower)) return isEqOrSpot ? 4 : 5;
      
      // Rank 6: Word Start match (e.g., "50" in "NIFTY 50")
      if (wordStartMatch(name, qLower) || wordStartMatch(dispName, qLower) || wordStartMatch(sym, qLower)) {
        return isEqOrSpot ? 6 : 7;
      }

      // Rank 8: Substring Contains
      if (sym.includes(qLower) || name.includes(qLower) || dispName.includes(qLower)) return 8;
      
      return 9; // Fallback
    }

    validRows.sort((a: any, b: any) => {
      const scoreA = scoreInstrument(a);
      const scoreB = scoreInstrument(b);
      
      // Sort by score
      if (scoreA !== scoreB) return scoreA - scoreB;
      
      // Tie-breaker 1: Prefer Futures over Options
      const aIsOpt = a.option_type === 'CE' || a.option_type === 'PE';
      const bIsOpt = b.option_type === 'CE' || b.option_type === 'PE';
      if (!aIsOpt && bIsOpt) return -1;
      if (aIsOpt && !bIsOpt) return 1;

      // Tie-breaker 3: Nearest expiry for derivatives
      if (a.expiry && b.expiry && a.expiry !== b.expiry) {
        return a.expiry.localeCompare(b.expiry);
      }
      
      // Tie-breaker 4: Sort options by strike_price ascending
      if (a.strike_price !== undefined && a.strike_price !== null && b.strike_price !== undefined && b.strike_price !== null && a.strike_price !== b.strike_price) {
        return (Number(a.strike_price) || 0) - (Number(b.strike_price) || 0);
      }

      // Tie-breaker 5: Alphabetical by tradingsymbol
      return (a.tradingsymbol || '').localeCompare(b.tradingsymbol || '');
    });

    // Filter out expired contracts by parsing the date from the symbol (e.g. CRUDEOIL26JUNFUT)
    validRows = validRows.filter((r: any) => {
      if (!r.expiry && r.tradingsymbol && r.tradingsymbol.includes('FUT')) {
        const match = r.tradingsymbol.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/);
        if (match) {
          const year = parseInt(match[1], 10) + 2000;
          const monthIndex = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(match[2]);
          
          // Set to the end of the month for a rough expiry check
          const roughExpiry = new Date(year, monthIndex + 1, 0);
          if (roughExpiry < new Date()) {
            return false; // It's expired
          }
        }
      }
      return true;
    });

    // We only need the top 50 matches for the UI to stay performant
    validRows = validRows.slice(0, 50);

    // Fetch live prices for all results
    const kiteIds = validRows.map((inst: any) => `${inst.exchange}:${inst.tradingsymbol}`);
    const quoteMap = await fetchLivePrices(kiteIds, request);

    // Map to watchlist-compatible shape
    let results = validRows.map((inst: any) => {
      let segmentLabel = '';
      const symUpper = (inst.tradingsymbol || '').toUpperCase();
      const nameUpper = (inst.name || '').toUpperCase();
      const rawExch = inst.exchange === 'NFO' ? 'NSE' : inst.exchange === 'BFO' ? 'BSE' : inst.exchange;
      const isMcxCommodity = rawExch === 'MCX' || (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM'].some(c => symUpper.includes(c) || nameUpper.includes(c)) && !['NSE', 'BSE', 'CDS', 'NFO', 'BFO'].includes(rawExch));
      const exch = isMcxCommodity ? 'MCX' : rawExch;
      const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(inst.name);
      const type = inst.instrument_type;

      if (isMcxCommodity) {
        if (type === 'CE' || type === 'PE' || symUpper.endsWith('CE') || symUpper.endsWith('PE')) {
          segmentLabel = 'MCX - Options';
        } else {
          segmentLabel = 'MCX - Futures';
        }
      } else if (type === 'OPTSTK' || (!isIndex && (type === 'CE' || type === 'PE' || type === 'OPT'))) {
        segmentLabel = `${exch} - Stock Options`;
      } else if (type === 'OPTIDX' || (isIndex && (type === 'CE' || type === 'PE' || type === 'OPT'))) {
        segmentLabel = `${exch} - Options`;
      } else if (type === 'FUTSTK' || (!isIndex && ['FUT', 'MAPPED_FUT'].includes(type) && ['NSE', 'BSE'].includes(exch))) {
        segmentLabel = `${exch} - Stock Futures`;
      } else if (['FUT', 'MAPPED_FUT', 'FUTIDX', 'FUTCOM', 'FUTCUR'].includes(type)) {
        segmentLabel = `${exch} - Futures`;
      } else if (type === 'EQ') {
        segmentLabel = `${exch} - Equity`;
      } else {
        // Robust fallback by inspecting the tradingsymbol
        const symUpper = (inst.tradingsymbol || '').toUpperCase();
        if (symUpper.includes('CE') || symUpper.includes('PE') || symUpper.includes('OPT')) {
          if (['NSE', 'BSE'].includes(exch)) segmentLabel = isIndex ? `${exch} - Options` : `${exch} - Stock Options`;
          else segmentLabel = `${exch} - Options`;
        } else if (symUpper.includes('FUT')) {
          if (['NSE', 'BSE'].includes(exch)) segmentLabel = isIndex ? `${exch} - Futures` : `${exch} - Stock Futures`;
          else segmentLabel = `${exch} - Futures`;
        } else {
          segmentLabel = inst.segment || inst.exchange || '';
        }
      }

      const kiteId = `${inst.exchange}:${inst.tradingsymbol}`;
      const displayName = buildDisplayName(
        inst.tradingsymbol,
        inst.underlying_symbol || inst.name || inst.tradingsymbol,
        inst.strike_price ?? null,
        inst.option_type ?? null,
        formatUIExpiry(inst.expiry) || null,
      );

      const isForexPair = ['GBPUSD', 'EURUSD', 'USDJPY'].includes(inst.tradingsymbol);
      const isCryptoPair = inst.segment === 'CRYPTO';
      const binanceSym = isForexPair ? `${inst.tradingsymbol}T` : (isCryptoPair ? `${inst.tradingsymbol}USDT` : undefined);
      const liveQuote = quoteMap[kiteId] || quoteMap[inst.tradingsymbol] || (binanceSym ? quoteMap[binanceSym] : undefined);

      return {
        name: displayName,
        symbol: inst.tradingsymbol,
        kiteSymbol: isForexPair || isCryptoPair ? '' : kiteId,
        binanceSymbol: binanceSym,
        price: liveQuote?.price ?? 0,
        change: '0%',
        segment: segmentLabel,
        contractDate: formatUIExpiry(inst.expiry) || '',
        open: 0,
        high: liveQuote?.high ?? 0,
        low: liveQuote?.low ?? 0,
        close: 0,
      };
    });

    // ── Filter out blocked symbols for this user ──────────────────────────
    // Fetch the user's blocked scripts and remove those instruments from results.
    // This ensures blocked symbols don't appear in watchlist search at all.
    if (user) {
      try {
        const { data: blockedRows } = await getSupabase()
          .from('user_blocked_scripts')
          .select('symbol')
          .eq('user_id', user.id);
        if (blockedRows && blockedRows.length > 0) {
          const blockedSet = new Set(blockedRows.map((r: any) => r.symbol.toUpperCase()));
          results = results.filter(r => {
            const sym = (r.symbol || '').toUpperCase();
            const name = (r.name || '').toUpperCase();
            if (blockedSet.has(sym) || blockedSet.has(name)) return false;
            for (const blocked of blockedSet) {
              if (sym.startsWith(blocked)) return false;
            }
            return true;
          });
        }

        // Also filter out entire segments if they are blocked (trade_allowed = false)
        const [ { data: segRows }, { data: scalperRows } ] = await Promise.all([
          getSupabase().from('segment_settings').select('segment').eq('user_id', user.id).eq('trade_allowed', false),
          getSupabase().from('scalper_segment_settings').select('segment').eq('user_id', user.id).eq('trade_allowed', false)
        ]);

        const blockedSegments = new Set<string>([
          ...(segRows?.map(r => r.segment) || []),
          ...(scalperRows?.map(r => r.segment) || [])
        ]);

        if (blockedSegments.size > 0) {
          results = results.filter(r => !blockedSegments.has(mapSegmentToDbSegment(r.segment)));
        }
      } catch {
        // Non-fatal — if we can't fetch blocked scripts, show all results
      }
    }

    // Append matching COMEX items if tab is All or COMEX
    if (tab === 'All' || tab === 'COMEX') {
      const comexSearchItems = [
        { name: 'GOLD', symbol: 'GC=F', comexSymbol: 'GC=F', segment: 'COMEX - Futures' },
        { name: 'SILVER', symbol: 'SI=F', comexSymbol: 'SI=F', segment: 'COMEX - Futures' },
        { name: 'CRUDEOIL', symbol: 'CL=F', comexSymbol: 'CL=F', segment: 'COMEX - Futures' },
        { name: 'COPPER', symbol: 'HG=F', comexSymbol: 'HG=F', segment: 'COMEX - Futures' },
        { name: 'NATURALGAS', symbol: 'NG=F', comexSymbol: 'NG=F', segment: 'COMEX - Futures' },
      ];
      const comexSearchTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const matchingComex = comexSearchItems
        .filter(item => {
          const itemText = `${item.name} ${item.symbol} ${item.segment} comex`.toLowerCase();
          return comexSearchTerms.every(term => itemText.includes(term));
        })
        .map(item => ({
          name: item.name,
          symbol: item.symbol,
          kiteSymbol: '', // Pure COMEX has no kiteSymbol
          comexSymbol: item.comexSymbol,
          price: 0,
          change: '0%',
          segment: item.segment,
          contractDate: 'Continuous',
          open: 0,
          high: 0,
          low: 0,
          close: 0,
        }));

      results.push(...matchingComex);
    }

    // Append matching FOREX items if tab is All or FOREX
    if (tab === 'All' || tab === 'FOREX') {
      const curMonthYear = `${new Date().toLocaleString('en-US', { month: 'short' })} ${new Date().getFullYear()}`;
      const forexSearchItems = [
        { name: 'EUR/USD', symbol: 'EURUSD', kiteSymbol: '', binanceSymbol: '', comexSymbol: 'EURUSD=X', segment: 'Forex', category: 'FOREX' },
        { name: 'GBP/USD', symbol: 'GBPUSD', kiteSymbol: '', binanceSymbol: '', comexSymbol: 'GBPUSD=X', segment: 'Forex', category: 'FOREX' },
        { name: 'USD/JPY', symbol: 'USDJPY', kiteSymbol: '', binanceSymbol: '', comexSymbol: 'USDJPY=X', segment: 'Forex', category: 'FOREX' },
        { name: 'USD/CHF', symbol: 'USDCHF', kiteSymbol: '', binanceSymbol: '', comexSymbol: 'USDCHF=X', segment: 'Forex', category: 'FOREX' },
        { name: 'USD/CAD', symbol: 'USDCAD', kiteSymbol: '', binanceSymbol: '', comexSymbol: 'USDCAD=X', segment: 'Forex', category: 'FOREX' },
        { name: 'AUD/USD', symbol: 'AUDUSD', kiteSymbol: '', binanceSymbol: '', comexSymbol: 'AUDUSD=X', segment: 'Forex', category: 'FOREX' },
        { name: 'NZD/USD', symbol: 'NZDUSD', kiteSymbol: '', binanceSymbol: '', comexSymbol: 'NZDUSD=X', segment: 'Forex', category: 'FOREX' },
        { name: 'USD/INR', symbol: getCurrentFuturesSymbol('CDS', 'USDINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'USDINR'), comexSymbol: '', segment: 'CDS - Futures', category: 'FOREX' },
        { name: 'EUR/INR', symbol: getCurrentFuturesSymbol('CDS', 'EURINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'EURINR'), comexSymbol: '', segment: 'CDS - Futures', category: 'FOREX' },
        { name: 'GBP/INR', symbol: getCurrentFuturesSymbol('CDS', 'GBPINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'GBPINR'), comexSymbol: '', segment: 'CDS - Futures', category: 'FOREX' },
        { name: 'JPY/INR', symbol: getCurrentFuturesSymbol('CDS', 'JPYINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'JPYINR'), comexSymbol: '', segment: 'CDS - Futures', category: 'FOREX' },
      ];
      const searchTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const qClean = q.replace(/[\s\/]+/g, '').toLowerCase();
      const matchingForex = forexSearchItems
        .filter(item => {
          const itemText = `${item.name} ${item.symbol} ${item.segment} forex`.toLowerCase();
          const cleanText = itemText.replace(/[\s\/]+/g, '');
          return searchTerms.every(term => itemText.includes(term) || cleanText.includes(term.replace(/[\s\/]+/g, '')) || cleanText.includes(qClean));
        })
        .map(item => ({
          name: item.name,
          symbol: item.symbol,
          kiteSymbol: item.kiteSymbol || '',
          binanceSymbol: (item as any).binanceSymbol || '',
          comexSymbol: (item as any).comexSymbol || '',
          price: 0,
          change: '0%',
          segment: item.segment,
          contractDate: item.segment.includes('CDS') ? curMonthYear : 'Continuous',
          open: 0,
          high: 0,
          low: 0,
          close: 0,
        }));

      results.push(...matchingForex);
    }

    // Append matching US Stock items if tab is All, STOCKS, US-EQ, US Equity, or US Stocks
    if (tab === 'All' || tab === 'STOCKS' || tab === 'NSE-EQ' || tab === 'Equity' || tab === 'Stocks' || tab === 'US-EQ' || tab === 'US Equity' || tab === 'US Stocks' || tab === 'US') {
      const searchTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const qClean = q.replace(/[\s\/]+/g, '').toLowerCase();

      const matchingUsStocks = US_STOCK_ITEMS
        .filter(item => {
          const itemText = `${item.name} ${item.symbol} ${item.segment} us stock equity`.toLowerCase();
          const cleanText = itemText.replace(/[\s\/]+/g, '');
          return searchTerms.every(term => itemText.includes(term) || cleanText.includes(term.replace(/[\s\/]+/g, '')) || cleanText.includes(qClean));
        });

      if (matchingUsStocks.length > 0) {
        const usSymbols = matchingUsStocks.map(i => i.symbol);
        const usQuotes = await fetchUSStockQuotes(usSymbols);

        const usResults = matchingUsStocks.map(item => {
          const qInfo = usQuotes[item.symbol];
          const baseP = getUSStockBasePrice(item.symbol);
          const price = qInfo?.price ?? baseP;
          const high = qInfo?.high ?? Number((baseP * 1.01).toFixed(2));
          const low = qInfo?.low ?? Number((baseP * 0.99).toFixed(2));
          const close = qInfo?.prevClose ?? baseP;
          return {
            name: `${item.name} (${item.symbol})`,
            symbol: item.symbol,
            kiteSymbol: `US:${item.symbol}`,
            price,
            change: qInfo?.changePercent ? `${qInfo.changePercent > 0 ? '+' : ''}${qInfo.changePercent.toFixed(2)}%` : '0%',
            segment: item.segment,
            contractDate: 'Continuous',
            open: close,
            high,
            low,
            close,
          };
        });

        results.push(...usResults);
      }
    }

    // Deduplicate results by symbol/name
    const seenSymbols = new Set<string>();
    results = results.filter(r => {
      const key = `${r.name}_${r.symbol}`.toUpperCase();
      if (seenSymbols.has(key)) return false;
      seenSymbols.add(key);
      return true;
    });

    if (tab === 'FOREX') {
      const forexPattern = /(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|INR|FOREX|CDS)/i;
      results = results.filter(item => {
        const text = `${item.name || ''} ${item.symbol || ''} ${item.segment || ''}`.toUpperCase();
        return forexPattern.test(text) && !/GOLD|SILVER|CRUDEOIL|NATURALGAS|COPPER|ZINC|LEAD|ALUMINIUM/i.test(text);
      });
    }

    if (searchCache.size >= MAX_SEARCH_CACHE_SIZE) {
      const firstKey = searchCache.keys().next().value;
      if (firstKey) searchCache.delete(firstKey);
    }
    searchCache.set(cacheKey, { results, cachedAt: Date.now() });

    return NextResponse.json(results);
  } catch (err: any) {
    console.error('[GET /api/market/instruments/search] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
