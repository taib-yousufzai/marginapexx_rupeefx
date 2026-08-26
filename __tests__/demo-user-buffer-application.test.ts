import { describe, it, expect } from 'vitest';
import { resolveEffectivePrices } from '../lib/trading/marketPriceResolver';
import { calculateBufferedPrice } from '../lib/trading/BufferCalculator';

describe('Demo User Buffer Application & Audit Verification', () => {
  it('A. Resolves effective prices using entry_buffer for BUY side (Ask Buffer)', () => {
    // Demo user settings in DB for INDEX-OPT BUY: entry_buffer = 0.2, bid_buffer = 0
    const buySetting = { segment: 'INDEX-OPT', side: 'BUY', entry_buffer: 0.2, bid_buffer: 0, exit_buffer: 0.1 };
    const sellSetting = { segment: 'INDEX-OPT', side: 'SELL', entry_buffer: 0.4, bid_buffer: 0, exit_buffer: 0.2 };

    const askBuffer = buySetting.entry_buffer ?? buySetting.bid_buffer ?? 0;
    const bidBuffer = sellSetting.entry_buffer ?? sellSetting.bid_buffer ?? 0;

    const effective = resolveEffectivePrices({
      ltp: 100,
      hasRealBidAsk: false,
      askBuffer,
      bidBuffer,
    });

    expect(effective.effectiveAsk).toBe(100.2); // 100 + 0.2
    expect(effective.effectiveBid).toBe(99.6);  // 100 - 0.4
  });

  it('B. Calculates fill price for MARKET BUY order using entry_buffer markup', () => {
    const buySetting = { segment: 'INDEX-OPT', side: 'BUY', entry_buffer: 0.2, exit_buffer: 0.1 };
    const sellSetting = { segment: 'INDEX-OPT', side: 'SELL', entry_buffer: 0.4, exit_buffer: 0.2 };

    const fillPrice = calculateBufferedPrice({
      side: 'BUY',
      isExit: false,
      basePrice: 200,
      buySetting,
      sellSetting,
    });

    // 200 * (1 + 0.002) = 200.4
    expect(fillPrice).toBe(200.4);
  });

  it('C. Calculates fill price for MARKET SELL order using entry_buffer markdown', () => {
    const buySetting = { segment: 'INDEX-OPT', side: 'BUY', entry_buffer: 0.2, exit_buffer: 0.1 };
    const sellSetting = { segment: 'INDEX-OPT', side: 'SELL', entry_buffer: 0.4, exit_buffer: 0.2 };

    const fillPrice = calculateBufferedPrice({
      side: 'SELL',
      isExit: false,
      basePrice: 200,
      buySetting,
      sellSetting,
    });

    // 200 * (1 - 0.004) = 199.2
    expect(fillPrice).toBe(199.2);
  });

  it('D. Validates percentage-style decimal conversion for values > 0.005 (e.g. 0.3 -> 0.003 multiplier)', () => {
    const buySetting = { entry_buffer: 0.3, exit_buffer: 0.17 };
    const sellSetting = { entry_buffer: 0.3, exit_buffer: 0.17 };

    const fillPrice = calculateBufferedPrice({
      side: 'BUY',
      isExit: false,
      basePrice: 1000,
      buySetting,
      sellSetting,
      exitPriceModeOverride: 'LTP',
    });

    // 1000 * (1 + 0.003) = 1003
    expect(fillPrice).toBe(1003);
  });
});
