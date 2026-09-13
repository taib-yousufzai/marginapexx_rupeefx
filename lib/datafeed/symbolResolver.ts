type LibrarySymbolInfo = any;
type ResolutionString = any;

const KNOWN_US_SYMBOLS = new Set([
  'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'INTC',
  'SPY', 'QQQ', 'DIA', 'ES=F', 'NQ=F', 'YM=F', 'CL=F', 'GC=F', 'SI=F', 'NG=F', 'HG=F',
  'XAUUSD', 'XAGUSD', 'XTIUSD', 'XNGUSD', 'XCUUSD', 'GOLD', 'SILVER', 'CRUDE', 'WTI'
]);

export function isUsSymbol(symbolName: string, segment?: string): boolean {
  if (!symbolName) return false;
  const upper = symbolName.toUpperCase().trim();
  if (upper.startsWith('US:') || upper.startsWith('COMEX:')) return true;
  if (segment && (segment.toUpperCase().includes('US') || segment.toUpperCase().includes('COMEX') || segment.toUpperCase() === 'US EQUITIES' || segment.toUpperCase() === 'US FUTURES')) return true;
  const clean = upper.replace(/^(US:|COMEX:)/, '').trim();
  return KNOWN_US_SYMBOLS.has(clean) || clean.endsWith('=F');
}

export function isForexSymbol(symbolName: string): boolean {
  if (!symbolName) return false;
  let upper = symbolName.toUpperCase().trim();

  if (upper.startsWith('US:') || isUsSymbol(symbolName)) return false;
  
  // Indian currency futures, exchange prefixes, and Indian indices/stocks are NOT Yahoo Forex
  if (
    upper.includes('INR') || 
    upper.endsWith('FUT') || 
    upper.startsWith('CDS:') ||
    upper.startsWith('BSE:') ||
    upper.startsWith('NSE:') ||
    upper.startsWith('NFO:') ||
    upper.startsWith('BFO:') ||
    upper.startsWith('MCX:') ||
    upper.includes('SENSEX') ||
    upper.includes('BANKEX') ||
    upper.includes('NIFTY')
  ) {
    return false;
  }

  if (upper.startsWith('FOREX:')) return true;
  if (upper.endsWith('=X')) upper = upper.slice(0, -2);
  const clean = (upper.includes(':') ? upper.split(':')[1] : upper).replace(/[\/\=X]/g, '').trim();
  const FOREX_PAIRS = ['GBPUSD', 'EURUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'CHFJPY', 'NZDJPY', 'EURAUD', 'EURCAD', 'EURNZD', 'GBPAUD', 'GBPCAD', 'GBPNZD'];
  return FOREX_PAIRS.includes(clean);
}

/**
 * Derives the exchange name from a Kite-style exchange-prefixed symbol.
 * Falls back to "NSE" for unrecognised or un-prefixed symbols.
 */
export function deriveExchange(symbolName: string): string {
  const upper = symbolName.toUpperCase();

  if (isUsSymbol(symbolName)) {
    return 'US';
  }

  if (isForexSymbol(symbolName)) {
    return 'FOREX';
  }

  // Commodity contracts (GOLD, SILVER, CRUDEOIL, NATURALGAS, etc.) are always MCX
  if (
    upper.includes('CRUDE') || upper.includes('GOLD') || 
    upper.includes('SILVER') || upper.includes('NATURALGAS') || 
    upper.includes('NATGAS') || upper.includes('COPPER') || 
    upper.includes('ZINC') || upper.includes('ALUMINIUM') || 
    upper.includes('LEAD')
  ) {
    return 'MCX';
  }

  if (symbolName.startsWith('NSE:')) return 'NSE';
  if (symbolName.startsWith('BSE:')) return 'BSE';
  if (symbolName.startsWith('MCX:')) return 'MCX';
  if (symbolName.startsWith('NCO:')) return 'MCX';
  if (symbolName.startsWith('NFO:')) return 'NFO';
  if (symbolName.startsWith('BFO:')) return 'BFO';
  if (symbolName.startsWith('CDS:')) return 'CDS';

  if (
    upper.includes('EURINR') || upper.includes('USDINR') || 
    upper.includes('GBPINR') || upper.includes('JPYINR')
  ) {
    return 'CDS';
  }

  if (upper.match(/\d+(CE|PE)$/) || upper.match(/(FUT)$/)) {
    if (upper.includes('SENSEX') || upper.includes('BANKEX')) return 'BFO';
    return 'NFO';
  }

  if (upper.includes('SENSEX') || upper.includes('BANKEX')) return 'BSE';

  return 'NSE';
}

/**
 * Builds a TradingView `LibrarySymbolInfo` object for the given symbol and segment.
 */
export function formatShortName(name: string): string {
  // Check for Options (e.g., NIFTY2672124200CE)
  const optMatch = name.match(/^([A-Z]+).*?(\d+)(CE|PE)$/i);
  if (optMatch) {
    return `${optMatch[1]} ${optMatch[2]} ${optMatch[3].toUpperCase()}`;
  }

  // Check for Futures (e.g., NIFTY26JULFUT)
  const futMatch = name.match(/^([A-Z]+).*?(FUT)$/i);
  if (futMatch) {
    return `${futMatch[1]} FUT`;
  }

  // Default fallback
  return name;
}

export function buildSymbolInfo(symbolName: string, segment: string): LibrarySymbolInfo {
  const upperSym = symbolName.toUpperCase();
  const isUs = isUsSymbol(symbolName, segment);
  const isGlobalForex = !isUs && (isForexSymbol(symbolName) || (segment.toUpperCase() === 'FOREX' && !upperSym.includes('INR') && !upperSym.endsWith('FUT') && !upperSym.startsWith('CDS:')));
  const isCrypto =
    !isUs && !isGlobalForex && (symbolName.endsWith('USDT') || segment.toUpperCase() === 'CRYPTO');

  const colonIdx = symbolName.indexOf(':');
  const rawName = colonIdx >= 0 ? symbolName.slice(colonIdx + 1) : symbolName;
  let name = formatShortName(rawName);
  if (isGlobalForex) {
    if (name.endsWith('=X')) name = name.slice(0, -2);
    name = name.replace(/\//g, '');
  }
  
  const exchange = isUs ? 'US' : isGlobalForex ? 'FOREX' : isCrypto ? 'BINANCE' : deriveExchange(symbolName);
  let ticker = isUs
    ? (symbolName.startsWith('US:') ? symbolName : `US:${symbolName}`)
    : (isCrypto || isGlobalForex || symbolName.includes(':')) ? symbolName : `${exchange}:${symbolName}`;

  if (exchange === 'MCX' && ticker.startsWith('NFO:')) {
    ticker = `MCX:${ticker.slice(4)}`;
  }
  
  const isComex = upperSym.startsWith('COMEX:') || segment?.toUpperCase() === 'COMEX' || ['GC=F', 'SI=F', 'CL=F', 'NG=F', 'HG=F', 'XAUUSD', 'XAGUSD', 'XTIUSD', 'XNGUSD', 'XCUUSD'].some(c => upperSym.includes(c));

  let session = '0915-1530';
  let timezone = 'Asia/Kolkata';

  if (isCrypto || isComex) {
    session = '24x7';
    timezone = 'Asia/Kolkata';
  } else if (isGlobalForex) {
    session = '24x7';
    timezone = 'Asia/Kolkata';
  } else if (isUs) {
    session = '0930-1600';
    timezone = 'America/New_York';
  } else if (exchange === 'MCX') {
    session = '0900-2355';
    timezone = 'Asia/Kolkata';
  } else if (exchange === 'CDS') {
    session = '0900-1700';
    timezone = 'Asia/Kolkata';
  }

  const isJpy = rawName.toUpperCase().includes('JPY');

  return {
    name,
    ticker,
    description: rawName,
    type: isCrypto ? 'crypto' : isGlobalForex ? 'forex' : 'stock',
    exchange,
    listed_exchange: exchange,
    session,
    timezone,
    pricescale: isCrypto ? 100000 : (isJpy && isGlobalForex) ? 1000 : isGlobalForex ? 100000 : exchange === 'CDS' ? 10000 : 100,
    minmov: 1,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    intraday_multipliers: ['1', '2', '3', '5', '10', '15', '30', '60'],
    supported_resolutions: ['1', '2', '3', '5', '10', '15', '30', '60', 'D'] as ResolutionString[],
    volume_precision: 2,
    data_status: 'streaming',
    format: 'price',
  };
}

export function getCanonicalSymbol(symbolInfoOrName: any): string {
  if (!symbolInfoOrName) return '';
  if (typeof symbolInfoOrName === 'string') {
    return symbolInfoOrName;
  }
  return symbolInfoOrName.ticker || symbolInfoOrName.name || '';
}
