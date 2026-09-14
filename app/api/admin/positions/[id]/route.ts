/**
 * PATCH /api/admin/positions/[id]
 * DELETE /api/admin/positions/[id]
 *
 * PATCH: Update editable fields on a position row, recalculate closed PnL, sync ledger
 *        transactions, and — if entry price / qty / ltp changed on an open position —
 *        trigger a full account-level liquidation check to handle the updated floating PnL.
 *
 * DELETE: Remove a position row and reverse ALL associated accounting impacts so the
 *         trade is treated as if it never existed:
 *           - PnL transaction (ref_id = position_id)
 *           - Brokerage transaction (ref_id = BKG_<posId> or BKG_<orderId>)
 *           - Margin adjustment transaction (ref_id = MADJ_<posId>)
 *         The sync_profile_balance trigger fires on each DELETE and automatically
 *         reverses the wallet balance.
 *
 * Validates: Requirements 7.8–7.9, 12.1–12.6
 */

import { requireAdmin, requireSuperAdmin } from '../../_auth';
import { requireAuth as apiRequireAuth } from '@/lib/api-middleware';
import { isUserInHierarchy } from '@/lib/hierarchy';
import { checkAndExecuteAccountLiquidation } from '@/lib/liquidationEngine';
import {
  calculateClosedPnl,
  pnlAffectingFieldsChanged,
  isStatusExplicitlyReopened,
} from '@/lib/positionAccountingHelpers';

// Editable position fields allowed via PATCH
const EDITABLE_FIELDS = [
  'sl',
  'tp',
  'qty_open',
  'avg_price',
  'ltp',
  'exit_price',
  'duration_seconds',
  'brokerage',
  'settlement',
  'status',
  'qty_total',
  'side',
] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    const authResult = await apiRequireAuth(request, ['VIEW_USER_POSITIONS']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Resolve params
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Step 3: Parse JSON body
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Step 4: Fetch existing position row
    const { data: existingPosition, error: fetchError } = await adminClient
      .from('positions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existingPosition) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    if (!await isUserInHierarchy(adminClient, callerUser.id, existingPosition.user_id)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }


    // Step 5: Extract only editable fields from body
    const updateFields: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in body) {
        updateFields[field] = body[field];
      }
    }

    // Keep entry_price in sync with avg_price if avg_price is edited
    if ('avg_price' in updateFields) {
      updateFields['entry_price'] = updateFields['avg_price'];
    }

    if (Object.keys(updateFields).length === 0) {
      return Response.json({ error: 'No editable fields provided' }, { status: 400 });
    }

    // Step 6: Construct merged representation to calculate/recalculate PnL
    const mergedPosition = {
      ...existingPosition,
      ...updateFields,
    };

    if (mergedPosition.status === 'closed') {
      const qty = Number(mergedPosition.qty_total || 0);
      const entryPrice = Number(mergedPosition.entry_price || 0);
      const exitPrice = Number(mergedPosition.exit_price || 0);
      const side = mergedPosition.side;
      const calculatedPnl = calculateClosedPnl(side, entryPrice, exitPrice, qty);
      mergedPosition.pnl = calculatedPnl;
      updateFields['pnl'] = calculatedPnl;
    } else {
      // Open positions: do NOT write pnl=0 here.
      // positions.pnl for an open position is the running (floating) PnL stored
      // by the matching engine / ticker updates — it must not be zeroed out by
      // admin edits that do not close the position. Deleting it would make the
      // UI show ₹0 PnL and, more critically, the Step-8 else-branch below would
      // delete the existing PNL_CREDIT/DEBIT transaction that was already settled
      // (e.g. after a partial close), reversing realized losses from the wallet.
      //
      // We intentionally do NOT touch mergedPosition.pnl / updateFields['pnl']
      // for open positions — the field is managed by the matching engine and the
      // close_position RPC, not admin PATCH.
    }

    // Step 7: Update the position row
    const { data: updatedPosition, error: updateError } = await adminClient
      .from('positions')
      .update(updateFields)
      .eq('id', id)
      .select()
      .single();

    if (updateError || !updatedPosition) {
      return Response.json({ error: 'Failed to update position' }, { status: 500 });
    }

    // Step 7b: Margin adjustment — sync user balance when position value changes
    // Position value = avg_price × qty_total. If admin changes either, the difference
    // must be debited or credited to the user's balance.
    const oldValue = Number(existingPosition.avg_price || 0) * Number(existingPosition.qty_total || 0);
    const newValue = Number(updatedPosition.avg_price || 0) * Number(updatedPosition.qty_total || 0);
    const valueDiff = newValue - oldValue; // positive = user owes more, negative = user gets refund

    if (updatedPosition.status !== 'closed' && Math.abs(valueDiff) > 0.01) {
      const adjRefId = `MADJ_${id}`;
      const adjType = valueDiff > 0 ? 'MARGIN_ADJ_DEBIT' : 'MARGIN_ADJ_CREDIT';
      const adjAmount = Math.abs(valueDiff);

      // Check if an adjustment transaction already exists for this position
      const { data: existingAdjTx } = await adminClient
        .from('transactions')
        .select('id, amount, type')
        .eq('ref_id', adjRefId)
        .maybeSingle();

      if (existingAdjTx) {
        // Update existing adjustment transaction
        await adminClient
          .from('transactions')
          .update({
            type: adjType,
            amount: adjAmount,
            status: 'APPROVED',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingAdjTx.id);
      } else {
        // Create new adjustment transaction
        await adminClient
          .from('transactions')
          .insert({
            user_id: updatedPosition.user_id,
            type: adjType,
            amount: adjAmount,
            status: 'APPROVED',
            ref_id: adjRefId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
      }
    }

    // Step 8: Sync PnL transaction
    if (updatedPosition.status === 'closed') {
      const { data: existingPnlTx } = await adminClient
        .from('transactions')
        .select('id')
        .eq('ref_id', id)
        .maybeSingle();

      const pnlType = updatedPosition.pnl >= 0 ? 'PNL_CREDIT' : 'PNL_DEBIT';
      const pnlAmount = Math.abs(updatedPosition.pnl);

      if (pnlAmount > 0.000001) {
        if (existingPnlTx) {
          await adminClient
            .from('transactions')
            .update({
              type: pnlType,
              amount: pnlAmount,
              status: 'APPROVED',
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingPnlTx.id);
        } else {
          await adminClient
            .from('transactions')
            .insert({
              user_id: updatedPosition.user_id,
              type: pnlType,
              amount: pnlAmount,
              status: 'APPROVED',
              ref_id: id,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
        }
      } else {
        if (existingPnlTx) {
          await adminClient
            .from('transactions')
            .delete()
            .eq('id', existingPnlTx.id);
        }
      }
    } else {
      // Position is open — only remove the PnL transaction if the admin explicitly
      // changed the status field FROM 'closed' back to 'open'. In all other cases
      // (editing ltp, sl, tp, qty, etc. while the position stays open) we must NOT
      // touch any existing PNL_CREDIT/DEBIT transaction, because:
      //   a) close_position() stores the settled PnL transaction with ref_id = position_id
      //   b) Deleting it here would reverse the realized loss from the user's wallet
      //      — the exact "losses getting reset after square-off" bug.
      const statusExplicitlyReopened = isStatusExplicitlyReopened(
        updateFields,
        existingPosition.status,
        updatedPosition.status,
      );

      if (statusExplicitlyReopened) {
        await adminClient
          .from('transactions')
          .delete()
          .eq('ref_id', id);
      }
    }

    // Step 9: Sync Brokerage transaction
    const { data: relatedOrders } = await adminClient
      .from('orders')
      .select('id')
      .eq('user_id', updatedPosition.user_id)
      .eq('symbol', updatedPosition.symbol);

    const orderIds = relatedOrders ? relatedOrders.map((o: any) => o.id) : [];
    const candidateRefIds = [`BKG_${id}`, ...orderIds.map((oId: any) => `BKG_${oId}`)];

    const { data: bkgTxs } = await adminClient
      .from('transactions')
      .select('*')
      .eq('user_id', updatedPosition.user_id)
      .eq('type', 'BROKERAGE_DEBIT')
      .in('ref_id', candidateRefIds);

    const targetBrokerage = Number(updatedPosition.brokerage || 0);

    if (targetBrokerage > 0) {
      if (bkgTxs && bkgTxs.length > 0) {
        // Update first one and delete the rest to avoid duplicates
        const firstBkgTx = bkgTxs[0];
        await adminClient
          .from('transactions')
          .update({
            amount: targetBrokerage,
            ref_id: `BKG_${id}`,
            status: 'APPROVED',
            updated_at: new Date().toISOString(),
          })
          .eq('id', firstBkgTx.id);

        if (bkgTxs.length > 1) {
          const remainingIds = bkgTxs.slice(1).map((tx: any) => tx.id);
          await adminClient
            .from('transactions')
            .delete()
            .in('id', remainingIds);
        }
      } else {
        // Create new brokerage transaction
        await adminClient
          .from('transactions')
          .insert({
            user_id: updatedPosition.user_id,
            type: 'BROKERAGE_DEBIT',
            amount: targetBrokerage,
            status: 'APPROVED',
            ref_id: `BKG_${id}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
      }
    } else {
      // If brokerage updated to 0, clean up any existing transactions
      if (bkgTxs && bkgTxs.length > 0) {
        await adminClient
          .from('transactions')
          .delete()
          .in('id', bkgTxs.map((tx: any) => tx.id));
      }
    }

    // Step 10: Log action to act_logs
    const adjInfo = Math.abs(valueDiff) > 0.01
      ? `, Margin Adj: ${valueDiff > 0 ? '-' : '+'}₹${Math.abs(valueDiff).toFixed(2)} (${valueDiff > 0 ? 'debited' : 'credited'})`
      : '';
    await adminClient.from('act_logs').insert({
      type: 'POSITION_EDIT',
      user_id: callerUser.id,
      target_user_id: updatedPosition.user_id,
      symbol: updatedPosition.symbol,
      qty: updatedPosition.qty_total,
      price: updatedPosition.avg_price,
      reason: `Admin updated position ${id}. Status: ${updatedPosition.status}, PnL: ${updatedPosition.pnl}, Brokerage: ${updatedPosition.brokerage}${adjInfo}`,
    });

    // Step 11: Risk check — if the position is still open and any field that affects
    // floating PnL has changed (entry_price / qty / ltp), run a full account-level
    // liquidation check so that a margin-breaching admin edit triggers an immediate
    // auto-square-off.
    //
    // Previously this only checked for avg_price / qty changes, MISSING the ltp field.
    // An admin changing ltp (the current mark price) directly changes floating PnL and
    // MUST also trigger the risk check — fixed here.
    const pnlAffectingFieldChanged = pnlAffectingFieldsChanged(updateFields);
    if (updatedPosition.status === 'open' && pnlAffectingFieldChanged) {
      try {
        // Fetch current profile balance and auto_sqoff setting
        const { data: profile } = await adminClient
          .from('profiles')
          .select('balance, auto_sqoff, parent_id, trading_mode')
          .eq('id', updatedPosition.user_id)
          .single();

        if (profile) {
          const balance = Number(profile.balance ?? 0);
          const autoSqoffPercent = Number(profile.auto_sqoff ?? 90);

          // Fetch ALL open positions for this user to compute account-level floating PnL
          const { data: openPositions } = await adminClient
            .from('positions')
            .select('*')
            .eq('user_id', updatedPosition.user_id)
            .eq('status', 'open');

          if (openPositions && openPositions.length > 0) {
            // Fetch exit buffers from segment_settings
            const isScalper = profile.trading_mode === 'scalper';
            const settingsTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
            const lookupId = profile.parent_id ?? updatedPosition.user_id;

            const { data: settingsRows } = await adminClient
              .from(settingsTable)
              .select('segment, side, exit_buffer, bid_buffer, carry_commission_type, carry_commission_value, commission_type, commission_value')
              .eq('user_id', lookupId);

            const exitBuffers = new Map<string, { exit_buffer: number, bid_buffer: number, carry_commission_type?: string | null, carry_commission_value?: number | null, commission_type?: string | null, commission_value?: number | null }>();
            for (const row of settingsRows ?? []) {
              const key = `${updatedPosition.user_id}|${row.segment}|${row.side}`;
              exitBuffers.set(key, { 
                exit_buffer: Number(row.exit_buffer ?? 0.17),
                bid_buffer: Number(row.bid_buffer ?? 0.3),
                carry_commission_type: row.carry_commission_type || null,
                carry_commission_value: row.carry_commission_value != null ? Number(row.carry_commission_value) : null,
                commission_type: row.commission_type || null,
                commission_value: row.commission_value != null ? Number(row.commission_value) : null,
              });
            }

            // Compute total floating PnL across all open positions using stored ltp
            let totalFloatingPnl = 0;
            const positionsForLiquidation = openPositions.map((pos) => {
              const ltp = Number(pos.ltp ?? pos.entry_price);
              const entryPrice = Number(pos.entry_price ?? pos.avg_price);
              const qty = Number(pos.qty_open ?? 0);

              // Liquidation PnL is calculated based on Bid price (exit-buffer-adjusted)
              const bufKeyBuy = `${updatedPosition.user_id}|${pos.settlement}|BUY`;
              const bufKeySell = `${updatedPosition.user_id}|${pos.settlement}|SELL`;
              const buyBuf = Number(exitBuffers.get(bufKeyBuy)?.bid_buffer ?? 0.0017);
              const sellBuf = Number(exitBuffers.get(bufKeySell)?.exit_buffer ?? 0.0017);

              const pnl =
                pos.side === 'BUY'
                  ? ((ltp * (1 - buyBuf)) - entryPrice) * qty
                  : (entryPrice - (ltp * (1 + sellBuf))) * qty;

              totalFloatingPnl += pnl;
              return { ...pos, ltp, qty_open: qty, entry_price: entryPrice };
            });

            // Run the liquidation check — will auto-square-off if threshold is breached
            await checkAndExecuteAccountLiquidation(
              updatedPosition.user_id,
              balance,
              autoSqoffPercent,
              positionsForLiquidation,
              totalFloatingPnl,
              exitBuffers,
              adminClient,
            );
          }
        }
      } catch (riskErr) {
        // Non-fatal: log the error but still return the successful PATCH response
        console.error('[PATCH /api/admin/positions/[id]] Risk check error after admin edit:', riskErr);
      }
    }

    // Step 12: Return the updated position row
    return Response.json(updatedPosition, { status: 200 });
  } catch (error) {
    console.error('[PATCH /api/admin/positions/[id]] Error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller (super_admin only)
    const authResult = await requireSuperAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Resolve params
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Step 3: Fetch the position details before deletion to clean up transactions & log
    const { data: position, error: fetchError } = await adminClient
      .from('positions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !position) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Step 4: Delete associated PnL transaction (ref_id = position_id)
    await adminClient
      .from('transactions')
      .delete()
      .eq('ref_id', id);

    // Step 4b: Delete margin adjustment transaction if one was ever created by PATCH
    // (ref_id = 'MADJ_<positionId>' — these are NOT caught by the plain ref_id=id query above)
    await adminClient
      .from('transactions')
      .delete()
      .eq('ref_id', `MADJ_${id}`);

    // Step 5: Delete associated Brokerage transaction(s)
    const { data: relatedOrders } = await adminClient
      .from('orders')
      .select('id')
      .eq('user_id', position.user_id)
      .eq('symbol', position.symbol);

    const orderIds = relatedOrders ? relatedOrders.map((o: any) => o.id) : [];
    const candidateRefIds = [`BKG_${id}`, ...orderIds.map((oId: any) => `BKG_${oId}`)];

    await adminClient
      .from('transactions')
      .delete()
      .eq('user_id', position.user_id)
      .eq('type', 'BROKERAGE_DEBIT')
      .in('ref_id', candidateRefIds);

    // Step 5b: Delete buffer fee transactions related to the position's entry orders
    const bufferFeeRefIds = orderIds.map((oId: any) => `BUF_${oId}`);
    if (bufferFeeRefIds.length > 0) {
      await adminClient
        .from('transactions')
        .delete()
        .eq('user_id', position.user_id)
        .eq('type', 'BUFFER_FEE_DEBIT')
        .in('ref_id', bufferFeeRefIds);
    }

    // Step 6: Delete the position row
    const { error: deleteError, count } = await adminClient
      .from('positions')
      .delete({ count: 'exact' })
      .eq('id', id);

    if (deleteError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (count === 0) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Step 7: Log action to act_logs
    await adminClient.from('act_logs').insert({
      type: 'POSITION_DELETE',
      user_id: callerUser.id,
      target_user_id: position.user_id,
      symbol: position.symbol,
      qty: position.qty_total,
      price: position.avg_price,
      reason: `Admin deleted position ${id}. Status was: ${position.status}, PnL was: ${position.pnl}, Brokerage was: ${position.brokerage}`,
    });

    // Step 8: Return success
    return Response.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('[DELETE /api/admin/positions/[id]] Error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
