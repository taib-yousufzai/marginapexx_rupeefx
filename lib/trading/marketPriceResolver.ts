export interface MarketPriceInput {
  ltp: number;
  rawBid?: number | null;
  rawAsk?: number | null;
  hasRealBidAsk?: boolean;
  askBuffer?: number;
  bidBuffer?: number;
}

export interface EffectivePrices {
  effectiveAsk: number;
  effectiveBid: number;
  hasRealBidAsk: boolean;
}

/**
 * Normalizes buffer values into a decimal fraction multiplier.
 * e.g. 0.3 (0.3%) -> 0.003, 0.003 (already fraction) -> 0.003
 */
function toDecimalBuffer(val: number | undefined | null): number {
  if (val === undefined || val === null || isNaN(Number(val))) return 0;
  const num = Number(val);
  if (num === 0) return 0;
  return num > 0.005 ? num / 100 : num;
}

/**
 * Resolves the Effective Ask and Effective Bid prices according to explicit market feed type.
 *
 * Zerodha / Real Feed (with real bid & ask):
 *   Effective Ask = Zerodha Ask + askBuffer
 *   Effective Bid = Zerodha Bid - bidBuffer
 *
 * Crypto / Synthetic Feed (where data feed has no real bid/ask):
 *   Effective Ask = LTP * (1 + askBufferPct)
 *   Effective Bid = LTP * (1 - bidBufferPct)
 */
export function resolveEffectivePrices({
  ltp,
  rawBid,
  rawAsk,
  hasRealBidAsk = false,
  askBuffer = 0,
  bidBuffer = 0,
}: MarketPriceInput): EffectivePrices {
  const baseLtp = Number.isFinite(Number(ltp)) && Number(ltp) > 0 ? Number(ltp) : 0;

  const validRealSpread =
    hasRealBidAsk &&
    rawBid !== undefined &&
    rawBid !== null &&
    rawAsk !== undefined &&
    rawAsk !== null &&
    Number(rawBid) > 0 &&
    Number(rawAsk) > 0 &&
    Number(rawBid) < Number(rawAsk);

  let effectiveAsk: number;
  let effectiveBid: number;

  const askVal = Number(askBuffer) || 0;
  const bidVal = Number(bidBuffer) || 0;

  // Handle percentage buffers (e.g. 0.3 for 0.3%, 10 for 10%, 0.003 ratio)
  const getBufferAmount = (val: number, basePrice: number) => {
    if (!val || val <= 0) return 0;
    const pct = val > 0.005 ? val / 100 : val;
    return basePrice * pct;
  };

  if (validRealSpread) {
    // Real orderbook spread feed: apply % buffer on top of real ask/bid
    effectiveAsk = Number(rawAsk) + getBufferAmount(askVal, Number(rawAsk));
    effectiveBid = Number(rawBid) - getBufferAmount(bidVal, Number(rawBid));
  } else {
    // Synthetic spread feed: apply % buffer on top of LTP
    effectiveAsk = baseLtp + getBufferAmount(askVal, baseLtp);
    effectiveBid = baseLtp - getBufferAmount(bidVal, baseLtp);
  }

  return {
    effectiveAsk: Math.round(effectiveAsk * 10000) / 10000,
    effectiveBid: Math.round(effectiveBid * 10000) / 10000,
    hasRealBidAsk: Boolean(validRealSpread),
  };
}

