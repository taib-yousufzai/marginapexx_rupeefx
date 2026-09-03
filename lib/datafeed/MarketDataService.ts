import { getAdminClient } from '@/lib/adminClient';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { telemetry } from '@/lib/metrics';
import pino from 'pino';

const logger = pino({ name: 'market-data-service' });

export async function fetchWithTimeout(url: string, options: any = {}, timeoutMs = 250): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Simple inflight cache for Binance requests to avoid duplicate concurrent calls for the same symbol
const binanceInflight = new Map<string, Promise<{ltp: number, bid: number, ask: number} | null>>();

export async function fetchBinanceQuote(symbol: string): Promise<{ltp: number, bid: number, ask: number} | null> {
  let cleanSym = symbol.replace('/', '').toUpperCase();
  if (!cleanSym.endsWith('USDT')) cleanSym = cleanSym + 'USDT';

  let promise = binanceInflight.get(cleanSym);
  if (!promise) {
    promise = (async () => {
      try {
        // 1. Redis cache (Ticker Daemon writes Binance prices here too)
        try {
          const { getRedisClient } = await import('@/lib/redis');
          const redis = getRedisClient();
          const cached = await Promise.race([
            redis.hget('market:quotes', cleanSym),
            new Promise(r => setTimeout(() => r(null), 300))
          ]) as string | null;
          if (cached) {
            const q = JSON.parse(cached);
            if (q && q.last_price !== undefined) {
              return {
                ltp: Number(q.last_price),
                bid: Number(q.bid || q.last_price),
                ask: Number(q.ask || q.last_price)
              };
            }
          }
        } catch { /* fall through */ }

        // 2. Ticker Daemon in-memory endpoint
        try {
          const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
          const params = new URLSearchParams({ symbols: cleanSym });
          const resTicker = await fetchWithTimeout(`${tickerUrl}/quotes?${params}`, { cache: 'no-store' }, 150);
          if (resTicker.ok) {
            const json = await resTicker.json();
            if (json.success && json.data && json.data[cleanSym]) {
              const q = json.data[cleanSym];
              return {
                ltp: Number(q.last_price),
                bid: Number(q.bid || q.last_price),
                ask: Number(q.ask || q.last_price)
              };
            }
          }
        } catch { /* fall through */ }

        // 3. Direct Binance REST fallback
        try {
          const res = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${cleanSym}`, { cache: 'no-store' }, 250);
          if (!res.ok) return null;
          const data = await res.json();
          if (data.price) {
            const ltp = parseFloat(data.price);
            return { ltp, bid: ltp, ask: ltp };
          }
          return null;
        } catch (err) {
          console.error('[fetchBinanceQuote] Error:', err);
          return null;
        }
      } finally {
        binanceInflight.delete(cleanSym);
      }
    })();
    binanceInflight.set(cleanSym, promise);
  }
  return promise;
}

// Raw fetch function for Kite quotes
async function executeRawKiteQuotes(instruments: string[]): Promise<Record<string, number>> {
  if (instruments.length === 0) return {};
  const result: Record<string, number> = {};
  const foundKiteIds = new Set<string>();

  try {
    const admin = getAdminClient();

    // 1. Fetch from Redis Hash cache — use HMGET for a single round-trip
    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      const cachedValues = await redis.hmget('market:quotes', ...instruments);
      instruments.forEach((inst, idx) => {
        const raw = cachedValues[idx];
        if (raw) {
          try {
            const q = JSON.parse(raw);
            if (q && q.last_price !== undefined) {
              const quoteTime = q.timestamp ? new Date(q.timestamp).getTime() : 0;
              const ageMs = Date.now() - quoteTime;
              if (quoteTime > 0 && ageMs > 15000) {
                // Stale quote, skip
                return;
              }
              result[inst] = q.last_price;
              result[`${inst}_bid`] = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? q.last_price);
              result[`${inst}_ask`] = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? q.last_price);
              result[`${inst}_depth_buy`] = q.depth?.buy || [];
              result[`${inst}_depth_sell`] = q.depth?.sell || [];
              foundKiteIds.add(inst);
            }
          } catch { /* malformed cache entry — fall through */ }
        }
      });
    } catch (redisErr) {
      console.warn('[fetchKiteQuotes] Failed to query Redis, falling back:', redisErr);
    }

    // 2. Fetch available quotes from Ticker Daemon for remaining instruments
    const remainingKiteIds = instruments.filter(id => !foundKiteIds.has(id));
    if (remainingKiteIds.length > 0) {
      try {
        const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
        const params = new URLSearchParams({ symbols: remainingKiteIds.join(',') });
        const resTicker = await fetchWithTimeout(`${tickerUrl}/quotes?${params}`, { cache: 'no-store' }, 150);
        if (resTicker.ok) {
          const json = await resTicker.json();
          if (json.success && json.data) {
            for (const [key, val] of Object.entries(json.data)) {
              const q = val as any;
              result[key] = q.last_price;
              result[`${key}_bid`] = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? q.last_price);
              result[`${key}_ask`] = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? q.last_price);
              result[`${key}_depth_buy`] = q.depth?.buy || [];
              result[`${key}_depth_sell`] = q.depth?.sell || [];
              foundKiteIds.add(key);
            }
          }
        }
      } catch (tickerErr) {
        console.warn('[fetchKiteQuotes] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
      }
    }

    // 3. Identify missing instruments
    const missingKiteIds = instruments.filter(id => !foundKiteIds.has(id));

    // 3. Fallback on-demand fetch from Kite REST API for missing instruments only
    if (missingKiteIds.length > 0) {
      const apiKey = process.env.KITE_API_KEY;
      if (!apiKey) return result;
      const session = await getSharedKiteSession();
      if (!session) return result;

      const params = new URLSearchParams();
      missingKiteIds.forEach(i => params.append('i', i));

      const res = await fetchWithTimeout(`https://api.kite.trade/quote?${params}`, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${session.accessToken}`,
        },
        cache: 'no-store'
      }, 250);

      if (!res || !res.ok) return result;

      const data = await res.json() as { data?: Record<string, { last_price: number; instrument_token?: number; ohlc?: { close?: number }, depth?: { buy?: { price: number }[], sell?: { price: number }[] } }> };
      const instrumentUpserts: any[] = [];

      for (const inst of missingKiteIds) {
        const quote = (data.data as any)?.[inst];
        if (quote) {
          result[inst] = quote.last_price;
          result[`${inst}_bid`] = Number(quote.depth?.buy?.[0]?.price ?? quote.last_price);
          result[`${inst}_ask`] = Number(quote.depth?.sell?.[0]?.price ?? quote.last_price);
          result[`${inst}_depth_buy`] = quote.depth?.buy || [];
          result[`${inst}_depth_sell`] = quote.depth?.sell || [];

          const parts = inst.split(':');
          const exchange = parts[0] || 'NSE';
          const tradingsymbol = parts[1] || '';

          instrumentUpserts.push({
            id: inst,
            instrument_token: quote.instrument_token || 0,
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
            await admin.from('instruments').upsert(instrumentUpserts, { onConflict: 'id' });
          } catch (err) {
            console.error('[fetchKiteQuotes] Background cache error:', err);
          }
        })();
      }
    }

    return result;
  } catch (err) {
    console.error('[fetchKiteQuotes] Error:', err);
    return result;
  }
}

// Coalescing state for Kite quotes
let pendingKiteSymbols = new Set<string>();
let pendingKiteResolvers: Array<(quotes: Record<string, number>) => void> = [];
let batchTimeout: NodeJS.Timeout | null = null;

async function processKiteBatch() {
  const symbols = Array.from(pendingKiteSymbols);
  const resolvers = pendingKiteResolvers;
  
  // Clear batch queue
  pendingKiteSymbols = new Set();
  pendingKiteResolvers = [];
  batchTimeout = null;

  if (symbols.length === 0) return;

  try {
    const batchQuotes = await executeRawKiteQuotes(symbols);
    for (const resolve of resolvers) {
      resolve(batchQuotes);
    }
  } catch (err) {
    console.error('[MarketDataService] Batch process failed:', err);
    for (const resolve of resolvers) {
      resolve({});
    }
  }
}

export function fetchKiteQuotes(instruments: string[]): Promise<Record<string, number>> {
  if (instruments.length === 0) return Promise.resolve({});

  return new Promise((resolve) => {
    instruments.forEach(inst => pendingKiteSymbols.add(inst));
    pendingKiteResolvers.push((batchQuotes) => {
      const subset: Record<string, number> = {};
      instruments.forEach(inst => {
        if (batchQuotes[inst] !== undefined) {
          subset[inst] = batchQuotes[inst];
          subset[`${inst}_bid`] = batchQuotes[`${inst}_bid`];
          subset[`${inst}_ask`] = batchQuotes[`${inst}_ask`];
          subset[`${inst}_depth_buy`] = batchQuotes[`${inst}_depth_buy`];
          subset[`${inst}_depth_sell`] = batchQuotes[`${inst}_depth_sell`];
        }
      });
      resolve(subset);
    });

    if (!batchTimeout) {
      batchTimeout = setTimeout(processKiteBatch, 10); // 10ms coalescing window
    }
  });
}

export async function fetchSpeedQuotes(
  instruments: string[]
): Promise<Record<string, any>> {
  const start = performance.now();
  const result: Record<string, any> = {};
  if (instruments.length === 0) return result;

  const MAX_QUOTE_AGE_MS = 15000; // 15 seconds max age
  let redisHits = 0;
  let daemonHits = 0;
  let isRedisErr = false;
  let isDaemonErr = false;

  try {
    const { getRedisClient } = require('@/lib/redis');
    const redis = getRedisClient();
    const foundKiteIds = new Set<string>();

    // 1. Fetch from Redis cache hash
    try {
      const cachedValues = await redis.hmget('market:quotes', ...instruments);
      instruments.forEach((inst, idx) => {
        const raw = cachedValues[idx];
        if (raw) {
          try {
            const q = JSON.parse(raw);
            if (q && q.last_price !== undefined) {
              const quoteTime = q.timestamp ? new Date(q.timestamp).getTime() : 0;
              const ageMs = Date.now() - quoteTime;
              
              if (quoteTime > 0 && ageMs > MAX_QUOTE_AGE_MS) {
                logger.warn({ symbol: inst, source: 'quotes', reason: 'stale_quote', ageMs });
                return; // Stale, skip
              }

              result[inst] = q.last_price;
              result[`${inst}_bid`] = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? q.last_price);
              result[`${inst}_ask`] = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? q.last_price);
              result[`${inst}_depth_buy`] = q.depth?.buy || [];
              result[`${inst}_depth_sell`] = q.depth?.sell || [];
              foundKiteIds.add(inst);
              redisHits++;
            }
          } catch {}
        }
      });
    } catch (redisErr) {
      isRedisErr = true;
      logger.warn({ source: 'quotes', reason: 'redis_unavailable', error: redisErr instanceof Error ? redisErr.message : String(redisErr) });
    }

    // 2. Fetch from Ticker Daemon
    const remainingKiteIds = instruments.filter(id => !foundKiteIds.has(id));
    if (remainingKiteIds.length > 0) {
      try {
        const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
        const params = new URLSearchParams({ symbols: remainingKiteIds.join(',') });
        const resTicker = await fetchWithTimeout(`${tickerUrl}/quotes?${params}`, { cache: 'no-store' }, 150);
        if (resTicker.ok) {
          const json = await resTicker.json();
          if (json.success && json.data) {
            for (const [key, val] of Object.entries(json.data)) {
              const q = val as any;
              const quoteTime = q.timestamp ? new Date(q.timestamp).getTime() : 0;
              const ageMs = Date.now() - quoteTime;

              if (quoteTime > 0 && ageMs > MAX_QUOTE_AGE_MS) {
                logger.warn({ symbol: key, source: 'quotes', reason: 'stale_quote', ageMs });
                continue; // Stale, skip
              }

              result[key] = q.last_price;
              result[`${key}_bid`] = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? q.last_price);
              result[`${key}_ask`] = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? q.last_price);
              result[`${key}_depth_buy`] = q.depth?.buy || [];
              result[`${key}_depth_sell`] = q.depth?.sell || [];
              foundKiteIds.add(key);
              daemonHits++;
            }
          }
        }
      } catch (tickerErr) {
        isDaemonErr = true;
        logger.warn({ source: 'quotes', reason: 'daemon_timeout', error: tickerErr instanceof Error ? tickerErr.message : String(tickerErr) });
      }
    }

    // 3. Telemetry and structured logging on misses
    const misses = instruments.length - (redisHits + daemonHits);
    if (misses > 0) {
      instruments.forEach(inst => {
        if (!foundKiteIds.has(inst)) {
          logger.warn({ symbol: inst, source: 'quotes', reason: 'cache_miss', redis_error: isRedisErr, daemon_error: isDaemonErr });
        }
      });
    }

    const latencyMs = performance.now() - start;
    telemetry.recordQuoteLookup(redisHits, daemonHits, misses, latencyMs);
    return result;
  } catch (err) {
    logger.error({ source: 'quotes', reason: 'lookup_error', error: err instanceof Error ? err.message : String(err) });
    const latencyMs = performance.now() - start;
    telemetry.recordQuoteLookup(0, 0, instruments.length, latencyMs);
    return result;
  }
}
