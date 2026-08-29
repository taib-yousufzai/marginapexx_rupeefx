import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mapResolutionToYahooInterval(res: string): string {
  const norm = res.toLowerCase().trim();
  if (norm === '1' || norm === '1m' || norm === 'minute') return '1m';
  if (norm === '2' || norm === '2m' || norm === '3' || norm === '3m' || norm === '5' || norm === '5m' || norm === '5minute') return '5m';
  if (norm === '10' || norm === '10m' || norm === '15' || norm === '15m' || norm === '15minute') return '15m';
  if (norm === '30' || norm === '30m' || norm === '30minute' || norm === '60' || norm === '60m' || norm === '1h' || norm === '60minute') return '60m';
  if (norm === 'd' || norm === 'day' || norm === '1d') return '1d';
  return '5m';
}

function cleanForexSymbol(symbol: string): string {
  let s = symbol.trim().toUpperCase();
  if (s.startsWith('FOREX:')) s = s.slice(6);
  if (s.startsWith('US:')) s = s.slice(3);
  if (s.endsWith('USDT')) s = s.slice(0, -4) + 'USD';
  s = s.replace(/\//g, '');
  if (!s.endsWith('=X') && !s.endsWith('=F') && s.length === 6 && !s.includes('INR') && !s.includes('=')) {
    s = `${s}=X`;
  }
  return s;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawSymbol = searchParams.get('symbol');
    const rawInterval = searchParams.get('interval') || '5m';

    if (!rawSymbol) {
      return NextResponse.json({ error: 'Missing required symbol parameter' }, { status: 400 });
    }

    const yahooSymbol = cleanForexSymbol(rawSymbol);
    const interval = mapResolutionToYahooInterval(rawInterval);

    const nowSec = Math.floor(Date.now() / 1000);
    let period2 = nowSec;
    let period1 = period2 - 5 * 86400; // Default 5 days for intraday

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

    // Yahoo Finance API limits for intraday intervals relative to current time
    let minP1 = 0;
    if (interval === '1m') {
      minP1 = nowSec - 6 * 86400;
    } else if (['5m', '15m', '30m', '60m'].includes(interval)) {
      minP1 = nowSec - 58 * 86400;
    }

    if (minP1 > 0) {
      if (period2 <= minP1) {
        return NextResponse.json({ candles: [] });
      }
      if (period1 < minP1) {
        period1 = minP1;
      }
    }

    if (period2 <= period1) {
      return NextResponse.json({ candles: [] });
    }

    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&period1=${period1}&period2=${period2}`;
    
    console.log(`[/api/market/historical-forex] Fetching ${yahooSymbol} interval=${interval} period1=${period1} period2=${period2}`);

    const res = await fetch(yahooUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      console.warn(`[/api/market/historical-forex] Yahoo Finance fetch failed for ${yahooSymbol}: status ${res.status}`);
      return NextResponse.json({ candles: [] });
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result || !result.timestamp || !Array.isArray(result.timestamp)) {
      return NextResponse.json({ candles: [] });
    }

    const timestamps: number[] = result.timestamp;
    const quote = result.indicators?.quote?.[0] || {};
    const opens: (number | null)[] = quote.open || [];
    const highs: (number | null)[] = quote.high || [];
    const lows: (number | null)[] = quote.low || [];
    const closes: (number | null)[] = quote.close || [];
    const volumes: (number | null)[] = quote.volume || [];

    const candles: any[][] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      // Yahoo Finance ignores period2 for intraday intervals and returns data up to the current moment.
      // We must strictly filter out any candle with timestamp > period2 or < period1 to prevent TradingView bar cache corruption.
      if (ts < period1 || ts > period2) continue;

      const open = opens[i];
      const high = highs[i];
      const low = lows[i];
      const close = closes[i];

      if (open != null && high != null && low != null && close != null && isFinite(close)) {
        const timeIso = new Date(ts * 1000).toISOString();
        candles.push([
          timeIso,
          open,
          high,
          low,
          close,
          volumes[i] ?? 0
        ]);
      }
    }

    return NextResponse.json({ candles }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    console.error('[/api/market/historical-forex] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch forex historical data', message: err.message }, { status: 500 });
  }
}
