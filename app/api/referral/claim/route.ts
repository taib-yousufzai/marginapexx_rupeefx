import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('Missing Supabase env vars');
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = getAdminClient();

    const { data: rpcData, error: rpcError } = await supabase.rpc('claim_referral_earnings', {
      p_user_id: user.id
    });

    if (rpcError) {
      console.error('[POST /api/referral/claim] RPC error:', rpcError);
      return NextResponse.json({ error: 'Failed to claim referral earnings' }, { status: 500 });
    }

    if (rpcData?.error) {
      return NextResponse.json({ error: rpcData.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, claimed_amount: rpcData?.claimed_amount });

  } catch (error) {
    console.error('[POST /api/referral/claim] unhandled error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
