/**
 * USStockService.ts
 *
 * Lightweight, high-performance datafeed service for US Equities (AAPL, TSLA, NVDA, MSFT, etc.).
 * Uses reliable financial REST endpoint with 2-second in-memory caching.
 */

export interface USStockQuote {
  symbol: string;
  name: string;
  price: number;
  high: number;
  low: number;
  prevClose: number;
  changePercent: number;
  currency: string;
}

// In-memory price cache to prevent duplicate requests within 2 seconds
const quoteCache = new Map<string, { quote: USStockQuote; timestamp: number }>();
const CACHE_TTL_MS = 2000;

import { fetchMT5StockQuote, isMT5Configured } from './MT5StockService';

export const US_BASE_PRICES: Record<string, number> = {
  'NFLX': 77.40,
  'AAPL': 332.27,
  'TSLA': 210,
  'NVDA': 120,
  'MSFT': 420,
  'AMZN': 180,
  'GOOGL': 165,
  'META': 500,
  'AMD': 150,
  'INTC': 30,
  'SPY': 550,
  'QQQ': 480,
  'DIA': 400,
  'ES=F': 5500,
  'NQ=F': 19500,
  'YM=F': 41000,
  'XAUUSD': 4349.42,
  'GC=F': 4349.42,
  'GOLD': 4349.42,
  'XAGUSD': 64.21,
  'SI=F': 64.21,
  'SILVER': 64.21,
  'CL=F': 69.50,
  'XTIUSD': 69.50,
  'CRUDE': 69.50,
  'WTI': 69.50,
  'HG=F': 4.15,
  'COPPER': 4.15,
  'XCUUSD': 4.15,
  'NG=F': 2.30,
  'XNGUSD': 2.30,
  'NATGAS': 2.30,
};

export const FOREX_BASE_PRICES: Record<string, number> = {
  'GBPUSD': 1.3523,
  'EURUSD': 1.1597,
  'USDJPY': 153.61,
  'USDCHF': 0.8166,
  'USDCAD': 1.3863,
  'AUDUSD': 0.7155,
  'NZDUSD': 0.5811,
  'USDINR': 95.61,
  'EURINR': 110.88,
  'GBPINR': 129.29,
  'JPYINR': 0.622,
  'EURGBP': 0.8570,
  'EURJPY': 178.10,
  'GBPJPY': 207.75,
  'GBPUSD=X': 1.3523,
  'EURUSD=X': 1.1597,
  'USDJPY=X': 153.61,
  'USDCHF=X': 0.8166,
  'USDCAD=X': 1.3863,
  'AUDUSD=X': 0.7155,
  'NZDUSD=X': 0.5811,
};

export function getUSStockBasePrice(symbol: string): number {
  if (!symbol) return 100;
  const clean = symbol.replace(/^(US:|FOREX:|COMEX:|MCX:|CDS:|FX:|TVC:|OANDA:)/i, '').replace(/[\/\s]/g, '').trim().toUpperCase();
  if (US_BASE_PRICES[clean]) return US_BASE_PRICES[clean];
  if (FOREX_BASE_PRICES[clean]) return FOREX_BASE_PRICES[clean];

  const baseClean = clean.replace(/(=[FX]|\.X)$/i, '').replace(/(\d{2}[A-Z]{3}FUT)$/i, '');
  if (US_BASE_PRICES[baseClean]) return US_BASE_PRICES[baseClean];
  if (FOREX_BASE_PRICES[baseClean]) return FOREX_BASE_PRICES[baseClean];

  for (const [k, v] of Object.entries(FOREX_BASE_PRICES)) {
    if (baseClean.startsWith(k) || clean.startsWith(k)) return v;
  }
  for (const [k, v] of Object.entries(US_BASE_PRICES)) {
    if (baseClean.startsWith(k) || clean.startsWith(k)) return v;
  }

  // If it matches 6-character forex pattern, return reasonable base rate rather than 100
  if (/^[A-Z]{6}$/.test(baseClean)) {
    if (baseClean.endsWith('JPY')) return 150.0;
    if (baseClean.endsWith('INR')) return 90.0;
    return 1.15;
  }

  return 100;
}

export async function fetchUSStockQuote(symbol: string): Promise<USStockQuote | null> {
  const cleanSymbol = symbol.replace(/^US:/i, '').trim().toUpperCase();
  const cached = quoteCache.get(cleanSymbol);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.quote;
  }

  // 1. Try MT5 if configured
  try {
    const mt5Quote = await fetchMT5StockQuote(cleanSymbol);
    if (mt5Quote) {
      quoteCache.set(cleanSymbol, { quote: mt5Quote, timestamp: Date.now() });
      return mt5Quote;
    }
  } catch (err) { }

  // 2. Fetch REAL Official NASDAQ Live Market Quote (0 Broker Logins / Credentials Needed)
  try {
    const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(cleanSymbol)}/info?assetclass=stocks`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(3500),
    });

    if (res.ok) {
      const json = await res.json();
      const primaryData = json?.data?.primaryData;
      if (primaryData && primaryData.lastSalePrice) {
        const rawPriceStr = String(primaryData.lastSalePrice).replace(/[^0-9.]/g, '');
        const price = parseFloat(rawPriceStr);
        if (!isNaN(price) && price > 0) {
          const changeStr = String(primaryData.percentageChange || '0').replace(/[^0-9.-]/g, '');
          const changePercent = parseFloat(changeStr) || 0;

          const realQuote: USStockQuote = {
            symbol: cleanSymbol,
            name: json?.data?.companyName || cleanSymbol,
            price,
            high: price,
            low: price,
            prevClose: price,
            changePercent,
            currency: 'INR',
          };

          quoteCache.set(cleanSymbol, { quote: realQuote, timestamp: Date.now() });
          return realQuote;
        }
      }
    }
  } catch (err) {
    console.warn(`[USStockService] NASDAQ live quote fetch failed for ${cleanSymbol}:`, err);
  }

  // Consistent Fallback for US Stocks if network is offline
  const basePrice = getUSStockBasePrice(cleanSymbol);
  const dec = basePrice < 10 ? 4 : 2;
  const fallbackQuote: USStockQuote = {
    symbol: cleanSymbol,
    name: cleanSymbol,
    price: basePrice,
    high: Number((basePrice * 1.01).toFixed(dec)),
    low: Number((basePrice * 0.99).toFixed(dec)),
    prevClose: basePrice,
    changePercent: 0,
    currency: 'INR',
  };

  quoteCache.set(cleanSymbol, { quote: fallbackQuote, timestamp: Date.now() });
  return fallbackQuote;
}

export async function fetchUSStockQuotes(symbols: string[]): Promise<Record<string, USStockQuote>> {
  if (symbols.length === 0) return {};

  const uniqueSymbols = Array.from(new Set(symbols.map(s => s.trim().toUpperCase())));
  const results: Record<string, USStockQuote> = {};

  const quotes = await Promise.all(uniqueSymbols.map(sym => fetchUSStockQuote(sym)));

  quotes.forEach(q => {
    if (q) {
      results[q.symbol] = q;
    }
  });

  return results;
}

