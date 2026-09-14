import type { Timeframe } from '@/components/chart/types';

// ResolutionString is not exported from the charting library; define locally.
export type ResolutionString = string;

/**
 * Maps a Timeframe prop value to a UDF resolution string expected by TradingView.
 * Unrecognised values fall back to "5".
 */
export function toUdfResolution(timeframe: Timeframe): ResolutionString {
  switch (timeframe) {
    case '1m':  return '1';
    case '2m':  return '2';
    case '3m':  return '3';
    case '5m':  return '5';
    case '10m': return '10';
    case '15m': return '15';
    case '30m': return '30';
    case '60m': return '60';
    case 'day': return 'D';
    default:    return '5';
  }
}

/**
 * Maps a UDF resolution string to a Kite (Zerodha) interval string.
 * Unrecognised values fall back to "5minute".
 */
export function resolutionToKiteInterval(r: ResolutionString): string {
  switch (r) {
    case '1':  case '1m': return 'minute';
    case '2':  case '2m': return '2minute';
    case '3':  case '3m': return '3minute';
    case '5':  case '5m': return '5minute';
    case '10': case '10m': return '10minute';
    case '15': case '15m': return '15minute';
    case '30': case '30m': return '30minute';
    case '60': case '60m': case '1h': return '60minute';
    case 'D':  case '1d':  case 'day': return 'day';
    default:   return '5minute';
  }
}

/**
 * Maps a UDF resolution string to a Binance klines interval string.
 * Unrecognised values fall back to "5m".
 */
export function resolutionToBinanceInterval(r: ResolutionString): string {
  switch (r) {
    case '1':  case '1m': return '1m';
    case '2':  case '2m': return '1m'; // fallback
    case '3':  case '3m': return '3m';
    case '5':  case '5m': return '5m';
    case '10': case '10m': return '5m'; // fallback
    case '15': case '15m': return '15m';
    case '30': case '30m': return '30m';
    case '60': case '60m': case '1h': return '1h';
    case 'D':  case '1d':  case 'day': return '1d';
    default:   return '5m';
  }
}

/**
 * Maps a UDF resolution string to its duration in milliseconds.
 * Unrecognised values fall back to 300000 (5 minutes).
 */
export function resolutionToMs(r: ResolutionString): number {
  switch (r) {
    case '1':  case '1m': return 60_000;
    case '2':  case '2m': return 120_000;
    case '3':  case '3m': return 180_000;
    case '5':  case '5m': return 300_000;
    case '10': case '10m': return 600_000;
    case '15': case '15m': return 900_000;
    case '30': case '30m': return 1_800_000;
    case '60': case '60m': case '1h': return 3_600_000;
    case 'D':  case '1d':  case 'day': return 86_400_000;
    default:   return 300_000;
  }
}

/**
 * Maps chart type prop values to the integer codes used by the TradingView widget.
 */
export const CHART_TYPE_MAP = {
  bar:      0,
  candle:   1,
  area:     3,
  baseline: 10,
} as const;
