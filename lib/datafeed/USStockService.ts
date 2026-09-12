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
  'NFLX': 600,
  'AAPL': 220,
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
};

export function getUSStockBasePrice(symbol: string): number {
  const clean = symbol.replace(/^(US:|FOREX:)/i, '').trim().toUpperCase();
  if (US_BASE_PRICES[clean]) return US_BASE_PRICES[clean];
  const baseClean = clean.replace(/=F$/i, '');
  if (US_BASE_PRICES[baseClean]) return US_BASE_PRICES[baseClean];
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

  // 2. Fetch REAL Live Market Quote Server-Side (0 Broker Credentials Required)
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSymbol)}?interval=1m&range=1d`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(3500),
    });

    if (res.ok) {
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta && typeof meta.regularMarketPrice === 'number' && meta.regularMarketPrice > 0) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || meta.previousClose || price;
        const high = meta.regularMarketDayHigh || price;
        const low = meta.regularMarketDayLow || price;
        const changePercent = meta.regularMarketChangePercent ?? (prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0);

        const realQuote: USStockQuote = {
          symbol: cleanSymbol,
          name: meta.shortName || meta.symbol || cleanSymbol,
          price,
          high,
          low,
          prevClose,
          changePercent: Number(changePercent.toFixed(2)),
          currency: 'INR',
        };

        quoteCache.set(cleanSymbol, { quote: realQuote, timestamp: Date.now() });
        return realQuote;
      }
    }
  } catch (err) {
    console.warn(`[USStockService] Real market quote fetch failed for ${cleanSymbol}:`, err);
  }

  // Consistent Fallback for US Stocks if network is offline
  const basePrice = getUSStockBasePrice(cleanSymbol);
  const fallbackQuote: USStockQuote = {
    symbol: cleanSymbol,
    name: cleanSymbol,
    price: basePrice,
    high: Number((basePrice * 1.01).toFixed(2)),
    low: Number((basePrice * 0.99).toFixed(2)),
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

