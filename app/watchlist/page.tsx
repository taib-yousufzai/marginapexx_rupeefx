'use client';
import { useState, useEffect, useRef, Suspense, useMemo } from 'react';
import { api, ApiError } from '@/lib/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useMarketQuotes, QuoteData } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';
import { ComexQuoteData } from '@/contexts/ComexDataContext';
import { useOrderEntry, OrderSide, OrderType, ProductType } from '@/hooks/useOrderEntry';
import { useActivePositions } from '@/hooks/useActivePositions';
import { useMobileBack } from '@/hooks/useMobileBack';
import { useBalance } from '@/hooks/useBalance';
import AnimatedLoader from '@/components/AnimatedLoader';
import dynamic from 'next/dynamic';
import { useTradeConfig } from '@/contexts/TradeConfigContext';
import { mapSegmentToDbSegment, mapSymbolToSegment, mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';
import { isForexSymbol } from '@/lib/datafeed/symbolResolver';
import { getCurrentFuturesSymbol } from '@/lib/contractExpiry';
import { resolveEffectivePrices } from '@/lib/trading/marketPriceResolver';
import { RiskValidation } from '@/lib/trading/RiskValidation';
import { generateRealisticFallbackQuote } from '@/lib/quoteFallback';

const TradingChart = dynamic(() => import('@/components/TradingChart'), { ssr: false });
const TradeSheet = dynamic(() => import('@/components/TradeSheet'), { ssr: false });
import WatchlistSearch from '@/components/WatchlistSearch';
import { getSavedTheme, applyTheme } from '@/lib/theme';

import { ErrorModal } from '@/components/ErrorModal';
import './page.css';

export interface WatchlistItem {
  name: string;
  symbol: string;
  kiteSymbol: string;
  binanceSymbol?: string;  // e.g. 'BTCUSDT' — crypto (Binance)
  comexSymbol?: string;  // e.g. 'GC=F'    — COMEX USD price (Yahoo Finance proxy, paired with kiteSymbol for MCX)
  comexName?: string;
  exchange?: string;
  price: number;
  change: string;
  segment: string;
  contractDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  category?: string;
  lotSize?: number;
}

declare global {
  interface Window {
    __kiteQuotes: Record<string, QuoteData>;
    __binanceQuotes: Record<string, QuoteData>;
    __comexQuotes: Record<string, ComexQuoteData>;
    __watchlistItems: WatchlistItem[];
    __renderWatchlist: () => void;
    __addToWatchlistCallback: (item: WatchlistItem) => void;
    __removeFromWatchlistCallback: (symbol: string) => void;
    __selectionModeActive?: boolean;
    __watchlistEventsAttached?: boolean;
    __isBasketModeActive?: boolean;
    __lastProcessedQuery?: string;
    __searchPriceInterval?: ReturnType<typeof setInterval> | null;
    __triggerSearch?: (query: string) => void;
  }
}

const WATCHLIST_KEY = 'marginApex_watchlist';

function loadWatchlistFromStorage(userId?: string): WatchlistItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const key = userId ? `${WATCHLIST_KEY}_${userId}` : WATCHLIST_KEY;
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as WatchlistItem[]) : [];
  } catch { return []; }
}

function saveWatchlistToStorage(items: WatchlistItem[], userId?: string) {
  try {
    const key = userId ? `${WATCHLIST_KEY}_${userId}` : WATCHLIST_KEY;
    localStorage.setItem(key, JSON.stringify(items));
  } catch { }
}

// ── Default Crypto Items (Binance) ──────────────────────────────────────────

// Crypto whitelist: only BTC, ETH, DOGE (Requirement 5.1)
const DEFAULT_CRYPTO_ITEMS: WatchlistItem[] = [
  { name: 'Bitcoin', symbol: 'BTC', kiteSymbol: '', binanceSymbol: 'BTCUSDT', price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
  { name: 'Ethereum', symbol: 'ETH', kiteSymbol: '', binanceSymbol: 'ETHUSDT', price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
  { name: 'Dogecoin', symbol: 'DOGE', kiteSymbol: '', binanceSymbol: 'DOGEUSDT', price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
];

// ── Default Forex Items (Zerodha CDS segment — INR pairs) ──────────────────
// Update expiry month as contracts roll (format: CDS:XYZINR26MONFUT)

const DEFAULT_FOREX_ITEMS: WatchlistItem[] = [
  { name: 'GBP/USD', symbol: 'GBPUSD', kiteSymbol: '', comexSymbol: 'GBPUSD=X', price: 0, change: '0%', segment: 'Forex', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'EUR/USD', symbol: 'EURUSD', kiteSymbol: '', comexSymbol: 'EURUSD=X', price: 0, change: '0%', segment: 'Forex', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'USD/JPY', symbol: 'USDJPY', kiteSymbol: '', comexSymbol: 'USDJPY=X', price: 0, change: '0%', segment: 'Forex', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'USD/CHF', symbol: 'USDCHF', kiteSymbol: '', comexSymbol: 'USDCHF=X', price: 0, change: '0%', segment: 'Forex', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'USD/CAD', symbol: 'USDCAD', kiteSymbol: '', comexSymbol: 'USDCAD=X', price: 0, change: '0%', segment: 'Forex', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'AUD/USD', symbol: 'AUDUSD', kiteSymbol: '', comexSymbol: 'AUDUSD=X', price: 0, change: '0%', segment: 'Forex', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'NZD/USD', symbol: 'NZDUSD', kiteSymbol: '', comexSymbol: 'NZDUSD=X', price: 0, change: '0%', segment: 'Forex', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'USD/INR', symbol: getCurrentFuturesSymbol('CDS', 'USDINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'USDINR'), price: 0, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'EUR/INR', symbol: getCurrentFuturesSymbol('CDS', 'EURINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'EURINR'), price: 0, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'GBP/INR', symbol: getCurrentFuturesSymbol('CDS', 'GBPINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'GBPINR'), price: 0, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'JPY/INR', symbol: getCurrentFuturesSymbol('CDS', 'JPYINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'JPYINR'), price: 0, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
];

// ── Default COMEX Items (MCX ₹ via Kite + COMEX $ via Yahoo proxy) ──────────────
// Rows with both kiteSymbol + comexSymbol show a ₹⇄$ toggle pill

const DEFAULT_COMEX_ITEMS: WatchlistItem[] = [
  { name: 'GOLD', symbol: 'XAUUSD', kiteSymbol: '', comexSymbol: 'XAUUSD', price: 4349.00, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 4349.00, high: 4350, low: 4340, close: 4349.00, category: 'COMEX' },
  { name: 'SILVER', symbol: 'XAGUSD', kiteSymbol: '', comexSymbol: 'XAGUSD', price: 65.20, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 65.20, high: 65.50, low: 64.90, close: 65.20, category: 'COMEX' },
  { name: 'CRUDE OIL', symbol: 'XTIUSD', kiteSymbol: '', comexSymbol: 'XTIUSD', price: 100.00, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 100.00, high: 100.80, low: 99.20, close: 100.00, category: 'COMEX' },
  { name: 'COPPER', symbol: 'XCUUSD', kiteSymbol: '', comexSymbol: 'XCUUSD', price: 6.55, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 6.55, high: 6.60, low: 6.50, close: 6.55, category: 'COMEX' },
];

const DEFAULT_US_ITEMS: WatchlistItem[] = [
  { name: 'Apple Inc.', symbol: 'US:AAPL', kiteSymbol: 'US:AAPL', price: 220, change: '0%', segment: 'US - Equity', contractDate: '', open: 220, high: 222.20, low: 217.80, close: 220, category: 'US-EQ' },
  { name: 'Tesla Inc.', symbol: 'US:TSLA', kiteSymbol: 'US:TSLA', price: 210, change: '0%', segment: 'US - Equity', contractDate: '', open: 210, high: 212.10, low: 207.90, close: 210, category: 'US-EQ' },
  { name: 'Nvidia Corp.', symbol: 'US:NVDA', kiteSymbol: 'US:NVDA', price: 120, change: '0%', segment: 'US - Equity', contractDate: '', open: 120, high: 121.20, low: 118.80, close: 120, category: 'US-EQ' },
  { name: 'Microsoft Corp.', symbol: 'US:MSFT', kiteSymbol: 'US:MSFT', price: 420, change: '0%', segment: 'US - Equity', contractDate: '', open: 420, high: 424.20, low: 415.80, close: 420, category: 'US-EQ' },
  { name: 'Amazon.com Inc.', symbol: 'US:AMZN', kiteSymbol: 'US:AMZN', price: 180, change: '0%', segment: 'US - Equity', contractDate: '', open: 180, high: 181.80, low: 178.20, close: 180, category: 'US-EQ' },
  { name: 'Netflix Inc.', symbol: 'US:NFLX', kiteSymbol: 'US:NFLX', price: 600, change: '0%', segment: 'US - Equity', contractDate: '', open: 600, high: 606.00, low: 594.00, close: 600, category: 'US-EQ' },
  { name: 'S&P 500 E-mini Futures', symbol: 'ES=F', kiteSymbol: '', comexSymbol: 'ES=F', price: 5500, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 5500, high: 5555, low: 5445, close: 5500, category: 'COMEX' },
  { name: 'Nasdaq 100 E-mini Futures', symbol: 'NQ=F', kiteSymbol: '', comexSymbol: 'NQ=F', price: 19500, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 19500, high: 19695, low: 19305, close: 19500, category: 'COMEX' },
  { name: 'Dow Jones E-mini Futures', symbol: 'YM=F', kiteSymbol: '', comexSymbol: 'YM=F', price: 41000, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 41000, high: 41410, low: 40590, close: 41000, category: 'COMEX' },
];

export function getDefaultWatchlistItems(): WatchlistItem[] {
  return [
    {
      name: 'NIFTY 50 INDEX',
      symbol: 'NIFTY_INDEX',
      kiteSymbol: 'NSE:NIFTY 50',
      price: 22456.80,
      change: '+0.45%',
      segment: 'NSE - Equity',
      contractDate: '',
      open: 22350,
      high: 22580,
      low: 22320,
      close: 22456.80
    },
    {
      name: 'BANKNIFTY INDEX',
      symbol: 'BANKNIFTY_INDEX',
      kiteSymbol: 'NSE:NIFTY BANK',
      price: 48210.50,
      change: '-0.21%',
      segment: 'NSE - Equity',
      contractDate: '',
      open: 48350,
      high: 48500,
      low: 48100,
      close: 48210.50
    },
    {
      name: 'SENSEX INDEX',
      symbol: 'SENSEX_INDEX',
      kiteSymbol: 'BSE:SENSEX',
      price: 74230.15,
      change: '+0.32%',
      segment: 'BSE - Equity',
      contractDate: '',
      open: 73950,
      high: 74500,
      low: 73800,
      close: 74230.15
    },
    ...DEFAULT_CRYPTO_ITEMS,
    ...DEFAULT_FOREX_ITEMS,
    ...DEFAULT_COMEX_ITEMS,
    ...DEFAULT_US_ITEMS,
  ];
}

// ── Tab Labels ──────────────────────────────────────────────────────────────

export type TabLabel =
  | 'All'
  | 'INDEX-FUT'
  | 'INDEX-OPT'
  | 'MCX-FUT'
  | 'MCX-OPT'
  | 'STOCK-FUT'
  | 'STOCK-OPT'
  | 'STOCKS'
  | 'CRYPTO'
  | 'COMEX'
  | 'FOREX'
  | 'US-EQ';

export const TAB_LABELS: TabLabel[] = [
  'All',
  'INDEX-FUT',
  'INDEX-OPT',
  'MCX-FUT',
  'MCX-OPT',
  'STOCK-FUT',
  'STOCK-OPT',
  'STOCKS',
  'CRYPTO',
  'COMEX',
  'FOREX',
  'US-EQ'
];

// ── Segment → Tab Mapping ────────────────────────────────────────────────────

export const SEGMENT_TAB_MAP: Record<string, TabLabel> = {
  'NSE - Futures': 'INDEX-FUT',
  'BSE - Futures': 'INDEX-FUT',
  'NFO - Futures': 'INDEX-FUT',
  'BFO - Futures': 'INDEX-FUT',
  'NSE - Options': 'INDEX-OPT',
  'BSE - Options': 'INDEX-OPT',
  'NFO - Options': 'INDEX-OPT',
  'BFO - Options': 'INDEX-OPT',
  'NSE - Stock Futures': 'STOCK-FUT',
  'BSE - Stock Futures': 'STOCK-FUT',
  'NFO - Stock Futures': 'STOCK-FUT',
  'BFO - Stock Futures': 'STOCK-FUT',
  'NSE - Stock Options': 'STOCK-OPT',
  'BSE - Stock Options': 'STOCK-OPT',
  'NFO - Stock Options': 'STOCK-OPT',
  'BFO - Stock Options': 'STOCK-OPT',
  'MCX - Futures': 'MCX-FUT',
  'MCX - Options': 'MCX-OPT',
  'MCX-FUT': 'MCX-FUT',
  'MCX-OPT': 'MCX-OPT',
  'NSE - Equity': 'STOCKS',
  'BSE - Equity': 'STOCKS',
  'NSE-EQ': 'STOCKS',
  'BSE-EQ': 'STOCKS',
  'STOCKS': 'STOCKS',
  'Stocks': 'STOCKS',
  'Equity': 'STOCKS',
  'EQUITY': 'STOCKS',
  'Crypto': 'CRYPTO',
  'CRYPTO': 'CRYPTO',
  'Forex': 'FOREX',
  'FOREX': 'FOREX',
  'CDS - Futures': 'FOREX',
  'CDS - Options': 'FOREX',
  'COMEX - Futures': 'COMEX',
  'COMEX - Options': 'COMEX',
  'COMEX': 'COMEX',
  'COI': 'COMEX',
  'US - Equity': 'US-EQ',
  'US-EQ': 'US-EQ',
  'INDEX-FUT': 'INDEX-FUT',
  'INDEX-OPT': 'INDEX-OPT',
  'STOCK-FUT': 'STOCK-FUT',
  'STOCK-OPT': 'STOCK-OPT',
};

// ── Pure Helper Functions ────────────────────────────────────────────────────

/** Maps a WatchlistItem to its TabLabel. Checks category first, then segment. */
export function getTabForItem(item: WatchlistItem): TabLabel {
  const comb = `${item.name || ''} ${item.symbol || ''} ${item.segment || ''} ${item.category || ''}`.toUpperCase();
  if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM'].some(c => comb.includes(c))) {
    if (comb.includes(' CE') || comb.includes(' PE') || comb.endsWith('CE') || comb.endsWith('PE') || comb.includes('OPT')) return 'MCX-OPT';
    if (comb.includes('COMEX') || (item.symbol || '').endsWith('=F')) return 'COMEX';
    return 'MCX-FUT';
  }

  if (item.category) {
    const c = item.category.toUpperCase();
    if (c.includes('INDEX-FUT') || c.includes('INDEX - FUTURE')) return 'INDEX-FUT';
    if (c.includes('INDEX-OPT') || c.includes('INDEX - OPTIONS')) return 'INDEX-OPT';
    if (c.includes('STOCK-FUT') || c.includes('STOCKS - FUTURE')) return 'STOCK-FUT';
    if (c.includes('STOCK-OPT') || c.includes('STOCKS - OPTIONS')) return 'STOCK-OPT';
    if (c.includes('MCX-FUT') || c.includes('MCX - FUTURE')) return 'MCX-FUT';
    if (c.includes('MCX-OPT') || c.includes('MCX - OPTIONS')) return 'MCX-OPT';
    if (c.includes('NSE-EQ') || c.includes('EQUITY') || c.includes('STOCKS')) return 'STOCKS';
    if (c.includes('CRYPTO')) return 'CRYPTO';
    if (c.includes('FOREX')) return 'FOREX';
    if (c.includes('COMEX') || c === 'COI') return 'COMEX';
    if (c.includes('US-EQ') || c.includes('US EQUITY')) return 'US-EQ';
  }

  if (item.segment && SEGMENT_TAB_MAP[item.segment]) {
    return SEGMENT_TAB_MAP[item.segment];
  }

  // Robust fallback for unmapped instruments
  const n = (item.name || item.symbol || '').toUpperCase();
  if (n.startsWith('US:') || n.includes('US-EQ')) return 'US-EQ';
  if (n.includes('NATURALGAS') || n.includes('CRUDEOIL') || n.includes('GOLD') || n.includes('SILVER') || n.includes('COPPER') || n.includes('ZINC') || n.includes('MCX') || n.includes('ALUMINIUM') || n.includes('LEAD')) {
    if (n.includes('CE') || n.includes('PE') || n.includes('OPT')) return 'MCX-OPT';
    return 'MCX-FUT';
  }

  const CRYPTO_BASES = ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'];
  if (n.endsWith('USDT') || n.includes('CRYPTO') || CRYPTO_BASES.some(c => n === c || n.startsWith(`${c}USDT`) || n.startsWith(`${c}/`))) return 'CRYPTO';
  if (n.includes('USDINR') || n.includes('EURINR') || n.includes('GBPINR') || n.includes('JPYINR') || n.includes('GBPUSD') || n.includes('EURUSD') || n.includes('USDJPY') || n.includes('USDCHF') || n.includes('USDCAD') || n.includes('AUDUSD') || n.includes('NZDUSD') || n.includes('CDS') || n.includes('FOREX')) return 'FOREX';

  const isIndexName = n.includes('NIFTY') || n.includes('SENSEX') || n.includes('BANKEX') || n.includes('FINNIFTY') || n.includes('MIDCP') || n.includes('MIDCAP');
  if (n.includes('CE') || n.includes('PE') || n.includes('OPT')) {
    if (isIndexName) return 'INDEX-OPT';
    return 'STOCK-OPT';
  }
  if (n.includes('FUT') || n.includes('FUTURES')) {
    if (isIndexName) return 'INDEX-FUT';
    return 'STOCK-FUT';
  }

  return 'STOCKS';
}

/** Filters items to those belonging to the active tab. */
export function filterByTab(items: WatchlistItem[], tab: TabLabel): WatchlistItem[] {
  if (tab === 'All') return items;
  return items.filter(item => getTabForItem(item) === tab);
}

/** Filters items by word-start match on name/symbol. "Nif" matches "NIFTY" but not "FINNIFTY". */
export function filterBySearch(items: WatchlistItem[], query: string): WatchlistItem[] {
  if (!query.trim()) return items;
  const q = query.toLowerCase();

  function wordStartMatch(text: string): boolean {
    const t = text.toLowerCase();
    if (t.startsWith(q)) return true;
    const words = t.split(/[\s\-_\/]/);
    return words.some(w => w.startsWith(q));
  }

  return items.filter(
    item => wordStartMatch(item.name) || wordStartMatch(item.symbol)
  );
}

/** Derives the exchange badge string from segment, name, and symbol. */
export function getExchangeBadge(segment: string, name?: string, symbol?: string): string {
  const segUpper = (segment || '').toUpperCase();
  const comb = `${name || ''} ${symbol || ''} ${segment || ''}`.toUpperCase();

  const isCommodity = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM'].some(c => comb.includes(c));
  if (isCommodity) {
    if (comb.includes(' CE') || comb.includes(' PE') || comb.endsWith('CE') || comb.endsWith('PE') || comb.includes('OPT')) return 'MCX-OPT';
    if (segUpper.includes('COMEX') || (symbol || '').endsWith('=F')) return 'COMEX';
    return 'MCX-FUT';
  }

  if (segUpper.includes('US-EQ') || segUpper.includes('US EQUITY') || segUpper.includes('US - EQUITY') || (symbol || '').startsWith('US:')) return 'US-EQ';
  if (segUpper === 'STOCK-OPT' || segUpper.includes('STOCK OPTIONS') || segUpper.includes('STOCK OPT')) return 'STOCK-OPT';
  if (segUpper === 'STOCK-FUT' || segUpper.includes('STOCK FUTURES') || segUpper.includes('STOCK FUT')) return 'STOCK-FUT';
  if (segUpper === 'INDEX-OPT' || segUpper.includes('INDEX OPTIONS') || segUpper.includes('INDEX OPT')) return 'INDEX-OPT';
  if (segUpper === 'INDEX-FUT' || segUpper.includes('INDEX FUTURES') || segUpper.includes('INDEX FUT')) return 'INDEX-FUT';
  if (segUpper === 'MCX-OPT' || segUpper.includes('MCX OPTIONS')) return 'MCX-OPT';
  if (segUpper === 'MCX-FUT' || segUpper.includes('MCX FUTURES')) return 'MCX-FUT';

  // Symbol / Name based resolution if segment is generic (e.g. "NSE", "NFO", "BFO")
  const isIndex = comb.includes('NIFTY') || comb.includes('BANKNIFTY') || comb.includes('FINNIFTY') || comb.includes('SENSEX') || comb.includes('BANKEX') || comb.includes('MIDCP') || comb.includes('MIDCAP');
  const isOption = comb.includes(' CE') || comb.includes(' PE') || comb.endsWith('CE') || comb.endsWith('PE') || comb.includes('OPT');
  const isFuture = comb.includes(' FUT') || comb.endsWith('FUT') || comb.includes('FUTURES');

  if (isOption) {
    if (isIndex) return segUpper.startsWith('BSE') || segUpper.startsWith('BFO') ? 'BFO' : 'NFO';
    if (segUpper.includes('MCX')) return 'MCX-OPT';
    return 'STOCK-OPT';
  }

  if (isFuture) {
    if (isIndex) return segUpper.startsWith('BSE') || segUpper.startsWith('BFO') ? 'BFO' : 'NFO';
    if (segUpper.includes('MCX')) return 'MCX-FUT';
    return 'STOCK-FUT';
  }

  if (segUpper.includes('MCX') || segUpper.includes('NCO')) return 'MCX';
  if (segUpper.includes('CRYPTO')) return 'CRYPTO';
  if (segUpper.includes('FOREX')) return 'FOREX';
  if (segUpper.includes('CDS')) return 'CDS';
  if (segUpper === 'NSE - EQUITY' || segUpper === 'NSE-EQ' || segUpper === 'EQUITY' || segUpper === 'STOCKS' || segUpper === 'NSE') return 'NSE';
  if (segUpper === 'BSE - EQUITY' || segUpper === 'BSE-EQ' || segUpper === 'BSE') return 'BSE';
  if (segUpper.startsWith('NSE') || segUpper.startsWith('NFO')) return 'NFO';
  if (segUpper.startsWith('BSE') || segUpper.startsWith('BFO')) return 'BFO';
  return 'NSE';
}

/** Returns the CSS class for a percentage change value. */
export function getPctClass(pct: number): 'pct-positive' | 'pct-negative' {
  return pct < 0 ? 'pct-negative' : 'pct-positive';
}

// ── SegmentTabBar Component ──────────────────────────────────────────────────

interface SegmentTabBarProps {
  activeTab: TabLabel;
  onTabChange: (tab: TabLabel) => void;
}

function SegmentTabBar({ activeTab, onTabChange }: SegmentTabBarProps) {
  return (
    <div className="seg-tab-bar">
      {TAB_LABELS.map(label => (
        <button
          key={label}
          className={`seg-tab${activeTab === label ? ' seg-tab--active' : ''}`}
          onClick={() => onTabChange(label)}
          suppressHydrationWarning
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── InstrumentRow Component ─────────────────────────────────────────────────

interface InstrumentRowProps {
  item: WatchlistItem;
  quote?: QuoteData;
  binanceQuote?: QuoteData;
  comexQuote?: ComexQuoteData;
  onTrade: (item: WatchlistItem) => void;
  onDetail: (item: WatchlistItem) => void;
  basketMode?: boolean;
  onBasketBuy?: (item: WatchlistItem) => void;
  onBasketSell?: (item: WatchlistItem) => void;
  onChart?: (item: WatchlistItem) => void;
}

function InstrumentRow({ item, quote, binanceQuote, comexQuote, onTrade, onDetail, basketMode, onBasketBuy, onBasketSell, onChart }: InstrumentRowProps) {
  const [priceView, setPriceView] = useState<'kite' | 'comex'>('kite');

  const symCheck = ((item.symbol || '') + ' ' + (item.name || '') + ' ' + (item.kiteSymbol || '')).toUpperCase();
  const isForex = item.category === 'FOREX' || item.segment === 'Forex' || ['USDJPY', 'USDCHF', 'USDCAD', 'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDINR', 'EURINR', 'GBPINR', 'JPYINR'].some(f => symCheck.replace(/[\/\=X\s]/g, '').includes(f));

  const CRYPTO_BASES = ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'];
  const symUp = (item.symbol || '').toUpperCase().trim();
  const segUpper = (item.segment || '').toUpperCase();
  const catUpper = (item.category || '').toUpperCase();

  const isCrypto = !isForex && (
    segUpper === 'CRYPTO' ||
    segUpper === 'CRYPTO-FUT' ||
    catUpper === 'CRYPTO' ||
    symUp.endsWith('USDT') ||
    CRYPTO_BASES.some(c => symUp === c || symUp.startsWith(`${c}USDT`) || symUp.startsWith(`${c}/`))
  );
  const isPureComex = segUpper.includes('COMEX') || catUpper.includes('COMEX') || symUp.endsWith('=F') || (!!item.comexSymbol && !item.kiteSymbol);
  const hasDualView = false;
  const showComex = isPureComex || (isForex && !!item.comexSymbol);

  const activeCryptoQuote = binanceQuote || quote;

  let ltp = 0;
  let prevClose = 0;
  let percentChange = 0;
  let absoluteChange = 0;

  if (isCrypto) {
    let rawLtp = activeCryptoQuote?.lastPrice ?? item.price ?? 0;
    let rawClose = activeCryptoQuote?.close ?? (item.close || rawLtp);
    ltp = rawLtp;
    prevClose = rawClose;
    absoluteChange = ltp - prevClose;
    percentChange = prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
  } else if (showComex) {
    ltp = comexQuote?.lastPrice ?? item.price ?? 0;
    prevClose = comexQuote?.close ?? (item.close || ltp);
    absoluteChange = ltp - prevClose;
    percentChange = prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
  } else {
    ltp = quote?.lastPrice ?? item.price ?? 0;
    if (quote && quote.lastPrice > 0) {
      prevClose = quote.close ?? ltp;
      absoluteChange = ltp - prevClose;
      percentChange = prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
    } else {
      const match = item.change ? item.change.match(/([-+]?[0-9]*\.?[0-9]+)%/) : null;
      percentChange = match ? parseFloat(match[1]) : 0;
      prevClose = percentChange !== -100 ? (ltp / (1 + percentChange / 100)) : ltp;
      absoluteChange = ltp - prevClose;
    }
  }

  if (ltp === 0) {
    const fallbackKey = item.symbol || item.kiteSymbol || item.name || '';
    const fallback = generateRealisticFallbackQuote(fallbackKey);
    ltp = fallback.last_price;
    prevClose = fallback.ohlc.close;
    absoluteChange = fallback.net_change;
    percentChange = fallback.changePercent;
  }

  const isForexUsd = symCheck.includes('GBPUSD') || symCheck.includes('EURUSD') || symCheck.includes('GBP/USD') || symCheck.includes('EUR/USD');
  // Raw currency prices maintained for Forex/Crypto/COMEX

  const isLoading = ltp === 0;

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('.wc-action-btn') ||
      target.closest('.instrument-delete-btn') ||
      target.closest('.mcx-comex-switch') ||
      target.closest('.wc-basket-actions') ||
      target.closest('button')
    ) {
      return;
    }
    if (basketMode) return;
    onDetail({ ...item, preferredView: priceView } as any);
  };

  const formatUIExpiry = (dateStr: string | null | undefined): string => {
    if (!dateStr) return '';
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return dateStr;
    const [, year, month, day] = match;
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${parseInt(day, 10)} ${monthNames[parseInt(month, 10) - 1]} ${year}`;
  };

  return (
    <div className="instr-row watchlist-card" data-symbol={item.symbol}>
      <div className="wc-swipe-actions">
        <button className="wc-action-btn delete-btn" onClick={(e) => { e.stopPropagation(); (window as any).removeFromWatchlist?.(item.symbol); }}>
          <i className="fas fa-trash-alt"></i>
        </button>
      </div>
      <div className="wc-content instr-row__content" onClick={handleCardClick} style={{ cursor: 'pointer' }}>
        <div className="instr-row__left">
          <div className="instr-row__name-line">
            <span className="instr-row__name">{item.name}</span>
            <span className="exchange-badge" style={
              isCrypto ? { background: '#F0A500', color: '#fff' } :
                isForex ? { background: '#2563EB', color: '#fff' } :
                  showComex ? { background: '#4A148C', color: '#fff' } : {}
            }>
              {isCrypto ? 'CRYPTO' : isForex ? 'FOREX' : showComex ? 'COMEX' : getExchangeBadge(item.segment, item.name, item.symbol)}
            </span>
            {!basketMode && onChart && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onChart({ ...item, preferredView: priceView } as any);
                }}
                style={{ background: 'none', border: 'none', color: '#2C8E5A', cursor: 'pointer', padding: '0 4px', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center' }}
                title="Open Chart"
              >
                <i className="fas fa-chart-simple"></i>
              </button>
            )}
          </div>
          {item.contractDate && (
            <div className="instr-row__date">{formatUIExpiry(item.contractDate)}</div>
          )}
          {isCrypto && (
            <div className="instr-row__date" style={{ color: '#6B7280', fontSize: '0.7rem' }}>{item.binanceSymbol}</div>
          )}
          {hasDualView && (
            <div
              className="mcx-comex-switch"
              onClick={(e) => { e.stopPropagation(); setPriceView(v => v === 'kite' ? 'comex' : 'kite'); }}
              style={{ fontSize: '0.62rem', fontWeight: '700', color: showComex ? '#4A148C' : '#2C8E5A', background: showComex ? '#EDE7F6' : '#E9F6EF', padding: '2px 8px', borderRadius: '20px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '3px', userSelect: 'none' }}
            >
              {showComex ? '₹ COMEX ⇄ ₹ MCX' : '₹ MCX ⇄ ₹ COMEX'}
            </div>
          )}
        </div>
        <div className="instr-row__right">
          {isLoading ? (
            <div className="instr-row__ltp" style={{ color: '#9CA3AF' }}>Loading…</div>
          ) : (
            <>
              <div className="instr-row__ltp">
                {`₹${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </div>
              <div className="instr-row__abs-change">{absoluteChange >= 0 ? '+' : ''}{absoluteChange.toFixed(2)}</div>
              <div className={`instr-row__pct-change ${getPctClass(percentChange)}`}>
                {percentChange >= 0 ? '+' : ''}{percentChange.toFixed(2)}%
              </div>
            </>
          )}
        </div>
        {!basketMode && (
          <button className="instrument-delete-btn" onClick={(e) => { e.stopPropagation(); (window as any).removeFromWatchlist?.(item.symbol); }}>
            <i className="fas fa-trash-alt"></i>
          </button>
        )}
        <div className="wc-checkbox-wrapper" style={{ display: 'none' }}>
          <input type="checkbox" className="wc-checkbox" onClick={(e) => e.stopPropagation()} />
        </div>
        {basketMode && (
          <div className="wc-basket-actions" onClick={(e) => e.stopPropagation()}>
            <button className="wc-basket-buy" onClick={() => onBasketBuy?.(item)}>BUY</button>
            <button className="wc-basket-sell" onClick={() => onBasketSell?.(item)}>SELL</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── EmptyState Component ────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="watchlist-empty-state">
      <div className="watchlist-empty-state__icon">
        <i className="fas fa-inbox"></i>
      </div>
      <div className="watchlist-empty-state__title">No instruments here</div>
      <div className="watchlist-empty-state__subtitle">Add instruments from the Library to this segment</div>
    </div>
  );
}

// ── Trading Segments Data ────────────────────────────────────────────────────

interface TradingInstrument {
  name: string; symbol: string; kiteSymbol: string; price: number; change: string;
  segment: string; contractDate: string; open: number; high: number; low: number; close: number;
  binanceSymbol?: string; comexSymbol?: string;
}
interface TradingSubCategory { name: string; instruments: TradingInstrument[]; }
interface TradingSegment { name: string; icon: string; instruments?: TradingInstrument[]; subCategories?: TradingSubCategory[]; }

function WatchlistContent() {
  const [tradingSegments, setTradingSegments] = useState<TradingSegment[]>([]);
  const tradingSegmentsRef = useRef<TradingSegment[]>([]);

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).__initialTradingSegments) {
      setTradingSegments((window as any).__initialTradingSegments);
      tradingSegmentsRef.current = (window as any).__initialTradingSegments;
    }

    const fetchSegments = () => {
      const qs = new URLSearchParams();
      if (typeof window !== 'undefined' && (window as any).__marketQuotes) {
        const mq = (window as any).__marketQuotes;
        const nifty = mq['NSE:NIFTY 50']?.lastPrice || mq['NIFTY 50']?.lastPrice;
        if (nifty) qs.set('nifty', String(nifty));
        const banknifty = mq['NSE:NIFTY BANK']?.lastPrice || mq['NIFTY BANK']?.lastPrice;
        if (banknifty) qs.set('banknifty', String(banknifty));
      }

      api.get<{ segments: TradingSegment[] }>(`/api/market/instruments/library?${qs.toString()}`)
        .then(data => {
          if (data.segments) {
            setTradingSegments(data.segments);
            tradingSegmentsRef.current = data.segments;
          }
        })
        .catch(err => console.error('Failed to load library segments:', err));
    };

    fetchSegments(); // Initial fetch
  }, []);

  const router = useRouter();
  const searchParams = useSearchParams();
  useAuth();
  const { placeOrder, loading: placingOrder, error: placeOrderError } = useOrderEntry();
  const { positions: activePositions } = useActivePositions();

  // Reset body overflow when this page unmounts (prevents scroll lock on other pages)
  useEffect(() => {
    return () => {
      document.body.style.overflow = '';
      document.body.style.overflowY = '';
      window.__selectionModeActive = false;
    };
  }, []);

  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<TabLabel>('All');
  const [searchText, setSearchText] = useState<string>('');
  const [isFolderDrawerOpen, setIsFolderDrawerOpen] = useState(false);
  const [expandedSegments, setExpandedSegments] = useState<Record<string, boolean>>({});
  const [allowedSegments, setAllowedSegments] = useState<string[] | null>(null);
  // segmentSettings, getSegment, and getLotSize come from the shared TradeConfigProvider
  const { segmentSettings, getSegment, getLotSize } = useTradeConfig();
  const [blockedSymbols, setBlockedSymbols] = useState<Set<string>>(new Set());
  const [userId, setUserId] = useState<string>('');
  const [tradingHours, setTradingHours] = useState<any[]>([]);
  const [errorModalMsg, setErrorModalMsg] = useState<string | null>(null);

  // Fetch Binance quotes directly for crypto symbols
  const cryptoSymbols = useMemo(() => {
    return watchlistItems
      .filter(item => item.binanceSymbol && item.category === 'CRYPTO')
      .map(item => item.binanceSymbol!)
      .filter((v, i, a) => a.indexOf(v) === i); // unique
  }, [watchlistItems]);

  // order_error is now handled centrally in ClientShell — no local listener needed.

  const isMarketOpen = (item: WatchlistItem) => {
    const segUpper = (item.segment || '').toUpperCase();
    if (segUpper.includes('CRYPTO')) return true;

    const symName = (item as any).tradingsymbol || item.symbol || item.name || '';
    const segmentId = RiskValidation.resolveTradingHoursSegmentId(symName, item.segment || '');


    const th = tradingHours.find(t => t.id === segmentId);
    if (!th) return true; // fallback
    if (!th.is_active) return false;

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hour12: false
    });
    const parts = formatter.formatToParts(new Date());
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hourVal = parts.find(p => p.type === 'hour')?.value;
    const minuteVal = parts.find(p => p.type === 'minute')?.value;
    if (!weekday || !hourVal || !minuteVal) return true;

    if (weekday === 'Sat' || weekday === 'Sun') return false;

    const currentHHMM = `${hourVal.padStart(2, '0')}:${minuteVal.padStart(2, '0')}`;
    if (currentHHMM < th.start_time || currentHHMM >= th.end_time) return false;

    return true;
  };

  const isSpotIndex = (item: WatchlistItem) => {
    if (!item) return false;
    const spotKiteSymbols = [
      'NSE:NIFTY 50', 'NSE:NIFTY BANK', 'BSE:SENSEX', 'BSE:BANKEX',
      'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY MID SELECT', 'NSE:INDIA VIX'
    ];
    if (item.kiteSymbol && spotKiteSymbols.includes(item.kiteSymbol.toUpperCase())) return true;

    const nameUpper = (item.name || '').toUpperCase();
    if (nameUpper.includes('INDEX') && !nameUpper.includes('FUT') && !nameUpper.includes('CE') && !nameUpper.includes('PE')) return true;

    return false;
  };

  const [isExecutingBasket, setIsExecutingBasket] = useState(false);

  const getWatchlistLotSize = (item: any): number => {
    const rawLotSize = Number(item?.lotSize || 0);
    const isOption = item?.symbol ? (item.symbol.endsWith('CE') || item.symbol.endsWith('PE')) : false;
    if (item && rawLotSize > 0 && !(isOption && rawLotSize === 1)) return rawLotSize;
    // Use the context-provided getLotSize which handles script settings + hardcoded fallbacks
    return getLotSize(item?.symbol || item?.name || '');
  };

  useEffect(() => {
    async function fetchAllowedSegments() {
      try {
        const { supabase: sb } = await import('@/lib/supabaseClient');
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { setAllowedSegments([]); return; }

        setUserId(session.user.id);

        // Also save to window for easy inline script access
        (window as any).__accessToken = session.access_token;

        const controller1 = new AbortController();
        const t1 = setTimeout(() => controller1.abort(), 5000);
        let profile: any;
        try {
          profile = await api.get<any>('/api/user/profile', { signal: controller1.signal });
        } finally {
          clearTimeout(t1);
        }

        if (profile) {
          // Use profile.segments if set, otherwise empty array means all allowed
          setAllowedSegments(profile?.segments ?? []);

          // Fetch block-scripts and trading_hours in parallel with timeouts
          const controller2 = new AbortController();
          const t2 = setTimeout(() => controller2.abort(), 5000);

          const thTimeout = new Promise<{ data: null }>((resolve) =>
            setTimeout(() => resolve({ data: null }), 5000)
          );

          const [blockedData, thResult] = await Promise.allSettled([
            api.get<any>(`/api/admin/users/${session.user.id}/block-scripts`, { signal: controller2.signal }),
            Promise.race([sb.from('trading_hours').select('*'), thTimeout]),
          ]);
          clearTimeout(t2);

          if (blockedData.status === 'fulfilled') {
            const symbols: string[] = (blockedData.value as any)?.symbols || [];
            setBlockedSymbols(new Set(symbols.map((s: string) => s.toUpperCase())));
          }

          if (thResult.status === 'fulfilled') {
            const thData = (thResult.value as any)?.data;
            if (thData) setTradingHours(thData);
          }
        } else {
          // On error, fall back to allowing all
          setAllowedSegments([]);
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          console.warn('Failed to fetch allowed segments', err);
        }
        // On error, fall back to allowing all
        setAllowedSegments([]);
      }
    }
    fetchAllowedSegments();
  }, []);




  // Toast State
  const [toast, setToast] = useState<{ msg: string; isError: boolean; visible: boolean }>({
    msg: '', isError: false, visible: false
  });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, isError: boolean) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ msg, isError, visible: true });
    toastTimerRef.current = setTimeout(() => {
      setToast(t => ({ ...t, visible: false }));
    }, 1500);
  };

  useEffect(() => {
    (window as any).showToast = showToast;
  }, [showToast]);

  // Trade Sheet State
  const [selectedItem, setSelectedItem] = useState<WatchlistItem | null>(null);
  const [isBenchmarkChart, setIsBenchmarkChart] = useState<boolean>(false);
  const [chartItem, setChartItem] = useState<WatchlistItem | null>(null);

  const [tradeSide, setTradeSide] = useState<'BUY' | 'SELL' | 'BOTH'>('BOTH');
  const [orderQty, setOrderQty] = useState(1);
  const [qtyInput, setQtyInput] = useState('1');
  const [orderUnit, setOrderUnit] = useState('qty');
  const [orderType, setOrderType] = useState('MARKET');
  const [productType, setProductType] = useState('INTRADAY');
  const [slTpOpen, setSlTpOpen] = useState(false);
  const [slPrice, setSlPrice] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const openDetailSheet = (item: any) => {
    isOpeningTradeSheetRef.current = false;
    setDetailOpeningSide(null);
    setSelectedItem(item);
    setIsTradeSheetOpen(false); // ensure TradeSheet is closed when detail opens
  };
  const [isTradeSheetOpen, setIsTradeSheetOpen] = useState(false);
  const [isBasketSheetOpen, setIsBasketSheetOpen] = useState(false);
  const [isCheckoutSheetOpen, setIsCheckoutSheetOpen] = useState(false);
  // Tracks which detail-sheet button is in the "tapped, waiting for sheet" state.
  // 'BUY' or 'SELL' while the sheet is opening; null otherwise.
  // Used to show a spinner on the tapped button and dim the other one.
  const [detailOpeningSide, setDetailOpeningSide] = useState<'BUY' | 'SELL' | null>(null);
  // Prevents duplicate TradeSheet mounts when the user taps BUY/SELL rapidly or
  // when both onClick and onTouchEnd fire within the same gesture.
  // Must be a ref (not state) so it is synchronously readable in the same tick.
  const isOpeningTradeSheetRef = useRef(false);


  const marketSymbols = useMemo(() => {
    const list: string[] = [];
    watchlistItems.forEach(i => {
      const candidates = [i.kiteSymbol, i.symbol, i.name, i.symbol?.replace(/\s+/g, '')].filter(Boolean) as string[];
      candidates.forEach(sym => {
        if (!i.binanceSymbol && !list.includes(sym)) list.push(sym);
      });
      if (i.binanceSymbol && !list.includes(i.binanceSymbol)) list.push(i.binanceSymbol);
    });
    if (selectedItem) {
      const selCandidates = [selectedItem.kiteSymbol, selectedItem.symbol, selectedItem.name, selectedItem.symbol?.replace(/\s+/g, '')].filter(Boolean) as string[];
      selCandidates.forEach(sym => {
        if (!list.includes(sym)) list.push(sym);
      });
    }
    return list;
  }, [watchlistItems, selectedItem?.kiteSymbol, selectedItem?.symbol, selectedItem?.name]);

  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);

  // Use marketQuotes instead of legacy binanceQuotes
  const binanceQuotesAsQuoteData = useMemo(() => {
    const result: Record<string, QuoteData> = {};
    for (const sym of cryptoSymbols) {
      if (marketQuotes[sym]) {
        result[sym] = marketQuotes[sym];
      }
    }
    return result;
  }, [cryptoSymbols, marketQuotes]);

  // Expose binanceQuotes to window for inline script access
  useEffect(() => {
    (window as any).__binanceQuotes = binanceQuotesAsQuoteData;
  }, [binanceQuotesAsQuoteData]);

  const comexSymbols = Array.from(new Set([
    ...watchlistItems.map(i => i.comexSymbol || (i.symbol.endsWith('=F') ? i.symbol : (
      (i.segment || '').toUpperCase().includes('COMEX') ? (
        (i.name || i.symbol || '').toUpperCase().includes('SILVER') ? 'SI=F' :
        (i.name || i.symbol || '').toUpperCase().includes('GOLD') ? 'GC=F' :
        (i.name || i.symbol || '').toUpperCase().includes('CRUDE') ? 'CL=F' :
        (i.name || i.symbol || '').toUpperCase().includes('COPPER') ? 'HG=F' :
        (i.name || i.symbol || '').toUpperCase().includes('NAT') ? 'NG=F' : ''
      ) : ''
    ))).filter((s): s is string => !!s),
    ...(selectedItem?.comexSymbol ? [selectedItem.comexSymbol] : []),
    ...(selectedItem && (selectedItem.segment || '').toUpperCase().includes('COMEX') ? [
      (selectedItem.name || selectedItem.symbol || '').toUpperCase().includes('SILVER') ? 'SI=F' :
      (selectedItem.name || selectedItem.symbol || '').toUpperCase().includes('GOLD') ? 'GC=F' :
      (selectedItem.name || selectedItem.symbol || '').toUpperCase().includes('CRUDE') ? 'CL=F' :
      (selectedItem.name || selectedItem.symbol || '').toUpperCase().includes('COPPER') ? 'HG=F' :
      (selectedItem.name || selectedItem.symbol || '').toUpperCase().includes('NAT') ? 'NG=F' : ''
    ].filter(Boolean) : [])
  ]));
  const { quotes: comexQuotes } = useComexQuotes(comexSymbols, 1000);

  // ── Detail sheet: resolve live quote from correct source ─────────────────
  const isCrypto = !!(selectedItem?.binanceSymbol);
  const isComex = !!selectedItem && (
    (selectedItem.segment || '').toUpperCase().includes('COMEX') ||
    (selectedItem.category || '').toUpperCase().includes('COMEX') ||
    (selectedItem.symbol || '').endsWith('=F') ||
    (!!selectedItem.comexSymbol && (!(selectedItem.kiteSymbol) || (selectedItem as any).preferredView === 'comex'))
  );

  const comexSymbolKey = selectedItem?.comexSymbol || (selectedItem?.symbol?.endsWith('=F') ? selectedItem.symbol : (
    (selectedItem?.name || selectedItem?.symbol || '').toUpperCase().includes('SILVER') ? 'SI=F' :
    (selectedItem?.name || selectedItem?.symbol || '').toUpperCase().includes('GOLD') ? 'GC=F' :
    (selectedItem?.name || selectedItem?.symbol || '').toUpperCase().includes('CRUDE') ? 'CL=F' :
    (selectedItem?.name || selectedItem?.symbol || '').toUpperCase().includes('COPPER') ? 'HG=F' :
    (selectedItem?.name || selectedItem?.symbol || '').toUpperCase().includes('NAT') ? 'NG=F' : ''
  ));

  const currentKiteQuote = selectedItem ? (
    (selectedItem.kiteSymbol ? marketQuotes[selectedItem.kiteSymbol] : null) ||
    (selectedItem.symbol ? marketQuotes[selectedItem.symbol] : null) ||
    (selectedItem.symbol ? marketQuotes[selectedItem.symbol.replace(/\s+/g, '')] : null) ||
    (selectedItem.name ? marketQuotes[selectedItem.name] : null) ||
    null
  ) : null;
  const currentBinanceQuote = selectedItem?.binanceSymbol ? (marketQuotes[selectedItem.binanceSymbol] || binanceQuotesAsQuoteData[selectedItem.binanceSymbol]) : null;
  const currentComexQuote = comexSymbolKey ? comexQuotes[comexSymbolKey] : null;

  let currentLtp = 0;
  let currentChangePercent = 0;
  let detailOpen = (isCrypto && currentBinanceQuote?.open) || (isComex && currentComexQuote?.open) || currentKiteQuote?.open || selectedItem?.open;
  let detailHigh = (isCrypto && currentBinanceQuote?.high) || (isComex && currentComexQuote?.high) || currentKiteQuote?.high || selectedItem?.high;
  let detailLow = (isCrypto && currentBinanceQuote?.low) || (isComex && currentComexQuote?.low) || currentKiteQuote?.low || selectedItem?.low;
  let detailClose = (isCrypto && currentBinanceQuote?.close) || (isComex && currentComexQuote?.close) || currentKiteQuote?.close || selectedItem?.close;

  if (isCrypto && currentBinanceQuote) {
    currentLtp = currentBinanceQuote.lastPrice;
    currentChangePercent = currentBinanceQuote.changePercent;
  } else if (isComex && currentComexQuote) {
    currentLtp = currentComexQuote.lastPrice;
    currentChangePercent = currentComexQuote.changePercent;
  } else if (currentKiteQuote) {
    currentLtp = currentKiteQuote.lastPrice;
    currentChangePercent = currentKiteQuote.changePercent;
  } else {
    currentLtp = typeof selectedItem?.price === 'string'
      ? parseFloat((selectedItem.price as string).replace(/,/g, ''))
      : (selectedItem?.price ?? 0);
    currentChangePercent = parseFloat(selectedItem?.change?.replace(/[%+]/g, '') || '0') || 0;
  }

  let detailFallbackQuote: any = null;
  if (currentLtp === 0 && selectedItem) {
    const fallbackKey = selectedItem.symbol || selectedItem.kiteSymbol || selectedItem.name || '';
    detailFallbackQuote = generateRealisticFallbackQuote(fallbackKey);
    currentLtp = detailFallbackQuote.last_price;
    currentChangePercent = detailFallbackQuote.changePercent;
    detailOpen = detailFallbackQuote.ohlc.open;
    detailHigh = detailFallbackQuote.ohlc.high;
    detailLow = detailFallbackQuote.ohlc.low;
    detailClose = detailFallbackQuote.ohlc.close;
  }

  const detailSymCheck = ((selectedItem?.symbol || '') + ' ' + (selectedItem?.name || '') + ' ' + (selectedItem?.kiteSymbol || '')).toUpperCase();
  const isDetailForexUsd = detailSymCheck.includes('GBPUSD') || detailSymCheck.includes('EURUSD') || detailSymCheck.includes('GBP/USD') || detailSymCheck.includes('EUR/USD');

  if (isDetailForexUsd && currentLtp > 0 && currentLtp < 20) {
    // Keep raw price
  }

  const formatPrice = (price: number | undefined | null) => {
    if (price === undefined || price === null || isNaN(price as number)) return '--';
    let p = price;
    const sym = '₹';
    const locale = 'en-IN';
    return `${sym}${p.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const dbSeg = selectedItem ? mapSegmentWithSymbol(selectedItem.segment, selectedItem.symbol || selectedItem.name || '') : '';
  const buySetting = dbSeg ? getSegment(dbSeg, 'BUY') : undefined;
  const sellSetting = dbSeg ? getSegment(dbSeg, 'SELL') : undefined;

  const buyEntryBuffer = buySetting ? buySetting.entry_buffer : 0.003;
  const sellEntryBuffer = sellSetting ? sellSetting.entry_buffer : 0.003;

  let rawBid = currentLtp;
  let rawAsk = currentLtp;

  if (isCrypto && currentBinanceQuote) {
    rawBid = currentBinanceQuote.bid || currentLtp;
    rawAsk = currentBinanceQuote.ask || currentLtp;
  } else if (isComex && currentComexQuote) {
    rawBid = currentComexQuote.bid || currentLtp;
    rawAsk = currentComexQuote.ask || currentLtp;
  } else if (currentKiteQuote) {
    rawBid = currentKiteQuote.bid || currentLtp;
    rawAsk = currentKiteQuote.ask || currentLtp;
  } else if (detailFallbackQuote) {
    rawBid = detailFallbackQuote.bid || currentLtp;
    rawAsk = detailFallbackQuote.ask || currentLtp;
  }

  // Use real bid/ask from the exchange if valid (non-zero and bid < ask).
  // Only fall back to a tight synthetic spread when prices are missing or crossed.
  if (currentLtp > 0) {
    if (!rawBid || rawBid <= 0) rawBid = currentLtp;
    if (!rawAsk || rawAsk <= 0) rawAsk = currentLtp;
  }

  if (isDetailForexUsd) {
    // Keep raw bid/ask
  }



  // ── Mobile Back Button Interception ──
  useMobileBack(isFolderDrawerOpen, () => setIsFolderDrawerOpen(false), 'segments');
  useMobileBack(!!selectedItem && !isTradeSheetOpen && !chartItem, () => {
    closeDetailSheet();
  }, 'details');
  useMobileBack(isTradeSheetOpen, () => {
    closeTradeSheet();
  }, 'trade');
  useMobileBack(!!chartItem, () => {
    closeChartSheet();
  }, 'chart');
  useMobileBack(isBasketSheetOpen, () => {
    setIsBasketSheetOpen(false);
  }, 'basket');
  useMobileBack(isCheckoutSheetOpen, () => {
    setIsCheckoutSheetOpen(false);
  }, 'checkout');

  useEffect(() => {
    return () => {
      document.body.style.overflow = '';
      document.body.style.overflowY = '';
      isOpeningTradeSheetRef.current = false;
      setDetailOpeningSide(null);
      const ids = [
        'tradeSheet', 'detailSheet', 'chartSheet', 'basketSheet', 'checkoutSheet', 'scriptsFolderDrawer',
        'tradeSheetOverlay', 'detailSheetOverlay', 'chartSheetOverlay', 'basketSheetOverlay', 'checkoutSheetOverlay', 'drawerOverlay'
      ];
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.classList.remove('open');
          el.classList.remove('active');
        }
      });
    };
  }, []);

  // Basket Mode State
  const [basketMode, setBasketMode] = useState(false);
  const [basketLegs, setBasketLegs] = useState<Array<{ item: WatchlistItem; side: 'BUY' | 'SELL'; qty: number; unit: 'qty' | 'lot'; productType?: 'INTRADAY' | 'CARRY' }>>([]);
  const [showChargesBreakdown, setShowChargesBreakdown] = useState(false);

  const [isSelectionActive, setIsSelectionActive] = useState(false);

  useEffect(() => {
    (window as any).__isBasketModeActive = basketMode;
    if (basketMode) {
      if (isSelectionActive) setIsSelectionActive(false);
      (window as any).exitSelectionMode?.();
    }
  }, [basketMode]);

  // Map a segment label to DB key segment — imported from lib/trading/SymbolMapping
  // (local copy removed)

  const filteredItems = filterBySearch(filterByTab(watchlistItems, activeTab), searchText);
  const addedSymbolsSet = useMemo(() => new Set(watchlistItems.map(i => i.symbol)), [watchlistItems]);
  const scriptMountedRef = useRef(false);
  const deepLinkHandledRef = useRef(false);
  const watchlistItemsRef = useRef<WatchlistItem[]>([]);

  // Available Balance — live via Realtime (no polling needed)
  const { balance: availableBalance } = useBalance();

  useEffect(() => {
    (window as any).__activeTab = activeTab;
  }, [activeTab]);

  // Search results overlay: show search results library whenever search input has text
  useEffect(() => {
    const area = document.getElementById('searchResultsArea');
    if (!area) return;

    if (!searchText.trim()) {
      area.style.display = 'none';
      return;
    }

    // Pre-show the area so it's visible before inline script renders results
    area.style.display = 'flex';

    // Use the exposed search function directly — avoids the fragile synthetic
    // input event that could fire before the inline script has attached its listener
    if (typeof (window as any).__triggerSearch === 'function') {
      (window as any).__triggerSearch(searchText.trim());
    } else {
      // Script not mounted yet — dispatch input event as fallback
      const input = document.getElementById('globalSearchInput') as HTMLInputElement | null;
      if (input) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }, [searchText]);



  useEffect(() => {
    const handleTheme = () => {
      applyTheme(getSavedTheme());
    };
    handleTheme();
    window.addEventListener('themeChanged', handleTheme);
    return () => window.removeEventListener('themeChanged', handleTheme);
  }, []);

  // Keep a ref to activePositions so the side-change effect reads the latest
  // without re-triggering on every positions data update
  const activePositionsRef = useRef(activePositions);
  useEffect(() => { activePositionsRef.current = activePositions; }, [activePositions]);

  // Sync maximum position quantity when side changes to SELL
  useEffect(() => {
    const positions = activePositionsRef.current;
    if (selectedItem && positions) {
      if (tradeSide === 'SELL') {
        const existingPos = positions.find(
          p => p.symbol === selectedItem.symbol && ((p.status as string) === 'open' || (p.status as string) === 'active') && p.side === 'BUY'
        );
        if (existingPos) {
          setOrderQty(existingPos.qty_open);
          setQtyInput(String(existingPos.qty_open));
        }
      } else if (tradeSide === 'BUY') {
        const computedLot = getWatchlistLotSize(selectedItem);
        setOrderQty(computedLot);
        setQtyInput(String(computedLot));
      }
    }
  }, [tradeSide, selectedItem?.symbol]);

  // Handle deep linking from other screens (e.g. Home)
  const deepLinkSymbol = searchParams.get('symbol');
  const deepLinkAction = searchParams.get('action');

  useEffect(() => {
    deepLinkHandledRef.current = false;
  }, [deepLinkSymbol, deepLinkAction]);

  useEffect(() => {
    if (!deepLinkSymbol || !hasLoaded) return;
    // Only process the deep-link once — re-running on every watchlistItems change
    // would re-open the deep-linked chart whenever a new item is added from the library.
    if (deepLinkHandledRef.current) return;
    deepLinkHandledRef.current = true;
    // Map dashboard display names back to their standard search terms
    const aliasMap: Record<string, string> = {
      'NAT GAS': 'NATURALGAS',
      'CRUDE OIL': 'CRUDEOIL',
      'BANK NIFTY': 'BANKNIFTY',
    };

    const rawQuery = deepLinkSymbol.toUpperCase();
    let query = rawQuery;
    if (aliasMap[query]) {
      query = aliasMap[query];
    }
    const cleanQuery = query.includes(':') ? query.split(':')[1] : query;

    const tryOpen = (items: WatchlistItem[]) => {
      let item = items.find(i => {
        const itemSym = i.symbol.toUpperCase().replace(/\s/g, '');
        const itemKite = (i.kiteSymbol || '').toUpperCase().replace(/\s/g, '');
        const itemKiteClean = itemKite.includes(':') ? itemKite.split(':')[1] : itemKite;
        return (
          itemSym === cleanQuery.replace(/\s/g, '') ||
          itemKiteClean === cleanQuery.replace(/\s/g, '') ||
          itemKite === rawQuery.replace(/\s/g, '') ||
          i.name.toUpperCase().replace(/\s/g, '').replace('INDEX', '').replace('FUT', '') === cleanQuery.replace(/\s/g, '').replace('INDEX', '').replace('FUT', '')
        );
      });

      // Fallback: Try to find in master segments lists first
      if (!item) {
        // Try searching defaults first (e.g. for crypto/forex/comex)
        const allDefaults = [...DEFAULT_CRYPTO_ITEMS, ...DEFAULT_FOREX_ITEMS, ...DEFAULT_COMEX_ITEMS];
        const defaultMatch = allDefaults.find(d =>
          d.symbol.toUpperCase() === cleanQuery ||
          d.name.toUpperCase().replace(/\s/g, '').replace('INDEX', '').replace('FUT', '') === cleanQuery.replace(/\s/g, '').replace('INDEX', '').replace('FUT', '') ||
          (d.kiteSymbol && d.kiteSymbol.toUpperCase() === rawQuery)
        );

        let masterFound: any = defaultMatch ? { ...defaultMatch } : null;

        if (!masterFound) {
          for (const seg of tradingSegmentsRef.current) {
            if (seg.instruments) {
              const found = seg.instruments.find(i =>
                i.symbol.toUpperCase().replace(/\s/g, '') === cleanQuery.replace(/\s/g, '') ||
                i.name.toUpperCase().replace(/\s/g, '').replace('INDEX', '').replace('FUT', '') === cleanQuery.replace(/\s/g, '').replace('INDEX', '').replace('FUT', '') ||
                (i.kiteSymbol && i.kiteSymbol.toUpperCase() === rawQuery) ||
                (i.kiteSymbol && i.kiteSymbol.toUpperCase().split(':').pop() === cleanQuery)
              );
              if (found) { masterFound = found; break; }
            }
            if (seg.subCategories) {
              for (const sub of seg.subCategories) {
                const found = sub.instruments.find(i =>
                  i.symbol.toUpperCase().replace(/\s/g, '') === cleanQuery.replace(/\s/g, '') ||
                  i.name.toUpperCase().replace(/\s/g, '').replace('INDEX', '').replace('FUT', '') === cleanQuery.replace(/\s/g, '').replace('INDEX', '').replace('FUT', '') ||
                  (i.kiteSymbol && i.kiteSymbol.toUpperCase() === rawQuery) ||
                  (i.kiteSymbol && i.kiteSymbol.toUpperCase().split(':').pop() === cleanQuery)
                );
                if (found) { masterFound = found; break; }
              }
              if (masterFound) break;
            }
          }
        }

        if (masterFound) {
          item = { ...masterFound };
        } else {
          let resolvedKiteSymbol = rawQuery;
          if (!resolvedKiteSymbol.includes(':')) {
            const isOption = (cleanQuery.endsWith('CE') || cleanQuery.endsWith('PE')) && /\d/.test(cleanQuery);
            const isFut = cleanQuery.endsWith('FUT') || cleanQuery.includes('FUTURES');
            let prefix = 'NSE';
            if (cleanQuery.includes('SENSEX') || cleanQuery.includes('BANKEX')) prefix = 'BFO';
            else if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'NATGAS', 'MCX', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(x => cleanQuery.includes(x))) prefix = 'MCX';
            else if (isOption || isFut) prefix = 'NFO';
            resolvedKiteSymbol = `${prefix}:${cleanQuery}`;
          }

          item = {
            name: cleanQuery,
            symbol: cleanQuery,
            kiteSymbol: resolvedKiteSymbol,
            segment: mapSymbolToSegment(cleanQuery),
            price: 0,
          } as WatchlistItem;
        }

        // Auto-add fallback/master item to watchlist state and storage
        const dashboardBenchmarks = ['NIFTY 50', 'SENSEX', 'BANK NIFTY', 'USD/INR', 'CRUDE OIL', 'GOLD', 'SILVER', 'NAT GAS'];
        if (!dashboardBenchmarks.includes(deepLinkSymbol)) {
          setWatchlistItems(prev => {
            const newItem = { ...item!, category: activeTab };
            if (prev.some(i => i.symbol === newItem.symbol && getTabForItem(i) === activeTab)) return prev;
            const next = [...prev, newItem];
            saveWatchlistToStorage(next, userId);
            return next;
          });
        }
      }

      const itemTab = getTabForItem(item!);
      if (itemTab !== activeTab) setActiveTab(itemTab);

      const timer = setTimeout(() => {
        const dashboardBenchmarks = ['NIFTY 50', 'SENSEX', 'BANK NIFTY', 'USD/INR', 'CRUDE OIL', 'GOLD', 'SILVER', 'NAT GAS'];
        if (dashboardBenchmarks.includes(deepLinkSymbol) && deepLinkAction !== 'detail') {
          setChartItem(item!);
          setIsBenchmarkChart(true);
        } else {
          openDetailSheet(item!);
        }
      }, 500);
      return () => clearTimeout(timer);
    };

    return tryOpen(watchlistItemsRef.current);
  }, [deepLinkSymbol, deepLinkAction, hasLoaded]);

  useEffect(() => {
    if (allowedSegments === null) return; // Wait until session/allowedSegments are resolved to avoid premature loading/defaulting

    const userKey = userId ? `${WATCHLIST_KEY}_${userId}` : WATCHLIST_KEY;
    let rawUser: string | null = null;
    try {
      rawUser = localStorage.getItem(userKey);
    } catch (e) {
      console.warn("localStorage.getItem userKey failed", e);
    }

    let itemsToLoad: WatchlistItem[];

    if (rawUser === null) {
      // User-specific key doesn't exist yet. Check if we should migrate from the legacy global key
      let rawLegacy: string | null = null;
      try {
        rawLegacy = localStorage.getItem(WATCHLIST_KEY);
      } catch (e) {
        console.warn("localStorage.getItem legacy failed", e);
      }

      if (rawLegacy !== null && rawLegacy !== "null") {
        try {
          itemsToLoad = JSON.parse(rawLegacy) as WatchlistItem[];
          if (!Array.isArray(itemsToLoad)) itemsToLoad = getDefaultWatchlistItems();
        } catch {
          itemsToLoad = getDefaultWatchlistItems();
        }
      } else {
        itemsToLoad = getDefaultWatchlistItems();
      }
      // Save it to the user-specific key
      try {
        localStorage.setItem(userKey, JSON.stringify(itemsToLoad));
      } catch (e) {
        console.error(e);
      }
    } else {
      try {
        itemsToLoad = JSON.parse(rawUser) as WatchlistItem[];
        if (!Array.isArray(itemsToLoad)) itemsToLoad = [];
      } catch {
        itemsToLoad = [];
      }
    }

    // Apply migrations/upgrades on the loaded items
    let migrated = false;
    const updated = itemsToLoad.map(item => {
      // Clean up broken dummy deep link items (e.g. symbol "NIFTY 50" with segment "INR")
      if (item.symbol === 'NIFTY 50' || item.segment === 'INR') {
        const defaults = getDefaultWatchlistItems();
        const match = defaults.find(d => d.symbol === 'NIFTY_FUT');
        if (match) { migrated = true; return { ...match }; }
      }
      // Upgrade legacy Forex (Frankfurter) to new CDS pairs
      if ((item.category === 'FOREX' || item.segment === 'Forex') && !item.kiteSymbol.startsWith('CDS:')) {
        const match = DEFAULT_FOREX_ITEMS.find(d => d.name === item.name || d.symbol === item.symbol);
        if (match) { migrated = true; return { ...match }; }
      }
      // Ensure COMEX items are pure MT5 symbols (XAUUSD, XAGUSD, XTIUSD, XCUUSD)
      if (item.category === 'COMEX' || item.category === 'COI' || item.segment === 'COMEX - Futures' || item.segment === 'COMEX' || (item.symbol || '').endsWith('=F') || (item.comexSymbol || '').endsWith('=F')) {
        const itemNameUpper = (item.name || '').toUpperCase();
        const itemSymUpper = (item.symbol || '').toUpperCase();
        let targetSymbol = '';
        if (itemNameUpper.includes('GOLD') || itemSymUpper.includes('GOLD') || itemSymUpper.includes('GC')) targetSymbol = 'XAUUSD';
        else if (itemNameUpper.includes('SILVER') || itemSymUpper.includes('SILVER') || itemSymUpper.includes('SI')) targetSymbol = 'XAGUSD';
        else if (itemNameUpper.includes('CRUDE') || itemSymUpper.includes('CRUDE') || itemSymUpper.includes('CL')) targetSymbol = 'XTIUSD';
        else if (itemNameUpper.includes('COPPER') || itemSymUpper.includes('COPPER') || itemSymUpper.includes('HG')) targetSymbol = 'XCUUSD';
        
        if (targetSymbol) {
          const match = DEFAULT_COMEX_ITEMS.find(d => d.symbol === targetSymbol || d.comexSymbol === targetSymbol);
          if (match) {
            migrated = true;
            return { ...match };
          } else {
            migrated = true;
            return {
              ...item,
              symbol: targetSymbol,
              kiteSymbol: '',
              comexSymbol: targetSymbol,
              category: 'COMEX',
              segment: 'COMEX - Futures'
            };
          }
        }
      }
      // Clean up MCX items that had erroneously attached comexSymbol
      if (item.kiteSymbol?.startsWith('MCX:') && item.comexSymbol) {
        migrated = true;
        const copy = { ...item };
        delete copy.comexSymbol;
        copy.segment = 'MCX - Futures';
        copy.category = 'MCX-FUT';
        return copy;
      }
      // Upgrade expired May 2026 contracts to active June 2026 contracts
      if (item.kiteSymbol && (item.kiteSymbol.includes('26MAYFUT') || item.kiteSymbol.includes('26MAY'))) {
        const allDefaults = [...DEFAULT_FOREX_ITEMS, ...DEFAULT_COMEX_ITEMS, ...getDefaultWatchlistItems()];
        const match = allDefaults.find(d => d.name === item.name || d.symbol === item.symbol);
        if (match) { migrated = true; return { ...match }; }
      }
      // Upgrade expired July 2026 Silver contract to September 2026
      if (item.kiteSymbol && item.kiteSymbol === 'MCX:SILVER26JULFUT') {
        const match = DEFAULT_COMEX_ITEMS.find(d => d.symbol === 'SILVER_FUT');
        if (match) { migrated = true; return { ...match }; }
      }
      // Fix spot index items with erroneous hardcoded contract dates
      if (item.symbol.endsWith('_INDEX') && item.contractDate) {
        migrated = true;
        return { ...item, contractDate: '' };
      }
      return item;
    });

    const finalItems = migrated ? updated : itemsToLoad;

    // Deduplicate by symbol — keep the first occurrence.
    // Guards against duplicates saved in localStorage from prior sessions.
    const seen = new Set<string>();
    const deduped = finalItems.filter(item => {
      if (seen.has(item.symbol)) return false;
      seen.add(item.symbol);
      return true;
    });

    if (deduped.length !== finalItems.length) {
      // Duplicates were found — persist the cleaned list immediately
      try { localStorage.setItem(userKey, JSON.stringify(deduped)); } catch (e) { }
    }

    setWatchlistItems(deduped);
    setHasLoaded(true);
  }, [userId, allowedSegments]);



  const getLegPrice = (legItem: WatchlistItem) => {
    if (legItem.binanceSymbol) {
      return (marketQuotes?.[legItem.binanceSymbol] || binanceQuotesAsQuoteData[legItem.binanceSymbol])?.lastPrice ?? legItem.price;
    }
    if (legItem.comexSymbol) {
      return comexQuotes?.[legItem.comexSymbol]?.lastPrice ?? legItem.price;
    }
    return (
      (legItem.kiteSymbol && marketQuotes?.[legItem.kiteSymbol]) ||
      (legItem.symbol && marketQuotes?.[legItem.symbol]) ||
      (legItem.symbol && marketQuotes?.[legItem.symbol.replace(/\s+/g, '')]) ||
      (legItem.name && marketQuotes?.[legItem.name])
    )?.lastPrice ?? legItem.price;
  };

  useEffect(() => {
    window.__kiteQuotes = marketQuotes;
    window.__binanceQuotes = marketQuotes;
    window.__comexQuotes = comexQuotes;
  }, [marketQuotes, comexQuotes]);

  useEffect(() => {
    (window as any).__reactOpenChartSheet = (item: WatchlistItem) => {
      console.log('[WINDOW HELPER] __reactOpenChartSheet called for:', item?.symbol);
      setChartItem(item);
      setIsBenchmarkChart(false);
    };
    (window as any).__reactSetChartItem = (item: WatchlistItem | null) => {
      setChartItem(item);
    };
  }, []);

  useEffect(() => {
    window.__watchlistItems = watchlistItems;
    watchlistItemsRef.current = watchlistItems;
    if (scriptMountedRef.current && typeof (window as any).attachSwipeHandlers === 'function') {
      (window as any).attachSwipeHandlers();
    }
  }, [watchlistItems, activeTab, searchText]);

  useEffect(() => {
    window.__addToWatchlistCallback = (item: WatchlistItem) => {
      setWatchlistItems(prev => {
        // If on 'All' tab, determine actual category from item's segment/category
        // so the item appears in both 'All' AND its specific category tab
        const resolvedCategory = activeTab === 'All' ? getTabForItem(item) : activeTab;
        const newItem = { ...item, category: resolvedCategory };
        // Duplicate check: same symbol already exists anywhere
        const isDuplicate = prev.some(i => i.symbol === newItem.symbol);
        if (isDuplicate) return prev;
        const next = [...prev, newItem];
        saveWatchlistToStorage(next, userId);
        // Keep inline script symbol set in sync
        if (typeof (window as any).__syncWatchlistSymbols === 'function') {
          (window as any).__syncWatchlistSymbols(next.map((i: WatchlistItem) => i.symbol));
        }
        return next;
      });
    };
    window.__removeFromWatchlistCallback = (symbol: string) => {
      setWatchlistItems(prev => {
        const next = prev.filter(i => {
          if (activeTab === 'All') return i.symbol !== symbol;
          return !(i.symbol === symbol && getTabForItem(i) === activeTab);
        });
        saveWatchlistToStorage(next, userId);
        // Keep inline script symbol set in sync
        if (typeof (window as any).__syncWatchlistSymbols === 'function') {
          (window as any).__syncWatchlistSymbols(next.map((i: WatchlistItem) => i.symbol));
        }
        return next;
      });
    };
    // Expose React handlers to window for legacy scripts
    (window as any).__reactOpenTradeSheet = (symbol: string) => {
      let item: WatchlistItem | undefined = window.__watchlistItems?.find((i: WatchlistItem) => i.symbol === symbol)
        || watchlistItems.find(i => i.symbol === symbol);

      if (!item) {
        for (const seg of tradingSegmentsRef.current) {
          const insts = [
            ...(seg.instruments || []),
            ...(seg.subCategories?.flatMap(s => s.instruments) || [])
          ];
          const found = insts.find(i => i.symbol === symbol);
          if (found) {
            item = {
              name: found.name,
              symbol: found.symbol,
              kiteSymbol: found.kiteSymbol,
              price: found.price,
              change: found.change,
              segment: found.segment,
              contractDate: found.contractDate,
              open: found.open,
              high: found.high,
              low: found.low,
              close: found.close,
              binanceSymbol: found.binanceSymbol,
              comexSymbol: found.comexSymbol,
            } as WatchlistItem;
            break;
          }
        }
      }

      if (item) {
        // Directly set state - avoid stale closure
        setSelectedItem(item);
        const computedLot = getWatchlistLotSize(item);
        setOrderQty(computedLot);
        setQtyInput(String(computedLot));
        setOrderUnit('qty');
        setOrderType('MARKET');
        setProductType('INTRADAY');
        setSelectedItem(null);
        setIsTradeSheetOpen(true);
      }
    };

    // Open trade sheet with a pre-built item object (used by position page "Add More")
    (window as any).__reactOpenTradeSheetWithItem = (item: WatchlistItem, side: 'BUY' | 'SELL' | 'BOTH' = 'BUY') => {
      setSelectedItem(item);
      setTradeSide(side);
      const computedLot = getWatchlistLotSize(item);
      setOrderQty(computedLot);
      setQtyInput(String(computedLot));
      setOrderUnit('qty');
      setOrderType('MARKET');
      setProductType('INTRADAY');
      setIsTradeSheetOpen(true);
    };

    (window as any).__reactOpenDetailSheet = (symbol: string) => {
      // Search in user watchlist first
      let item: WatchlistItem | undefined = window.__watchlistItems?.find((i: WatchlistItem) => i.symbol === symbol)
        || watchlistItems.find(i => i.symbol === symbol);

      if (!item) {
        for (const seg of tradingSegmentsRef.current) {
          const insts = [
            ...(seg.instruments || []),
            ...(seg.subCategories?.flatMap(s => s.instruments) || [])
          ];
          const found = insts.find(i => i.symbol === symbol);
          if (found) {
            item = {
              name: found.name,
              symbol: found.symbol,
              kiteSymbol: found.kiteSymbol,
              price: found.price,
              change: found.change,
              segment: found.segment,
              contractDate: found.contractDate,
              open: found.open,
              high: found.high,
              low: found.low,
              close: found.close,
              binanceSymbol: found.binanceSymbol,
              comexSymbol: found.comexSymbol,
            } as WatchlistItem;
            break;
          }
        }
      }

      if (item) {
        setIsTradeSheetOpen(false);
        setSelectedItem(item);
      }
    };

    (window as any).__reactOpenChartSheet = (item: WatchlistItem) => {
      setChartItem(item);
      setIsBenchmarkChart(false);
    };

    (window as any).__reactSetChartItem = (item: WatchlistItem | null) => {
      setChartItem(item);
    };
  }, [watchlistItems, activeTab, userId]);

  const closeDetailSheet = () => {
    isOpeningTradeSheetRef.current = false;
    setSelectedItem(null);
    setDetailOpeningSide(null);
    const ids = ['detailSheet', 'detailSheetOverlay'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('open');
        el.classList.remove('active');
      }
    });
  };

  const closeChartSheet = () => {
    isOpeningTradeSheetRef.current = false;
    setDetailOpeningSide(null);
    setChartItem(null);
    setIsBenchmarkChart(false);
    const ids = ['chartSheet', 'chartSheetOverlay'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('open');
        el.classList.remove('active');
      }
    });
  };

  const closeTradeSheet = () => {
    setIsTradeSheetOpen(false);
    setSelectedItem(null);
    setDetailOpeningSide(null);
    isOpeningTradeSheetRef.current = false;
    const ids = [
      'tradeSheet', 'detailSheet', 'chartSheet', 'basketSheet', 'checkoutSheet',
      'tradeSheetOverlay', 'detailSheetOverlay', 'chartSheetOverlay', 'basketSheetOverlay', 'checkoutSheetOverlay'
    ];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('open');
        el.classList.remove('active');
      }
    });
  };

  const openTradeSheet = async (item: WatchlistItem, side: 'BUY' | 'SELL' | 'BOTH' = 'BOTH') => {
    // Guard covers the entire async operation — not just one animation frame.
    // Also short-circuit if the sheet is already open (second tap while open).
    if (isOpeningTradeSheetRef.current || isTradeSheetOpen) {
      setDetailOpeningSide(null);
      return;
    }
    isOpeningTradeSheetRef.current = true;

    try {
      if (isSpotIndex(item)) {
        showToast('Indices cannot be traded directly. Trade their Futures or Options.', true);
        setDetailOpeningSide(null);
        return;
      }

      // ── Open the sheet immediately so the slide-up animation starts on tap ──
      setTradeSide(side);
      setSelectedItem(item);
      const computedLot = getWatchlistLotSize(item);
      setOrderQty(computedLot);
      setQtyInput(String(computedLot));
      setOrderUnit('qty');
      setOrderType('MARKET');
      setProductType('INTRADAY');
      setSlTpOpen(false);
      setSlPrice('');
      setTpPrice('');

      setIsTradeSheetOpen(true);

      // ── Strike range pre-check (runs after sheet is already open) ────────
      // For options only. If out-of-range, close the sheet and show the error.
      // Non-option instruments skip this entirely — no network round-trip on open.
      const sym = (item.symbol || '').toUpperCase();
      const isOption = sym.endsWith('CE') || sym.endsWith('PE');
      if (isOption) {
        try {
          const token = (window as any).__accessToken || '';
          const res = await fetch(
            `/api/market/strike-range-check?symbol=${encodeURIComponent(sym)}`,
            { headers: token ? { Authorization: `Bearer ${token}` } : {} }
          );
          if (res.ok) {
            const data = await res.json();
            if (data.allowed === false) {
              closeTradeSheet();
              const errMsg = data.reason || `Strike price ${data.strike} is outside the active option chain window (${data.min} to ${data.max}).`;
              window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
              return;
            }
          }
        } catch {
          // Network error → fail open, let TradeEngine catch it at order time
        }
      }
      // ─────────────────────────────────────────────────────────────────────
    } finally {
      // Lock released only after all async work is done — including the fetch.
      isOpeningTradeSheetRef.current = false;
      setDetailOpeningSide(null);
    }
  };

  const blockedSymbolsArr = useMemo(() => Array.from(blockedSymbols).sort(), [blockedSymbols]);
  const scriptContent = useMemo(() => {
    if (allowedSegments === null) return '';
    return buildInlineScript(allowedSegments, segmentSettings, blockedSymbolsArr);
  }, [allowedSegments, segmentSettings, blockedSymbolsArr]);

  useEffect(() => {
    if (!scriptContent) return;

    window.__kiteQuotes = window.__kiteQuotes || {};
    window.__watchlistItems = window.__watchlistItems || [];
    (window as any).__reactSetSelectionActive = setIsSelectionActive;

    // Expose api helpers for inline script use (avoids raw fetch in the injected script)
    (window as any).__apiPostKiteQuotes = (instruments: string[]) =>
      api.post<{ data: Record<string, any> }>('/api/kite/quotes', { instruments });
    (window as any).__apiSearchInstruments = (path: string, signal: AbortSignal) =>
      api.get<any[]>(path, { signal });

    // Reset any stale search state from previous mount
    if (typeof (window as any).__triggerSearch === 'function') {
      (window as any).__triggerSearch = null;
    }

    const script = document.createElement('script');
    script.innerHTML = scriptContent;
    document.body.appendChild(script);
    scriptMountedRef.current = true;

    // Re-attach swipe handlers after script mounts (items may already be rendered)
    requestAnimationFrame(() => {
      if (typeof (window as any).attachSwipeHandlers === 'function') {
        (window as any).attachSwipeHandlers();
      }
    });

    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
      scriptMountedRef.current = false;

      // Clear event listeners on document
      if ((window as any).__watchlistInputHandler) {
        document.removeEventListener('input', (window as any).__watchlistInputHandler);
        (window as any).__watchlistInputHandler = null;
      }
      if ((window as any).__watchlistClickHandler) {
        document.removeEventListener('click', (window as any).__watchlistClickHandler, true);
        (window as any).__watchlistClickHandler = null;
      }
      if ((window as any).__watchlistChangeHandler) {
        document.removeEventListener('change', (window as any).__watchlistChangeHandler);
        (window as any).__watchlistChangeHandler = null;
      }

      // Clear search timers and intervals
      if ((window as any).__searchPriceInterval) {
        clearInterval((window as any).__searchPriceInterval);
        (window as any).__searchPriceInterval = null;
      }
      if ((window as any).__searchDebounceTimer) {
        clearTimeout((window as any).__searchDebounceTimer);
        (window as any).__searchDebounceTimer = null;
      }

      // Clean up global state that persists across navigation and blocks other pages
      window.__selectionModeActive = false;
      window.__watchlistEventsAttached = false;
      window.__isBasketModeActive = false;
      document.body.style.overflow = '';
      document.body.style.overflowY = '';

      // Clean up global window bridge function handles
      (window as any).__reactOpenTradeSheet = null;
      (window as any).__reactOpenDetailSheet = null;
      (window as any).__reactOpenChartSheet = null;
      (window as any).__reactSetChartItem = null;
      (window as any).__addToWatchlistCallback = null;
      (window as any).__removeFromWatchlistCallback = null;
      (window as any).__syncWatchlistSymbols = null;
      (window as any).__triggerSearch = null;
      (window as any).__reactSelectAll = null;
      (window as any).__reactDeleteSelected = null;

      // Force close any open drawers/overlays left behind
      const drawerOverlay = document.getElementById('drawerOverlay');
      const folderDrawer = document.getElementById('scriptsFolderDrawer');
      if (drawerOverlay) drawerOverlay.classList.remove('active');
      if (folderDrawer) folderDrawer.classList.remove('open');
    };
  }, [scriptContent]);

  return (
    <div className="desktop-layout">
      <main className="main-viewport">
        <div className="mobile-app" suppressHydrationWarning>
          <div className="app-header">
            <div className="header-top">
              <div className="logo-area">
                <div className="logo-text">Watchlist</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <div className="folder-btn" id="openFolderMobileBtn" onClick={() => setIsFolderDrawerOpen(true)}>
                  <span>Scripts Library</span>
                  <i className="fas fa-chevron-right"></i>
                </div>
              </div>
            </div>
            <SegmentTabBar activeTab={activeTab} onTabChange={(tab) => { setActiveTab(tab); setSearchText(''); }} />
            <WatchlistSearch
              activeTab={activeTab}
              addedSymbols={new Set(watchlistItems.map(i => i.symbol))}
              onAdd={(item) => {
                setWatchlistItems(prev => {
                  const newItem = { ...item, category: activeTab };
                  if (prev.some(i => i.symbol === newItem.symbol && (activeTab === 'All' || getTabForItem(i) === activeTab))) {
                    return prev;
                  }
                  const next = [...prev, newItem];
                  saveWatchlistToStorage(next, userId);
                  if (typeof (window as any).__syncWatchlistSymbols === 'function') {
                    (window as any).__syncWatchlistSymbols(next.map((i: WatchlistItem) => i.symbol));
                  }
                  return next;
                });
              }}
              onRemove={(item) => {
                setWatchlistItems(prev => {
                  const next = prev.filter(i => i.symbol !== item.symbol);
                  saveWatchlistToStorage(next, userId);
                  if (typeof (window as any).__syncWatchlistSymbols === 'function') {
                    (window as any).__syncWatchlistSymbols(next.map((i: WatchlistItem) => i.symbol));
                  }
                  return next;
                });
              }}
              token={typeof window !== 'undefined' ? (window as any).__accessToken : undefined}
            />
          </div>

          <div className="watchlist-layout">
            <div className="main-content">

              <div className="watchlist-section">
                <div className="watchlist-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '4px', marginTop: '4px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                    <div className="watchlist-title-section">
                      <div className="watchlist-title">MY WATCHLIST</div>
                      <div className="watchlist-count" id="mobileWatchlistCounter">{filteredItems.length} item{filteredItems.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div className="action-hint" style={{ padding: 0, background: 'transparent' }}>Swipe | Tap to trade</div>
                  </div>
                </div>
                <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span className="add-hint">Add scripts to watchlist from Scripts Library</span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {isSelectionActive && (
                      <div className="folder-btn select-all-btn"
                        onClick={() => {
                          if (typeof (window as any).__reactSelectAll === 'function') (window as any).__reactSelectAll();
                        }}>
                        <span>All</span>
                      </div>
                    )}
                    <div className={`folder-btn basket-btn ${isSelectionActive ? 'is-delete' : ''}`} id="basketModeBtn"
                      onClick={() => {
                        if (isSelectionActive) {
                          if (typeof (window as any).__reactDeleteSelected === 'function') (window as any).__reactDeleteSelected();
                        } else {
                          setBasketMode(b => !b);
                        }
                      }}>
                      {isSelectionActive ? <span>Delete</span> : <span>Basket</span>}
                    </div>
                    <div className="folder-btn dustbin-btn"
                      onClick={() => {
                        if (isSelectionActive) {
                          setIsSelectionActive(false);
                          if (typeof (window as any).exitSelectionMode === 'function') (window as any).exitSelectionMode();
                        } else {
                          setIsSelectionActive(true);
                          setBasketMode(false);
                          if (typeof (window as any).enterSelectionMode === 'function') (window as any).enterSelectionMode();
                        }
                      }}>
                      <i className={isSelectionActive ? "fas fa-times" : "fas fa-trash-alt"}></i>
                    </div>
                  </div>
                </div>
                <div className="watchlist-card-list" style={{ paddingBottom: basketMode ? '120px' : '0px' }}>
                  {allowedSegments === null ? (
                    <div style={{ padding: '40px 0' }}>
                      <AnimatedLoader text="Loading watchlist..." />
                    </div>
                  ) : filteredItems.length === 0 ? <EmptyState /> : filteredItems.map((item, index) => (
                    <InstrumentRow
                      key={`${item.symbol}_${index}`}
                      item={item}
                      quote={
                        (item.kiteSymbol && marketQuotes[item.kiteSymbol]) ||
                        (item.symbol && marketQuotes[item.symbol]) ||
                        (item.symbol && marketQuotes[item.symbol.replace(/\s+/g, '')]) ||
                        (item.name && marketQuotes[item.name]) ||
                        (item.binanceSymbol ? marketQuotes[item.binanceSymbol] : undefined)
                      }
                      binanceQuote={item.binanceSymbol ? (marketQuotes[item.binanceSymbol] || binanceQuotesAsQuoteData[item.binanceSymbol]) : undefined}
                      comexQuote={item.comexSymbol ? comexQuotes[item.comexSymbol] : undefined}
                      onTrade={(it: WatchlistItem, type?: 'BUY' | 'SELL' | 'BOTH') => {
                        if (!isMarketOpen(it)) { showToast('Market is closed', true); return; }
                        openTradeSheet(it, type);
                      }}
                      onDetail={openDetailSheet}
                      basketMode={basketMode}
                      onBasketBuy={(it) => {
                        if (isSpotIndex(it)) { showToast('Indices cannot be traded directly.', true); return; }
                        if (!isMarketOpen(it)) { showToast('Market is closed', true); return; }
                        setBasketLegs(prev => {
                          // If BUY leg already exists for this symbol, remove it (toggle off)
                          const exists = prev.find(l => l.item.symbol === it.symbol && l.side === 'BUY');
                          if (exists) {
                            showToast(`${it.name} BUY removed`, false);
                            return prev.filter(l => !(l.item.symbol === it.symbol && l.side === 'BUY'));
                          }
                          showToast(`${it.name} BUY added to basket ✓`, false);
                          return [...prev, { item: it, side: 'BUY', qty: 1, unit: 'qty', productType: 'INTRADAY' }];
                        });
                      }}
                      onBasketSell={(it) => {
                        if (isSpotIndex(it)) { showToast('Indices cannot be traded directly.', true); return; }
                        if (!isMarketOpen(it)) { showToast('Market is closed', true); return; }
                        setBasketLegs(prev => {
                          // If SELL leg already exists for this symbol, remove it (toggle off)
                          const exists = prev.find(l => l.item.symbol === it.symbol && l.side === 'SELL');
                          if (exists) {
                            showToast(`${it.name} SELL removed`, false);
                            return prev.filter(l => !(l.item.symbol === it.symbol && l.side === 'SELL'));
                          }
                          showToast(`${it.name} SELL added to basket ✓`, false);
                          return [...prev, { item: it, side: 'SELL', qty: 1, unit: 'qty', productType: 'INTRADAY' }];
                        });
                      }}
                      onChart={(item) => {
                        setSelectedItem(null);
                        setChartItem(item);
                        setIsBenchmarkChart(false);
                      }}
                    />
                  ))}
                  <div id="watchlistMobileContainer"></div>
                </div>
              </div>
            </div>

            {/* Basket bottom bar */}
            {basketMode && (
              <div style={{
                position: 'fixed', bottom: '92px', left: '50%', transform: 'translateX(-50%)',
                width: 'calc(100% - 24px)', maxWidth: '476px',
                background: 'var(--container-bg, #FFFFFF)',
                borderTop: '1px solid var(--border-light, #E8ECF0)', padding: '10px 16px',
                boxShadow: '0 -4px 16px rgba(0,0,0,0.15)', zIndex: 44,
                boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '8px',
                borderRadius: '16px'
              }}>
                <div style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-primary, #1A1E2B)' }}>
                  {basketLegs.length} in basket
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => { setBasketMode(false); setBasketLegs([]); }}
                    style={{ flex: 1, background: 'var(--icon-bg, #F3F4F6)', color: 'var(--text-secondary, #4B5563)', border: 'none', padding: '11px 0', borderRadius: '30px', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                  >
                    <i className="fas fa-times"></i> Cancel
                  </button>
                  <button
                    onClick={() => setIsBasketSheetOpen(true)}
                    style={{ flex: 2, background: '#15803D', color: '#fff', border: 'none', padding: '11px 0', borderRadius: '30px', fontSize: '0.85rem', fontWeight: '800', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                  >
                    <i className="fas fa-shopping-basket"></i> View Basket
                  </button>
                </div>
              </div>
            )}

            {/* TradeSheet is always mounted so the dynamic import fires at page load,
                not on the first tap. The sheet opens/closes via the item prop:
                non-null = open, null = closed (TradeSheet renders isOpen = !!item). */}
            <TradeSheet
              item={isTradeSheetOpen && selectedItem ? selectedItem as any : null}
              side={tradeSide === 'BOTH' ? 'BUY' : tradeSide}
              onClose={closeTradeSheet}
              hideLotText={true}
            />

            <div id="detailSheetOverlay" className={`trade-sheet-overlay${(selectedItem && !isTradeSheetOpen && !chartItem) ? ' active' : ''}`} onClick={() => closeDetailSheet()}></div>
            <div id="detailSheet" className={`trade-sheet detail-sheet${(selectedItem && !isTradeSheetOpen && !chartItem) ? ' open' : ''}`} style={{ height: 'auto', maxHeight: '72dvh', paddingBottom: '16px' }}>
              <div className="sheet-handle"><div className="handle-bar"></div></div>
              {selectedItem && (() => {
                const dbSeg = mapSegmentWithSymbol(selectedItem.segment || '', selectedItem.symbol);
                const isDetailCrypto = dbSeg === 'CRYPTO' || (selectedItem.symbol || '').endsWith('USDT') || !!selectedItem.binanceSymbol;
                const isDetailComex = dbSeg === 'COMEX' || !!selectedItem.comexSymbol;
                const isDetailIndian = !isDetailCrypto && !isDetailComex;

                const buySegSetting = segmentSettings.find((s: any) =>
                  ((s.segment || '').toUpperCase() === (dbSeg || '').toUpperCase() || (s.segment || '').toUpperCase() === (selectedItem.segment || '').toUpperCase()) &&
                  (s.side || '').toUpperCase() === 'BUY'
                );
                const sellSegSetting = segmentSettings.find((s: any) =>
                  ((s.segment || '').toUpperCase() === (dbSeg || '').toUpperCase() || (s.segment || '').toUpperCase() === (selectedItem.segment || '').toUpperCase()) &&
                  (s.side || '').toUpperCase() === 'SELL'
                );

                // ── Two-Layer Price Model: Layer 1 (Display) ──────────────────────────
                // bid_buffer creates the displayed spread shown to the user.
                // entry/exit buffer is hidden, applied only at execution.
                //
                // LTP mode    : Ask = LTP + LTP*bid_buffer%   |  Bid = LTP - LTP*bid_buffer%
                // BID/ASK mode: Ask = RealAsk + LTP*bid_buffer%  |  Bid = RealBid - LTP*bid_buffer%
                const isDetailCommodity = dbSeg.toUpperCase().includes('MCX') ||
                  ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(c =>
                    (selectedItem.symbol || selectedItem.name || '').toUpperCase().includes(c));
                const isDetailIndianNonCommodity = isDetailIndian && !isDetailCommodity;
                const detailBidBufferRaw = isDetailIndianNonCommodity ? 0 : Number(buySegSetting?.bid_buffer ?? sellSegSetting?.bid_buffer ?? 0);
                const detailBidBufferDecimal = Math.abs(detailBidBufferRaw) > 0.005 ? detailBidBufferRaw / 100 : detailBidBufferRaw;
                const detailBidBufferAmount = currentLtp * detailBidBufferDecimal; // always LTP-based

                const detailExecMode = buySegSetting?.exit_price_mode || sellSegSetting?.exit_price_mode || 'BID_ASK';
                const detailHasRealBidAsk = Boolean(rawBid && rawAsk && rawBid > 0 && rawAsk > 0 && rawBid < rawAsk);
                const detailUseLtpMode = detailExecMode === 'LTP' || isDetailCommodity || !detailHasRealBidAsk;

                let bid: number;
                let ask: number;
                if (detailUseLtpMode) {
                  ask = currentLtp + detailBidBufferAmount;
                  bid = currentLtp - detailBidBufferAmount;
                } else {
                  ask = rawAsk + detailBidBufferAmount;
                  bid = rawBid - detailBidBufferAmount;
                }
                if (bid <= 0) bid = currentLtp;
                if (ask <= 0) ask = currentLtp;
                
                const ltp = currentLtp;
                const chgPct = currentChangePercent;
                const fmt = (v: number) => formatPrice(v);
                return (
                  <div style={{ padding: '0' }}>
                    <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
                        <button style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'var(--icon-bg)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: '0', flexShrink: 0 }} onClick={() => closeDetailSheet()}>
                          <i className="fas fa-chevron-left" style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}></i>
                        </button>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div style={{ fontSize: '1.2rem', fontWeight: '800', color: 'var(--text-primary)', lineHeight: '1.15' }}>{selectedItem.name}</div>
                          <div>
                            <span style={{ fontSize: '0.51rem', fontWeight: '700', color: '#DC2626', background: '#FEF2F2', padding: '2px 6px', borderRadius: '20px', lineHeight: '1', display: 'inline-block' }}>{selectedItem.segment}</span>
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', textAlign: 'right' }}>
                        <span style={{ fontSize: '0.65rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '1px', lineHeight: '1' }}>CMP</span>
                        <div style={{ fontSize: '1.3rem', fontWeight: '800', color: 'var(--text-primary)', lineHeight: '1.1', letterSpacing: '-0.3px' }}>{fmt(ltp)}</div>
                        <span className="sheet-change" style={{ fontSize: '0.78rem', fontWeight: '700', padding: '0', lineHeight: '1', color: chgPct >= 0 ? '#059669' : '#DC2626' }}>{chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%</span>
                      </div>
                    </div>
                    <div style={{ height: '1px', background: 'var(--border-light)', margin: '0 0 8px', width: '100%' }}></div>
                    <div style={{ padding: '0 12px 10px 12px' }}>
                      {/* Open Trading Chart Button */}
                      <button
                        style={{
                          width: '100%',
                          padding: '9px',
                          borderRadius: '50px',
                          border: '1px solid rgba(44, 142, 90, 0.6)',
                          background: 'transparent',
                          color: '#2C8E5A',
                          fontFamily: 'Inter, sans-serif',
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '8px',
                          marginBottom: '8px',
                          transition: 'all 0.18s'
                        }}
                        onClick={() => {
                          const item = selectedItem;
                          setSelectedItem(null);
                          setChartItem(item);
                          setIsBenchmarkChart(false);
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          style={{
                            width: '1.1rem',
                            height: '1.1rem',
                            display: 'inline-block',
                            verticalAlign: 'middle',
                          }}
                        >
                          {/* Bars */}
                          <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                          <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                          <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                          <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />

                          {/* Trendline */}
                          <path
                            d="M 4 14 L 8 9 L 13 12 L 20 4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          {/* Arrowhead */}
                          <polyline
                            points="15 4 20 4 20 9"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        Open Trading Chart
                      </button>

                      <div style={{ background: 'var(--card-alt-bg)', border: '1px solid var(--border-card)', borderRadius: '14px', padding: '8px 12px', display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>BID</div>
                          <div style={{ fontSize: '0.9rem', fontWeight: '700', color: '#059669' }}>{fmt(bid)}</div>
                        </div>
                        <div style={{ width: '1px', background: 'var(--border-card)', height: '24px' }}></div>
                        <div style={{ flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>ASK</div>
                          <div style={{ fontSize: '0.9rem', fontWeight: '700', color: '#DC2626' }}>{fmt(ask)}</div>
                        </div>
                      </div>
                      <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: '0.62rem', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '6px' }}>PRICE SUMMARY</div>
                        <div style={{ background: 'var(--card-alt-bg)', border: '1px solid var(--border-card)', borderRadius: '14px', padding: '8px 10px', display: 'flex', justifyContent: 'space-between' }}>
                          <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.52rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>OPEN</div><div style={{ fontSize: '0.72rem', fontWeight: '700', color: '#059669' }}>{fmt(detailOpen ?? 0)}</div></div>
                          <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.52rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>HIGH</div><div style={{ fontSize: '0.72rem', fontWeight: '700', color: '#059669' }}>{fmt(detailHigh ?? 0)}</div></div>
                          <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.52rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>LOW</div><div style={{ fontSize: '0.72rem', fontWeight: '700', color: '#DC2626' }}>{fmt(detailLow ?? 0)}</div></div>
                          <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.52rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>CLOSE</div><div style={{ fontSize: '0.72rem', fontWeight: '700', color: 'var(--text-primary)' }}>{fmt(detailClose ?? 0)}</div></div>
                        </div>
                      </div>
                      <div style={{ background: 'var(--card-alt-bg)', border: '1px solid var(--border-card)', borderRadius: '14px', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <div style={{ fontSize: '0.65rem', fontWeight: '600', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}><i className="far fa-calendar-alt"></i> CONTRACT DATE</div>
                        <div style={{ fontSize: '0.72rem', fontWeight: '700', color: 'var(--text-primary)', background: 'var(--bg-card)', padding: '3px 10px', borderRadius: '20px' }}>{selectedItem.contractDate}</div>
                      </div>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                          style={{
                            flex: 1,
                            background: detailOpeningSide === 'SELL' ? 'rgba(21,128,61,0.35)' : '#15803D',
                            color: 'white',
                            border: 'none',
                            padding: '11px 0',
                            borderRadius: '30px',
                            fontSize: '0.9rem',
                            fontWeight: '800',
                            cursor: detailOpeningSide ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            gap: '6px',
                            touchAction: 'manipulation',
                            transition: 'background 0.2s, opacity 0.2s',
                          }}
                          disabled={!!detailOpeningSide}
                          onClick={() => {
                            if (!isOpeningTradeSheetRef.current && !isTradeSheetOpen && selectedItem) {
                              setDetailOpeningSide('BUY');
                              openTradeSheet(selectedItem, 'BUY');
                            }
                          }}
                        >
                          {detailOpeningSide === 'BUY' ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" style={{ animation: 'spin 0.7s linear infinite' }}>
                              <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="3" />
                              <path d="M12 2 a10 10 0 0 1 10 10" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" />
                            </svg>
                          ) : (
                            <i className="fas fa-arrow-up"></i>
                          )}
                          BUY
                        </button>
                        <button
                          style={{
                            flex: 1,
                            background: detailOpeningSide === 'BUY' ? 'rgba(185,28,28,0.35)' : '#B91C1C',
                            color: 'white',
                            border: 'none',
                            padding: '11px 0',
                            borderRadius: '30px',
                            fontSize: '0.9rem',
                            fontWeight: '800',
                            cursor: detailOpeningSide ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            gap: '6px',
                            touchAction: 'manipulation',
                            transition: 'background 0.2s, opacity 0.2s',
                          }}
                          disabled={!!detailOpeningSide}
                          onClick={() => {
                            if (isOpeningTradeSheetRef.current || isTradeSheetOpen || detailOpeningSide) return;
                            if (selectedItem) {
                              setDetailOpeningSide('SELL');
                              openTradeSheet(selectedItem, 'SELL');
                            }
                          }}
                        >
                          {detailOpeningSide === 'SELL' ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" style={{ animation: 'spin 0.7s linear infinite' }}>
                              <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="3" />
                              <path d="M12 2 a10 10 0 0 1 10 10" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" />
                            </svg>
                          ) : (
                            <i className="fas fa-arrow-down"></i>
                          )}
                          SELL
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div id="basketSheetOverlay" className={`trade-sheet-overlay${isBasketSheetOpen ? ' active' : ''}`} onClick={() => setIsBasketSheetOpen(false)}></div>

            <div id="basketSheet" className={`trade-sheet detail-sheet${isBasketSheetOpen ? ' open' : ''}`} style={{ height: '100dvh', maxHeight: '100dvh', width: '100vw', top: 0, left: 0, bottom: 0, position: 'fixed', zIndex: 100000, borderRadius: 0, paddingBottom: '30px', background: 'var(--bg-body, #F5F7FB)' }}>
              <div style={{ padding: '24px 20px 20px 20px', height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '12px' }}>
                  <button
                    onClick={() => setIsBasketSheetOpen(false)}
                    style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-primary)', padding: 0 }}
                  >
                    <i className="fas fa-arrow-left"></i>
                  </button>
                  <div className="basket-sheet-title" style={{ fontSize: '1.2rem', fontWeight: '800', margin: 0 }}><i className="fas fa-shopping-basket"></i> Basket Orders</div>
                </div>

                {/* Basket legs - React rendered */}
                <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {basketLegs.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '24px', color: '#9CA3AF', fontSize: '0.8rem' }}>
                      <i className="fas fa-shopping-basket" style={{ fontSize: '2rem', marginBottom: '8px', display: 'block', opacity: 0.3 }}></i>
                      No items. Tap BUY/SELL on any stock.
                    </div>
                  ) : basketLegs.map((leg, i) => {
                    const ltp = getLegPrice(leg.item);
                    const totalVal = ltp * leg.qty;
                    const legSymbol = '₹';
                    return (
                      <div key={i} style={{ background: 'var(--card-alt-bg, #F8FAFF)', border: '1px solid var(--border-card, #EEF2F8)', borderRadius: '16px', padding: '14px' }}>
                        {/* Header row */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                          <span style={{ fontSize: '0.9rem', fontWeight: '800', color: 'var(--text-primary, #1A1E2B)' }}>{leg.item.name}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-primary, #1A1E2B)' }}>{legSymbol}{totalVal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                            <button onClick={() => setBasketLegs(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#C62E2E', cursor: 'pointer', fontSize: '0.9rem', padding: '0' }}>
                              <i className="fas fa-trash-alt"></i>
                            </button>
                          </div>
                        </div>
                        {/* Order unit row */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                          <span style={{ fontSize: '0.6rem', fontWeight: '700', color: 'var(--text-muted, #8C94A8)', letterSpacing: '0.5px' }}>ORDER UNIT</span>
                          <div style={{ display: 'flex', background: 'var(--bg-card, #FFFFFF)', border: '1px solid var(--border-card, #E2E6EC)', borderRadius: '20px', overflow: 'hidden' }}>
                            <button
                              onClick={() => setBasketLegs(prev => prev.map((l, j) => j === i ? { ...l, unit: 'qty' } : l))}
                              style={{ padding: '4px 12px', fontSize: '0.65rem', fontWeight: '700', border: 'none', cursor: 'pointer', background: leg.unit !== 'lot' ? '#4B5563' : 'transparent', color: '#fff' }}
                            >QTY</button>
                            <button
                              onClick={() => setBasketLegs(prev => prev.map((l, j) => j === i ? { ...l, unit: 'lot' } : l))}
                              style={{ padding: '4px 12px', fontSize: '0.65rem', fontWeight: '700', border: 'none', cursor: 'pointer', background: leg.unit === 'lot' ? '#4B5563' : 'transparent', color: leg.unit === 'lot' ? '#fff' : 'var(--text-secondary, #6B7280)' }}
                            >LOT</button>
                          </div>
                        </div>
                        {/* B/S toggle + qty stepper */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ display: 'flex', borderRadius: '20px', overflow: 'hidden', border: '1px solid var(--border-card, #E2E6EC)' }}>
                            <button
                              onClick={() => setBasketLegs(prev => prev.map((l, j) => j === i ? { ...l, side: 'BUY' } : l))}
                              style={{ padding: '6px 14px', fontSize: '0.72rem', fontWeight: '800', border: 'none', cursor: 'pointer', background: leg.side === 'BUY' ? '#1a8a3a' : 'var(--icon-bg, #F3F4F6)', color: leg.side === 'BUY' ? '#fff' : 'var(--text-secondary, #6B7280)' }}
                            >B</button>
                            <button
                              onClick={() => setBasketLegs(prev => prev.map((l, j) => j === i ? { ...l, side: 'SELL' } : l))}
                              style={{ padding: '6px 14px', fontSize: '0.72rem', fontWeight: '800', border: 'none', cursor: 'pointer', background: leg.side === 'SELL' ? '#b91c1c' : 'var(--icon-bg, #F3F4F6)', color: leg.side === 'SELL' ? '#fff' : 'var(--text-secondary, #6B7280)' }}
                            >S</button>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--card-alt-bg, #F3F4F6)', border: '1px solid var(--border-card, #E2E6EC)', borderRadius: '20px', padding: '4px 14px' }}>
                            <button onClick={() => setBasketLegs(prev => prev.map((l, j) => j === i ? { ...l, qty: Math.max(1, l.qty - 1) } : l))} style={{ background: 'none', border: 'none', fontSize: '0.9rem', cursor: 'pointer', color: 'var(--text-secondary, #6B7280)', padding: '0' }}>−</button>
                            <span style={{ fontSize: '0.85rem', fontWeight: '700', minWidth: '20px', textAlign: 'center', color: 'var(--text-primary, #1A1E2B)' }}>{leg.qty}</span>
                            <button onClick={() => setBasketLegs(prev => prev.map((l, j) => j === i ? { ...l, qty: l.qty + 1 } : l))} style={{ background: 'none', border: 'none', fontSize: '0.9rem', cursor: 'pointer', color: 'var(--text-secondary, #6B7280)', padding: '0' }}>+</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>


                <div style={{ display: 'flex', gap: '12px', width: '100%', padding: '0 4px' }}>
                  <button
                    style={{ flex: 1, background: '#2C8E5A', color: 'white', border: 'none', padding: '17px 8px', borderRadius: '16px', fontSize: '0.9rem', fontWeight: '800', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px', boxShadow: '0 6px 14px rgba(44,142,90,0.3)', minWidth: 0, whiteSpace: 'nowrap' }}
                    onClick={() => setIsCheckoutSheetOpen(true)}
                  >
                    <i className="fas fa-bolt" style={{ lineHeight: 1, fontSize: '0.9rem' }}></i> Checkout
                  </button>
                  <button
                    style={{ flex: 1, background: 'var(--icon-bg, #EFEFEF)', color: 'var(--text-secondary, #6B7280)', border: 'none', padding: '17px 8px', borderRadius: '16px', fontSize: '0.9rem', fontWeight: '600', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '7px', minWidth: 0, whiteSpace: 'nowrap' }}
                    onClick={() => {
                      setBasketLegs([]);
                      setIsBasketSheetOpen(false);
                    }}
                  >
                    <i className="fas fa-trash-alt" style={{ opacity: 0.5 }}></i> Clear
                  </button>
                </div>
              </div>
            </div>

            {/* Checkout Sheet */}
            <div id="checkoutSheetOverlay" className={`trade-sheet-overlay${isCheckoutSheetOpen ? ' active' : ''}`} onClick={() => setIsCheckoutSheetOpen(false)}></div>
            <div id="checkoutSheet" className={`trade-sheet detail-sheet${isCheckoutSheetOpen ? ' open' : ''}`} style={{ height: '100dvh', maxHeight: '100dvh', width: '100vw', top: 0, left: 0, bottom: 0, position: 'fixed', zIndex: 100000, borderRadius: 0, background: 'var(--bg-body, #F5F7FB)', display: 'flex', flexDirection: 'column', padding: 0 }}>

              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-light, #EEF2F8)', background: 'var(--card-bg, #fff)', flexShrink: 0 }}>
                <button onClick={() => setIsCheckoutSheetOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px 10px 4px 0', fontSize: '1.05rem' }}>
                  <i className="fas fa-arrow-left" />
                </button>
                <div>
                  <div style={{ fontSize: '1rem', fontWeight: '800', color: 'var(--text-primary)' }}>Checkout</div>
                  <div style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-muted, #8C94A8)' }}>{basketLegs.length} item{basketLegs.length !== 1 ? 's' : ''} to execute</div>
                </div>
              </div>

              {/* Scrollable body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

                {/* Leg cards */}
                {basketLegs.map((leg, i) => {
                  const ltp = getLegPrice(leg.item);
                  const lotSz = getLotSize(leg.item.symbol || leg.item.name || '');
                  const qty = leg.unit === 'lot' ? leg.qty * lotSz : leg.qty;
                  const isBuy = leg.side === 'BUY';
                  return (
                    <div key={`chk_${i}`} style={{ background: 'var(--card-bg, #fff)', border: '1px solid var(--border-card, #EEF2F8)', borderRadius: '14px', padding: '14px 16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '0.6rem', fontWeight: '800', padding: '3px 8px', borderRadius: '5px', background: isBuy ? '#E9F6EF' : '#FEF0F0', color: isBuy ? '#15803D' : '#C62E2E', letterSpacing: '0.04em' }}>{leg.side}</span>
                          <span style={{ fontSize: '0.9rem', fontWeight: '800', color: 'var(--text-primary)' }}>{leg.item.name || leg.item.symbol}</span>
                        </div>
                        <span style={{ fontSize: '0.9rem', fontWeight: '700', color: 'var(--text-primary)' }}>₹{(ltp * qty).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', gap: '10px' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-secondary)' }}>{leg.qty} {leg.unit.toUpperCase()}</span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>@ ₹{ltp.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div style={{ display: 'flex', background: 'var(--bg-body, #F5F7FB)', borderRadius: '8px', padding: '2px', gap: '2px', opacity: isExecutingBasket ? 0.5 : 1, pointerEvents: isExecutingBasket ? 'none' : 'auto' }}>
                          {(['INTRADAY', 'CARRY'] as const).map(pt => {
                            const active = (leg.productType || 'INTRADAY') === pt;
                            return (
                              <div key={pt} onClick={() => !isExecutingBasket && setBasketLegs(prev => prev.map((l, idx) => idx === i ? { ...l, productType: pt } : l))}
                                style={{ padding: '3px 10px', fontSize: '0.65rem', fontWeight: '700', borderRadius: '6px', cursor: 'pointer', background: active ? 'var(--card-bg, #fff)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)', boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.15s' }}>
                                {pt === 'INTRADAY' ? 'Intraday' : 'Carry'}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Summary card */}
                {(() => {
                  let totalMargin = 0, intradayCharges = 0, carryCharges = 0;
                  basketLegs.forEach((leg) => {
                    const price = getLegPrice(leg.item); const seg = mapSegmentToDbSegment(leg.item.segment); const setting = getSegment(seg, leg.side);
                    const lotSz = getLotSize(leg.item.symbol || leg.item.name || ''); const qty = leg.unit === 'lot' ? leg.qty * lotSz : leg.qty; const exposure = qty * price;
                    const isIntra = (leg.productType || 'INTRADAY') === 'INTRADAY';
                    const lev = Number(isIntra ? (setting?.intraday_leverage ?? 10) : (setting?.normal_leverage ?? 10));
                    const levType = (isIntra ? setting?.intraday_type : setting?.normal_type) ?? 'Multiplier';
                    if (levType === '%') totalMargin += exposure * (lev / 100);
                    else if (levType === 'Fixed') totalMargin += (qty / lotSz) * lev;
                    else totalMargin += exposure / lev;
                    const commType = (isIntra ? setting?.intraday_commission_type : setting?.commission_type) || setting?.commission_type || 'Per Crore';
                    let commVal = Number((isIntra ? setting?.intraday_commission_value : setting?.commission_value) ?? setting?.commission_value ?? 0);
                    if (!setting) { const sU = (leg.item.segment || '').toUpperCase(); commVal = sU.includes('FOREX') ? 2000 : sU.includes('CRYPTO') ? 1000 : 4500; }
                    let charge = 0;
                    if (commType === 'Per Crore') charge = (exposure * commVal) / 10000000;
                    else if (commType === 'Per Lot') charge = (qty / lotSz) * commVal;
                    else if (commType === 'Per Trade' || commType === 'Flat') charge = commVal;
                    else charge = exposure * 0.001;
                    if (isIntra) intradayCharges += charge * 2; else carryCharges += charge * 2;
                  });
                  const totalCharges = intradayCharges + carryCharges;
                  const totalValue = basketLegs.reduce((acc, l) => { const lz = getLotSize(l.item.symbol || l.item.name || ''); const q = l.unit === 'lot' ? l.qty * lz : l.qty; return acc + getLegPrice(l.item) * q; }, 0);
                  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--border-light, #EEF2F8)' };
                  const lbl: React.CSSProperties = { fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-muted, #8C94A8)' };
                  const val: React.CSSProperties = { fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-primary)' };
                  return (
                    <div style={{ background: 'var(--card-bg, #fff)', border: '1px solid var(--border-card, #EEF2F8)', borderRadius: '14px', padding: '4px 16px 10px' }}>
                      <div style={row}><span style={lbl}>Total Value</span><span style={val}>₹{totalValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
                      <div style={row}><span style={lbl}>Required Margin</span><span style={{ ...val, color: '#C62E2E' }}>₹{totalMargin.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
                      <div style={{ ...row, cursor: 'pointer' }} onClick={() => setShowChargesBreakdown(!showChargesBreakdown)}>
                        <span style={{ ...lbl, display: 'flex', alignItems: 'center', gap: '5px' }}>Charges <i className="fas fa-chevron-down" style={{ fontSize: '0.6rem', transition: 'transform 0.2s', transform: showChargesBreakdown ? 'rotate(180deg)' : 'none' }} /></span>
                        <span style={{ ...val, color: '#C62E2E' }}>₹{totalCharges.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                      {showChargesBreakdown && (
                        <div style={{ padding: '8px 10px 6px', background: 'var(--bg-body, #F5F7FB)', borderRadius: '8px', marginBottom: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {[['Intraday Brokerage', intradayCharges], ['Carry Brokerage', carryCharges]].map(([label, v]) => (
                            <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{label}</span>
                              <span style={{ fontSize: '0.72rem', fontWeight: '700', color: 'var(--text-primary)' }}>₹{(v as number).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '10px' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: '700', color: 'var(--text-primary)' }}>Available Balance</span>
                        <span style={{ fontSize: '0.88rem', fontWeight: '800', color: '#2C8E5A' }}>{availableBalance !== null ? `₹${availableBalance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '₹0.00'}</span>
                      </div>
                    </div>
                  );
                })()}

              </div>{/* end scrollable body */}

              {/* Sticky bottom actions */}
              <div style={{ flexShrink: 0, padding: '14px 20px', paddingBottom: 'max(14px, env(safe-area-inset-bottom))', borderTop: '1px solid var(--border-light, #EEF2F8)', background: 'var(--card-bg, #fff)', display: 'flex', gap: '10px' }}>
                <button
                  disabled={isExecutingBasket}
                  onClick={async () => {
                    if (isExecutingBasket) return;
                    let totalRequiredMargin = 0, intradayCharges = 0, carryCharges = 0;
                    basketLegs.forEach((leg) => {
                      const price = getLegPrice(leg.item); const seg = mapSegmentWithSymbol(leg.item.segment, leg.item.symbol || leg.item.name || ''); const setting = getSegment(seg, leg.side);
                      const lotSz = getLotSize(leg.item.symbol || leg.item.name || ''); const qty = leg.unit === 'lot' ? leg.qty * lotSz : leg.qty; const exposure = qty * price;
                      const isIntra = (leg.productType || 'INTRADAY') === 'INTRADAY';
                      const lev = Number(isIntra ? (setting?.intraday_leverage ?? 10) : (setting?.normal_leverage ?? 10));
                      const levType = (isIntra ? setting?.intraday_type : setting?.normal_type) ?? 'Multiplier';
                      if (levType === '%') totalRequiredMargin += exposure * (lev / 100);
                      else if (levType === 'Fixed') totalRequiredMargin += (qty / lotSz) * lev;
                      else totalRequiredMargin += exposure / lev;
                      const commType = (isIntra ? setting?.intraday_commission_type : setting?.commission_type) || setting?.commission_type || 'Per Crore';
                      let commVal = Number((isIntra ? setting?.intraday_commission_value : setting?.commission_value) ?? setting?.commission_value ?? 0);
                      if (!setting) { const sU = (leg.item.segment || '').toUpperCase(); commVal = sU.includes('FOREX') ? 2000 : sU.includes('CRYPTO') ? 1000 : 4500; }
                      let charge = 0;
                      if (commType === 'Per Crore') charge = (exposure * commVal) / 10000000;
                      else if (commType === 'Per Lot') charge = (qty / lotSz) * commVal;
                      else if (commType === 'Per Trade' || commType === 'Flat') charge = commVal;
                      else charge = exposure * 0.001;
                      if (isIntra) intradayCharges += charge * 2; else carryCharges += charge * 2;
                    });
                    const totalNeeded = totalRequiredMargin + intradayCharges + carryCharges;
                    const avBal = availableBalance ?? 0;
                    if (avBal < totalNeeded) { setErrorModalMsg(`Required: ₹${totalNeeded.toLocaleString('en-IN', { minimumFractionDigits: 2 })}\nAvailable: ₹${avBal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`); return; }
                    setIsExecutingBasket(true);
                    const safetyTimer = setTimeout(() => setIsExecutingBasket(false), 10000);
                    try {
                      const results: boolean[] = [];
                      for (const leg of basketLegs) {
                        const ltp = getLegPrice(leg.item);
                        const lotSz = getLotSize(leg.item.symbol || leg.item.name || '');
                        const qty = leg.unit === 'lot' ? leg.qty * lotSz : leg.qty;
                        try {
                          const res = await placeOrder({
                            symbol: leg.item.symbol,
                            kite_instrument: leg.item.kiteSymbol || leg.item.symbol,
                            segment: leg.item.segment,
                            side: leg.side,
                            qty,
                            lots: leg.unit === 'lot' ? leg.qty : Math.ceil(leg.qty / lotSz),
                            order_type: 'MARKET',
                            product_type: leg.productType || 'INTRADAY',
                            client_price: ltp
                          });
                          if (res && !res.success) {
                            showToast(`${leg.side} ${leg.item.symbol} failed: ${res.error || 'Unknown error'}`, true);
                            results.push(false);
                          } else {
                            results.push(true);
                          }
                        } catch (e: any) {
                          showToast(`${leg.side} ${leg.item.symbol} failed: ${e?.message || 'Unknown error'}`, true);
                          results.push(false);
                        }
                        // Small delay to ensure the Redis lock is fully released
                        await new Promise((resolve) => setTimeout(resolve, 150));
                      }
                      const successCount = results.filter(Boolean).length;
                      const failCount = results.length - successCount;
                      if (failCount === 0) {
                        showToast('Basket executed successfully!', false);
                        setBasketLegs([]); setBasketMode(false);
                        setIsCheckoutSheetOpen(false);
                        setIsBasketSheetOpen(false);
                      } else {
                        showToast(`${successCount} order(s) placed, ${failCount} failed.`, true);
                      }
                    } finally { clearTimeout(safetyTimer); setIsExecutingBasket(false); }
                  }}
                  style={{ flex: 1.5, background: isExecutingBasket ? '#9CA3AF' : '#2C8E5A', color: '#fff', border: 'none', padding: '15px 0', borderRadius: '14px', fontSize: '0.9rem', fontWeight: '800', cursor: isExecutingBasket ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', whiteSpace: 'nowrap', boxShadow: isExecutingBasket ? 'none' : '0 4px 12px rgba(44,142,90,0.25)' }}
                >
                  {isExecutingBasket ? <><AnimatedLoader size="small" /> Executing...</> : <><i className="fas fa-bolt" style={{ marginRight: '4px' }} /> Confirm</>}
                </button>
                <button
                  onClick={() => { if (!isExecutingBasket) setIsCheckoutSheetOpen(false); }}
                  disabled={isExecutingBasket}
                  style={{ flex: 1, background: 'var(--bg-body, #F3F4F6)', color: isExecutingBasket ? '#9CA3AF' : 'var(--text-secondary)', border: '1px solid var(--border-light, #EEF2F8)', padding: '15px 0', borderRadius: '14px', fontSize: '0.9rem', fontWeight: '700', cursor: isExecutingBasket ? 'not-allowed' : 'pointer' }}
                >
                  Cancel
                </button>
              </div>

            </div>

            <div id="drawerOverlay" className={`drawer-overlay${isFolderDrawerOpen ? ' active' : ''}`} onClick={() => setIsFolderDrawerOpen(false)}></div>
            <div id="scriptsFolderDrawer" className={`folder-drawer${isFolderDrawerOpen ? ' open' : ''}`}>
              <div className="drawer-header">
                <h3>Trading Segments</h3>
                <button className="close-drawer" onClick={() => setIsFolderDrawerOpen(false)} suppressHydrationWarning><i className="fas fa-times"></i></button>
              </div>
              <div className="folder-tree-scroll">
                {(() => {
                  const DRAWER_SEG_TO_DB_KEY: Record<string, string> = {
                    'INDEX-FUT': 'INDEX-FUT',
                    'INDEX-OPT': 'INDEX-OPT',
                    'MCX-FUT': 'MCX-FUT',
                    'MCX-OPT': 'MCX-OPT',
                    'STOCK-FUT': 'STOCK-FUT',
                    'STOCK-OPT': 'STOCK-OPT',
                    'NSE-EQ': 'STOCKS',
                    'Equity': 'STOCKS',
                    'EQUITY': 'STOCKS',
                    'Stocks': 'STOCKS',
                    'STOCKS': 'STOCKS',
                    'CRYPTO': 'CRYPTO',
                    'COMEX': 'COMEX',
                    'FOREX': 'FOREX',
                    'US-EQ': 'US-EQ',
                    'US Equity': 'US-EQ',
                  };
                  // Define the desired display order
                  const SEGMENT_ORDER = ['INDEX-FUT', 'INDEX-OPT', 'MCX-FUT', 'MCX-OPT', 'STOCK-FUT', 'STOCK-OPT', 'STOCKS', 'CRYPTO', 'COMEX', 'FOREX', 'US-EQ', 'US Equity'];
                  const sortedSegments = [...tradingSegments].sort((a, b) => {
                    const ai = SEGMENT_ORDER.indexOf(a.name);
                    const bi = SEGMENT_ORDER.indexOf(b.name);
                    if (ai === -1 && bi === -1) return 0;
                    if (ai === -1) return 1;
                    if (bi === -1) return -1;
                    return ai - bi;
                  });
                  const visibleSegments = sortedSegments.filter(seg => {
                    if (allowedSegments === null) return true; // still loading — show all initially
                    if (allowedSegments.length === 0) return true;
                    const dbKey = DRAWER_SEG_TO_DB_KEY[seg.name] ?? seg.name.toUpperCase();
                    return (
                      allowedSegments.includes(dbKey) ||
                      allowedSegments.includes(seg.name) ||
                      ((seg.name.toUpperCase() === 'EQUITY' || seg.name.toUpperCase() === 'STOCKS') && (allowedSegments.includes('NSE-EQ') || allowedSegments.includes('Equity') || allowedSegments.includes('Stocks'))) ||
                      (dbKey === 'US-EQ' && (allowedSegments.includes('US-EQ') || allowedSegments.includes('US Equity') || allowedSegments.includes('NSE-EQ') || allowedSegments.includes('Equity') || allowedSegments.length >= 7))
                    );
                  });
                  return visibleSegments.map((seg) => {
                    // Filter out blocked symbols from this segment's instruments
                    const filterBlocked = (instruments: any[]) =>
                      blockedSymbols.size === 0
                        ? instruments
                        : instruments.filter(i => !blockedSymbols.has((i.symbol || '').toUpperCase()));

                    const filteredSeg = {
                      ...seg,
                      instruments: seg.instruments ? filterBlocked(seg.instruments) : undefined,
                      subCategories: seg.subCategories
                        ? seg.subCategories.map((sub: any) => ({
                          ...sub,
                          instruments: filterBlocked(sub.instruments || []),
                        })).filter((sub: any) => sub.instruments.length > 0)
                        : undefined,
                    };

                    const count = (filteredSeg.instruments?.length ?? 0) + (filteredSeg.subCategories?.reduce((a: number, s: any) => a + s.instruments.length, 0) ?? 0);
                    if (count === 0) return null; // hide segment if all instruments are blocked
                    const isOpen = !!expandedSegments[seg.name];
                    return (
                      <div key={seg.name} className="tree-item-li">
                        <div
                          className="tree-label-row"
                          onClick={() => setExpandedSegments(prev => ({ ...prev, [seg.name]: !prev[seg.name] }))}
                        >
                          <i className="fas fa-chevron-right chevron-icon" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}></i>
                          <span style={{ flex: 1, fontWeight: 700, fontSize: '0.88rem', textTransform: 'uppercase' }}>{seg.name}</span>
                          <span className="segment-count">{count}</span>
                        </div>
                        {isOpen && (
                          <div className="children-container" style={{ display: 'block' }}>
                            {filteredSeg.instruments?.map((inst) => {
                              const isAdded = addedSymbolsSet.has(inst.symbol);
                              return (
                                <div key={inst.symbol} className="script-item">
                                  <span>{inst.name}</span>
                                  <button
                                    className="add-script-btn"
                                    data-watch-symbol={inst.symbol}
                                    data-watch-item={JSON.stringify(inst)}
                                    style={isAdded ? { background: '#2C8E5A', color: '#fff', border: 'none', opacity: 0.9, cursor: 'pointer' } : undefined}
                                    onClick={() => {
                                      if (isAdded) {
                                        setWatchlistItems(prev => {
                                          const next = prev.filter(i => i.symbol !== inst.symbol);
                                          saveWatchlistToStorage(next, userId);
                                          if (typeof (window as any).__syncWatchlistSymbols === 'function') {
                                            (window as any).__syncWatchlistSymbols(next.map((i: WatchlistItem) => i.symbol));
                                          }
                                          return next;
                                        });
                                        showToast('Removed from watchlist', false);
                                      } else {
                                        if (typeof window.__addToWatchlistCallback === 'function') {
                                          window.__addToWatchlistCallback(inst as WatchlistItem);
                                          showToast('Added to watchlist', false);
                                        }
                                      }
                                    }}
                                  >
                                    {isAdded ? 'Added ✓' : '+ Add'}
                                  </button>
                                </div>
                              );
                            })}
                            {filteredSeg.subCategories?.map((sub) => {
                              const subKey = `${seg.name}__${sub.name}`;
                              const subOpen = !!expandedSegments[subKey];
                              return (
                                <div key={sub.name} className="tree-item-li">
                                  <div
                                    className="tree-label-row"
                                    style={{ paddingTop: '8px', paddingBottom: '8px' }}
                                    onClick={(e) => { e.stopPropagation(); setExpandedSegments(prev => ({ ...prev, [subKey]: !prev[subKey] })); }}
                                  >
                                    <i className="fas fa-chevron-right chevron-icon" style={{ fontSize: '0.55rem', transform: subOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}></i>
                                    <span style={{ flex: 1, fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary, #5B677E)' }}>{sub.name}</span>
                                    <span className="segment-count">{sub.instruments.length}</span>
                                  </div>
                                  {subOpen && (
                                    <div className="children-container" style={{ display: 'block' }}>
                                      {sub.instruments.map((inst: any) => {
                                        const isAdded = addedSymbolsSet.has(inst.symbol);
                                        return (
                                          <div key={inst.symbol} className="script-item">
                                            <span>{inst.name}</span>
                                            <button
                                              className="add-script-btn"
                                              data-watch-symbol={inst.symbol}
                                              data-watch-item={JSON.stringify(inst)}
                                              style={isAdded ? { background: '#2C8E5A', color: '#fff', border: 'none', opacity: 0.9, cursor: 'pointer' } : undefined}
                                              onClick={() => {
                                                if (isAdded) {
                                                  setWatchlistItems(prev => {
                                                    const next = prev.filter(i => i.symbol !== inst.symbol);
                                                    saveWatchlistToStorage(next, userId);
                                                    if (typeof (window as any).__syncWatchlistSymbols === 'function') {
                                                      (window as any).__syncWatchlistSymbols(next.map((i: WatchlistItem) => i.symbol));
                                                    }
                                                    return next;
                                                  });
                                                  showToast('Removed from watchlist', false);
                                                } else {
                                                  if (typeof window.__addToWatchlistCallback === 'function') {
                                                    window.__addToWatchlistCallback(inst as WatchlistItem);
                                                    showToast('Added to watchlist', false);
                                                  }
                                                }
                                              }}
                                            >
                                              {isAdded ? 'Added ✓' : '+ Add'}
                                            </button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
              <div className="drawer-footer"><i className="fas fa-plus-circle"></i> Tap <span style={{ color: '#C62E2E' }}>+ Add</span> to watchlist | Browse all segments</div>
            </div>
          </div>

          {/* React-driven order toast */}
          <div
            onClick={() => setToast(t => ({ ...t, visible: false }))}
            style={{
              position: 'fixed',
              bottom: '90px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: '#2C313F',
              border: toast.isError ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid rgba(255, 255, 255, 0.18)',
              color: '#F8FAFC',
              padding: '8px 18px',
              borderRadius: '30px',
              fontSize: '0.75rem',
              fontWeight: '600',
              fontFamily: 'Inter, sans-serif',
              zIndex: 99999,
              whiteSpace: 'nowrap',
              maxWidth: '80vw',
              overflowX: 'hidden',
              textOverflow: 'ellipsis',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              backdropFilter: 'blur(10px)',
              opacity: toast.visible ? 1 : 0,
              visibility: toast.visible ? 'visible' : 'hidden',
              transition: 'opacity 0.2s ease, visibility 0.2s ease',
              cursor: 'pointer',
            }}
          >
            {toast.msg}
          </div>

          <div id="chartSheetOverlay" className={`trade-sheet-overlay${chartItem ? ' active' : ''}`} onClick={() => closeChartSheet()}></div>
          <div id="chartSheet" className={`trade-sheet${chartItem ? ' open' : ''}`} style={{ height: '100dvh', paddingBottom: '0', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, position: 'relative', width: '100%', overflow: 'hidden' }}>
              {chartItem && (() => {
                console.log('[CHART PERF REACTION] Rendering TradingChart for chartItem:', chartItem.symbol, chartItem.segment);
                const symUpper = chartItem.symbol.toUpperCase();
                const isGlobalForex = isForexSymbol(chartItem.symbol) || isForexSymbol(chartItem.comexSymbol || '') || (chartItem.segment?.toUpperCase() === 'FOREX' && !symUpper.includes('INR') && !symUpper.endsWith('FUT') && !symUpper.startsWith('CDS:'));
                const isChartComex = !isGlobalForex && !!chartItem.comexSymbol && (!(chartItem.kiteSymbol) || (chartItem as any).preferredView === 'comex');
                return (
                  <TradingChart
                    symbol={isGlobalForex ? (chartItem.comexSymbol || chartItem.symbol) : isChartComex ? (chartItem.comexSymbol || chartItem.symbol) : (chartItem.binanceSymbol || chartItem.kiteSymbol || chartItem.symbol)}
                    segment={isGlobalForex ? 'FOREX' : isChartComex ? 'COMEX' : (chartItem.binanceSymbol || ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC'].includes(chartItem.symbol) ? 'CRYPTO' : chartItem.segment)}
                    onClose={closeChartSheet}
                  />
                );
              })()}
            </div>
          </div>

          <ErrorModal error={errorModalMsg} onClose={() => setErrorModalMsg(null)} title="Order Failed" />
        </div>
      </main>
    </div>
  );
}


function buildInlineScript(allowedSegments: string[], segmentSettings: any[], blockedSymbols: string[] = []): string {
  return `
    (function() {
      var allowedSegments = ${JSON.stringify(allowedSegments)};
      var segmentSettings = ${JSON.stringify(segmentSettings)};
      var blockedSymbols = new Set(${JSON.stringify(blockedSymbols.map(s => s.toUpperCase()))});
      var tradingSegments = [
        {
          name: 'INDEX-FUT',
          icon: 'fa-chart-line',
          instruments: [
            { name: 'NIFTY 50 INDEX', symbol: 'NIFTY_INDEX', kiteSymbol: 'NSE:NIFTY 50', price: 22456.80, change: '+0.45%', segment: 'NSE - Equity', contractDate: '', open: 22350, high: 22580, low: 22320, close: 22456.80 },
            { name: 'SENSEX INDEX', symbol: 'SENSEX_INDEX', kiteSymbol: 'BSE:SENSEX', price: 74230.15, change: '+0.32%', segment: 'BSE - Equity', contractDate: '', open: 73950, high: 74500, low: 73800, close: 74230.15 },
            { name: 'BANKNIFTY INDEX', symbol: 'BANKNIFTY_INDEX', kiteSymbol: 'NSE:NIFTY BANK', price: 48210.50, change: '-0.21%', segment: 'NSE - Equity', contractDate: '', open: 48350, high: 48500, low: 48100, close: 48210.50 },
            { name: 'FINNIFTY INDEX', symbol: 'FINNIFTY_INDEX', kiteSymbol: 'NSE:NIFTY FIN SERVICE', price: 21234.90, change: '+0.67%', segment: 'NSE - Equity', contractDate: '', open: 21080, high: 21350, low: 21050, close: 21234.90 },
            { name: 'MIDCAP NIFTY INDEX', symbol: 'MIDCP_INDEX', kiteSymbol: 'NSE:NIFTY MID SELECT', price: 11820.45, change: '+0.88%', segment: 'NSE - Equity', contractDate: '', open: 11700, high: 11880, low: 11680, close: 11820.45 }
          ]
        },
        {
          name: 'INDEX-OPT',
          icon: 'fa-chart-gantt',
          subCategories: [
            {
              name: 'NIFTY Options',
              instruments: [
                { name: 'NIFTY 22300 PE', symbol: 'NIFTY22300PE', kiteSymbol: '', price: 65.10, change: '-2.1%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 66, high: 68, low: 64, close: 65.10 },
                { name: 'NIFTY 22400 PE', symbol: 'NIFTY22400PE', kiteSymbol: '', price: 78.20, change: '-1.2%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 79.50, high: 80, low: 77.50, close: 78.20 },
                { name: 'NIFTY 22500 CE', symbol: 'NIFTY22500CE', kiteSymbol: '', price: 125.40, change: '+2.3%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 122, high: 128.50, low: 121, close: 125.40 },
                { name: 'NIFTY 22600 CE', symbol: 'NIFTY22600CE', kiteSymbol: '', price: 85.30, change: '+1.5%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 84, high: 88, low: 82, close: 85.30 },
                { name: 'NIFTY 22700 CE', symbol: 'NIFTY22700CE', kiteSymbol: '', price: 55.20, change: '+3.1%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 53, high: 57, low: 51, close: 55.20 }
              ]
            },
            {
              name: 'SENSEX Options',
              instruments: [
                { name: 'SENSEX 74100 PE', symbol: 'SENSEX741PE', kiteSymbol: '', price: 150.20, change: '-1.5%', segment: 'BSE - Options', contractDate: '26 Jun 2026', open: 152, high: 155, low: 148, close: 150.20 },
                { name: 'SENSEX 74500 CE', symbol: 'SENSEX745CE', kiteSymbol: '', price: 210.30, change: '+0.9%', segment: 'BSE - Options', contractDate: '26 Jun 2026', open: 208, high: 212.50, low: 207.50, close: 210.30 },
                { name: 'SENSEX 74900 CE', symbol: 'SENSEX749CE', kiteSymbol: '', price: 125.10, change: '+2.5%', segment: 'BSE - Options', contractDate: '26 Jun 2026', open: 122, high: 128, low: 120, close: 125.10 }
              ]
            },
            {
              name: 'BANKEX Options',
              instruments: [
                { name: 'BANKEX 51800 PE', symbol: 'BANKEX518PE', kiteSymbol: '', price: 240.50, change: '-1.4%', segment: 'BSE - Options', contractDate: '26 Jun 2026', open: 245, high: 248, low: 238, close: 240.50 },
                { name: 'BANKEX 52000 CE', symbol: 'BANKEX520CE', kiteSymbol: '', price: 310.75, change: '+1.1%', segment: 'BSE - Options', contractDate: '26 Jun 2026', open: 307, high: 314, low: 306.50, close: 310.75 }
              ]
            },
            {
              name: 'BANKNIFTY Options',
              instruments: [
                { name: 'BANKNIFTY 47800 PE', symbol: 'BN47800PE', kiteSymbol: '', price: 110.15, change: '+0.3%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 109, high: 112, low: 108, close: 110.15 },
                { name: 'BANKNIFTY 48000 PE', symbol: 'BN48000PE', kiteSymbol: '', price: 140.25, change: '+0.7%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 139, high: 142, low: 138.50, close: 140.25 },
                { name: 'BANKNIFTY 48200 CE', symbol: 'BN48200CE', kiteSymbol: '', price: 280.40, change: '-1.1%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 282, high: 285, low: 279, close: 280.40 },
                { name: 'BANKNIFTY 48500 CE', symbol: 'BN48500CE', kiteSymbol: '', price: 215.60, change: '-0.4%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 216.50, high: 218, low: 214, close: 215.60 },
                { name: 'BANKNIFTY 48800 CE', symbol: 'BN48800CE', kiteSymbol: '', price: 155.80, change: '-0.8%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 157, high: 160, low: 154, close: 155.80 },
                { name: 'BANKNIFTY 49000 CE', symbol: 'BN49000CE', kiteSymbol: '', price: 120.40, change: '-1.5%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 122, high: 125, low: 118, close: 120.40 }
              ]
            },
            {
              name: 'FINNIFTY Options',
              instruments: [
                { name: 'FINNIFTY 21300 PE', symbol: 'FIN21300PE', kiteSymbol: '', price: 45.20, change: '-2.5%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 48, high: 50, low: 44, close: 45.20 },
                { name: 'FINNIFTY 21500 CE', symbol: 'FIN21500CE', kiteSymbol: '', price: 92.50, change: '+1.5%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 91, high: 94, low: 90.50, close: 92.50 },
                { name: 'FINNIFTY 21700 CE', symbol: 'FIN21700CE', kiteSymbol: '', price: 32.10, change: '+4.5%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 30, high: 34, low: 28, close: 32.10 }
              ]
            },
            {
              name: 'MID CAP NIFTY Options',
              instruments: [
                { name: 'MIDCPNIFTY 11800 CE', symbol: 'MIDCP118CE', kiteSymbol: '', price: 65.30, change: '+2.1%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 63.80, high: 66.50, low: 63.50, close: 65.30 },
                { name: 'MIDCPNIFTY 12000 CE', symbol: 'MIDCP120CE', kiteSymbol: '', price: 25.50, change: '+6.5%', segment: 'NSE - Options', contractDate: '26 Jun 2026', open: 22, high: 28, low: 20, close: 25.50 }
              ]
            }
          ]
        },
        {
          name: 'STOCK-FUT',
          icon: 'fa-building',
          instruments: [
            { name: 'RELIANCE FUT', symbol: 'RELIANCE_FUT', kiteSymbol: 'NSE:RELIANCE', price: 2856.40, change: '+0.75%', segment: 'NSE - Futures', contractDate: '26 Jun 2026', open: 2835, high: 2870, low: 2830, close: 2856.40 },
            { name: 'TCS FUT', symbol: 'TCS_FUT', kiteSymbol: 'NSE:TCS', price: 3987.20, change: '-0.33%', segment: 'NSE - Futures', contractDate: '26 Jun 2026', open: 4000, high: 4015, low: 3975, close: 3987.20 },
            { name: 'HDFCBANK FUT', symbol: 'HDFCBANK_FUT', kiteSymbol: 'NSE:HDFCBANK', price: 1680.90, change: '+0.22%', segment: 'NSE - Futures', contractDate: '26 Jun 2026', open: 1675, high: 1688, low: 1672, close: 1680.90 }
          ]
        },
        {
          name: 'MCX-FUT',
          icon: 'fa-coins',
          instruments: [
            { name: 'GOLD FUT', symbol: 'GOLD_FUT', kiteSymbol: 'MCX:GOLD26OCTFUT', price: 72450, change: '+0.28%', segment: 'MCX - Futures', contractDate: 'Oct 2026', open: 72150, high: 72450, low: 72100, close: 72450 },
            { name: 'SILVER FUT', symbol: 'SILVER_FUT', kiteSymbol: 'MCX:SILVER26SEPFUT', price: 0, change: '0%', segment: 'MCX - Futures', contractDate: 'Sep 2026', open: 0, high: 0, low: 0, close: 0 },
            { name: 'CRUDEOIL FUT', symbol: 'CRUDEOIL_FUT', kiteSymbol: 'MCX:CRUDEOIL26JULFUT', price: 6120.50, change: '+1.2%', segment: 'MCX - Futures', contractDate: 'Jul 2026', open: 6045, high: 6140, low: 6040, close: 6120.50 }
          ]
        },
        {
          name: 'MCX-OPT',
          icon: 'fa-chart-line',
          subCategories: [
            {
              name: 'GOLD',
              instruments: [
                { name: 'GOLD 72000 CE', symbol: 'GOLD26JUL72000CE', kiteSymbol: 'MCX:GOLD26JUL72000CE', price: 820, change: '+0.9%', segment: 'MCX - Options', contractDate: '2026-07-31', open: 812, high: 828, low: 810, close: 820 }
              ]
            },
            {
              name: 'CRUDEOIL',
              instruments: [
                { name: 'CRUDEOIL 6000 CE', symbol: 'CRUDEOIL26JUL6000CE', kiteSymbol: 'MCX:CRUDEOIL26JUL6000CE', price: 145, change: '+1.5%', segment: 'MCX - Options', contractDate: '2026-07-31', open: 140, high: 152, low: 138, close: 145 }
              ]
            }
          ]
        },
        {
          name: 'CRYPTO',
          icon: 'fa-bitcoin',
          instruments: [
            { name: 'BTC/USDT', symbol: 'BTCUSDT', kiteSymbol: '', binanceSymbol: 'BTCUSDT', price: 68450.20, change: '+2.1%', segment: 'CRYPTO', contractDate: 'Perpetual', open: 67000, high: 69000, low: 66800, close: 68450.20 },
            { name: 'ETH/USDT', symbol: 'ETHUSDT', kiteSymbol: '', binanceSymbol: 'ETHUSDT', price: 3420.80, change: '+1.4%', segment: 'CRYPTO', contractDate: 'Perpetual', open: 3370, high: 3450, low: 3360, close: 3420.80 },
            { name: 'SOL/USDT', symbol: 'SOLUSDT', kiteSymbol: '', binanceSymbol: 'SOLUSDT', price: 182.30, change: '-0.7%', segment: 'CRYPTO', contractDate: 'Perpetual', open: 183.50, high: 184, low: 181, close: 182.30 }
          ]
        },
        {
          name: 'FOREX',
          icon: 'fa-globe',
          instruments: [
            { name: 'USD/INR', symbol: 'USDINR_FUT', kiteSymbol: 'CDS:USDINR26JULFUT', price: 95.96, change: '0%', segment: 'CDS - Futures', contractDate: 'Jul 2026', open: 95.72, high: 96.03, low: 95.59, close: 95.61 },
            { name: 'EUR/INR', symbol: 'EURINR_FUT', kiteSymbol: 'CDS:EURINR26JULFUT', price: 0, change: '0%', segment: 'CDS - Futures', contractDate: 'Jul 2026', open: 0, high: 0, low: 0, close: 0 }
          ]
        },
        {
          name: 'COMEX',
          icon: 'fa-gem',
          instruments: [
            { name: 'GOLD', comexName: 'Gold', symbol: 'GOLD_FUT', kiteSymbol: 'MCX:GOLD26OCTFUT', comexSymbol: 'GC=F', price: 72450, change: '+0.28%', segment: 'MCX - Futures', contractDate: 'Oct 2026', open: 72150, high: 72450, low: 72100, close: 72450 },
            { name: 'SILVER', comexName: 'Silver', symbol: 'SILVER_FUT', kiteSymbol: 'MCX:SILVER26SEPFUT', comexSymbol: 'SI=F', price: 0, change: '0%', segment: 'MCX - Futures', contractDate: 'Sep 2026', open: 0, high: 0, low: 0, close: 0 },
            { name: 'CRUDEOIL', comexName: 'Crude Oil', symbol: 'CRUDEOIL_FUT', kiteSymbol: 'MCX:CRUDEOIL26JULFUT', comexSymbol: 'CL=F', price: 6120, change: '0%', segment: 'MCX - Futures', contractDate: 'Jul 2026', open: 0, high: 0, low: 0, close: 0 },
            { name: 'COPPER', comexName: 'Copper', symbol: 'COPPER_FUT', kiteSymbol: 'MCX:COPPER26JULFUT', comexSymbol: 'HG=F', price: 780, change: '0%', segment: 'MCX - Futures', contractDate: 'Jul 2026', open: 0, high: 0, low: 0, close: 0 }
          ]
        },
        {
          name: 'STOCK-OPT',
          icon: 'fa-layer-group',
          subCategories: [
            {
              name: 'RELIANCE',
              instruments: [
                { name: 'RELIANCE 2900 CE', symbol: 'RELIANCE26JUN2900CE', kiteSymbol: 'NFO:RELIANCE26JUN2900CE', price: 0, change: '0%', segment: 'NSE - Stock Options', contractDate: '2026-06-30', open: 0, high: 0, low: 0, close: 0 },
                { name: 'RELIANCE 2800 PE', symbol: 'RELIANCE26JUN2800PE', kiteSymbol: 'NFO:RELIANCE26JUN2800PE', price: 0, change: '0%', segment: 'NSE - Stock Options', contractDate: '2026-06-30', open: 0, high: 0, low: 0, close: 0 }
              ]
            },
            {
              name: 'TCS',
              instruments: [
                { name: 'TCS 4000 CE', symbol: 'TCS26JUN4000CE', kiteSymbol: 'NFO:TCS26JUN4000CE', price: 0, change: '0%', segment: 'NSE - Stock Options', contractDate: '2026-06-30', open: 0, high: 0, low: 0, close: 0 }
              ]
            },
            {
              name: 'HDFCBANK',
              instruments: [
                { name: 'HDFCBANK 1700 CE', symbol: 'HDFCBANK26JUN1700CE', kiteSymbol: 'NFO:HDFCBANK26JUN1700CE', price: 0, change: '0%', segment: 'NSE - Stock Options', contractDate: '2026-06-30', open: 0, high: 0, low: 0, close: 0 },
                { name: 'HDFCBANK 1600 PE', symbol: 'HDFCBANK26JUN1600PE', kiteSymbol: 'NFO:HDFCBANK26JUN1600PE', price: 0, change: '0%', segment: 'NSE - Stock Options', contractDate: '2026-06-30', open: 0, high: 0, low: 0, close: 0 }
              ]
            }
          ]
        },
        {
          name: 'STOCKS',
          icon: 'fa-landmark',
          instruments: [
            { name: 'RELIANCE', symbol: 'RELIANCE_EQ', kiteSymbol: 'NSE:RELIANCE', price: 0, change: '0%', segment: 'NSE - Equity', contractDate: '', open: 0, high: 0, low: 0, close: 0 },
            { name: 'TCS', symbol: 'TCS_EQ', kiteSymbol: 'NSE:TCS', price: 0, change: '0%', segment: 'NSE - Equity', contractDate: '', open: 0, high: 0, low: 0, close: 0 },
            { name: 'HDFCBANK', symbol: 'HDFCBANK_EQ', kiteSymbol: 'NSE:HDFCBANK', price: 0, change: '0%', segment: 'NSE - Equity', contractDate: '', open: 0, high: 0, low: 0, close: 0 },
            { name: 'INFY', symbol: 'INFY_EQ', kiteSymbol: 'NSE:INFY', price: 0, change: '0%', segment: 'NSE - Equity', contractDate: '', open: 0, high: 0, low: 0, close: 0 }
          ]
        }
      ];

      function mapCategoryToDbSegment(name) {
        var n = name.toUpperCase();
        if (n === 'INDEX-FUT') return 'INDEX-FUT';
        if (n === 'INDEX-OPT') return 'INDEX-OPT';
        if (n === 'STOCK-FUT') return 'STOCK-FUT';
        if (n === 'STOCK-OPT') return 'STOCK-OPT';
        if (n === 'MCX-FUT') return 'MCX-FUT';
        if (n === 'MCX-OPT') return 'MCX-OPT';
        if (n === 'NSE-EQ' || n === 'EQUITY' || n === 'STOCKS') return 'STOCKS';
        if (n === 'CRYPTO') return 'CRYPTO';
        if (n === 'FOREX') return 'FOREX';
        if (n === 'COMEX') return 'COMEX';
        return name;
      }
      if (allowedSegments && allowedSegments.length > 0) {
        tradingSegments = tradingSegments.filter(function(seg) {
          return allowedSegments.indexOf(mapCategoryToDbSegment(seg.name)) !== -1;
        });
      }
      
      window.__initialTradingSegments = tradingSegments;

      function getAllScripts() {
        var scripts = [];
        function traverse(node) {
          if (node.instruments) node.instruments.forEach(function(inst) { scripts.push(Object.assign({}, inst, { category: node.name })); });
          if (node.subCategories) node.subCategories.forEach(function(sub) {
            if (sub.instruments) sub.instruments.forEach(function(inst) { scripts.push(Object.assign({}, inst, { category: node.name + ' > ' + sub.name })); });
          });
        }
        tradingSegments.forEach(function(seg) { traverse(seg); });
        return scripts;
      }

      var allScriptsDB = getAllScripts().filter(function(s) {
        return !blockedSymbols.has((s.symbol || '').toUpperCase());
      });
      var watchlistItems = (window.__watchlistItems && window.__watchlistItems.length > 0) ? window.__watchlistItems.slice() : [];
      var selectionMode = false;
      var longPressTimer = null;

      var watchlistContainer = document.getElementById('watchlistMobileContainer');
      var watchlistCounter = document.getElementById('mobileWatchlistCounter');
      var multiSelectBar = document.getElementById('multiSelectBar');
      var selectedCountSpan = document.getElementById('selectedCount');
      var searchInput = document.getElementById('globalSearchInput');
      var clearSearchBtn = document.getElementById('clearSearchBtn');
      var searchResultsArea = document.getElementById('searchResultsArea');
      var searchResultsList = document.getElementById('searchResultsList');
      var searchResultCount = document.getElementById('searchResultCount');
      var folderDrawer = document.getElementById('scriptsFolderDrawer');
      var overlay = document.getElementById('drawerOverlay');

      function formatPrice(price, isCrypto) {
        var numPrice = typeof price === 'number' ? price : parseFloat(price);
        var sym = '₹';
        var loc = 'en-IN';
        return sym + numPrice.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function(m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]; });
      }

      // Symbols currently in the watchlist — kept in sync so buttons can
      // reflect "Added" state without waiting for a React re-render.
      var watchlistSymbols = new Set(
        (window.__watchlistItems || []).map(function(i) { return i.symbol; })
      );

      // Called by React after the watchlist state updates so the inline
      // script always has the latest set.
      window.__syncWatchlistSymbols = function(symbols) {
        watchlistSymbols = new Set(symbols);
        document.querySelectorAll('.add-script-btn[data-watch-symbol]').forEach(function(btn) {
          var sym = btn.getAttribute('data-watch-symbol');
          if (sym) {
            if (watchlistSymbols.has(sym)) {
              setButtonAdded(btn);
            } else {
              setButtonRemoved(btn);
            }
          }
        });
      };

      function setButtonAdded(btn) {
        btn.textContent = 'Added ✓';
        btn.disabled = false;
        btn.style.background = '#2C8E5A';
        btn.style.color = '#fff';
        btn.style.opacity = '0.85';
        btn.style.cursor = 'pointer';
        
        var symbol = btn.getAttribute('data-watch-symbol');
        if (symbol) {
          btn.setAttribute('onclick', 'removeFromWatchlist("' + symbol.replace(/"/g, '&quot;') + '")');
        }
      }

      function setButtonRemoved(btn) {
        var isSearch = btn.classList.contains('sri-add-btn');
        btn.textContent = isSearch ? 'Add' : '+ Add';
        btn.disabled = false;
        
        if (isSearch) {
          btn.style.background = '#c53030';
          btn.style.color = 'white';
          btn.style.border = 'none';
          btn.style.borderRadius = '20px';
          btn.style.padding = '6px 16px';
          btn.style.fontWeight = '600';
          btn.style.fontSize = '0.85rem';
          btn.style.opacity = '1';
        } else {
          btn.style.cssText = '';
        }
        btn.style.cursor = 'pointer';
        
        var itemJsonEscaped = btn.getAttribute('data-watch-item');
        if (itemJsonEscaped) {
           btn.setAttribute('onclick', 'addToWatchlist(' + itemJsonEscaped + ')');
        }
      }

      function addToWatchlist(item) {
        if (typeof window.__addToWatchlistCallback === 'function') {
          window.__addToWatchlistCallback(item);
          watchlistSymbols.add(item.symbol);
          // Update every button on screen for this symbol
          var btns = document.querySelectorAll('[data-watch-symbol="' + item.symbol.replace(/"/g, '') + '"]');
          btns.forEach(function(btn) { setButtonAdded(btn); });
          if (window.showToast) window.showToast('Added to watchlist', false);
        }
      }

      function removeFromWatchlist(symbol) {
        if (typeof window.__removeFromWatchlistCallback === 'function') {
          window.__removeFromWatchlistCallback(symbol);
          watchlistSymbols.delete(symbol);
          var btns = document.querySelectorAll('[data-watch-symbol="' + symbol.replace(/"/g, '') + '"]');
          btns.forEach(function(btn) { setButtonRemoved(btn); });
          if (window.showToast) window.showToast('Removed from watchlist', false);
        }
      }

      function openDetailSheet(symbol) {
        if (typeof window.__reactOpenDetailSheet === 'function') {
          window.__reactOpenDetailSheet(symbol);
        }
      }

      function openTradeSheet(symbol) {
        if (typeof window.__reactOpenTradeSheet === 'function') {
          window.__reactOpenTradeSheet(symbol);
        }
      }

      function renderFolderTree() {
        var folderTreeMobile = document.getElementById('folderTreeMobile');
        if (!folderTreeMobile) return;
        var html = '';
        tradingSegments.forEach(function(seg) {
          html += '<div class="folder-item">';
          html += '<div class="folder-header">' + escapeHtml(seg.name) + '</div>';
          if (seg.instruments) {
            seg.instruments.filter(function(inst) {
              return !blockedSymbols.has((inst.symbol || '').toUpperCase());
            }).forEach(function(inst) {
              var alreadyAdded = watchlistSymbols.has(inst.symbol);
              var itemJsonEscaped = JSON.stringify(inst).replace(/"/g, '&quot;');
              var btnHtml = alreadyAdded
                ? '<button class="add-script-btn" data-watch-symbol="' + escapeHtml(inst.symbol) + '" data-watch-item="' + itemJsonEscaped + '" onclick=\\'removeFromWatchlist("' + escapeHtml(inst.symbol) + '")\\' style="background:#2C8E5A;color:#fff;opacity:0.85;cursor:pointer;">Added ✓</button>'
                : '<button class="add-script-btn" data-watch-symbol="' + escapeHtml(inst.symbol) + '" data-watch-item="' + itemJsonEscaped + '" onclick=\\'addToWatchlist(' + itemJsonEscaped + ')\\'>+ Add</button>';
              html += '<div class="script-item"><span>' + escapeHtml(inst.name) + '</span>' + btnHtml + '</div>';
            });
          }
          if (seg.subCategories) {
            seg.subCategories.forEach(function(sub) {
              html += '<div class="subfolder-item"><div class="subfolder-header">' + escapeHtml(sub.name) + '</div>';
              sub.instruments.filter(function(inst) {
                return !blockedSymbols.has((inst.symbol || '').toUpperCase());
              }).forEach(function(inst) {
                var alreadyAdded = watchlistSymbols.has(inst.symbol);
                var itemJsonEscaped = JSON.stringify(inst).replace(/"/g, '&quot;');
                var btnHtml = alreadyAdded
                  ? '<button class="add-script-btn" data-watch-symbol="' + escapeHtml(inst.symbol) + '" data-watch-item="' + itemJsonEscaped + '" onclick=\\'removeFromWatchlist("' + escapeHtml(inst.symbol) + '")\\' style="background:#2C8E5A;color:#fff;opacity:0.85;cursor:pointer;">Added ✓</button>'
                  : '<button class="add-script-btn" data-watch-symbol="' + escapeHtml(inst.symbol) + '" data-watch-item="' + itemJsonEscaped + '" onclick=\\'addToWatchlist(' + itemJsonEscaped + ')\\'>+ Add</button>';
                html += '<div class="script-item"><span>' + escapeHtml(inst.name) + '</span>' + btnHtml + '</div>';
              });
              html += '</div>';
            });
          }
          html += '</div>';
        });
        folderTreeMobile.innerHTML = html;
      }

      var searchDebounceTimer = null;
      var currentSearchController = null; // AbortController for in-flight fetch

      function getTabForSearchItem(seg, cat) {
        if (cat) {
          var c = cat.toUpperCase();
          if (c.indexOf('INDEX-FUT') >= 0 || c.indexOf('INDEX - FUTURE') >= 0) return 'INDEX-FUT';
          if (c.indexOf('INDEX-OPT') >= 0 || c.indexOf('INDEX - OPTIONS') >= 0) return 'INDEX-OPT';
          if (c.indexOf('STOCK-FUT') >= 0 || c.indexOf('STOCKS - FUTURE') >= 0) return 'STOCK-FUT';
          if (c.indexOf('STOCK-OPT') >= 0 || c.indexOf('STOCKS - OPTIONS') >= 0) return 'STOCK-OPT';
          if (c.indexOf('MCX-FUT') >= 0 || c.indexOf('MCX - FUTURE') >= 0) return 'MCX-FUT';
          if (c.indexOf('MCX-OPT') >= 0 || c.indexOf('MCX - OPTIONS') >= 0) return 'MCX-OPT';
          if (c.indexOf('NSE-EQ') >= 0 || c.indexOf('EQUITY') >= 0 || c.indexOf('STOCKS') >= 0) return 'STOCKS';
          if (c.indexOf('CRYPTO') >= 0) return 'CRYPTO';
          if (c.indexOf('FOREX') >= 0) return 'FOREX';
          if (c.indexOf('COMEX') >= 0 || c === 'COI') return 'COMEX';
        }
        if (!seg) return 'INDEX-FUT';
        var m = {
          'NSE - Futures': 'INDEX-FUT', 'BSE - Futures': 'INDEX-FUT',
          'NSE - Options': 'INDEX-OPT', 'BSE - Options': 'INDEX-OPT',
          'NSE - Stock Futures': 'STOCK-FUT', 'BSE - Stock Futures': 'STOCK-FUT',
          'NSE - Stock Options': 'STOCK-OPT', 'BSE - Stock Options': 'STOCK-OPT',
          'MCX - Futures': 'MCX-FUT', 'MCX - Options': 'MCX-OPT',
          'NSE - Equity': 'STOCKS', 'BSE - Equity': 'STOCKS', 'NSE-EQ': 'STOCKS', 'STOCKS': 'STOCKS',
          'Crypto': 'CRYPTO', 'CRYPTO': 'CRYPTO',
          'Forex': 'FOREX', 'FOREX': 'FOREX',
          'CDS - Futures': 'FOREX', 'CDS - Options': 'FOREX',
          'COMEX - Futures': 'COMEX', 'COMEX - Options': 'COMEX', 'COMEX': 'COMEX', 'COI': 'COMEX'
        };
        return m[seg] || 'INDEX-FUT';
      }

      function renderSearchResults(results) {
        var searchResultsArea = document.getElementById('searchResultsArea');
        var searchResultsList = document.getElementById('searchResultsList');
        var searchResultCount = document.getElementById('searchResultCount');
        if (!searchResultsArea || !searchResultsList) return;
        var html = '';
        results.slice(0, 40).forEach(function(item) {
          var kiteId = item.kiteSymbol || item.symbol || '';
          
          var mainName = item.name;
          
          var segMap = {
            'NSE - Options': 'NFO',
            'NSE - Futures': 'NFO',
            'MCX - Futures': 'MCX',
            'BSE - Options': 'BFO',
            'Crypto': 'CRYPTO',
            'CDS - Futures': 'CDS'
          };
          var badgeStr = segMap[item.segment] || 'NSE';
          var dateStr = (item.contractDate || '').replace(/ 20\d\d$/, '');
          var bottomHtml = dateStr ? escapeHtml(dateStr) + '<span style="background: #f1f5f9; color: #64748b; font-size: 0.65rem; padding: 3px 6px; border-radius: 4px; font-weight: 700; margin-left: 8px;">' + escapeHtml(badgeStr) + '</span>' : escapeHtml(badgeStr);

            var defaultPrice = item.price ? item.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '---';
            var alreadyInWL = watchlistSymbols.has(item.symbol);
            var itemJsonEscaped = JSON.stringify(item).replace(/"/g, '&quot;');
            var addBtnHtml = alreadyInWL
              ? '<button class="add-script-btn sri-add-btn" data-watch-symbol="' + escapeHtml(item.symbol) + '" data-watch-item="' + itemJsonEscaped + '" onclick=\\'removeFromWatchlist("' + escapeHtml(item.symbol) + '")\\' style="background: #2C8E5A; color: white; border: none; border-radius: 20px; padding: 6px 16px; font-weight: 600; font-size: 0.85rem; opacity: 0.85; cursor: pointer;">Added ✓</button>'
              : '<button class="add-script-btn sri-add-btn" data-watch-symbol="' + escapeHtml(item.symbol) + '" data-watch-item="' + itemJsonEscaped + '" style="background: #c53030; color: white; border: none; border-radius: 20px; padding: 6px 16px; font-weight: 600; font-size: 0.85rem; cursor: pointer;" onclick=\\'addToWatchlist(' + itemJsonEscaped + ')\\'>Add</button>';
            html += '<div class="search-result-item" style="padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;">' +
            '<div class="sri-left"><div class="sri-name" style="font-weight: 700; font-size: 0.95rem; color: #1e293b; margin-bottom: 4px;">' + escapeHtml(mainName) + '</div><div class="sri-symbol" style="color: #94a3b8; font-size: 0.75rem; font-weight: 500; display: flex; align-items: center;">' + bottomHtml + '</div></div>' +
            '<div class="sri-right" style="display: flex; align-items: center; gap: 12px;">' +
            '<div class="sri-price" data-kite-id="' + escapeHtml(kiteId) + '" style="font-weight: 700; font-size: 0.95rem; color: #1e293b; min-width: 60px; text-align: right;">' + escapeHtml(defaultPrice) + '</div>' +
            addBtnHtml +
            '</div></div>';
        });
        if (searchResultCount) searchResultCount.textContent = results.length + ' RESULTS';
        searchResultsList.innerHTML = html || '<div class="no-results">No results found in library</div>';
        searchResultsArea.style.display = 'flex';

        // Clear any existing price-refresh interval
        if (window.__searchPriceInterval) { clearInterval(window.__searchPriceInterval); window.__searchPriceInterval = null; }

        var activeResults = results.slice(0, 40);

        function refreshSearchPrices() {
          if (!searchResultsList || !document.contains(searchResultsList)) return;

          // 1. Try window.__kiteQuotes for non-crypto, window.__binanceQuotes for crypto
          var stillMissing = [];
          activeResults.forEach(function(item) {
            var kiteId = item.kiteSymbol || item.symbol || '';
            var isCrypto = (item.segment || '').toUpperCase().includes('CRYPTO') || kiteId.startsWith('CRYPTO:');
            var lp = 0;

            if (isCrypto) {
              var binanceSym = item.symbol ? item.symbol.toUpperCase().replace(/USDT$/, '') + 'USDT' : '';
              var bq = (window.__binanceQuotes || window.__kiteQuotes || {})[binanceSym];
              lp = bq && (bq.last_price || bq.lastPrice || 0);
            } else {
              var kq = (window.__kiteQuotes || {})[kiteId];
              lp = kq && (kq.last_price || kq.lastPrice || 0);
            }

            if (lp) {
              var el = searchResultsList.querySelector('[data-kite-id="' + kiteId + '"]');
              if (el) el.textContent = lp.toLocaleString('en-IN', { maximumFractionDigits: 2 });
            } else if (!isCrypto && kiteId.includes(':')) {
              stillMissing.push(kiteId);
            }
          });

          // 2. For any still missing — fetch from Kite REST via our API
          if (stillMissing.length > 0) {
            (window.__apiPostKiteQuotes ? window.__apiPostKiteQuotes(stillMissing) : Promise.resolve({ data: {} }))
              .then(function(json) {
                var quoteData = (json && json.data) || {};
                Object.entries(quoteData).forEach(function(entry) {
                  var kId = entry[0];
                  var quote = entry[1];
                  var lp = quote && quote.last_price;
                  if (!lp) return;
                  var el = searchResultsList && searchResultsList.querySelector('[data-kite-id="' + kId + '"]');
                  if (el) el.textContent = lp.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                });
              })
              .catch(function() {});
          }
        }

        // Run immediately, then every 2 seconds while the panel is open
        refreshSearchPrices();
        window.__searchPriceInterval = setInterval(refreshSearchPrices, 2000);
      }

      function runSearch(query) {
        // Empty query — hide results immediately (no debounce needed)
        if (query.length === 0) {
          if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
          if (currentSearchController) { try { currentSearchController.abort(); } catch(e) {} }
          if (window.__searchPriceInterval) { clearInterval(window.__searchPriceInterval); window.__searchPriceInterval = null; }
          var area = document.getElementById('searchResultsArea');
          if (area) area.style.display = 'none';
          var btn = document.getElementById('clearSearchBtn');
          if (btn) btn.style.display = 'none';
          return;
        }

        var btn = document.getElementById('clearSearchBtn');
        if (btn) btn.style.display = 'block';

        // Cancel any previous in-flight request
        if (currentSearchController) {
          try { currentSearchController.abort(); } catch(e) {}
        }

        // Debounce both local and live results — filter on full word, not per character
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(function() {
          var activeTab = window.__activeTab || 'All';
          var q = query.toLowerCase();

          // Word-start matching: query must match the start of any word in name/symbol
          // e.g. "nif" matches "NIFTY 50" and "NIFTY22300PE" but NOT "FINNIFTY" or "BANKNIFTY"
          function wordStartMatch(text) {
            var t = text.toLowerCase();
            // Check if text itself starts with query
            if (t.indexOf(q) === 0) return true;
            // Check if any word (split by space, hyphen, underscore, digit boundary) starts with query
            var words = t.split(/[\s_\/\-]/);
            for (var i = 0; i < words.length; i++) {
              if (words[i].indexOf(q) === 0) return true;
            }
            return false;
          }

          // Local results filtered with word-start match
          var localResults = allScriptsDB.filter(function(s) {
            var match = wordStartMatch(s.name) || wordStartMatch(s.symbol);
            if (!match) return false;
            if (activeTab === 'All') return true;
            return getTabForSearchItem(s.segment, s.category) === activeTab;
          });
          renderSearchResults(localResults);

          currentSearchController = new AbortController();
          var signal = currentSearchController.signal;
          var timestamp = new Date().getTime();

          (window.__apiSearchInstruments
            ? window.__apiSearchInstruments('/api/market/instruments/search?q=' + encodeURIComponent(query) + '&tab=' + encodeURIComponent(activeTab) + '&_t=' + timestamp, signal)
            : Promise.resolve([])
          )
            .then(function(liveResults) {
              if (!liveResults || !Array.isArray(liveResults)) return;
              // Check query is still current (guard against tab changes mid-flight)
              var currentInput = document.getElementById('globalSearchInput');
              if (!currentInput || currentInput.value.trim() !== query.trim()) return;
              // Apply word-start filter to live results too
              var filteredLive = liveResults.filter(function(r) {
                return wordStartMatch(r.name || '') || wordStartMatch(r.symbol || '');
              });
              // Live results first, then any local-only extras not in live set
              var liveSymbols = new Set(filteredLive.map(function(r) { return r.symbol; }));
              var hardcodedExtra = localResults.filter(function(s) { return !liveSymbols.has(s.symbol); });
              var merged = filteredLive.concat(hardcodedExtra);
              var activeTabLive = window.__activeTab || 'All';
              if (activeTabLive !== 'All') {
                merged = merged.filter(function(r) { return getTabForSearchItem(r.segment, r.category) === activeTabLive; });
              }
              renderSearchResults(merged);
            })
            .catch(function(err) {
              // AbortError is expected when a new search supersedes this one — ignore silently
              if (err && err.name === 'AbortError') return;
            });
        }, 300);
      }

      // Safely disconnect any previously attached input listener before re-binding
      if (window.__watchlistInputHandler) {
        document.removeEventListener('input', window.__watchlistInputHandler);
      }
      function handleSearchInput(e) {
        if (e.target && e.target.id === 'globalSearchInput') {
          runSearch(e.target.value.trim());
        }
      }
      window.__watchlistInputHandler = handleSearchInput;
      document.addEventListener('input', handleSearchInput);

      // Expose so React's searchText useEffect can trigger it directly
      window.__triggerSearch = function(query) {
        runSearch(query);
      };


      var openFolderBtn = document.getElementById('openFolderMobileBtn');
      if (openFolderBtn) {
        openFolderBtn.onclick = function() {
          folderDrawer.classList.add('open');
          overlay.classList.add('active');
          renderFolderTree();
        };
      }

      var closeFolderBtn = document.getElementById('closeFolderDrawerBtn');
      if (closeFolderBtn) {
        closeFolderBtn.onclick = function() {
          folderDrawer.classList.remove('open');
          overlay.classList.remove('active');
        };
      }

      if (overlay) {
        overlay.onclick = function() {
          folderDrawer.classList.remove('open');
          overlay.classList.remove('active');
        };
      }

      window.__reactSelectAll = function() {
        var allCheckboxes = document.querySelectorAll('.wc-checkbox');
        if (allCheckboxes.length === 0) return;
        
        var allChecked = true;
        allCheckboxes.forEach(function(cb) {
          if (!cb.checked) allChecked = false;
        });
        
        allCheckboxes.forEach(function(cb) {
          cb.checked = !allChecked;
        });
        
        if (typeof window.__updateSelectionUI === 'function') window.__updateSelectionUI();
      };

      window.__reactDeleteSelected = function() {
        var checkedBoxes = document.querySelectorAll('.wc-checkbox:checked');
        if (checkedBoxes.length === 0) {
          if (window.showToast) window.showToast('Select items to delete', true);
          return;
        }
        
        var symbolsToDelete = [];
        checkedBoxes.forEach(function(cb) {
          var card = cb.closest('.watchlist-card');
          if (card) {
            var symbol = card.getAttribute('data-symbol');
            if (symbol) symbolsToDelete.push(symbol);
          }
        });

        if (symbolsToDelete.length > 0) {
          symbolsToDelete.forEach(function(sym) {
            if (typeof window.__removeFromWatchlistCallback === 'function') {
              window.__removeFromWatchlistCallback(sym);
            }
          });
          if (window.showToast) window.showToast('Deleted ' + symbolsToDelete.length + ' item' + (symbolsToDelete.length !== 1 ? 's' : '') + ' from watchlist', false);
        }
        
        exitSelectionMode();
      };

      // Safely disconnect existing click and change handlers on document before re-binding
      if (window.__watchlistClickHandler) {
        document.removeEventListener('click', window.__watchlistClickHandler, true);
      }
      if (window.__watchlistChangeHandler) {
        document.removeEventListener('change', window.__watchlistChangeHandler);
      }

      function handleWatchlistClick(e) {
        if (!window.__selectionModeActive) return;
        
        var card = e.target.closest('.watchlist-card');
        if (!card) return;
        
        // Skip swipe delete buttons or checkbox itself to avoid double-toggling
        if (e.target.closest('.wc-swipe-actions') || e.target.classList.contains('wc-checkbox') || e.target.closest('.mcx-comex-switch')) {
          return;
        }
        
        e.preventDefault();
        e.stopPropagation();
        
        var cb = card.querySelector('.wc-checkbox');
        if (cb) {
          cb.checked = !cb.checked;
          if (typeof window.__updateSelectionUI === 'function') window.__updateSelectionUI();
        }
      }

      function handleWatchlistChange(e) {
        if (e.target && e.target.classList.contains('wc-checkbox')) {
          if (typeof window.__updateSelectionUI === 'function') window.__updateSelectionUI();
        }
      }

      window.__watchlistClickHandler = handleWatchlistClick;
      window.__watchlistChangeHandler = handleWatchlistChange;
      document.addEventListener('click', handleWatchlistClick, true);
      document.addEventListener('change', handleWatchlistChange);
      window.__watchlistEventsAttached = true;

      var basketModeBtn = document.getElementById('basketModeBtn');
      // basketModeBtn click is handled by React - no JS handler needed

      function attachSwipeHandlers() {
        var cards = document.querySelectorAll('.watchlist-card');
        cards.forEach(function(card) {
          if (card.getAttribute('data-swipe-attached')) return;
          card.setAttribute('data-swipe-attached', 'true');
          
          var startX = 0, startY = 0, currentX = 0, isDragging = false, longPressTimer = null;
          card.addEventListener('touchstart', function(e) {
            if (!e.touches || !e.touches[0]) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentX = startX;
            isDragging = true;
            if (longPressTimer) clearTimeout(longPressTimer);
            longPressTimer = setTimeout(function() {
              if (!selectionMode && isDragging) {
                enterSelectionMode();
                var cb = card.querySelector('.wc-checkbox');
                if (cb) cb.checked = true;
                updateSelectionUI();
              }
            }, 500);
          }, { passive: true });

          card.addEventListener('touchmove', function(e) {
            if (!isDragging || !e.touches || !e.touches[0]) return;
            var currentY = e.touches[0].clientY;
            currentX = e.touches[0].clientX;
            var diffX = currentX - startX;
            var diffY = currentY - startY;

            // If finger moved significantly (scrolling or swiping), cancel long-press selection mode timer
            if (Math.abs(diffY) > 6 || Math.abs(diffX) > 6) {
              if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
              }
            }

            var content = card.querySelector('.wc-content');
            if (!content) return;
            if (diffX < -50) {
              content.style.transform = 'translateX(-80px)';
            } else if (diffX > 0) {
              content.style.transform = 'translateX(0)';
            }
          }, { passive: true });

          card.addEventListener('touchend', function() {
            if (longPressTimer) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
            isDragging = false;
          });

          card.addEventListener('touchcancel', function() {
            if (longPressTimer) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
            isDragging = false;
          });
        });
      }

      function enterSelectionMode() {
        selectionMode = true;
        window.__selectionModeActive = true;
        if (window.__reactSetSelectionActive) window.__reactSetSelectionActive(true);
        document.querySelectorAll('.wc-checkbox-wrapper').forEach(function(el) {
          el.style.display = 'flex';
        });
        updateSelectionUI();
      }

      function exitSelectionMode() {
        selectionMode = false;
        window.__selectionModeActive = false;
        if (window.__reactSetSelectionActive) window.__reactSetSelectionActive(false);
        document.querySelectorAll('.wc-checkbox-wrapper').forEach(function(el) {
          el.style.display = 'none';
        });
        document.querySelectorAll('.wc-checkbox').forEach(function(cb) {
          cb.checked = false;
        });
      }

      function updateSelectionUI() {
        var checked = document.querySelectorAll('.wc-checkbox:checked').length;
        if (selectedCountSpan) selectedCountSpan.textContent = checked + ' selected';
      }
      window.__updateSelectionUI = updateSelectionUI;
      window.__selectionModeActive = selectionMode;

      window.__renderWatchlist = function() { /* Now handled by React */ };
      window.attachSwipeHandlers = attachSwipeHandlers;
      window.enterSelectionMode = enterSelectionMode;
      window.exitSelectionMode = exitSelectionMode;
      window.openDetailSheet = openDetailSheet;
      window.openTradeSheet = openTradeSheet;
      window.addToWatchlist = addToWatchlist;
      window.removeFromWatchlist = removeFromWatchlist;
      
      attachSwipeHandlers();
    })();
  `;
}

export default function WatchlistPage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <AnimatedLoader text="Loading watchlist..." />;
  }

  return (
    <Suspense fallback={<AnimatedLoader text="Loading watchlist..." />}>
      <WatchlistContent />
    </Suspense>
  );
}


