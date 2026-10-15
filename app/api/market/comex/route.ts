import { NextRequest, NextResponse } from 'next/server';
import { getUSStockBasePrice } from '@/lib/datafeed/USStockService';
import { fetchMT5StockQuote } from '@/lib/datafeed/MT5StockService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fetch real-time forex rates from a free public API
 */
async function fetchForexRate(symbol: string): Promise<number | null> {
  try {
    // Convert EURUSD to EUR/USD format for the API
    const clean = symbol.replace(/^(FOREX:|COMEX:|MCX:)/i, '').replace('/', '').toUpperCase();
    
    // For INR pairs, use exchangerate-api (free, no key needed)
    if (clean.includes('INR')) {
      const fromCurrency = clean.replace('INR', '').trim();
      if (fromCurrency) {
        try {
          const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${fromCurrency}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const data = await res.json();
            const rate = data.rates?.INR;
            if (rate > 0) {
              console.log('[COMEX] Exchange rate for', `${fromCurrency}/INR`, ':', rate);
              return rate;
            }
          }
        } catch (err) {
          console.log('[COMEX] Exchange rate API failed for', fromCurrency);
        }
      }
    }
    
    // For USD pairs (EURUSD, GBPUSD, etc), calculate from base USD rates
    if (clean.length === 6 && clean.endsWith('USD')) {
      const baseCurrency = clean.substring(0, 3);
      try {
        const res = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          const rate = data.rates?.[baseCurrency];
          if (rate > 0) {
            // Convert to XXX/USD format (e.g., EUR/USD = 1/USD_to_EUR)
            const forexRate = 1 / rate;
            console.log('[COMEX] Calculated forex rate for', clean, ':', forexRate);
            return forexRate;
          }
        }
      } catch (err) {
        console.log('[COMEX] Exchange rate calculation failed for', clean);
      }
    }
    
    // For USD/XXX pairs (USDJPY, USDCHF, etc)
    if (clean.length === 6 && clean.startsWith('USD')) {
      const targetCurrency = clean.substring(3);
      try {
        const res = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          const rate = data.rates?.[targetCurrency];
          if (rate > 0) {
            console.log('[COMEX] Exchange rate for', clean, ':', rate);
            return rate;
          }
        }
      } catch (err) {
        console.log('[COMEX] Exchange rate API failed for', clean);
      }
    }
  } catch (err) {
    console.log('[COMEX] Forex rate fetch error:', err);
  }
  return null;
}

async function fetchComexQuote(symbol: string) {
  console.log('[COMEX] Fetching quote for symbol:', symbol);
  const basePrice = getUSStockBasePrice(symbol);
  console.log('[COMEX] Base price for', symbol, '=', basePrice);

  // Try MT5 first
  try {
    const mt5Quote = await fetchMT5StockQuote(symbol);
    if (mt5Quote && mt5Quote.price > 0) {
      console.log('[COMEX] MT5 quote found for', symbol, ':', mt5Quote.price);
      return {
        symbol,
        contractSymbol: symbol,
        lastPrice: mt5Quote.price,
        change: Number((mt5Quote.price - mt5Quote.prevClose).toFixed(2)),
        changePercent: mt5Quote.changePercent,
        open: mt5Quote.prevClose,
        high: mt5Quote.high,
        low: mt5Quote.low,
        close: mt5Quote.prevClose,
        volume: 5000,
        currency: 'USD',
        name: symbol,
      };
    }
  } catch (err) {
    console.log('[COMEX] MT5 fetch failed for', symbol);
  }

  // Try real forex API for forex symbols
  const upper = symbol.toUpperCase();
  const isForex = upper.includes('USD') || upper.includes('EUR') || upper.includes('GBP') || 
                  upper.includes('JPY') || upper.includes('INR') || upper.includes('CHF') ||
                  upper.includes('CAD') || upper.includes('AUD') || upper.includes('NZD');
  
  if (isForex) {
    const forexRate = await fetchForexRate(symbol);
    if (forexRate && forexRate > 0) {
      console.log('[COMEX] Using real forex rate for', symbol, ':', forexRate);
      return {
        symbol,
        contractSymbol: symbol,
        lastPrice: forexRate,
        change: Number((forexRate - basePrice).toFixed(4)),
        changePercent: basePrice > 0 ? Number((((forexRate - basePrice) / basePrice) * 100).toFixed(2)) : 0,
        open: basePrice,
        high: Number((forexRate * 1.002).toFixed(4)),
        low: Number((forexRate * 0.998).toFixed(4)),
        close: basePrice,
        volume: 5000,
        currency: 'USD',
        name: symbol,
      };
    }
  }

  console.log('[COMEX] Using fallback base price for', symbol, ':', basePrice);
  return {
    symbol,
    contractSymbol: symbol,
    lastPrice: basePrice,
    change: 0,
    changePercent: 0,
    open: basePrice,
    high: Number((basePrice * 1.005).toFixed(2)),
    low: Number((basePrice * 0.995).toFixed(2)),
    close: basePrice,
    volume: 5000,
    currency: 'USD',
    name: symbol,
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols') ?? 'XAUUSD,XAGUSD,XTIUSD,XCUUSD,USDINR,EURINR,GBPINR,EURUSD,GBPUSD';
  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  try {
    const quotesList = await Promise.all(symbols.map(s => fetchComexQuote(s)));
    const quotes: Record<string, any> = {};
    for (const q of quotesList) {
      quotes[q.symbol] = q;
      
      // Also add with FOREX: prefix for forex symbols
      const upper = q.symbol.toUpperCase();
      if (upper.includes('USD') || upper.includes('EUR') || upper.includes('GBP') || 
          upper.includes('JPY') || upper.includes('CHF') || upper.includes('CAD') || 
          upper.includes('AUD') || upper.includes('NZD') || upper.includes('INR')) {
        quotes[`FOREX:${q.symbol}`] = q;
      }
    }

    return NextResponse.json({ quotes }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    console.error('[/api/market/comex] handler error:', err);
    return NextResponse.json({ error: 'Failed to fetch commodity/forex data' }, { status: 500 });
  }
}


