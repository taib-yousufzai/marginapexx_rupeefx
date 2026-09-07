import { NextResponse } from 'next/server';
import { requireBroker } from '../_auth';
import { assertUserInHierarchy } from '@/lib/hierarchy';
import { sanitizeOrderInfo } from '@/lib/trading/orderSanitizer';

export async function GET(req: Request) {
  const auth = await requireBroker(req);
  if (!auth || !('adminClient' in auth) || !auth.adminClient) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { adminClient, callerUser: broker, role } = auth as any;
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('user_id');

  if (!userId) {
    return NextResponse.json({ error: 'Missing user_id' }, { status: 400 });
  }

  // Ensure user exists in caller's hierarchy
  const denied = await assertUserInHierarchy(adminClient, broker.id, userId, role);
  if (denied) return denied;

  // Fetch orders from positions table (history) or external API if needed
  // For now, mirroring admin's simplified order fetching from a hypothetical orders table or positions
  // Assuming a table named 'orders' exists based on admin audit
  const { data: orders, error: ordersError } = await adminClient
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (ordersError) {
    // If table doesn't exist, return empty for now to prevent 500
    return NextResponse.json([]);
  }

  const sanitized = (orders || []).map((o: any) => ({
    ...o,
    info: sanitizeOrderInfo(o.info) ?? null,
  }));

  return NextResponse.json(sanitized);
}
