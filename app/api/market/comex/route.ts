import { NextRequest, NextResponse } from 'next/server';
import { getUSStockBasePrice } from '@/lib/datafeed/USStockService';
import { fetchMT5StockQuote } from '@/lib/datafeed/MT5StockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function fetchComexQuote(symbol: string) {
  const basePrice = getUSStockBasePrice(symbol);

  try {
    const mt5Quote = await fetchMT5StockQuote(symbol);
    if (mt5Quote && mt5Quote.price > 0) {
      return {
        symbol,
        contractSymbol: symbol,
        lastPrice: mt5Quote.price,
        change: Number((mt5Quote.price - mt5Quote.prevClose).toFixed(2)),
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

  return {
    symbol,
    contractSymbol: symbol,
    lastPrice: basePrice,
    change: 0,
    changePercent: 0,
    open: basePrice,
    high: Number((basePrice * 1.005).toFixed(2)),
    low: Number((basePrice * 0.995).toFixed(2)),
    close: basePrice,
    volume: 5000,
    currency: 'USD',
    name: symbol,
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols') ?? 'XAUUSD,XAGUSD,XTIUSD,XCUUSD';
  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  try {
    const quotesList = await Promise.all(symbols.map(s => fetchComexQuote(s)));
    const quotes: Record<string, any> = {};
    for (const q of quotesList) {
      quotes[q.symbol] = q;
    }

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


