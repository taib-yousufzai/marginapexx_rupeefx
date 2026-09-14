/**
 * POST /api/admin/orders/cancel-all
 * Cancels ALL pending LIMIT orders platform-wide (emergency risk control).
 */
import { requireAdmin } from '../../_auth';

export async function POST(request: Request): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Cancel all PENDING LIMIT orders
    const { data, error } = await adminClient
      .from('orders')
      .update({ status: 'CANCELLED', info: 'Admin Cancel All', updated_at: new Date().toISOString() })
      .eq('status', 'PENDING')
      .eq('order_type', 'LIMIT')
      .select('id');

    if (error) {
      console.error('[cancel-all]', error.message);
      return Response.json({ error: 'Failed to cancel orders' }, { status: 500 });
    }

    // Log the admin action (correct table: act_logs)
    await adminClient.from('act_logs').insert({
      type: 'ADMIN_CANCEL_ALL',
      user_id: callerUser.id,
      target_user_id: callerUser.id,
      reason: 'Admin emergency cancel all pending orders',
    });

    return Response.json({ cancelled: (data ?? []).length }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
