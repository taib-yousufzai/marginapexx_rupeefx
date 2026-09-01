import { parseOptionSymbol } from '../../lib/positionStore';
import { resolveEffectivePrices } from './marketPriceResolver';
import { calculateBufferedPrice } from './BufferCalculator';

export class OrderService {
  /**
   * Validates Limit price constraints relative to LTP
   */
  static validateLimitPrice(orderType: string, side: 'BUY' | 'SELL', clientPrice: number, baseLtp: number, isExit: boolean): string | null {
    if (orderType === 'LIMIT') {
      if (side === 'BUY' && clientPrice >= baseLtp) {
        return 'Limit price must be lower than the current market price (LTP).';
      }
      if (side === 'SELL' && clientPrice <= baseLtp) {
        return 'Limit price must be higher than the current market price (LTP).';
      }
    } else if (orderType === 'GTT' && !isExit) {
      if (!clientPrice || isNaN(clientPrice) || clientPrice <= 0) {
        return side === 'BUY'
          ? 'Limit price is required for a GTT Buy order.'
          : 'Limit price is required for a GTT Sell order.';
      }
      if (side === 'BUY' && clientPrice > baseLtp) {
        return 'Limit price must be lower than or equal to the current market price (LTP).';
      }
      if (side === 'SELL' && clientPrice < baseLtp) {
        return 'Limit price must be higher than or equal to the current market price (LTP).';
      }
    }
    return null;
  }

  /**
   * Validates SL and SLM trigger price constraints relative to LTP.
   *
   * Exit SL orders: trigger must be on the loss side of LTP (cut the position).
   * Entry SLM orders: trigger is the stop-loss price for the new position, so it
   *   must be on the same loss side as an existing SL would be.
   * Entry SL orders: pending breakout orders — trigger must be above LTP for BUY
   *   (buy the breakout) and below LTP for SELL (sell the breakdown).
   */
  static validateStopLoss(orderType: string, side: 'BUY' | 'SELL', triggerPrice: number | null, baseLtp: number, isExit: boolean): string | null {
    if ((orderType === 'SL' || orderType === 'SLM') && triggerPrice !== null && !isNaN(triggerPrice)) {
      if (isExit) {
        if (side === 'SELL' && triggerPrice >= baseLtp) {
          return 'Trigger price must be lower than current market price (LTP) for BUY position exit SL/SLM.';
        }
        if (side === 'BUY' && triggerPrice <= baseLtp) {
          return 'Trigger price must be higher than current market price (LTP) for SELL position exit SL/SLM.';
        }
      } else {
        if (side === 'BUY' && triggerPrice >= baseLtp) {
          return 'Trigger price must be lower than current market price (LTP) for BUY SL/SLM.';
        }
        if (side === 'SELL' && triggerPrice <= baseLtp) {
          return 'Trigger price must be higher than current market price (LTP) for SELL SL/SLM.';
        }
      }
    }
    return null;
  }

  /**
   * Validates Target and Stop Loss rules on entry and exit.
   */
  static validateTargetAndStopLoss(
    isExit: boolean,
    isLong: boolean,
    orderTarget: number | null,
    orderSL: number | null,
    baseLtp: number,
    clientPrice: number,
    hasLimitPrice: boolean
  ): string | null {
    if (isExit) {
      if (isLong) {
        if (orderTarget !== null && orderTarget <= baseLtp) {
          return `Target price must be above the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
        if (orderSL !== null && orderSL >= baseLtp) {
          return `Stop Loss must be strictly below the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
      } else {
        if (orderTarget !== null && orderTarget >= baseLtp) {
          return `Target price must be below the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
        if (orderSL !== null && orderSL <= baseLtp) {
          return `Stop Loss must be strictly above the current market price (LTP: ${baseLtp.toFixed(2)}).`;
        }
      }
    } else {
      if (isLong) {
        if (orderSL !== null) {
          if (orderSL >= baseLtp) {
            return `Stop loss price must be below the current market price (LTP: ${baseLtp.toFixed(2)}).`;
          }
          if (hasLimitPrice && orderSL >= clientPrice) {
            return 'Stop loss price must be below the limit price.';
          }
        }
        if (orderTarget !== null) {
          const targetRef = hasLimitPrice ? clientPrice : baseLtp;
          if (orderTarget <= targetRef) {
            return hasLimitPrice
              ? 'Target price must be above the limit price.'
              : `Target price must be above or equal to the current market price (LTP: ${baseLtp.toFixed(2)}).`;
          }
        }
      } else {
        if (orderSL !== null) {
          if (orderSL <= baseLtp) {
            return `Stop loss price must be above the current market price (LTP: ${baseLtp.toFixed(2)}).`;
          }
          if (hasLimitPrice && orderSL <= clientPrice) {
            return 'Stop loss price must be above the limit price.';
          }
        }
        if (orderTarget !== null) {
          const targetRef = hasLimitPrice ? clientPrice : baseLtp;
          if (orderTarget >= targetRef) {
            return hasLimitPrice
              ? 'Target price must be below the limit price.'
              : `Target price must be below or equal to the current market price (LTP: ${baseLtp.toFixed(2)}).`;
          }
        }
      }
    }
    return null;
  }

  /**
   * Validates Segment Price Limits (top_limit and min_limit)
   */
  static validateSegmentPriceLimits(orderType: string, clientPrice: number, baseLtp: number, topLimitPercent: number, minLimitPercent: number): string | null {
    if (['LIMIT', 'SL', 'GTT'].includes(orderType)) {
      if (topLimitPercent > 0) {
        const maxAllowed = baseLtp * (1 + topLimitPercent / 100);
        if (clientPrice > maxAllowed) {
          return `Maximum price allowed is ₹${maxAllowed.toFixed(2)}`;
        }
      }
      if (minLimitPercent > 0) {
        const minAllowed = baseLtp * (1 - minLimitPercent / 100);
        if (clientPrice < minAllowed) {
          return `Minimum price allowed is ₹${minAllowed.toFixed(2)}`;
        }
      }
    }
    return null;
  }

  /**
   * Validates Strike Range check (Deprecated: all strike range validation is canonically handled by OptionStrikeValidator)
   */
  static validateStrikeRange(_symbol: string, _isOption: boolean, _strikeRange: number, _underlyingLtp: number | undefined, _isExit?: boolean): string | null {
    // Legacy numeric range validation is disabled in favor of canonical OptionStrikeValidator 11-strike membership validation.
    return null;
  }

  /**
   * Enforce Anti-Scalping hold duration for manual market exits.
   *
   * P&L is estimated using the buffered exit price (matching what the position
   * would actually realise), consistent with the original order execution logic.
   * Both profit and loss hold times are enforced.
   */
  static validateHoldDuration(
    isExit: boolean,
    orderType: string,
    activePosition: any,
    baseLtp: number,
    profitHoldSec: number,
    lossHoldSec: number,
    exitBuffer?: number
  ): string | null {
    if (isExit && activePosition && activePosition.entry_time && (orderType === 'MARKET' || orderType === 'SLM')) {
      const buf = exitBuffer ?? 0.0017;
      // Estimate the buffered exit price the way the actual execution would compute it
      const effective = resolveEffectivePrices({ ltp: baseLtp, hasRealBidAsk: false, askBuffer: 0, bidBuffer: 0 });
      const basePrice = activePosition.side === 'BUY' ? effective.effectiveBid : effective.effectiveAsk;
      const setting = { entry_buffer: buf, exit_buffer: buf, exit_price_mode: 'BID_ASK' as const };
      const estExitPrice = calculateBufferedPrice({
        side: activePosition.side === 'BUY' ? 'SELL' : 'BUY',
        isExit: true,
        basePrice,
        buySetting: setting,
        sellSetting: setting,
      });

      const entryPrice = Number(activePosition.avg_price || activePosition.entry_price || 0);
      const pnlValue = activePosition.side === 'BUY'
        ? (estExitPrice - entryPrice) * Number(activePosition.qty_open)
        : (entryPrice - estExitPrice) * Number(activePosition.qty_open);

      const durationSec = Math.floor((Date.now() - new Date(activePosition.entry_time).getTime()) / 1000);
      const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

      if (durationSec < requiredHold) {
        return `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`;
      }
    }
    return null;
  }
}
