import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { buildSymbolInfo, getCanonicalSymbol } from '../lib/datafeed/symbolResolver';
import { fetchBars } from '../lib/datafeed/historyProvider';
import { RealtimeProvider } from '../lib/datafeed/realtimeProvider';
import { GET } from '../app/api/market/historical/route';

describe('Chart Pipeline Regression & Commodity Historical Data Audit', () => {
  const testCases = [
    { label: 'A. NSE Equity', sym: 'RELIANCE', seg: 'NSE', expectedExchange: 'NSE' },
    { label: 'B. GOLD CE', sym: 'GOLD26AUG162000CE', seg: 'MCX-OPT', expectedExchange: 'MCX' },
    { label: 'C. GOLD PE', sym: 'GOLD26AUG162000PE', seg: 'MCX-OPT', expectedExchange: 'MCX' },
    { label: 'D. GOLD Futures', sym: 'GOLD26OCTFUT', seg: 'MCX-FUT', expectedExchange: 'MCX' },
    { label: 'E. SILVER Futures', sym: 'SILVER26SEPFUT', seg: 'MCX-FUT', expectedExchange: 'MCX' },
    { label: 'F. CRUDEOIL Futures', sym: 'CRUDEOIL26SEPFUT', seg: 'MCX-FUT', expectedExchange: 'MCX' },
    { label: 'G. NATURALGAS Futures', sym: 'NATURALGAS26SEPFUT', seg: 'MCX-FUT', expectedExchange: 'MCX' },
  ];

  testCases.forEach(({ label, sym, seg, expectedExchange }) => {
    it(`${label}: resolves symbol and fetches valid historical OHLC candles`, async () => {
      const symInfo = buildSymbolInfo(sym, seg);
      expect(symInfo.ticker).toBeDefined();
      expect(symInfo.name).toBeDefined();
      expect(symInfo.description).toBeDefined();
      expect(symInfo.exchange).toBe(expectedExchange);
      expect(symInfo.listed_exchange).toBe(expectedExchange);
      expect(symInfo.type).toBe('stock');
      expect(symInfo.session).toBeDefined();
      expect(symInfo.timezone).toBe('Asia/Kolkata');
      expect(symInfo.pricescale).toBeGreaterThan(0);
      expect(symInfo.minmov).toBe(1);
      expect(symInfo.has_intraday).toBe(true);
      expect(symInfo.has_daily).toBe(true);
      expect(symInfo.data_status).toBe('streaming');

      // Test Backend Route Resolution
      const req = new Request(`http://localhost/api/market/historical?symbol=${encodeURIComponent(symInfo.ticker)}&interval=5minute`);
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeUndefined();
      expect(Array.isArray(json.candles)).toBe(true);
      expect(json.candles.length).toBeGreaterThan(0);

      const firstBar = json.candles[0];
      expect(firstBar.length).toBeGreaterThanOrEqual(5);
      expect(typeof firstBar[1]).toBe('number'); // open
      expect(typeof firstBar[2]).toBe('number'); // high
      expect(typeof firstBar[3]).toBe('number'); // low
      expect(typeof firstBar[4]).toBe('number'); // close
    }, 15000);
  });

  it('H. Invalid symbol fails cleanly without returning fake candles', async () => {
    const invalidSym = 'INVALID_NONEXISTENT_SYMBOL_9999';
    const symInfo = buildSymbolInfo(invalidSym, 'NSE');
    const req = new Request(`http://localhost/api/market/historical?symbol=${encodeURIComponent(symInfo.ticker)}&interval=5minute`);
    const res = await GET(req);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeDefined();
  }, 15000);

  it('I. RealtimeProvider correctly forwards ticks without cross-contaminating CE and PE', () => {
    const realtime = new RealtimeProvider();
    let ceTickReceived: any = null;
    let peTickReceived: any = null;

    realtime.subscribe('ce_sub', {
      symbol: 'MCX:GOLD26AUG162000CE',
      resolution: '5',
      callback: (bar) => { ceTickReceived = bar; }
    });

    realtime.subscribe('pe_sub', {
      symbol: 'MCX:GOLD26AUG162000PE',
      resolution: '5',
      callback: (bar) => { peTickReceived = bar; }
    });

    const now = Date.now();
    realtime.setLastBar('MCX:GOLD26AUG162000CE', '5', { time: now - 300000, open: 2400, high: 2450, low: 2390, close: 2410 });
    realtime.setLastBar('MCX:GOLD26AUG162000PE', '5', { time: now - 300000, open: 2600, high: 2650, low: 2590, close: 2610 });

    realtime.update('MCX:GOLD26AUG162000CE', 2420, now, 10);
    expect(ceTickReceived).toBeDefined();
    expect(ceTickReceived.close).toBe(2420);
    expect(peTickReceived?.close).not.toBe(2420);
  });
});
