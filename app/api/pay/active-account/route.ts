/**
 * GET /api/pay/active-account
 *
 * Returns the currently active payment account for deposit, selected via the
 * rotation algorithm. Computes daily usage stats per account in a single query
 * and aggregates in JS to avoid N+1 queries.
 *
 * Validates: Requirements 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7
 */

import { createClient } from '@supabase/supabase-js';
import { selectActiveAccount, type AccountWithStats } from '../../../../lib/accountRotation';

// ---------------------------------------------------------------------------
// Admin client factory
// ---------------------------------------------------------------------------

/**
 * Creates a Supabase admin client using the service role key.
 * Defined as a function (not at module scope) to prevent accidental
 * client-side bundling of the service role key.
 *
 * Validates: Requirements 28.1
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

    const { data: userProfile } = await adminClient
      .from('profiles')
      .select('parent_id')
      .eq('id', user.id)
      .single();
    
    const parentId = userProfile?.parent_id;
    let accounts: any[] = [];

    // First try broker accounts if parent exists
    if (parentId) {
      const { data: brokerAccounts, error: brokerErr } = await adminClient
        .from('payment_accounts')
        .select('*')
        .eq('is_active', true)
        .eq('created_by', parentId)
        .order('sort_order', { ascending: true });
        
      if (brokerErr) {
        console.error('[GET /api/pay/active-account] broker payment_accounts error:', brokerErr.message);
      }
      if (brokerAccounts && brokerAccounts.length > 0) {
        accounts = brokerAccounts;
      }
    }

    // Fallback to global admin accounts if no broker accounts found
    if (accounts.length === 0) {
      const { data: adminProfiles } = await adminClient
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'super_admin']);

      const adminIds = (adminProfiles || []).map((p: any) => p.id);

      let query = adminClient
        .from('payment_accounts')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (adminIds.length > 0) {
        query = query.or(`created_by.is.null,created_by.in.(${adminIds.join(',')})`);
      } else {
        query = query.is('created_by', null);
      }

      const { data: adminAccounts, error: accountsError } = await query;
        
      if (accountsError) {
        console.error('[GET /api/pay/active-account] admin payment_accounts error:', accountsError.message);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
      accounts = adminAccounts || [];
    }

    // Step 3: Return 404 if no active accounts
    // Validates: Requirements 28.3
    if (!accounts || accounts.length === 0) {
      return Response.json({ error: 'No active payment accounts' }, { status: 404 });
    }

    // Step 4: Compute daily stats for all accounts in a single query
    // Query pay_requests WHERE payment_account_id IN (account_ids)
    //   AND type = 'DEPOSIT'
    //   AND status IN ('PENDING', 'APPROVED')
    //   AND created_at >= start of today (UTC)
    // Validates: Requirements 28.4
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const accountIds = accounts.map((a) => a.id);

    const { data: statsRows, error: statsError } = await adminClient
      .from('pay_requests')
      .select('payment_account_id, amount')
      .in('payment_account_id', accountIds)
      .eq('type', 'DEPOSIT')
      .in('status', ['PENDING', 'APPROVED'])
      .gte('created_at', todayStart.toISOString());

    if (statsError) {
      console.error('[GET /api/pay/active-account] pay_requests stats fetch error:', statsError.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 5: Aggregate stats per account in JS
    // Validates: Requirements 28.4
    const statsMap = new Map<string, { daily_count: number; daily_amount: number }>();
    for (const row of statsRows ?? []) {
      const existing = statsMap.get(row.payment_account_id) ?? { daily_count: 0, daily_amount: 0 };
      statsMap.set(row.payment_account_id, {
        daily_count: existing.daily_count + 1,
        daily_amount: existing.daily_amount + Number(row.amount),
      });
    }

    // Step 6: Build AccountWithStats array
    const accountsWithStats: AccountWithStats[] = accounts.map((account) => {
      const stats = statsMap.get(account.id) ?? { daily_count: 0, daily_amount: 0 };
      return {
        ...account,
        daily_count: stats.daily_count,
        daily_amount: stats.daily_amount,
      };
    });

    // Step 7: Select the active account using the rotation algorithm
    // Validates: Requirements 28.5
    const selected = selectActiveAccount(accountsWithStats);

    // Step 8: Return only the fields needed by the client
    // Validates: Requirements 28.6, 28.7
    return Response.json(
      {
        id: selected.id,
        account_holder: selected.account_holder,
        bank_name: selected.bank_name,
        account_no: selected.account_no,
        ifsc: selected.ifsc,
        upi_id: selected.upi_id,
        qr_image_url: selected.qr_image_url,
      },
      { status: 200 },
    );
  } catch {
    // Validates: Requirements 28.7
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
