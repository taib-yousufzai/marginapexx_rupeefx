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

export function getComexSymbolKey(item: Partial<WatchlistItem> | null | undefined): string {
  if (!item) return '';
  if (item.comexSymbol) return item.comexSymbol.toUpperCase();
  if (item.symbol?.endsWith('=F')) return item.symbol.toUpperCase();

  const symUp = (item.symbol || '').toUpperCase().trim();
  const segUp = (item.segment || '').toUpperCase();
  const catUp = (item.category || '').toUpperCase();
  const isComexContext = segUp.includes('COMEX') || catUp.includes('COMEX');

  if (isComexContext) {
    if (symUp === 'XAUUSD' || symUp === 'GOLD' || symUp === 'GC=F' || symUp === 'GC') return 'XAUUSD';
    if (symUp === 'XAGUSD' || symUp === 'SILVER' || symUp === 'SI=F' || symUp === 'SI') return 'XAGUSD';
    if (symUp === 'XTIUSD' || symUp === 'CRUDE' || symUp === 'CRUDE OIL' || symUp === 'WTI' || symUp === 'CL=F') return 'XTIUSD';
    if (symUp === 'XCUUSD' || symUp === 'COPPER' || symUp === 'HG=F' || symUp === 'HG') return 'XCUUSD';
    if (symUp === 'XNGUSD' || symUp === 'NATGAS' || symUp === 'NATURAL GAS' || symUp === 'NG=F') return 'XNGUSD';
  } else {
    // If not in COMEX segment, only return if the symbol itself is an explicit COMEX ticker
    if (symUp.startsWith('XAU')) return 'XAUUSD';
    if (symUp.startsWith('XAG')) return 'XAGUSD';
    if (symUp.startsWith('XTI')) return 'XTIUSD';
    if (symUp.startsWith('XCU')) return 'XCUUSD';
    if (symUp.startsWith('XNG')) return 'XNGUSD';
  }

  return '';
}

// ── Default Crypto Items (Binance) ──────────────────────────────────────────

export const DEFAULT_CRYPTO_ITEMS: WatchlistItem[] = [
  { name: 'Bitcoin', symbol: 'BTC', kiteSymbol: '', binanceSymbol: 'BTCUSDT', price: 95000, change: '0%', segment: 'CRYPTO', contractDate: '', open: 95000, high: 96000, low: 94000, close: 95000, category: 'CRYPTO' },
  { name: 'Ethereum', symbol: 'ETH', kiteSymbol: '', binanceSymbol: 'ETHUSDT', price: 3400, change: '0%', segment: 'CRYPTO', contractDate: '', open: 3400, high: 3450, low: 3350, close: 3400, category: 'CRYPTO' },
  { name: 'Dogecoin', symbol: 'DOGE', kiteSymbol: '', binanceSymbol: 'DOGEUSDT', price: 0.15, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0.15, high: 0.155, low: 0.145, close: 0.15, category: 'CRYPTO' },
];

// ── Default Forex Items (Zerodha CDS segment — INR pairs) ──────────────────

export const DEFAULT_FOREX_ITEMS: WatchlistItem[] = [
  { name: 'GBP/USD', symbol: 'GBPUSD', kiteSymbol: '', comexSymbol: 'GBPUSD=X', price: 1.3485, change: '0%', segment: 'Forex', contractDate: '', open: 1.3485, high: 1.3505, low: 1.3480, close: 1.3485, category: 'FOREX' },
  { name: 'EUR/USD', symbol: 'EURUSD', kiteSymbol: '', comexSymbol: 'EURUSD=X', price: 1.1537, change: '0%', segment: 'Forex', contractDate: '', open: 1.1537, high: 1.1555, low: 1.1530, close: 1.1537, category: 'FOREX' },
  { name: 'USD/JPY', symbol: 'USDJPY', kiteSymbol: '', comexSymbol: 'USDJPY=X', price: 154.64, change: '0%', segment: 'Forex', contractDate: '', open: 154.64, high: 155.00, low: 154.20, close: 154.64, category: 'FOREX' },
  { name: 'USD/CHF', symbol: 'USDCHF', kiteSymbol: '', comexSymbol: 'USDCHF=X', price: 0.8181, change: '0%', segment: 'Forex', contractDate: '', open: 0.8181, high: 0.8200, low: 0.8160, close: 0.8181, category: 'FOREX' },
  { name: 'USD/CAD', symbol: 'USDCAD', kiteSymbol: '', comexSymbol: 'USDCAD=X', price: 1.3914, change: '0%', segment: 'Forex', contractDate: '', open: 1.3914, high: 1.3950, low: 1.3880, close: 1.3914, category: 'FOREX' },
  { name: 'AUD/USD', symbol: 'AUDUSD', kiteSymbol: '', comexSymbol: 'AUDUSD=X', price: 0.7123, change: '0%', segment: 'Forex', contractDate: '', open: 0.7123, high: 0.7150, low: 0.7100, close: 0.7123, category: 'FOREX' },
  { name: 'NZD/USD', symbol: 'NZDUSD', kiteSymbol: '', comexSymbol: 'NZDUSD=X', price: 0.5753, change: '0%', segment: 'Forex', contractDate: '', open: 0.5753, high: 0.5780, low: 0.5730, close: 0.5753, category: 'FOREX' },
  { name: 'USD/INR', symbol: getCurrentFuturesSymbol('CDS', 'USDINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'USDINR'), price: 95.80, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 95.80, high: 96.00, low: 95.50, close: 95.80, category: 'FOREX' },
  { name: 'EUR/INR', symbol: getCurrentFuturesSymbol('CDS', 'EURINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'EURINR'), price: 110.53, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 110.53, high: 110.80, low: 110.20, close: 110.53, category: 'FOREX' },
  { name: 'GBP/INR', symbol: getCurrentFuturesSymbol('CDS', 'GBPINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'GBPINR'), price: 129.20, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 129.20, high: 129.80, low: 128.80, close: 129.20, category: 'FOREX' },
  { name: 'JPY/INR', symbol: getCurrentFuturesSymbol('CDS', 'JPYINR'), kiteSymbol: getCurrentFuturesSymbol('CDS', 'JPYINR'), price: 0.6190, change: '0%', segment: 'CDS - Futures', contractDate: '', open: 0.6190, high: 0.6220, low: 0.6170, close: 0.6190, category: 'FOREX' },
];

// ── Default COMEX Items (COMEX $ via Direct feed) ──────────────────────────────

export const DEFAULT_COMEX_ITEMS: WatchlistItem[] = [
  { name: 'XAUUSD', symbol: 'XAUUSD', kiteSymbol: '', comexSymbol: 'XAUUSD', price: 4306.00, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 4306.00, high: 4320.00, low: 4290.00, close: 4306.00, category: 'COMEX' },
  { name: 'XAGUSD', symbol: 'XAGUSD', kiteSymbol: '', comexSymbol: 'XAGUSD', price: 63.30, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 63.30, high: 63.80, low: 62.80, close: 63.30, category: 'COMEX' },
  { name: 'XTIUSD', symbol: 'XTIUSD', kiteSymbol: '', comexSymbol: 'XTIUSD', price: 103.00, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 103.00, high: 104.00, low: 102.00, close: 103.00, category: 'COMEX' },
  { name: 'XCUUSD', symbol: 'XCUUSD', kiteSymbol: '', comexSymbol: 'XCUUSD', price: 6.28, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 6.28, high: 6.35, low: 6.20, close: 6.28, category: 'COMEX' },
];

export const DEFAULT_US_ITEMS: WatchlistItem[] = [
  { name: 'Apple Inc.', symbol: 'US:AAPL', kiteSymbol: 'US:AAPL', price: 228.00, change: '0%', segment: 'US - Equity', contractDate: '', open: 228.00, high: 230.20, low: 226.80, close: 228.00, category: 'US-EQ' },
  { name: 'Tesla Inc.', symbol: 'US:TSLA', kiteSymbol: 'US:TSLA', price: 215.00, change: '0%', segment: 'US - Equity', contractDate: '', open: 215.00, high: 218.10, low: 212.90, close: 215.00, category: 'US-EQ' },
  { name: 'Nvidia Corp.', symbol: 'US:NVDA', kiteSymbol: 'US:NVDA', price: 125.00, change: '0%', segment: 'US - Equity', contractDate: '', open: 125.00, high: 126.20, low: 123.80, close: 125.00, category: 'US-EQ' },
  { name: 'Microsoft Corp.', symbol: 'US:MSFT', kiteSymbol: 'US:MSFT', price: 425.00, change: '0%', segment: 'US - Equity', contractDate: '', open: 425.00, high: 428.20, low: 421.80, close: 425.00, category: 'US-EQ' },
  { name: 'Amazon.com Inc.', symbol: 'US:AMZN', kiteSymbol: 'US:AMZN', price: 185.00, change: '0%', segment: 'US - Equity', contractDate: '', open: 185.00, high: 187.80, low: 183.20, close: 185.00, category: 'US-EQ' },
  { name: 'Netflix Inc.', symbol: 'US:NFLX', kiteSymbol: 'US:NFLX', price: 680.00, change: '0%', segment: 'US - Equity', contractDate: '', open: 680.00, high: 686.00, low: 674.00, close: 680.00, category: 'US-EQ' },
  { name: 'S&P 500 E-mini Futures', symbol: 'ES=F', kiteSymbol: '', comexSymbol: 'ES=F', price: 5650.00, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 5650.00, high: 5680.00, low: 5620.00, close: 5650.00, category: 'COMEX' },
  { name: 'Nasdaq 100 E-mini Futures', symbol: 'NQ=F', kiteSymbol: '', comexSymbol: 'NQ=F', price: 19800.00, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 19800.00, high: 19950.00, low: 19650.00, close: 19800.00, category: 'COMEX' },
  { name: 'Dow Jones E-mini Futures', symbol: 'YM=F', kiteSymbol: '', comexSymbol: 'YM=F', price: 41500.00, change: '0%', segment: 'COMEX - Futures', contractDate: '', open: 41500.00, high: 41750.00, low: 41250.00, close: 41500.00, category: 'COMEX' },
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
  const symUp = (item.symbol || '').toUpperCase();
  const comexUp = (item.comexSymbol || '').toUpperCase();
  const segUp = (item.segment || '').toUpperCase();
  const catUp = (item.category || '').toUpperCase();

  // COMEX spot & futures symbols
  if (
    catUp === 'COMEX' || catUp === 'COI' ||
    segUp.includes('COMEX') ||
    symUp.endsWith('=F') || comexUp.endsWith('=F') ||
    ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].includes(symUp) ||
    (!!item.comexSymbol && !item.kiteSymbol)
  ) {
    return 'COMEX';
  }

  const comb = `${item.name || ''} ${item.symbol || ''} ${item.segment || ''} ${item.category || ''}`.toUpperCase();
  if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM'].some(c => comb.includes(c))) {
    if (comb.includes(' CE') || comb.includes(' PE') || comb.endsWith('CE') || comb.endsWith('PE') || comb.includes('OPT')) return 'MCX-OPT';
    if (comb.includes('COMEX') || symUp.endsWith('=F')) return 'COMEX';
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
  const symUpper = (symbol || '').toUpperCase();
  const comb = `${name || ''} ${symbol || ''} ${segment || ''}`.toUpperCase();

  if (segUpper.includes('COMEX') || symUpper.endsWith('=F') || ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].includes(symUpper)) {
    return 'COMEX';
  }

  const isCommodity = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM'].some(c => comb.includes(c));
  if (isCommodity) {
    if (comb.includes(' CE') || comb.includes(' PE') || comb.endsWith('CE') || comb.endsWith('PE') || comb.includes('OPT')) return 'MCX-OPT';
    if (segUpper.includes('COMEX') || symUpper.endsWith('=F')) return 'COMEX';
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
