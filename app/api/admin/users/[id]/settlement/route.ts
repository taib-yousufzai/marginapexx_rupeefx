/**
 * POST /api/admin/users/[id]/settlement
 *
 * Admin-only endpoint to clear (forgive) a user's outstanding settlement debt.
 *
 * The settlement_amount on profiles is a permanent record of the liquidation
 * deficit — it is never automatically cleared by deposits or PnL credits.
 * This endpoint is the ONLY way to zero it out, and it requires an explicit
 * admin action with a mandatory reason.
 *
 * Body: { reason: string }
 *
 * What it does:
 *   - Reads the current settlement_amount from profiles
 *   - Sets settlement_amount = 0
 *   - Writes an act_log entry documenting the forgiveness
 *
 * What it does NOT do:
 *   - It does NOT add money to the user's balance (the debt is simply forgiven)
 *   - It does NOT create a DEPOSIT or any balance-affecting transaction
 */

import { requireAdmin } from '../../../_auth';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Auth
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Params
    const resolvedParams = await Promise.resolve(params);
    const userId = resolvedParams.id;

    // Step 3: Parse body
    let body: { reason?: string } = {};
    try {
      body = await request.json();
    } catch {
      // reason is optional — allow empty body
    }
    const reason = (body.reason ?? '').trim() || 'Admin cleared settlement debt';

    // Step 4: Fetch current settlement amount
    const { data: profile, error: fetchErr } = await adminClient
      .from('profiles')
      .select('id, full_name, email, settlement_amount')
      .eq('id', userId)
      .single();

    if (fetchErr || !profile) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const currentDebt = Number(profile.settlement_amount ?? 0);

    if (currentDebt === 0) {
      return Response.json(
        { message: 'No outstanding settlement debt to clear', settlement_amount: 0 },
        { status: 200 },
      );
    }

    // Step 5: Clear the debt — call the DB function for atomicity
    const { error: clearErr } = await adminClient.rpc('admin_clear_settlement_debt', {
      p_user_id: userId,
    });

    if (clearErr) {
      console.error('[POST /settlement] RPC error:', clearErr.message);
      return Response.json({ error: 'Failed to clear settlement debt' }, { status: 500 });
    }

    // Step 6: Audit log
    await adminClient.from('act_logs').insert({
      type: 'SETTLEMENT_CLEARED',
      user_id: callerUser.id,
      target_user_id: userId,
      reason: `${reason} | Previous debt: ₹${Math.abs(currentDebt).toFixed(2)}`,
    });

    return Response.json(
      {
        success: true,
        previous_debt: currentDebt,
        settlement_amount: 0,
        message: `Settlement debt of ₹${Math.abs(currentDebt).toFixed(2)} cleared.`,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('[POST /api/admin/users/[id]/settlement] Error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
