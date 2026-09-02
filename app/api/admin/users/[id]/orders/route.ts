/**
 * GET /api/admin/users/[id]/orders
 *
 * Returns orders for a given user, with optional tab filtering, symbol search,
 * date range, and pagination.
 */

import { requireAdmin } from '../../../_auth';
import { sanitizeOrderInfo } from '@/lib/trading/orderSanitizer';

export type OrderItem = {
  id: string;
  user_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'EXECUTED' | 'CANCELLED' | 'REJECTED' | 'PENDING';
  qty: number;
  price: number;
  order_type: 'MARKET' | 'LIMIT';
  info: string;
  time: string;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    const url = new URL(request.url);
    const tab       = url.searchParams.get('tab') ?? null;
    const search    = url.searchParams.get('search') ?? null;
    const rowsParam = url.searchParams.get('rows') ?? null;
    const pageParam = url.searchParams.get('page') ?? '1';
    const dateFrom  = url.searchParams.get('dateFrom') ?? null;
    const dateTo    = url.searchParams.get('dateTo') ?? null;
    const rows      = rowsParam ? Math.min(parseInt(rowsParam, 10), 500) : 50;
    const page      = Math.max(1, parseInt(pageParam, 10));

    let query = adminClient
      .from('orders')
      .select('id, user_id, symbol, side, status, qty, price, order_type, info, created_at', { count: 'exact' })
      .eq('user_id', id)
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

    if (search) {
      query = query.ilike('symbol', `%${search}%`);
    }

    if (dateFrom) {
      query = query.gte('created_at', dateFrom);
    }
    if (dateTo) {
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

    const orders: OrderItem[] = (data ?? []).map(
      (row: {
        id: string;
        user_id: string;
        symbol: string;
        side: string;
        status: string;
        qty: number;
        price: number;
        order_type: string;
        info: string | null;
        created_at: string;
      }) => ({
        id: row.id,
        user_id: row.user_id,
        symbol: row.symbol,
        side: row.side as 'BUY' | 'SELL',
        status: row.status as 'EXECUTED' | 'CANCELLED' | 'REJECTED' | 'PENDING',
        qty: row.qty,
        price: row.price,
        order_type: row.order_type as 'MARKET' | 'LIMIT',
        info: sanitizeOrderInfo(row.info) ?? '',
        time: row.created_at,
      }),
    );

    // Return in same shape as global endpoint so the frontend handles both uniformly
    return Response.json({ orders, total: count ?? orders.length }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
