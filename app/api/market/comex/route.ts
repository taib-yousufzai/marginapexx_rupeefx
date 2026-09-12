import { NextRequest, NextResponse } from 'next/server';
import { getUSStockBasePrice } from '@/lib/datafeed/USStockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

    for (const symbol of symbols) {
      const basePrice = getUSStockBasePrice(symbol);
      quotes[symbol] = {
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
