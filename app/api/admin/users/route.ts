/**
 * GET /api/admin/users
 *
 * Returns a list of all user profiles for admin management.
 *
 * Validates: Requirements 2.1–2.6, 12.1–12.6
 */

/**
 * POST /api/admin/users
 *
 * Creates a new Supabase auth user and inserts a corresponding profile row.
 * On profile insert failure, rolls back by deleting the auth user.
 *
 * Validates: Requirements 3.2–3.9
 */

import { requireAuth } from '../../../../lib/api-middleware';
import { getRole } from '../../../../lib/auth'; // trigger recompile
import { auditLog } from '../../../../lib/audit';
import { getDescendantUserIds } from '../../../../lib/hierarchy';

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await requireAuth(request, ['VIEW_USERS']);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const url = new URL(request.url);
    const demoParam = url.searchParams.get('demo');
    const isDemo = demoParam === 'true';
    const fetchAll = demoParam === 'all' || demoParam === null;

    // 1. Fetch profiles (filtered by hierarchy for admin and broker)
    const callerRole = getRole(authResult.callerUser);
    const callerId = authResult.callerUser.id;

    const cacheKey = `cache:admin:users:${callerId}:${demoParam || 'all'}`;
    try {
      const { getRedisClient } = await import('../../../../lib/redis');
      const redis = getRedisClient();
      const cached = await redis.get(cacheKey);
      if (cached) {
        return Response.json(JSON.parse(cached), { status: 200 });
      }
    } catch (_) {}

    let pQuery = adminClient
      .from('profiles')
      .select('id, client_id, email, full_name, phone, role, parent_id, segments, active, read_only, demo_user, intraday_sq_off, auto_sqoff, showcase_auto_sqoff, sqoff_method, balance, settlement_amount, created_at, scheduled_delete_at, trading_mode, mode_locked_until, template_id, history_reset_at');
    
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

    if (!fetchAll) {
      pQuery = pQuery.eq('demo_user', isDemo);
    }
    
    const timeoutPromise = new Promise<{ data: null; error: any }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('Database query timeout') }), 4000)
    );

    const { data: profiles, error: pError } = await Promise.race([pQuery, timeoutPromise]);

    if (pError || !profiles) {
      console.warn('[GET /api/admin/users] Profiles query warning:', pError?.message || pError);
      return Response.json([], { status: 200 });
    }

    const targetUserIds = (profiles ?? []).map((p: any) => p.id);
    if (targetUserIds.length === 0) {
      return Response.json([], { status: 200 });
    }

    const resetMap: Record<string, string | null> = {};
    (profiles ?? []).forEach((p: any) => {
      resetMap[p.id] = p.history_reset_at ?? null;
    });

    // 2. Fetch positions to calculate live stats (only for filtered users)
    const { data: positions } = await adminClient
      .from('positions')
      .select('user_id, pnl, status, entry_time, exit_time, updated_at, margin_required')
      .in('user_id', targetUserIds);

    // 3. Aggregate stats per user
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const statsMap: Record<string, { openPnl: number; m2m: number; weeklyPnl: number; marginUsed: number }> = {};

    (positions ?? []).forEach(pos => {
      if (!statsMap[pos.user_id]) {
        statsMap[pos.user_id] = { openPnl: 0, m2m: 0, weeklyPnl: 0, marginUsed: 0 };
      }
      const s = statsMap[pos.user_id];
      const resetAt = resetMap[pos.user_id];

      // Open PNL: positions that are open or active
      if (pos.status === 'open' || pos.status === 'active') {
        s.openPnl += Number(pos.pnl || 0);
      }

      // M2M: All PNL from today (open + closed today)
      const exitOrUpdate = pos.exit_time || pos.updated_at || pos.entry_time;
      const isToday = pos.entry_time >= today || (exitOrUpdate && exitOrUpdate >= today);
      if (isToday) {
        if (!resetAt || (exitOrUpdate && exitOrUpdate > resetAt)) {
          s.m2m += Number(pos.pnl || 0);
        }
      }

      // Weekly PNL: Realized PNL from closed positions in the last 7 days after history reset
      if (pos.status === 'closed') {
        const closedAt = pos.exit_time || pos.updated_at;
        const isThisWeek = closedAt && closedAt >= oneWeekAgo;
        const isAfterReset = !resetAt || (closedAt && closedAt > resetAt);
        if (isThisWeek && isAfterReset) {
          s.weeklyPnl += Number(pos.pnl || 0);
        }
      }

      // Margin Used — prefer locked_margin (frozen at entry) over margin_required
      if (pos.status === 'open' || pos.status === 'active') {
        s.marginUsed += Number((pos as any).locked_margin || pos.margin_required || 0);
      }
    });

    // 4. Merge stats into profiles
    const users = (profiles ?? []).map(p => ({
      ...p,
      ...(statsMap[p.id] || { openPnl: 0, m2m: 0, weeklyPnl: 0, marginUsed: 0 })
    }));

    try {
      const { getRedisClient } = await import('../../../../lib/redis');
      const redis = getRedisClient();
      await redis.setex(cacheKey, 30, JSON.stringify(users));
    } catch (_) {}

    return Response.json(users, { status: 200 });
  } catch (error: any) {
    console.error('[GET /api/admin/users] Error:', error);
    return Response.json([], { status: 200 });
  }
}

// Profile fields extracted from the request body (excluding email and password)
const PROFILE_FIELDS = [
  'full_name',
  'phone',
  'role',
  'parent_id',
  'segments',
  'active',
  'read_only',
  'demo_user',
  'intraday_sq_off',
  'auto_sqoff',
  'showcase_auto_sqoff',
  'sqoff_method',
  'trading_mode',
  'mode_locked_until',
] as const;

export async function POST(request: Request): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 2.1–2.7
    // Depending on the role we are creating, we might need different permissions, but for now we require CREATE_USER.
    // We will refine later based on the role being created.
    const authResult = await requireAuth(request, ['CREATE_USER']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser, callerRole } = authResult;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const requestedRole = (body.role as string)?.toLowerCase().replace(' ', '_');

    // Hierarchy Enforcement
    if (requestedRole === 'super_admin' && callerRole !== 'super_admin') {
      return Response.json({ error: 'Only Super Admins can create other Super Admins' }, { status: 403 });
    }
    if (requestedRole === 'admin' && callerRole !== 'super_admin') {
      return Response.json({ error: 'Only Super Admins can create Admins' }, { status: 403 });
    }
    if (requestedRole === 'broker' && !['super_admin', 'admin'].includes(callerRole)) {
      return Response.json({ error: 'Only Admins and Super Admins can create Brokers' }, { status: 403 });
    }
    if (requestedRole === 'sub_broker' && !['super_admin', 'admin', 'broker'].includes(callerRole)) {
      return Response.json({ error: 'Only Admins, Super Admins, and Brokers can create Sub-Brokers' }, { status: 403 });
    }

    // Step 3: Validate required fields
    // Validates: Requirement 3.8
    const { email, password } = body;
    if (!email || !password) {
      return Response.json({ error: 'Missing required fields: Email and Password' }, { status: 400 });
    }

    // Step 4: Validate password length
    // Validates: Requirement 3.9
    if (typeof password === 'string' && password.length < 8) {
      return Response.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 },
      );
    }

    // Extract profile fields from body
    const profileFields: Record<string, unknown> = {};
    for (const field of PROFILE_FIELDS) {
      if (field in body && body[field] !== '' && body[field] !== undefined && body[field] !== null) {
        profileFields[field] = body[field];
      }
    }
    profileFields['role'] = requestedRole === 'sub_broker' ? 'broker' : requestedRole;

    if (!profileFields.parent_id && (callerRole === 'admin' || callerRole === 'broker')) {
      profileFields.parent_id = callerUser.id;
    } else if (profileFields.parent_id) {
      const parentVal = String(profileFields.parent_id).trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentVal);
      if (!isUuid) {
        const { data: parentProf } = await adminClient
          .from('profiles')
          .select('id')
          .or(`client_id.ilike.${parentVal},email.ilike.${parentVal}`)
          .maybeSingle();
        if (parentProf?.id) {
          profileFields.parent_id = parentProf.id;
        } else {
          return Response.json({ error: `Parent account "${parentVal}" not found.` }, { status: 400 });
        }
      }
    }

    // Resolve or generate unique client_id
    let client_id = typeof body.username === 'string' ? body.username.trim().toUpperCase() : '';
    if (client_id && /^[A-Z0-9_-]{3,20}$/i.test(client_id)) {
      const { data: existing } = await adminClient
        .from('profiles')
        .select('id')
        .eq('client_id', client_id)
        .maybeSingle();
      if (existing) {
        return Response.json({ error: `Username / Client ID "${client_id}" is already taken.` }, { status: 400 });
      }
    } else {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let isUnique = false;
      while (!isUnique) {
        client_id = '';
        for (let i = 0; i < 6; i++) {
          client_id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const { data: existing } = await adminClient.from('profiles').select('id').eq('client_id', client_id).maybeSingle();
        if (!existing) {
          isUnique = true;
        }
      }
    }
    profileFields['client_id'] = client_id;

    // Step 5: Create auth user
    // Validates: Requirements 3.2, 3.4
    const authRole = requestedRole === 'sub_broker' ? 'broker' : requestedRole;
    const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
      email: (email as string).trim(),
      password: password as string,
      email_confirm: true,
      user_metadata: { role: authRole, username: client_id },
    });

    if (createError || !createData?.user) {
      console.error('[POST /api/admin/users] Auth error:', createError);
      return Response.json(
        { error: createError?.message ?? 'Failed to create user in Auth' },
        { status: 422 },
      );
    }

    const newUser = createData.user;

    // Ensure role and username in user_metadata are synced
    await adminClient.auth.admin.updateUserById(newUser.id, {
      user_metadata: { role: authRole, username: client_id }
    });

    // Step 6: Upsert profile row
    const { error: insertError } = await adminClient
      .from('profiles')
      .upsert({ id: newUser.id, email: (email as string).trim(), ...profileFields }, { onConflict: 'id' });

    if (insertError) {
      console.error('[POST /api/admin/users] Insert error:', insertError);
      // Rollback: delete the created auth user
      await adminClient.auth.admin.deleteUser(newUser.id);
      return Response.json(
        { error: `Database error: ${insertError.message}` },
        { status: 500 },
      );
    }

    // Step 6.5: Initialize default segment_settings and scalper_segment_settings for active segments if specified
    const activeSegments = body.segments;
    if (Array.isArray(activeSegments) && activeSegments.length > 0) {
      const defaultSettingsRows: any[] = [];
      const defaultScalperSettingsRows: any[] = [];
      for (const seg of activeSegments) {
        for (const side of ['BUY', 'SELL'] as const) {
          defaultSettingsRows.push({
            user_id: newUser.id,
            segment: seg,
            side,
            commission_type: 'Per Crore',
            commission_value: 4500,
            profit_hold_sec: 120,
            loss_hold_sec: 0,
            strike_range: 0,
            max_lot: 50,
            max_order_lot: 50,
            intraday_leverage: 10,
            intraday_type: 'Multiplier',
            holding_leverage: 10,
            holding_type: 'Multiplier',
            entry_buffer: 0.3,
            bid_buffer: 0.3,
            exit_buffer: 0.17,
            trade_allowed: true,
          });

          defaultScalperSettingsRows.push({
            user_id: newUser.id,
            segment: seg,
            side,
            commission_type: 'Per Crore',
            commission_value: 8500,
            profit_hold_sec: 15,
            loss_hold_sec: 0,
            strike_range: 0,
            max_lot: 50,
            max_order_lot: 50,
            intraday_leverage: 10,
            intraday_type: 'Multiplier',
            holding_leverage: 10,
            holding_type: 'Multiplier',
            entry_buffer: 0.3,
            bid_buffer: 0.3,
            exit_buffer: 0.17,
            trade_allowed: true,
          });
        }
      }

      if (defaultSettingsRows.length > 0) {
        const [segInitRes, scalperInitRes] = await Promise.all([
          adminClient.from('segment_settings').upsert(defaultSettingsRows, { onConflict: 'user_id,segment,side' }),
          adminClient.from('scalper_segment_settings').upsert(defaultScalperSettingsRows, { onConflict: 'user_id,segment,side' })
        ]);

        if (segInitRes.error || scalperInitRes.error) {
          console.error('[POST /api/admin/users] Settings initialization error:', segInitRes.error || scalperInitRes.error);
          // Rollback: delete the profiles row and auth user
          await adminClient.from('profiles').delete().eq('id', newUser.id);
          await adminClient.auth.admin.deleteUser(newUser.id);
          return Response.json(
            { error: `Database error (Segment Settings): ${(segInitRes.error || scalperInitRes.error)?.message}` },
            { status: 500 },
          );
        }
      }
    }

    // Step 6.6: If no explicit segments were provided, check for a default template and apply it
    const hasExplicitSegments = Array.isArray(body.segments) && (body.segments as unknown[]).length > 0;
    if (!hasExplicitSegments) {
      try {
        // Fetch the default template (if one exists)
        const { data: defaultTemplate } = await adminClient
          .from('account_templates')
          .select('id, segments, read_only, demo_user, intraday_sq_off, auto_sqoff, showcase_auto_sqoff, sqoff_method, trading_mode')
          .eq('is_default', true)
          .single();

        if (defaultTemplate) {
          // Apply profile-level settings from default template
          const templateProfileUpdate: Record<string, unknown> = {
            read_only: defaultTemplate.read_only,
            demo_user: defaultTemplate.demo_user,
            intraday_sq_off: defaultTemplate.intraday_sq_off,
            auto_sqoff: defaultTemplate.auto_sqoff,
            showcase_auto_sqoff: defaultTemplate.showcase_auto_sqoff,
            sqoff_method: defaultTemplate.sqoff_method,
            trading_mode: defaultTemplate.trading_mode,
            template_id: defaultTemplate.id,
          };
          if (Array.isArray(defaultTemplate.segments) && defaultTemplate.segments.length > 0) {
            templateProfileUpdate.segments = defaultTemplate.segments;
          }

          await adminClient.from('profiles').update(templateProfileUpdate).eq('id', newUser.id);

          // Apply segment settings from default template
          const [segRows, scalperRows] = await Promise.all([
            adminClient.from('template_segment_settings').select('*').eq('template_id', defaultTemplate.id),
            adminClient.from('template_scalper_segment_settings').select('*').eq('template_id', defaultTemplate.id),
          ]);

          if (segRows.data && segRows.data.length > 0) {
            const rows = segRows.data.map((s: Record<string, unknown>) => {
              const { id: _id, template_id: _tid, ...rest } = s;
              return { ...rest, user_id: newUser.id };
            });
            await adminClient.from('segment_settings').upsert(rows, { onConflict: 'user_id,segment,side' });
          }

          if (scalperRows.data && scalperRows.data.length > 0) {
            const rows = scalperRows.data.map((s: Record<string, unknown>) => {
              const { id: _id, template_id: _tid, ...rest } = s;
              return { ...rest, user_id: newUser.id };
            });
            await adminClient.from('scalper_segment_settings').upsert(rows, { onConflict: 'user_id,segment,side' });
          }
        }
      } catch (templateErr) {
        // Non-fatal: log but don't fail user creation
        console.warn('[POST /api/admin/users] Default template application failed:', templateErr);
      }
    }

    // Step 7: Return 201 with id, client_id, and email
    // Validates: Requirement 3.6
    await auditLog(adminClient, callerUser.id, newUser.id, 'User Created', {
      role: body.role,
      email: email,
      client_id: client_id
    });
    return Response.json({ id: newUser.id, client_id: client_id, email: newUser.email }, { status: 201 });
  } catch (err: any) {
    // Outer catch: unhandled exceptions
    // Validates: Requirement 6.1
    console.error('[POST /api/admin/users] Unexpected error:', err);
    return Response.json({ error: `Internal error: ${err.message || err}` }, { status: 500 });
  }
}
