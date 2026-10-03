import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient } from '@/lib/redis';
import { getCurrentFuturesSymbol } from '@/lib/contractExpiry';
import { getSharedKiteSession } from '@/lib/kiteSession';

export const dynamic = 'force-dynamic';

const OVERVIEW_SYMBOLS = [
  'NSE:NIFTY 50',
  'BSE:SENSEX',
  'NSE:NIFTY BANK',
  'CDS:USDINR',
  'MCX:CRUDEOIL',
  'MCX:GOLD',
  'MCX:SILVER',
  'MCX:NATURALGAS',
];

const FALLBACK_PRICES: Record<string, { last_price: number; close: number }> = {
  'NSE:NIFTY 50': { last_price: 22421.95, close: 22620.45 },
  'BSE:SENSEX': { last_price: 73800.00, close: 74100.00 },
  'NSE:NIFTY BANK': { last_price: 48200.00, close: 48350.00 },
  'CDS:USDINR': { last_price: 83.95, close: 83.92 },
  'MCX:CRUDEOIL': { last_price: 5740.00, close: 5710.00 },
  'MCX:GOLD': { last_price: 73450.00, close: 73200.00 },
  'MCX:SILVER': { last_price: 85200.00, close: 84900.00 },
  'MCX:NATURALGAS': { last_price: 198.50, close: 196.20 },
};

let cachedOverview: { data: any; ts: number } | null = null;
const OVERVIEW_CACHE_TTL_MS = 1500;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const now = Date.now();
  if (cachedOverview && now - cachedOverview.ts < OVERVIEW_CACHE_TTL_MS) {
    return NextResponse.json(cachedOverview.data);
  }

  const quotesMap: Record<string, any> = {};

  // Resolve dynamic current futures symbols for commodities & currency
  const resolvedSymbols = [
    'NSE:NIFTY 50',
    'BSE:SENSEX',
    'NSE:NIFTY BANK',
    getCurrentFuturesSymbol('CDS', 'USDINR'),
    getCurrentFuturesSymbol('MCX', 'CRUDEOIL'),
    getCurrentFuturesSymbol('MCX', 'GOLD'),
    getCurrentFuturesSymbol('MCX', 'SILVER'),
    getCurrentFuturesSymbol('MCX', 'NATURALGAS'),
  ];

  try {
    const redis = getRedisClient();

    // Fetch quotes from Redis Hash `market:quotes` in parallel
    const redisResults = await Promise.all(
      resolvedSymbols.map(async (sym) => {
        try {
          const raw = await redis.hget('market:quotes', sym);
          if (raw) {
            return { sym, data: JSON.parse(raw) };
          }
          // Also try base symbol (e.g. GOLD, CRUDEOIL)
          const baseName = sym.includes(':') ? sym.split(':')[1] : sym;
          const rawBase = await redis.hget('market:quotes', baseName);
          if (rawBase) {
            return { sym, data: JSON.parse(rawBase) };
          }
        } catch {}
        return { sym, data: null };
      })
    );

    const missingSymbols: string[] = [];

    function isQuoteRealistic(sym: string, price: number): boolean {
      if (!price || isNaN(price) || price <= 0) return false;
      const upper = sym.toUpperCase();
      if (price === 1000) {
        if (upper.includes('NIFTY') || upper.includes('SENSEX') || upper.includes('BANK') ||
            upper.includes('GOLD') || upper.includes('SILVER') || upper.includes('CRUDE') ||
            upper.includes('USDINR') || upper.includes('NATURALGAS') || upper.includes('NATGAS')) {
          return false;
        }
      }
      if (upper.includes('GOLD')) return price >= 20000 && price <= 200000;
      if (upper.includes('SILVER')) return price >= 20000 && price <= 200000;
      if (upper.includes('CRUDE')) return price >= 2000 && price <= 20000;
      if (upper.includes('NATURALGAS') || upper.includes('NATGAS')) return price >= 50 && price <= 2000;
      if (upper.includes('USDINR')) return price >= 50 && price <= 150;
      if (upper.includes('SENSEX')) return price >= 30000;
      if (upper.includes('BANKNIFTY') || upper.includes('NIFTY BANK')) return price >= 20000;
      if (upper.includes('NIFTY')) return price >= 10000;
      return true;
    }

    for (const item of redisResults) {
      const lp = Number(item.data?.last_price || item.data?.lastPrice || 0);
      if (item.data && isQuoteRealistic(item.sym, lp)) {
        const close = Number(item.data.ohlc?.close || item.data.close || item.data.prevClose || lp);
        const quoteObj = {
          timestamp: new Date().toISOString(),
          last_price: lp,
          volume: item.data.volume || 1000,
          ohlc: {
            open: Number(item.data.ohlc?.open || item.data.open || lp),
            high: Number(item.data.ohlc?.high || item.data.high || lp),
            low: Number(item.data.ohlc?.low || item.data.low || lp),
            close: close,
          },
          net_change: lp - close,
          bid: Number(item.data.bid || lp),
          ask: Number(item.data.ask || lp),
        };

        quotesMap[item.sym] = quoteObj;
        const cleanName = item.sym.includes(':') ? item.sym.split(':')[1] : item.sym;
        quotesMap[cleanName] = quoteObj;
      } else {
        // If Redis had corrupted/stale 1000 data, actively purge it from Redis
        if (item.data && lp > 0) {
          redis.hdel('market:quotes', item.sym).catch(() => {});
          const cleanName = item.sym.includes(':') ? item.sym.split(':')[1] : item.sym;
          redis.hdel('market:quotes', cleanName).catch(() => {});
        }
        missingSymbols.push(item.sym);
      }
    }

    // If any symbols are missing from Redis, fetch them from fallback / Kite REST API and populate Redis
    if (missingSymbols.length > 0) {
      try {
        const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
        const params = new URLSearchParams({ symbols: missingSymbols.join(',') });
        const res = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (res?.ok) {
          const json = await res.json();
          if (json.success && json.data) {
            for (const [sym, q] of Object.entries(json.data)) {
              if (q && (q as any).last_price > 0) {
                const tick = q as any;
                quotesMap[sym] = tick;
                const cleanName = sym.includes(':') ? sym.split(':')[1] : sym;
                quotesMap[cleanName] = tick;
                // Store in Redis so subsequent requests are instant
                redis.hset('market:quotes', sym, JSON.stringify(tick)).catch(() => {});
              }
            }
          }
        }
      } catch (err) {
        console.warn('[MarketOverview API] Ticker daemon query warning:', err);
      }

      // If still missing, query Kite REST API directly
      const stillMissing = missingSymbols.filter(sym => !quotesMap[sym]);
      if (stillMissing.length > 0) {
        try {
          const sharedSession = await getSharedKiteSession();
          const apiKey = process.env.KITE_API_KEY;
          if (sharedSession?.accessToken && apiKey) {
            const params = new URLSearchParams();
            stillMissing.forEach(s => params.append('i', s));
            const kiteRes = await fetch(`https://api.kite.trade/quote?${params.toString()}`, {
              headers: {
                'X-Kite-Version': '3',
                'Authorization': `token ${apiKey}:${sharedSession.accessToken}`,
              },
              cache: 'no-store',
              signal: AbortSignal.timeout(2000),
            });
            if (kiteRes.ok) {
              const kiteJson = await kiteRes.json();
              if (kiteJson?.data) {
                for (const [sym, q] of Object.entries(kiteJson.data as Record<string, any>)) {
                  if (q && q.last_price > 0) {
                    const close = q.ohlc?.close || q.close || q.last_price;
                    const quoteObj = {
                      timestamp: q.last_trade_time || q.timestamp || new Date().toISOString(),
                      last_price: q.last_price,
                      volume: q.volume || 0,
                      ohlc: {
                        open: q.ohlc?.open || q.open || q.last_price,
                        high: q.ohlc?.high || q.high || q.last_price,
                        low: q.ohlc?.low || q.low || q.last_price,
                        close,
                      },
                      net_change: q.last_price - close,
                      bid: q.bid ?? q.depth?.buy?.[0]?.price ?? q.last_price,
                      ask: q.ask ?? q.depth?.sell?.[0]?.price ?? q.last_price,
                    };
                    quotesMap[sym] = quoteObj;
                    const cleanName = sym.includes(':') ? sym.split(':')[1] : sym;
                    quotesMap[cleanName] = quoteObj;
                    redis.hset('market:quotes', sym, JSON.stringify(q)).catch(() => {});
                    redis.hset('market:quotes', cleanName, JSON.stringify(q)).catch(() => {});
                  }
                }
              }
            }
          }
        } catch (kiteErr) {
          console.warn('[MarketOverview API] Kite REST query warning:', kiteErr);
        }
      }

      // Final safety guard: ensure every symbol has a non-zero quote from known realistic baselines
      for (const sym of missingSymbols) {
        if (!quotesMap[sym]) {
          const upper = sym.toUpperCase();
          let fb = FALLBACK_PRICES[sym];
          if (!fb) {
            if (upper.includes('CRUDE')) fb = FALLBACK_PRICES['MCX:CRUDEOIL'];
            else if (upper.includes('GOLD')) fb = FALLBACK_PRICES['MCX:GOLD'];
            else if (upper.includes('SILVER')) fb = FALLBACK_PRICES['MCX:SILVER'];
            else if (upper.includes('NATURALGAS') || upper.includes('NATGAS')) fb = FALLBACK_PRICES['MCX:NATURALGAS'];
            else if (upper.includes('USDINR')) fb = FALLBACK_PRICES['CDS:USDINR'];
            else if (upper.includes('BANKNIFTY') || upper.includes('NIFTY BANK')) fb = FALLBACK_PRICES['NSE:NIFTY BANK'];
            else if (upper.includes('SENSEX')) fb = FALLBACK_PRICES['BSE:SENSEX'];
            else if (upper.includes('NIFTY')) fb = FALLBACK_PRICES['NSE:NIFTY 50'];
          }

          if (fb && fb.last_price > 0) {
            const baseName = sym.includes(':') ? sym.split(':')[1] : sym;
            const quoteObj = {
              timestamp: new Date().toISOString(),
              last_price: fb.last_price,
              volume: 1000,
              ohlc: { open: fb.close, high: fb.last_price, low: fb.close, close: fb.close },
              net_change: fb.last_price - fb.close,
              bid: fb.last_price,
              ask: fb.last_price,
            };
            quotesMap[sym] = quoteObj;
            quotesMap[baseName] = quoteObj;
          }
        }
      }
    }

    const responseData = { quotes: quotesMap };
    if (Object.keys(quotesMap).length > 0) {
      cachedOverview = { data: responseData, ts: Date.now() };
    }
    return NextResponse.json(responseData);
  } catch (err: any) {
    console.error('[MarketOverview API] Error:', err);
    return NextResponse.json({ quotes: quotesMap });
  }
}
