/**
 * GET /api/admin/accounts
 *
 * Returns per-user P&L summaries computed from positions and transactions.
 * Supports date range filtering, role-based grouping, and search.
 *
 * Validates: Requirements 10.1–10.7, 12.1–12.6
 */

import { requireAdmin } from '../_auth';
import { getRole } from '../../../../lib/auth';
import { getDescendantUserIds } from '../../../../lib/hierarchy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountItem = {
  id: string;
  full_name: string;
  broker: string;
  net_pnl: number;
  brokerage: number;
  /** CRITICAL INVARIANT (Property 13): pnl_bkg === net_pnl + brokerage */
  pnl_bkg: number;
  settlement: number;
};

// ---------------------------------------------------------------------------
// Pure aggregation helpers (exported for unit/PBT testing)
// ---------------------------------------------------------------------------

/**
 * Aggregates position rows for a single user.
 *
 * Returns net_pnl, brokerage, pnl_bkg, and settlement.
 * pnl_bkg is ALWAYS computed as net_pnl + brokerage (Property 13).
 */
export function aggregatePositions(
  positions: Array<{
    pnl: number | null;
    brokerage: number | null;
    settlement_amount?: number | null;
    settlement?: string | number | null;
  }>,
): { net_pnl: number; brokerage: number; pnl_bkg: number; settlement: number } {
  let net_pnl = 0;
  let brokerage = 0;
  let settlement = 0;

  for (const pos of positions) {
    net_pnl += Number(pos.pnl ?? 0);
    brokerage += Number(pos.brokerage ?? 0);
    const posSettlement = pos.settlement_amount ?? (typeof pos.settlement === 'number' ? pos.settlement : 0);
    settlement += Number(posSettlement);
  }

  // Property 13: pnl_bkg MUST always equal net_pnl + brokerage
  const pnl_bkg = net_pnl + brokerage;

  return { net_pnl, brokerage, pnl_bkg, settlement };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    // Step 2: Parse query params
    const url = new URL(request.url);
    const dateFrom = url.searchParams.get('date_from') ?? null;
    const dateTo = url.searchParams.get('date_to') ?? null;
    const filter = url.searchParams.get('filter') ?? 'all';
    const search = url.searchParams.get('search') ?? null;
    const demoParam = url.searchParams.get('demo');
    const isDemo = demoParam === 'true';

    // Step 3: Query profiles with optional role filter and search
    const callerRole = getRole(authResult.callerUser);
    const callerId = authResult.callerUser.id;

    let profilesQuery = adminClient
      .from('profiles')
      .select('id, full_name, email, role, parent_id')
      .eq('demo_user', isDemo);

    if (callerRole === 'broker') {
      profilesQuery = profilesQuery.eq('parent_id', callerId);
    } else if (callerRole === 'admin') {
      const descendantIds = await getDescendantUserIds(adminClient, callerId, callerRole);
      if (descendantIds !== null) {
        if (descendantIds.length === 0) {
          return Response.json([], { status: 200 });
        }
        profilesQuery = profilesQuery.in('id', descendantIds);
      }
    }


    if (filter === 'subbrokers') {
      profilesQuery = profilesQuery.eq('role', 'sub_broker');
    } else if (filter === 'brokers') {
      profilesQuery = profilesQuery.eq('role', 'broker');
    }

    if (search) {
      profilesQuery = profilesQuery.or(
        `full_name.ilike.%${search}%,email.ilike.%${search}%`,
      );
    }

    const { data: profilesData, error: profilesError } = await profilesQuery;

    if (profilesError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    const profiles = profilesData ?? [];

    if (profiles.length === 0) {
      return Response.json([], { status: 200 });
    }

    // Step 4: Query positions selecting numeric settlement_amount
    let positionsQuery = adminClient
      .from('positions')
      .select('user_id, pnl, brokerage, settlement_amount, settlement');

    if (dateFrom) {
      positionsQuery = positionsQuery.gte('created_at', dateFrom);
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setDate(toDate.getDate() + 1);
      positionsQuery = positionsQuery.lt('created_at', toDate.toISOString());
    }

    const { data: positionsData, error: positionsError } = await positionsQuery;

    if (positionsError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    const positions = positionsData ?? [];

    // Step 5: Build a map of user_id → aggregated position metrics
    const positionsByUser = new Map<
      string,
      Array<{ pnl: number | null; brokerage: number | null; settlement_amount?: number | null; settlement?: string | number | null }>
    >();

    for (const pos of positions) {
      const userId: string = pos.user_id;
      if (!positionsByUser.has(userId)) {
        positionsByUser.set(userId, []);
      }
      positionsByUser.get(userId)!.push({
        pnl: pos.pnl,
        brokerage: pos.brokerage,
        settlement_amount: pos.settlement_amount,
        settlement: pos.settlement,
      });
    }

    // Step 6: Map profiles to AccountItem[]
    const accounts: AccountItem[] = profiles.map(
      (profile: {
        id: string;
        full_name: string | null;
        email: string | null;
        role: string | null;
        parent_id: string | null;
      }) => {
        const userPositions = positionsByUser.get(profile.id) ?? [];
        const { net_pnl, brokerage, pnl_bkg, settlement } =
          aggregatePositions(userPositions);

        return {
          id: profile.id,
          full_name: profile.full_name ?? '',
          broker: profile.parent_id ?? '',
          net_pnl,
          brokerage,
          pnl_bkg,
          settlement,
        };
      },
    );

    return Response.json(accounts, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
