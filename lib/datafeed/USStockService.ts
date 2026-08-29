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

export async function fetchUSStockQuote(symbol: string): Promise<USStockQuote | null> {
  const cleanSymbol = symbol.replace(/^US:/i, '').trim().toUpperCase();
  const cached = quoteCache.get(cleanSymbol);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.quote;
  }

  try {
    const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${cleanSymbol}?interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return null;

    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;

    if (!meta) return null;

    const quote: USStockQuote = {
      symbol: meta.symbol || cleanSymbol,
      name: meta.longName || meta.shortName || cleanSymbol,
      price: meta.regularMarketPrice ?? 0,
      high: meta.regularMarketDayHigh ?? meta.regularMarketPrice ?? 0,
      low: meta.regularMarketDayLow ?? meta.regularMarketPrice ?? 0,
      prevClose: meta.chartPreviousClose ?? meta.regularMarketPrice ?? 0,
      changePercent: meta.regularMarketChangePercent ?? 0,
      currency: meta.currency || 'USD',
    };

    quoteCache.set(cleanSymbol, { quote, timestamp: Date.now() });
    return quote;
  } catch (err) {
    console.warn(`[USStockService] Failed to fetch quote for ${cleanSymbol}:`, err);
    return null;
  }
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
