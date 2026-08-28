import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { logAction, extractClientIp } from '@/lib/actionLogger';

/**
 * PATCH /api/orders/[id]
 * Handles order updates (Cancel if payload.status === 'CANCELLED', otherwise Modify).
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

  let response: NextResponse;
  let actionType: 'CANCEL_ORDER' | 'MODIFY_ORDER' = 'MODIFY_ORDER';

  if (payload?.status === 'CANCELLED') {
    actionType = 'CANCEL_ORDER';
    response = await handleCancelOrder(request, { id }, ipAddress, user, payload);
  } else {
    response = await handleModifyOrder(request, { id }, ipAddress, user, payload);
  }

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
    actionType,
    module: 'TRADING',
    apiEndpoint: '/api/orders/[id]',
    httpMethod: 'PATCH',
    ipAddress,
    requestPayload: payload,
    responseStatus: response.status,
    isSuccess: response.ok,
    errorMessage,
  });

  return response;
}

/**
 * PUT /api/orders/[id]
 * Modifies an existing PENDING order in place.
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
  } catch {}

  const user = await getUserFromRequest(request);
  const response = await handleModifyOrder(request, { id }, ipAddress, user, payload);

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
    errorMessage,
  });

  return response;
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

      const { error } = await admin
        .from('positions')
        .update(updateField)
        .eq('id', positionId)
        .eq('user_id', user.id)
        .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
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

async function handleModifyOrder(
  request: NextRequest,
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

    if (!payload || typeof payload !== 'object') {
      return NextResponse.json({ error: 'Payload must be a valid JSON object' }, { status: 400 });
    }

    const admin = getAdminClient();

    // Check if virtual order (SL/Target/GTT attached to position)
    const isVirtualSl = id.startsWith('pos-sl-');
    const isVirtualTarget = id.startsWith('pos-target-');
    const isVirtualGtt = id.startsWith('pos-gtt-');

    if (isVirtualSl || isVirtualTarget || isVirtualGtt) {
      const positionId = id.replace('pos-sl-', '').replace('pos-target-', '').replace('pos-gtt-', '');
      
      let updateField: any = {};
      if (isVirtualSl) {
        updateField.stop_loss = payload.stop_loss ?? payload.trigger_price ?? null;
      } else if (isVirtualTarget) {
        updateField.target = payload.target ?? payload.client_price ?? payload.price ?? null;
      } else if (isVirtualGtt) {
        updateField.stop_loss = payload.stop_loss ?? null;
        updateField.target = payload.target ?? null;
      }

      const { data: posData, error: posError } = await admin
        .from('positions')
        .update(updateField)
        .eq('id', positionId)
        .eq('user_id', user.id)
        .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
        .select()
        .single();

      if (posError || !posData) {
        return NextResponse.json({ error: 'Could not modify virtual order. The position might already be closed.' }, { status: 400 });
      }

      return NextResponse.json({
        success: true,
        order: {
          id,
          status: 'PENDING',
          stop_loss: posData.stop_loss,
          target: posData.target,
        }
      });
    }

    // Real order modification logic
    const { data: existingOrder, error: fetchErr } = await admin
      .from('orders')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (fetchErr || !existingOrder) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (existingOrder.status !== 'PENDING') {
      return NextResponse.json({
        error: `Order cannot be modified. Current status: ${existingOrder.status}`
      }, { status: 400 });
    }

    // Build update fields for pending order
    const updates: Record<string, any> = {
      updated_at: new Date().toISOString()
    };

    if (payload.client_price !== undefined) {
      const p = payload.client_price !== null ? Number(payload.client_price) : null;
      updates.price = p;
      updates.fill_price = p;
    } else if (payload.price !== undefined) {
      const p = payload.price !== null ? Number(payload.price) : null;
      updates.price = p;
      updates.fill_price = p;
    }

    if (payload.trigger_price !== undefined) {
      updates.trigger_price = payload.trigger_price !== null ? Number(payload.trigger_price) : null;
    }

    if (payload.stop_loss !== undefined) {
      updates.stop_loss = payload.stop_loss !== null ? Number(payload.stop_loss) : null;
    }

    if (payload.target !== undefined) {
      updates.target = payload.target !== null ? Number(payload.target) : null;
    }

    if (payload.qty !== undefined) {
      const parsedQty = Number(payload.qty);
      if (isNaN(parsedQty) || parsedQty <= 0) {
        return NextResponse.json({ error: 'Quantity must be greater than zero.' }, { status: 400 });
      }
      updates.qty = parsedQty;
    }

    if (payload.lots !== undefined) {
      const parsedLots = Number(payload.lots);
      if (!isNaN(parsedLots) && parsedLots > 0) {
        updates.lots = parsedLots;
      }
    }

    if (payload.order_type !== undefined) {
      updates.order_type = payload.order_type;
    }

    const { data: updatedOrder, error: updateErr } = await admin
      .from('orders')
      .update(updates)
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('status', 'PENDING')
      .select()
      .single();

    if (updateErr || !updatedOrder) {
      console.error('Update error:', updateErr);
      return NextResponse.json({
        error: `Order modification failed: ${updateErr?.message || 'Order may have executed or cancelled concurrently.'}`
      }, { status: 400 });
    }

    // If modified to MARKET — execute immediately (don't wait for ticker)
    if (updatedOrder.order_type === 'MARKET') {
      // For SL orders, price/fill_price may be null — fall back to trigger_price or ltp_at_entry
      const fillPrice =
        Number(updatedOrder.price || 0) ||
        Number(updatedOrder.fill_price || 0) ||
        Number(updatedOrder.trigger_price || 0) ||
        Number(updatedOrder.ltp_at_entry || 0) ||
        0;

      if (!fillPrice) {
        console.error('[Modify→MARKET] Cannot execute: no valid fill price found for order', id);
        return NextResponse.json({
          success: true,
          order: updatedOrder,
          warning: 'Order modified but could not auto-execute: no price available. Ticker will pick it up.'
        });
      }

      // Mark as EXECUTED immediately
      const { error: execErr } = await admin
        .from('orders')
        .update({
          status: 'EXECUTED',
          fill_price: fillPrice,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'PENDING');

      if (execErr) {
        console.error('[Modify→MARKET] Failed to mark order as EXECUTED:', execErr);
        return NextResponse.json({
          success: true,
          order: updatedOrder,
          warning: `Order modified but auto-execute failed: ${execErr.message}`
        });
      }

      // Call process_executed_position to create/close the position
      const linkedInfo = updatedOrder.info || null;
      const { error: rpcErr } = await admin.rpc('process_executed_position', {
        p_order_id: id,
        p_info: linkedInfo,
      });

      if (rpcErr) {
        console.error('[Modify→MARKET] RPC error:', rpcErr);
        return NextResponse.json({
          success: false,
          error: `Order executed but position processing failed: ${rpcErr.message}`
        }, { status: 500 });
      }

      console.log(`[Modify→MARKET] Order ${id} executed instantly at fill_price: ${fillPrice}, linked pos: ${linkedInfo}`);
    }

    return NextResponse.json({
      success: true,
      order: updatedOrder
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

