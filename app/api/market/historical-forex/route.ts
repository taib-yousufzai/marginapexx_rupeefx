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

  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = ((hash << 5) - hash) + symbol.charCodeAt(i);
    hash |= 0;
  }

  let seed = Math.abs(hash) + 1;
  function pseudoRandom() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }

  const totalSteps = Math.floor((toSec - startSec) / stepSec);
  let stepIndex = 0;
  let currentWalkPrice = basePrice * (1 + (pseudoRandom() - 0.5) * 0.01);

  for (let t = startSec; t <= toSec; t += stepSec) {
    stepIndex++;
    const isLastBar = stepIndex >= totalSteps || t + stepSec > toSec;
    const timeIso = new Date(t * 1000).toISOString();
    
    const r1 = pseudoRandom();
    const r2 = pseudoRandom();
    const r3 = pseudoRandom();

    // Realistic small candle walk step (-0.2% to +0.2%)
    const stepPct = (r1 - 0.495) * 0.004;
    const open = Number(currentWalkPrice.toFixed(2));
    let close = isLastBar ? basePrice : Number((open * (1 + stepPct)).toFixed(2));

    const maxOC = Math.max(open, close);
    const minOC = Math.min(open, close);

    const high = Number((maxOC + basePrice * (r2 * 0.0015)).toFixed(2));
    const low = Number((Math.max(0.01, minOC - basePrice * (r3 * 0.0015))).toFixed(2));
    const volume = Math.floor(r1 * 8000) + 1200;
    
    currentWalkPrice = close;
    candles.push([timeIso, open, high, low, close, volume]);
  }
  
  return candles;
}

async function fetchRealHistoricalBars(symbol: string, interval: string, period1: number, period2: number): Promise<any[][]> {
  try {
    const clean = symbol.replace(/^(US:|FOREX:)/i, '').trim().toUpperCase();
    const intervalMap: Record<string, string> = {
      '1m': '1m', '2m': '2m', '3m': '2m', '5m': '5m', '15m': '15m', '30m': '30m', '60m': '60m', '1h': '60m', '1d': '1d', 'D': '1d'
    };
    const validInterval = intervalMap[interval] || '5m';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?interval=${validInterval}&period1=${period1}&period2=${period2}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return [];

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];

    const bars: any[][] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] && closes[i] !== null && closes[i] !== undefined) {
        const timeIso = new Date(timestamps[i] * 1000).toISOString();
        const o = Number((opens[i] ?? closes[i]).toFixed(2));
        const h = Number((highs[i] ?? closes[i]).toFixed(2));
        const l = Number((lows[i] ?? closes[i]).toFixed(2));
        const c = Number((closes[i]).toFixed(2));
        const v = volumes[i] ?? 0;
        bars.push([timeIso, o, h, l, c, v]);
      }
    }
    return bars;
  } catch (err) {
    console.warn(`[historical-forex] Failed to fetch real bars for ${symbol}:`, err);
    return [];
  }
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

    // Server-side real market chart candles (0 credentials needed)
    if (!candles || candles.length === 0) {
      candles = await fetchRealHistoricalBars(rawSymbol, rawInterval, period1, period2);
    }

    // Synthetic Fallback if offline
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
