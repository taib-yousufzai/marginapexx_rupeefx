import { describe, it, expect } from 'vitest';
import { getTabForItem, getExchangeBadge, WatchlistItem } from '../app/watchlist/page';
import { mapSegmentWithSymbol, mapSymbolToSegment } from '../lib/trading/SymbolMapping';

describe('Instrument Segment and Tab Categorization Audit', () => {
  it('correctly classifies ADANIPORTS stock options as STOCK-OPT and NOT CRYPTO', () => {
    const item: WatchlistItem = {
      name: 'ADANIPORTS 900 CE',
      symbol: 'ADANIPORTS26AUG900CE',
      kiteSymbol: 'NFO:ADANIPORTS26AUG900CE',
      price: 0,
      change: '0%',
      segment: 'NFO - Stock Options',
      contractDate: '2026-08-27',
      open: 0, high: 0, low: 0, close: 0
    };

    expect(getTabForItem(item)).toBe('STOCK-OPT');
    expect(mapSegmentWithSymbol(item.segment, item.symbol)).toBe('STOCK-OPT');
    expect(mapSymbolToSegment(item.symbol)).toBe('STOCK-OPT');
    expect(getExchangeBadge(item.segment, item.name, item.symbol)).toBe('STOCK-OPT');
  });

  it('correctly classifies HCLTECH stock options as STOCK-OPT', () => {
    const item: WatchlistItem = {
      name: 'HCLTECH 900 CE',
      symbol: 'HCLTECH26AUG900CE',
      kiteSymbol: 'NFO:HCLTECH26AUG900CE',
      price: 0,
      change: '0%',
      segment: 'NFO - Stock Options',
      contractDate: '2026-08-27',
      open: 0, high: 0, low: 0, close: 0
    };

    expect(getTabForItem(item)).toBe('STOCK-OPT');
    expect(mapSegmentWithSymbol(item.segment, item.symbol)).toBe('STOCK-OPT');
    expect(mapSymbolToSegment(item.symbol)).toBe('STOCK-OPT');
    expect(getExchangeBadge(item.segment, item.name, item.symbol)).toBe('STOCK-OPT');
  });

  it('correctly classifies unmapped stock option fallbacks', () => {
    const unmappedAdani: WatchlistItem = {
      name: 'ADANIPORTS 900 CE',
      symbol: 'ADANIPORTS 900 CE',
      kiteSymbol: 'NFO:ADANIPORTS 900 CE',
      price: 0,
      change: '0%',
      segment: '',
      contractDate: '',
      open: 0, high: 0, low: 0, close: 0
    };

    const unmappedHcl: WatchlistItem = {
      name: 'HCLTECH 920 CE',
      symbol: 'HCLTECH 920 CE',
      kiteSymbol: 'NFO:HCLTECH 920 CE',
      price: 0,
      change: '0%',
      segment: '',
      contractDate: '',
      open: 0, high: 0, low: 0, close: 0
    };

    expect(getTabForItem(unmappedAdani)).toBe('STOCK-OPT');
    expect(getTabForItem(unmappedHcl)).toBe('STOCK-OPT');
    expect(getExchangeBadge(unmappedAdani.segment, unmappedAdani.name, unmappedAdani.symbol)).toBe('STOCK-OPT');
    expect(getExchangeBadge(unmappedHcl.segment, unmappedHcl.name, unmappedHcl.symbol)).toBe('STOCK-OPT');
  });

  it('correctly preserves CRYPTO classification for real crypto symbols', () => {
    const btc: WatchlistItem = {
      name: 'BTCUSDT',
      symbol: 'BTCUSDT',
      kiteSymbol: 'CRYPTO:BTCUSDT',
      price: 0,
      change: '0%',
      segment: 'CRYPTO',
      contractDate: '',
      open: 0, high: 0, low: 0, close: 0
    };

    const ada: WatchlistItem = {
      name: 'ADA',
      symbol: 'ADA',
      kiteSymbol: 'CRYPTO:ADA',
      price: 0,
      change: '0%',
      segment: 'CRYPTO',
      contractDate: '',
      open: 0, high: 0, low: 0, close: 0
    };

    expect(getTabForItem(btc)).toBe('CRYPTO');
    expect(getTabForItem(ada)).toBe('CRYPTO');
    expect(getExchangeBadge(btc.segment, btc.name, btc.symbol)).toBe('CRYPTO');
    expect(getExchangeBadge(ada.segment, ada.name, ada.symbol)).toBe('CRYPTO');
  });

  it('correctly classifies equity items under STOCKS tab', () => {
    const reliance: WatchlistItem = {
      name: 'RELIANCE',
      symbol: 'RELIANCE_EQ',
      kiteSymbol: 'NSE:RELIANCE',
      price: 0,
      change: '0%',
      segment: 'NSE - Equity',
      contractDate: '',
      open: 0, high: 0, low: 0, close: 0
    };

    expect(getTabForItem(reliance)).toBe('STOCKS');
    expect(getExchangeBadge(reliance.segment, reliance.name, reliance.symbol)).toBe('NSE');
  });
});
