/**
 * MT5StockService.ts
 *
 * High-performance MT5 datafeed service for US Equities (AAPL, TSLA, NVDA, MSFT, etc.).
 * Communicates with MT5 Web API / Server Gateway to supply real-time Bid/Ask/Last quotes
 * and OHLC data formatted for the application UI.
 */

import { USStockQuote } from './USStockService';

interface MT5SymbolTickResponse {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  price?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  changePercent?: number;
  time?: number;
}

// In-memory quote cache (2-second TTL matching USStockService)
const mt5QuoteCache = new Map<string, { quote: USStockQuote; timestamp: number }>();
const CACHE_TTL_MS = 2000;

/**
 * Checks if MT5 datafeed integration is enabled and configured via environment variables.
 */
export function isMT5Configured(): boolean {
  const enabled = process.env.MT5_ENABLED;
  const webApiUrl = process.env.MT5_WEB_API_URL;
  if (!enabled || enabled.toLowerCase() !== 'true') return false;
  return Boolean(webApiUrl && webApiUrl.trim().length > 0);
}

/**
 * Formats a clean US symbol to MT5 broker symbol format (e.g. AAPL -> AAPL.US)
 */
export function formatMT5Symbol(symbol: string): string {
  const cleanSymbol = symbol.replace(/^US:/i, '').trim().toUpperCase();
  const suffix = process.env.MT5_SYMBOL_SUFFIX || '';
  if (suffix && !cleanSymbol.endsWith(suffix)) {
    return `${cleanSymbol}${suffix}`;
  }
  return cleanSymbol;
}

/**
 * Fetches a single US Stock Quote from the MT5 Web API / Gateway.
 */
export async function fetchMT5StockQuote(symbol: string): Promise<USStockQuote | null> {
  if (!isMT5Configured()) return null;

  const cleanSymbol = symbol.replace(/^US:/i, '').trim().toUpperCase();
  const mt5Symbol = formatMT5Symbol(cleanSymbol);

  const cached = mt5QuoteCache.get(cleanSymbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.quote;
  }

  let rawUrl = process.env.MT5_WEB_API_URL!.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = `http://${rawUrl}`;
  }
  const webApiUrl = rawUrl;
  const login = process.env.MT5_LOGIN;
  const password = process.env.MT5_PASSWORD;

  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    if (login && password) {
      const authHeader = Buffer.from(`${login}:${password}`).toString('base64');
      headers['Authorization'] = `Basic ${authHeader}`;
    }

    const endpoint = `${webApiUrl}/api/tick/last?symbol=${encodeURIComponent(mt5Symbol)}`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });

    if (!res.ok) {
      console.warn(`[MT5StockService] MT5 API returned status ${res.status} for ${mt5Symbol}`);
      return null;
    }

    const data: MT5SymbolTickResponse = await res.json();
    const price = data.last ?? data.price ?? data.bid ?? data.ask ?? 0;
    if (price <= 0) return null;

    const high = data.high ?? price;
    const low = data.low ?? price;
    const prevClose = data.prevClose ?? price;
    const changePercent = data.changePercent ?? (prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0);

    const quote: USStockQuote = {
      symbol: cleanSymbol,
      name: cleanSymbol,
      price,
      high,
      low,
      prevClose,
      changePercent: Number(changePercent.toFixed(2)),
      currency: 'INR',
    };

    mt5QuoteCache.set(cleanSymbol, { quote, timestamp: Date.now() });
    return quote;
  } catch (err) {
    console.warn(`[MT5StockService] Failed to fetch MT5 quote for ${mt5Symbol}:`, err);
    return null;
  }
}

/**
 * Batch fetches US Stock Quotes from MT5.
 */
export async function fetchMT5StockQuotes(symbols: string[]): Promise<Record<string, USStockQuote>> {
  if (!isMT5Configured() || symbols.length === 0) return {};

  const uniqueSymbols = Array.from(new Set(symbols.map(s => s.trim().toUpperCase())));
  const results: Record<string, USStockQuote> = {};

  const quotes = await Promise.all(uniqueSymbols.map(sym => fetchMT5StockQuote(sym)));

  quotes.forEach(q => {
    if (q) {
      results[q.symbol] = q;
    }
  });

  return results;
}

/**
 * Fetches historical candle bars from MT5 Web API for chart display.
 */
export async function fetchMT5HistoricalBars(
  symbol: string,
  interval: string,
  fromSec: number,
  toSec: number
): Promise<any[][]> {
  if (!isMT5Configured()) return [];

  const mt5Symbol = formatMT5Symbol(symbol);
  let rawUrl = process.env.MT5_WEB_API_URL!.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = `http://${rawUrl}`;
  }
  const webApiUrl = rawUrl;
  const login = process.env.MT5_LOGIN;
  const password = process.env.MT5_PASSWORD;

  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    if (login && password) {
      const authHeader = Buffer.from(`${login}:${password}`).toString('base64');
      headers['Authorization'] = `Basic ${authHeader}`;
    }

    const endpoint = `${webApiUrl}/api/chart/bars?symbol=${encodeURIComponent(mt5Symbol)}&interval=${encodeURIComponent(interval)}&from=${fromSec}&to=${toSec}`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return [];

    const json = await res.json();
    const bars: any[] = json?.bars ?? json?.candles ?? [];
    return bars.map(b => [
      typeof b.time === 'number' ? new Date(b.time * 1000).toISOString() : b.time,
      b.open,
      b.high,
      b.low,
      b.close,
      b.volume ?? 0
    ]);
  } catch (err) {
    console.warn(`[MT5StockService] Failed to fetch MT5 bars for ${mt5Symbol}:`, err);
    return [];
  }
}

