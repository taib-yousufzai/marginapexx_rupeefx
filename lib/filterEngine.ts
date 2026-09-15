/**
 * filterEngine.ts
 *
 * Centralised Filter Engine for instrument and contract filtering.
 * All filtering is applied at the backend API layer (serve path only).
 * The data ingestion pipeline (sync-instruments cron) must NOT import this module.
 *
 * Requirements: 1.1, 1.2, 2.2, 3.2, 4.1, 4.2, 5.1, 5.2, 6.1, 9.8
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface StrikeConfig {
  indexOptionsRange: number; // default: 5
  mcxOptionsRange: number;   // default: 7
}

export interface FilterContext {
  strikeConfig: StrikeConfig;
  atmPrices: Record<string, number>; // symbol → current market price
  today: string;                     // ISO date string "YYYY-MM-DD"
}

export interface FilterLog {
  event: 'instrument_excluded';
  symbol: string;
  rule: 'FOREX_OPTIONS' | 'CRYPTO_WHITELIST' | 'STRIKE_RANGE' | 'EXPIRY_FILTER';
  segment: string;
  timestamp: string;
}

export interface Instrument {
  id?: string;
  tradingsymbol: string;
  name?: string;
  exchange: string;
  instrument_type: string;
  segment?: string;
  underlying_symbol?: string;
  option_type?: string; // 'CE' | 'PE' | null
  strike_price?: number;
  expiry?: string;
}

export type SegmentKey = string;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STRIKE_CONFIG: StrikeConfig = {
  indexOptionsRange: 11,
  mcxOptionsRange: 22,
};

const CRYPTO_WHITELIST = new Set(['BTC', 'ETH', 'DOGE']);

// ---------------------------------------------------------------------------
// loadStrikeConfig
// ---------------------------------------------------------------------------

/**
 * Queries the admin_config table for strike range configuration values.
 * Falls back to defaults on missing rows or any DB error.
 * Never throws.
 *
 * Requirements: 2.1, 2.6, 3.1, 3.6
 */
export async function loadStrikeConfig(supabase: SupabaseClient): Promise<StrikeConfig> {
  try {
    const { data, error } = await supabase
      .from('admin_config')
      .select('key, value')
      .in('key', ['index_options_strike_range', 'mcx_options_strike_range']);

    if (error) {
      console.error('[filterEngine] loadStrikeConfig DB error:', error.message);
      return { ...DEFAULT_STRIKE_CONFIG };
    }

    if (!data || data.length === 0) {
      return { ...DEFAULT_STRIKE_CONFIG };
    }

    const rowMap: Record<string, string> = {};
    for (const row of data) {
      rowMap[row.key] = row.value;
    }

    const indexRaw = rowMap['index_options_strike_range'];
    const mcxRaw = rowMap['mcx_options_strike_range'];

    // Force index options range to 11 (5 up, 5 down, 1 ATM) as per user request
    const indexOptionsRange = 11;

    const mcxOptionsRange =
      mcxRaw !== undefined
        ? (parseInt(mcxRaw, 10) || DEFAULT_STRIKE_CONFIG.mcxOptionsRange)
        : DEFAULT_STRIKE_CONFIG.mcxOptionsRange;

    return { indexOptionsRange, mcxOptionsRange };
  } catch (err) {
    console.error('[filterEngine] loadStrikeConfig unexpected error:', err);
    return { ...DEFAULT_STRIKE_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// isForexOption
// ---------------------------------------------------------------------------

/**
 * Returns true when the instrument is a Forex CE or PE contract.
 * Forex Futures (CDS FUT) and all non-CDS instruments return false.
 *
 * Requirements: 1.1, 1.2
 */
export function isForexOption(instrument: Instrument): boolean {
  const isCds =
    instrument.segment === 'CDS' || instrument.exchange === 'CDS';
  const isOption =
    instrument.option_type === 'CE' || instrument.option_type === 'PE';
  return isCds && isOption;
}

// ---------------------------------------------------------------------------
// applyForexFilter
// ---------------------------------------------------------------------------

/**
 * Filters out all Forex CE/PE contracts from the list.
 * Emits a structured console.log (FilterLog) for each excluded item
 * only in development to avoid production log spam.
 *
 * Requirements: 1.1, 9.8
 */
export function applyForexFilter(instruments: Instrument[]): Instrument[] {
  const result: Instrument[] = [];
  const isDev = process.env.NODE_ENV !== 'production';
  let excludedCount = 0;

  for (const instrument of instruments) {
    if (isForexOption(instrument)) {
      excludedCount++;
    } else {
      result.push(instrument);
    }
  }

  if (isDev && excludedCount > 0) {
    console.log(`[filterEngine] Excluded ${excludedCount} instruments due to FOREX_OPTIONS`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// applyCryptoWhitelist
// ---------------------------------------------------------------------------

/**
 * Keeps only instruments whose underlying_symbol or name is one of
 * BTC, ETH, DOGE (case-insensitive). Logs each exclusion.
 *
 * Requirements: 5.1, 5.2, 9.8
 */
export function applyCryptoWhitelist(instruments: Instrument[]): Instrument[] {
  const result: Instrument[] = [];
  const isDev = process.env.NODE_ENV !== 'production';
  let excludedCount = 0;

  for (const instrument of instruments) {
    const symbolRaw = instrument.underlying_symbol ?? instrument.name ?? '';
    const symbol = symbolRaw.toUpperCase();

    if (CRYPTO_WHITELIST.has(symbol)) {
      result.push(instrument);
    } else {
      excludedCount++;
    }
  }

  if (isDev && excludedCount > 0) {
    console.log(`[filterEngine] Excluded ${excludedCount} instruments due to CRYPTO_WHITELIST`);
  }

  return result;
}

export function applyStrikeRangeFilter(
  instruments: Instrument[],
  atmPrice: number,
  range: number,
): Instrument[] {
  const others = instruments.filter((i) => i.option_type !== 'CE' && i.option_type !== 'PE');
  const options = instruments.filter((i) => i.option_type === 'CE' || i.option_type === 'PE');

  if (options.length === 0) return others;

  // Extract unique strikes and sort them
  const strikes = Array.from(new Set(options.map((i) => i.strike_price ?? 0))).sort((a, b) => a - b);

  if (strikes.length === 0) return others;

  // Find the exact closest strike index
  let closestIdx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const diff = Math.abs(strikes[i] - atmPrice);
    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = i;
    }
  }

  // Calculate slice boundaries
  const half = Math.floor(range / 2);
  let startIdx = closestIdx - half;
  let endIdx = closestIdx + half;

  // Adjust if hitting boundaries (to maintain total range count if possible)
  if (startIdx < 0) {
    endIdx += Math.abs(startIdx);
    startIdx = 0;
  }
  if (endIdx >= strikes.length) {
    const excess = endIdx - (strikes.length - 1);
    startIdx = Math.max(0, startIdx - excess);
    endIdx = strikes.length - 1;
  }

  const selectedStrikes = new Set(strikes.slice(startIdx, endIdx + 1));

  const kept = options.filter((i) => selectedStrikes.has(i.strike_price ?? 0));
  const excluded = options.filter((i) => !selectedStrikes.has(i.strike_price ?? 0));

  if (process.env.NODE_ENV !== 'production' && excluded.length > 0) {
    console.log(`[filterEngine] Excluded ${excluded.length} instruments due to STRIKE_RANGE`);
  }

  return [...others, ...kept];
}

// ---------------------------------------------------------------------------
// applyMcxStrikeRangeFilter
// ---------------------------------------------------------------------------

/**
 * MCX-specific strike range filter. Now forwards to the perfectly centered unified algorithm.
 */
export const MCX_STRIKES_PER_DIRECTION = 10;

export function applyMcxStrikeRangeFilter(
  instruments: Instrument[],
  atmPrice: number,
): Instrument[] {
  return applyStrikeRangeFilter(instruments, atmPrice, 22);
}

// ---------------------------------------------------------------------------
/**
 * Checks whether an expiry date string 'YYYY-MM-DD' has already expired based on current IST time.
 * For daytime markets (NSE/BSE/NFO/BFO), contracts expire at 15:30 IST on expiry day.
 * For MCX commodity options, contracts expire at 23:30 IST on expiry day.
 */
export function isExpiryDateExpired(expiryDateStr: string, isMcx: boolean = false): boolean {
  if (!expiryDateStr) return true;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  const hour = parts.find(p => p.type === 'hour')?.value;
  const minute = parts.find(p => p.type === 'minute')?.value;

  if (!year || !month || !day || !hour || !minute) return false;

  const todayStr = `${year}-${month}-${day}`;
  if (expiryDateStr < todayStr) return true;
  if (expiryDateStr > todayStr) return false;

  // It is today! Check market close cutoff time (15:30 for NSE/BSE, 23:30 for MCX)
  const currentMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);
  const cutoffMinutes = isMcx ? (23 * 60 + 30) : (15 * 60 + 30);

  return currentMinutes >= cutoffMinutes;
}

// ---------------------------------------------------------------------------
// applyExpiryFilter
// ---------------------------------------------------------------------------

/**
 * Returns active expiry dates that have not expired.
 * Filters out today's expiry if current time is past market close (15:30 IST).
 * Dates must be ISO strings 'YYYY-MM-DD'.
 */
export function applyExpiryFilter(expiries: string[], today?: string, isMcx: boolean = false): string[] {
  const active = expiries.filter((expiry) => !isExpiryDateExpired(expiry, isMcx));

  if (active.length === 0) {
    return [];
  }

  return Array.from(new Set(active)).sort();
}

// ---------------------------------------------------------------------------
// applyAllFilters
// ---------------------------------------------------------------------------

/**
 * Master filter function that composes all rules per segment.
 *
 * Segment routing:
 *  - 'CDS'           → applyForexFilter
 *  - 'CRYPTO'/'BCD'  → applyCryptoWhitelist
 *  - 'NFO'           → applyExpiryFilter on expiries, then applyStrikeRangeFilter
 *                       with ctx.strikeConfig.indexOptionsRange
 *  - 'MCX' options   → applyExpiryFilter on expiries, then applyStrikeRangeFilter
 *                       with ctx.strikeConfig.mcxOptionsRange
 *  - All other option segments → applyExpiryFilter on expiries first
 *
 * Requirements: 1.1, 2.2, 3.2, 4.1, 4.2, 5.1, 5.2, 6.1
 */
export function applyAllFilters(
  instruments: Instrument[],
  segment: SegmentKey,
  ctx: FilterContext,
): Instrument[] {
  const seg = segment.toUpperCase();

  // Forex segment: remove CE/PE options
  if (seg === 'CDS') {
    return applyForexFilter(instruments);
  }

  // Crypto segment: whitelist BTC, ETH, DOGE
  if (seg === 'CRYPTO' || seg === 'BCD') {
    return applyCryptoWhitelist(instruments);
  }

  // Index options (NFO)
  if (seg === 'NFO') {
    const withActiveExpiry = filterByActiveExpiry(instruments, ctx.today);
    const optionInstruments = withActiveExpiry.filter(
      (i) => i.option_type === 'CE' || i.option_type === 'PE',
    );
    const nonOptionInstruments = withActiveExpiry.filter(
      (i) => i.option_type !== 'CE' && i.option_type !== 'PE',
    );

    const atmPrice = resolveAtmPrice(optionInstruments, ctx.atmPrices);
    if (atmPrice === null) {
      return withActiveExpiry;
    }

    return [
      ...nonOptionInstruments,
      ...applyStrikeRangeFilter(optionInstruments, atmPrice, ctx.strikeConfig.indexOptionsRange),
    ];
  }

  // MCX options
  if (seg === 'MCX') {
    const withActiveExpiry = filterByActiveExpiry(instruments, ctx.today);
    const optionInstruments = withActiveExpiry.filter(
      (i) => i.option_type === 'CE' || i.option_type === 'PE',
    );
    const nonOptionInstruments = withActiveExpiry.filter(
      (i) => i.option_type !== 'CE' && i.option_type !== 'PE',
    );

    const atmPrice = resolveAtmPrice(optionInstruments, ctx.atmPrices);
    if (atmPrice === null) {
      return withActiveExpiry;
    }

    return [
      ...nonOptionInstruments,
      ...applyStrikeRangeFilter(optionInstruments, atmPrice, ctx.strikeConfig.mcxOptionsRange),
    ];
  }

  // All other segments with options: apply expiry filtering only
  const hasOptions = instruments.some(
    (i) => i.option_type === 'CE' || i.option_type === 'PE',
  );
  if (hasOptions) {
    return filterByActiveExpiry(instruments, ctx.today);
  }

  // No applicable rules — return as-is
  return instruments;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Filters instruments to those with the nearest active expiry.
 * Non-option instruments (no expiry) are passed through unchanged.
 */
function filterByActiveExpiry(instruments: Instrument[], today: string): Instrument[] {
  const withExpiry = instruments.filter((i) => i.expiry !== undefined && i.expiry !== null);
  const withoutExpiry = instruments.filter((i) => i.expiry === undefined || i.expiry === null);

  const expiries = [...new Set(withExpiry.map((i) => i.expiry as string))];
  const activeExpiries = applyExpiryFilter(expiries, today);

  if (activeExpiries.length === 0) {
    // No active expiries
    if (process.env.NODE_ENV !== 'production') {
      const timestamp = new Date().toISOString();
      for (const instrument of withExpiry) {
        const log: FilterLog = {
          event: 'instrument_excluded',
          symbol: instrument.tradingsymbol,
          rule: 'EXPIRY_FILTER',
          segment: instrument.segment ?? instrument.exchange ?? '',
          timestamp,
        };
        console.log(JSON.stringify(log));
      }
    }
    return withoutExpiry;
  }

  const activeSet = new Set(activeExpiries);
  const kept: Instrument[] = [];

  for (const instrument of withExpiry) {
    if (activeSet.has(instrument.expiry as string)) {
      kept.push(instrument);
    } else if (process.env.NODE_ENV !== 'production') {
      const timestamp = new Date().toISOString();
      const log: FilterLog = {
        event: 'instrument_excluded',
        symbol: instrument.tradingsymbol,
        rule: 'EXPIRY_FILTER',
        segment: instrument.segment ?? instrument.exchange ?? '',
        timestamp,
      };
      console.log(JSON.stringify(log));
    }
  }

  return [...withoutExpiry, ...kept];
}

/**
 * Resolves the ATM price for a set of option instruments from the atmPrices map.
 * Returns null when no price can be found (triggers fallback to all-strikes).
 */
function resolveAtmPrice(
  instruments: Instrument[],
  atmPrices: Record<string, number>,
): number | null {
  for (const instrument of instruments) {
    const symbol = instrument.underlying_symbol ?? instrument.name ?? instrument.tradingsymbol;
    if (symbol && atmPrices[symbol] !== undefined) {
      return atmPrices[symbol];
    }
  }
  return null;
}
