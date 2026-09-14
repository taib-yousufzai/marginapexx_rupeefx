import { NextRequest, NextResponse } from 'next/server';
import { fetchMT5HistoricalBars, isMT5Configured } from '../../../../lib/datafeed/MT5StockService';
import { fetchUSStockQuote, getUSStockBasePrice } from '../../../../lib/datafeed/USStockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function generateFallbackCandles(symbol: string, interval: string, fromSec: number, toSec: number, anchorClosePrice?: number): any[][] {
  const basePrice = anchorClosePrice && anchorClosePrice > 0 ? anchorClosePrice : getUSStockBasePrice(symbol);
  const normInt = (interval || '').toLowerCase().trim();
  const stepSec = (normInt === '1m' || normInt === '1') ? 60 :
                  (normInt === '2m' || normInt === '2') ? 120 :
                  (normInt === '3m' || normInt === '3') ? 180 :
                  (normInt === '5m' || normInt === '5') ? 300 :
                  (normInt === '10m' || normInt === '10') ? 600 :
                  (normInt === '15m' || normInt === '15') ? 900 :
                  (normInt === '30m' || normInt === '30') ? 1800 :
                  (normInt === '60m' || normInt === '60' || normInt === '1h') ? 3600 :
                  (normInt === '1d' || normInt === 'd' || normInt === 'D') ? 86400 : 300;
  
  const rawCandles: any[][] = [];
  const maxBars = 300;
  const decimals = basePrice < 10 ? 4 : 2;
  
  // Work BACKWARDS smoothly from basePrice at toSec down to startSec
  let currentClose = basePrice;
  const maxDev = basePrice * 0.006; // Max 0.6% deviation from basePrice

  let t = toSec;
  while (rawCandles.length < maxBars && t >= fromSec - (maxBars * stepSec * 3)) {
    const d = new Date(t * 1000);
    const day = d.getUTCDay();
    const hour = d.getUTCHours();
    
    // Skip weekend market closure (Saturday 00:00 UTC to Sunday 22:00 UTC)
    const isWeekendClosed = (day === 6) || (day === 0 && hour < 22);
    if (!isWeekendClosed || interval === '1d' || interval === 'd') {
      const pullToBase = (basePrice - currentClose) * 0.08;
      const noise = (Math.random() - 0.5) * (basePrice * 0.0015);
      let open = Number((currentClose + pullToBase + noise).toFixed(decimals));

      if (open > basePrice + maxDev) open = Number((basePrice + maxDev).toFixed(decimals));
      if (open < basePrice - maxDev) open = Number((basePrice - maxDev).toFixed(decimals));

      const maxOC = Math.max(open, currentClose);
      const minOC = Math.min(open, currentClose);

      const upperWick = Math.random() * (basePrice * 0.001);
      const lowerWick = Math.random() * (basePrice * 0.001);

      const high = Number((maxOC + upperWick).toFixed(decimals));
      const low = Number((Math.max(0.0001, minOC - lowerWick)).toFixed(decimals));
      const close = Number(currentClose.toFixed(decimals));
      const volume = Math.floor(1500 + Math.random() * 3500);

      const timeIso = d.toISOString();
      rawCandles.push([timeIso, open, high, low, close, volume]);
      
      currentClose = open;
    }
    t -= stepSec;
  }

  return rawCandles.reverse();
}

async function fetchRealNasdaqHistoricalBars(symbol: string): Promise<any[][]> {
  try {
    const clean = symbol.replace(/^(US:|FOREX:)/i, '').trim().toUpperCase();
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(clean)}/chart?assetclass=stocks`;
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
    const chartList: any[] = json?.data?.chart || [];
    if (!Array.isArray(chartList) || chartList.length === 0) return [];

    // 1. Extract raw valid price points
    const rawPoints: { time: string; price: number }[] = [];
    for (const item of chartList) {
      if (item && item.x && typeof item.y === 'number' && item.y > 0) {
        rawPoints.push({
          time: new Date(item.x).toISOString(),
          price: Number(item.y.toFixed(2)),
        });
      }
    }

    if (rawPoints.length === 0) return [];

    // 2. Outlier Filtering (Filter out ticks deviating > 3% from median to prevent giant needles)
    const sortedPrices = rawPoints.map(p => p.price).sort((a, b) => a - b);
    const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)] || rawPoints[0].price;
    const cleanPoints = rawPoints.filter(p => Math.abs(p.price - medianPrice) / medianPrice < 0.03);

    if (cleanPoints.length === 0) return [];

    // 3. Build realistic OHLC candlestick bars
    const bars: any[][] = [];
    let prevClose = cleanPoints[0].price;

    for (let i = 0; i < cleanPoints.length; i++) {
      const p = cleanPoints[i];
      const open = prevClose;
      const close = p.price;
      const maxOC = Math.max(open, close);
      const minOC = Math.min(open, close);
      const wickOffset = Number((medianPrice * 0.0005).toFixed(2));
      const high = Number((maxOC + wickOffset).toFixed(2));
      const low = Number((Math.max(0.01, minOC - wickOffset)).toFixed(2));
      const volume = 1500 + (i % 20) * 100;

      bars.push([p.time, open, high, low, close, volume]);
      prevClose = close;
    }

    // 4. Sync last bar close price with live CMP quote
    const liveQuote = await fetchUSStockQuote(clean);
    if (liveQuote && liveQuote.price > 0 && bars.length > 0) {
      const lastIdx = bars.length - 1;
      const cmp = liveQuote.price;
      bars[lastIdx][4] = cmp;
      bars[lastIdx][2] = Math.max(bars[lastIdx][2], cmp);
      bars[lastIdx][3] = Math.min(bars[lastIdx][3], cmp);
    }

    return bars;
  } catch (err) {
    console.warn(`[historical-forex] Failed to fetch NASDAQ chart bars for ${symbol}:`, err);
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

    // 1. Primary Source: MT5 Historical Bars (if MT5 Web API is configured)
    if (isMT5Configured()) {
      candles = await fetchMT5HistoricalBars(rawSymbol, rawInterval, period1, period2);
    }

    // 2. Real Official NASDAQ Live Chart Candles (for US Stocks, 0 Broker Accounts Needed)
    if (!candles || candles.length === 0) {
      const nasdaqBars = await fetchRealNasdaqHistoricalBars(rawSymbol);
      if (nasdaqBars && nasdaqBars.length > 0) {
        let filteredNasdaq = nasdaqBars.filter(b => {
          const sec = Math.floor(new Date(b[0]).getTime() / 1000);
          return sec >= period1 && sec <= period2;
        });

        if (filteredNasdaq.length === 0) {
          filteredNasdaq = nasdaqBars;
        }

        const firstBarSec = Math.floor(new Date(filteredNasdaq[0][0]).getTime() / 1000);
        if (firstBarSec > period1 + 600) {
          const firstOpenPrice = filteredNasdaq[0][1];
          const historicBars = generateFallbackCandles(
            rawSymbol,
            rawInterval,
            period1,
            firstBarSec - 300,
            firstOpenPrice
          );
          candles = [...historicBars, ...filteredNasdaq];
        } else {
          candles = filteredNasdaq;
        }
      }
    }

    // 3. Fallback Candles for historical pagination or offline data
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
