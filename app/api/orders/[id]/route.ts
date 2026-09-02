import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { logAction, extractClientIp } from '@/lib/actionLogger';
import { OrderService } from '@/lib/trading/OrderService';

/**
 * PUT /api/orders/[id]
 * 
 * Modifies an existing pending order in place.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const ipAddress = extractClientIp(request.headers);
  const clonedRequest = request.clone();
  const { id } = await params;

  let payload: any = null;
  try {
    payload = await clonedRequest.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
  }

  const user = await getUserFromRequest(request);

  const response = await handleModifyOrder({ id }, ipAddress, user, payload);

  let errorMessage: string | null = null;
  if (!response.ok) {
    try {
      const errorData = await response.clone().json();
      errorMessage = errorData.error || errorData.message || 'Unknown error';
    } catch {
      errorMessage = 'Failed to parse error response';
    }
  }

  logAction({
    userId: user?.id,
    username: user?.user_metadata?.username || user?.email,
    role: user?.user_metadata?.role,
    actionType: 'MODIFY_ORDER',
    module: 'TRADING',
    apiEndpoint: '/api/orders/[id]',
    httpMethod: 'PUT',
    ipAddress,
    requestPayload: payload,
    responseStatus: response.status,
    isSuccess: response.ok,
    errorMessage: errorMessage || undefined,
  });

  return response;
}

/**
 * PATCH /api/orders/[id]
 * 
 * Updates an internal platform order (Cancel or Modify).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const ipAddress = extractClientIp(request.headers);
  const clonedRequest = request.clone();
  const { id } = await params;
  
  let payload: any = null;
  try {
    payload = await clonedRequest.json();
  } catch {}

  const user = await getUserFromRequest(request);

  const isCancel = payload?.status === 'CANCELLED';
  const response = isCancel 
    ? await handleCancelOrder(request, { id }, ipAddress, user, payload)
    : await handleModifyOrder({ id }, ipAddress, user, payload);

  let errorMessage: string | null = null;
  if (!response.ok) {
    try {
      const errorData = await response.clone().json();
      errorMessage = errorData.error || errorData.message || 'Unknown error';
    } catch {
      errorMessage = 'Failed to parse error response';
    }
  }

  logAction({
    userId: user?.id,
    username: user?.user_metadata?.username || user?.email,
    role: user?.user_metadata?.role,
    actionType: isCancel ? 'CANCEL_ORDER' : 'MODIFY_ORDER',
    module: 'TRADING',
    apiEndpoint: '/api/orders/[id]',
    httpMethod: 'PATCH',
    ipAddress,
    requestPayload: payload,
    responseStatus: response.status,
    isSuccess: response.ok,
    errorMessage: errorMessage || undefined,
  });

  return response;
}

async function handleModifyOrder(
  params: { id: string },
  clientIp: string,
  user: any,
  payload: any
): Promise<NextResponse> {
  try {
    const { id } = params;

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = getAdminClient();

    // Check if virtual order (SL/Target/GTT attached to position)
    const isVirtualSl = id.startsWith('pos-sl-');
    const isVirtualTarget = id.startsWith('pos-target-');
    const isVirtualGtt = id.startsWith('pos-gtt-');

    if (isVirtualSl || isVirtualTarget || isVirtualGtt) {
      const positionId = id.replace('pos-sl-', '').replace('pos-target-', '').replace('pos-gtt-', '');
      
      let updateField: any = {};
      if (payload.stop_loss !== undefined) updateField.stop_loss = payload.stop_loss;
      if (payload.target !== undefined) updateField.target = payload.target;

      const { data, error } = await admin
        .from('positions')
        .update(updateField)
        .eq('id', positionId)
        .eq('user_id', user.id)
        .eq('status', 'open')
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: 'Could not update stop loss/target. The position might already be closed.' }, { status: 400 });
      }

      return NextResponse.json({ order: { id, ...data } });
    }

    // 1. Fetch existing order from DB to check status
    const { data: existingOrder, error: fetchErr } = await admin
      .from('orders')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (fetchErr || !existingOrder) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const statusUpper = (existingOrder.status || '').toUpperCase();
    if (statusUpper !== 'PENDING' && statusUpper !== 'TRIGGER_PENDING') {
      return NextResponse.json({ error: `Cannot modify order with status '${existingOrder.status}'. Only pending orders can be modified.` }, { status: 400 });
    }

    // 2. Determine target order type and check for Market transition
    const targetOrderType = (payload.order_type || existingOrder.order_type || '').toUpperCase();
    const isChangingToMarket = targetOrderType === 'MARKET';

    let fillPrice: number | null = null;
    let baseLtp: number | null = null;
    const currentLtp = Number(payload.frontend_ltp || existingOrder.ltp_at_entry || existingOrder.price || 0);

    if (isChangingToMarket) {
      // Resolve live market quote for immediate market execution
      let rawBid: number | null = null;
      let rawAsk: number | null = null;

      if (payload.frontend_ask && Number(payload.frontend_ask) > 0) rawAsk = Number(payload.frontend_ask);
      if (payload.frontend_bid && Number(payload.frontend_bid) > 0) rawBid = Number(payload.frontend_bid);
      if (payload.frontend_ltp && Number(payload.frontend_ltp) > 0) baseLtp = Number(payload.frontend_ltp);

      const kiteInst = existingOrder.kite_instrument || existingOrder.symbol || '';
      const symbol = existingOrder.symbol || '';
      const segment = existingOrder.segment || '';

      try {
        if (segment.toUpperCase().includes('CRYPTO') || ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'].some(c => symbol.toUpperCase().startsWith(c))) {
          const { fetchBinanceQuote } = await import('@/lib/datafeed/MarketDataService');
          const bQuote = await fetchBinanceQuote(symbol);
          if (bQuote) {
            baseLtp = bQuote.ltp;
            rawBid = bQuote.bid;
            rawAsk = bQuote.ask;
          }
        } else if (kiteInst) {
          const { fetchSpeedQuotes } = await import('@/lib/datafeed/MarketDataService');
          const quotes = await fetchSpeedQuotes([kiteInst]);
          if (quotes[kiteInst]) {
            baseLtp = quotes[kiteInst];
            rawBid = quotes[`${kiteInst}_bid`] ?? baseLtp;
            rawAsk = quotes[`${kiteInst}_ask`] ?? baseLtp;
          }
        }
      } catch (quoteErr) {
        console.warn('[handleModifyOrder] Failed to fetch live market quote, falling back:', quoteErr);
      }

      if (!baseLtp || baseLtp <= 0) {
        baseLtp = payload.price || existingOrder.price || existingOrder.trigger_price || existingOrder.ltp_at_entry || 0;
      }

      const side = existingOrder.side;
      if (side === 'BUY') {
        fillPrice = rawAsk && rawAsk > 0 ? rawAsk : baseLtp;
      } else {
        fillPrice = rawBid && rawBid > 0 ? rawBid : baseLtp;
      }
      if (fillPrice !== null) {
        fillPrice = Math.round(fillPrice * 100) / 100;
      }

      // Update existing order to EXECUTED
      const updateData: any = {
        updated_at: new Date().toISOString(),
        order_type: 'MARKET',
        status: 'EXECUTED',
        fill_price: fillPrice,
        price: fillPrice,
        trigger_price: null, // NEUTRALIZE OLD TRIGGER CONDITION
        stop_loss: payload.stop_loss !== undefined ? payload.stop_loss : null,
        target: payload.target !== undefined ? payload.target : null,
      };

      const { data: updatedOrder, error: updateErr } = await admin
        .from('orders')
        .update(updateData)
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single();

      if (updateErr) {
        return NextResponse.json({ error: updateErr.message || 'Failed to update order' }, { status: 500 });
      }

      // Trigger immediate position creation / netting via process_executed_position RPC
      const linkedInfo = existingOrder.info || null;
      const { error: rpcErr } = await admin.rpc('process_executed_position', {
        p_order_id: id,
        p_info: linkedInfo,
      });
      if (rpcErr) {
        console.error(`[handleModifyOrder] Failed process_executed_position RPC for order ${id}:`, rpcErr);
        // Rollback order state in DB to prevent orphaned EXECUTED order
        await admin
          .from('orders')
          .update({
            status: existingOrder.status,
            fill_price: existingOrder.fill_price,
            price: existingOrder.price,
            trigger_price: existingOrder.trigger_price,
            order_type: existingOrder.order_type,
          })
          .eq('id', id);

        return NextResponse.json({ error: rpcErr.message || 'Execution failed during market transition' }, { status: 400 });
      }

      return NextResponse.json({ success: true, order: updatedOrder, executed: true });
    }

    // --- NON-MARKET MODIFICATION: ATOMIC CANCEL & REPLACE LIFECYCLE ---
    console.log(`[EXEC_TRACE ${new Date().toISOString()}] MODIFY_START | Old Order ID: ${id} | Current Status: ${existingOrder.status} | Target Type: ${targetOrderType} | Payload:`, JSON.stringify(payload));

    const targetTriggerPrice = payload.trigger_price !== undefined ? payload.trigger_price : (payload.stop_loss !== undefined ? payload.stop_loss : existingOrder.trigger_price);
    const targetIsExit = payload.is_exit !== undefined ? Boolean(payload.is_exit) : Boolean(existingOrder.is_exit);
    const targetSide = existingOrder.side;

    if ((targetOrderType === 'SL' || targetOrderType === 'SLM') && targetTriggerPrice !== null && targetTriggerPrice !== undefined && currentLtp > 0) {
      const slErr = OrderService.validateStopLoss(targetOrderType, targetSide, Number(targetTriggerPrice), currentLtp, targetIsExit);
      if (slErr) {
        return NextResponse.json({ error: slErr }, { status: 400 });
      }
    }

    // Step A: Atomically mark old order (Order A) as CANCELLED to prevent race condition with order matching loop
    const cancelNote = existingOrder.info 
      ? `${existingOrder.info} (Modified to ${targetOrderType})`
      : `Modified to ${targetOrderType}`;

    console.log(`[EXEC_TRACE ${new Date().toISOString()}] OLD_ORDER_CANCEL_START | Old Order ID: ${id} | Status BEFORE: ${existingOrder.status} -> Status AFTER: CANCELLED`);

    const { data: cancelledOrder, error: cancelErr } = await admin
      .from('orders')
      .update({
        status: 'CANCELLED',
        info: cancelNote,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('status', existingOrder.status)
      .select()
      .single();

    if (cancelErr || !cancelledOrder) {
      console.error(`[EXEC_TRACE ${new Date().toISOString()}] OLD_ORDER_CANCEL_FAILED | Old Order ID: ${id} | Error:`, cancelErr);
      return NextResponse.json({ error: 'Could not modify order. It might already be executed or cancelled.' }, { status: 400 });
    }

    console.log(`[EXEC_TRACE ${new Date().toISOString()}] OLD_ORDER_CANCELLED_SUCCESS | Old Order ID: ${id}`);

    // Step B: Construct and insert replacement order (Order B) with status 'PENDING'
    const resolvedLinkedPosId = payload.linked_position_id || existingOrder.info || null;

    const newOrderPayload: any = {
      user_id: user.id,
      symbol: existingOrder.symbol,
      kite_instrument: existingOrder.kite_instrument || null,
      segment: existingOrder.segment || null,
      side: existingOrder.side,
      status: 'PENDING',
      qty: payload.qty !== undefined && Number(payload.qty) > 0 ? Number(payload.qty) : Number(existingOrder.qty),
      lots: payload.lots !== undefined && Number(payload.lots) > 0 ? Number(payload.lots) : Number(existingOrder.lots || 1),
      price: payload.price !== undefined && payload.price !== null ? Number(payload.price) : Number(existingOrder.price || currentLtp),
      fill_price: payload.price !== undefined && payload.price !== null ? Number(payload.price) : Number(existingOrder.fill_price || currentLtp),
      ltp_at_entry: currentLtp > 0 ? currentLtp : Number(existingOrder.ltp_at_entry || currentLtp),
      order_type: targetOrderType,
      product_type: existingOrder.product_type || 'INTRADAY',
      is_exit: targetIsExit,
      info: resolvedLinkedPosId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Explicitly set/clear fields based on targetOrderType to eliminate stale trigger state
    if (targetOrderType === 'GTT') {
      newOrderPayload.trigger_price = payload.trigger_price !== undefined && payload.trigger_price !== null ? Number(payload.trigger_price) : null;
      newOrderPayload.stop_loss = payload.stop_loss !== undefined && payload.stop_loss !== null ? Number(payload.stop_loss) : null;
      newOrderPayload.target = payload.target !== undefined && payload.target !== null ? Number(payload.target) : null;
    } else if (targetOrderType === 'SL' || targetOrderType === 'SLM') {
      newOrderPayload.trigger_price = payload.trigger_price !== undefined && payload.trigger_price !== null 
        ? Number(payload.trigger_price) 
        : (payload.stop_loss !== undefined && payload.stop_loss !== null ? Number(payload.stop_loss) : null);
      newOrderPayload.stop_loss = null; // Clear residual bracket fields
      newOrderPayload.target = null;
    } else {
      // LIMIT, etc.
      newOrderPayload.trigger_price = null;
      newOrderPayload.stop_loss = null;
      newOrderPayload.target = null;
    }

    console.log(`[EXEC_TRACE ${new Date().toISOString()}] NEW_ORDER_INSERT_START | Target Type: ${targetOrderType} | Payload:`, JSON.stringify(newOrderPayload));

    const { data: newOrder, error: insertErr } = await admin
      .from('orders')
      .insert(newOrderPayload)
      .select()
      .single();

    if (insertErr) {
      console.error(`[EXEC_TRACE ${new Date().toISOString()}] NEW_ORDER_INSERT_FAILED | Error:`, insertErr);
      // Restore Order A back to PENDING so user doesn't lose their pending order
      await admin
        .from('orders')
        .update({ status: existingOrder.status, info: existingOrder.info })
        .eq('id', id);

      return NextResponse.json({ error: insertErr.message || 'Failed to create replacement order' }, { status: 500 });
    }

    console.log(`[EXEC_TRACE ${new Date().toISOString()}] NEW_ORDER_INSERTED_SUCCESS | New Order ID: ${newOrder.id} | Status: ${newOrder.status} | Type: ${newOrder.order_type}`);

    return NextResponse.json({
      success: true,
      order: newOrder,
      old_order_id: id,
      executed: false
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

async function handleCancelOrder(
  request: NextRequest,
  params: { id: string },
  clientIp: string,
  user: any,
  payload: any
): Promise<NextResponse> {
  try {
    const { id } = params;
    const { status } = payload || {};

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (status !== 'CANCELLED') {
      return NextResponse.json({ error: 'Invalid status update' }, { status: 400 });
    }

    const admin = getAdminClient();

    // Check if virtual order (SL/Target/GTT attached to position)
    const isVirtualSl = id.startsWith('pos-sl-');
    const isVirtualTarget = id.startsWith('pos-target-');
    const isVirtualGtt = id.startsWith('pos-gtt-');

    if (isVirtualSl || isVirtualTarget || isVirtualGtt) {
      const positionId = id.replace('pos-sl-', '').replace('pos-target-', '').replace('pos-gtt-', '');
      
      let updateField: any = {};
      if (isVirtualSl) updateField = { stop_loss: null };
      else if (isVirtualTarget) updateField = { target: null };
      else if (isVirtualGtt) updateField = { stop_loss: null, target: null };

      const { data, error } = await admin
        .from('positions')
        .update(updateField)
        .eq('id', positionId)
        .eq('user_id', user.id)
        .eq('status', 'open')
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: 'Could not cancel stop loss/target. The position might already be closed.' }, { status: 400 });
      }

      return NextResponse.json({
        order: {
          id,
          status: 'CANCELLED',
        }
      });
    }

    // Update order status if it's still PENDING
    const { data, error } = await admin
      .from('orders')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('status', 'PENDING')
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: 'Could not cancel order. It might already be executed or cancelled.' }, { status: 400 });
    }

    return NextResponse.json({ order: data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
