/**
 * GET /api/admin/dashboard
 *
 * Returns computed global dashboard metrics, with optional hierarchy filtering.
 */

import { requireAdmin } from '../_auth';
import { getRole } from '../../../../lib/auth';
import { getDescendantUserIds } from '../../../../lib/hierarchy';

export type TransactionRecord = { type: 'DEPOSIT' | 'WITHDRAWAL'; amount: number };
export type PositionRecord = { pnl: number; side: 'BUY' | 'SELL'; brokerage: number };

export async function GET(request: Request): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    const url = new URL(request.url);
    const date_from = url.searchParams.get('date_from') ?? null;
    const date_to = url.searchParams.get('date_to') ?? null;
    const broker_id = url.searchParams.get('broker_id');
    const sub_broker_id = url.searchParams.get('sub_broker_id');
    const client_id = url.searchParams.get('client_id');
    const demoParam = url.searchParams.get('demo');
    const isDemo = demoParam === 'true';

    const callerRole = getRole(callerUser);
    const callerId = callerUser.id;

    const descendantIds = await getDescendantUserIds(adminClient, callerId, callerRole);

    // 1. Fetch profiles to resolve hierarchy if needed
    let targetUserIds: string[] | null = null;
    
    if (client_id) {
      if (client_id.length === 6) {
        const { data: profile } = await adminClient.from('profiles').select('id').eq('client_id', client_id).single();
        if (profile) {
          targetUserIds = [profile.id];
        } else {
          targetUserIds = [client_id]; // Fallback to UUID if not found
        }
      } else {
        targetUserIds = [client_id];
      }
    } else if (broker_id || sub_broker_id) {
      const { data: profiles } = await adminClient.from('profiles').select('id, parent_id, role');
      if (profiles) {
        const getDescendants = (parentId: string): string[] => {
          const children = profiles.filter(p => p.parent_id === parentId).map(p => p.id);
          const descendants = children.flatMap(childId => getDescendants(childId));
          return [...children, ...descendants];
        };
        
        if (sub_broker_id) {
          targetUserIds = [sub_broker_id, ...getDescendants(sub_broker_id)];
        } else if (broker_id) {
          targetUserIds = [broker_id, ...getDescendants(broker_id)];
        }
      }
    }

    if (!targetUserIds) {
      // If no specific hierarchy or client is requested, filter by demo_user globally or within descendant tree
      let query = adminClient.from('profiles').select('id').eq('demo_user', isDemo);
      if (descendantIds !== null) {
        if (descendantIds.length === 0) {
          return Response.json({
            payin: 0, payout: 0, netDeposit: 0, brokerage: 0,
            grossPnL: 0, netPnL: 0, totalPnlBkg: 0, settlement: 0, activeClients: 0
          }, { status: 200 });
        }
        query = query.in('id', descendantIds);
      }
      const { data: allProfiles } = await query;
      if (allProfiles) {
        targetUserIds = allProfiles.map(p => p.id);
      }
    } else {
      // If targetUserIds exist, filter them to ensure they match demo mode AND caller's hierarchy
      let query = adminClient.from('profiles').select('id').in('id', targetUserIds).eq('demo_user', isDemo);
      if (descendantIds !== null) {
        query = query.in('id', descendantIds);
      }
      const { data: matchingProfiles } = await query;
      targetUserIds = matchingProfiles ? matchingProfiles.map(p => p.id) : [];
    }


    // 2. Fetch transactions
    let txnQuery = adminClient.from('transactions').select('type, amount');
    if (targetUserIds) {
      txnQuery = txnQuery.in('user_id', targetUserIds);
    }
    if (date_from) txnQuery = txnQuery.gte('created_at', date_from);
    if (date_to) {
      const toDate = new Date(date_to);
      toDate.setDate(toDate.getDate() + 1);
      txnQuery = txnQuery.lt('created_at', toDate.toISOString());
    }

    const { data: txnData, error: txnError } = await txnQuery;
    if (txnError) return Response.json({ error: 'Failed to fetch transactions' }, { status: 500 });

    // 3. Fetch positions
    let posQuery = adminClient.from('positions').select('pnl, side, brokerage');
    if (targetUserIds) {
      posQuery = posQuery.in('user_id', targetUserIds);
    }
    if (date_from) posQuery = posQuery.gte('entry_time', date_from);
    if (date_to) {
      const toDate = new Date(date_to);
      toDate.setDate(toDate.getDate() + 1);
      posQuery = posQuery.lt('entry_time', toDate.toISOString());
    }

    const { data: posData, error: posError } = await posQuery;
    if (posError) return Response.json({ error: 'Failed to fetch positions' }, { status: 500 });

    // 4. Compute metrics
    const txns = (txnData ?? []) as TransactionRecord[];
    const positions = (posData ?? []) as PositionRecord[];

    const deposits = txns.filter(t => t.type === 'DEPOSIT');
    const withdrawals = txns.filter(t => t.type === 'WITHDRAWAL');
    const total_deposits = deposits.reduce((s, t) => s + t.amount, 0);
    const total_withdrawals = withdrawals.reduce((s, t) => s + t.amount, 0);
    const net = total_deposits - total_withdrawals;

    const profits = positions.filter(p => p.pnl > 0);
    const losses = positions.filter(p => p.pnl < 0);
    
    const mark_to_market = positions.reduce((s, p) => s + (Number(p.pnl) || 0), 0);
    const total_brokerage = positions.reduce((s, p) => s + (Number(p.brokerage) || 0), 0);
    const margin_used = positions.reduce((s, p) => s + (Number((p as any).margin_required) || 0), 0);

    // Net P&L = MTM - Brokerage (brokerage is a cost, not an addition)
    const net_pnl = mark_to_market - total_brokerage;
    
    // Net Balance = Net Deposits + Net PNL
    const ledger_balance = net;
    const net_balance = ledger_balance + net_pnl;

    const fullMetrics = {
      ledger_balance,
      net_balance,
      mark_to_market,
      net_pnl,
      total_brokerage,
      margin_used,
      net,
      total_deposits,
      total_withdrawals,
      avg_deposit: deposits.length > 0 ? total_deposits / deposits.length : 0,
      avg_withdrawal: withdrawals.length > 0 ? total_withdrawals / withdrawals.length : 0,
      avg_profit: profits.length > 0 ? profits.reduce((s, p) => s + (Number(p.pnl) || 0), 0) / profits.length : 0,
      avg_loss: losses.length > 0 ? losses.reduce((s, p) => s + (Number(p.pnl) || 0), 0) / losses.length : 0,
      profitable_clients: profits.length,
      loss_making_clients: losses.length,
      buy_position_count: positions.filter(p => p.side === 'BUY').length,
      sell_position_count: positions.filter(p => p.side === 'SELL').length,
      registered: targetUserIds ? targetUserIds.length : 0, // Approximate
      added_funds: txns.filter(t => t.type === 'DEPOSIT').length,
      conversion: '0%',
    };

    return Response.json(fullMetrics, { status: 200 });
  } catch (err) {
    console.error('[GET /api/admin/dashboard] Error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
