import { describe, it, expect } from 'vitest';
import { normalizeOptionQuoteDepth, calculateSyntheticOptionSpread } from '../lib/trading/quoteNormalization';

describe('Option Quote Depth Normalization (B/A Mode)', () => {
  it('A. LTP inside spread with stale high Ask -> clamps Ask to LTP when raw depth enabled', () => {
    const result = normalizeOptionQuoteDepth(2724, 2713, 2857, { forceSynthetic: false, useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2713, ask: 2724 });
  });

  it('B. LTP exactly at Ask -> preserves valid depth when raw depth enabled', () => {
    const result = normalizeOptionQuoteDepth(2724, 2713, 2724, { forceSynthetic: false, useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2713, ask: 2724 });
  });

  it('C. LTP above Ask -> normalizes stale Ask to LTP when raw depth enabled', () => {
    const result = normalizeOptionQuoteDepth(2724, 2600, 2700, { forceSynthetic: false, useSyntheticFallback: false });
    expect(result.ask).toBe(2724);
    expect(result.bid).toBeLessThanOrEqual(result.ask);
    expect(2724).toBeGreaterThanOrEqual(result.ask);
  });

  it('D. LTP below Bid -> normalizes stale Bid and Ask to LTP when raw depth enabled', () => {
    const result = normalizeOptionQuoteDepth(2724, 2800, 2900, { forceSynthetic: false, useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2724, ask: 2724 });
  });

  it('E. Valid quote with balanced spread -> preserved unchanged when raw depth enabled', () => {
    const result = normalizeOptionQuoteDepth(2724, 2700, 2750, { forceSynthetic: false, useSyntheticFallback: false });
    expect(result).toEqual({ bid: 2700, ask: 2750 });
  });

  it('F. Synthetic spread generation from LTP with 0 buffers -> bid and ask equal LTP', () => {
    const synthetic = calculateSyntheticOptionSpread(2724, 0, 0);
    expect(synthetic).toEqual({ bid: 2724, ask: 2724 });
  });

  it('G. Synthetic Crypto-style spread generation from LTP with 0.3 buffers', () => {
    const synthetic = calculateSyntheticOptionSpread(2724, 0.3, 0.3);
    expect(synthetic.bid).toBeLessThan(2724);
    expect(synthetic.ask).toBeGreaterThan(2724);
    expect(synthetic).toEqual({ bid: 2715.83, ask: 2732.17 });
  });

  it('H. Default option normalization with 0 buffers -> bid and ask equal LTP', () => {
    const result = normalizeOptionQuoteDepth(2724, 1179.0, 3228.5, { askBuffer: 0, bidBuffer: 0, forceSynthetic: true });
    expect(result).toEqual({ bid: 2724, ask: 2724 });
  });
});
