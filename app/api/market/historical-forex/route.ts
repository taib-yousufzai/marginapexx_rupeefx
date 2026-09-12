import { NextRequest, NextResponse } from 'next/server';
import { fetchMT5HistoricalBars, isMT5Configured } from '../../../../lib/datafeed/MT5StockService';
import { getUSStockBasePrice } from '../../../../lib/datafeed/USStockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function generateFallbackCandles(symbol: string, interval: string, fromSec: number, toSec: number): any[][] {
  const basePrice = getUSStockBasePrice(symbol);
  const stepSec = interval === '1m' ? 60 : (interval === '1d' || interval === 'd') ? 86400 : 300;
  
  const candles: any[][] = [];
  
  // Cap at 500 bars max
  const maxBars = 500;
  let startSec = fromSec;
  if ((toSec - fromSec) / stepSec > maxBars) {
    startSec = toSec - maxBars * stepSec;
  }

  const totalSteps = Math.max(1, Math.floor((toSec - startSec) / stepSec));
  let stepIndex = 0;

  for (let t = startSec; t <= toSec; t += stepSec) {
    stepIndex++;
    const progress = stepIndex / totalSteps;
    // Smooth wave centered on basePrice
    const wave = Math.sin(progress * Math.PI * 4) * (basePrice * 0.015);
    const micro = Math.cos(stepIndex * 0.7) * (basePrice * 0.003);
    
    // At last bar (progress -> 1), damp drops to 0 so close price equals basePrice exactly
    const damp = Math.pow(1 - progress, 1.5);
    const close = stepIndex >= totalSteps ? basePrice : Number((basePrice + (wave + micro) * damp).toFixed(2));
    const prevClose = stepIndex === 1 ? basePrice : candles[stepIndex - 2]?.[4] ?? basePrice;
    const open = prevClose;

    const maxOC = Math.max(open, close);
    const minOC = Math.min(open, close);

    const high = Number((maxOC + basePrice * 0.001).toFixed(2));
    const low = Number((Math.max(0.01, minOC - basePrice * 0.001)).toFixed(2));
    const volume = 2500 + Math.floor(Math.abs(Math.sin(stepIndex)) * 3000);
    
    const timeIso = new Date(t * 1000).toISOString();
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
      const num = Number(toParam);
      if (!isNaN(num) && num > 0) {
        period2 = num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
      } else {
        const toMs = new Date(toParam).getTime();
        if (!isNaN(toMs) && toMs > 0) {
          period2 = Math.floor(toMs / 1000);
        }
      }
    }

    if (fromParam) {
      const num = Number(fromParam);
      if (!isNaN(num) && num > 0) {
        period1 = num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
      } else {
        const fromMs = new Date(fromParam).getTime();
        if (!isNaN(fromMs) && fromMs > 0) {
          period1 = Math.floor(fromMs / 1000);
        }
      }
    }

    let candles: any[][] = [];

    // 1. Primary Source: MT5 Historical Bars (0 Yahoo Finance calls)
    if (isMT5Configured()) {
      candles = await fetchMT5HistoricalBars(rawSymbol, rawInterval, period1, period2);
    }

    // 2. Base Fallback Candles if MT5 is unconfigured / offline
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
