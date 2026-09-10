/**
 * GET /api/market/comex?symbols=GC=F,SI=F,HG=F,CL=F
 *
 * Server-side proxy that fetches commodity prices from Yahoo Finance.
 * Running server-side avoids CORS issues and requires no API key.
 *
 * Supported Yahoo Finance symbols:
 *   GC=F  → Gold COMEX Futures
 *   SI=F  → Silver COMEX Futures
 *   HG=F  → Copper COMEX Futures
 *   CL=F  → WTI Crude Oil Futures
 *   NG=F  → Natural Gas Futures
 *   PL=F  → Platinum Futures
 *   PA=F  → Palladium Futures
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface YahooQuote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  currency?: string;
  shortName?: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols') ?? 'GC=F,SI=F,HG=F,CL=F';
  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  try {
    const quotes: Record<string, {
      symbol: string;
      contractSymbol: string;
      lastPrice: number;
      change: number;
      changePercent: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      currency: string;
      name: string;
    }> = {};

    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json',
              'Cookie': '',
            },
            cache: 'no-store',
          });

          if (!res.ok) {
            console.warn(`[/api/market/comex] Failed to fetch ${symbol}: status ${res.status}`);
            return;
          }

          const data = await res.json();
          const result = data?.chart?.result?.[0];
          if (!result) return;

          const meta = result.meta || {};
          const quote = result.indicators?.quote?.[0] || {};
          
          const lastPrice = meta.regularMarketPrice ?? quote.close?.[0] ?? 0;
          const close = meta.chartPreviousClose ?? 0;
          const change = lastPrice - close;
          const changePercent = close !== 0 ? (change / close) * 100 : 0;

          // meta.shortName gives the friendly contract name (e.g. "Gold Aug 26").
          // meta.symbol is just the generic ticker (GC=F), not the front-month contract code.
          quotes[symbol] = {
            symbol,
            contractSymbol: meta.shortName ?? symbol,
            lastPrice,
            change,
            changePercent,
            open:          quote.open?.[0] ?? lastPrice,
            high:          meta.regularMarketDayHigh ?? quote.high?.[0] ?? lastPrice,
            low:           meta.regularMarketDayLow ?? quote.low?.[0] ?? lastPrice,
            close,
            volume:        meta.regularMarketVolume ?? quote.volume?.[0] ?? 0,
            currency:      meta.currency ?? 'USD',
            name:          meta.shortName ?? symbol,
          };
        } catch (e) {
          console.error(`[/api/market/comex] Error fetching symbol ${symbol}:`, e);
        }
      })
    );

    return NextResponse.json({ quotes }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    console.error('[/api/market/comex] handler error:', err);
    return NextResponse.json({ error: 'Failed to fetch commodity data' }, { status: 500 });
  }
}
