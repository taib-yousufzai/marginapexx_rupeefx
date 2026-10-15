import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FOREX_BASE_PRICES: Record<string, number> = {
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
};

/**
 * Fetch real-time forex rate from exchange rate API
 */
async function fetchForexRate(symbol: string): Promise<{ price: number; source: string } | null> {
  try {
    const clean = symbol.replace(/^(FOREX:|CDS:|COMEX:)/i, '').replace(/[\/\s]/g, '').toUpperCase();
    console.log('[FOREX-API] Fetching rate for:', clean);

    // For INR pairs (USDINR, EURINR, GBPINR, etc)
    if (clean.includes('INR')) {
      const baseCurrency = clean.replace('INR', '').trim();
      if (baseCurrency && baseCurrency.length === 3) {
        try {
          const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${baseCurrency}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(4000),
          });
          if (res.ok) {
            const data = await res.json();
            const rate = data.rates?.INR;
            if (rate > 0) {
              console.log('[FOREX-API] ✅ Got rate for', clean, ':', rate, '(from ExchangeRate API)');
              return { price: rate, source: 'exchangerate-api' };
            }
          }
        } catch (err) {
          console.warn('[FOREX-API] ExchangeRate API failed for', baseCurrency, ':', err);
        }
      }
    }

    // For XXX/USD pairs (EURUSD, GBPUSD, AUDUSD, etc)
    if (clean.length === 6 && clean.endsWith('USD') && !clean.startsWith('USD')) {
      const baseCurrency = clean.substring(0, 3);
      try {
        const res = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = await res.json();
          const usdRate = data.rates?.[baseCurrency];
          if (usdRate > 0) {
            // Convert USD->XXX to XXX->USD (inverse)
            const forexRate = Number((1 / usdRate).toFixed(5));
            console.log('[FOREX-API] ✅ Got rate for', clean, ':', forexRate, '(calculated from USD rates)');
            return { price: forexRate, source: 'exchangerate-api-calculated' };
          }
        }
      } catch (err) {
        console.warn('[FOREX-API] ExchangeRate calculation failed for', clean, ':', err);
      }
    }

    // For USD/XXX pairs (USDJPY, USDCHF, USDCAD, etc)
    if (clean.length === 6 && clean.startsWith('USD') && !clean.endsWith('USD')) {
      const targetCurrency = clean.substring(3);
      try {
        const res = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = await res.json();
          const rate = data.rates?.[targetCurrency];
          if (rate > 0) {
            console.log('[FOREX-API] ✅ Got rate for', clean, ':', rate, '(from ExchangeRate API)');
            return { price: rate, source: 'exchangerate-api' };
          }
        }
      } catch (err) {
        console.warn('[FOREX-API] ExchangeRate API failed for', clean, ':', err);
      }
    }

    console.log('[FOREX-API] ⚠️ No live rate found for', clean, ', using base price');
    return null;
  } catch (err) {
    console.error('[FOREX-API] Error fetching forex rate:', err);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols') ?? 'EURUSD,GBPUSD,USDINR';
  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  console.log('[FOREX-API] Request for symbols:', symbols);

  try {
    const quotes: Record<string, any> = {};
    
    // Filter to ONLY process actual forex pairs (not crypto/futures that backend WS handles)
    const forexOnlySymbols = symbols.filter(sym => {
      const clean = sym.replace(/^(FOREX:|CDS:|COMEX:)/i, '').replace(/[\/\s]/g, '').toUpperCase();
      // Skip crypto (BTCUSDT, ETHUSDT, etc) and futures with dates (EURINR26SEPFUT)
      if (clean.includes('USDT') || clean.includes('BTC') || clean.includes('ETH') || clean.includes('DOGE')) {
        console.log('[FOREX-API] ⏭️ Skipping crypto:', clean, '(backend WS handles this)');
        return false;
      }
      if (/\d{2}[A-Z]{3}FUT/.test(clean)) {
        console.log('[FOREX-API] ⏭️ Skipping futures contract:', clean, '(backend WS handles this)');
        return false;
      }
      return true;
    });

    console.log('[FOREX-API] Processing', forexOnlySymbols.length, 'forex symbols out of', symbols.length, 'total');
    
    // Fetch all forex symbols in parallel
    const results = await Promise.allSettled(
      forexOnlySymbols.map(async (sym) => {
        const clean = sym.replace(/^(FOREX:|CDS:|COMEX:)/i, '').replace(/[\/\s]/g, '').toUpperCase();
        const basePrice = FOREX_BASE_PRICES[clean] || 100;
        
        const liveRate = await fetchForexRate(sym);
        
        const price = liveRate?.price ?? basePrice;
        const isLive = Boolean(liveRate);
        
        return {
          symbol: sym,
          clean,
          quote: {
            symbol: sym,
            lastPrice: price,
            price: price,
            bid: price,
            ask: price,
            open: basePrice,
            high: Number((price * 1.002).toFixed(5)),
            low: Number((price * 0.998).toFixed(5)),
            close: basePrice,
            prevClose: basePrice,
            change: Number((price - basePrice).toFixed(5)),
            changePercent: basePrice > 0 ? Number((((price - basePrice) / basePrice) * 100).toFixed(2)) : 0,
            volume: 10000,
            time: Date.now(),
            isLive,
            source: liveRate?.source || 'fallback',
          }
        };
      })
    );

    // Process results
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        const { symbol, clean, quote } = result.value;
        quotes[symbol] = quote;
        quotes[clean] = quote;
        quotes[`FOREX:${clean}`] = quote;
        quotes[`CDS:${clean}`] = quote;
      }
    });

    console.log('[FOREX-API] ✅ Returning', Object.keys(quotes).length, 'quotes');

    return NextResponse.json({ 
      success: true,
      quotes 
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err) {
    console.error('[FOREX-API] Handler error:', err);
    return NextResponse.json({ 
      success: false,
      error: 'Failed to fetch forex data',
      quotes: {}
    }, { status: 500 });
  }
}
