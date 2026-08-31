export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

const ALL_SEGMENTS = [
  'INDEX-FUT', 'STOCK-OPT', 'STOCKS', 'COMEX', 'INDEX-OPT',
  'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'
];

export async function GET(request: NextRequest) {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = getAdminClient();

  // 1. Fetch user's profile to get allowed segments list and active trading mode
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('segments, trading_mode')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) {
    console.error('[GET /api/user/segments] Error querying user profile:', profileErr);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  // Determine which settings table to use
  const queryMode = request.nextUrl.searchParams.get('mode');
  const targetMode = (queryMode === 'normal' || queryMode === 'scalper')
    ? queryMode
    : (profile.trading_mode || 'normal');
  const settingsTable = targetMode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';

  // If segments is null or empty, it means the user is unrestricted and allowed to trade ALL segments!
  const rawSegments: string[] = profile.segments && profile.segments.length > 0
    ? profile.segments
    : ALL_SEGMENTS;
  const allowedSegments = rawSegments.map(s => s === 'NSE-EQ' || s === 'NSE - EQUITY' || s === 'Equity' ? 'STOCKS' : s);

  // 2. Fetch current segment settings from DB
  const { data: currentSettings, error: queryErr } = await admin
    .from(settingsTable)
    .select(
      'id, user_id, segment, side, commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value, profit_hold_sec, loss_hold_sec, strike_range, max_lot, max_order_lot, intraday_leverage, intraday_type, holding_leverage, entry_buffer, holding_type, bid_buffer, exit_buffer, trade_allowed, top_limit, min_limit, exit_price_mode, created_at, updated_at'
    )
    .eq('user_id', user.id);

  if (queryErr) {
    console.error(`[GET /api/user/segments] Error querying ${settingsTable}:`, queryErr);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  let finalSettings = (currentSettings ?? []).map(s => ({
    ...s,
    entry_buffer: (s.entry_buffer != null && String(s.entry_buffer).trim() !== '') ? Number(s.entry_buffer) : 0.3,
    bid_buffer: (s.bid_buffer != null && String(s.bid_buffer).trim() !== '') ? Number(s.bid_buffer) : ((s.entry_buffer != null && String(s.entry_buffer).trim() !== '') ? Number(s.entry_buffer) : 0.3),
    exit_buffer: s.exit_buffer != null ? Number(s.exit_buffer) : 0.17,
  }));

  // 3. Find which of the allowed segments are missing settings in the database and auto-initialize them
  const existingSegmentKeys = new Set(finalSettings.map(s => `${s.segment.toUpperCase()}-${s.side.toUpperCase()}`));
  const defaultSettingsRows = [];

  for (const seg of allowedSegments) {
    const segUpper = seg.toUpperCase();
    let intraday_leverage = 10;
    let holding_leverage = 10;
    let commission_value = 4500;

    if (segUpper.includes('FOREX') || segUpper.includes('CDS')) {
      intraday_leverage = 100;
      holding_leverage = 10;
      commission_value = 2000;
    } else if (segUpper.includes('COMEX')) {
      intraday_leverage = 10;
      holding_leverage = 10;
      commission_value = 4500;
    } else if (segUpper.includes('CRYPTO')) {
      intraday_leverage = 10;
      holding_leverage = 1;
      commission_value = 1000;
    }

    const isScalper = targetMode === 'scalper';
    const profit_hold_sec = isScalper ? 15 : 120;
    const commission_val = isScalper ? 8500 : commission_value;

    for (const side of ['BUY', 'SELL'] as const) {
      const key = `${segUpper}-${side}`;
      if (!existingSegmentKeys.has(key)) {
        defaultSettingsRows.push({
          user_id: user.id,
          segment: seg,
          side,
          commission_type: 'Per Crore',
          commission_value: commission_val,
          profit_hold_sec,
          loss_hold_sec: 0,
          strike_range: 0,
          max_lot: 50,
          max_order_lot: 50,
          intraday_leverage,
          intraday_type: 'Multiplier',
          holding_leverage,
          holding_type: 'Multiplier',
          entry_buffer: 0.3,
          bid_buffer: 0.3,
          exit_buffer: 0.17,
          trade_allowed: true,
        });
      }
    }
  }

  // Insert missing rows atomically in background/parallel to fetch
  if (defaultSettingsRows.length > 0) {
    const { data: insertedData, error: insertErr } = await admin
      .from(settingsTable)
      .insert(defaultSettingsRows)
      .select();

    if (!insertErr && insertedData) {
      const mappedInserted = insertedData.map(s => ({
        ...s,
        entry_buffer: (s.entry_buffer != null && String(s.entry_buffer).trim() !== '') ? Number(s.entry_buffer) : 0.3,
        bid_buffer: (s.bid_buffer != null && String(s.bid_buffer).trim() !== '') ? Number(s.bid_buffer) : 0.3,
        exit_buffer: s.exit_buffer != null ? Number(s.exit_buffer) : 0.17,
      }));
      finalSettings = [...finalSettings, ...mappedInserted];
    } else {
      console.error(`[GET /api/user/segments] Failed to initialize default settings in ${settingsTable}:`, insertErr);
    }
  }

  // 4. Filter the final list to only include allowed segments (handling cases where profile has restrictions)
  const allowedUpper = allowedSegments.map(s => s.toUpperCase());
  const filteredSettings = finalSettings.filter(s => allowedUpper.includes(s.segment.toUpperCase()));

  return NextResponse.json(filteredSettings);
}
