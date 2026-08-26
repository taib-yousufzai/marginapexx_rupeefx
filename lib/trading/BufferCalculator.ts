export interface BufferSettings {
  entry_buffer?: number;
  exit_buffer?: number;
  exit_price_mode?: 'BID_ASK' | 'LTP';
}

export interface BufferCalculationParams {
  side: 'BUY' | 'SELL';
  isExit: boolean;
  /**
   * Displayed Ask (for BUY) or Displayed Bid (for SELL).
   * In LTP mode    → Ask = LTP + LTP*bid_buffer%  |  Bid = LTP - LTP*bid_buffer%
   * In BID/ASK mode → Ask = RealAsk + LTP*bid_buffer%  |  Bid = RealBid - LTP*bid_buffer%
   * This is what the user SEES — entry/exit buffer is added on top and NOT shown.
   */
  basePrice: number;
  /**
   * Raw LTP from the exchange. Used as the base amount for entry/exit buffer calculation.
   * If omitted, falls back to basePrice (backward-compatible).
   */
  ltp?: number;
  buySetting: BufferSettings | undefined;
  sellSetting: BufferSettings | undefined;
  brokeragePerUnit?: number;
  exitPriceModeOverride?: 'BID_ASK' | 'LTP';
  /**
   * When true, basePrice is already the Displayed Ask/Bid (with bid_buffer applied).
   * Entry/Exit buffer will be added on top using LTP * buffer% as the amount.
   * When false, buffer is applied multiplicatively to basePrice (legacy LTP-only mode).
   */
  isBasePriceRealBidAsk?: boolean;
}

/**
 * Two-Layer Price Model
 * ─────────────────────
 *
 * Layer 1 – Display Price (what user SEES in TradeSheet / DetailSheet):
 *   LTP Mode    → Ask = LTP + LTP * bid_buffer%   |  Bid = LTP − LTP * bid_buffer%
 *   BID/ASK Mode → Ask = RealAsk + LTP * bid_buffer%  |  Bid = RealBid − LTP * bid_buffer%
 *
 * Layer 2 – Execution Price (HIDDEN from user, applied here):
 *   BUY  entry : Displayed Ask + LTP * entry_buffer%
 *   BUY  exit  : Displayed Ask + LTP * exit_buffer%   (buying back to close a SELL)
 *   SELL entry : Displayed Bid − LTP * entry_buffer%
 *   SELL exit  : Displayed Bid − LTP * exit_buffer%   (selling to close a BUY)
 */
export function calculateBufferedPrice({
  side,
  isExit,
  basePrice,
  ltp,
  buySetting,
  sellSetting,
  brokeragePerUnit = 0,
  exitPriceModeOverride,
  isBasePriceRealBidAsk = false,
}: BufferCalculationParams): number {
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw new Error('Invalid base price for buffer calculation');
  }

  // Admin enters 2 to mean 2%; values > 0.005 are treated as percentages and divided by 100.
  const toDecimalBuffer = (val: any, fallback: number) => {
    if (val === undefined || val === null || isNaN(Number(val))) return fallback;
    const num = Number(val);
    if (num === 0) return 0;
    return Math.abs(num) > 0.005 ? num / 100 : num;
  };

  const buyEntryBuffer  = toDecimalBuffer(buySetting?.entry_buffer, 0);
  const buyExitBuffer   = toDecimalBuffer(buySetting?.exit_buffer, 0);
  const sellEntryBuffer = toDecimalBuffer(sellSetting?.entry_buffer, 0);
  const sellExitBuffer  = toDecimalBuffer(sellSetting?.exit_buffer, 0);

  // LTP is used as the base for computing the buffer AMOUNT (not basePrice).
  // This separates the display spread (bid_buffer) from the execution slippage (entry/exit buffer).
  const ltpBase = (Number.isFinite(ltp) && ltp! > 0) ? ltp! : basePrice;

  if (isBasePriceRealBidAsk) {
    // basePrice = Displayed Ask (BUY) or Displayed Bid (SELL) — bid_buffer already applied.
    // Add entry/exit buffer as: ± LTP * buffer%
    //
    //   BUY  entry : Displayed Ask + LTP * entry_buffer%
    //   BUY  exit  : Displayed Ask + LTP * exit_buffer%
    //   SELL entry : Displayed Bid − LTP * entry_buffer%
    //   SELL exit  : Displayed Bid − LTP * exit_buffer%
    let executionPrice: number;
    if (side === 'BUY') {
      const buffer = isExit ? sellExitBuffer : buyEntryBuffer;
      executionPrice = basePrice + ltpBase * buffer + brokeragePerUnit;
    } else {
      const buffer = isExit ? buyExitBuffer : sellEntryBuffer;
      executionPrice = basePrice - ltpBase * buffer - brokeragePerUnit;
    }
    return Math.round(executionPrice * 10000) / 10000;
  }

  // Legacy / LTP-only mode: buffer applied multiplicatively to basePrice (which equals LTP here).
  let bufferedPrice: number;
  if (side === 'BUY') {
    const buffer = isExit ? sellExitBuffer : buyEntryBuffer;
    bufferedPrice = basePrice + ltpBase * buffer + brokeragePerUnit;
    // Strict rule: BUY must never execute below the base price
    bufferedPrice = Math.max(basePrice, bufferedPrice);
  } else {
    const buffer = isExit ? buyExitBuffer : sellEntryBuffer;
    bufferedPrice = basePrice - ltpBase * buffer - brokeragePerUnit;
    // Strict rule: SELL must never execute above the base price
    bufferedPrice = Math.min(basePrice, bufferedPrice);
  }

  return Math.round(bufferedPrice * 10000) / 10000;
}
