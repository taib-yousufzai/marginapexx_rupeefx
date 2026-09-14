import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRedisClient } from '@/lib/redis';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// In-memory cache for index expiries (1-hour TTL)
let cachedExpiries: { data: Record<string, string>; expiresAt: number; dateStr: string } | null = null;

export async function GET() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // 1. Process memory cache
  if (cachedExpiries && cachedExpiries.dateStr === todayStr && cachedExpiries.expiresAt > Date.now()) {
    return NextResponse.json({ success: true, expiries: cachedExpiries.data });
  }

  // 2. Redis cache check across server instances
  const redis = getRedisClient();
  const redisKey = `market:expiries:${todayStr}`;

  try {
    const raw = await redis.get(redisKey);
    if (raw) {
      const data = JSON.parse(raw);
      cachedExpiries = { data, expiresAt: Date.now() + 3600 * 1000, dateStr: todayStr };
      return NextResponse.json({ success: true, expiries: data });
    }
  } catch (_) {}

  const supabase = getSupabase();
  try {
    const symbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
    const earliest: Record<string, string> = {};

    const marketClose = new Date();
    marketClose.setHours(15, 30, 0, 0);

    // Fetch expiries per symbol to bypass 1000 row limit on 'instruments'
    await Promise.all(symbols.map(async (sym) => {
      const { data, error } = await supabase.rpc('get_option_expiries', { 
        p_min_date: todayStr, 
        p_symbol: sym 
      });

      if (!error && data && data.length > 0) {
        // Find the earliest active expiry
        for (const row of data) {
          if (!row.expiry) continue;
          const expDate = new Date(row.expiry);
          const isToday = expDate.getDate() === now.getDate() && 
                          expDate.getMonth() === now.getMonth() && 
                          expDate.getFullYear() === now.getFullYear();
          
          if (isToday && now > marketClose) {
            continue; // Skip today's expiry if market is closed
          }
          
          earliest[sym] = row.expiry;
          break; // Found the earliest active one!
        }
      }
    }));

    // Cache in process memory & Redis (1 hour)
    cachedExpiries = {
      data: earliest,
      expiresAt: Date.now() + 3600 * 1000,
      dateStr: todayStr,
    };

    try {
      await redis.setex(redisKey, 3600, JSON.stringify(earliest));
    } catch (_) {}

    return NextResponse.json({ success: true, expiries: earliest });
  } catch (err: any) {
    console.error('[market/expiries] Error:', err);
    if (cachedExpiries?.data) {
      return NextResponse.json({ success: true, expiries: cachedExpiries.data });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
