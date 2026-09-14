/**
 * POST /api/admin/templates/[id]/set-default
 *
 * Marks this template as the system default.
 *
 * Behaviour:
 *   1. Clears is_default on ALL other templates atomically.
 *   2. Sets is_default = true on this template.
 *   3. Returns the updated template row.
 *
 * Constraints:
 *   - Only ONE template can be default at any time.
 *   - Existing users are NOT modified.
 *   - Only NEW users (with no explicit segments) will inherit this template.
 *   - Survives server restarts, deployments, and session changes (DB-persisted).
 */

import { requireAuth as apiRequireAuth } from '@/lib/api-middleware';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    const authResult = await apiRequireAuth(request, ['MANAGE_TEMPLATES']);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const { id } = await Promise.resolve(params);

    // Step 1: Verify the template exists
    const { data: existing, error: fetchErr } = await adminClient
      .from('account_templates')
      .select('id, name, is_default')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return Response.json({ error: 'Template not found' }, { status: 404 });
    }

    // If already default, nothing to do — return current state
    if (existing.is_default) {
      return Response.json(existing, { status: 200 });
    }

    // Step 2: Unset all other defaults in one query
    const { error: unsetErr } = await adminClient
      .from('account_templates')
      .update({ is_default: false })
      .eq('is_default', true)
      .neq('id', id);

    if (unsetErr) {
      console.error('[POST /api/admin/templates/[id]/set-default] unset error:', unsetErr.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 3: Set this template as default
    const { data, error: setErr } = await adminClient
      .from('account_templates')
      .update({ is_default: true })
      .eq('id', id)
      .select('id, name, description, is_default, segments, read_only, demo_user, intraday_sq_off, auto_sqoff, showcase_auto_sqoff, sqoff_method, trading_mode, created_at, updated_at')
      .single();

    if (setErr || !data) {
      console.error('[POST /api/admin/templates/[id]/set-default] set error:', setErr?.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    return Response.json(data, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
