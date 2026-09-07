/**
 * GET    /api/admin/templates/[id]  — get a single template with segment settings
 * PATCH  /api/admin/templates/[id]  — update template profile fields (with copy-on-write duplication for admins)
 * DELETE /api/admin/templates/[id]  — delete template (only if no users are assigned and caller owns it)
 */

import { requireAuth as apiRequireAuth } from '@/lib/api-middleware';

const TEMPLATE_FIELDS = [
  'name', 'description', 'is_default',
  'segments', 'read_only', 'demo_user',
  'intraday_sq_off', 'auto_sqoff', 'showcase_auto_sqoff', 'sqoff_method', 'trading_mode',
  'carry_rollover_day', 'carry_rollover_time'
] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    const authResult = await apiRequireAuth(request, ['MANAGE_TEMPLATES']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerRole, callerUser } = authResult;

    const { id } = await Promise.resolve(params);

    const [templateRes, segRes, scalperRes] = await Promise.all([
      adminClient
        .from('account_templates')
        .select('id, name, description, is_default, segments, read_only, demo_user, intraday_sq_off, auto_sqoff, showcase_auto_sqoff, sqoff_method, trading_mode, carry_rollover_day, carry_rollover_time, created_by, created_at, updated_at')
        .eq('id', id)
        .single(),
      adminClient
        .from('template_segment_settings')
        .select('*')
        .eq('template_id', id),
      adminClient
        .from('template_scalper_segment_settings')
        .select('*')
        .eq('template_id', id),
    ]);

    if (templateRes.error || !templateRes.data) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Visibility guard: non-super admins can only view their own templates or super admin/system templates
    if (callerRole !== 'super_admin') {
      const isOwned = templateRes.data.created_by === callerUser.id;
      const isSystem = templateRes.data.created_by === null;
      if (!isOwned && !isSystem) {
        const { data: superAdmins } = await adminClient
          .from('profiles')
          .select('id')
          .eq('role', 'super_admin');
        const superAdminIds = (superAdmins ?? []).map((s: { id: string }) => s.id);
        if (!superAdminIds.includes(templateRes.data.created_by)) {
          return Response.json({ error: 'Not found or not authorized' }, { status: 404 });
        }
      }
    }

    return Response.json({
      ...templateRes.data,
      segment_settings: segRes.data ?? [],
      scalper_segment_settings: scalperRes.data ?? [],
    }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    const authResult = await apiRequireAuth(request, ['MANAGE_TEMPLATES']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerRole, callerUser } = authResult;

    const { id } = await Promise.resolve(params);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Fetch existing template
    const { data: existing, error: fetchErr } = await adminClient
      .from('account_templates')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return Response.json({ error: 'Template not found' }, { status: 404 });
    }

    // Non-super admins cannot set global default
    if (callerRole !== 'super_admin') {
      body.is_default = false;
    } else if (body.is_default === true) {
      await adminClient
        .from('account_templates')
        .update({ is_default: false })
        .eq('is_default', true)
        .neq('id', id);
    }

    const updateData: Record<string, unknown> = {};
    for (const field of TEMPLATE_FIELDS) {
      if (field in body) updateData[field] = body[field];
    }

    if (Object.keys(updateData).length === 0) {
      return Response.json({ error: 'No fields to update' }, { status: 400 });
    }

    // COPY-ON-WRITE (DUPLICATION):
    // If an admin modifies a template that was not created by them (e.g. parent template or super admin template),
    // fork it into a new template owned by this admin and clone all segment/script settings.
    if (callerRole !== 'super_admin' && existing.created_by !== callerUser.id) {
      const targetName = (body.name && typeof body.name === 'string' && body.name.trim() && body.name.trim() !== existing.name)
        ? body.name.trim()
        : `${existing.name} (Copy)`;

      const duplicatedTemplateData: Record<string, unknown> = {
        name: targetName,
        description: 'description' in body ? body.description : existing.description,
        is_default: false,
        segments: 'segments' in body ? body.segments : existing.segments,
        read_only: 'read_only' in body ? body.read_only : existing.read_only,
        demo_user: 'demo_user' in body ? body.demo_user : existing.demo_user,
        intraday_sq_off: 'intraday_sq_off' in body ? body.intraday_sq_off : existing.intraday_sq_off,
        auto_sqoff: 'auto_sqoff' in body ? body.auto_sqoff : existing.auto_sqoff,
        showcase_auto_sqoff: 'showcase_auto_sqoff' in body ? body.showcase_auto_sqoff : existing.showcase_auto_sqoff,
        sqoff_method: 'sqoff_method' in body ? body.sqoff_method : existing.sqoff_method,
        trading_mode: 'trading_mode' in body ? body.trading_mode : existing.trading_mode,
        carry_rollover_day: 'carry_rollover_day' in body ? body.carry_rollover_day : existing.carry_rollover_day,
        carry_rollover_time: 'carry_rollover_time' in body ? body.carry_rollover_time : existing.carry_rollover_time,
        created_by: callerUser.id,
      };

      const { data: newTemplate, error: insertErr } = await adminClient
        .from('account_templates')
        .insert(duplicatedTemplateData)
        .select()
        .single();

      if (insertErr || !newTemplate) {
        console.error('[PATCH /api/admin/templates/[id]] duplication insert error:', insertErr?.message);
        return Response.json({ error: 'Failed to duplicate template' }, { status: 500 });
      }

      // Clone normal segment settings
      const { data: normalSegs } = await adminClient
        .from('template_segment_settings')
        .select('*')
        .eq('template_id', id);

      if (normalSegs && normalSegs.length > 0) {
        const clonedSegs = normalSegs.map(({ id: _i, created_at: _c, updated_at: _u, ...rest }) => ({
          ...rest,
          template_id: newTemplate.id,
        }));
        await adminClient.from('template_segment_settings').insert(clonedSegs);
      }

      // Clone scalper segment settings
      const { data: scalperSegs } = await adminClient
        .from('template_scalper_segment_settings')
        .select('*')
        .eq('template_id', id);

      if (scalperSegs && scalperSegs.length > 0) {
        const clonedScalper = scalperSegs.map(({ id: _i, created_at: _c, updated_at: _u, ...rest }) => ({
          ...rest,
          template_id: newTemplate.id,
        }));
        await adminClient.from('template_scalper_segment_settings').insert(clonedScalper);
      }

      // Clone template scripts if any
      const { data: scripts } = await adminClient
        .from('template_scripts')
        .select('*')
        .eq('template_id', id);

      if (scripts && scripts.length > 0) {
        const clonedScripts = scripts.map(({ id: _i, created_at: _c, updated_at: _u, ...rest }) => ({
          ...rest,
          template_id: newTemplate.id,
        }));
        await adminClient.from('template_scripts').insert(clonedScripts);
      }

      return Response.json(newTemplate, { status: 200 });
    }

    // Direct update (for super admin or if this admin already owns the template)
    const { data, error } = await adminClient
      .from('account_templates')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[PATCH /api/admin/templates/[id]]', error.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!data) return Response.json({ error: 'Not found' }, { status: 404 });

    return Response.json(data, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    const authResult = await apiRequireAuth(request, ['MANAGE_TEMPLATES']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerRole, callerUser } = authResult;

    const { id } = await Promise.resolve(params);

    const { data: existing, error: fetchErr } = await adminClient
      .from('account_templates')
      .select('id, created_by, is_default')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return Response.json({ error: 'Template not found' }, { status: 404 });
    }

    // Default template cannot be deleted
    if (existing.is_default) {
      return Response.json({ error: 'Cannot delete the default template' }, { status: 400 });
    }

    // Admins can only delete templates created by themselves
    if (callerRole !== 'super_admin' && existing.created_by !== callerUser.id) {
      return Response.json({ error: 'Forbidden: You can only delete templates you created' }, { status: 403 });
    }

    // Block deletion if any users are still assigned to this template
    const { count, error: countError } = await adminClient
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('template_id', id);

    if (countError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    if ((count ?? 0) > 0) {
      return Response.json(
        { error: `Cannot delete: ${count} user(s) are assigned to this template. Remove them first.` },
        { status: 409 },
      );
    }

    const { error } = await adminClient
      .from('account_templates')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[DELETE /api/admin/templates/[id]]', error.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
