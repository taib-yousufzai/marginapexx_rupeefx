/**
 * GET /api/admin/users/[id]/ledger-history
 *
 * Returns paginated ledger entries for a specific user.
 *
 * Query params:
 *   page       - page number (default: 1)
 *   rows       - rows per page (default: 20)
 *   date_from  - ISO date string, inclusive lower bound on created_at
 *   date_to    - ISO date string, inclusive upper bound on created_at
 *   entry_type - one of DEPOSIT | WITHDRAWAL | ADJUSTMENT | CORRECTION | REFUND
 *
 * Response: { data: LedgerEntry[], total: number }
 * Ordered by created_at DESC.
 *
 * Validates: Requirements 7.1, 7.2, 8.1, 8.2, 8.3
 */

import { requireAdmin } from '../../../_auth';
import type { EntryType, LedgerEntry } from '../../../../../../lib/ledger';

const VALID_ENTRY_TYPES: EntryType[] = [
  'DEPOSIT',
  'WITHDRAWAL',
  'ADJUSTMENT',
  'CORRECTION',
  'REFUND',
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorise the caller
    // Returns 403 if the caller does not hold admin / super_admin / broker role
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    // Step 2: Resolve route param
    const resolvedParams = await Promise.resolve(params);
    const userId = resolvedParams.id;

    // Step 3: Verify the target user exists
    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    // Step 4: Parse query parameters
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const rows = Math.max(1, parseInt(url.searchParams.get('rows') ?? '20', 10) || 20);
    const dateFrom = url.searchParams.get('date_from') ?? null;
    const dateTo = url.searchParams.get('date_to') ?? null;
    const entryTypeParam = url.searchParams.get('entry_type') ?? null;

    // Validate entry_type filter when supplied
    if (entryTypeParam !== null && !VALID_ENTRY_TYPES.includes(entryTypeParam as EntryType)) {
      return Response.json({ error: 'Invalid entry_type' }, { status: 400 });
    }

    // Step 5: Build the count query (to get total matching rows)
    let countQuery = adminClient
      .from('ledger_entries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (dateFrom) {
      countQuery = countQuery.gte('created_at', dateFrom);
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setDate(toDate.getDate() + 1);
      countQuery = countQuery.lt('created_at', toDate.toISOString());
    }
    if (entryTypeParam) {
      countQuery = countQuery.eq('entry_type', entryTypeParam);
    }

    // Step 6: Build the data query with pagination
    const from = (page - 1) * rows;
    const to = from + rows - 1;

    let dataQuery = adminClient
      .from('ledger_entries')
      .select('id, user_id, entry_type, direction, amount, remarks, pay_request_id, balance_after, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (dateFrom) {
      dataQuery = dataQuery.gte('created_at', dateFrom);
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setDate(toDate.getDate() + 1);
      dataQuery = dataQuery.lt('created_at', toDate.toISOString());
    }
    if (entryTypeParam) {
      dataQuery = dataQuery.eq('entry_type', entryTypeParam);
    }

    // Step 7: Execute both queries in parallel
    const [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);

    if (countResult.error) {
      console.error('[GET ledger-history] Count query error:', countResult.error.message);
      return Response.json({ error: 'Failed to fetch ledger history' }, { status: 500 });
    }

    if (dataResult.error) {
      console.error('[GET ledger-history] Data query error:', dataResult.error.message);
      return Response.json({ error: 'Failed to fetch ledger history' }, { status: 500 });
    }

    const total = countResult.count ?? 0;
    const data: LedgerEntry[] = dataResult.data ?? [];

    // Step 8: Return paginated result
    return Response.json({ data, total }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET ledger-history] Unhandled error:', message);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
