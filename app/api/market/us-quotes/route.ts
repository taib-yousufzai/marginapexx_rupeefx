import { NextRequest, NextResponse } from 'next/server';
import { fetchUSStockQuotes } from '@/lib/datafeed/USStockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbolsParam = searchParams.get('symbols') || searchParams.get('q') || '';
    if (!symbolsParam.trim()) {
      return NextResponse.json({ quotes: {} });
    }

    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
    const quotes = await fetchUSStockQuotes(symbols);

    return NextResponse.json({ quotes }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    console.error('[/api/market/us-quotes] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch US stock quotes', message: err?.message }, { status: 500 });
  }
}
