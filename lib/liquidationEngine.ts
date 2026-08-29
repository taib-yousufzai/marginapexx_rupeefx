import { SupabaseClient } from '@supabase/supabase-js';
import { calculateCarryBrokerage } from './trading/BrokerageCalculator';
import { calculateExitPrice, calculateFreeMargin } from './floatingPnl.ts';

export interface LiquidationResult {
  liquidated: boolean;
  positionsClosed: number;
  totalPnl: number;
  settlementAmount: number;
  error?: string;
}

export interface PositionForLiquidation {
  id: string;
  user_id: string;
  symbol: string;
  side: string;
  qty_open: number;
  entry_price: number;
  settlement: string;
  product_type: string;
  ltp?: number;
  bid?: number;
  ask?: number;
  pnl?: number;
  entry_time?: string;
  created_at?: string;
}

export function computeLiquidationThreshold(
  walletBalance: number,
  liquidationPercentage: number,
): number {
  if (walletBalance <= 0 || liquidationPercentage <= 0) return 0;
  return -(walletBalance * (liquidationPercentage / 100));
}

export function computeFreeMargin(
  walletBalance: number,
  totalLockedMargin: number,
): number {
  return calculateFreeMargin(walletBalance, totalLockedMargin, 0);
}

/**
 * Checks if an account meets the liquidation criteria and liquidates positions
 * strictly in sequential execution/opening order (oldest first). Re-evaluates
 * account state after each trade liquidation and stops if the threshold is no longer breached.
 *
 * @param userId - The user ID to check
 * @param balance - Current wallet balance (already post-brokerage)
 * @param autoSqoffPercent - Liquidation percentage (from profiles.auto_sqoff, default 90)
 * @param positions - All open positions with their current PnL
 * @param totalFloatingPnl - Total floating PnL across all open positions
 * @param exitBuffers - Map of `userId|settlement|side` → exit_buffer for computing exit prices
 * @param admin - Supabase admin client
 */
export async function checkAndExecuteAccountLiquidation(
  userId: string,
  balance: number,
  autoSqoffPercent: number,
  positions: PositionForLiquidation[],
  totalFloatingPnl: number,
  exitBuffers: Map<string, { exit_buffer: number, bid_buffer?: number, carry_commission_type?: string | null, carry_commission_value?: number | null, commission_type?: string | null, commission_value?: number | null }>,
  admin: SupabaseClient,
): Promise<LiquidationResult> {
  if (autoSqoffPercent <= 0 || positions.length === 0) {
    return { liquidated: false, positionsClosed: 0, totalPnl: 0, settlementAmount: 0 };
  }

  const initialThreshold = computeLiquidationThreshold(balance, autoSqoffPercent);

  // Not yet at liquidation level — return early
  if (totalFloatingPnl > initialThreshold) {
    return { liquidated: false, positionsClosed: 0, totalPnl: totalFloatingPnl, settlementAmount: 0 };
  }

  let confirmedBalance = balance;
  let confirmedAutoSqoff = autoSqoffPercent;
  try {
    const { data: liveProfile } = await admin
      .from('profiles')
      .select('balance, auto_sqoff')
      .eq('id', userId)
      .single();

    if (liveProfile) {
      confirmedBalance = Number(liveProfile.balance ?? balance);
      if (liveProfile.auto_sqoff && Number(liveProfile.auto_sqoff) > 0) {
        confirmedAutoSqoff = Number(liveProfile.auto_sqoff);
      }
      const confirmedThreshold = computeLiquidationThreshold(confirmedBalance, confirmedAutoSqoff);

      if (totalFloatingPnl > confirmedThreshold) {
        console.log(
          `[LiquidationEngine] SKIP (confirmed) user ${userId}: ` +
          `PnL=₹${totalFloatingPnl.toFixed(2)} > confirmed threshold=₹${confirmedThreshold.toFixed(2)} ` +
          `(live balance=₹${confirmedBalance.toFixed(2)}, sqoff=${confirmedAutoSqoff}%)`,
        );
        return { liquidated: false, positionsClosed: 0, totalPnl: totalFloatingPnl, settlementAmount: 0 };
      }
    }
  } catch {
    // DB query error — proceed with caller parameters
  }

  // ─── LIQUIDATION CONFIRMED ───────────────────────────────────────────────
  const confirmedThreshold = computeLiquidationThreshold(confirmedBalance, confirmedAutoSqoff);
  console.warn(
    `[LiquidationEngine] LIQUIDATION TRIGGERED for user ${userId}. ` +
    `Balance: ₹${confirmedBalance.toFixed(2)}, ` +
    `FloatingPnL: ₹${totalFloatingPnl.toFixed(2)}, ` +
    `Threshold: ₹${confirmedThreshold.toFixed(2)} (${confirmedAutoSqoff}%). ` +
    `Evaluating ${positions.length} open position(s) sequentially.`,
  );

  const previousBalance = confirmedBalance;

  // ─── STEP 1: Cancel all pending orders first ──────────────────────────────
  const { error: cancelErr } = await admin
    .from('orders')
    .update({ status: 'CANCELLED', info: 'AUTO_LIQUIDATION' })
    .eq('user_id', userId)
    .eq('status', 'PENDING');

  if (cancelErr) {
    console.error(`[LiquidationEngine] Failed to cancel pending orders for user ${userId}:`, cancelErr.message);
  }

  // ─── STEP 2: Sort positions strictly by creation/opening order ─────────────
  const sortedPositions = [...positions].sort((a, b) => {
    const tA = new Date(a.entry_time || a.created_at || 0).getTime();
    const tB = new Date(b.entry_time || b.created_at || 0).getTime();
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  });

  // ─── STEP 3: Sequential Position Closure Loop with Re-evaluation ───────────
  let currentBalance = confirmedBalance;
  let positionsClosed = 0;
  const liquidatedPositions: PositionForLiquidation[] = [];
  const closeResults: boolean[] = [];

  for (let i = 0; i < sortedPositions.length; i++) {
    const pos = sortedPositions[i];

    const ltp = Number(pos.ltp || pos.entry_price);
    const exitBufferKey = `${userId}|${pos.settlement}|${pos.side}`;
    const bufferSettings = exitBuffers.get(exitBufferKey);
    const exitBufferPct = bufferSettings?.exit_buffer ?? 0.17;
    const bidBufferPct = bufferSettings?.bid_buffer ?? 0.3;

    const exitBase = pos.side === 'BUY'
      ? (pos.bid && pos.bid > 0 ? pos.bid : ltp)
      : (pos.ask && pos.ask > 0 ? pos.ask : ltp);

    if (exitBase === ltp) {
      console.warn(`[LiquidationEngine] ${pos.side === 'BUY' ? 'bid' : 'ask'} unavailable for ${pos.symbol}; using ltp=${ltp} for liquidation exit.`);
    }

    const exitPrice = calculateExitPrice({ side: pos.side, ltp: exitBase, exitBufferPct, bidBufferPct });

    const carryBrokerage = calculateCarryBrokerage({
      productType: pos.product_type,
      qty: Number(pos.qty_open),
      entryPrice: Number(pos.entry_price),
      carryCommissionType: bufferSettings?.carry_commission_type,
      carryCommissionValue: bufferSettings?.carry_commission_value,
      commissionType: bufferSettings?.commission_type,
      commissionValue: bufferSettings?.commission_value,
    });

    let closedThisPos = false;

    // Attempt close with retry & graceful exception handling
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { error: closeErr } = await admin.rpc('close_position_v2', {
          p_position_id:        pos.id,
          p_close_qty:          Number(pos.qty_open),
          p_close_price:        exitPrice,
          p_closed_by:          'LIQUIDATION',
          p_expected_brokerage: carryBrokerage,
        });

        if (!closeErr) {
          closedThisPos = true;
          break;
        }

        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 200));
        } else {
          console.error(`[LiquidationEngine] close_position FAILED for ${pos.id}: ${closeErr.message}`);
        }
      } catch (err: any) {
        if (attempt === 2) {
          console.warn(`[LiquidationEngine] close_position_v2 exception for ${pos.id}:`, err?.message);
        }
      }
    }

    closeResults.push(closedThisPos);

    if (closedThisPos) {
      positionsClosed++;
      liquidatedPositions.push(pos);

      // Re-read live wallet balance from profiles
      try {
        const { data: updatedProfile } = await admin
          .from('profiles')
          .select('balance')
          .eq('id', userId)
          .single();
        if (updatedProfile) {
          currentBalance = Number(updatedProfile.balance ?? 0);
        }
      } catch {
        // Keep current balance estimate
      }

      // Re-evaluate floating PnL of remaining open positions
      const remainingPositions = sortedPositions.slice(i + 1);
      if (remainingPositions.length > 0) {
        let remainingFloatingPnl = 0;
        for (const remPos of remainingPositions) {
          if (typeof remPos.pnl === 'number') {
            remainingFloatingPnl += remPos.pnl;
          } else {
            const remLtp = Number(remPos.ltp || remPos.entry_price);
            const remPnl = remPos.side === 'BUY'
              ? (remLtp - Number(remPos.entry_price)) * Number(remPos.qty_open)
              : (Number(remPos.entry_price) - remLtp) * Number(remPos.qty_open);
            remainingFloatingPnl += remPnl;
          }
        }

        const updatedThreshold = computeLiquidationThreshold(currentBalance, confirmedAutoSqoff);
        if (remainingFloatingPnl > updatedThreshold) {
          console.log(
            `[LiquidationEngine] STOPPING sequential liquidation for user ${userId}: ` +
            `Remaining floating PnL=₹${remainingFloatingPnl.toFixed(2)} > threshold=₹${updatedThreshold.toFixed(2)} ` +
            `(Balance=₹${currentBalance.toFixed(2)})`
          );
          break;
        }
      }
    }
  }

  // ─── STEP 4: Notifications for closed positions ────────────────────────────
  if (positionsClosed > 0) {
    const notifRows = liquidatedPositions.map(pos => ({
      user_id: userId,
      type: 'GENERAL',
      title: `⚠️ Auto Liquidation — ${pos.symbol}`,
      message:
        `Your ${pos.side} position in ${pos.symbol} (${pos.qty_open} qty) was automatically ` +
        `closed due to margin call at ${confirmedAutoSqoff}% loss threshold. ` +
        `Balance: ₹${confirmedBalance.toFixed(2)}. ` +
        `Floating P&L at trigger: ₹${totalFloatingPnl.toFixed(2)}.`,
      read: false,
      created_at: new Date().toISOString(),
    }));

    await admin.from('notifications').insert(notifRows);
  }

  // ─── STEP 5: Settlement Loss Calculation & Accounting ──────────────────────
  let incrementalSettlement = 0;
  if (positionsClosed > 0) {
    const closedIds = liquidatedPositions.map(p => p.id);
    const targetRefIds = Array.from(new Set([
      ...closedIds,
      ...closedIds.map(id => `PNL_${id}`),
      ...closedIds.map(id => `CLOSE_PNL_${id}`),
    ]));

    const { data: pnlTxs } = await admin
      .from('transactions')
      .select('amount, type, ref_id')
      .in('ref_id', targetRefIds)
      .eq('type', 'PNL_DEBIT')
      .eq('status', 'APPROVED');

    const totalPnlDebit = (pnlTxs || []).reduce((sum, tx) => sum + Number(tx.amount), 0);

    const { data: pnlCredits } = await admin
      .from('transactions')
      .select('amount')
      .in('ref_id', targetRefIds)
      .eq('type', 'PNL_CREDIT')
      .eq('status', 'APPROVED');

    const totalPnlCredit = (pnlCredits || []).reduce((sum, tx) => sum + Number(tx.amount), 0);
    let netLoss = totalPnlDebit - totalPnlCredit;

    // Fallback: If transaction query produced 0 netLoss, derive directly from liquidatedPositions PnL
    if (netLoss <= 0 && liquidatedPositions.length > 0) {
      const directLossSum = liquidatedPositions.reduce((sum, p) => {
        const pnl = typeof p.pnl === 'number' ? p.pnl : 0;
        return sum + (pnl < 0 ? Math.abs(pnl) : 0);
      }, 0);
      const directProfitSum = liquidatedPositions.reduce((sum, p) => {
        const pnl = typeof p.pnl === 'number' ? p.pnl : 0;
        return sum + (pnl > 0 ? pnl : 0);
      }, 0);
      netLoss = directLossSum - directProfitSum;
    }

    // Settlement is the unabsorbed deficit when net loss exceeds available positive balance
    const previousPositiveBalance = Math.max(0, previousBalance);
    incrementalSettlement = Math.max(0, Math.round((netLoss - previousPositiveBalance) * 100) / 100);
  }

  const finalLoss = Math.abs(totalFloatingPnl);

  // Distribute settlement debt to positions
  if (incrementalSettlement > 0 && positionsClosed > 0) {
    const liquidatedIds = liquidatedPositions.map(p => p.id);

    const posLosses = liquidatedPositions.map(p => {
      if (typeof p.pnl === 'number') return { id: p.id, loss: Math.max(0, -p.pnl) };
      const ltp = Number(p.ltp || p.entry_price);
      const pnl = p.side === 'BUY'
        ? (ltp - Number(p.entry_price)) * p.qty_open
        : (Number(p.entry_price) - ltp) * p.qty_open;
      return { id: p.id, loss: Math.max(0, -pnl) };
    });

    const totalLoss = posLosses.reduce((sum, p) => sum + p.loss, 0);

    if (totalLoss > 0) {
      await Promise.all(
        posLosses.map(({ id, loss }) => {
          const share = (loss / totalLoss) * incrementalSettlement;
          return admin
            .from('positions')
            .update({ settlement_amount: Math.round(share * 100) / 100 })
            .eq('id', id);
        }),
      );
    } else {
      const equalShare = Math.round((incrementalSettlement / liquidatedIds.length) * 100) / 100;
      await admin
        .from('positions')
        .update({ settlement_amount: equalShare })
        .in('id', liquidatedIds);
    }
  }

  // Insert settlement record if balance deficit was incurred
  if (incrementalSettlement > 0) {
    await admin.from('settlement_records').insert({
      user_id: userId,
      settlement_amount: incrementalSettlement,
      liquidation_event: 'AUTO_LIQUIDATION',
      previous_balance: previousBalance,
      final_loss: finalLoss,
      positions_closed: positionsClosed,
      notes:
        `Auto-liquidation at ${confirmedAutoSqoff}% threshold. ` +
        `Threshold: ₹${confirmedThreshold.toFixed(2)}, ` +
        `Floating PnL at trigger: ₹${totalFloatingPnl.toFixed(2)}`,
    });
  }

  // ─── STEP 6: Audit Log Entry ──────────────────────────────────────────────
  await admin.from('act_logs').insert({
    type: 'AUTO_SQUARE_OFF',
    user_id: userId,
    target_user_id: userId,
    reason:
      `ACCOUNT_LIQUIDATION (${confirmedAutoSqoff}%): ${positionsClosed} positions closed. ` +
      `Balance: ₹${previousBalance.toFixed(2)}, ` +
      `FloatingPnL: ₹${totalFloatingPnl.toFixed(2)}, ` +
      `Threshold: ₹${confirmedThreshold.toFixed(2)}` +
      (incrementalSettlement > 0 ? `, Settlement: ₹${incrementalSettlement.toFixed(2)}` : ''),
  });

  return {
    liquidated: true,
    positionsClosed,
    totalPnl: totalFloatingPnl,
    settlementAmount: incrementalSettlement,
  };
}
