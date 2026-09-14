/**
 * POST /api/admin/positions/[id]/sqoff
 *
 * Admin-initiated square-off for a single open position.
 *
 * Uses the same close_position() RPC as user-initiated and auto-liquidation
 * closes to ensure full accounting consistency:
 *   - Closes the position at current LTP (with exit buffer from segment_settings)
 *   - Inserts a PNL_CREDIT or PNL_DEBIT transaction → updates wallet via trigger
 *   - Records the exit order row (is_exit = true)
 *   - Writes to act_logs
 *
 * Intentionally does NOT charge brokerage on admin-forced square-offs
 * (same convention as AUTO_LIQUIDATION and AUTO_SL paths).
 *
 * Validates: Requirements 7.10, 12.1–12.6
 */

import { requireAdmin } from '../../../_auth';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    // Step 2: Resolve params
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Step 3: Fetch the open position row (must be open to square off)
    const { data: position, error: fetchError } = await adminClient
      .from('positions')
      .select('id, user_id, symbol, side, settlement, qty_open, entry_price, ltp, product_type, carry_brokerage_paid')
      .eq('id', id)
      .eq('status', 'open')
      .single();

    if (fetchError || position === null) {
      return Response.json({ error: 'Position not found or already closed' }, { status: 404 });
    }

    // Step 4: Fetch live bid/ask from Ticker Daemon.
    // BUY position exits via SELL → use BID; SELL position exits via BUY → use ASK.
    // Do NOT fall back to stored LTP — that would reintroduce the execution pricing bug.
    let basePrice: number | null = null;
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
      const symbolKey = position.symbol.includes(':') ? position.symbol : `NSE:${position.symbol}`;
      const params = new URLSearchParams({ symbols: symbolKey });
      const res = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(100) });
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data && json.data[symbolKey]) {
          const q = json.data[symbolKey];
          basePrice = position.side === 'BUY'
            ? Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? 0) || null
            : Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? 0) || null;
        }
      }
    } catch (tickerErr) {
      console.warn('[sqoff] Ticker Daemon unavailable:', tickerErr);
    }

    if (!basePrice || basePrice <= 0) {
      return Response.json({ error: 'Live bid/ask unavailable — cannot execute at correct price. Try again shortly.' }, { status: 503 });
    }

    // Step 5: Fetch exit buffer from segment_settings (user's own settings first)
    const { data: segSetting } = await adminClient
      .from('segment_settings')
      .select('exit_buffer, carry_commission_type, carry_commission_value, commission_type, commission_value')
      .eq('user_id', position.user_id)
      .eq('segment', position.settlement ?? '')
      .eq('side', position.side)
      .maybeSingle();

    const toDecimalBuffer = (val: any, fallback: number) => {
      if (val === undefined || val === null || isNaN(Number(val))) return fallback;
      const num = Number(val);
      if (num === 0) return 0;
      return num > 0.005 ? num / 100 : num;
    };

    const exitBuffer = toDecimalBuffer(segSetting?.exit_buffer, 0.0017);

    // Step 6: Compute exit price — buffer applied on top of the correct market side price.
    // BUY pos (SELL exit): BID × (1 - exitBuffer)
    // SELL pos (BUY exit): ASK × (1 + exitBuffer)
    const exitPrice = Math.round(basePrice * (position.side === 'BUY' ? (1 - exitBuffer) : (1 + exitBuffer)) * 100) / 100;

    // Step 7: Call the atomic close_position RPC — this handles:
    //   - Setting position status = 'closed', exit_price, exit_time, pnl, qty_open = 0
    //   - Inserting PNL_CREDIT / PNL_DEBIT transaction (wallet updated via trigger)
    //   - Inserting exit order row
    //   - Writing to act_logs
    // Carry brokerage deferred to exit
    let carryBrokerage = 0;
    if (!position.carry_brokerage_paid) {
      carryBrokerage = calculateCarryBrokerage({
        productType: position.product_type,
        qty: Number(position.qty_open),
        entryPrice: Number(position.entry_price),
        carryCommissionType: segSetting?.carry_commission_type,
        carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
        commissionType: segSetting?.commission_type,
        commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
      });
    }

    const { data: pnl, error: rpcErr } = await adminClient.rpc('close_position_v2', {
      p_position_id:        id,
      p_close_qty:          Number(position.qty_open),
      p_close_price:        exitPrice,
      p_closed_by:          'ADMIN',
      p_expected_brokerage: carryBrokerage,
    });

    if (rpcErr) {
      console.error('[POST /api/admin/positions/[id]/sqoff] RPC error:', rpcErr);
      return Response.json({ error: 'Failed to close position' }, { status: 500 });
    }

    // Step 8: Return result
    return Response.json(
      {
        success: true,
        pnl: Number(pnl),
        exit_price: exitPrice,
        message: `Position squared off at ₹${exitPrice}. PnL: ₹${Number(pnl).toFixed(2)}`,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('[POST /api/admin/positions/[id]/sqoff] Error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
