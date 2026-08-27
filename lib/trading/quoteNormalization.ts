/**
 * Calculates synthetic Bid and Ask prices around Last Traded Price (LTP)
 * using segment buffers (identical to the Crypto pricing model).
 *
 * Effective Ask = LTP + askBuffer
 * Effective Bid = max(0.05, LTP - bidBuffer)
 */
export function calculateSyntheticOptionSpread(
  ltp: number,
  askBuffer: number = 0,
  bidBuffer: number = 0
): { bid: number; ask: number } {
  if (!ltp || ltp <= 0) return { bid: 0, ask: 0 };

  const getBufferAmount = (buf: number): number => {
    if (!buf || buf <= 0) {
      return 0; // When buffer is 0, bid and ask equal LTP (no artificial spread)
    }
    if (buf >= 1) {
      return buf; // Absolute points if >= 1
    }
    // Percentage buffer (e.g., 0.3 => 0.3%, 0.08 => 0.08%, 0.03 => 0.03%)
    const pct = buf > 0.005 ? buf / 100 : buf;
    return Math.max(0.05, Math.round(ltp * pct * 100) / 100);
  };

  const aBuf = getBufferAmount(askBuffer);
  const bBuf = getBufferAmount(bidBuffer);

  const ask = Math.round((ltp + aBuf) * 100) / 100;
  const bid = Math.max(0.05, Math.round((ltp - bBuf) * 100) / 100);

  return { bid, ask };
}

/**
 * Normalizes option contract depth (Bid / Ask) against Last Traded Price (LTP)
 * or generates synthetic Crypto-style depth derived strictly from LTP.
 */
export function normalizeOptionQuoteDepth(
  ltp: number,
  rawBid: number,
  rawAsk: number,
  options?: {
    askBuffer?: number;
    bidBuffer?: number;
    useSyntheticFallback?: boolean;
    forceSynthetic?: boolean;
  }
): { bid: number; ask: number } {
  const askBuffer = options?.askBuffer ?? 0;
  const bidBuffer = options?.bidBuffer ?? 0;
  const forceSynthetic = options?.forceSynthetic ?? true;

  // If no LTP, return raw values (or 0)
  if (!ltp || ltp <= 0) return { bid: rawBid > 0 ? rawBid : 0, ask: rawAsk > 0 ? rawAsk : 0 };

  // When forceSynthetic is true, generate synthetic Bid & Ask derived strictly from LTP
  if (forceSynthetic) {
    return calculateSyntheticOptionSpread(ltp, askBuffer, bidBuffer);
  }

  // If depth is missing (0 / 0), generate synthetic Crypto-style Bid/Ask from LTP if fallback enabled
  if ((!rawBid || rawBid <= 0) && (!rawAsk || rawAsk <= 0)) {
    if (options?.useSyntheticFallback ?? true) {
      return calculateSyntheticOptionSpread(ltp, askBuffer, bidBuffer);
    }
    return { bid: 0, ask: 0 };
  }

  let bid = rawBid > 0 ? rawBid : 0;
  let ask = rawAsk > 0 ? rawAsk : 0;

  // 1. If LTP is strictly within a balanced, valid exchange spread (bid <= ltp <= ask),
  //    and the ask is not disproportionately stale relative to the bid-to-ltp distance:
  if (bid > 0 && ask > 0 && bid <= ltp && ltp <= ask) {
    const bidDistance = ltp - bid;
    const askDistance = ask - ltp;

    const maxReasonableAskDistance = Math.max(bidDistance * 3, 50);
    if (askDistance <= maxReasonableAskDistance) {
      return { bid, ask };
    }
  }

  // Pass-through the raw bid/ask, only filling missing sides from LTP.
  // Do NOT override valid spread data (e.g. ask > ltp is normal for futures).
  if (ask <= 0) {
    ask = ask > 0 ? ask : Math.round((ltp + askBuffer) * 100) / 100;
  }
  if (bid <= 0) {
    bid = Math.max(0.05, Math.round((ltp - bidBuffer) * 100) / 100);
  }
  // Clamp: bid should not exceed ltp (stale depth edge case)
  if (bid > ltp) bid = ltp;

  // Preserve Bid <= Ask invariant:
  if (bid > 0 && ask > 0 && bid > ask) {
    ask = bid;
  }

  return { bid, ask };
}
