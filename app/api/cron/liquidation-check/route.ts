/**
 * GET /api/cron/liquidation-check
 *
 * Fallback liquidation cron — runs every 30 seconds via Vercel cron.
 * Primary liquidation is handled by the Ticker Daemon (real-time, per-tick).
 * This cron is the safety net for when the Ticker Daemon is down, restarting,
 * or the Binance/Kite WebSocket is disconnected.
 *
 * Flow:
 *  1. Fetch all users with open positions
 *  2. For each user: compute floating PnL using latest LTP (Ticker Daemon → Binance REST)
 *  3. If floating PnL ≤ -(balance × auto_sqoff%), fire checkAndExecuteAccountLiquidation
 *  4. Skip users already being liquidated by the Ticker Daemon (via DB lock check)
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkAndExecuteAccountLiquidation } from '@/lib/liquidationEngine';
import { calculateFloatingPnl } from '@/lib/floatingPnl';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// ─── LTP fetcher (Ticker Daemon → Binance REST → Kite REST) ──────────────────

async function fetchLtp(symbol: string, settlement: string): Promise<number | null> {
  const seg = (settlement || '').toUpperCase();
  const isCrypto = seg.includes('CRYPTO') || symbol.endsWith('USDT');

  if (isCrypto) {
    const sym = symbol.replace('/', '').toUpperCase();
    const binanceSym = sym.endsWith('USDT') ? sym : `${sym}USDT`;

    // 1. Ticker Daemon
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL ||
        'https://marginapexx-production.up.railway.app';
      const res = await fetch(
        `${tickerUrl}/quotes?symbols=${binanceSym}`,
        { cache: 'no-store', signal: AbortSignal.timeout(3000) },
      );
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data?.[binanceSym]?.last_price) {
          return Number(json.data[binanceSym].last_price);
        }
      }
    } catch { /* fall through */ }

    // 2. Binance REST
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSym}`,
        { cache: 'no-store', signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.price) return parseFloat(data.price);
      }
    } catch { /* fall through */ }

    return null;
  }

  // Non-crypto: Ticker Daemon first, then Kite REST
  try {
    const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL ||
      'https://marginapexx-production.up.railway.app';
    let kiteId = symbol;
    if (!symbol.includes(':')) {
      const exchange = seg.includes('MCX') ? 'MCX'
        : seg.includes('CDS') || seg.includes('FOREX') ? 'CDS'
        : seg.includes('OPT') || seg.includes('FUT') ? 'NFO'
        : seg.includes('BSE') ? 'BSE' : 'NSE';
      kiteId = `${exchange}:${symbol}`;
    }
    const res = await fetch(
      `${tickerUrl}/quotes?symbols=${encodeURIComponent(kiteId)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const json = await res.json();
      if (json.success && json.data?.[kiteId]?.last_price) {
        return Number(json.data[kiteId].last_price);
      }
    }
  } catch { /* fall through */ }

  return null;
}

async function runLiquidationCheckPass() {
  const admin = getAdmin();
  const { data: positions, error: posErr } = await admin
    .from('positions')
    .select('id, user_id, symbol, side, qty_open, entry_price, ltp, settlement, product_type, created_at, entry_time')
    .eq('status', 'open')
    .gt('qty_open', 0);

  if (posErr) throw posErr;
  if (!positions || positions.length === 0) {
    return { openPositionsCount: 0, checked: 0, liquidated: 0, skipped: 0 };
  }

  const userIds = Array.from(new Set(positions.map(p => p.user_id)));

  const [profilesRes, segSettingsRes] = await Promise.all([
    admin
      .from('profiles')
      .select('id, balance, auto_sqoff, trading_mode, parent_id')
      .in('id', userIds),
    admin
      .from('segment_settings')
      .select('user_id, segment, side, exit_buffer, bid_buffer, carry_commission_type, carry_commission_value, commission_type, commission_value')
      .in('user_id', userIds),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map(p => [p.id, p]));

  const exitBuffers = new Map<string, {
    exit_buffer: number; bid_buffer: number;
    carry_commission_type?: string | null;
    carry_commission_value?: number | null;
    commission_type?: string | null;
    commission_value?: number | null;
  }>();
  for (const s of segSettingsRes.data ?? []) {
    exitBuffers.set(`${s.user_id}|${s.segment}|${s.side}`, {
      exit_buffer: Number(s.exit_buffer ?? 0.17),
      bid_buffer: Number(s.bid_buffer ?? 0.3),
      carry_commission_type: s.carry_commission_type ?? null,
      carry_commission_value: s.carry_commission_value != null ? Number(s.carry_commission_value) : null,
      commission_type: s.commission_type ?? null,
      commission_value: s.commission_value != null ? Number(s.commission_value) : null,
    });
  }

  const byUser = new Map<string, typeof positions>();
  for (const pos of positions) {
    if (!byUser.has(pos.user_id)) byUser.set(pos.user_id, []);
    byUser.get(pos.user_id)!.push(pos);
  }

  const uniqueSymbols = Array.from(
    new Map(positions.map(p => [`${p.symbol}|${p.settlement}`, p])).values()
  );
  const ltpResults = await Promise.all(
    uniqueSymbols.map(async p => ({
      key: `${p.symbol}|${p.settlement}`,
      ltp: await fetchLtp(p.symbol, p.settlement),
    }))
  );
  const ltpMap = new Map(ltpResults.map(r => [r.key, r.ltp]));

  let liquidated = 0;
  let skipped = 0;
  let checked = 0;

  for (const [userId, userPositions] of byUser) {
    const profile = profileMap.get(userId);
    if (!profile) { skipped++; continue; }

    const balance = Number(profile.balance ?? 0);
    const autoSqoffPercent = Number(profile.auto_sqoff ?? 90);
    if (autoSqoffPercent <= 0) { skipped++; continue; }

    const threshold = -(balance * (autoSqoffPercent / 100));

    let totalFloatingPnl = 0;
    const positionsWithLtp = userPositions.map(pos => {
      const ltp = ltpMap.get(`${pos.symbol}|${pos.settlement}`)
        ?? Number(pos.ltp ?? pos.entry_price);

      const bufKey = `${userId}|${pos.settlement}|${pos.side}`;
      const exitBufferPct = exitBuffers.get(bufKey)?.exit_buffer ?? 0.17;

      const pnl = calculateFloatingPnl({
        side: pos.side,
        ltp,
        entryPrice: Number(pos.entry_price),
        qty: Number(pos.qty_open),
        exitBufferPct,
      });

      totalFloatingPnl += pnl;
      return { ...pos, ltp };
    });

    checked++;

    if (totalFloatingPnl > threshold) continue;

    console.log(
      `[LiquidationCron] Threshold breached for user ${userId}: ` +
      `PnL=₹${totalFloatingPnl.toFixed(2)}, threshold=₹${threshold.toFixed(2)}`
    );

    const result = await checkAndExecuteAccountLiquidation(
      userId,
      balance,
      autoSqoffPercent,
      positionsWithLtp,
      totalFloatingPnl,
      exitBuffers,
      admin,
    );

    if (result.liquidated) liquidated++;
  }

  return { openPositionsCount: positions.length, checked, liquidated, skipped };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('secret') !== process.env.AUTOLOGIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const PASSES = 5;
    const INTERVAL_MS = 8000;
    let totalChecked = 0;
    let totalLiquidated = 0;
    let totalSkipped = 0;
    let passCount = 0;

    for (let pass = 0; pass < PASSES; pass++) {
      if (pass > 0) {
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
      }
      passCount++;
      const res = await runLiquidationCheckPass();
      totalChecked += res.checked;
      totalLiquidated += res.liquidated;
      totalSkipped += res.skipped;
      if (res.openPositionsCount === 0) break;
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[LiquidationCron] Sub-cycle completed ${passCount} passes in ${elapsed}ms — ` +
      `checked=${totalChecked}, liquidated=${totalLiquidated}, skipped=${totalSkipped}`
    );

    return NextResponse.json({
      success: true,
      passes: passCount,
      elapsed_ms: elapsed,
      users_checked: totalChecked,
      users_liquidated: totalLiquidated,
      users_skipped: totalSkipped,
    });

  } catch (err: any) {
    console.error('[LiquidationCron] Fatal error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
