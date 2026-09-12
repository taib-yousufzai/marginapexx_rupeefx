import { NextRequest, NextResponse } from 'next/server';
import { fetchMT5HistoricalBars, isMT5Configured } from '../../../../lib/datafeed/MT5StockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawSymbol = searchParams.get('symbol');
    const rawInterval = searchParams.get('interval') || '5m';

    if (!rawSymbol) {
      return NextResponse.json({ error: 'Missing required symbol parameter' }, { status: 400 });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let period2 = nowSec;
    let period1 = period2 - 14 * 86400;

    const fromParam = searchParams.get('from') || searchParams.get('startTime');
    const toParam = searchParams.get('to') || searchParams.get('endTime');

    if (toParam) {
      const toMs = isNaN(Number(toParam)) ? new Date(toParam).getTime() : Number(toParam);
      if (!isNaN(toMs) && toMs > 0) {
        period2 = Math.min(Math.floor(toMs / 1000), nowSec);
      }
    }

    if (fromParam) {
      const fromMs = isNaN(Number(fromParam)) ? new Date(fromParam).getTime() : Number(fromParam);
      if (!isNaN(fromMs) && fromMs > 0) {
        period1 = Math.floor(fromMs / 1000);
      }
    }

    if (!isMT5Configured()) {
      return NextResponse.json({ candles: [] });
    }

    const candles = await fetchMT5HistoricalBars(rawSymbol, rawInterval, period1, period2);

    return NextResponse.json({ candles }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    console.error('[/api/market/historical-forex] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch MT5 historical data', message: err?.message }, { status: 500 });
  }
}
