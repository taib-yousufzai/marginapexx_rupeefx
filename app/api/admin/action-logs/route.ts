import { requireAuth } from '@/lib/api-middleware';
import { isRailwayDbConfigured, queryRailwayDb } from '@/lib/railway-db';

export async function GET(request: Request) {
  const auth = await requireAuth(request, ['VIEW_USERS']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const filterModule = url.searchParams.get('module') || 'ALL';
  const search = url.searchParams.get('search') || '';
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);

  // 1. Try Railway Postgres first if configured
  if (isRailwayDbConfigured()) {
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (filterModule !== 'ALL') {
        conditions.push(`module = $${paramIndex++}`);
        params.push(filterModule);
      }

      if (search) {
        conditions.push(`(username ILIKE $${paramIndex} OR action_type ILIKE $${paramIndex} OR ip_address ILIKE $${paramIndex})`);
        params.push(`%${search}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      const query = `
        SELECT id, created_at, username, role, action_type, module, ip_address, is_success, error_message, wallet_before, wallet_after
        FROM action_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex}
      `;

      const logs = await queryRailwayDb(query, params);
      if (logs) {
        return Response.json({ logs, source: 'railway_postgres' });
      }
    } catch (err) {
      console.warn('[GET /api/admin/action-logs] Railway query failed, falling back to Supabase:', err);
    }
  }

  // 2. Fallback to Supabase
  let query = auth.adminClient
    .from('action_logs')
    .select('id, created_at, username, role, action_type, module, ip_address, is_success, error_message, wallet_before, wallet_after')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (filterModule !== 'ALL') {
    query = query.eq('module', filterModule);
  }

  if (search) {
    query = query.or(`username.ilike.%${search}%,action_type.ilike.%${search}%,ip_address.ilike.%${search}%`);
  }

  const { data: logs, error } = await query;
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ logs: logs || [], source: 'supabase' });
}
