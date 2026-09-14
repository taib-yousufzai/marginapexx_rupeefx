/**
 * POST /api/admin/orders/square-off-all
 *
 * Force-closes ALL open positions platform-wide (emergency risk control).
 *
 * Uses the close_position() RPC for every open position so that:
 *   - PnL is correctly realized (PNL_CREDIT / PNL_DEBIT transactions inserted)
 *   - Wallet balances are updated via the sync_profile_balance trigger
 *   - Exit orders are recorded (is_exit = true)
 *   - act_logs are written per position
 *
 * No brokerage is charged on emergency admin square-offs.
 */
import { requireAdmin } from '../../_auth';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';

export async function POST(request: Request): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Fetch all open positions
    const { data: openPositions, error: fetchErr } = await adminClient
      .from('positions')
      .select('id, user_id, symbol, side, settlement, qty_open, entry_price, ltp, product_type, carry_brokerage_paid')
      .eq('status', 'open')
      .gt('qty_open', 0);

    if (fetchErr) {
      console.error('[square-off-all] fetch error:', fetchErr.message);
      return Response.json({ error: 'Failed to fetch open positions' }, { status: 500 });
    }

    if (!openPositions || openPositions.length === 0) {
      return Response.json({ squaredOff: 0, errors: 0 }, { status: 200 });
    }

    // Bulk-fetch exit buffers for involved (user, segment, side) combos
    const userIds = [...new Set(openPositions.map((p) => p.user_id))];
    const { data: settingsRows } = await adminClient
      .from('segment_settings')
      .select('user_id, segment, side, exit_buffer, carry_commission_type, carry_commission_value, commission_type, commission_value')
      .in('user_id', userIds);

    const exitBufferMap = new Map<string, { exit_buffer: number, carry_commission_type?: string, carry_commission_value?: number, commission_type?: string, commission_value?: number }>();
    for (const row of settingsRows ?? []) {
      exitBufferMap.set(
        `${row.user_id}|${row.segment}|${row.side}`,
        {
          exit_buffer: Number(row.exit_buffer ?? 0.17),
          carry_commission_type: row.carry_commission_type || undefined,
          carry_commission_value: row.carry_commission_value != null ? Number(row.carry_commission_value) : undefined,
          commission_type: row.commission_type || undefined,
          commission_value: row.commission_value != null ? Number(row.commission_value) : undefined,
        },
      );
    }

    let squaredOff = 0;
    let errors = 0;

    // Bulk-fetch live bid/ask for all affected symbols from the Ticker Daemon.
    const uniqueSymbols = [...new Set(openPositions.map(p => p.symbol.includes(':') ? p.symbol : `NSE:${p.symbol}`))];
    const liveBidAsk: Record<string, { bid: number; ask: number }> = {};
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
      const params = new URLSearchParams({ symbols: uniqueSymbols.join(',') });
      const res = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(200) });
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          for (const sym of uniqueSymbols) {
            const q = json.data[sym];
            if (q) {
              const bid = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? 0);
              const ask = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? 0);
              if (bid > 0 && ask > 0) liveBidAsk[sym] = { bid, ask };
            }
          }
        }
      }
    } catch (tickerErr) {
      console.warn('[square-off-all] Ticker Daemon unavailable:', tickerErr);
    }

    for (const pos of openPositions) {
      const symKey = pos.symbol.includes(':') ? pos.symbol : `NSE:${pos.symbol}`;
      const liveQuote = liveBidAsk[symKey];
      if (!liveQuote) {
        console.error(`[square-off-all] No live bid/ask for ${pos.symbol}. Skipping position ${pos.id}.`);
        errors++;
        continue;
      }

      const bufKey = `${pos.user_id}|${pos.settlement}|${pos.side}`;
      const bufSettings = exitBufferMap.get(bufKey);
      const exitBuffer = Number(bufSettings?.exit_buffer ?? 0.0017);

      // BUY position exits via SELL → use BID; SELL position exits via BUY → use ASK.
      const basePrice = pos.side === 'BUY' ? liveQuote.bid : liveQuote.ask;
      const exitPrice = Math.round(basePrice * (pos.side === 'BUY' ? (1 - exitBuffer) : (1 + exitBuffer)) * 100) / 100;

      // Carry brokerage deferred to exit
      let carryBrokerage = 0;
      if (!pos.carry_brokerage_paid) {
        carryBrokerage = calculateCarryBrokerage({
          productType: pos.product_type,
          qty: Number(pos.qty_open),
          entryPrice: Number(pos.entry_price),
          carryCommissionType: bufSettings?.carry_commission_type,
          carryCommissionValue: bufSettings?.carry_commission_value,
          commissionType: bufSettings?.commission_type,
          commissionValue: bufSettings?.commission_value,
        });
      }

      const { error: rpcErr } = await adminClient.rpc('close_position_v2', {
        p_position_id:        pos.id,
        p_close_qty:          Number(pos.qty_open),
        p_close_price:        exitPrice,
        p_closed_by:          'ADMIN',
        p_expected_brokerage: carryBrokerage,
      });

      if (rpcErr) {
        console.error(`[square-off-all] failed to close position ${pos.id}:`, rpcErr.message);
        errors++;
      } else {
        squaredOff++;
      }
    }

    // Log the admin action (correct table: act_logs)
    await adminClient.from('act_logs').insert({
      type: 'ADMIN_SQUARE_OFF_ALL',
      user_id: callerUser.id,
      target_user_id: callerUser.id,
      reason: `Admin emergency square-off all: ${squaredOff} closed, ${errors} errors`,
    });

    return Response.json({ squaredOff, errors }, { status: 200 });
  } catch (err) {
    console.error('[square-off-all] unexpected error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

