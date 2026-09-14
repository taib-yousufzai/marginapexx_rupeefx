import { requireAdmin } from '../../../_auth';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    const { data: position, error: fetchError } = await adminClient
      .from('positions')
      .select('id, user_id, symbol, qty_total, status')
      .eq('id', id)
      .eq('status', 'closed')
      .single();

    if (fetchError || !position) {
      return Response.json({ error: 'Position not found or is not closed' }, { status: 404 });
    }

    const { error: txError } = await adminClient
      .from('transactions')
      .delete()
      .eq('ref_id', position.id)
      .in('type', ['PNL_CREDIT', 'PNL_DEBIT']);

    if (txError) {
      console.error('[POST /api/admin/positions/[id]/reopen] TX Delete Error:', txError);
      return Response.json({ error: 'Failed to revert PnL transaction' }, { status: 500 });
    }

    const { error: updateError } = await adminClient
      .from('positions')
      .update({
        status: 'open',
        qty_open: position.qty_total,
        exit_price: null,
        exit_time: null,
        pnl: 0,
        updated_at: new Date().toISOString()
      })
      .eq('id', position.id);

    if (updateError) {
      console.error('[POST /api/admin/positions/[id]/reopen] Position Update Error:', updateError);
      return Response.json({ error: 'Failed to reopen position' }, { status: 500 });
    }

    await adminClient.from('act_logs').insert({
      type: 'ADMIN_ACTION',
      user_id: callerUser.id,
      target_user_id: position.user_id,
      reason: `Reopened closed position for ${position.symbol}`,
      created_at: new Date().toISOString(),
    });

    return Response.json(
      { success: true, message: 'Position successfully reopened' },
      { status: 200 }
    );

  } catch (err) {
    console.error('[POST /api/admin/positions/[id]/reopen] Error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
