import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from './adminClient.ts';
import { resolveEffectivePrices } from './trading/marketPriceResolver.ts';
import { checkAndExecuteAccountLiquidation, PositionForLiquidation } from './liquidationEngine.ts';
import { calculateFloatingPnl } from './floatingPnl.ts';

export interface Quote {
  id: string; // e.g. "NSE:INFY"
  last_price: number;
  bid?: number;
  ask?: number;
}

export interface OrderTriggerResult {
  shouldTrigger: boolean;
  fillPrice: number;
}

/**
 * Evaluates whether a pending order (LIMIT, SL, SLM, GTT) should trigger given market LTP, bid, and ask.
 */
export function evaluateOrderTriggerCondition(
  order: {
    order_type: string;
    side: 'BUY' | 'SELL';
    price?: number | null;
    client_price?: number | null;
    fill_price?: number | null;
    trigger_price?: number | null;
    stop_loss?: number | null;
    target?: number | null;
    ltp_at_entry?: number | null;
    is_exit?: boolean | null;
    info?: any;
  },
  ltp: number,
  bid?: number,
  ask?: number
): OrderTriggerResult {
  let shouldTrigger = false;
  let fillPrice = Number(order.price ?? ltp);

  const orderType = order.order_type;
  const side = order.side;
  const triggerPrice = order.trigger_price ? Number(order.trigger_price) : null;
  const limitPrice = (order.client_price ?? order.fill_price ?? order.price) ? Number(order.client_price ?? order.fill_price ?? order.price) : null;

  const effective = resolveEffectivePrices({
    ltp,
    rawBid: bid,
    rawAsk: ask,
    hasRealBidAsk: Boolean(bid && ask),
  });

  if (orderType === 'LIMIT' && limitPrice !== null) {
    if (side === 'BUY' && ltp <= limitPrice) {
      shouldTrigger = true;
      fillPrice = limitPrice;
    } else if (side === 'SELL' && ltp >= limitPrice) {
      shouldTrigger = true;
      fillPrice = limitPrice;
    }
  } else if ((orderType === 'SL' || orderType === 'SLM') && triggerPrice !== null) {
    const refEntry = (order.ltp_at_entry !== undefined && order.ltp_at_entry !== null && Number(order.ltp_at_entry) > 0) 
      ? Number(order.ltp_at_entry) 
      : (order.info?.entry_price ? Number(order.info.entry_price) : ltp);
    if (side === 'SELL') {
      if (triggerPrice > refEntry) {
        if (ltp >= triggerPrice) shouldTrigger = true;
      } else {
        if (ltp <= triggerPrice) shouldTrigger = true;
      }
      if (shouldTrigger) fillPrice = effective.effectiveBid;
    } else if (side === 'BUY') {
      if (triggerPrice >= refEntry) {
        if (ltp >= triggerPrice) shouldTrigger = true;
      } else {
        if (ltp <= triggerPrice) shouldTrigger = true;
      }
      if (shouldTrigger) fillPrice = effective.effectiveAsk;
    }
  } else if (orderType === 'GTT') {
    const stopLoss = order.stop_loss ? Number(order.stop_loss) : null;
    const target = order.target ? Number(order.target) : null;
    // INVARIANT: stop_loss/target sub-order evaluation is ONLY reached when isExit === true.
    // For pre-entry GTT orders (is_exit = false), this block is skipped entirely, so the
    // stop_loss and target fields stored on the order row never cause a premature trigger.
    // Only the triggerPrice/limitPrice path below evaluates for pre-entry GTT orders.
    const isExit = order.is_exit === true;

    // ONLY evaluate stopLoss and target as trigger conditions if this is an EXIT order for an existing open position
    if (isExit) {
      if (stopLoss !== null) {
        if (side === 'SELL' && ltp <= stopLoss) shouldTrigger = true;      // Sell exit for BUY position (price dropped to SL)
        else if (side === 'BUY' && ltp >= stopLoss) shouldTrigger = true;  // Buy exit for SELL position (price rose to SL)
      }
      if (!shouldTrigger && target !== null) {
        if (side === 'SELL' && ltp >= target) shouldTrigger = true;       // Sell exit for BUY position (price rose to Target)
        else if (side === 'BUY' && ltp <= target) shouldTrigger = true;   // Buy exit for SELL position (price dropped to Target)
      }
    }

    // For ENTRY GTT orders, evaluate trigger price / limit price conditions strictly when !isExit
    if (!shouldTrigger && !isExit && triggerPrice !== null) {
      const refEntry = (order.ltp_at_entry !== undefined && order.ltp_at_entry !== null && Number(order.ltp_at_entry) > 0) 
        ? Number(order.ltp_at_entry) 
        : (order.info?.entry_price ? Number(order.info.entry_price) : ltp);
      if (side === 'SELL') {
        if (triggerPrice <= refEntry) {
          if (ltp <= triggerPrice) shouldTrigger = true;
        } else {
          if (ltp >= triggerPrice) shouldTrigger = true;
        }
      } else if (side === 'BUY') {
        if (triggerPrice >= refEntry) {
          if (ltp >= triggerPrice) shouldTrigger = true;
        } else {
          if (ltp <= triggerPrice) shouldTrigger = true;
        }
      }
    }

    if (!shouldTrigger && !isExit && triggerPrice === null && limitPrice !== null) {
      if (side === 'BUY' && ltp <= limitPrice) {
        shouldTrigger = true;
      } else if (side === 'SELL' && ltp >= limitPrice) {
        shouldTrigger = true;
      }
    }

    if (shouldTrigger && (fillPrice === 0 || fillPrice === Number(order.price ?? 0))) {
      fillPrice = limitPrice ?? (side === 'BUY' ? effective.effectiveAsk : effective.effectiveBid);
    }
  } else if (orderType === 'MARKET') {
    shouldTrigger = true;
    fillPrice = side === 'BUY' ? effective.effectiveAsk : effective.effectiveBid;
  }

  return { shouldTrigger, fillPrice };
}

/**
 * Iterates over all PENDING orders and open positions to check if they need to be triggered or updated.
 * Driven by the daily/regular price sync.
 */
export async function processPendingOrdersAndPositions(quotes: Quote[]): Promise<void> {
  const admin = getAdminClient();

  if (!quotes || quotes.length === 0) return;

  // Build a lookup map of prices for fast access
  const pricesMap = new Map<string, { ltp: number; bid: number; ask: number }>();
  for (const quote of quotes) {
    pricesMap.set(quote.id, {
      ltp: quote.last_price,
      bid: quote.bid ?? quote.last_price,
      ask: quote.ask ?? quote.last_price
    });
  }

  // 1. Fetch pending orders and open positions in parallel
  const [ordersRes, positionsRes] = await Promise.all([
    admin.from('orders').select('*').eq('status', 'PENDING'),
    admin.from('positions').select('*').eq('status', 'open')
  ]);

  const pendingOrders = ordersRes.data ?? [];
  const openPositions = positionsRes.data ?? [];

  if (ordersRes.error) {
    console.error('[Order Matching] Error fetching pending orders:', ordersRes.error);
  }
  if (positionsRes.error) {
    console.error('[Order Matching] Error fetching open positions:', positionsRes.error);
  }

  // Pre-fetch segment settings for all involved users in a single query
  const userIds = Array.from(new Set([
    ...pendingOrders.map(o => o.user_id),
    ...openPositions.map(p => p.user_id)
  ]));

  const segmentSettingsCache = new Map<string, { entry_buffer: number; exit_buffer: number }>();
  if (userIds.length > 0) {
    const { data: allSegSettings, error: segSettingsErr } = await admin
      .from('segment_settings')
      .select('user_id, segment, side, entry_buffer, exit_buffer')
      .in('user_id', userIds);

    const toDb = (val: any, fallback: number) => {
      const num = Number(val);
      if (!val || isNaN(num)) return fallback;
      return num > 0.005 ? num / 100 : num;
    };

    if (segSettingsErr) {
      console.error('[Order Matching] Error pre-fetching segment settings:', segSettingsErr);
    } else if (allSegSettings) {
      for (const s of allSegSettings) {
        const key = `${s.user_id}|${s.segment}|${s.side}`;
        segmentSettingsCache.set(key, {
          entry_buffer: toDb(s.entry_buffer, 0.003),
          exit_buffer: toDb(s.exit_buffer, 0.0017)
        });
      }
    }
  }

  // 1. PROCESS PENDING ORDERS
  if (pendingOrders.length > 0) {
    console.log(`[Order Matching] Found ${pendingOrders.length} pending orders to evaluate.`);

    for (const order of pendingOrders) {
      const rawSymbol = order.kite_instrument || order.symbol || '';

      // Try multiple key variants to handle crypto (BTCUSDT, BTC, BTC/USDT)
      // and Indian equities (NSE:INFY, NFO:NIFTY25JUNFUT, etc.)
      const symbolVariants = [
        rawSymbol,
        rawSymbol.toUpperCase(),
        rawSymbol.replace('/', ''),                          // BTC/USDT → BTCUSDT
        rawSymbol.replace('/USDT', 'USDT'),                  // BTC/USDT → BTCUSDT
        rawSymbol + 'USDT',                                  // BTC → BTCUSDT
        rawSymbol.replace('USDT', ''),                       // BTCUSDT → BTC
        (rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol), // NSE:INFY → INFY
      ];

      let priceObj: { ltp: number; bid: number; ask: number } | undefined;
      let symbolKey = rawSymbol;
      for (const variant of symbolVariants) {
        const found = pricesMap.get(variant);
        if (found) {
          priceObj = found;
          symbolKey = variant;
          break;
        }
      }

      const ltp = priceObj?.ltp;

      if (ltp === undefined || ltp <= 0) {
        console.log(`[DEBUG] No price for order ${order.id} symbol "${rawSymbol}" (tried: ${symbolVariants.join(', ')})`);
        continue;
      }

      const { shouldTrigger, fillPrice } = evaluateOrderTriggerCondition(
        order,
        ltp,
        priceObj?.bid,
        priceObj?.ask
      );

      console.log(`[EXEC_TRACE ${new Date().toISOString()}] EVALUATING | Order ID: ${order.id} | Type: ${order.order_type} | Side: ${order.side} | Status: ${order.status} | LTP: ${ltp} | TriggerPrice: ${order.trigger_price} | SL: ${order.stop_loss} | Target: ${order.target} | is_exit: ${order.is_exit} | info: ${order.info} | Result: ${shouldTrigger}`);

      if (shouldTrigger) {
        try {
          console.log(`[EXEC_TRACE ${new Date().toISOString()}] TRIGGERED_TRUE | Function: processPendingOrdersAndPositions | Order ID: ${order.id} | Type: ${order.order_type} | Side: ${order.side} | Status: ${order.status} | LTP: ${ltp} | FillPrice: ${fillPrice} | TriggerPrice: ${order.trigger_price} | SL: ${order.stop_loss} | Target: ${order.target} | is_exit: ${order.is_exit}`);

          const { data: existingPos, error: posErrorCheck } = await admin
            .from('positions')
            .select('id, side')
            .eq('symbol', symbolKey)
            .eq('status', 'open');

          if (posErrorCheck) {
            console.error('[Order Matching] Error checking existing positions for', symbolKey, ':', posErrorCheck);
            // Skip processing this order due to error
            continue;
          }

          if (order.is_exit || order.linked_position_id || (order.info && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(order.info)))) {
            if (!existingPos || existingPos.length === 0) {
              console.log(`[EXEC_TRACE ${new Date().toISOString()}] CANCEL_ORPHAN | Order ID: ${order.id} | Symbol: ${symbolKey} | Reason: Position is closed`);
              await admin
                .from('orders')
                .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
                .eq('id', order.id);
              continue;
            }
          } else {
            // Entry orders (is_exit is false)
            // BUT: if an opposite position exists, treat this as an exit order to close it.
            // e.g. User places BUY LIMIT while holding a SELL position → close the short.
            if (order.side === 'BUY') {
              const oppSellPos = existingPos && existingPos.find((p: any) => p.side === 'SELL');
              if (oppSellPos) {
                console.log(`[EXEC_TRACE ${new Date().toISOString()}] OPPOSITE_POS_CONVERT | BUY entry order ${order.id} has opposite SELL position ${oppSellPos.id}`);
                (order as any)._runtimeIsExit = true;
                (order as any)._runtimeLinkedPosId = oppSellPos.id;
              }
            } else if (order.side === 'SELL') {
              const oppBuyPos = existingPos && existingPos.find((p: any) => p.side === 'BUY');
              if (oppBuyPos) {
                console.log(`[EXEC_TRACE ${new Date().toISOString()}] OPPOSITE_POS_CONVERT | SELL entry order ${order.id} has opposite BUY position ${oppBuyPos.id}`);
                (order as any)._runtimeIsExit = true;
                (order as any)._runtimeLinkedPosId = oppBuyPos.id;
              }
            }
          }

          // 1b. Resolve the linked position ID. For virtual SL/Target orders, extract it from the ID.
          let virtualPosId = null;
          if (typeof order.id === 'string' && (order.id.startsWith('pos-sl-') || order.id.startsWith('pos-target-'))) {
            virtualPosId = order.id.replace('pos-sl-', '').replace('pos-target-', '');
          }

          const infoAsUuid = order.info && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(order.info))
            ? String(order.info) : null;
          const finalLinkedPosId = (order as any)._runtimeLinkedPosId
            || virtualPosId
            || (order.linked_position_id || null)
            || infoAsUuid;
          const finalIsExit = (order as any)._runtimeIsExit || order.is_exit;

          if (finalIsExit && finalLinkedPosId) {
            const patchPayload: any = {};
            if ((order as any)._runtimeIsExit) patchPayload.is_exit = true;
            if ((order as any)._runtimeLinkedPosId) patchPayload.linked_position_id = finalLinkedPosId;
            // ALWAYS patch info for the RPC to consume
            patchPayload.info = finalLinkedPosId;

            const { error: patchErr } = await admin
              .from('orders')
              .update(patchPayload)
              .eq('id', order.id);

            if (patchErr) {
              console.error(`[Order Matching] Failed to patch exit info for order ${order.id}:`, patchErr);
            } else {
              console.log(`[Order Matching] Patched order ${order.id} exit info (linked to ${finalLinkedPosId})`);
            }
          }

          console.log(`[EXEC_TRACE ${new Date().toISOString()}] BEFORE_EXEC_UPDATE | Function: processPendingOrdersAndPositions | Order ID: ${order.id} | Type: ${order.order_type} | Side: ${order.side} | Status BEFORE: ${order.status} -> Status AFTER: EXECUTED | FillPrice: ${fillPrice}`);

          const { data: updatedDbRecord, error: updateOrderErr } = await admin
            .from('orders')
            .update({
              status: 'EXECUTED',
              fill_price: fillPrice,
              updated_at: new Date().toISOString(),
            })
            .eq('id', order.id)
            .eq('status', 'PENDING')
            .select();

          if (updateOrderErr) {
            console.error(`[EXEC_TRACE ${new Date().toISOString()}] EXEC_UPDATE_ERROR | Order ID: ${order.id} | Error:`, updateOrderErr);
            continue;
          }

          console.log(`[EXEC_TRACE ${new Date().toISOString()}] AFTER_EXEC_UPDATE | Order ID: ${order.id} | DB Status: ${updatedDbRecord?.[0]?.status}`);

          // Explicitly call the RPC to process the position.
          const linkedInfo = finalLinkedPosId || null;
          console.log(`[EXEC_TRACE ${new Date().toISOString()}] CALLING_RPC_PROCESS_EXECUTED | Order ID: ${order.id} | Info: ${linkedInfo}`);
          const { error: rpcErr } = await admin.rpc('process_executed_position', {
            p_order_id: order.id,
            p_info: linkedInfo,
          });
          if (rpcErr) {
            console.error(`[EXEC_TRACE ${new Date().toISOString()}] RPC_ERROR | Order ID: ${order.id} | Error:`, rpcErr);
          } else {
            console.log(`[EXEC_TRACE ${new Date().toISOString()}] RPC_SUCCESS | Order ID: ${order.id}`);

            // GTT LIMIT gate activation: copy SL/TARGET from the order to the linked position.
            // At placement time, GTT positions are created with NULL SL/TARGET to prevent
            // phantom triggers before the LIMIT gate is reached. Now that the order has
            // executed (LIMIT gate met), activate the protective SL/TARGET on the position.
            if (order.order_type === 'GTT' && !finalIsExit) {
              const posIdForSLTarget = linkedInfo || order.info;
              if (posIdForSLTarget && (order.stop_loss || order.target)) {
                const slTargetPatch: any = {};
                if (order.stop_loss) slTargetPatch.stop_loss = Number(order.stop_loss);
                if (order.target) slTargetPatch.target = Number(order.target);
                slTargetPatch.updated_at = new Date().toISOString();

                const { error: slPatchErr } = await admin
                  .from('positions')
                  .update(slTargetPatch)
                  .eq('id', posIdForSLTarget);

                if (slPatchErr) {
                  console.error(`[EXEC_TRACE ${new Date().toISOString()}] GTT_SL_TARGET_PATCH_ERROR | Order ID: ${order.id} | Position: ${posIdForSLTarget} | Error:`, slPatchErr);
                } else {
                  console.log(`[EXEC_TRACE ${new Date().toISOString()}] GTT_SL_TARGET_ACTIVATED | Order ID: ${order.id} | Position: ${posIdForSLTarget} | SL: ${order.stop_loss} | Target: ${order.target}`);
                }
              }
            }
          }

          // 3. Write audit log
          await admin.from('act_logs').insert({
            type: 'ORDER_EXECUTION',
            user_id: order.user_id,
            target_user_id: order.user_id,
            symbol: order.symbol,
            qty: order.qty,
            price: fillPrice,
            reason: `${order.order_type ?? 'LIMIT'} Order Triggered @ ${ltp}`,
          });
        } catch (orderErr: any) {
          console.error(`[Order Matching] Error processing order ${order.id}:`, orderErr?.message ?? orderErr);
          continue;
        }
      }
    }
  }

  // 2. PROCESS OPEN POSITIONS
  if (openPositions.length > 0) {
    console.log(`[Order Matching] Found ${openPositions.length} open positions to evaluate.`);

    // Group open positions by user_id
    const userOpenPositions: Record<string, any[]> = {};
    for (const pos of openPositions) {
      if (!userOpenPositions[pos.user_id]) {
        userOpenPositions[pos.user_id] = [];
      }
      userOpenPositions[pos.user_id].push(pos);
    }

    const closedPositionIds = new Set<string>();

    // Evaluate Drawdown Limit per user
    for (const [userId, userPositions] of Object.entries(userOpenPositions)) {
      // 1. Fetch user profile
      const { data: profile, error: profileErr } = await admin
        .from('profiles')
        .select('balance, auto_sqoff')
        .eq('id', userId)
        .single();

      if (profileErr || !profile) {
        console.error(`[Order Matching] Error fetching profile for user ${userId}:`, profileErr);
        continue;
      }

      const balance = Number(profile.balance || 0);
      const autoSqoffPercent = Number(profile.auto_sqoff ?? 90);

      // Guard: Bypass if balance is 0/negative or auto_sqoff is disabled (<= 0)
      if (balance <= 0 || autoSqoffPercent <= 0) {
        continue;
      }

      const drawdownLimit = - (autoSqoffPercent / 100.0) * balance;

      // 2. Map buffers from pre-fetched settings (to get entry/exit buffers)
      const entryBufferMap = new Map<string, number>();
      const exitBufferMap = new Map<string, number>();
      for (const [key, val] of segmentSettingsCache.entries()) {
        if (key.startsWith(`${userId}|`)) {
          const parts = key.split('|');
          const seg = parts[1];
          const side = parts[2];
          entryBufferMap.set(`${seg}|${side}`, val.entry_buffer);
          exitBufferMap.set(`${seg}|${side}`, val.exit_buffer);
        }
      }

      // 3. Compute live Floating P/L and resolve LTP/Prices for each position
      let totalUnrealised = 0;
      const resolvedPositions: any[] = [];

      for (const pos of userPositions) {
        let priceObj = pricesMap.get(pos.symbol);

        if (!priceObj && pos.settlement) {
          let exchange = 'NSE';
          const s = pos.settlement.toUpperCase();
          if (s.includes('MCX')) exchange = 'MCX';
          else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
          else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
          else if (s.includes('BSE')) exchange = 'BSE';
          priceObj = pricesMap.get(`${exchange}:${pos.symbol}`);
        }

        // Fallback
        if (!priceObj || priceObj.ltp <= 0) {
          priceObj = { ltp: Number(pos.ltp ?? pos.entry_price), bid: Number(pos.ltp ?? pos.entry_price), ask: Number(pos.ltp ?? pos.entry_price) };
        }

        const ltp = priceObj.ltp;
        const entryPrice = Number(pos.entry_price ?? pos.avg_price);
        const qty = Number(pos.qty_open ?? 0);
        const rawExitBuffer = exitBufferMap.get(`${pos.settlement}|${pos.side}`) ?? 0.17;
        const exitBufferPct = rawExitBuffer > 0.005 ? rawExitBuffer / 100 : rawExitBuffer;
        const pnl = calculateFloatingPnl({
          side: pos.side,
          ltp,
          entryPrice,
          qty,
          exitBufferPct,
        });

        totalUnrealised += pnl;

        resolvedPositions.push({
          pos,
          ltp,
          priceObj,
          pnl
        });
      }

      // 4. Check if user hit drawdown limit
      if (totalUnrealised <= drawdownLimit && userPositions.length > 0) {
        console.log(`[Order Matching] DRAWDOWN TRIGGERED for user ${userId}. Total Unrealised: ${totalUnrealised}, Limit: ${drawdownLimit} (${autoSqoffPercent}% of ${balance}). Delegating to sequential liquidation engine.`);

        // Convert user positions for checkAndExecuteAccountLiquidation
        const positionsForLiquidation: PositionForLiquidation[] = resolvedPositions.map(item => ({
          ...item.pos,
          ltp: item.ltp,
          entry_price: Number(item.pos.entry_price ?? item.pos.avg_price),
          qty_open: Number(item.pos.qty_open ?? 0),
        }));

        // Convert exitBufferMap for liquidationEngine
        const exitBuffers = new Map<string, { exit_buffer: number; bid_buffer: number }>();
        for (const [key, val] of exitBufferMap.entries()) {
          const fullKey = `${userId}|${key}`;
          exitBuffers.set(fullKey, { exit_buffer: val, bid_buffer: val });
        }

        const result = await checkAndExecuteAccountLiquidation(
          userId,
          balance,
          autoSqoffPercent,
          positionsForLiquidation,
          totalUnrealised,
          exitBuffers,
          admin,
        );

        if (result.liquidated) {
          for (const pos of userPositions) {
            closedPositionIds.add(pos.id);
          }
        }
      }
    }

    // 5. PROCESS REMAINING OPEN POSITIONS FOR STOP LOSS AND TARGET
    for (const pos of openPositions) {
      if (closedPositionIds.has(pos.id)) {
        continue; // Already closed by drawdown limit
      }

      let priceObj = pricesMap.get(pos.symbol);

      if (!priceObj && pos.settlement) {
        let exchange = 'NSE';
        const s = pos.settlement.toUpperCase();
        if (s.includes('MCX')) exchange = 'MCX';
        else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
        else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
        else if (s.includes('BSE')) exchange = 'BSE';
        priceObj = pricesMap.get(`${exchange}:${pos.symbol}`);
      }

      if (!priceObj || priceObj.ltp <= 0) {
        continue; // No price update in this batch
      }
      
      const ltp = priceObj.ltp;

      let shouldClose = false;
      let closeReason = 'AUTO_SQOFF';

      const stopLoss = pos.stop_loss ? Number(pos.stop_loss) : (pos.sl ? Number(pos.sl) : null);
      const target = pos.target ? Number(pos.target) : (pos.tp ? Number(pos.tp) : null);
      const side = pos.side;
      const entryPrice = Number(pos.entry_price ?? pos.avg_price);

      // Check Stop Loss
      if (stopLoss !== null && stopLoss > 0) {
        if (side === 'BUY' && ltp <= stopLoss) {
          shouldClose = true;
          closeReason = 'AUTO_SL';
        } else if (side === 'SELL' && ltp >= stopLoss) {
          shouldClose = true;
          closeReason = 'AUTO_SL';
        }
      }

      // Check Target
      if (!shouldClose && target !== null && target > 0) {
        if (side === 'BUY' && ltp >= target) {
          shouldClose = true;
          closeReason = 'AUTO_TARGET';
        } else if (side === 'SELL' && ltp <= target) {
          shouldClose = true;
          closeReason = 'AUTO_TARGET';
        }
      }

      if (shouldClose) {
        console.log(`[Order Matching] Triggering auto-exit for position ${pos.id} (${side} ${pos.symbol}) due to ${closeReason}. LTP: ${ltp}, SL: ${stopLoss}, Target: ${target}`);

        // Calculate exit price
        let exitPrice = ltp;
        const exitBuffer = segmentSettingsCache.get(`${pos.user_id}|${pos.settlement}|${pos.side}`)?.exit_buffer ?? 0.0017;
        if (pos.side === 'BUY') {
          // Closing BUY (selling) → BID - exitBuffer
          exitPrice = priceObj.bid * (1 - exitBuffer);
        } else {
          // Closing SELL (buying back) → ASK + exitBuffer
          exitPrice = priceObj.ask * (1 + exitBuffer);
        }
        exitPrice = Math.round(exitPrice * 10000) / 10000;

        const { error: closeRpcErr } = await admin.rpc('close_position', {
          p_position_id: pos.id,
          p_user_id: pos.user_id,
          p_ltp: ltp,
          p_exit_price: exitPrice,
          p_closed_by: closeReason,
        });

        if (closeRpcErr) {
          console.error(`[Order Matching] Failed to close position ${pos.id} via close_position RPC:`, closeRpcErr);
        } else {
          // Cancel open pending exit/linked orders for this position or symbol
          await admin.from('orders')
            .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
            .eq('user_id', pos.user_id)
            .eq('status', 'PENDING')
            .or(`info.eq.${pos.id},linked_position_id.eq.${pos.id},symbol.eq.${pos.symbol}`);
        }
      }
    }
  }
}
