/**
 * GET /api/broker/users
 * POST /api/broker/users
 *
 * Scoped user management for brokers.
 */

import { NextResponse } from 'next/server';
import { requireBroker } from '../_auth';

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await requireBroker(request);
    if (!authResult || !('adminClient' in authResult) || !authResult.adminClient) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { adminClient, callerUser } = authResult as any;

    // Check role from profiles table (more reliable than user_metadata)
    const { data: callerProfile } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', callerUser.id)
      .single();

    const callerRole = callerProfile?.role ?? authResult.role;
    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';

    let profilesQuery = adminClient
      .from('profiles')
      .select('id, email, full_name, phone, role, parent_id, segments, active, read_only, demo_user, balance, settlement_amount, created_at, scheduled_delete_at, history_reset_at')
      .not('role', 'in', '("admin","super_admin","broker")');

    if (!isAdmin) {
      profilesQuery = profilesQuery.eq('parent_id', callerUser.id);
    }

    const { data: profiles, error } = await profilesQuery;

    if (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!profiles || profiles.length === 0) {
      return Response.json([], { status: 200 });
    }

    const userIds = profiles.map((p: any) => p.id);

    // Fetch positions to compute PnL metrics
    const { data: positions } = await adminClient
      .from('positions')
      .select('user_id, pnl, brokerage, settlement, open_qty, status, created_at, exit_time, updated_at')
      .in('user_id', userIds);

    // Fetch orders count per user
    const { data: orders } = await adminClient
      .from('orders')
      .select('user_id, side, status, created_at')
      .in('user_id', userIds);

    const positionsByUser = new Map<string, any[]>();
    for (const pos of (positions ?? [])) {
      if (!positionsByUser.has(pos.user_id)) positionsByUser.set(pos.user_id, []);
      positionsByUser.get(pos.user_id)!.push(pos);
    }

    const ordersByUser = new Map<string, any[]>();
    for (const ord of (orders ?? [])) {
      if (!ordersByUser.has(ord.user_id)) ordersByUser.set(ord.user_id, []);
      ordersByUser.get(ord.user_id)!.push(ord);
    }

    // Weekly boundary (rolling 7 days)
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const enriched = profiles.map((profile: any) => {
      const userPositions = positionsByUser.get(profile.id) ?? [];
      const userOrders = ordersByUser.get(profile.id) ?? [];
      const resetAt = profile.history_reset_at ? new Date(profile.history_reset_at) : null;

      // Open positions (open_qty != 0 or status = 'open')
      const openPositions = userPositions.filter((p: any) => p.status === 'open' || Number(p.open_qty ?? 0) !== 0);

      // All-time PnL
      const alltimePnl = userPositions.reduce((acc: number, p: any) => acc + Number(p.pnl ?? 0), 0);

      // Open PnL (from open positions)
      const openPnl = openPositions.reduce((acc: number, p: any) => acc + Number(p.pnl ?? 0), 0);

      // Weekly PnL: Realized PnL from closed positions in the last 7 days after history reset
      const weeklyPnl = userPositions
        .filter((p: any) => {
          if (p.status !== 'closed') return false;
          const closedDate = new Date(p.exit_time || p.updated_at || p.created_at);
          const isThisWeek = closedDate >= oneWeekAgo;
          const isAfterReset = !resetAt || closedDate > resetAt;
          return isThisWeek && isAfterReset;
        })
        .reduce((acc: number, p: any) => acc + Number(p.pnl ?? 0), 0);

      // Brokerage (m2m proxy)
      const totalBrokerage = userPositions.reduce((acc: number, p: any) => acc + Number(p.brokerage ?? 0), 0);

      // Margin used = balance - available (approximate from open positions)
      const marginUsed = openPositions.reduce((acc: number, p: any) => acc + Math.abs(Number(p.settlement ?? 0)), 0);

      return {
        ...profile,
        openPnl,
        weeklyPnl,
        alltimePnl,
        m2m: alltimePnl,
        marginUsed,
        holdingMargin: marginUsed,
        ledgerBal: Number(profile.balance ?? 0),
        settlement_amount: Number(profile.settlement_amount ?? 0),
        mAvailable: Number(profile.balance ?? 0) - marginUsed,
        totalPositions: userPositions.length,
        openPositions: openPositions.length,
        totalOrders: userOrders.length,
        brokerage: totalBrokerage,
      };
    });

    return Response.json(enriched, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const PROFILE_FIELDS = [
  'full_name',
  'phone',
  'role',
  'segments',
  'active',
  'read_only',
  'demo_user',
  'intraday_sq_off',
  'auto_sqoff',
  'showcase_auto_sqoff',
  'sqoff_method',
] as const;

export async function POST(request: Request): Promise<Response> {
  try {
    const authResult = await requireBroker(request);
    if (!authResult || !('adminClient' in authResult) || !authResult.adminClient) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { adminClient, callerUser } = authResult as any;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { email, password } = body;
    if (!email || !password) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (typeof password === 'string' && password.length < 8) {
      return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const profileFields: Record<string, unknown> = {};
    for (const field of PROFILE_FIELDS) {
      if (field in body && body[field] !== '') {
        profileFields[field] = body[field];
      }
    }

    // Force parent_id to the broker's ID
    profileFields['parent_id'] = callerUser.id;

    const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
      email: email as string,
      password: password as string,
      email_confirm: true,
      user_metadata: { username: body.username },
    });

    if (createError || !createData?.user) {
      return Response.json({ error: createError?.message ?? 'Failed to create user' }, { status: 422 });
    }

    const newUser = createData.user;

    await adminClient.auth.admin.updateUserById(newUser.id, {
      user_metadata: { role: body.role ?? 'user', username: body.username }
    });

    const { error: insertError } = await adminClient
      .from('profiles')
      .update({ email: email as string, ...profileFields })
      .eq('id', newUser.id);

    if (insertError) {
      await adminClient.auth.admin.deleteUser(newUser.id);
      return Response.json({ error: 'Failed to create profile' }, { status: 500 });
    }

    return Response.json({ id: newUser.id, email: newUser.email }, { status: 201 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
