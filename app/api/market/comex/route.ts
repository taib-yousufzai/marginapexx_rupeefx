import { NextRequest, NextResponse } from 'next/server';
import { getUSStockBasePrice } from '@/lib/datafeed/USStockService';
import { fetchMT5StockQuote } from '@/lib/datafeed/MT5StockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let forexCache: { rates: Record<string, number>; timestamp: number } | null = null;

async function getLiveForexRate(symbol: string): Promise<number | null> {
  const clean = symbol.replace(/^(US:|FOREX:|COMEX:|MCX:|CDS:|FX:|TVC:|OANDA:)/i, '').replace(/[\/\s]/g, '').replace(/(=[FX]|\.X)$/i, '').trim().toUpperCase();
  const FOREX_KEYS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD', 'USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
  if (!FOREX_KEYS.some(k => clean.startsWith(k))) {
    return null;
  }

  try {
    const now = Date.now();
    if (!forexCache || now - forexCache.timestamp > 15000) {
      const res = await fetch('https://open.er-api.com/v6/latest/USD', {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.rates) {
          forexCache = { rates: json.rates, timestamp: now };
        }
      }
    }

    if (forexCache?.rates) {
      const r = forexCache.rates;
      if (clean.startsWith('EURUSD')) return r.EUR ? Number((1 / r.EUR).toFixed(4)) : null;
      if (clean.startsWith('GBPUSD')) return r.GBP ? Number((1 / r.GBP).toFixed(4)) : null;
      if (clean.startsWith('USDJPY')) return r.JPY ? Number(r.JPY.toFixed(2)) : null;
      if (clean.startsWith('USDCHF')) return r.CHF ? Number(r.CHF.toFixed(4)) : null;
      if (clean.startsWith('USDCAD')) return r.CAD ? Number(r.CAD.toFixed(4)) : null;
      if (clean.startsWith('AUDUSD')) return r.AUD ? Number((1 / r.AUD).toFixed(4)) : null;
      if (clean.startsWith('NZDUSD')) return r.NZD ? Number((1 / r.NZD).toFixed(4)) : null;
      if (clean.startsWith('USDINR')) return r.INR ? Number(r.INR.toFixed(2)) : null;
      if (clean.startsWith('EURINR')) return r.EUR && r.INR ? Number((r.INR / r.EUR).toFixed(2)) : null;
      if (clean.startsWith('GBPINR')) return r.GBP && r.INR ? Number((r.INR / r.GBP).toFixed(2)) : null;
      if (clean.startsWith('JPYINR')) return r.JPY && r.INR ? Number((r.INR / r.JPY).toFixed(4)) : null;
    }
  } catch {}

  return null;
}

async function fetchComexQuote(symbol: string) {
  // 1. Try MT5 if configured
  try {
    const mt5Quote = await fetchMT5StockQuote(symbol);
    if (mt5Quote && mt5Quote.price > 0) {
      const decimals = mt5Quote.price < 10 ? 4 : 2;
      return {
        symbol,
        contractSymbol: symbol,
        lastPrice: mt5Quote.price,
        change: Number((mt5Quote.price - mt5Quote.prevClose).toFixed(decimals)),
        changePercent: mt5Quote.changePercent,
        open: mt5Quote.prevClose,
        high: mt5Quote.high,
        low: mt5Quote.low,
        close: mt5Quote.prevClose,
        volume: 5000,
        currency: 'USD',
        name: symbol,
      };
    }
  } catch (err) { }

  // 2. Try live Forex rates if symbol is a Forex pair
  let price = await getLiveForexRate(symbol);
  if (!price || price <= 0) {
    price = getUSStockBasePrice(symbol);
  }

  const decimals = price < 10 ? 4 : 2;
  return {
    symbol,
    contractSymbol: symbol,
    lastPrice: price,
    change: 0,
    changePercent: 0,
    open: price,
    high: Number((price * 1.002).toFixed(decimals)),
    low: Number((price * 0.998).toFixed(decimals)),
    close: price,
    volume: 5000,
    currency: 'USD',
    name: symbol,
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols') ?? 'XAUUSD,XAGUSD,XTIUSD,XCUUSD,USDINR,EURINR,GBPINR,EURUSD,GBPUSD';
  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  try {
    const quotesList = await Promise.all(symbols.map(s => fetchComexQuote(s)));
    const quotes: Record<string, any> = {};
    for (const q of quotesList) {
      quotes[q.symbol] = q;
      const clean = q.symbol.replace(/^(FOREX:|COMEX:|US:|CDS:)/i, '').replace(/[\/\s]/g, '').replace(/(=[FX]|\.X)$/i, '');
      quotes[clean] = q;
      quotes[`${clean}=X`] = q;
      quotes[`FOREX:${clean}`] = q;
      quotes[`FOREX:${q.symbol}`] = q;
    }

    return NextResponse.json({ quotes }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    console.error('[/api/market/comex] handler error:', err);
    return NextResponse.json({ error: 'Failed to fetch commodity/forex data' }, { status: 500 });
  }
}


