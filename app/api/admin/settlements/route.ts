import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/adminClient';

/**
 * GET /api/admin/settlements
 * 
 * Retrieves settlement records for admin visibility.
 * Query params:
 *   - user_id (optional): Filter by user ID
 *   - limit (optional, default 50): Number of records to return
 *   - offset (optional, default 0): Pagination offset
 */
export async function GET(req: NextRequest) {
  const admin = getAdminClient();

  // Auth check — verify the caller is an admin/broker
  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify role
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'broker', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { getDescendantUserIds } = await import('@/lib/hierarchy');
  const descendantIds = await getDescendantUserIds(admin, user.id, profile.role);

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('user_id');
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  if (descendantIds !== null && descendantIds.length === 0) {
    return NextResponse.json({
      settlements: [],
      total: 0,
      limit,
      offset,
    });
  }

  let query = admin
    .from('settlement_records')
    .select(`
      id,
      user_id,
      settlement_amount,
      liquidation_event,
      previous_balance,
      final_loss,
      positions_closed,
      notes,
      created_at,
      profiles!inner(email, full_name, client_id)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (descendantIds !== null) {
    query = query.in('user_id', descendantIds);
  }

  if (userId) {
    query = query.eq('user_id', userId);
  }


  const { data, error, count } = await query;

  if (error) {
    console.error('[GET /api/admin/settlements] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch settlement records' }, { status: 500 });
  }

  return NextResponse.json({
    settlements: data || [],
    total: count || 0,
    limit,
    offset,
  });
}
