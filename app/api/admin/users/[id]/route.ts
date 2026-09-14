/**
 * GET    /api/admin/users/[id]
 * PATCH  /api/admin/users/[id]
 * DELETE /api/admin/users/[id]
 *
 * Validates: Requirements 4.2–4.10, 5.2–5.8, 8.5–8.7, 13.7
 */

import { requireAdmin, requireSuperAdmin } from '../../_auth';
import { getRole } from '@/lib/auth';
import { isUserInHierarchy } from '@/lib/hierarchy';


// Profile fields that can be updated via PATCH (password is handled separately)
const PROFILE_FIELDS = [
  'email',
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
  'template_id',
] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 2.1–2.7
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Resolve params (may be a Promise in newer Next.js versions)
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Check hierarchy permission
    if (!await isUserInHierarchy(adminClient, callerUser.id, id)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Step 2: Query the profile row
    // Validates: Requirements 8.5, 13.7
    const { data, error } = await adminClient
      .from('profiles')
      .select(
        'id, email, full_name, phone, role, parent_id, segments, active, read_only, demo_user, intraday_sq_off, auto_sqoff, showcase_auto_sqoff, sqoff_method, balance, settlement_amount, created_at, scheduled_delete_at, trading_mode, mode_locked_until, template_id',
      )
      .eq('id', id)
      .single();

    if (error || data === null) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Step 3: Return the profile
    return Response.json(data, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 2.1–2.7
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Resolve params (may be a Promise in newer Next.js versions)
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Check hierarchy permission
    if (!await isUserInHierarchy(adminClient, callerUser.id, id)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }


    // Step 2: Parse JSON body
    // Validates: Requirement 6.4
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Step 3: If password present and non-empty, validate length
    // Validates: Requirement 4.10
    const { password } = body;
    if (password !== undefined && password !== '') {
      if (typeof password === 'string' && password.length < 8) {
        return Response.json(
          { error: 'Password must be at least 8 characters' },
          { status: 400 },
        );
      }
    }

    // Extract profile fields from body (excluding password)
    const profileFields: Record<string, unknown> = {};
    for (const field of PROFILE_FIELDS) {
      if (field in body) {
        profileFields[field] = body[field];
      }
    }

    if (profileFields.parent_id === '') {
      profileFields.parent_id = null;
    }

    // Step 4: Update profile row
    // Validates: Requirements 4.2, 4.6
    const { data: profileData, error: profileError } = await adminClient
      .from('profiles')
      .update(profileFields)
      .eq('id', id)
      .select()
      .single();

    if (profileError || profileData === null) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    // Sync segment_settings for newly added segments if segments is updated in body
    const activeSegments = body.segments;
    if (Array.isArray(activeSegments) && activeSegments.length > 0) {
      const [existingSegResult, existingScalperResult] = await Promise.all([
        adminClient.from('segment_settings').select('segment, side').eq('user_id', id),
        adminClient.from('scalper_segment_settings').select('segment, side').eq('user_id', id),
      ]);

      const existingKeys = new Set(
        (existingSegResult.data ?? []).map(s => `${s.segment.toUpperCase()}-${s.side.toUpperCase()}`)
      );
      const existingScalperKeys = new Set(
        (existingScalperResult.data ?? []).map(s => `${s.segment.toUpperCase()}-${s.side.toUpperCase()}`)
      );

      const defaultSettingsRows: any[] = [];
      const defaultScalperSettingsRows: any[] = [];

      for (const seg of activeSegments) {
        const segUpper = seg.toUpperCase();
        let intraday_leverage = 50;
        let holding_leverage = 5;
        let commission_value = 4500;
        
        if (segUpper.includes('FOREX') || segUpper.includes('CDS')) {
          intraday_leverage = 100;
          holding_leverage = 10;
          commission_value = 2000;
        } else if (segUpper.includes('COMEX')) {
          intraday_leverage = 50;
          holding_leverage = 5;
          commission_value = 4500;
        } else if (segUpper.includes('CRYPTO')) {
          intraday_leverage = 10;
          holding_leverage = 1;
          commission_value = 1000;
        }

        for (const side of ['BUY', 'SELL'] as const) {
          const key = `${segUpper}-${side}`;
          if (!existingKeys.has(key)) {
            defaultSettingsRows.push({
              user_id: id,
              segment: seg,
              side,
              commission_type: 'Per Crore',
              commission_value,
              profit_hold_sec: 120,
              loss_hold_sec: 0,
              strike_range: 0,
              max_lot: 50,
              max_order_lot: 50,
              intraday_leverage,
              intraday_type: 'Multiplier',
              holding_leverage,
              holding_type: 'Multiplier',
              entry_buffer: 0.3,
              bid_buffer: 0.3,
              exit_buffer: 0.17,
              trade_allowed: true,
            });
          }

          if (!existingScalperKeys.has(key)) {
            defaultScalperSettingsRows.push({
              user_id: id,
              segment: seg,
              side,
              commission_type: 'Per Crore',
              commission_value: 8500,
              profit_hold_sec: 15,
              loss_hold_sec: 0,
              strike_range: 0,
              max_lot: 50,
              max_order_lot: 50,
              intraday_leverage,
              intraday_type: 'Multiplier',
              holding_leverage,
              holding_type: 'Multiplier',
              entry_buffer: 0.003,
              bid_buffer: 0.003,
              exit_buffer: 0.0017,
              trade_allowed: true,
            });
          }
        }
      }

      await Promise.all([
        defaultSettingsRows.length > 0
          ? adminClient.from('segment_settings').upsert(defaultSettingsRows, { onConflict: 'user_id,segment,side' })
          : Promise.resolve(),
        defaultScalperSettingsRows.length > 0
          ? adminClient.from('scalper_segment_settings').upsert(defaultScalperSettingsRows, { onConflict: 'user_id,segment,side' })
          : Promise.resolve(),
      ]);
    }

    // Step 5: Sync role/active to auth user_metadata if present in body
    // Validates: Requirement 4.3
    if ('role' in body || 'active' in body) {
      const userMetadata: Record<string, unknown> = {};
      if ('role' in body) userMetadata.role = body.role;
      if ('active' in body) userMetadata.active = body.active;
      await adminClient.auth.admin.updateUserById(id, { user_metadata: userMetadata });
    }

    // Step 6: Update password if present and non-empty
    // Validates: Requirements 4.4, 4.5
    if (password !== undefined && password !== '' && typeof password === 'string') {
      await adminClient.auth.admin.updateUserById(id, { password });
    }

    // Step 7: Return success
    // Validates: Requirement 4.7
    return Response.json({ success: true }, { status: 200 });
  } catch (err: any) {
    // Outer catch: unhandled exceptions
    // Validates: Requirement 6.1
    console.error('[PATCH /api/admin/users/[id]] Unhandled error:', err);
    return Response.json({ error: 'Internal server error', detail: err?.message }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller (super_admin only)
    // Validates: Requirements 2.1–2.7
    const authResult = await requireSuperAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Resolve params (may be a Promise in newer Next.js versions)
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Scope broker soft-delete to their own child users
    const callerRole = getRole(callerUser);
    if (callerRole === 'broker') {
      const { data: targetProfile, error: targetError } = await adminClient
        .from('profiles')
        .select('parent_id')
        .eq('id', id)
        .single();
      if (targetError || !targetProfile || targetProfile.parent_id !== callerUser.id) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    // Step 2: Soft-delete: update scheduled_delete_at in profiles table to 30 days from now
    const scheduledDeleteAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: profileData, error: deleteError } = await adminClient
      .from('profiles')
      .update({ scheduled_delete_at: scheduledDeleteAt })
      .eq('id', id)
      .select('scheduled_delete_at')
      .single();

    if (deleteError || profileData === null) {
      console.error('[DELETE /api/admin/users/[id]] soft delete error:', deleteError?.message);
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    // Step 3: Return success
    return Response.json({
      success: true,
      scheduled_delete_at: profileData.scheduled_delete_at,
    }, { status: 200 });
  } catch {
    // Outer catch: unhandled exceptions
    // Validates: Requirement 6.1
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
