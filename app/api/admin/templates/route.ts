/**
 * GET  /api/admin/templates  — list all account templates
 * POST /api/admin/templates  — create a new account template
 */

import { requireAuth as apiRequireAuth } from '@/lib/api-middleware';

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  segments: string[] | null;
  read_only: boolean;
  demo_user: boolean;
  intraday_sq_off: boolean;
  auto_sqoff: number;
  showcase_auto_sqoff: number;
  sqoff_method: string;
  trading_mode: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_FIELDS = [
  'name', 'description', 'is_default',
  'segments', 'read_only', 'demo_user',
  'intraday_sq_off', 'auto_sqoff', 'showcase_auto_sqoff', 'sqoff_method', 'trading_mode',
  'carry_rollover_day', 'carry_rollover_time'
] as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await apiRequireAuth(request, ['MANAGE_TEMPLATES']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerRole, callerUser } = authResult;

    let query = adminClient
      .from('account_templates')
      .select('id, name, description, is_default, segments, read_only, demo_user, intraday_sq_off, auto_sqoff, showcase_auto_sqoff, sqoff_method, trading_mode, carry_rollover_day, carry_rollover_time, created_by, created_at, updated_at');

    if (callerRole !== 'super_admin') {
      // Admins only see templates they created + super admin/system templates.
      // Other admins' templates are never visible.
      const { data: superAdmins } = await adminClient
        .from('profiles')
        .select('id')
        .eq('role', 'super_admin');

      const superAdminIds = (superAdmins ?? []).map((s: { id: string }) => s.id);
      let orFilter = `created_by.eq.${callerUser.id},created_by.is.null`;
      if (superAdminIds.length > 0) {
        orFilter += `,created_by.in.(${superAdminIds.join(',')})`;
      }
      query = query.or(orFilter);
    }

    const { data, error } = await query
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[GET /api/admin/templates]', error.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    return Response.json(data ?? [], { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const authResult = await apiRequireAuth(request, ['MANAGE_TEMPLATES']);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerRole, callerUser } = authResult;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return Response.json({ error: 'Template name is required' }, { status: 400 });
    }

    // Only super admins can create a global default template
    if (callerRole !== 'super_admin') {
      body.is_default = false;
    } else if (body.is_default === true) {
      await adminClient
        .from('account_templates')
        .update({ is_default: false })
        .eq('is_default', true);
    }

    const insertData: Record<string, unknown> = { created_by: callerUser.id };
    for (const field of TEMPLATE_FIELDS) {
      if (field in body) insertData[field] = body[field];
    }

    const { data, error } = await adminClient
      .from('account_templates')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('[POST /api/admin/templates]', error.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    return Response.json(data, { status: 201 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
