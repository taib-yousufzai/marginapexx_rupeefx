import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { logAction, extractClientIp } from '@/lib/actionLogger';

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
    if (isChangingToMarket) {
      // Resolve live market quote for immediate market execution
      let baseLtp: number | null = null;
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
      fillPrice = Math.round(fillPrice * 100) / 100;
    }

    // 3. Prepare update payload
    const updateData: any = {
      updated_at: new Date().toISOString(),
    };

    if (payload.order_type !== undefined) {
      updateData.order_type = payload.order_type;
    }

    if (isChangingToMarket) {
      updateData.status = 'EXECUTED';
      updateData.fill_price = fillPrice;
      updateData.price = fillPrice;
      updateData.trigger_price = null; // ATOMICALLY NEUTRALIZE OLD GTT TRIGGER CONDITION
      updateData.stop_loss = payload.stop_loss !== undefined ? payload.stop_loss : existingOrder.stop_loss;
      updateData.target = payload.target !== undefined ? payload.target : existingOrder.target;
    } else {
      if (payload.price !== undefined && payload.price !== null) {
        updateData.price = payload.price;
        updateData.fill_price = payload.price;
      }
      if (payload.trigger_price !== undefined) {
        updateData.trigger_price = payload.trigger_price;
      }
      if (payload.stop_loss !== undefined) {
        updateData.stop_loss = payload.stop_loss;
      }
      if (payload.target !== undefined) {
        updateData.target = payload.target;
      }
    }

    if (payload.qty !== undefined && payload.qty > 0) {
      updateData.qty = payload.qty;
    }
    if (payload.lots !== undefined && payload.lots > 0) {
      updateData.lots = payload.lots;
    }

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

    // 4. If transitioning to Market, trigger immediate position creation via process_executed_position RPC
    if (isChangingToMarket) {
      const linkedInfo = existingOrder.linked_position_id || existingOrder.info || null;
      const { error: rpcErr } = await admin.rpc('process_executed_position', {
        p_order_id: id,
        p_info: linkedInfo,
      });
      if (rpcErr) {
        console.error(`[handleModifyOrder] Failed process_executed_position RPC for order ${id}:`, rpcErr);
      }
    }

    return NextResponse.json({ success: true, order: updatedOrder, executed: isChangingToMarket });
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
