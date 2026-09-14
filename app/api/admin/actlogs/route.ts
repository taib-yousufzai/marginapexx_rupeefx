/**
 * GET /api/admin/actlogs
 *
 * Returns activity log entries with optional date range filtering, search,
 * pagination, and CSV export.
 *
 * Validates: Requirements 9.1–9.6, 12.1–12.6
 */

import { requireAdmin } from '../_auth';
import { getRole } from '../../../../lib/auth';
import { getDescendantUserIds } from '../../../../lib/hierarchy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActLogItem = {
  id: string;
  type: string;
  time: string; // mapped from created_at
  by: string; // mapped from user_id
  by_id: string | null;
  by_client_id: string | null;
  target: string; // mapped from target_user_id
  target_id: string | null;
  target_client_id: string | null;
  symbol: string | null;
  qty: number | null;
  price: number | null;
  reason: string | null;
  ip: string;
  // New fields
  original_price: number | null;
  margin_used: number | null;
  buffer: number | null;
  brokerage_value: number | null;
  brokerage_mode: 'per_crore' | 'per_lot' | null;
  trade_mode: 'carry' | 'intraday' | null;
  edited_by: string | null;
  edited_at: string | null;
  edit_remark: string | null;
};

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Escapes a CSV field value by wrapping in quotes if it contains commas,
 * quotes, or newlines.
 */
function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts an array of ActLogItem to a CSV string with headers.
 */
function toCsv(items: ActLogItem[]): string {
  const headers = [
    'id', 'type', 'time', 'by', 'target', 'symbol', 'qty', 'price', 'reason', 'ip',
    'original_price', 'margin_used', 'buffer', 'brokerage_value', 'brokerage_mode',
    'trade_mode', 'edited_by', 'edited_at', 'edit_remark',
  ];
  const rows = items.map((item) =>
    [
      csvEscape(item.id),
      csvEscape(item.type),
      csvEscape(item.time),
      csvEscape(item.by),
      csvEscape(item.target),
      csvEscape(item.symbol),
      csvEscape(item.qty),
      csvEscape(item.price),
      csvEscape(item.reason),
      csvEscape(item.ip),
      csvEscape(item.original_price),
      csvEscape(item.margin_used),
      csvEscape(item.buffer),
      csvEscape(item.brokerage_value),
      csvEscape(item.brokerage_mode),
      csvEscape(item.trade_mode),
      csvEscape(item.edited_by),
      csvEscape(item.edited_at),
      csvEscape(item.edit_remark),
    ].join(','),
  );
  return [headers.join(','), ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 12.1–12.6
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Parse query params
    // Validates: Requirements 9.2, 9.6
    const url = new URL(request.url);
    const dateFrom = url.searchParams.get('date_from') ?? null;
    const dateTo = url.searchParams.get('date_to') ?? null;
    const search = url.searchParams.get('search') ?? null;
    const userId = url.searchParams.get('user_id') ?? null;
    const pageParam = url.searchParams.get('page') ?? null;
    const rowsParam = url.searchParams.get('rows') ?? null;
    const exportParam = url.searchParams.get('export') ?? null;
    const demoParam = url.searchParams.get('demo');
    const isDemo = demoParam === 'true';

    const page = pageParam ? parseInt(pageParam, 10) : 1;
    const rows = rowsParam ? parseInt(rowsParam, 10) : 50;

    // Step 3: Build base query
    // Validates: Requirements 9.3
    let query = adminClient
      .from('act_logs')
      .select(
        'id, type, user_id, target_user_id, symbol, qty, price, reason, ip, created_at, ' +
        'original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode, ' +
        'edited_by, edited_at, edit_remark',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false });

    const callerRole = getRole(callerUser);
    const callerId = callerUser.id;

    // Pre-fetch profiles filtered by hierarchy and demo mode
    let pQuery = adminClient.from('profiles').select('id, email, full_name, client_id').eq('demo_user', isDemo);
    if (callerRole === 'broker') {
      pQuery = pQuery.eq('parent_id', callerId);
    } else if (callerRole === 'admin') {
      const descendantIds = await getDescendantUserIds(adminClient, callerId, callerRole);
      if (descendantIds !== null) {
        if (descendantIds.length === 0) {
          return Response.json({ data: [], total: 0 }, { status: 200 });
        }
        pQuery = pQuery.in('id', descendantIds);
      }
    }
    const { data: allowedProfiles, error: pError } = await pQuery;


    const profileMap: Record<string, { email: string; full_name: string | null; client_id?: string }> = {};
    const allowedUserIds: string[] = [];
    if (!pError && allowedProfiles) {
      allowedProfiles.forEach((p: any) => {
        profileMap[p.id] = p;
        allowedUserIds.push(p.id);
      });
    }

    if (allowedUserIds.length > 0) {
      query = query.in('target_user_id', allowedUserIds);
    } else {
      return Response.json({ data: [], total: 0 }, { status: 200 });
    }

    // Step 4: Apply date range filter on created_at
    // Validates: Requirement 9.2
    if (dateFrom) {
      query = query.gte('created_at', dateFrom);
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setDate(toDate.getDate() + 1);
      query = query.lt('created_at', toDate.toISOString());
    }

    // Step 4.5: Apply user_id filter if present
    if (userId) {
      query = query.or(`user_id.eq.${userId},target_user_id.eq.${userId}`);
    }

    // Step 5: Apply search filter
    // ilike on type and symbol; exact match on user_id and target_user_id
    // Validates: Requirement 9.4
    if (search) {
      query = query.or(
        `type.ilike.%${search}%,symbol.ilike.%${search}%,user_id.eq.${search},target_user_id.eq.${search}`,
      );
    }

    // Step 6: Apply pagination (skip for CSV export to get all rows)
    // Validates: Requirement 9.2
    if (exportParam !== 'csv') {
      const from = (page - 1) * rows;
      const to = from + rows - 1;
      query = query.range(from, to);
    }

    const { data, error, count } = await query;

    if (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Profiles are already fetched above, we just use the existing profileMap

    const formatUser = (id: string | null) => {
      if (!id) return '';
      const p = profileMap[id];
      if (!p) return id; // fallback to raw ID if profile not found
      const name = p.full_name || p.email;
      const cid = p.client_id || id.slice(0, 8);
      return `${name} (${cid.toUpperCase()})`;
    };

    // Step 8: Map database rows to ActLogItem[]
    // Validates: Requirement 9.5
    const logs: ActLogItem[] = (data ?? []).map(
      (row: any) => ({
        id: row.id,
        type: row.type,
        time: row.created_at,
        by: formatUser(row.user_id),
        by_id: row.user_id,
        by_client_id: row.user_id && profileMap[row.user_id] ? (profileMap[row.user_id].client_id || row.user_id.slice(0, 8).toUpperCase()) : null,
        target: formatUser(row.target_user_id),
        target_id: row.target_user_id,
        target_client_id: row.target_user_id && profileMap[row.target_user_id] ? (profileMap[row.target_user_id].client_id || row.target_user_id.slice(0, 8).toUpperCase()) : null,
        symbol: row.symbol,
        qty: row.qty,
        price: row.price,
        reason: row.reason,
        ip: row.ip ?? '',
        original_price: row.original_price ?? null,
        margin_used: row.margin_used ?? null,
        buffer: row.buffer ?? null,
        brokerage_value: row.brokerage_value ?? null,
        brokerage_mode: row.brokerage_mode ?? null,
        trade_mode: row.trade_mode ?? null,
        edited_by: row.edited_by ? formatUser(row.edited_by) : null,
        edited_at: row.edited_at ?? null,
        edit_remark: row.edit_remark ?? null,
      }),
    );

    // Step 8: Return CSV or JSON
    // Validates: Requirement 9.6
    if (exportParam === 'csv') {
      const csv = toCsv(logs);
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename=actlogs.csv',
        },
      });
    }

    return Response.json({ data: logs, total: count ?? 0 }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
