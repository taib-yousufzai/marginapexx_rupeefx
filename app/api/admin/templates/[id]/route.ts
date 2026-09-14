/**
 * GET    /api/admin/templates/[id]  — get a single template with segment settings
 * PATCH  /api/admin/templates/[id]  — update template profile fields
 * DELETE /api/admin/templates/[id]  — delete template (only if no users are assigned)
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
    const { adminClient } = authResult;

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
    const { adminClient } = authResult;

    const { id } = await Promise.resolve(params);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // If setting this as default, unset all others first
    if (body.is_default === true) {
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
    const { adminClient } = authResult;

    const { id } = await Promise.resolve(params);

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
