import { NextRequest, NextResponse } from 'next/server';
import { fetchMT5HistoricalBars, isMT5Configured } from '../../../../lib/datafeed/MT5StockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getBasePrice(symbol: string): number {
  const clean = symbol.replace(/^(US:|FOREX:)/i, '').trim().toUpperCase();
  const prices: Record<string, number> = {
    'NFLX': 600,
    'AAPL': 220,
    'TSLA': 210,
    'NVDA': 120,
    'MSFT': 420,
    'AMZN': 180,
    'GOOGL': 165,
    'META': 500,
    'AMD': 150,
    'INTC': 30,
    'SPY': 550,
    'QQQ': 480,
    'DIA': 400,
  };
  return prices[clean] ?? 100;
}

function generateFallbackCandles(symbol: string, interval: string, fromSec: number, toSec: number): any[][] {
  const basePrice = getBasePrice(symbol);
  const stepSec = interval === '1m' ? 60 : (interval === '1d' || interval === 'd') ? 86400 : 300;
  
  const candles: any[][] = [];
  let currentPrice = basePrice;
  
  // Cap at 500 bars max
  const maxBars = 500;
  let startSec = fromSec;
  if ((toSec - fromSec) / stepSec > maxBars) {
    startSec = toSec - maxBars * stepSec;
  }

  for (let t = startSec; t <= toSec; t += stepSec) {
    const timeIso = new Date(t * 1000).toISOString();
    const variation = (Math.random() - 0.49) * (basePrice * 0.003);
    const open = Number((currentPrice).toFixed(2));
    const close = Number((currentPrice + variation).toFixed(2));
    const high = Number((Math.max(open, close) + Math.random() * (basePrice * 0.002)).toFixed(2));
    const low = Number((Math.min(open, close) - Math.random() * (basePrice * 0.002)).toFixed(2));
    const volume = Math.floor(Math.random() * 5000) + 1000;
    
    currentPrice = close;
    candles.push([timeIso, open, high, low, close, volume]);
  }
  
  return candles;
}

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

    let candles: any[][] = [];

    if (isMT5Configured()) {
      candles = await fetchMT5HistoricalBars(rawSymbol, rawInterval, period1, period2);
    }

    // Fallback if MT5 is unconfigured or returned 0 bars
    if (!candles || candles.length === 0) {
      candles = generateFallbackCandles(rawSymbol, rawInterval, period1, period2);
    }

    return NextResponse.json({ candles }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    console.error('[/api/market/historical-forex] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch historical data', message: err?.message }, { status: 500 });
  }
}
