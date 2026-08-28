import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from './adminClient.ts';
import { resolveEffectivePrices } from './trading/marketPriceResolver.ts';

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
    if (side === 'BUY' && ltp >= triggerPrice) {
      shouldTrigger = true;
      fillPrice = effective.effectiveAsk;
    } else if (side === 'SELL' && ltp <= triggerPrice) {
      shouldTrigger = true;
      fillPrice = effective.effectiveBid;
    }
  } else if (orderType === 'GTT') {
    if (triggerPrice !== null) {
      const ltpAtEntry = order.ltp_at_entry ? Number(order.ltp_at_entry) : null;
      if (side === 'BUY') {
        if (ltpAtEntry !== null && ltpAtEntry < triggerPrice) {
          if (ltp >= triggerPrice) shouldTrigger = true;
        } else {
          if (ltp <= triggerPrice) shouldTrigger = true;
        }
      } else if (side === 'SELL') {
        if (ltpAtEntry !== null && ltpAtEntry > triggerPrice) {
          if (ltp <= triggerPrice) shouldTrigger = true;
        } else {
          if (ltp >= triggerPrice) shouldTrigger = true;
        }
      }
    }

    const stopLoss = order.stop_loss ? Number(order.stop_loss) : null;
    const target = order.target ? Number(order.target) : null;
    if (triggerPrice === null) {
      if (!shouldTrigger && stopLoss !== null) {
        if (side === 'BUY') {
          if (ltp >= stopLoss) shouldTrigger = true;
        } else if (side === 'SELL') {
          if (ltp <= stopLoss) shouldTrigger = true;
        }
      }
      if (!shouldTrigger && target !== null) {
        if (side === 'BUY') {
          if (ltp <= target) shouldTrigger = true;
        } else if (side === 'SELL') {
          if (ltp >= target) shouldTrigger = true;
        }
      }
    }

    if (shouldTrigger) {
      fillPrice = side === 'BUY' ? effective.effectiveAsk : effective.effectiveBid;
    }
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

      const limitPrice = (order.client_price ?? order.fill_price ?? order.price) ? Number(order.client_price ?? order.fill_price ?? order.price) : null;
      console.log(`[DEBUG] Eval order ${order.id} | ${order.side} ${order.order_type} | limitPrice: ${limitPrice} | ltp: ${ltp} | symbol: "${symbolKey}"`);

      const { shouldTrigger, fillPrice } = evaluateOrderTriggerCondition(
        order,
        ltp,
        priceObj?.bid,
        priceObj?.ask
      );

      console.log(`[DEBUG] -> shouldTrigger: ${shouldTrigger}`);

      if (shouldTrigger) {
        console.log(`[Order Matching] Triggering order ${order.id} (${order.side} ${order.order_type} ${order.symbol}) at LTP: ${ltp}, Fill: ${fillPrice}`);

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

        if (order.is_exit) {
          if (!existingPos || existingPos.length === 0) {
            console.log(`[Order Matching] Skipping exit order ${order.id}: No open position to exit.`);
            continue;
          }
        } else {
          // Entry orders (is_exit is false)
          // BUT: if an opposite position exists, treat this as an exit order to close it.
          // e.g. User places BUY LIMIT while holding a SELL position → close the short.
          if (order.side === 'BUY') {
            const oppSellPos = existingPos && existingPos.find((p: any) => p.side === 'SELL');
            if (oppSellPos) {
              console.log(`[Order Matching] BUY entry order ${order.id} has opposite SELL position — treating as exit to close short`);
              // Fall through: let it execute as an exit below by overriding is_exit
              (order as any)._runtimeIsExit = true;
              (order as any)._runtimeLinkedPosId = oppSellPos.id;
            }
          } else if (order.side === 'SELL') {
            const oppBuyPos = existingPos && existingPos.find((p: any) => p.side === 'BUY');
            if (oppBuyPos) {
              console.log(`[Order Matching] SELL entry order ${order.id} has opposite BUY position — treating as exit to close long`);
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

        const { error: updateOrderErr } = await admin
          .from('orders')
          .update({
            status: 'EXECUTED',
            fill_price: fillPrice,
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        if (updateOrderErr) {
          console.error(`[Order Matching] Failed to update order ${order.id} to EXECUTED:`, updateOrderErr);
          continue;
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
        const buyExitBuffer = exitBufferMap.get(`${pos.settlement}|BUY`) ?? 0;
        const sellExitBuffer = exitBufferMap.get(`${pos.settlement}|SELL`) ?? 0;
        const pnl = pos.side === 'BUY'
          // Closing BUY (selling) → BID - exitBuffer
          ? ((priceObj.bid * (1 - buyExitBuffer)) - entryPrice) * qty
          // Closing SELL (buying back) → ASK + exitBuffer
          : (entryPrice - (priceObj.ask * (1 + sellExitBuffer))) * qty;

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
        console.log(`[Order Matching] DRAWDOWN TRIGGERED for user ${userId}. Total Unrealised: ${totalUnrealised}, Limit: ${drawdownLimit} (${autoSqoffPercent}% of ${balance}). Closing all positions.`);

        for (const item of resolvedPositions) {
          const pos = item.pos;
          const ltp = item.ltp;
          const priceObj = item.priceObj;

          // Calculate exit price
          let exitPrice = ltp;
          if (pos.side === 'BUY') {
            // Closing BUY (selling) → BID - exitBuffer
            const exitBuffer = exitBufferMap.get(`${pos.settlement}|BUY`) ?? 0;
            exitPrice = priceObj.bid * (1 - exitBuffer);
          } else {
            // Closing SELL (buying back) → ASK + exitBuffer
            const exitBuffer = exitBufferMap.get(`${pos.settlement}|SELL`) ?? 0;
            exitPrice = priceObj.ask * (1 + exitBuffer);
          }
          exitPrice = Math.round(exitPrice * 10000) / 10000;

          console.log(`[Order Matching] Liquidation Close for position ${pos.id} (${pos.symbol}). LTP: ${ltp}, Exit Price: ${exitPrice}`);

          const { error: closeRpcErr } = await admin.rpc('close_position', {
            p_position_id: pos.id,
            p_user_id: pos.user_id,
            p_ltp: ltp,
            p_exit_price: exitPrice,
            p_closed_by: 'AUTO_SQOFF',
          });

          if (closeRpcErr) {
            console.error(`[Order Matching] Failed to close position ${pos.id} via close_position RPC during drawdown:`, closeRpcErr);
          } else {
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
        }
      }
    }
  }
}
