import { describe, it, expect } from 'vitest';
import { normalizeOptionQuoteDepth, calculateSyntheticOptionSpread } from '../lib/trading/quoteNormalization';

describe('Indian Commodities Synthetic Buffer Normalization', () => {
  it('A. MCX Gold Option raw depth (wide Zerodha spread) is replaced with synthetic spread when forceSynthetic is true', () => {
    // Raw depth has wide spread: Bid = 1923, Ask = 5024 around LTP = 2619
    const rawBid = 1923;
    const rawAsk = 5024;
    const ltp = 2619;

    const normalized = normalizeOptionQuoteDepth(ltp, rawBid, rawAsk, {
      forceSynthetic: true,
      askBuffer: 0,
      bidBuffer: 0,
      useSyntheticFallback: true,
    });

    // Should NOT return 1923 or 5024
    expect(normalized.bid).not.toBe(rawBid);
    expect(normalized.ask).not.toBe(rawAsk);

    // With 0 buffer, bid and ask equal LTP (2619)
    expect(normalized.bid).toBe(2619);
    expect(normalized.ask).toBe(2619);
  });

  it('B. MCX Silver Option with 0 raw depth and 0 buffers sets bid and ask equal to LTP', () => {
    const ltp = 650;
    const normalized = normalizeOptionQuoteDepth(ltp, 0, 0, {
      forceSynthetic: true,
      askBuffer: 0,
      bidBuffer: 0,
      useSyntheticFallback: true,
    });

    expect(normalized.bid).toBe(650);
    expect(normalized.ask).toBe(650);
  });

  it('C. Synthetic spread with custom buffer (0.3%) for MCX Crude Oil option', () => {
    const ltp = 5500;
    const synthetic = calculateSyntheticOptionSpread(ltp, 0.3, 0.3);

    // 0.3% of 5500 is 16.50
    expect(synthetic.bid).toBe(5483.5);
    expect(synthetic.ask).toBe(5516.5);
  });
});
