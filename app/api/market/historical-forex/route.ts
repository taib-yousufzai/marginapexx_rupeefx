import { NextRequest, NextResponse } from 'next/server';
import { fetchMT5HistoricalBars, isMT5Configured } from '../../../../lib/datafeed/MT5StockService';
import { getUSStockBasePrice } from '../../../../lib/datafeed/USStockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function generateFallbackCandles(symbol: string, interval: string, fromSec: number, toSec: number): any[][] {
  const basePrice = getUSStockBasePrice(symbol);
  const stepSec = interval === '1m' ? 60 : (interval === '1d' || interval === 'd') ? 86400 : 300;
  
  const candles: any[][] = [];
  let currentPrice = basePrice;
  
  // Cap at 500 bars max
  const maxBars = 500;
  let startSec = fromSec;
  if ((toSec - fromSec) / stepSec > maxBars) {
    startSec = toSec - maxBars * stepSec;
  }

  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = ((hash << 5) - hash) + symbol.charCodeAt(i);
    hash |= 0;
  }

  const totalSteps = Math.floor((toSec - startSec) / stepSec);
  let stepIndex = 0;

  for (let t = startSec; t <= toSec; t += stepSec) {
    stepIndex++;
    const isLastBar = stepIndex >= totalSteps || t + stepSec > toSec;
    const timeIso = new Date(t * 1000).toISOString();
    
    // Pseudo-random deterministic variation based on timestamp
    const pseudoRand = Math.abs(Math.sin(t * 0.0001 + hash));
    const variation = (pseudoRand - 0.49) * (basePrice * 0.002);
    
    const open = Number((currentPrice).toFixed(2));
    let close = Number((currentPrice + variation).toFixed(2));

    if (isLastBar) {
      close = basePrice;
    }

    const high = Number((Math.max(open, close) + (pseudoRand * (basePrice * 0.001))).toFixed(2));
    const low = Number((Math.min(open, close) - (pseudoRand * (basePrice * 0.001))).toFixed(2));
    const volume = Math.floor(pseudoRand * 5000) + 1000;
    
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
