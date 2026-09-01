/**
 * GET /api/pay/ledger
 *
 * Returns the authenticated user's own ledger entries, ordered by
 * created_at DESC. Every entry in the response has user_id equal to
 * the caller's authenticated user ID (enforced both by the WHERE clause
 * and by the RLS policy on ledger_entries).
 *
 * Validates: Requirements 9.1, 9.2, 9.3
 */

import { createClient } from '@supabase/supabase-js';
import type { LedgerEntry } from '../../../../lib/ledger';

// ---------------------------------------------------------------------------
// Admin client factory
// ---------------------------------------------------------------------------

/**
 * Creates a Supabase admin client using the service role key.
 * Defined as a function (not at module scope) to prevent accidental
 * client-side bundling of the service role key.
 */
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceKey) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminClient = getAdminClient();
    const userId = user.id;

    // Step 3: Query ledger_entries for this user, ordered by created_at DESC
    // Validates: Requirements 9.1, 9.3
    const { data, error } = await adminClient
      .from('ledger_entries')
      .select('id, user_id, entry_type, direction, amount, remarks, pay_request_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/pay/ledger] query error:', error.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    const entries: LedgerEntry[] = data ?? [];

    // Step 4: Return the array directly (not wrapped in an object)
    // Validates: Requirements 9.3
    return Response.json(entries, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/pay/ledger] Unhandled error:', message);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
