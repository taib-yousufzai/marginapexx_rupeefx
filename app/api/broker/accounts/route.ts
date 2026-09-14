/**
 * GET /api/broker/accounts
 *
 * Scoped account P&L summaries for brokers.
 */

import { requireBroker } from '../_auth';
import { NextResponse } from 'next/server';
import { aggregatePositions } from '../../admin/accounts/route';

interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
  parent_id: string | null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await requireBroker(request);
    if (!authResult || !('adminClient' in authResult) || !authResult.adminClient) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { adminClient, callerUser } = authResult as any;

    // Step 1: Query profiles belonging to this broker
    const { data: profiles, error: profilesError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role, parent_id')
      .eq('parent_id', callerUser.id);

    if (profilesError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!profiles || profiles.length === 0) {
      return Response.json([], { status: 200 });
    }

    const userIds = profiles.map((p: { id: string }) => p.id);

    // Step 2: Query positions for these users
    const { data: positions, error: positionsError } = await adminClient
      .from('positions')
      .select('user_id, pnl, brokerage, settlement')
      .in('user_id', userIds);

    if (positionsError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 3: Aggregate
    const positionsByUser = new Map<string, any[]>();
    for (const pos of (positions ?? [])) {
      if (!positionsByUser.has(pos.user_id)) {
        positionsByUser.set(pos.user_id, []);
      }
      positionsByUser.get(pos.user_id)!.push(pos);
    }

    const accounts = profiles.map((profile: Profile) => {
      const userPositions = positionsByUser.get(profile.id) ?? [];
      const { net_pnl, brokerage, pnl_bkg, settlement } = aggregatePositions(userPositions);

      return {
        id: profile.id,
        full_name: profile.full_name ?? '',
        broker: profile.parent_id ?? '',
        net_pnl,
        brokerage,
        pnl_bkg,
        settlement,
      };
    });

    return Response.json(accounts, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
