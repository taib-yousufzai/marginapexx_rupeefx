/**
 * GET    /api/admin/users/[id]/block-scripts
 * POST   /api/admin/users/[id]/block-scripts
 * DELETE /api/admin/users/[id]/block-scripts
 */

import { requireAdmin } from '../../../_auth';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const resolvedParams = await Promise.resolve(params);
    const userId = resolvedParams.id;

    // 1. Fetch blocked symbols
    const { data: symbols, error: sError } = await adminClient
      .from('user_blocked_scripts')
      .select('symbol')
      .eq('user_id', userId);

    // 2. Fetch blocked segments (trade_allowed = false)
    const { data: segments, error: segError } = await adminClient
      .from('segment_settings')
      .select('segment')
      .eq('user_id', userId)
      .eq('trade_allowed', false);

    if (sError || segError) {
      console.error('[GET block-scripts] Error:', sError?.message || segError?.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    return Response.json({
      symbols: symbols?.map(d => d.symbol) || [],
      segments: Array.from(new Set(segments?.map(d => d.segment) || [])),
    }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const resolvedParams = await Promise.resolve(params);
    const userId = resolvedParams.id;

    const body = await request.json();
    const { symbol, segment } = body;

    if (symbol) {
      // Block specific symbol
      const { error } = await adminClient
        .from('user_blocked_scripts')
        .upsert({ user_id: userId, symbol }, { onConflict: 'user_id, symbol' });
      if (error) throw error;
    } else if (segment) {
      // Block entire segment (both BUY and SELL)
      const { error: errorBuy } = await adminClient
        .from('segment_settings')
        .upsert({ user_id: userId, segment, side: 'BUY', trade_allowed: false }, { onConflict: 'user_id, segment, side' });
      const { error: errorSell } = await adminClient
        .from('segment_settings')
        .upsert({ user_id: userId, segment, side: 'SELL', trade_allowed: false }, { onConflict: 'user_id, segment, side' });
      if (errorBuy || errorSell) throw errorBuy || errorSell;
    }

    return Response.json({ success: true }, { status: 201 });
  } catch (error: any) {
    console.error('[POST block-scripts] Error:', error.message);
    return Response.json({ error: 'Failed to block script/segment' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const resolvedParams = await Promise.resolve(params);
    const userId = resolvedParams.id;

    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const segment = searchParams.get('segment');

    if (symbol) {
      const { error } = await adminClient
        .from('user_blocked_scripts')
        .delete()
        .eq('user_id', userId)
        .eq('symbol', symbol);
      if (error) throw error;
    } else if (segment) {
      // Unblock segment (set trade_allowed to true)
      const { error: errorBuy } = await adminClient
        .from('segment_settings')
        .update({ trade_allowed: true })
        .eq('user_id', userId)
        .eq('segment', segment);
      if (errorBuy) throw errorBuy;
    } else {
      return Response.json({ error: 'Missing symbol or segment' }, { status: 400 });
    }

    return Response.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error('[DELETE block-scripts] Error:', error.message);
    return Response.json({ error: 'Failed to unblock script/segment' }, { status: 500 });
  }
}
