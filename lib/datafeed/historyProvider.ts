type Bar = any;
type LibrarySymbolInfo = any;
type PeriodParams = any;
type ResolutionString = any;
import { getCanonicalSymbol } from './symbolResolver';

/**
 * Fetches historical bars for a given symbol and resolution.
 *
 * All instrument types (equity, index, forex, COMEX, crypto, CDS) are routed
 * through the single /api/market/candles endpoint.  That route tries Railway
 * Postgres first, then falls back to the appropriate live data source
 * (Kite, Binance, MT5, NASDAQ) based on the instrument type.
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
  const canonicalSymbol = getCanonicalSymbol(symbolInfo);

  const url =
    `/api/market/candles` +
    `?symbol=${encodeURIComponent(canonicalSymbol)}` +
    `&interval=${encodeURIComponent(resolution)}` +
    `&segment=${encodeURIComponent(segment)}` +
    `&from=${periodParams.from * 1000}` +
    `&to=${periodParams.to * 1000}` +
    (periodParams.countBack ? `&limit=${periodParams.countBack}` : '');

  const fetchStart = performance.now();
  console.log(
    `[CHART PERF ${loadId}] +${(fetchStart - loadStartTime).toFixed(1)}ms` +
    ` fetchBars #${getBarsCallNum} START: ${canonicalSymbol} (${resolution})` +
    ` segment=${segment}`
  );

  const json = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`candles fetch failed: ${r.status} ${r.statusText}`);
    return r.json();
  });

  const duration = performance.now() - fetchStart;
  const candles: any[][] = json?.candles ?? [];

  if (!Array.isArray(candles)) {
    throw new Error(json?.error || json?.message || 'Invalid candles response');
  }

  const bars: Bar[] = candles.map(c => ({
    time:   new Date(c[0]).getTime(),
    open:   Number(c[1]),
    high:   Number(c[2]),
    low:    Number(c[3]),
    close:  Number(c[4]),
    volume: Number(c[5] ?? 0),
  }));

  console.log(
    `[CHART PERF ${loadId}] +${(performance.now() - loadStartTime).toFixed(1)}ms` +
    ` fetchBars #${getBarsCallNum} DONE: ${canonicalSymbol} → ${bars.length} bars` +
    ` (${duration.toFixed(1)}ms, source=${json?.source ?? 'unknown'}, noData=${bars.length === 0})`
  );

  return { bars, noData: bars.length === 0 };
}
