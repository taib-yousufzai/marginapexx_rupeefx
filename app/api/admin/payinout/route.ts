/**
 * GET /api/admin/payinout
 *
 * Returns a filtered, paginated list of pay requests for admin review.
 * Supports filtering by type, status, date range, and exact search on user_id or id.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 19.1
 */

import { requireAdmin } from '../_auth';
import { getRole } from '../../../../lib/auth';
import { getDescendantUserIds } from '../../../../lib/hierarchy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PayRequest = {
  id: string;
  user_id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  account_name: string | null;
  account_no: string | null;
  ifsc: string | null;
  upi: string | null;
  created_at: string;
  updated_at: string;
  reference_id: string | null;
};

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Parse query params
    const url = new URL(request.url);
    const type = url.searchParams.get('type') ?? null;
    const status = url.searchParams.get('status') ?? null;
    const dateFrom = url.searchParams.get('date_from') ?? null;
    const dateTo = url.searchParams.get('date_to') ?? null;
    const search = url.searchParams.get('search') ?? null;
    const pageParam = url.searchParams.get('page') ?? null;
    const rowsParam = url.searchParams.get('rows') ?? null;
    const demoParam = url.searchParams.get('demo');
    const isDemo = demoParam === 'true';

    const callerRole = getRole(callerUser);
    const callerId = callerUser.id;

    // Fetch allowed profiles based on caller's hierarchy
    let pQuery = adminClient.from('profiles').select('id, email, full_name, client_id, bank_name').eq('demo_user', isDemo);
    if (callerRole === 'broker') {
      pQuery = pQuery.eq('parent_id', callerId);
    } else if (callerRole === 'admin') {
      const descendantIds = await getDescendantUserIds(adminClient, callerId, callerRole);
      if (descendantIds !== null) {
        if (descendantIds.length === 0) {
          return Response.json([], { status: 200 });
        }
        pQuery = pQuery.in('id', descendantIds);
      }
    }
    const { data: profiles } = await pQuery;

    const profileMap: Record<string, { full_name: string; email: string; client_id: string; bank_name: string }> = {};
    (profiles ?? []).forEach((p: any) => { profileMap[p.id] = p; });

    // Step 3: Build Supabase query ordered by created_at descending
    let query = adminClient
      .from('pay_requests')
      .select('id, user_id, type, amount, status, account_name, account_no, ifsc, upi, utr, screenshot_url, payment_account_id, created_at, updated_at, reference_id')
      .order('created_at', { ascending: false });

    // Apply allowed userIds
    const allowedUserIds = (profiles ?? []).map((p: any) => p.id);
    if (allowedUserIds.length > 0) {
      query = query.in('user_id', allowedUserIds);
    } else {
      return Response.json([], { status: 200 });
    }

    // Apply type filter
    if (type) {
      query = query.eq('type', type);
    }

    // Apply status filter
    if (status) {
      query = query.eq('status', status);
    }

    // Apply date_from filter
    if (dateFrom) {
      query = query.gte('created_at', dateFrom);
    }

    // Apply date_to filter
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setDate(toDate.getDate() + 1);
      query = query.lt('created_at', toDate.toISOString());
    }

    // NOTE: Search is now done client-side after merging profiles so we can
    // match by name, client_id, user_id, or request id.

    // Note: We skip server-side pagination because the frontend relies on receiving all 
    // filtered records for client-side pagination, real-time search, and CSV exports.

    const { data, error } = await query;

    if (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Fetch bank names from user_bank_accounts
    const accountNos = (data ?? []).map((r: any) => r.account_no).filter(Boolean);
    const { data: bankAccounts } = accountNos.length > 0 
      ? await adminClient.from('user_bank_accounts').select('account_no, bank_name').in('account_no', accountNos)
      : { data: [] };
      
    const bankMap: Record<string, string> = {};
    (bankAccounts ?? []).forEach((b: any) => {
      if (b.account_no && b.bank_name) {
        bankMap[b.account_no] = b.bank_name;
      }
    });

    // Merge profile info into each request
    let merged = (data ?? []).map((r: any) => ({
      ...r,
      user_name: profileMap[r.user_id]?.full_name || profileMap[r.user_id]?.email || r.user_id,
      user_client_id: profileMap[r.user_id]?.client_id || '',
      user_bank_name: bankMap[r.account_no] || profileMap[r.user_id]?.bank_name || '',
    }));

    // Apply search filter across name, client_id, user_id, and request id
    if (search) {
      const q = search.toLowerCase();
      merged = merged.filter((r: any) =>
        r.user_name.toLowerCase().includes(q) ||
        r.user_client_id.toLowerCase().includes(q) ||
        r.user_id.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      );
    }

    return Response.json(merged, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
