import { SupabaseClient } from '@supabase/supabase-js';
import { calculateCarryBrokerage } from './trading/BrokerageCalculator';
import { calculateFloatingPnl, calculateExitPrice, calculateFreeMargin } from './floatingPnl';

export async function checkAndSquareOffPositionsForMargin(userId: string, adminClient: SupabaseClient) {
  try {
    // 1. Fetch user profile
    const { data: profile, error: profileErr } = await adminClient
      .from('profiles')
      .select('balance, trading_mode, parent_id')
      .eq('id', userId)
      .single();

    if (profileErr || !profile) return;

    const balance = Number(profile.balance || 0);
    const isScalper = profile.trading_mode === 'scalper';
    const parentId = profile.parent_id;

    // 2. Fetch all open positions
    const { data: positions, error: posErr } = await adminClient
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'open');

    if (posErr || !positions || positions.length === 0) return;

    // 3. Fetch all segment settings for this user (and parent if applicable)
    const settingsTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
    
    const { data: userSettings } = await adminClient
      .from(settingsTable)
      .select('*')
      .eq('user_id', userId);

    const { data: parentSettings } = parentId 
      ? await adminClient.from(settingsTable).select('*').eq('user_id', parentId)
      : { data: null };

    const userSettingsMap = new Map(userSettings?.map(s => [`${s.segment}_${s.side}`, s]));
    const parentSettingsMap = new Map(parentSettings?.map(s => [`${s.segment}_${s.side}`, s]));

    // 4. Use frozen locked_margin for each open position (set at trade entry, never recalculated)
    const positionsWithMargin: any[] = [];
    let totalLockedMargin = 0;
    let totalFloatingPnl = 0;

    for (const pos of positions) {
      // Find settings for this position
      const key = `${pos.settlement}_${pos.side}`;
      const setting = userSettingsMap.get(key) || parentSettingsMap.get(key);

      // Use frozen locked_margin (fallback to margin_required for backward compat)
      const lockedMargin = Number(pos.locked_margin || pos.margin_required || 0);
      totalLockedMargin += lockedMargin;

      // Compute live floating PnL using exit-buffer-adjusted LTP (same formula as liquidationEngine)
      // This is more accurate than stale pos.pnl which is only updated on close.
      const exitBufferPct = setting?.exit_buffer ?? 0.17; // passed to floatingPnl which handles % → decimal conversion
      const baseLtp = Number(pos.ltp || pos.entry_price);
      const entryPrice = Number(pos.entry_price || pos.avg_price);
      const qty = Number(pos.qty_open || 0);
      let livePnl = 0;
      if (qty > 0 && entryPrice > 0) {
        livePnl = calculateFloatingPnl({ side: pos.side, ltp: baseLtp, entryPrice, qty, exitBufferPct });
      }
      totalFloatingPnl += livePnl;

      positionsWithMargin.push({
        ...pos,
        lockedMargin,
        exitBufferPct,
      });
    }

    // 5. Check if total available margin is negative
    const freeMargin = calculateFreeMargin(balance, totalLockedMargin, totalFloatingPnl);
    
    if (freeMargin < 0) {
      // User has insufficient margin now!
      // We will square off the open carry positions in the segments that are over margin
      const positionsToClose = positionsWithMargin.filter(p => p.product_type === 'CARRY');
      
      for (const pos of positionsToClose) {
        // Compute exit price using exit buffer
        const baseLtp = Number(pos.ltp || pos.entry_price);
        // Use the correct market side for exit pricing:
        //   BUY position exits via SELL → BID; SELL position exits via BUY → ASK.
        // Explicit LTP fallback for forced margin close (same policy as liquidation engine).
        const exitBase = pos.side === 'BUY'
          ? (pos.bid && Number(pos.bid) > 0 ? Number(pos.bid) : baseLtp)
          : (pos.ask && Number(pos.ask) > 0 ? Number(pos.ask) : baseLtp);
        if (exitBase === baseLtp) {
          console.warn(`[marginSquareOff] ${pos.side === 'BUY' ? 'bid' : 'ask'} unavailable for ${pos.symbol}; using ltp for exit price.`);
        }
        const exitPrice = calculateExitPrice({ side: pos.side, ltp: exitBase, exitBufferPct: pos.exitBufferPct }, 2);

        // Carry brokerage deferred to exit
        const key = `${pos.settlement}_${pos.side}`;
        const setting = userSettingsMap.get(key) || parentSettingsMap.get(key);
        const carryBrokerage = calculateCarryBrokerage({
          productType: pos.product_type,
          qty: Number(pos.qty_open),
          entryPrice: Number(pos.entry_price),
          carryCommissionType: setting?.carry_commission_type,
          carryCommissionValue: setting?.carry_commission_value != null ? Number(setting.carry_commission_value) : null,
          commissionType: setting?.commission_type,
          commissionValue: setting?.commission_value != null ? Number(setting.commission_value) : null,
        });

        // Call RPC close_position
        const closeQty = Number(pos.qty_open !== undefined && pos.qty_open !== null && Number(pos.qty_open) > 0 ? pos.qty_open : (pos.qty_total || 1));
        const { error: rpcErr } = await adminClient.rpc('close_position_v2', {
          p_position_id:        pos.id,
          p_close_qty:          closeQty,
          p_close_price:        exitPrice,
          p_closed_by:          'SYSTEM',
          p_expected_brokerage: carryBrokerage,
        });

        if (!rpcErr) {
          // Send notification to user
          const { sendNotifications } = await import('./notifications');
          await sendNotifications(adminClient, {
            user_id: userId,
            type: 'GENERAL',
            title: `[Position Squared Off] ${pos.symbol}`,
            message: `Because you no longer have the carry margin, the specific instrument ${pos.symbol} has been squared off.`,
            read: false,
            created_at: new Date().toISOString()
          });

          // margin_required is already set to 0 atomically by close_position_v2
        }
      }
    }
  } catch (err) {
    console.error('[checkAndSquareOffPositionsForMargin] Error:', err);
  }
}
