/**
 * POST /api/admin/templates/[id]/apply
 *
 * Applies a template to a list of selected user IDs.
 * For each user this will:
 *   1. Update profile-level settings (segments, read_only, demo_user, etc.)
 *   2. Upsert all normal segment_settings rows
 *   3. Upsert all scalper_segment_settings rows
 *   4. Write a TEMPLATE_APPLY audit log entry
 *
 * Body: { user_ids: string[] }
 */

import { requireAuth as apiRequireAuth } from '@/lib/api-middleware';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    const authResult = await apiRequireAuth(request, ['APPLY_TEMPLATES']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    const { id: templateId } = await Promise.resolve(params);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const userIds = body.user_ids;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return Response.json({ error: 'user_ids must be a non-empty array' }, { status: 400 });
    }

    // 1. Fetch the template + both sets of segment settings in parallel
    const [templateRes, segRes, scalperRes] = await Promise.all([
      adminClient
        .from('account_templates')
        .select('id, name, segments, read_only, demo_user, intraday_sq_off, auto_sqoff, showcase_auto_sqoff, sqoff_method, trading_mode, carry_rollover_day, carry_rollover_time')
        .eq('id', templateId)
        .single(),
      adminClient
        .from('template_segment_settings')
        .select('*')
        .eq('template_id', templateId),
      adminClient
        .from('template_scalper_segment_settings')
        .select('*')
        .eq('template_id', templateId),
    ]);

    if (templateRes.error || !templateRes.data) {
      return Response.json({ error: 'Template not found' }, { status: 404 });
    }

    const template = templateRes.data;
    const templateSegments = segRes.data ?? [];
    const templateScalperSegments = scalperRes.data ?? [];

    // 2. Update profile-level settings for all selected users
    const profileUpdate: Record<string, unknown> = {
      read_only: template.read_only,
      intraday_sq_off: template.intraday_sq_off,
      auto_sqoff: template.auto_sqoff,
      showcase_auto_sqoff: template.showcase_auto_sqoff,
      sqoff_method: template.sqoff_method,
      trading_mode: template.trading_mode,
      carry_rollover_day: template.carry_rollover_day,
      carry_rollover_time: template.carry_rollover_time,
      template_id: templateId,
    };
    if (Array.isArray(template.segments) && template.segments.length > 0) {
      profileUpdate.segments = template.segments;
    }

    const { error: profileError } = await adminClient
      .from('profiles')
      .update(profileUpdate)
      .in('id', userIds);

    if (profileError) {
      console.error('[POST /api/admin/templates/[id]/apply] profile update error:', profileError.message);
      return Response.json({ error: 'Failed to update user profiles' }, { status: 500 });
    }

    // 3. Build segment_settings upsert rows for all users × all template segments
    if (templateSegments.length > 0) {
      const segRows: any[] = [];
      for (const userId of userIds) {
        for (const s of templateSegments) {
          segRows.push({
            user_id: userId,
            segment: s.segment,
            side: s.side,
            commission_type: s.commission_type,
            commission_value: s.commission_value,
            carry_commission_type: s.carry_commission_type,
            carry_commission_value: s.carry_commission_value,
            gtt_commission_type: s.gtt_commission_type,
            gtt_commission_value: s.gtt_commission_value,
            profit_hold_sec: s.profit_hold_sec,
            loss_hold_sec: s.loss_hold_sec,
            strike_range: s.strike_range,
            max_lot: s.max_lot,
            max_order_lot: s.max_order_lot,
            intraday_leverage: s.intraday_leverage,
            intraday_type: s.intraday_type,
            holding_leverage: s.holding_leverage,
            holding_type: s.holding_type,
            entry_buffer: s.entry_buffer ?? 0,
            bid_buffer: s.bid_buffer ?? 0,
            exit_buffer: s.exit_buffer ?? 0,
            trade_allowed: s.trade_allowed,
            top_limit: s.top_limit,
            min_limit: s.min_limit,
            use_custom_calc: s.use_custom_calc ?? false,
          });
        }
      }

      // Batch in chunks of 500 to avoid PostgREST payload limits
      for (let i = 0; i < segRows.length; i += 500) {
        const chunk = segRows.slice(i, i + 500);
        const { error } = await adminClient
          .from('segment_settings')
          .upsert(chunk, { onConflict: 'user_id,segment,side' });
        if (error) {
          console.error('[apply] segment_settings upsert error:', error.message);
          return Response.json({ error: 'Failed to apply segment settings' }, { status: 500 });
        }
      }
    }

    // 4. Build scalper_segment_settings upsert rows
    if (templateScalperSegments.length > 0) {
      const scalperRows: any[] = [];
      for (const userId of userIds) {
        for (const s of templateScalperSegments) {
          scalperRows.push({
            user_id: userId,
            segment: s.segment,
            side: s.side,
            commission_type: s.commission_type,
            commission_value: s.commission_value,
            carry_commission_type: s.carry_commission_type,
            carry_commission_value: s.carry_commission_value,
            gtt_commission_type: s.gtt_commission_type,
            gtt_commission_value: s.gtt_commission_value,
            profit_hold_sec: s.profit_hold_sec,
            loss_hold_sec: s.loss_hold_sec,
            strike_range: s.strike_range,
            max_lot: s.max_lot,
            max_order_lot: s.max_order_lot,
            intraday_leverage: s.intraday_leverage,
            intraday_type: s.intraday_type,
            holding_leverage: s.holding_leverage,
            holding_type: s.holding_type,
            entry_buffer: s.entry_buffer ?? 0,
            bid_buffer: s.bid_buffer ?? 0,
            exit_buffer: s.exit_buffer ?? 0,
            trade_allowed: s.trade_allowed,
            top_limit: s.top_limit,
            min_limit: s.min_limit,
            use_custom_calc: s.use_custom_calc ?? false,
          });
        }
      }

      for (let i = 0; i < scalperRows.length; i += 500) {
        const chunk = scalperRows.slice(i, i + 500);
        const { error } = await adminClient
          .from('scalper_segment_settings')
          .upsert(chunk, { onConflict: 'user_id,segment,side' });
        if (error) {
          console.error('[apply] scalper_segment_settings upsert error:', error.message);
          return Response.json({ error: 'Failed to apply scalper segment settings' }, { status: 500 });
        }
      }
    }

    // 5. Write audit log entries — one per user
    const auditRows = userIds.map(userId => ({
      type: 'TEMPLATE_APPLY',
      user_id: callerUser.id,
      target_user_id: userId,
      reason: `Template applied: ${template.name} (${templateId})`,
    }));

    // Insert audit logs in chunks
    for (let i = 0; i < auditRows.length; i += 500) {
      await adminClient.from('act_logs').insert(auditRows.slice(i, i + 500));
    }

    // 6. Trigger margin checks in background for all affected users
    try {
      const { checkAndSquareOffPositionsForMargin } = await import('@/lib/marginSquareOff');
      await Promise.all(userIds.map(uid => checkAndSquareOffPositionsForMargin(uid, adminClient)));
    } catch (err) {
      console.error('[apply] margin check error:', err);
    }

    return Response.json({
      success: true,
      applied_to: userIds.length,
      template_name: template.name,
    }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[POST /api/admin/templates/[id]/apply]', message);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
