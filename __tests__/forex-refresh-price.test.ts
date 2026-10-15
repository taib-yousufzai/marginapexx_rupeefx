import { describe, it, expect } from 'vitest';
import { getUSStockBasePrice, FOREX_BASE_PRICES } from '../lib/datafeed/USStockService';
import { generateRealisticFallbackQuote } from '../lib/quoteFallback';
import { GET } from '../app/api/market/comex/route';

describe('Forex Price Resolution & Refresh Regression Test', () => {
  const forexSymbols = [
    'GBPUSD',
    'GBPUSD=X',
    'EURUSD',
    'EURUSD=X',
    'USDJPY',
    'USDJPY=X',
    'USDCHF',
    'USDCHF=X',
    'USDCAD',
    'USDCAD=X',
    'AUDUSD',
    'AUDUSD=X',
    'NZDUSD',
    'NZDUSD=X',
    'USDINR',
    'CDS:USDINR26OCTFUT',
    'EURINR',
    'CDS:EURINR26OCTFUT',
    'GBPINR',
    'CDS:GBPINR26OCTFUT',
    'JPYINR',
    'CDS:JPYINR26OCTFUT',
  ];

  it('getUSStockBasePrice returns realistic forex prices and NEVER 100 for any forex pair', () => {
    for (const sym of forexSymbols) {
      const base = getUSStockBasePrice(sym);
      expect(base).not.toBe(100);
      expect(base).toBeGreaterThan(0);
      if (sym.includes('JPY') && !sym.includes('INR')) {
        expect(base).toBeGreaterThan(100); // USDJPY is ~150
      } else if (sym.includes('INR') && !sym.includes('JPY')) {
        expect(base).toBeGreaterThan(50); // USDINR/EURINR/GBPINR
      } else if (sym.includes('JPYINR')) {
        expect(base).toBeLessThan(1); // JPYINR is ~0.62
      } else {
        expect(base).toBeLessThan(10); // Normal FX pairs like EURUSD, GBPUSD < 10
      }
    }
  });

  it('generateRealisticFallbackQuote returns correct forex base prices and never defaults to 100 or stock hash', () => {
    const gbp = generateRealisticFallbackQuote('GBPUSD=X');
    expect(gbp.last_price).toBeCloseTo(1.3523, 2);
    expect(gbp.last_price).not.toBe(100);

    const eur = generateRealisticFallbackQuote('EURUSD=X');
    expect(eur.last_price).toBeCloseTo(1.1597, 2);
    expect(eur.last_price).not.toBe(100);

    const jpy = generateRealisticFallbackQuote('USDJPY=X');
    expect(jpy.last_price).toBeCloseTo(153.61, 1);
    expect(jpy.last_price).not.toBe(100);
  });

  it('/api/market/comex GET route returns valid forex quotes and never 100 upon refresh', async () => {
    const req = new Request('http://localhost/api/market/comex?symbols=GBPUSD=X,EURUSD=X,USDJPY=X,USDCHF=X,USDCAD=X,AUDUSD=X,NZDUSD=X');
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.quotes).toBeDefined();

    for (const [sym, q] of Object.entries(data.quotes as Record<string, any>)) {
      if (sym.includes('JPY') && !sym.includes('INR')) {
        // USDJPY is ~150, but definitely not the fallback 100
        expect(q.lastPrice).not.toBe(100);
      } else if (['GBPUSD', 'EURUSD', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'].some(x => sym.includes(x))) {
        expect(q.lastPrice).toBeLessThan(10);
        expect(q.lastPrice).not.toBe(100);
      }
    }
  });
});
