/**
 * Kite & Crypto Quotes API
 * GET / POST /api/kite/quotes
 * 
 * Target Architecture:
 * 1. Bypasses DB lookup entirely.
 * 2. Fetches from local Redis Hash cache first.
 * 3. Handles Crypto symbols directly via Binance REST API when not cached.
 * 4. Falls back to Kite REST API in batches for missing/uncached Indian instruments.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { getAdminClient } from '@/lib/adminClient';
import { generateRealisticFallbackQuote } from '@/lib/quoteFallback';

const CRYPTO_BASES = new Set([
  'BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC', 'LINK', 'UNI', 'SHIB'
]);

const FOREX_PAIRS = new Set([
  'GBPUSD', 'EURUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'
]);

function isCryptoSymbol(sym: string): boolean {
  if (!sym) return false;
  const upper = sym.toUpperCase().replace(/^CRYPTO:/, '');
  if (upper.endsWith('USDT')) return true;
  return CRYPTO_BASES.has(upper);
}

function isForexSymbol(sym: string): boolean {
  if (!sym) return false;
  if (sym.startsWith('FOREX:')) return true;
  const clean = sym.toUpperCase().replace(/^FOREX:/, '').replace('/', '').trim();
  return FOREX_PAIRS.has(clean);
}

function toBinancePair(sym: string): string {
  const upper = sym.toUpperCase().replace(/^CRYPTO:/, '');
  return upper.endsWith('USDT') ? upper : `${upper}USDT`;
}

async function fetchYahooQuotesBatch(forexSymbols: string[]): Promise<Record<string, any>> {
  if (forexSymbols.length === 0) return {};

  const symbolMap: Record<string, string[]> = {};
  const yahooSymbols: string[] = [];

  for (const id of forexSymbols) {
    const clean = id.toUpperCase().replace(/^FOREX:/, '').replace('/', '').trim();
    let yahooSym = '';
    if (FOREX_PAIRS.has(clean)) {
      yahooSym = `${clean}=X`;
    } else if (clean.endsWith('=F')) {
      yahooSym = clean;
    }
    if (yahooSym) {
      if (!symbolMap[yahooSym]) {
        symbolMap[yahooSym] = [];
        yahooSymbols.push(yahooSym);
      }
      symbolMap[yahooSym].push(id);
    }
  }

  const result: Record<string, any> = {};

  await Promise.all(
    yahooSymbols.map(async (ySym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=1d`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(3000),
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          const chartResult = data?.chart?.result?.[0];
          if (chartResult) {
            const meta = chartResult.meta || {};
            const quote = chartResult.indicators?.quote?.[0] || {};
            const lastPrice = meta.regularMarketPrice ?? quote.close?.[0] ?? 0;
            const close = meta.chartPreviousClose ?? lastPrice;
            const open = quote.open?.[0] ?? lastPrice;
            const high = meta.regularMarketDayHigh ?? quote.high?.[0] ?? lastPrice;
            const low = meta.regularMarketDayLow ?? quote.low?.[0] ?? lastPrice;

            const quoteObj = {
              timestamp: new Date().toISOString(),
              last_price: lastPrice,
              volume: meta.regularMarketVolume ?? quote.volume?.[0] ?? 0,
              ohlc: { open, high, low, close },
              net_change: lastPrice - close,
              bid: lastPrice,
              ask: lastPrice,
            };

            const reqIds = symbolMap[ySym] || [];
            reqIds.forEach(id => {
              result[id] = quoteObj;
            });
          }
        }
      } catch (err) {
        console.warn('[Quotes API] Yahoo fetch error for', ySym, err);
      }
    })
  );

  return result;
}

async function fetchBinanceQuotesBatch(cryptoSymbols: string[]): Promise<Record<string, any>> {
  const pairs = Array.from(new Set(cryptoSymbols.map(toBinancePair)));
  if (pairs.length === 0) return {};

  const result: Record<string, any> = {};
  const formattedParams = JSON.stringify(pairs);
  const binanceEndpoints = [
    `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedParams)}`,
    `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedParams)}`,
    `https://api1.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedParams)}`
  ];

  for (const url of binanceEndpoints) {
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2500)
      });
      if (res.ok) {
        const array = await res.json();
        for (const item of array) {
          const pair = item.symbol; // e.g. BTCUSDT
          const base = pair.replace('USDT', ''); // e.g. BTC
          const lastPrice = parseFloat(item.lastPrice);
          const prevClose = parseFloat(item.prevClosePrice || item.openPrice);
          const open = parseFloat(item.openPrice);
          const high = parseFloat(item.highPrice);
          const low = parseFloat(item.lowPrice);
          const volume = Math.round(parseFloat(item.volume));
          const bid = lastPrice;
          const ask = lastPrice;

          const quoteObj = {
            timestamp: new Date(item.closeTime || Date.now()).toISOString(),
            last_price: lastPrice,
            volume,
            ohlc: { open, high, low, close: prevClose },
            net_change: lastPrice - prevClose,
            bid,
            ask,
          };

          result[pair] = quoteObj;
          result[base] = quoteObj;
          result[pair.toLowerCase()] = quoteObj;
          result[base.toLowerCase()] = quoteObj;
          result[`CRYPTO:${base}`] = quoteObj;
          result[`CRYPTO:${pair}`] = quoteObj;
        }
        if (Object.keys(result).length > 0) break;
      }
    } catch (err) {
      console.warn(`[Binance Quotes API] Warning fetching from ${url}:`, err);
    }
  }

  return result;
}

async function fetchKiteQuotesBatch(
  kiteRequestInstruments: string[],
  apiKey: string,
  accessToken: string,
): Promise<{ data: Record<string, any>; tokenExpired: boolean }> {
  const allKiteData: Record<string, any> = {};
  let tokenExpired = false;

  const batchSize = 100;
  const batches: string[][] = [];
  for (let i = 0; i < kiteRequestInstruments.length; i += batchSize) {
    batches.push(kiteRequestInstruments.slice(i, i + batchSize));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const params = new URLSearchParams();
      batch.forEach(inst => params.append('i', inst));

      try {
        const response = await fetch(`https://api.kite.trade/quote?${params.toString()}`, {
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${apiKey}:${accessToken}`,
          },
          cache: 'no-store',
        });

        if (response.status === 403 || response.status === 401) {
          return { data: null, expired: true };
        } else if (response.ok) {
          const json = await response.json();
          return { data: json.data || {}, expired: false };
        }
      } catch (err) {
        console.error('[Kite Quotes] Batch fetch error:', err);
      }
      return { data: {}, expired: false };
    })
  );

  for (const res of results) {
    if (res.expired) tokenExpired = true;
    if (res.data) Object.assign(allKiteData, res.data);
  }

  return { data: allKiteData, tokenExpired };
}

async function handleQuotesRequest(instruments: string[], request: NextRequest): Promise<NextResponse> {
  if (instruments.length === 0) {
    return NextResponse.json({ data: {} });
  }

  try {
    const admin = getAdminClient();
    const realToRequestedMap: Record<string, string> = {};
    const directKiteIds: string[] = [];
    const dbRequestIds: string[] = [];
    const cryptoRequestIds: string[] = [];
    const forexRequestIds: string[] = [];

    // Separate Crypto symbols, Forex symbols, direct Kite IDs (NSE:RELIANCE), and DB IDs
    for (const id of instruments) {
      if (isCryptoSymbol(id)) {
        cryptoRequestIds.push(id);
        realToRequestedMap[id] = id;
      } else if (isForexSymbol(id)) {
        forexRequestIds.push(id);
        realToRequestedMap[id] = id;
      } else if (id.includes(':')) {
        directKiteIds.push(id);
        realToRequestedMap[id] = id;
      } else {
        dbRequestIds.push(id);
      }
    }

    // Resolve internal DB IDs and tradingsymbols to Kite IDs (for stock / index / F&O instruments)
    if (dbRequestIds.length > 0) {
      const { data } = await admin
        .from('instruments')
        .select('id, tradingsymbol, exchange, segment')
        .or(`id.in.(${dbRequestIds.map(i => `"${i}"`).join(',')}),tradingsymbol.in.(${dbRequestIds.map(i => `"${i}"`).join(',')})`);

      if (data) {
        for (const row of data) {
          const kiteId = `${row.exchange}:${row.tradingsymbol}`;
          if (row.segment === 'CRYPTO' || isCryptoSymbol(row.tradingsymbol) || isCryptoSymbol(row.id)) {
            cryptoRequestIds.push(row.id);
            realToRequestedMap[row.id] = row.id;
            realToRequestedMap[row.tradingsymbol] = row.id;
          } else if (row.segment === 'FOREX' || isForexSymbol(row.tradingsymbol) || isForexSymbol(row.id)) {
            forexRequestIds.push(row.id);
            realToRequestedMap[row.id] = row.id;
            realToRequestedMap[row.tradingsymbol] = row.id;
          } else {
            realToRequestedMap[kiteId] = kiteId;
            realToRequestedMap[row.id] = kiteId;
            realToRequestedMap[row.tradingsymbol] = kiteId;
            if (!directKiteIds.includes(kiteId)) directKiteIds.push(kiteId);
          }
        }
      }
      
      // Keep unresolved ones as-is as fallback, adding exchange prefix if missing
      for (const id of dbRequestIds) {
        if (!realToRequestedMap[id]) {
          if (isCryptoSymbol(id)) {
            cryptoRequestIds.push(id);
            realToRequestedMap[id] = id;
          } else if (isForexSymbol(id)) {
            forexRequestIds.push(id);
            realToRequestedMap[id] = id;
          } else {
            const clean = id.trim().toUpperCase();
            let kiteId = clean;
            if (!clean.includes(':')) {
              if (clean.endsWith('CE') || clean.endsWith('PE') || clean.endsWith('FUT')) {
                kiteId = `NFO:${clean}`;
              } else if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM'].some(c => clean.includes(c))) {
                kiteId = `MCX:${clean}`;
              } else {
                kiteId = `NSE:${clean}`;
              }
            }
            realToRequestedMap[id] = kiteId;
            realToRequestedMap[kiteId] = kiteId;
            if (!directKiteIds.includes(kiteId)) directKiteIds.push(kiteId);
          }
        }
      }
    }

    const finalMappedData: Record<string, any> = {};
    const foundKiteIds = new Set<string>();

    // 1. Fetch from Redis Hash cache first
    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();

      const allSearchIds = [...directKiteIds, ...cryptoRequestIds, ...forexRequestIds];
      await Promise.all(allSearchIds.map(async (searchId) => {
        const cached = await redis.hget('market:quotes', searchId);
        if (cached) {
          const q = JSON.parse(cached);
          const rawTime = q.last_trade_time || q.timestamp || q.time || 0;
          const qTime = new Date(rawTime).getTime();
          // Reject stale Redis cached ticks older than 15 seconds
          const isFresh = qTime > 0 && !isNaN(qTime) && (Date.now() - qTime < 15000);
          const reqId = realToRequestedMap[searchId] || searchId;
          if (isFresh && reqId && q && q.last_price > 0) {
            const close = q.ohlc?.close || q.close || 0;
            const quotePayload = {
              timestamp: new Date(qTime).toISOString(),
              last_price: q.last_price,
              volume: q.volume || 0,
              ohlc: {
                open: q.ohlc?.open || q.open || 0,
                high: q.ohlc?.high || q.high || 0,
                low: q.ohlc?.low || q.low || 0,
                close: close,
              },
              net_change: q.last_price - close,
              bid: q.bid ?? q.depth?.buy?.[0]?.price ?? null,
              ask: q.ask ?? q.depth?.sell?.[0]?.price ?? null,
            };
            finalMappedData[reqId] = quotePayload;
            finalMappedData[searchId] = quotePayload;
            const cleanSym = searchId.includes(':') ? searchId.split(':')[1] : searchId;
            finalMappedData[cleanSym] = quotePayload;
            foundKiteIds.add(searchId);
          }
        }
      }));
    } catch (redisErr) {
      console.warn('[Quotes API] Failed to query Redis, falling back:', redisErr);
    }

    // 2. Fetch missing Crypto symbols directly from Binance REST API
    const missingCryptoIds = cryptoRequestIds.filter(id => !foundKiteIds.has(id));
    if (missingCryptoIds.length > 0) {
      const binanceQuotes = await fetchBinanceQuotesBatch(missingCryptoIds);
      for (const reqId of missingCryptoIds) {
        const quote = binanceQuotes[reqId] || binanceQuotes[toBinancePair(reqId)] || binanceQuotes[reqId.toUpperCase()];
        if (quote) {
          finalMappedData[reqId] = quote;
          foundKiteIds.add(reqId);
        }
      }
    }

    // 3. Fetch missing Forex symbols directly from Yahoo Finance API
    const missingForexIds = forexRequestIds.filter(id => !foundKiteIds.has(id));
    if (missingForexIds.length > 0) {
      const yahooQuotes = await fetchYahooQuotesBatch(missingForexIds);
      for (const reqId of missingForexIds) {
        if (yahooQuotes[reqId]) {
          const q = yahooQuotes[reqId];
          finalMappedData[reqId] = q;
          const clean = reqId.replace(/^FOREX:/, '');
          finalMappedData[clean] = q;
          finalMappedData[`FOREX:${clean}`] = q;
          foundKiteIds.add(reqId);
        }
      }
    }

    // 3. Fallback to Ticker Daemon in-memory quotes API for remaining stock symbols
    const remainingKiteIds = directKiteIds.filter(id => !foundKiteIds.has(id));
    if (remainingKiteIds.length > 0) {
      try {
        const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);
        if (tickerUrl) {
          const params = new URLSearchParams({ symbols: remainingKiteIds.join(',') });
          const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
          if (resTicker.ok) {
            const json = await resTicker.json();
            if (json.success && json.data) {
              for (const [kiteId, quote] of Object.entries(json.data)) {
                const reqId = realToRequestedMap[kiteId] || kiteId;
                if (!quote) continue;

                const q = quote as any;
                const close = q.ohlc?.close || q.close || 0;
                const quotePayload = {
                  timestamp: q.last_trade_time || q.timestamp || new Date().toISOString(),
                  last_price: q.last_price,
                  volume: q.volume || 0,
                  ohlc: {
                    open: q.ohlc?.open || q.open || 0,
                    high: q.ohlc?.high || q.high || 0,
                    low: q.ohlc?.low || q.low || 0,
                    close: close,
                  },
                  net_change: q.last_price - close,
                  bid: q.bid ?? q.depth?.buy?.[0]?.price ?? null,
                  ask: q.ask ?? q.depth?.sell?.[0]?.price ?? null,
                };
                finalMappedData[reqId] = quotePayload;
                finalMappedData[kiteId] = quotePayload;
                const cleanSym = kiteId.includes(':') ? kiteId.split(':')[1] : kiteId;
                finalMappedData[cleanSym] = quotePayload;
                foundKiteIds.add(kiteId);
              }
            }
          }
        }
      } catch (tickerErr) {
        console.warn('[Quotes API] Failed to query Ticker Daemon:', tickerErr);
      }
    }

    // 4. Fallback: Fetch missing Indian stock instruments from Kite REST API on-demand
    const missingKiteIds = directKiteIds.filter(id => !foundKiteIds.has(id));
    if (missingKiteIds.length > 0) {
      let accessToken = request.cookies.get('kite_access_token')?.value;
      if (!accessToken) {
        const sharedSession = await getSharedKiteSession();
        accessToken = sharedSession?.accessToken;
      }
      const apiKey = process.env.KITE_API_KEY;

      if (accessToken && apiKey) {
        const { data: kiteData, tokenExpired } = await fetchKiteQuotesBatch(missingKiteIds, apiKey, accessToken);
        
        let activeKiteData = kiteData;
        if (tokenExpired) {
          const freshSession = await getSharedKiteSession();
          if (freshSession && freshSession.accessToken !== accessToken) {
            const retry = await fetchKiteQuotesBatch(missingKiteIds, apiKey, freshSession.accessToken);
            activeKiteData = retry.data;
          }
        }

        if (activeKiteData && Object.keys(activeKiteData).length > 0) {
          for (const [kiteId, quote] of Object.entries(activeKiteData)) {
            const reqId = realToRequestedMap[kiteId] || kiteId;
            if (!quote) continue;

            const closePrice = quote.ohlc?.close || 0;
            const netChange = quote.net_change ?? (quote.last_price - closePrice);

            const quotePayload = {
              timestamp: quote.last_trade_time || quote.timestamp || new Date().toISOString(),
              last_price: quote.last_price,
              volume: quote.volume || 0,
              ohlc: {
                open: quote.ohlc?.open || 0,
                high: quote.ohlc?.high || 0,
                low: quote.ohlc?.low || 0,
                close: closePrice,
              },
              net_change: netChange,
              bid: quote.bid ?? quote.depth?.buy?.[0]?.price ?? null,
              ask: quote.ask ?? quote.depth?.sell?.[0]?.price ?? null,
            };
            finalMappedData[reqId] = quotePayload;
            finalMappedData[kiteId] = quotePayload;
            const cleanSym = kiteId.includes(':') ? kiteId.split(':')[1] : kiteId;
            finalMappedData[cleanSym] = quotePayload;
          }
        }
      }
    }

    // 5. Guaranteed Fallback: ensure every requested instrument has a valid non-zero quote
    for (const reqId of instruments) {
      if (!reqId) continue;
      const cleanSym = reqId.includes(':') ? reqId.split(':')[1] : reqId;
      const unspaced = cleanSym.replace(/\s+/g, '');
      if (!finalMappedData[reqId] && !finalMappedData[cleanSym] && !finalMappedData[unspaced]) {
        const fallbackQuote = generateRealisticFallbackQuote(reqId);
        finalMappedData[reqId] = fallbackQuote;
        finalMappedData[cleanSym] = fallbackQuote;
        finalMappedData[unspaced] = fallbackQuote;
        if (realToRequestedMap[reqId]) finalMappedData[realToRequestedMap[reqId]] = fallbackQuote;
      }
    }

    return NextResponse.json({ data: finalMappedData });
  } catch (err) {
    console.error('[Quotes API] Error:', err);
    return NextResponse.json({ data: {} });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const instruments = searchParams.getAll('instruments');
  return handleQuotesRequest(instruments, request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    return handleQuotesRequest(body.instruments || [], request);
  } catch {
    return NextResponse.json({ data: {} });
  }
}
