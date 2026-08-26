export interface BufferSettings {
  entry_buffer?: number;
  exit_buffer?: number;
  exit_price_mode?: 'BID_ASK' | 'LTP';
}

export interface BufferCalculationParams {
  side: 'BUY' | 'SELL';
  isExit: boolean;
  basePrice: number;
  buySetting: BufferSettings | undefined;
  sellSetting: BufferSettings | undefined;
  brokeragePerUnit?: number;
  exitPriceMode?: 'BID_ASK' | 'LTP';
  isBasePriceRealBidAsk?: boolean;
}

/**
 * Calculates the execution price after applying entry/exit buffers.
 *
 * Execution Rules based on price mode (BID_ASK vs LTP):
 *
 * Mode = BID_ASK (Default):
 *   - Fresh BUY Entry  : ASK price (base * 1.001) * (1 + buyEntryBuffer)
 *   - Fresh SELL Entry : BID price (base * 0.999) * (1 - sellEntryBuffer)
 *   - BUY Exit (Close) : ASK price (base * 1.001) * (1 + sellExitBuffer)
 *   - SELL Exit (Close): BID price (base * 0.999) * (1 - buyExitBuffer)
 *
 * Mode = LTP:
 *   - Fresh BUY Entry  : raw LTP (base) * (1 + buyEntryBuffer)
 *   - Fresh SELL Entry : raw LTP (base) * (1 - sellEntryBuffer)
 *   - BUY Exit (Close) : raw LTP (base) * (1 + sellExitBuffer)
 *   - SELL Exit (Close): raw LTP (base) * (1 - buyExitBuffer)
 */
export function calculateBufferedPrice({
  side,
  isExit,
  basePrice,
  buySetting,
  sellSetting,
  brokeragePerUnit = 0,
  exitPriceMode,
  isBasePriceRealBidAsk = false,
}: BufferCalculationParams): number {
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw new Error('Invalid base price for buffer calculation');
  }

  const toDecimalBuffer = (val: any, fallback: number) => {
    if (val === undefined || val === null || isNaN(Number(val))) return fallback;
    const num = Number(val);
    if (num === 0) return 0;
    return num > 0.005 ? num / 100 : num;
  };

  const buyEntryBuffer  = toDecimalBuffer(buySetting?.entry_buffer, 0);
  const buyExitBuffer   = toDecimalBuffer(buySetting?.exit_buffer, 0);
  const sellEntryBuffer = toDecimalBuffer(sellSetting?.entry_buffer, 0);
  const sellExitBuffer  = toDecimalBuffer(sellSetting?.exit_buffer, 0);

  const activeSetting = side === 'BUY' ? buySetting : sellSetting;
  const mode = exitPriceMode || activeSetting?.exit_price_mode || buySetting?.exit_price_mode || sellSetting?.exit_price_mode || 'BID_ASK';

  if (isBasePriceRealBidAsk) {
    // When basePrice is ALREADY the Effective Ask/Bid resolved from raw market quotes or resolveEffectivePrices,
    // it ALREADY contains the execution spread/buffer. Do NOT apply entry/exit buffer markup on top.
    const priceWithBrokerage = side === 'BUY'
      ? basePrice + brokeragePerUnit
      : basePrice - brokeragePerUnit;
    return Math.round(priceWithBrokerage * 10000) / 10000;
  }

  let bufferedPrice: number;

  if (side === 'BUY') {
    const buffer = isExit ? sellExitBuffer : buyEntryBuffer;
    bufferedPrice = basePrice * (1 + buffer) + brokeragePerUnit;
    // Strict Execution Rule: BUY must never execute below Effective Ask (basePrice)
    bufferedPrice = Math.max(basePrice, bufferedPrice);
  } else {
    // side === 'SELL'
    const buffer = isExit ? buyExitBuffer : sellEntryBuffer;
    bufferedPrice = basePrice * (1 - buffer) - brokeragePerUnit;
    // Strict Execution Rule: SELL must never execute above Effective Bid (basePrice)
    bufferedPrice = Math.min(basePrice, bufferedPrice);
  }

  return Math.round(bufferedPrice * 10000) / 10000;
}
