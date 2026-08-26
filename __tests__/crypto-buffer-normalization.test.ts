import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';
import { normalizeOptionQuoteDepth, calculateSyntheticOptionSpread } from '../lib/trading/quoteNormalization';
import { calculateBufferedPrice } from '../lib/trading/BufferCalculator';

describe('Crypto & Non-Indian Market Quote Buffering', () => {
  it('A. Resolves non-zero bid/ask synthetic spread for Crypto when askBuffer & bidBuffer are supplied', () => {
    const buySetting = { segment: 'CRYPTO', side: 'BUY', entry_buffer: 0.3, bid_buffer: 0.3 };
    const sellSetting = { segment: 'CRYPTO', side: 'SELL', entry_buffer: 0.3, bid_buffer: 0.3 };

    const askBuffer = buySetting.entry_buffer ?? buySetting.bid_buffer;
    const bidBuffer = sellSetting.entry_buffer ?? sellSetting.bid_buffer;

    const effective = resolveEffectivePrices({
      ltp: 2400.0,
      hasRealBidAsk: false,
      askBuffer,
      bidBuffer,
    });

    expect(effective.effectiveAsk).toBeGreaterThan(2400.0);
    expect(effective.effectiveBid).toBeLessThan(2400.0);
    expect(effective.effectiveAsk).toBe(2407.2);
    expect(effective.effectiveBid).toBe(2392.8);
  });

  it('B. normalizeOptionQuoteDepth generates synthetic spread for Crypto when forceSynthetic is true', () => {
    const ltp = 2402.04;
    const { bid, ask } = normalizeOptionQuoteDepth(ltp, ltp, ltp, {
      forceSynthetic: true,
      askBuffer: 0.3,
      bidBuffer: 0.3,
    });

    expect(ask).toBeGreaterThan(ltp);
    expect(bid).toBeLessThan(ltp);
    expect(ask).toBe(2409.25);
    expect(bid).toBe(2394.83);
  });

  it('C. Ignores ask/bid buffers for Indian market (Raw passthrough)', () => {
    const isIndianMarket = true;
    const askBuffer = isIndianMarket ? 0 : 0.3;
    const bidBuffer = isIndianMarket ? 0 : 0.3;

    const effective = resolveEffectivePrices({
      ltp: 2400.0,
      rawAsk: 2401.0,
      rawBid: 2399.0,
      hasRealBidAsk: true,
      askBuffer,
      bidBuffer,
    });

    expect(effective.effectiveAsk).toBe(2401.0);
    expect(effective.effectiveBid).toBe(2399.0);
  });

  it('D. Correctly scales various percentage buffer settings (0.08%, 0.5%, 1.0%, 8.0%) on ETH $2,500', () => {
    // 0.08% of 2500 is 2.0
    const eff008 = resolveEffectivePrices({ ltp: 2500, hasRealBidAsk: false, askBuffer: 0.08, bidBuffer: 0.08 });
    expect(eff008.effectiveAsk).toBe(2502);

    // 0.5% of 2500 is 12.5
    const eff05 = resolveEffectivePrices({ ltp: 2500, hasRealBidAsk: false, askBuffer: 0.5, bidBuffer: 0.5 });
    expect(eff05.effectiveAsk).toBe(2512.5);

    // 1.0% of 2500 is 25.0
    const eff10 = resolveEffectivePrices({ ltp: 2500, hasRealBidAsk: false, askBuffer: 1.0, bidBuffer: 1.0 });
    expect(eff10.effectiveAsk).toBe(2525);

    // 8.0% of 2500 is 200.0
    const eff80 = resolveEffectivePrices({ ltp: 2500, hasRealBidAsk: false, askBuffer: 8.0, bidBuffer: 8.0 });
    expect(eff80.effectiveAsk).toBe(2700);
  });

  it('E. Prevents double-buffering when basePrice is pre-resolved using isBasePriceRealBidAsk flag', () => {
    // Effective Ask for 0.3% buffer on 2500 is 2507.5
    const effectiveAsk = 2507.5;
    const buySetting = { entry_buffer: 0.3 };

    const fillPrice = calculateBufferedPrice({
      side: 'BUY',
      isExit: false,
      basePrice: effectiveAsk,
      buySetting,
      sellSetting: undefined,
      exitPriceModeOverride: 'BID_ASK',
      isBasePriceRealBidAsk: true,
    });

    // Should return exactly 2507.5 (NOT 2515.02)
    expect(fillPrice).toBe(2507.5);
  });

  it('F. Treats values >= 10 as percentages (e.g. 10 = 10%) instead of absolute points', () => {
    // 10% of 2500 is 250
    const eff10 = resolveEffectivePrices({ ltp: 2500, hasRealBidAsk: false, askBuffer: 10, bidBuffer: 10 });
    expect(eff10.effectiveAsk).toBe(2750);
    expect(eff10.effectiveBid).toBe(2250);
  });
});
