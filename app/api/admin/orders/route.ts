/**
 * GET  /api/admin/orders  — list all orders platform-wide (with filters)
 * POST /api/admin/orders/square-off-all — force-close all open positions
 * POST /api/admin/orders/cancel-all     — cancel all pending LIMIT orders
 */

import { requireAdmin } from '../_auth';
import { getRole } from '../../../../lib/auth';
import { getDescendantUserIds } from '../../../../lib/hierarchy';
import { sanitizeOrderInfo } from '@/lib/trading/orderSanitizer';

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    const url = new URL(request.url);
    const tab        = url.searchParams.get('tab') ?? null;
    const search     = url.searchParams.get('search') ?? null;
    const dateFrom   = url.searchParams.get('dateFrom') ?? null;
    const dateTo     = url.searchParams.get('dateTo') ?? null;
    const rowsParam  = url.searchParams.get('rows') ?? null;
    const pageParam  = url.searchParams.get('page') ?? '1';
    const demoParam  = url.searchParams.get('demo');
    const isDemo     = demoParam === 'true';
    const rows       = rowsParam ? Math.min(parseInt(rowsParam, 10), 500) : 50;
    const page       = Math.max(1, parseInt(pageParam, 10));

    const callerRole = getRole(callerUser);
    const callerId = callerUser.id;

    // Fetch allowed profiles based on caller's role hierarchy
    let pQuery = adminClient.from('profiles').select('id, email, full_name, client_id').eq('demo_user', isDemo);
    if (callerRole === 'broker') {
      pQuery = pQuery.eq('parent_id', callerId);
    } else if (callerRole === 'admin') {
      const descendantIds = await getDescendantUserIds(adminClient, callerId, callerRole);
      if (descendantIds !== null) {
        if (descendantIds.length === 0) {
          return Response.json({ orders: [], total: 0 }, { status: 200 });
        }
        pQuery = pQuery.in('id', descendantIds);
      }
    }
    const { data: profiles } = await pQuery;

    const profileMap: Record<string, { full_name: string; email: string; client_id: string }> = {};
    (profiles ?? []).forEach((p: any) => { profileMap[p.id] = p; });

    let query = adminClient
      .from('orders')
      .select('id, user_id, symbol, side, status, qty, price, order_type, info, created_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (tab === 'executed') {
      query = query.eq('status', 'EXECUTED');
    } else if (tab === 'limit') {
      query = query.eq('status', 'CANCELLED').eq('order_type', 'LIMIT');
    } else if (tab === 'rejected') {
      query = query.eq('status', 'REJECTED');
    } else if (tab === 'pending') {
      query = query.eq('status', 'PENDING').eq('order_type', 'LIMIT');
    }

    // If search looks like a user name or client_id (not a symbol), resolve matching user_ids first
    let userIdFilter: string[] | null = null;
    if (search) {
      const q = search.toLowerCase();
      // Check if any profile matches by name or client_id
      const matchingUserIds = (profiles ?? [])
        .filter((p: any) =>
          (p.full_name && p.full_name.toLowerCase().includes(q)) ||
          (p.client_id && p.client_id.toLowerCase().includes(q)) ||
          (p.email && p.email.toLowerCase().includes(q))
        )
        .map((p: any) => p.id);

      if (matchingUserIds.length > 0) {
        // Search matches user profiles — filter by those user_ids OR by symbol
        userIdFilter = matchingUserIds;
        query = query.or(`symbol.ilike.%${search}%,user_id.in.(${matchingUserIds.join(',')})`);
      } else {
        // No profile match — just search by symbol as before, but still restrict to demo/live users
        query = query.ilike('symbol', `%${search}%`);
      }
    }
    
    // Ensure we only fetch orders for users matching the demo environment
    if (!userIdFilter) {
      const allowedUserIds = (profiles ?? []).map((p: any) => p.id);
      if (allowedUserIds.length > 0) {
        query = query.in('user_id', allowedUserIds);
      } else {
        return Response.json({ orders: [], total: 0 }, { status: 200 });
      }
    }

    if (dateFrom) {
      query = query.gte('created_at', dateFrom);
    }
    if (dateTo) {
      // Add 1 day so "to" date is inclusive
      const toDate = new Date(dateTo);
      toDate.setDate(toDate.getDate() + 1);
      query = query.lt('created_at', toDate.toISOString());
    }

    const from = (page - 1) * rows;
    const to   = from + rows - 1;
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Merge profile info into each order
    const merged = (data ?? []).map((r: any) => ({
      ...r,
      info: sanitizeOrderInfo(r.info) ?? '',
      user_name: profileMap[r.user_id]?.full_name || profileMap[r.user_id]?.email || r.user_id,
      user_client_id: profileMap[r.user_id]?.client_id || '',
    }));

    return Response.json({ orders: merged, total: count ?? 0 }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
