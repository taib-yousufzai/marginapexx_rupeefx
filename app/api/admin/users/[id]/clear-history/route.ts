/**
 * POST /api/admin/users/[id]/clear-history
 *
 * Super Admin / Admin endpoint to clear historical trading records for a user.
 * Sets profiles.history_reset_at = now() for the specified user.
 *
 * Immutability Guarantee:
 * - Wallet balance, ledger transactions, deposits, withdrawals, and realized P&L are UNCHANGED.
 * - Active open positions and pending orders are UNCHANGED.
 * - History view and weekly metrics will exclude pre-reset closed trades/orders.
 */

import { requireSuperAdmin } from '@/app/api/admin/_auth';
import { auditLog } from '../../../../../../lib/audit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // 1. Authenticate and authorize caller (must be super_admin)
    const authResult = await requireSuperAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // 2. Resolve target user ID
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    if (!id) {
      return Response.json({ error: 'Missing user ID' }, { status: 400 });
    }

    const resetTimestamp = new Date().toISOString();

    if (id === 'all') {
      const { data: updatedProfiles, error: updateError } = await adminClient
        .from('profiles')
        .update({ history_reset_at: resetTimestamp })
        .neq('id', '00000000-0000-0000-0000-000000000000')
        .select('id');

      if (updateError) {
        return Response.json({ error: 'Failed to clear history for all users' }, { status: 500 });
      }

      await auditLog(adminClient, callerUser.id, callerUser.id, 'Clear History All Users', {
        history_reset_at: resetTimestamp,
        affected_users_count: (updatedProfiles ?? []).length,
      });

      return Response.json({
        success: true,
        user_id: 'all',
        affected_count: (updatedProfiles ?? []).length,
        history_reset_at: resetTimestamp,
      }, { status: 200 });
    }

    // 3. Set history_reset_at on single user profile
    const { data: profileData, error: profileError } = await adminClient
      .from('profiles')
      .update({ history_reset_at: resetTimestamp })
      .eq('id', id)
      .select('id, client_id, email, history_reset_at')
      .single();

    if (profileError || !profileData) {
      return Response.json({ error: 'User profile not found' }, { status: 404 });
    }

    // 4. Invalidate caches
    try {
      const { invalidateUserProfile, invalidateUserPositionsCache, invalidateUserOrdersCache } = await import('@/lib/redisSettingsCache');
      const { invalidateUserHistoryCache } = await import('@/lib/redisHistoryCache');
      await Promise.all([
        invalidateUserProfile(id),
        invalidateUserPositionsCache(id),
        invalidateUserOrdersCache(id),
        invalidateUserHistoryCache(id),
      ]);
    } catch (_) {}

    // 5. Audit log
    await auditLog(adminClient, callerUser.id, id, 'Clear History', {
      history_reset_at: resetTimestamp,
      client_id: profileData.client_id,
      email: profileData.email,
    });

    return Response.json({
      success: true,
      user_id: id,
      history_reset_at: resetTimestamp,
    }, { status: 200 });

  } catch (err: any) {
    console.error('[POST /api/admin/users/[id]/clear-history] Unexpected error:', err);
    return Response.json({ error: 'Internal server error', detail: err?.message }, { status: 500 });
  }
}
