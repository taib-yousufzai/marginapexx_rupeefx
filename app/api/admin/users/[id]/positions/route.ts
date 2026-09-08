/**
 * GET /api/admin/users/[id]/positions
 *
 * Returns positions for a given user, with optional tab filtering, symbol search,
 * and pagination.
 *
 * Validates: Requirements 7.1–7.6, 12.1–12.6
 */

import { requireAdmin } from '../../../_auth';
import { getRole } from '../../../../../../lib/auth';
import { assertUserInHierarchy, getDescendantUserIds } from '@/lib/hierarchy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PositionItem = {
  id: string;
  user_id: string;
  profiles?: { email: string; client_id?: string; full_name?: string } | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'open' | 'active' | 'closed';
  pnl: number;
  qty_open: number;
  qty_total: number;
  avg_price: number;
  entry_price: number;
  ltp: number | null;
  exit_price: number | null;
  duration_seconds: number;
  brokerage: number;
  sl: number | null;
  tp: number | null;
  entry_time: string;
  exit_time: string | null;
  settlement: string | null;
};

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 12.1–12.6
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;
    const callerRole = getRole(callerUser);

    // Step 2: Resolve params
    const { id } = await params;

    // Step 3: Parse query params
    // Validates: Requirements 7.3–7.6
    const url = new URL(request.url);
    const tab = url.searchParams.get('tab') ?? null;
    const search = url.searchParams.get('search') ?? null;
    const startDate = url.searchParams.get('start_date') ?? null;
    const endDate = url.searchParams.get('end_date') ?? null;
    const rowsParam = url.searchParams.get('rows') ?? null;
    const pageParam = url.searchParams.get('page') ?? null;
    const demoParam = url.searchParams.get('demo');
    const isDemo = demoParam === 'true';
    const rows = rowsParam ? parseInt(rowsParam, 10) : 100;
    const page = pageParam ? parseInt(pageParam, 10) : 0;

    // Step 4: Build query — filter by user_id, select all PositionItem fields
    // Validates: Requirement 7.2
    let query = adminClient
      .from('positions')
      .select(
        'id, user_id, symbol, side, status, pnl, qty_open, qty_total, avg_price, entry_price, ltp, exit_price, duration_seconds, brokerage, sl, tp, entry_time, exit_time, settlement, profiles(email, client_id, full_name)',
      );

    if (id !== 'all') {
      const denied = await assertUserInHierarchy(adminClient, callerUser.id, id, callerRole);
      if (denied) return denied;
      query = query.eq('user_id', id);
    } else {
      const descendantIds = await getDescendantUserIds(adminClient, callerUser.id, callerRole);
      let pQuery = adminClient.from('profiles').select('id').eq('demo_user', isDemo);

      if (!isDemo && descendantIds !== null) {
        if (descendantIds.length === 0) {
          return Response.json([], { status: 200 });
        }
        pQuery = pQuery.in('id', descendantIds);
      }

      const { data: matchedUsers } = await pQuery;
      const matchedIds = matchedUsers?.map((u: { id: string }) => u.id) || [];
      if (matchedIds.length === 0) {
         return Response.json([], { status: 200 });
      }
      query = query.in('user_id', matchedIds);
    }

    // Step 5: Apply tab filter
    // Validates: Requirements 7.3, 7.4, 7.5
    if (tab === 'open' || tab === 'active') {
      query = query.in('status', ['open', 'OPEN', 'active', 'ACTIVE']);
    } else if (tab === 'closed') {
      query = query.in('status', ['closed', 'CLOSED']);
      if (id !== 'all') {
        const { data: uProfile } = await adminClient
          .from('profiles')
          .select('history_reset_at')
          .eq('id', id)
          .maybeSingle();
        if (uProfile?.history_reset_at) {
          query = query.gt('updated_at', uProfile.history_reset_at);
        }
      }
    }
    // default (no tab) → no status filter

    // Step 6: Apply symbol search filter
    if (search) {
      query = query.ilike('symbol', `%${search}%`);
    }

    // Apply date range filters
    if (startDate) {
      query = query.gte('entry_time', startDate + 'T00:00:00.000Z');
    }
    if (endDate) {
      query = query.lte('entry_time', endDate + 'T23:59:59.999Z');
    }

    // Apply newest to oldest sorting
    if (tab === 'closed') {
      query = query.order('exit_time', { ascending: false, nullsFirst: false }).order('entry_time', { ascending: false });
    } else {
      query = query.order('entry_time', { ascending: false });
    }

    // Step 7: Apply pagination
    // Validates: Requirement 7.6
    const from = page * rows;
    const to = from + rows - 1;
    query = query.range(from, to);

    const { data, error } = await query;

    if (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 8: Return PositionItem[]
    // Validates: Requirement 7.1
    const positions: PositionItem[] = (data ?? []).map(
      (row: any) => ({
        id: row.id,
        user_id: row.user_id,
        profiles: row.profiles,
        symbol: row.symbol,
        side: row.side as 'BUY' | 'SELL',
        status: row.status as 'open' | 'active' | 'closed',
        pnl: row.pnl,
        qty_open: row.qty_open,
        qty_total: row.qty_total,
        avg_price: row.avg_price,
        entry_price: row.entry_price,
        ltp: row.ltp,
        exit_price: row.exit_price,
        duration_seconds: row.duration_seconds,
        brokerage: row.brokerage,
        sl: row.sl,
        tp: row.tp,
        entry_time: row.entry_time,
        exit_time: row.exit_time,
        settlement: row.settlement,
      }),
    );

    return Response.json(positions, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
