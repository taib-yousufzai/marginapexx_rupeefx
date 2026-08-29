import { describe, it, expect, vi } from 'vitest';
import {
  checkAndExecuteAccountLiquidation,
  computeLiquidationThreshold,
  PositionForLiquidation,
} from '../lib/liquidationEngine';
import { aggregatePositions } from '../app/api/admin/accounts/route';

/**
 * Mock Supabase Admin Client Builder for Liquidation Testing
 */
function createMockAdminClient(initialProfile: { balance: number; auto_sqoff: number; settlement_amount?: number }) {
  let profile = { ...initialProfile, settlement_amount: initialProfile.settlement_amount ?? 0 };
  const positionsState: Record<string, { id: string; status: string; pnl: number; settlement_amount: number }> = {};
  const transactions: any[] = [];
  const settlementRecords: any[] = [];
  const notifications: any[] = [];
  const actLogs: any[] = [];
  const orders: any[] = [];

  const mock = {
    _profile: profile,
    _positions: positionsState,
    _transactions: transactions,
    _settlementRecords: settlementRecords,
    _notifications: notifications,
    _actLogs: actLogs,
    _orders: orders,

    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { balance: profile.balance, auto_sqoff: profile.auto_sqoff }, error: null }),
            }),
          }),
          update: (updates: any) => ({
            eq: async () => {
              if (updates.balance !== undefined) profile.balance = updates.balance;
              if (updates.settlement_amount !== undefined) profile.settlement_amount = updates.settlement_amount;
              return { error: null };
            },
          }),
        };
      }
      if (table === 'orders') {
        return {
          update: (updates: any) => ({
            eq: () => ({
              eq: async () => {
                orders.push(updates);
                return { error: null };
              },
            }),
          }),
        };
      }
      if (table === 'positions') {
        return {
          update: (updates: any) => ({
            eq: async (_col: string, id: string) => {
              if (positionsState[id]) {
                if (updates.settlement_amount !== undefined) {
                  positionsState[id].settlement_amount = updates.settlement_amount;
                }
                if (updates.status !== undefined) {
                  positionsState[id].status = updates.status;
                }
              }
              return { error: null };
            },
            in: async (_col: string, ids: string[]) => {
              for (const id of ids) {
                if (positionsState[id] && updates.settlement_amount !== undefined) {
                  positionsState[id].settlement_amount = updates.settlement_amount;
                }
              }
              return { error: null };
            },
          }),
        };
      }
      if (table === 'transactions') {
        return {
          select: () => ({
            in: (_col: string, refIds: string[]) => ({
              eq: (_typeCol: string, typeVal: string) => ({
                eq: async () => {
                  const filtered = transactions.filter(t => refIds.includes(t.ref_id) && t.type === typeVal);
                  return { data: filtered, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === 'settlement_records') {
        return {
          insert: async (record: any) => {
            settlementRecords.push(record);
            return { error: null };
          },
        };
      }
      if (table === 'notifications') {
        return {
          insert: async (records: any) => {
            if (Array.isArray(records)) notifications.push(...records);
            else notifications.push(records);
            return { error: null };
          },
        };
      }
      if (table === 'act_logs') {
        return {
          insert: async (record: any) => {
            actLogs.push(record);
            return { error: null };
          },
        };
      }
      return {};
    },

    rpc: vi.fn(async (functionName: string, args: any) => {
      if (functionName === 'close_position_v2') {
        const posId = args.p_position_id;
        const pos = positionsState[posId];
        if (!pos || pos.status === 'closed') {
          throw new Error('Position not found or already closed.');
        }

        pos.status = 'closed';
        const realizedPnl = pos.pnl;

        const pnlType = realizedPnl >= 0 ? 'PNL_CREDIT' : 'PNL_DEBIT';
        const pnlAmount = Math.abs(realizedPnl);

        transactions.push({
          user_id: 'usr_test',
          type: pnlType,
          amount: pnlAmount,
          status: 'APPROVED',
          ref_id: posId,
        });

        const netChange = realizedPnl;
        if (profile.balance + netChange < 0) {
          const shortfall = Math.abs(profile.balance + netChange);
          profile.settlement_amount = (profile.settlement_amount || 0) + shortfall;
          pos.settlement_amount = shortfall;
          profile.balance = 0;
        } else {
          profile.balance += netChange;
        }

        return realizedPnl;
      }
      return 0;
    }),
  };

  return mock;
}

describe('Liquidation & Settlement Loss Integrity Test Suite (8 Test Cases)', () => {
  const userId = 'usr_test';
  const autoSqoffPercent = 90;
  const emptyBuffers = new Map();

  it('TEST 1: LIQUIDATION TRIGGER — Triggers when floating PnL breaches threshold, skips when above', async () => {
    const balance = 10000;
    const threshold = computeLiquidationThreshold(balance, autoSqoffPercent); // -9000
    const mockAdmin = createMockAdminClient({ balance, auto_sqoff: autoSqoffPercent });

    const positions: PositionForLiquidation[] = [
      {
        id: 'pos_1',
        user_id: userId,
        symbol: 'NSE:RELIANCE',
        side: 'BUY',
        qty_open: 10,
        entry_price: 2500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        ltp: 2000,
        pnl: -5000,
      },
    ];

    mockAdmin._positions['pos_1'] = { id: 'pos_1', status: 'open', pnl: -5000, settlement_amount: 0 };

    const resNoTrigger = await checkAndExecuteAccountLiquidation(
      userId,
      balance,
      autoSqoffPercent,
      positions,
      -5000,
      emptyBuffers,
      mockAdmin as any,
    );
    expect(resNoTrigger.liquidated).toBe(false);
    expect(mockAdmin._positions['pos_1'].status).toBe('open');

    mockAdmin._positions['pos_1'].pnl = -9500;
    positions[0].pnl = -9500;
    const resTrigger = await checkAndExecuteAccountLiquidation(
      userId,
      balance,
      autoSqoffPercent,
      positions,
      -9500,
      emptyBuffers,
      mockAdmin as any,
    );
    expect(resTrigger.liquidated).toBe(true);
    expect(resTrigger.positionsClosed).toBe(1);
    expect(mockAdmin._positions['pos_1'].status).toBe('closed');
  });

  it('TEST 2: LIQUIDATION SEQUENCE — Liquidates multiple open trades strictly in execution/creation order', async () => {
    const balance = 10000;
    const mockAdmin = createMockAdminClient({ balance, auto_sqoff: autoSqoffPercent });

    const closedOrder: string[] = [];
    const originalRpc = mockAdmin.rpc;
    mockAdmin.rpc = vi.fn(async (fnName: string, args: any) => {
      if (fnName === 'close_position_v2') {
        closedOrder.push(args.p_position_id);
        return originalRpc(fnName, args);
      }
      return originalRpc(fnName, args);
    });

    const positions: (PositionForLiquidation & { created_at: string })[] = [
      {
        id: 'pos_newest',
        user_id: userId,
        symbol: 'NSE:INFY',
        side: 'BUY',
        qty_open: 10,
        entry_price: 1500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        created_at: '2026-08-28T12:00:00Z',
        pnl: -4000,
      },
      {
        id: 'pos_oldest',
        user_id: userId,
        symbol: 'NSE:RELIANCE',
        side: 'BUY',
        qty_open: 10,
        entry_price: 2500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        created_at: '2026-08-28T10:00:00Z',
        pnl: -4000,
      },
      {
        id: 'pos_middle',
        user_id: userId,
        symbol: 'NSE:TCS',
        side: 'BUY',
        qty_open: 10,
        entry_price: 3500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        created_at: '2026-08-28T11:00:00Z',
        pnl: -4000,
      },
    ];

    positions.forEach(p => {
      mockAdmin._positions[p.id] = { id: p.id, status: 'open', pnl: -4000, settlement_amount: 0 };
    });

    await checkAndExecuteAccountLiquidation(
      userId,
      balance,
      autoSqoffPercent,
      positions,
      -12000,
      emptyBuffers,
      mockAdmin as any,
    );

    expect(closedOrder).toEqual(['pos_oldest', 'pos_middle', 'pos_newest']);
  });

  it('TEST 3: NORMAL LOSS — Wallet = ₹10,000, Loss = ₹2,000 -> Wallet = ₹8,000, Settlement = ₹0', async () => {
    const balance = 10000;
    const mockAdmin = createMockAdminClient({ balance, auto_sqoff: 10 });

    const positions: PositionForLiquidation[] = [
      {
        id: 'pos_norm',
        user_id: userId,
        symbol: 'NSE:RELIANCE',
        side: 'BUY',
        qty_open: 10,
        entry_price: 2500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        pnl: -2000,
      },
    ];

    mockAdmin._positions['pos_norm'] = { id: 'pos_norm', status: 'open', pnl: -2000, settlement_amount: 0 };

    const res = await checkAndExecuteAccountLiquidation(
      userId,
      balance,
      10,
      positions,
      -2000,
      emptyBuffers,
      mockAdmin as any,
    );

    expect(res.liquidated).toBe(true);
    expect(mockAdmin._profile.balance).toBe(8000);
    expect(mockAdmin._profile.settlement_amount).toBe(0);
    expect(mockAdmin._settlementRecords.length).toBe(0);
  });

  it('TEST 4: LOSS EXCEEDS WALLET — Wallet = ₹1,000, Loss = ₹4,000 -> Wallet = ₹0, Actual P&L = -4,000, Settlement Loss = ₹3,000', async () => {
    const balance = 1000;
    const mockAdmin = createMockAdminClient({ balance: 1000, auto_sqoff: 50 });

    const positions: PositionForLiquidation[] = [
      {
        id: 'pos_deficit',
        user_id: userId,
        symbol: 'NSE:NIFTY',
        side: 'BUY',
        qty_open: 50,
        entry_price: 22000,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        pnl: -4000,
      },
    ];

    mockAdmin._positions['pos_deficit'] = { id: 'pos_deficit', status: 'open', pnl: -4000, settlement_amount: 0 };

    const res = await checkAndExecuteAccountLiquidation(
      userId,
      1000,
      50,
      positions,
      -4000,
      emptyBuffers,
      mockAdmin as any,
    );

    expect(res.liquidated).toBe(true);
    expect(mockAdmin._profile.balance).toBe(0);
    expect(mockAdmin._profile.settlement_amount).toBe(3000);
    expect(mockAdmin._positions['pos_deficit'].settlement_amount).toBe(3000);
    expect(mockAdmin._settlementRecords.length).toBe(1);
    expect(mockAdmin._settlementRecords[0].settlement_amount).toBe(3000);
  });

  it('TEST 5: MULTIPLE LIQUIDATIONS — Stops sequentially when floating PnL no longer breaches updated threshold', async () => {
    const balance = 10000;
    const mockAdmin = createMockAdminClient({ balance: 10000, auto_sqoff: 50 }); // threshold = -5000

    const positions: (PositionForLiquidation & { created_at: string })[] = [
      {
        id: 'pos_1',
        user_id: userId,
        symbol: 'NSE:RELIANCE',
        side: 'BUY',
        qty_open: 10,
        entry_price: 2500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        created_at: '2026-08-28T10:00:00Z',
        pnl: -4000,
      },
      {
        id: 'pos_2',
        user_id: userId,
        symbol: 'NSE:TCS',
        side: 'BUY',
        qty_open: 10,
        entry_price: 3500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        created_at: '2026-08-28T11:00:00Z',
        pnl: -3000,
      },
    ];

    mockAdmin._positions['pos_1'] = { id: 'pos_1', status: 'open', pnl: -4000, settlement_amount: 0 };
    mockAdmin._positions['pos_2'] = { id: 'pos_2', status: 'open', pnl: -3000, settlement_amount: 0 };

    const res = await checkAndExecuteAccountLiquidation(
      userId,
      10000,
      50,
      positions,
      -7000,
      emptyBuffers,
      mockAdmin as any,
    );

    expect(res.liquidated).toBe(true);
    expect(res.positionsClosed).toBe(2);
    expect(mockAdmin._profile.balance).toBe(3000);
  });

  it('TEST 6: PROFIT — Liquidated trade producing profit creates NO settlement loss', async () => {
    const balance = 5000;
    const mockAdmin = createMockAdminClient({ balance: 5000, auto_sqoff: 90 });

    const positions: PositionForLiquidation[] = [
      {
        id: 'pos_profit',
        user_id: userId,
        symbol: 'NSE:RELIANCE',
        side: 'BUY',
        qty_open: 10,
        entry_price: 2500,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        pnl: 4000,
      },
    ];

    mockAdmin._positions['pos_profit'] = { id: 'pos_profit', status: 'open', pnl: 4000, settlement_amount: 0 };

    const res = await checkAndExecuteAccountLiquidation(
      userId,
      5000,
      10,
      positions,
      -6000,
      emptyBuffers,
      mockAdmin as any,
    );

    expect(res.liquidated).toBe(true);
    expect(mockAdmin._profile.balance).toBe(9000);
    expect(mockAdmin._profile.settlement_amount).toBe(0);
    expect(mockAdmin._positions['pos_profit'].settlement_amount).toBe(0);
    expect(mockAdmin._settlementRecords.length).toBe(0);
  });

  it('TEST 7: ADMIN P&L — Preserves actual trading P&L (-4000) separately from settlement loss (3000)', () => {
    const positions = [
      { pnl: -4000, brokerage: 50, settlement_amount: 3000 },
      { pnl: 1000, brokerage: 20, settlement_amount: 0 },
    ];

    const result = aggregatePositions(positions);

    expect(result.net_pnl).toBe(-3000);
    expect(result.brokerage).toBe(70);
    expect(result.pnl_bkg).toBe(-2930);
    expect(result.settlement).toBe(3000);
  });

  it('TEST 8: DUPLICATE LIQUIDATION PROTECTION — Prevents duplicate closing or duplicate settlement logging', async () => {
    const balance = 1000;
    const mockAdmin = createMockAdminClient({ balance: 1000, auto_sqoff: 90 });

    const positions: PositionForLiquidation[] = [
      {
        id: 'pos_dup',
        user_id: userId,
        symbol: 'NSE:NIFTY',
        side: 'BUY',
        qty_open: 50,
        entry_price: 22000,
        settlement: 'NSE-EQ',
        product_type: 'INTRADAY',
        pnl: -4000,
      },
    ];

    mockAdmin._positions['pos_dup'] = { id: 'pos_dup', status: 'open', pnl: -4000, settlement_amount: 0 };

    const res1 = await checkAndExecuteAccountLiquidation(
      userId,
      1000,
      50,
      positions,
      -4000,
      emptyBuffers,
      mockAdmin as any,
    );

    expect(res1.liquidated).toBe(true);
    expect(res1.positionsClosed).toBe(1);
    expect(mockAdmin._profile.balance).toBe(0);
    expect(mockAdmin._profile.settlement_amount).toBe(3000);
    expect(mockAdmin._settlementRecords.length).toBe(1);

    positions[0].ltp = 22000;
    const res2 = await checkAndExecuteAccountLiquidation(
      userId,
      0,
      50,
      positions,
      -4000,
      emptyBuffers,
      mockAdmin as any,
    );

    expect(mockAdmin._settlementRecords.length).toBe(1);
    expect(mockAdmin._profile.balance).toBe(0);
    expect(mockAdmin._profile.settlement_amount).toBe(3000);
  });
});
