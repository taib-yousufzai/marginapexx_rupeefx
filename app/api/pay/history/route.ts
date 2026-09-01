import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminClient = getAdminClient();

    const { data, error } = await adminClient
      .from('pay_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/pay/history] fetch error:', error.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    return Response.json(data);
  } catch (err) {
    console.error('[GET /api/pay/history] catch error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
