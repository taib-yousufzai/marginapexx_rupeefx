type Bar = any;
type LibrarySymbolInfo = any;
type PeriodParams = any;
type ResolutionString = any;
import { resolutionToBinanceInterval, resolutionToKiteInterval } from './resolutionUtils';
import { getCanonicalSymbol, isForexSymbol, isUsSymbol } from './symbolResolver';

type BinanceKline = any[];

/**
 * Fetches historical bars for a given symbol and resolution.
 *
 * Routes to Binance API for CRYPTO, Yahoo Finance for FOREX and US instruments, and Kite API for all Indian symbols.
 */
export async function fetchBars(
  symbolInfo: LibrarySymbolInfo,
  resolution: ResolutionString,
  periodParams: PeriodParams,
  segment: string,
  loadId: string = 'default',
  getBarsCallNum: number = 1,
  loadStartTime: number = performance.now()
): Promise<{ bars: Bar[]; noData: boolean }> {
  try {
    const canonicalSymbol = getCanonicalSymbol(symbolInfo);
    const upperSym = canonicalSymbol.toUpperCase();
    const isUs = isUsSymbol(canonicalSymbol, segment) || symbolInfo?.exchange === 'US';
    const isGlobalYahooForex =
      !isUs &&
      (isForexSymbol(canonicalSymbol) ||
        (segment.toUpperCase() === 'FOREX' &&
          symbolInfo?.exchange === 'FOREX' &&
          !upperSym.includes('INR') &&
          !upperSym.endsWith('FUT') &&
          !upperSym.startsWith('CDS:')));
        
    const isCrypto =
      !isUs &&
      !isGlobalYahooForex &&
      (segment.toUpperCase() === 'CRYPTO' || canonicalSymbol.endsWith('USDT'));

    if (isCrypto) {
      return fetchBinanceBars(canonicalSymbol, resolution, periodParams, loadId, getBarsCallNum, loadStartTime);
    } else if (isGlobalYahooForex || isUs) {
      return fetchYahooForexBars(canonicalSymbol, resolution, periodParams, loadId, getBarsCallNum, loadStartTime);
    } else {
      return fetchKiteBars(canonicalSymbol, resolution, periodParams, loadId, getBarsCallNum, loadStartTime);
    }
  } catch (err) {
    throw err;
  }
}

/**
 * Fetches bars from the server-side Yahoo Finance Forex proxy API (/api/market/historical-forex).
 */
async function fetchYahooForexBars(
  symbol: string,
  resolution: ResolutionString,
  periodParams: PeriodParams,
  loadId: string,
  getBarsCallNum: number,
  loadStartTime: number
): Promise<{ bars: Bar[]; noData: boolean }> {
  const url =
    `/api/market/historical-forex` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(resolution)}` +
    `&from=${periodParams.from * 1000}` +
    `&to=${periodParams.to * 1000}`;

  const fetchStart = performance.now();
  console.log(`[CHART PERF ${loadId}] +${(fetchStart - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Forex START: ${symbol} (${resolution})`);

  const json = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Forex historical data fetch failed: ${r.status} ${r.statusText}`);
    return r.json();
  });

  const duration = performance.now() - fetchStart;
  const candles: any[][] = json?.candles ?? [];

  const bars: Bar[] = candles.map((c) => ({
    time: new Date(c[0]).getTime(),
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5] ?? 0,
  }));

  console.log(`[CHART PERF ${loadId}] +${(performance.now() - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Forex COMPLETE: ${symbol} -> ${bars.length} bars (fetch took ${duration.toFixed(1)}ms, noData=${bars.length === 0})`);
  return { bars, noData: bars.length === 0 };
}

/**
 * Fetches bars from the Binance klines REST API.
 * Bar.time is already in milliseconds (kline[0]).
 */
async function fetchBinanceBars(
  symbol: string,
  resolution: ResolutionString,
  periodParams: PeriodParams,
  loadId: string,
  getBarsCallNum: number,
  loadStartTime: number
): Promise<{ bars: Bar[]; noData: boolean }> {
  const interval = resolutionToBinanceInterval(resolution);
  const url =
    `/api/market/historical-crypto` +
    `?symbol=${symbol}` +
    `&interval=${interval}` +
    `&startTime=${periodParams.from * 1000}` +
    `&endTime=${periodParams.to * 1000}` +
    `&limit=1000`;

  const fetchStart = performance.now();
  console.log(`[CHART PERF ${loadId}] +${(fetchStart - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Crypto START: ${symbol} (${interval})`);

  const data: BinanceKline[] = await fetch(url).then((r) => {
    if (!r.ok) throw new Error('Network response was not ok');
    return r.json();
  });

  const duration = performance.now() - fetchStart;
  const bars: Bar[] = data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  console.log(`[CHART PERF ${loadId}] +${(performance.now() - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Crypto COMPLETE: ${symbol} -> ${bars.length} bars (fetch took ${duration.toFixed(1)}ms, noData=${bars.length === 0})`);
  return { bars, noData: bars.length === 0 };
}

/**
 * Fetches bars from the internal Kite (Zerodha) historical data API.
 * Bar.time is derived from the ISO date string in candle[0].
 */
async function fetchKiteBars(
  ticker: string,
  resolution: ResolutionString,
  periodParams: PeriodParams,
  loadId: string,
  getBarsCallNum: number,
  loadStartTime: number
): Promise<{ bars: Bar[]; noData: boolean }> {
  const interval = resolutionToKiteInterval(resolution);

  const fromFmt = new Date(periodParams.from * 1000).toISOString();
  const toFmt = new Date(periodParams.to * 1000).toISOString();

  const baseUrl = typeof window !== 'undefined'
    ? ''
    : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

  const url =
    `${baseUrl}/api/market/historical` +
    `?symbol=${encodeURIComponent(ticker)}` +
    `&interval=${interval}` +
    `&from=${encodeURIComponent(fromFmt)}` +
    `&to=${encodeURIComponent(toFmt)}`;

  const fetchStart = performance.now();
  console.log(`[CHART PERF ${loadId}] +${(fetchStart - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Kite START: ${ticker} (${resolution}) [from: ${fromFmt}, to: ${toFmt}]`);

  const json = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Historical data fetch failed: ${r.status} ${r.statusText}`);
    return r.json();
  });

  const duration = performance.now() - fetchStart;
  const candles: any[][] = json?.data?.candles ?? json?.candles ?? [];

  if (!Array.isArray(candles)) {
    throw new Error(json?.error || json?.message || 'Invalid candles response from server');
  }

  const bars: Bar[] = candles.map((c) => ({
    time: new Date(c[0]).getTime(),
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5] ?? 0,
  }));

  console.log(`[CHART PERF ${loadId}] +${(performance.now() - loadStartTime).toFixed(1)}ms fetchBars #${getBarsCallNum} Kite COMPLETE: ${ticker} -> ${bars.length} bars (fetch took ${duration.toFixed(1)}ms, noData=${bars.length === 0})`);
  return { bars, noData: bars.length === 0 };
}
