import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('Missing Supabase env vars');
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = getAdminClient();

    // Fetch user's referral balance and code
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('referral_balance, referral_code')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('[GET /api/referral/info] profile error:', profileError);
      return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 });
    }

    // Fetch referral earnings history
    // We join with profiles to get the referred user's name
    const { data: earnings, error: earningsError } = await supabase
      .from('referral_earnings')
      .select(`
        id,
        deposit_amount,
        commission_amount,
        created_at,
        referred_user:profiles!referred_user_id(full_name)
      `)
      .eq('referrer_id', user.id)
      .order('created_at', { ascending: false });

    if (earningsError) {
      console.error('[GET /api/referral/info] earnings error:', earningsError);
      return NextResponse.json({ error: 'Failed to fetch earnings' }, { status: 500 });
    }

    return NextResponse.json({
      balance: profile.referral_balance,
      code: profile.referral_code,
      earnings: earnings || []
    });

  } catch (error) {
    console.error('[GET /api/referral/info] unhandled error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
