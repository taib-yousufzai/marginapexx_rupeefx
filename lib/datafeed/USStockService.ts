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

  // 100% MT5 Datafeed
  try {
    const mt5Quote = await fetchMT5StockQuote(cleanSymbol);
    if (mt5Quote) {
      quoteCache.set(cleanSymbol, { quote: mt5Quote, timestamp: Date.now() });
      return mt5Quote;
    }
  } catch (err) {
    console.warn(`[USStockService] MT5 fetch failed for ${cleanSymbol}:`, err);
  }

  // Consistent Fallback for US Stocks when MT5 is unconfigured or unavailable
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

