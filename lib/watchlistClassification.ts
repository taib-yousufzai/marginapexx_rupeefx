import { getCurrentFuturesSymbol } from '@/lib/contractExpiry';

export const WATCHLIST_KEY = 'marginApex_watchlist';

export interface WatchlistItem {
  name: string;
  symbol: string;
  kiteSymbol: string;
  binanceSymbol?: string;  // e.g. 'BTCUSDT' — crypto (Binance)
  comexSymbol?: string;  // e.g. 'XAUUSD'  — COMEX USD price, paired with kiteSymbol for MCX
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

// ── Default Crypto Items (Binance) ──────────────────────────────────────────

export const DEFAULT_CRYPTO_ITEMS: WatchlistItem[] = [
  { name: 'Bitcoin', symbol: 'BTC', kiteSymbol: '', binanceSymbol: 'BTCUSDT', price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
  { name: 'Ethereum', symbol: 'ETH', kiteSymbol: '', binanceSymbol: 'ETHUSDT', price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
  { name: 'Dogecoin', symbol: 'DOGE', kiteSymbol: '', binanceSymbol: 'DOGEUSDT', price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
];

// ── Default Forex Items (Zerodha CDS segment — INR pairs) ──────────────────

export const DEFAULT_FOREX_ITEMS: WatchlistItem[] = [
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

// ── Default COMEX Items (MCX ₹ via Kite + COMEX $ via Direct feed) ──────────────

export const DEFAULT_COMEX_ITEMS: WatchlistItem[] = [
  { name: 'GOLD', symbol: 'XAUUSD', kiteSymbol: '', comexSymbol: 'XAUUSD', price: 4349.42, change: '+0.75%', segment: 'COMEX - Futures', contractDate: '', open: 4349.42, high: 4360, low: 4330, close: 4349.42, category: 'COMEX' },
  { name: 'SILVER', symbol: 'XAGUSD', kiteSymbol: '', comexSymbol: 'XAGUSD', price: 64.21, change: '+1.26%', segment: 'COMEX - Futures', contractDate: '', open: 64.21, high: 64.50, low: 63.90, close: 64.21, category: 'COMEX' },
  { name: 'CRUDE OIL', symbol: 'XTIUSD', kiteSymbol: '', comexSymbol: 'XTIUSD', price: 69.50, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 69.50, high: 70.00, low: 69.00, close: 69.50, category: 'COMEX' },
  { name: 'COPPER', symbol: 'XCUUSD', kiteSymbol: '', comexSymbol: 'XCUUSD', price: 4.15, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 4.15, high: 4.20, low: 4.10, close: 4.15, category: 'COMEX' },
];

export const DEFAULT_US_ITEMS: WatchlistItem[] = [
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
    const words = text.toLowerCase().split(/\s+/);
    return words.some(w => w.startsWith(q));
  }

  return items.filter(
    item => wordStartMatch(item.name) || wordStartMatch(item.symbol)
  );
}

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
