/**
 * lib/types/instrument.ts
 *
 * The single canonical type for any tradeable instrument in this app.
 *
 * Replaces:
 *   WatchlistItem   (app/watchlist/page.tsx + InstrumentRow.tsx)
 *   TradeSheetItem  (components/TradeSheet.tsx)
 *   ChartItem       (ad-hoc any objects in order/position/option-chain pages)
 *   TradingInstrument (inline interface in watchlist/page.tsx)
 *   selectedContract  (partial instrument in option-chain/page.tsx)
 *
 * Design decisions:
 *   - `segment` is ALWAYS the DB-normalized key ('INDEX-FUT', 'CRYPTO', …).
 *     UI labels ('NSE - Futures') must be mapped at ingestion using
 *     `mapSegmentToDbSegment` from lib/trading/SymbolMapping.ts.
 *   - `expiry` replaces both `contractDate` and `expiry` (same data, two names).
 *   - `lotSize` is always camelCase.
 *   - `preferredView` is a runtime UI toggle — not persisted or passed via API.
 *   - Feed attribution is explicit via the `feed` discriminant field.
 */

import type { OptionType } from '@/lib/positionValidator';

// ─── Segment ─────────────────────────────────────────────────────────────────

/**
 * All valid DB-normalized segment keys.
 * Matches the values stored in segment_settings / scalper_segment_settings.
 */
export type Segment =
  | 'INDEX-FUT'
  | 'INDEX-OPT'
  | 'STOCK-FUT'
  | 'STOCK-OPT'
  | 'MCX-FUT'
  | 'MCX-OPT'
  | 'STOCKS'
  | 'BSE-EQ'
  | 'CRYPTO'
  | 'FOREX'
  | 'COMEX'
  | 'US-EQ';

// ─── Data feed ────────────────────────────────────────────────────────────────

/**
 * Which price feed drives this instrument's live quote.
 *
 * - `kite`    — Zerodha Kite websocket (most equity/F&O/MCX instruments)
 * - `binance` — Binance REST/WS (crypto)
 * - `comex`   — Direct COMEX USD prices
 * - `dual`    — MCX commodity that also has a COMEX USD counterpart;
 *               the user can toggle between ₹MCX and $COMEX views.
 */
export type InstrumentFeed = 'kite' | 'binance' | 'comex' | 'dual';

// ─── Core type ───────────────────────────────────────────────────────────────

export interface TradingInstrument {
  // ── Identity ──────────────────────────────────────────────────────────────

  /** Short display name e.g. 'NIFTY FUT', 'Gold Mini', 'BTCUSDT' */
  name: string;

  /**
   * Internal trading symbol / DB key.
   * For F&O: the tradingsymbol e.g. 'NIFTY25DECFUT'.
   * For equity: e.g. 'INFY'.
   * For crypto: e.g. 'BTC' or 'BTCUSDT'.
   */
  symbol: string;

  /**
   * Kite instrument key — 'EXCHANGE:TRADINGSYMBOL'.
   * Used as the key for Kite quote subscriptions and order placement.
   * e.g. 'NFO:NIFTY25DECFUT', 'MCX:GOLD26AUGFUT', 'NSE:INFY'
   * For crypto/comex instruments this may be empty string.
   */
  kiteSymbol: string;

  /**
   * Binance symbol — only present for crypto instruments.
   * e.g. 'BTCUSDT'
   */
  binanceSymbol?: string;

  /**
   * COMEX symbol — only present for COMEX instruments.
   * e.g. 'GC=F' (Gold), 'CL=F' (Crude Oil)
   */
  comexSymbol?: string;

  /**
   * Display name for the COMEX side when hasDualView is true.
   * e.g. 'Gold', 'Crude Oil'
   */
  comexName?: string;

  // ── Classification ─────────────────────────────────────────────────────────

  /**
   * DB-normalized segment key. ALWAYS one of the `Segment` union members.
   * Use `mapSegmentToDbSegment()` at ingestion to normalize UI labels.
   */
  segment: Segment;

  /**
   * Which price feed drives this instrument's live data.
   * Derived from which symbol fields are populated:
   *   binanceSymbol present                      → 'binance'
   *   comexSymbol present && kiteSymbol present  → 'dual'
   *   comexSymbol present && no kiteSymbol        → 'comex'
   *   otherwise                                  → 'kite'
   */
  feed: InstrumentFeed;

  /**
   * Watchlist category tag — used for drawer grouping.
   * e.g. 'INDEX-FUT', 'CRYPTO', 'COI'
   */
  category?: string;

  // ── Contract metadata ──────────────────────────────────────────────────────

  /**
   * Human-readable expiry / contract date.
   * e.g. 'Aug 2026', '26 Jun 2025', 'YYYY-MM-DD'
   * Replaces both `contractDate` (WatchlistItem) and `expiry` (TradeSheetItem).
   */
  expiry: string;

  /** Lot size from DB script_settings or hardcoded fallback */
  lotSize?: number;

  // ── Option-specific ────────────────────────────────────────────────────────

  /** Strike price — only for options */
  strike?: number;

  /** CE or PE — only for options */
  optionType?: OptionType;

  /** Underlying symbol for options/futures e.g. 'NIFTY' */
  underlying?: string;

  // ── Snapshot price data ───────────────────────────────────────────────────

  /** Last known price at time of watchlist load / search */
  price: number;

  /** Change string e.g. '+0.45%', '-1.2' */
  change: string;

  open: number;
  high: number;
  low: number;
  close: number;

  // ── Runtime UI state ──────────────────────────────────────────────────────

  /**
   * MCX ↔ COMEX view toggle for dual-feed instruments.
   * Set at click time in InstrumentRow; NOT persisted.
   */
  preferredView?: 'kite' | 'comex';
}

// ─── Chart-only minimal shape ─────────────────────────────────────────────────

/**
 * Minimal instrument shape sufficient for TradingChart.
 * All chartItem state can be typed as this instead of `any`.
 */
export interface ChartInstrument {
  name?: string;
  symbol: string;
  kiteSymbol: string;
  segment: string;   // accepts both DB keys and UI labels — TradingChart normalizes internally
  binanceSymbol?: string;
  comexSymbol?: string;
  price?: number;
  preferredView?: 'kite' | 'comex';
}
