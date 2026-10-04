import { GET as getUserPositions } from '../users/[id]/positions/route';

export async function GET(request: Request): Promise<Response> {
  return getUserPositions(request, { params: { id: 'all' } });
}
