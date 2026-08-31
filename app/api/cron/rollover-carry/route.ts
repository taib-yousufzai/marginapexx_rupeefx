import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSharedKiteSession } from '@/lib/kiteSession';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function getAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Helper for fetching LTP
async function fetchLtp(symbol: string, settlement: string): Promise<number | null> {
  const cleanSym = symbol.replace('/', '').toUpperCase();
  const isCrypto = (settlement || '').toUpperCase().includes('CRYPTO') || cleanSym.endsWith('USDT');

  if (isCrypto) {
    try {
      const sym = cleanSym.endsWith('USDT') ? cleanSym : `${cleanSym}USDT`;
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);
      const params = new URLSearchParams({ symbols: sym });
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      if (!tickerUrl) throw new Error('No tickerUrl');
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(50) });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data && json.data[sym]) {
          return Number(json.data[sym].last_price);
        }
      }
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { cache: 'no-store', signal: AbortSignal.timeout(50) });
      if (res.ok) {
        const data = await res.json();
        return data.price ? parseFloat(data.price) : null;
      }
    } catch { return null; }
  } else {
    try {
      let fullSymbol = symbol;
      if (!symbol.includes(':')) {
        let exchange = 'NSE';
        const s = (settlement || '').toUpperCase();
        if (s.includes('MCX')) exchange = 'MCX';
        else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
        else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
        else if (s.includes('BSE')) exchange = 'BSE';
        fullSymbol = `${exchange}:${symbol}`;
      }
      const apiKey = process.env.KITE_API_KEY;
      if (!apiKey) return null;
      const session = await getSharedKiteSession();
      if (!session) return null;

      const params = new URLSearchParams({ i: fullSymbol });
      const res = await fetch(`https://api.kite.trade/quote?${params}`, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${session.accessToken}`,
        },
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json() as any;
        const quote = data.data?.[fullSymbol];
        if (quote) return quote.last_price;
      }
    } catch { return null; }
  }
  return null;
}

export async function GET(request: Request) {
  const admin = getAdmin();
  try {
    const { searchParams } = new URL(request.url);
    const secret = searchParams.get('secret');
    if (secret !== process.env.AUTOLOGIN_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[Rollover Carry] Starting...');

    const { data: openPositions, error: posError } = await admin
      .from('positions')
      .select('*, profiles!inner(id, carry_rollover_day, carry_rollover_time, last_carry_rollover)')
      .eq('status', 'open')
      .eq('product_type', 'CARRY')
      .gt('qty_open', 0);

    if (posError) throw posError;
    if (!openPositions || openPositions.length === 0) {
      return NextResponse.json({ success: true, message: 'No open CARRY positions to rollover.' });
    }

    const results = {
      rolledOver: 0,
      skipped: 0,
      errors: [] as string[]
    };

    const utcNow = new Date();
    const nowStr = utcNow.toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
    const nowIst = new Date(nowStr);
    
    // JS days: 0 = Sunday, 1 = Monday, ... 6 = Saturday
    const currentDayStr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][nowIst.getDay()];
    
    // Format HH:MM
    const currentHours = nowIst.getHours().toString().padStart(2, '0');
    const currentMinutes = nowIst.getMinutes().toString().padStart(2, '0');
    const currentTimeStr = `${currentHours}:${currentMinutes}`;

    // Helper to check if rollover is due this week
    const isDue = (prof: any) => {
      const { carry_rollover_day, carry_rollover_time, last_carry_rollover } = prof;
      
      // Check if it's the correct day
      if (carry_rollover_day !== currentDayStr) return false;
      
      // Check if current time is past the configured time
      if (currentTimeStr < carry_rollover_time) return false;

      // Check if already rolled over in the last 2 days (to prevent multiple within the same week)
      if (last_carry_rollover) {
        const lastRoll = new Date(last_carry_rollover).getTime();
        const diffDays = (utcNow.getTime() - lastRoll) / (1000 * 3600 * 24);
        if (diffDays < 2) return false;
      }
      
      return true;
    };

    const usersToUpdate = new Set<string>();

    for (const pos of openPositions) {
      try {
        const prof = Array.isArray(pos.profiles) ? pos.profiles[0] : pos.profiles;
        if (!isDue(prof)) {
          results.skipped++;
          continue;
        }

        const baseLtp = await fetchLtp(pos.symbol, pos.settlement);
        const ltpToUse = baseLtp || pos.ltp || pos.entry_price;
        
        // 1. Close current CARRY position at LTP using v2 engine
        const closeIdempotency = `ROLL_CLOSE_${pos.id}_${new Date().toISOString().slice(0, 10)}`;
        const { error: closeErr } = await admin.rpc('close_position_v2', {
          p_position_id: pos.id,
          p_close_qty: Number(pos.qty_open),
          p_close_price: ltpToUse,
          p_closed_by: 'WEEKLY_ROLLOVER',
          p_expected_brokerage: 0,
          p_idempotency_key: closeIdempotency
        });

        if (closeErr) {
          results.errors.push(`Failed to close pos ${pos.id} for rollover: ${closeErr.message}`);
          continue;
        }

        // 2. Open new CARRY position at LTP using v2 engine
        const openIdempotency = `ROLL_OPEN_${pos.id}_${new Date().toISOString().slice(0, 10)}`;
        const { error: openErr } = await admin.rpc('place_order_v2', {
          p_user_id: prof.id,
          p_symbol: pos.symbol,
          p_kite_inst: pos.symbol, // fallback to symbol
          p_segment: pos.settlement || 'STOCKS',
          p_side: pos.side,
          p_order_type: 'MARKET',
          p_product_type: 'CARRY',
          p_qty: Number(pos.qty_open),
          p_lots: Number(pos.qty_open), // approximation
          p_ltp: ltpToUse,
          p_fill_price: ltpToUse,
          p_is_exit: false,
          p_buffer_fee: 0,
          p_status: 'EXECUTED',
          p_expected_margin: 0, // already validated
          p_expected_brokerage: 0,
          p_idempotency_key: openIdempotency
        });

        if (!openErr) {
          results.rolledOver++;
          usersToUpdate.add(prof.id);
        } else {
          results.errors.push(`Failed to reopen pos ${pos.id} for rollover: ${openErr.message}`);
        }
      } catch (e: any) {
        results.errors.push(`Error processing pos ${pos.id}: ${e.message}`);
      }
    }

    // Update last_carry_rollover for processed users
    for (const userId of Array.from(usersToUpdate)) {
      await admin.from('profiles').update({ last_carry_rollover: new Date().toISOString() }).eq('id', userId);
    }

    console.log('[Rollover Carry] Completed:', results);

    return NextResponse.json({
      success: true,
      results,
    });
  } catch (error: any) {
    console.error('[Rollover Carry] Fatal Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
