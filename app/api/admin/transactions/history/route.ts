import { requireAdmin } from '../../_auth';
import { getRole } from '../../../../../lib/auth';
import { getDescendantUserIds } from '../../../../../lib/hierarchy';

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    const url = new URL(request.url);
    const demoParam = url.searchParams.get('demo');
    const isDemo = demoParam === 'true';

    const callerRole = getRole(callerUser);
    const callerId = callerUser.id;

    // Fetch allowed profiles based on hierarchy
    let pQuery = adminClient.from('profiles').select('id, email, full_name, client_id').eq('demo_user', isDemo);
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

    const { data: profiles, error: profilesError } = await pQuery;
    if (profilesError) throw profilesError;


    const profileMap: Record<string, any> = {};
    profiles?.forEach(p => {
      profileMap[p.id] = p;
    });

    let requestsQuery = adminClient
        .from('pay_requests')
        .select('*');
        
    const allowedUserIds = profiles ? profiles.map(p => p.id) : [];
    if (allowedUserIds.length > 0) {
      requestsQuery = requestsQuery.in('user_id', allowedUserIds);
    } else {
      return Response.json([], { status: 200 });
    }

    const { data: requests, error: requestsError } = await requestsQuery.order('created_at', { ascending: false });
        
    if (requestsError) throw requestsError;

    const merged = (requests || []).map(r => ({
      ...r,
      user_name: profileMap[r.user_id]?.full_name || profileMap[r.user_id]?.email || r.user_id,
      user_client_id: profileMap[r.user_id]?.client_id || '',
    }));

    return Response.json(merged, { status: 200 });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
