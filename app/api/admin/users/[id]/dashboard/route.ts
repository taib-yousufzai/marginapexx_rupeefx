/**
 * GET /api/admin/users/[id]/dashboard
 *
 * Returns computed dashboard metrics for a given user, with a 5-minute cache.
 * Pure computation functions are exported for property-based testing.
 *
 * Validates: Requirements 3.1–3.8, 12.1–12.6
 */

import { requireAdmin } from '../../../_auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransactionRecord = { type: 'DEPOSIT' | 'WITHDRAWAL'; amount: number };
export type PositionRecord = { pnl: number; side: 'BUY' | 'SELL' };

type DashboardMetrics = {
  ledger_balance: number;
  mark_to_market: number;
  net: number;
  total_deposits: number;
  total_withdrawals: number;
  avg_deposit: number;
  avg_withdrawal: number;
  avg_profit: number;
  avg_loss: number;
  profitable_clients: number;
  loss_making_clients: number;
  buy_position_count: number;
  sell_position_count: number;
  registered: number;
  added_funds: number;
  conversion: string;
};

// ---------------------------------------------------------------------------
// Pure computation functions (exported for PBT)
// ---------------------------------------------------------------------------

/**
 * Computes transaction-based metrics from an array of transaction records.
 *
 * Validates: Requirements 3.3
 * Feature: admin-panel-live-data, Property 2: Dashboard deposit/withdrawal arithmetic
 */
export function computeTransactionMetrics(txns: TransactionRecord[]): {
  total_deposits: number;
  total_withdrawals: number;
  net: number;
  avg_deposit: number;
  avg_withdrawal: number;
} {
  const deposits = txns.filter(t => t.type === 'DEPOSIT');
  const withdrawals = txns.filter(t => t.type === 'WITHDRAWAL');
  const total_deposits = deposits.reduce((s, t) => s + t.amount, 0);
  const total_withdrawals = withdrawals.reduce((s, t) => s + t.amount, 0);
  return {
    total_deposits,
    total_withdrawals,
    net: total_deposits - total_withdrawals,
    avg_deposit: deposits.length > 0 ? total_deposits / deposits.length : 0,
    avg_withdrawal: withdrawals.length > 0 ? total_withdrawals / withdrawals.length : 0,
  };
}

/**
 * Computes position-based metrics from an array of position records.
 *
 * Validates: Requirements 3.4
 * Feature: admin-panel-live-data, Property 3: Dashboard position metrics arithmetic
 */
export function computePositionMetrics(positions: PositionRecord[]): {
  avg_profit: number;
  avg_loss: number;
  profitable_clients: number;
  loss_making_clients: number;
  buy_position_count: number;
  sell_position_count: number;
} {
  const profits = positions.filter(p => p.pnl > 0);
  const losses = positions.filter(p => p.pnl < 0);
  return {
    avg_profit: profits.length > 0 ? profits.reduce((s, p) => s + p.pnl, 0) / profits.length : 0,
    avg_loss: losses.length > 0 ? losses.reduce((s, p) => s + p.pnl, 0) / losses.length : 0,
    profitable_clients: profits.length,
    loss_making_clients: losses.length,
    buy_position_count: positions.filter(p => p.side === 'BUY').length,
    sell_position_count: positions.filter(p => p.side === 'SELL').length,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 12.1–12.6
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    // Step 2: Resolve params to get the user id
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Step 3: Parse optional date range query params
    // Validates: Requirement 3.2
    const url = new URL(request.url);
    const date_from = url.searchParams.get('date_from') ?? null;
    const date_to = url.searchParams.get('date_to') ?? null;

    // Step 4: Check dashboard_cache for a fresh entry (< 5 minutes old)
    // Validates: Requirements 3.6, 3.7
    const { data: cacheData, error: cacheError } = await adminClient
      .from('dashboard_cache')
      .select('metrics')
      .eq('user_id', id)
      .eq('date_from', date_from)
      .eq('date_to', date_to)
      .gt('computed_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .single();

    if (!cacheError && cacheData) {
      // Cache hit — return cached metrics unchanged
      return Response.json(cacheData.metrics, { status: 200 });
    }

    // Step 5: Fetch transactions for this user, optionally filtered by date range
    // Validates: Requirement 3.3
    let txnQuery = adminClient
      .from('transactions')
      .select('type, amount')
      .eq('user_id', id);

    if (date_from) {
      txnQuery = txnQuery.gte('created_at', date_from);
    }
    if (date_to) {
      const toDate = new Date(date_to);
      toDate.setDate(toDate.getDate() + 1);
      txnQuery = txnQuery.lt('created_at', toDate.toISOString());
    }

    const { data: txnData, error: txnError } = await txnQuery;
    if (txnError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 6: Fetch positions for this user, optionally filtered by date range
    // Validates: Requirement 3.4
    let posQuery = adminClient
      .from('positions')
      .select('pnl, side')
      .eq('user_id', id);

    if (date_from) {
      posQuery = posQuery.gte('entry_time', date_from);
    }
    if (date_to) {
      const toDate = new Date(date_to);
      toDate.setDate(toDate.getDate() + 1);
      posQuery = posQuery.lt('entry_time', toDate.toISOString());
    }

    const { data: posData, error: posError } = await posQuery;
    if (posError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 7: Compute metrics using pure functions
    const txnMetrics = computeTransactionMetrics(
      (txnData ?? []) as TransactionRecord[],
    );
    const posMetrics = computePositionMetrics(
      (posData ?? []) as PositionRecord[],
    );

    // Step 8: Compute additional summary fields
    // Validates: Requirement 3.5
    const ledger_balance = txnMetrics.net;
    const mark_to_market = (posData ?? []).reduce(
      (s: number, p: { pnl: number }) => s + p.pnl,
      0,
    );
    const added_funds = (txnData ?? []).filter(
      (t: { type: string }) => t.type === 'DEPOSIT',
    ).length;

    // Step 9: Assemble full DashboardMetrics object
    const fullMetrics: DashboardMetrics = {
      ledger_balance,
      mark_to_market,
      net: txnMetrics.net,
      total_deposits: txnMetrics.total_deposits,
      total_withdrawals: txnMetrics.total_withdrawals,
      avg_deposit: txnMetrics.avg_deposit,
      avg_withdrawal: txnMetrics.avg_withdrawal,
      avg_profit: posMetrics.avg_profit,
      avg_loss: posMetrics.avg_loss,
      profitable_clients: posMetrics.profitable_clients,
      loss_making_clients: posMetrics.loss_making_clients,
      buy_position_count: posMetrics.buy_position_count,
      sell_position_count: posMetrics.sell_position_count,
      registered: 0,
      added_funds,
      conversion: '0%',
    };

    // Step 10: Upsert into dashboard_cache
    // Validates: Requirement 3.6
    await adminClient.from('dashboard_cache').upsert(
      {
        user_id: id,
        date_from,
        date_to,
        metrics: fullMetrics,
        computed_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,date_from,date_to' },
    );

    // Step 11: Return fresh metrics
    return Response.json(fullMetrics, { status: 200 });
  } catch {
    // Outer catch: unhandled exceptions
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
