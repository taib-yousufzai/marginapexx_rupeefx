/**
 * lib/trading/SymbolMapping.ts
 *
 * Canonical mapping helpers for segment labels, feed detection, and
 * TradingInstrument construction.
 *
 * All local `mapSegmentToDbSegment` copies in TradeSheet.tsx, TradingChart.tsx
 * and watchlist/page.tsx should be removed in favour of this import.
 */

import type { TradingInstrument, Segment, InstrumentFeed, ChartInstrument } from '@/lib/types/instrument';
import type { WatchlistItem } from '@/app/watchlist/InstrumentRow';
import type { MyPosition } from '@/lib/types/order';

// ─── Segment normalization ─────────────────────────────────────────────────

/** All accepted UI display labels → DB-normalized segment keys */
const SEGMENT_MAP: Record<string, Segment> = {
  // Index F&O
  'NSE - Futures':       'INDEX-FUT',
  'BSE - Futures':       'INDEX-FUT',
  'NFO - Futures':       'INDEX-FUT',
  'BFO - Futures':       'INDEX-FUT',
  'NSE - Options':       'INDEX-OPT',
  'BSE - Options':       'INDEX-OPT',
  'NFO - Options':       'INDEX-OPT',
  'BFO - Options':       'INDEX-OPT',
  // Stock F&O
  'NSE - Stock Futures': 'STOCK-FUT',
  'BSE - Stock Futures': 'STOCK-FUT',
  'NFO - Stock Futures': 'STOCK-FUT',
  'BFO - Stock Futures': 'STOCK-FUT',
  'NSE - Stock Options': 'STOCK-OPT',
  'BSE - Stock Options': 'STOCK-OPT',
  'NFO - Stock Options': 'STOCK-OPT',
  'BFO - Stock Options': 'STOCK-OPT',
  // MCX
  'MCX - Futures':       'MCX-FUT',
  'MCX-FUT':             'MCX-FUT',
  'MCX':                 'MCX-FUT',
  'MCX - Options':       'MCX-OPT',
  'MCX-OPT':             'MCX-OPT',
  // Equity
  'NSE - Equity':        'STOCKS',
  'NSE-EQ':              'STOCKS',
  'Equity':              'STOCKS',
  'EQUITY':              'STOCKS',
  'STOCKS':              'STOCKS',
  'Stocks':              'STOCKS',
  'BSE - Equity':        'STOCKS',
  'BSE-EQ':              'STOCKS',
  'BSE':                 'STOCKS',
  // Crypto / Forex / COMEX — already normalized
  'CRYPTO':              'CRYPTO',
  'Crypto':              'CRYPTO',
  'FOREX':               'FOREX',
  'Forex':               'FOREX',
  'CDS - Futures':       'FOREX',
  'CDS - Options':       'FOREX',
  'COMEX':               'COMEX',
  'COMEX - Futures':     'COMEX',
  'COMEX - Options':     'COMEX',
  'COI':                 'COMEX',
  'US - Equity':         'US-EQ',
  'US-EQ':               'US-EQ',
  'US Equity':           'US-EQ',
  'US':                  'US-EQ',
  // Legacy pass-throughs
  'INDEX-FUT':           'INDEX-FUT',
  'INDEX-OPT':           'INDEX-OPT',
  'STOCK-FUT':           'STOCK-FUT',
  'STOCK-OPT':           'STOCK-OPT',
  'NFO-OPT':             'INDEX-OPT',
  'BFO-OPT':             'INDEX-OPT',
  'NFO-FUT':             'INDEX-FUT',
  'NSE':                 'STOCKS',
};

/**
 * Converts any segment label (UI display string OR already-normalized DB key)
 * to the canonical DB-segment key.
 *
 * Falls back to returning the input string trimmed when no mapping is found —
 * this preserves existing behaviour in edge cases while the codebase migrates.
 */
export function mapSegmentToDbSegment(s: string): Segment {
  if (!s) return 'STOCKS';
  const trimmed = s.trim();
  return (SEGMENT_MAP[trimmed] ?? trimmed) as Segment;
}

/**
 * Segment normalization with optional symbol-based fallback inference.
 * When `symbol` is provided, crypto/MCX/option/equity is inferred from
 * the symbol string if the segment label alone is insufficient.
 *
 * This is a superset of `mapSegmentToDbSegment` that handles the TradeSheet
 * use-case where `item.segment` may be a vague label and `item.symbol` can
 * disambiguate.
 */
export function mapSegmentWithSymbol(segment: string, symbol: string = ''): Segment {
  if (!segment && !symbol) return 'STOCKS';

  const seg = segment.trim().toUpperCase();
  const sym = symbol.toUpperCase();

  // Symbol-first: US, forex & crypto symbols check
  if (sym) {
    if (sym.startsWith('US:') || sym.startsWith('US-EQ:')) return 'US-EQ';
    if (sym.startsWith('FOREX:')) return 'FOREX';
    const cleanSym = sym.includes(':') ? sym.split(':')[1] : sym;
    const FOREX_PAIRS = ['GBPUSD', 'EURUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'];
    if (FOREX_PAIRS.includes(cleanSym)) return 'FOREX';

    const CRYPTO_BASES = ['BTC','ETH','DOGE','SOL','XRP','ADA','BNB','DOT','LTC','AVAX','MATIC'];
    if (CRYPTO_BASES.some(c => sym === c || sym.startsWith(c + 'USDT'))) return 'CRYPTO';
    if (sym.endsWith('USDT')) return 'CRYPTO';

    // MCX commodities
    if (sym.includes('GOLD') || sym.includes('SILVER') || sym.includes('CRUDE') || sym.includes('NATURALGAS') || sym.includes('NATGAS') || sym.includes('COPPER') || sym.includes('ZINC') || sym.includes('LEAD') || sym.includes('ALUMINIUM') || sym.includes('NICKEL')) {
      if (sym.endsWith('CE') || sym.endsWith('PE')) return 'MCX-OPT';
      return 'MCX-FUT';
    }
    // Index derivatives
    if (sym.includes('NIFTY') || sym.includes('SENSEX') || sym.includes('BANKEX')) {
      if (sym.endsWith('CE') || sym.endsWith('PE')) return 'INDEX-OPT';
      return 'INDEX-FUT';
    }
    if (sym.endsWith('CE') || sym.endsWith('PE')) return 'STOCK-OPT';
    if (sym.endsWith('FUT')) return 'STOCK-FUT';
    if (sym.includes('-') || sym.includes('/')) return 'FOREX';
  }

  // Fall back to label-based mapping
  return mapSegmentToDbSegment(segment);
}

/**
 * Infers the DB-segment from an instrument symbol string alone.
 * Less reliable than using the explicit segment label — use only as a fallback.
 */
export function mapSymbolToSegment(symbol: string): Segment {
  const n = symbol.toUpperCase();
  if (n.startsWith('US:') || n.startsWith('US-EQ:')) return 'US-EQ';
  if (n.includes('GOLD') || n.includes('SILVER') || n.includes('CRUDE') || n.includes('NATGAS') || n.includes('NATURALGAS')) {
    if (n.endsWith('CE') || n.endsWith('PE')) return 'MCX-OPT';
    return 'MCX-FUT';
  }
  const isIndexName = n.includes('NIFTY') || n.includes('SENSEX') || n.includes('BANKEX') || n.includes('FINNIFTY') || n.includes('MIDCP') || n.includes('MIDCAP');
  if (n.endsWith('CE') || n.endsWith('PE')) {
    if (isIndexName) {
      return 'INDEX-OPT';
    }
    return 'STOCK-OPT';
  }
  if (n.endsWith('FUT') || n.includes('FUTURES')) {
    if (isIndexName) {
      return 'INDEX-FUT';
    }
    return 'STOCK-FUT';
  }
  if (isIndexName) {
    return 'INDEX-FUT';
  }
  if (n.endsWith('USDT') || ['BTC','ETH','DOGE','SOL','XRP','ADA','BNB','DOT','LTC','AVAX','MATIC'].some(c => n === c)) {
    return 'CRYPTO';
  }
  return 'STOCKS';
}

// ─── Feed detection ────────────────────────────────────────────────────────

/**
 * Derives the `InstrumentFeed` from which symbol fields are populated.
 * This is the single source of truth for feed attribution.
 */
export function detectFeed(
  binanceSymbol: string | undefined,
  kiteSymbol: string | undefined,
  comexSymbol: string | undefined,
): InstrumentFeed {
  if (binanceSymbol) return 'binance';
  if (kiteSymbol && comexSymbol) return 'dual';
  if (comexSymbol) return 'comex';
  return 'kite';
}

// ─── Mappers ───────────────────────────────────────────────────────────────

/**
 * Converts a `WatchlistItem` (including the dynamically-set `preferredView`
 * and `lotSize` fields) to the canonical `TradingInstrument`.
 *
 * Call this once at the trade/chart open site instead of casting via `as any`.
 */
export function fromWatchlistItem(item: WatchlistItem & {
  preferredView?: 'kite' | 'comex';
  lotSize?: number;
  expiry?: string;
  category?: string;
}): TradingInstrument {
  return {
    name:          item.name,
    symbol:        item.symbol,
    kiteSymbol:    item.kiteSymbol,
    binanceSymbol: item.binanceSymbol,
    comexSymbol:   item.comexSymbol,
    comexName:     (item as any).comexName,
    segment:       mapSegmentToDbSegment(item.segment),
    feed:          detectFeed(item.binanceSymbol, item.kiteSymbol, item.comexSymbol),
    category:      item.category,
    expiry:        item.expiry ?? item.contractDate ?? '',
    lotSize:       item.lotSize,
    price:         item.price,
    change:        item.change,
    open:          item.open,
    high:          item.high,
    low:           item.low,
    close:         item.close,
    preferredView: item.preferredView,
  };
}

/**
 * Converts a `TradingInstrument` back to the shape `WatchlistItem` expects.
 * Needed for passing to components that still accept WatchlistItem.
 */
export function toWatchlistItem(instr: TradingInstrument): WatchlistItem & {
  contractDate: string;
  lotSize?: number;
  category?: string;
  preferredView?: 'kite' | 'comex';
} {
  return {
    name:          instr.name,
    symbol:        instr.symbol,
    kiteSymbol:    instr.kiteSymbol,
    binanceSymbol: instr.binanceSymbol,
    comexSymbol:   instr.comexSymbol,
    comexName:     instr.comexName,
    segment:       instr.segment,
    contractDate:  instr.expiry,
    price:         instr.price,
    change:        instr.change,
    open:          instr.open,
    high:          instr.high,
    low:           instr.low,
    close:         instr.close,
    lotSize:       instr.lotSize,
    category:      instr.category,
    preferredView: instr.preferredView,
  };
}

/**
 * Builds the minimal ChartInstrument needed to open TradingChart from a
 * TradingInstrument, resolving the correct feed-specific symbol.
 */
export function toChartInstrument(instr: TradingInstrument): ChartInstrument {
  const useComex = instr.preferredView === 'comex' && !!instr.comexSymbol;
  return {
    name:          instr.name,
    symbol:        useComex
      ? (instr.comexSymbol ?? instr.symbol)
      : (instr.binanceSymbol ?? instr.kiteSymbol ?? instr.symbol),
    kiteSymbol:    instr.kiteSymbol,
    segment:       useComex ? 'COMEX' : instr.segment,
    binanceSymbol: instr.binanceSymbol,
    comexSymbol:   instr.comexSymbol,
    price:         instr.price,
    preferredView: instr.preferredView,
  };
}

/**
 * Builds a minimal ChartInstrument from an open position.
 * Used in position/page.tsx and order/page.tsx openChart handlers.
 */
export function fromPosition(pos: Pick<MyPosition,
  'symbol' | 'kite_instrument' | 'settlement' | 'ltp'
> & { current_ltp?: number }): ChartInstrument {
  const settlement = (pos.settlement || '').toUpperCase();
  let segment: string = pos.settlement ?? 'STOCKS';
  if (segment === 'NSE-EQ') segment = 'STOCKS';
  if (settlement.includes('CRYPTO') || pos.symbol.endsWith('USDT')) {
    segment = 'CRYPTO';
  } else if (settlement.includes('COMEX') || pos.symbol.endsWith('=F')) {
    segment = 'COMEX';
  }

  return {
    name:       pos.symbol,
    symbol:     pos.symbol,
    kiteSymbol: pos.kite_instrument ?? pos.symbol,
    segment,
    price:      pos.current_ltp ?? pos.ltp ?? 0,
  };
}

/**
 * Builds a minimal ChartInstrument from an order row.
 * Used in order/page.tsx openChart handler.
 */
export function fromOrder(order: {
  symbol: string;
  kite_instrument?: string;
  segment: string;
}): ChartInstrument {
  return {
    symbol:     order.symbol,
    kiteSymbol: order.kite_instrument ?? order.symbol,
    segment:    order.segment,
  };
}

/**
 * Builds a minimal ChartInstrument for an option contract from the
 * option-chain page's selectedContract + resolved kite ID.
 */
export function fromOptionContract(opts: {
  symbol: string;
  kiteId?: string;
  underlyingSymbol: string;
}): ChartInstrument {
  const isBFO = opts.underlyingSymbol.toUpperCase().includes('SENSEX') ||
                opts.underlyingSymbol.toUpperCase().includes('BANKEX');
  return {
    symbol:     opts.symbol,
    kiteSymbol: opts.kiteId ?? opts.symbol,
    segment:    isBFO ? 'BFO' : 'NFO',
  };
}
