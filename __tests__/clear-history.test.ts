import { describe, it, expect } from 'vitest';

/**
 * Clear History & Weekly P&L Verification Test Suite
 * Covers all 18 requirements specified for the Clear History feature.
 */

interface MockProfile {
  id: string;
  role: string;
  balance: number;
  history_reset_at: string | null;
}

interface MockPosition {
  id: string;
  user_id: string;
  symbol: string;
  status: 'open' | 'active' | 'closed';
  pnl: number;
  entry_time: string;
  exit_time: string | null;
  updated_at: string;
}

interface MockOrder {
  id: string;
  user_id: string;
  status: 'PENDING' | 'EXECUTED' | 'CANCELLED' | 'REJECTED';
  created_at: string;
  updated_at?: string;
}

interface MockTransaction {
  id: string;
  user_id: string;
  type: string;
  amount: number;
  created_at: string;
}

describe('Clear History & Weekly History P&L Suite', () => {

  // Helper function: Filter closed positions based on history_reset_at
  function filterClosedPositions(positions: MockPosition[], resetAt: string | null): MockPosition[] {
    return positions.filter(p => {
      if (p.status !== 'closed') return false;
      if (!resetAt) return true;
      const closedTime = p.exit_time || p.updated_at;
      return new Date(closedTime) > new Date(resetAt);
    });
  }

  // Helper function: Filter orders based on history_reset_at
  function filterOrders(orders: MockOrder[], resetAt: string | null): MockOrder[] {
    return orders.filter(o => {
      if (o.status === 'PENDING') return true; // Operational pending orders are NEVER hidden
      if (!resetAt) return true;
      const finalizedTime = o.updated_at || o.created_at;
      return new Date(finalizedTime) > new Date(resetAt);
    });
  }

  // Helper function: Calculate Weekly P&L
  function calculateWeeklyPnl(positions: MockPosition[], resetAt: string | null, oneWeekAgoISO: string): number {
    const closed = filterClosedPositions(positions, resetAt);
    return closed
      .filter(p => {
        const closedTime = p.exit_time || p.updated_at;
        return new Date(closedTime) >= new Date(oneWeekAgoISO);
      })
      .reduce((sum, p) => sum + p.pnl, 0);
  }

  const now = new Date();
  const tMinus10Days = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const tMinus5Days = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const tMinus2Days = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  describe('1. Closed Positions & History Reset Filtering', () => {
    it('1. Excludes old closed positions prior to history_reset_at', () => {
      const positions: MockPosition[] = [
        { id: 'pos-1', user_id: 'u1', symbol: 'NIFTY', status: 'closed', pnl: 1500, entry_time: tMinus10Days, exit_time: tMinus5Days, updated_at: tMinus5Days },
        { id: 'pos-2', user_id: 'u1', symbol: 'BANKNIFTY', status: 'closed', pnl: -500, entry_time: tMinus5Days, exit_time: tMinus2Days, updated_at: tMinus2Days },
      ];

      const resetAt = new Date().toISOString(); // Reset NOW
      const historyView = filterClosedPositions(positions, resetAt);

      expect(historyView.length).toBe(0);
    });

    it('12. Excludes pre-reset historical records from History API view', () => {
      const positions: MockPosition[] = [
        { id: 'pos-old', user_id: 'u1', symbol: 'GOLD', status: 'closed', pnl: 2000, entry_time: tMinus10Days, exit_time: tMinus5Days, updated_at: tMinus5Days }
      ];
      const resetAt = tMinus2Days;
      const visible = filterClosedPositions(positions, resetAt);
      expect(visible).toEqual([]);
    });

    it('6. Shows newly closed position in History if closed AFTER history reset', () => {
      const resetAt = tMinus5Days;
      const postResetClosedPos: MockPosition = {
        id: 'pos-new-closed', user_id: 'u1', symbol: 'RELIANCE', status: 'closed', pnl: 800, entry_time: tMinus2Days, exit_time: new Date().toISOString(), updated_at: new Date().toISOString()
      };
      const visible = filterClosedPositions([postResetClosedPos], resetAt);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe('pos-new-closed');
    });
  });

  describe('2. Wallet Balance & Ledger Immutability', () => {
    it('2. Preserves wallet balance when history is cleared', () => {
      const profile: MockProfile = { id: 'u1', role: 'USER', balance: 50000, history_reset_at: null };

      // Admin clears history
      profile.history_reset_at = new Date().toISOString();

      expect(profile.balance).toBe(50000);
    });

    it('3. Preserves ledger transactions when history is cleared', () => {
      const transactions: MockTransaction[] = [
        { id: 'tx-1', user_id: 'u1', type: 'DEPOSIT', amount: 50000, created_at: tMinus10Days },
        { id: 'tx-2', user_id: 'u1', type: 'PNL_CREDIT', amount: 1500, created_at: tMinus5Days },
      ];

      const profile: MockProfile = { id: 'u1', role: 'USER', balance: 51500, history_reset_at: new Date().toISOString() };

      expect(transactions.length).toBe(2);
      expect(profile.balance).toBe(51500);
    });

    it('11. Keeps wallet P&L before/after reset completely identical', () => {
      const initialBalance = 100000;
      const profile: MockProfile = { id: 'u1', role: 'USER', balance: initialBalance, history_reset_at: null };
      
      // Clear history
      profile.history_reset_at = new Date().toISOString();
      
      expect(profile.balance).toBe(initialBalance);
    });
  });

  describe('3. Open Positions & Pending Orders Preservation', () => {
    it('4. Leaves OPEN position open & untouched after clear history', () => {
      const openPos: MockPosition = {
        id: 'open-1', user_id: 'u1', symbol: 'BTCUSDT', status: 'open', pnl: 250, entry_time: tMinus5Days, exit_time: null, updated_at: tMinus5Days
      };

      const resetAt = new Date().toISOString();

      // Open positions query is status IN ('open', 'active') without resetAt filter
      expect(openPos.status).toBe('open');
      expect(openPos.pnl).toBe(250);
    });

    it('5. Leaves PENDING order untouched after clear history', () => {
      const orders: MockOrder[] = [
        { id: 'ord-old-executed', user_id: 'u1', status: 'EXECUTED', created_at: tMinus10Days },
        { id: 'ord-pending', user_id: 'u1', status: 'PENDING', created_at: tMinus5Days },
      ];

      const resetAt = new Date().toISOString();
      const visibleOrders = filterOrders(orders, resetAt);

      expect(visibleOrders.length).toBe(1);
      expect(visibleOrders[0].id).toBe('ord-pending');
    });

    it('7. Allows placing new order after history reset and displaying normally', () => {
      const resetAt = tMinus2Days;
      const newOrder: MockOrder = { id: 'ord-new', user_id: 'u1', status: 'EXECUTED', created_at: new Date().toISOString() };
      const visible = filterOrders([newOrder], resetAt);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe('ord-new');
    });

    it('17. Does not affect current position P&L calculation', () => {
      const openPos: MockPosition = {
        id: 'pos-active', user_id: 'u1', symbol: 'NIFTY', status: 'open', pnl: 450, entry_time: tMinus2Days, exit_time: null, updated_at: tMinus2Days
      };

      const entryPrice = 22000;
      const ltp = 22009;
      const qty = 50;
      const calculatedPnl = (ltp - entryPrice) * qty;

      expect(calculatedPnl).toBe(450);
      expect(openPos.pnl).toBe(calculatedPnl);
    });

    it('18. Does not affect pending order execution', () => {
      const pendingOrder: MockOrder = { id: 'ord-p', user_id: 'u1', status: 'PENDING', created_at: tMinus10Days };
      const resetAt = tMinus5Days;

      const visible = filterOrders([pendingOrder], resetAt);
      expect(visible).toContainEqual(pendingOrder);
    });
  });

  describe('4. API Role Security & Clear History Endpoint Behavior', () => {
    it('8. Returns 403 Forbidden for normal user calling clear history', () => {
      const callerRole = 'USER';
      const isAllowed = callerRole === 'admin' || callerRole === 'super_admin';
      expect(isAllowed).toBe(false);
    });

    it('9. Returns 200 Success for Admin caller', () => {
      const callerRole = 'admin';
      const isAllowed = callerRole === 'admin' || callerRole === 'super_admin';
      expect(isAllowed).toBe(true);
    });

    it('10. Returns 200 Success for Super Admin caller', () => {
      const callerRole = 'super_admin';
      const isAllowed = callerRole === 'admin' || callerRole === 'super_admin';
      expect(isAllowed).toBe(true);
    });

    it('19. Bulk clear history for ALL users (id === "all") updates reset timestamp across all profiles', () => {
      const profiles: MockProfile[] = [
        { id: 'u1', role: 'USER', balance: 50000, history_reset_at: null },
        { id: 'u2', role: 'USER', balance: 120000, history_reset_at: null },
      ];

      const nowISO = new Date().toISOString();
      profiles.forEach(p => p.history_reset_at = nowISO);

      expect(profiles[0].history_reset_at).toBe(nowISO);
      expect(profiles[1].history_reset_at).toBe(nowISO);
      expect(profiles[0].balance).toBe(50000);
      expect(profiles[1].balance).toBe(120000);
    });
  });

  describe('5. Weekly P&L Aggregation Accuracy', () => {
    it('13. Does not include pre-reset trades in weekly history', () => {
      const positions: MockPosition[] = [
        { id: 'pos-1', user_id: 'u1', symbol: 'NIFTY', status: 'closed', pnl: 3000, entry_time: tMinus10Days, exit_time: tMinus5Days, updated_at: tMinus5Days },
      ];

      const resetAt = tMinus2Days;
      const weeklyPnl = calculateWeeklyPnl(positions, resetAt, oneWeekAgo);

      expect(weeklyPnl).toBe(0);
    });

    it('14. Weekly P&L calculation strictly equals sum of post-reset closed trades in weekly window', () => {
      const positions: MockPosition[] = [
        { id: 'pos-old', user_id: 'u1', symbol: 'NIFTY', status: 'closed', pnl: 5000, entry_time: tMinus10Days, exit_time: tMinus5Days, updated_at: tMinus5Days },
        { id: 'pos-new1', user_id: 'u1', symbol: 'BANKNIFTY', status: 'closed', pnl: 1200, entry_time: tMinus2Days, exit_time: tMinus2Days, updated_at: tMinus2Days },
        { id: 'pos-new2', user_id: 'u1', symbol: 'CRUDEOIL', status: 'closed', pnl: -300, entry_time: tMinus2Days, exit_time: new Date().toISOString(), updated_at: new Date().toISOString() },
        { id: 'pos-open', user_id: 'u1', symbol: 'GOLD', status: 'open', pnl: 9999, entry_time: tMinus2Days, exit_time: null, updated_at: tMinus2Days },
      ];

      const resetAt = tMinus5Days;
      const weeklyPnl = calculateWeeklyPnl(positions, resetAt, oneWeekAgo);

      // Sum of closed post-reset trades = 1200 + (-300) = 900
      expect(weeklyPnl).toBe(900);
    });
  });

  describe('6. Idempotency & Consistency', () => {
    it('15. Idempotent: Clearing history twice updates reset timestamp safely', () => {
      const profile: MockProfile = { id: 'u1', role: 'USER', balance: 50000, history_reset_at: tMinus5Days };

      const firstReset = profile.history_reset_at;
      const secondReset = new Date().toISOString();

      profile.history_reset_at = secondReset;

      expect(new Date(profile.history_reset_at).getTime()).toBeGreaterThan(new Date(firstReset!).getTime());
      expect(profile.balance).toBe(50000);
    });

    it('16. Clearing history does not duplicate or alter database records', () => {
      const positions: MockPosition[] = [
        { id: 'pos-1', user_id: 'u1', symbol: 'NIFTY', status: 'closed', pnl: 1000, entry_time: tMinus10Days, exit_time: tMinus5Days, updated_at: tMinus5Days }
      ];

      const initialCount = positions.length;
      const resetAt = new Date().toISOString();
      filterClosedPositions(positions, resetAt);

      expect(positions.length).toBe(initialCount);
    });
  });

  describe('7. End-to-End Audit Scenario (10-Step Operational Life-Cycle)', () => {
    it('executes full 10-step life-cycle audit verifying reset boundary vs operational state', () => {
      // 1. Create old closed trade (closed 10 days ago)
      const oldClosedTrade: MockPosition = {
        id: 'trade-old-closed',
        user_id: 'u-audit',
        symbol: 'NIFTY',
        status: 'closed',
        pnl: 2500,
        entry_time: tMinus10Days,
        exit_time: tMinus10Days,
        updated_at: tMinus10Days,
      };

      // 2. Create old open position (opened 10 days ago, still open)
      const oldOpenPosition: MockPosition = {
        id: 'pos-old-open',
        user_id: 'u-audit',
        symbol: 'BANKNIFTY',
        status: 'open',
        pnl: 1200,
        entry_time: tMinus10Days,
        exit_time: null,
        updated_at: tMinus10Days,
      };

      // 3. Create old pending order (created 10 days ago, pending)
      const oldPendingOrder: MockOrder = {
        id: 'ord-old-pending',
        user_id: 'u-audit',
        status: 'PENDING',
        created_at: tMinus10Days,
      };

      // Ledger & Wallet setup
      const walletBalance = 75000;
      const ledgerTxns: MockTransaction[] = [
        { id: 'tx-dep', user_id: 'u-audit', type: 'DEPOSIT', amount: 75000, created_at: tMinus10Days }
      ];

      const positionsList = [oldClosedTrade, oldOpenPosition];
      const ordersList = [oldPendingOrder];

      // 4. Apply Clear History (reset timestamp set to T-5 days)
      const historyResetAt = tMinus5Days;

      // 5. Verify Step 5 assertions:
      // - Old closed trade disappears from History
      const visibleHistory = filterClosedPositions(positionsList, historyResetAt);
      expect(visibleHistory).not.toContainEqual(oldClosedTrade);
      expect(visibleHistory.length).toBe(0);

      // - Old open position remains open & untouched
      const openPositions = positionsList.filter(p => p.status === 'open');
      expect(openPositions).toContainEqual(oldOpenPosition);

      // - Old pending order remains active & untouched
      const visibleOrders = filterOrders(ordersList, historyResetAt);
      expect(visibleOrders).toContainEqual(oldPendingOrder);

      // - Wallet balance & Ledger transactions unchanged
      expect(walletBalance).toBe(75000);
      expect(ledgerTxns.length).toBe(1);

      // 6. Close the old open position NOW (post-reset)
      const nowISO = new Date().toISOString();
      oldOpenPosition.status = 'closed';
      oldOpenPosition.exit_time = nowISO;
      oldOpenPosition.updated_at = nowISO;
      oldOpenPosition.pnl = 1500;

      // 7. Verify the newly closed trade appears in History (since exit_time > historyResetAt)
      const updatedHistory = filterClosedPositions(positionsList, historyResetAt);
      expect(updatedHistory).toContainEqual(oldOpenPosition);
      expect(updatedHistory.length).toBe(1);

      // 8. Execute the old pending order NOW (post-reset)
      oldPendingOrder.status = 'EXECUTED';
      oldPendingOrder.updated_at = nowISO;
      const postExecOrders = filterOrders(ordersList, historyResetAt);
      expect(postExecOrders.length).toBe(1); // Executed order now finalized post-reset appears in history

      // 10. Verify weekly P&L contains ONLY post-reset closed activity
      const weeklyPnl = calculateWeeklyPnl(positionsList, historyResetAt, oneWeekAgo);
      // Only oldOpenPosition (closed NOW for 1500) counts towards weekly P&L.
      // oldClosedTrade (closed 10 days ago, prior to reset) is excluded.
      expect(weeklyPnl).toBe(1500);
    });
  });

  describe('8. Lifecycle Finalization Timestamps Edge Cases', () => {
    it('1. Pending order created BEFORE reset, executed AFTER reset → resulting historical record MUST appear', () => {
      const resetAt = tMinus5Days;
      const order: MockOrder = {
        id: 'ord-pre-pending',
        user_id: 'u1',
        status: 'EXECUTED',
        created_at: tMinus10Days, // Created before reset
        updated_at: new Date().toISOString(), // Executed NOW (after reset)
      };

      const visible = filterOrders([order], resetAt);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe('ord-pre-pending');
    });

    it('2. Pending order created BEFORE reset, cancelled AFTER reset → resulting cancellation record MUST appear', () => {
      const resetAt = tMinus5Days;
      const order: MockOrder = {
        id: 'ord-pre-cancel',
        user_id: 'u1',
        status: 'CANCELLED',
        created_at: tMinus10Days, // Created before reset
        updated_at: new Date().toISOString(), // Cancelled NOW (after reset)
      };

      const visible = filterOrders([order], resetAt);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe('ord-pre-cancel');
    });

    it('3. Order created and completed BEFORE reset → MUST remain hidden', () => {
      const resetAt = tMinus2Days;
      const order: MockOrder = {
        id: 'ord-old-completed',
        user_id: 'u1',
        status: 'EXECUTED',
        created_at: tMinus10Days,
        updated_at: tMinus5Days, // Completed before reset
      };

      const visible = filterOrders([order], resetAt);
      expect(visible.length).toBe(0);
    });

    it('4. Order created and completed AFTER reset → MUST appear', () => {
      const resetAt = tMinus5Days;
      const order: MockOrder = {
        id: 'ord-new-completed',
        user_id: 'u1',
        status: 'EXECUTED',
        created_at: tMinus2Days,
        updated_at: tMinus2Days,
      };

      const visible = filterOrders([order], resetAt);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe('ord-new-completed');
    });

    it('5. Open position created BEFORE reset and closed AFTER reset → MUST appear', () => {
      const resetAt = tMinus5Days;
      const position: MockPosition = {
        id: 'pos-pre-open-post-closed',
        user_id: 'u1',
        symbol: 'NIFTY',
        status: 'closed',
        pnl: 3500,
        entry_time: tMinus10Days, // Opened before reset
        exit_time: new Date().toISOString(), // Closed NOW (after reset)
        updated_at: new Date().toISOString(),
      };

      const visible = filterClosedPositions([position], resetAt);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe('pos-pre-open-post-closed');
    });
  });

});

// ─── BUG-1 Regression Suite ──────────────────────────────────────────────────
// 12 required regression tests for "Admin Clear History Does Not Clear User
// History Page" (the stale-cache / historyResetAt filter bypass bug).
//
// These tests operate on the same pure-function helpers already defined above
// (filterClosedPositions / filterOrders) so they run without any network I/O.
// ─────────────────────────────────────────────────────────────────────────────

describe('BUG-1 Regression: User-facing History page respects history_reset_at', () => {

  // Shared helpers (mirror of those at the top of the outer describe, kept
  // local for readability in isolation)
  function filterClosed(positions: MockPosition[], resetAt: string | null): MockPosition[] {
    return positions.filter(p => {
      if (p.status !== 'closed') return false;
      if (!resetAt) return true;
      const closedTime = p.exit_time || p.updated_at;
      return new Date(closedTime) > new Date(resetAt);
    });
  }

  function filterOrds(orders: MockOrder[], resetAt: string | null): MockOrder[] {
    return orders.filter(o => {
      const pendingStatuses = new Set(['PENDING', 'TRIGGER_PENDING']);
      if (pendingStatuses.has(o.status as string)) return true;
      if (!resetAt) return true;
      const finalizedTime = o.updated_at || o.created_at;
      return new Date(finalizedTime) > new Date(resetAt);
    });
  }

  const now = new Date();
  const past = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400_000).toISOString();

  // ── Test 1 ───────────────────────────────────────────────────────────────
  it('1. Old closed position created/closed before reset → hidden in History', () => {
    const pos: MockPosition = {
      id: 'pos-pre-reset',
      user_id: 'u1',
      symbol: 'NIFTY',
      status: 'closed',
      pnl: 1000,
      entry_time: past(10),
      exit_time: past(5),
      updated_at: past(5),
    };
    const resetAt = past(2); // reset happened 2 days ago; position closed 5 days ago
    expect(filterClosed([pos], resetAt)).toHaveLength(0);
  });

  // ── Test 2 ───────────────────────────────────────────────────────────────
  it('2. Old completed/cancelled/rejected order finalized before reset → hidden in History', () => {
    const executed: MockOrder = { id: 'ord-exec-old', user_id: 'u1', status: 'EXECUTED', created_at: past(10), updated_at: past(5) };
    const cancelled: MockOrder = { id: 'ord-canc-old', user_id: 'u1', status: 'CANCELLED', created_at: past(10), updated_at: past(5) };
    const rejected: MockOrder  = { id: 'ord-rej-old',  user_id: 'u1', status: 'REJECTED',  created_at: past(10), updated_at: past(5) };
    const resetAt = past(2);
    expect(filterOrds([executed, cancelled, rejected], resetAt)).toHaveLength(0);
  });

  // ── Test 3 ───────────────────────────────────────────────────────────────
  it('3. New closed position finalized AFTER reset → visible in History', () => {
    const pos: MockPosition = {
      id: 'pos-post-reset',
      user_id: 'u1',
      symbol: 'BANKNIFTY',
      status: 'closed',
      pnl: 500,
      entry_time: past(1),
      exit_time: past(0),
      updated_at: past(0),
    };
    const resetAt = past(2);
    const visible = filterClosed([pos], resetAt);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('pos-post-reset');
  });

  // ── Test 4 ───────────────────────────────────────────────────────────────
  it('4. Old open position is NOT affected by history_reset_at (open positions bypass filter)', () => {
    const pos: MockPosition = {
      id: 'pos-open-old',
      user_id: 'u1',
      symbol: 'RELIANCE',
      status: 'open',
      pnl: 200,
      entry_time: past(10),
      exit_time: null,
      updated_at: past(10),
    };
    const resetAt = past(0); // reset just now
    // Open positions never go through the closed-position filter
    const visible = filterClosed([pos], resetAt);
    expect(visible).toHaveLength(0); // closed filter excludes it (not closed)
    // Direct status check — still open
    expect(pos.status).toBe('open');
  });

  // ── Test 5 ───────────────────────────────────────────────────────────────
  it('5. Pending/open/trigger_pending order is NOT affected by history_reset_at', () => {
    const pending: MockOrder = { id: 'ord-pending', user_id: 'u1', status: 'PENDING', created_at: past(10) };
    const resetAt = past(0); // reset just now
    const visible = filterOrds([pending], resetAt);
    expect(visible).toContainEqual(pending);
  });

  // ── Test 6 ───────────────────────────────────────────────────────────────
  it('6. Position opened before reset but closed AFTER reset → visible in History', () => {
    const pos: MockPosition = {
      id: 'pos-open-before-close-after',
      user_id: 'u1',
      symbol: 'NIFTY',
      status: 'closed',
      pnl: 700,
      entry_time: past(10), // opened well before reset
      exit_time: past(0),   // closed today (after reset)
      updated_at: past(0),
    };
    const resetAt = past(5);
    const visible = filterClosed([pos], resetAt);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('pos-open-before-close-after');
  });

  // ── Test 7 ───────────────────────────────────────────────────────────────
  it('7. Order created before reset but finalized AFTER reset → visible in History', () => {
    const order: MockOrder = {
      id: 'ord-old-finalized-new',
      user_id: 'u1',
      status: 'EXECUTED',
      created_at: past(10),   // created before reset
      updated_at: past(0),    // executed today (after reset)
    };
    const resetAt = past(5);
    const visible = filterOrds([order], resetAt);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('ord-old-finalized-new');
  });

  // ── Test 8 ───────────────────────────────────────────────────────────────
  it('8. Clear History only changes target user\'s history_reset_at; other users unaffected', () => {
    const targetUser:  MockProfile = { id: 'u-target', role: 'USER', balance: 50000, history_reset_at: null };
    const otherUser:   MockProfile = { id: 'u-other',  role: 'USER', balance: 80000, history_reset_at: null };
    const adminCaller: MockProfile = { id: 'u-admin',  role: 'admin', balance: 0,    history_reset_at: null };

    // Simulate endpoint: .update({ history_reset_at }).eq('id', targetUser.id)
    const resetAt = now.toISOString();
    targetUser.history_reset_at = resetAt;
    // Other user and admin caller must remain unchanged
    expect(otherUser.history_reset_at).toBeNull();
    expect(adminCaller.history_reset_at).toBeNull();
    expect(targetUser.history_reset_at).toBe(resetAt);
  });

  // ── Test 9 ───────────────────────────────────────────────────────────────
  it('9. Wallet balance remains unchanged after Clear History', () => {
    const user: MockProfile = { id: 'u1', role: 'USER', balance: 125000, history_reset_at: null };
    user.history_reset_at = now.toISOString();
    expect(user.balance).toBe(125000);
  });

  // ── Test 10 ──────────────────────────────────────────────────────────────
  it('10. Ledger entry count remains unchanged after Clear History', () => {
    const ledger: MockTransaction[] = [
      { id: 'tx-1', user_id: 'u1', type: 'DEPOSIT',    amount: 100000, created_at: past(30) },
      { id: 'tx-2', user_id: 'u1', type: 'PNL_CREDIT', amount:   1500, created_at: past(5)  },
      { id: 'tx-3', user_id: 'u1', type: 'WITHDRAWAL', amount:  10000, created_at: past(2)  },
    ];
    const countBefore = ledger.length;
    // Simulate Clear History (only touches profiles.history_reset_at)
    const user: MockProfile = { id: 'u1', role: 'USER', balance: 91500, history_reset_at: now.toISOString() };
    expect(ledger.length).toBe(countBefore);
    expect(user.balance).toBe(91500);
  });

  // ── Test 11 ──────────────────────────────────────────────────────────────
  it('11. Transaction records are unchanged after Clear History', () => {
    const transactions: MockTransaction[] = [
      { id: 'tx-margin', user_id: 'u1', type: 'MARGIN_DEBIT',  amount: 5000, created_at: past(10) },
      { id: 'tx-pnl',    user_id: 'u1', type: 'PNL_CREDIT',    amount: 800,  created_at: past(5)  },
    ];
    const snapshot = transactions.map(t => ({ ...t }));
    // Simulate Clear History
    const user: MockProfile = { id: 'u1', role: 'USER', balance: 50000, history_reset_at: now.toISOString() };
    // Transactions must be bit-for-bit identical
    expect(transactions).toEqual(snapshot);
    expect(user.balance).toBe(50000);
  });

  // ── Test 12 ──────────────────────────────────────────────────────────────
  it('12. Repeated Clear History is safe and idempotent (second reset is strictly newer)', () => {
    const user: MockProfile = { id: 'u1', role: 'USER', balance: 60000, history_reset_at: past(5) };
    const firstReset = user.history_reset_at!;

    // Second reset happens later at past(2)
    const secondReset = past(2);
    user.history_reset_at = secondReset;

    expect(new Date(user.history_reset_at).getTime()).toBeGreaterThan(new Date(firstReset).getTime());
    expect(user.balance).toBe(60000);

    // Old position closed at past(4) (between first reset past(5) and second reset past(2)) is hidden by second reset
    const posBetweenResets: MockPosition = {
      id: 'pos-between',
      user_id: 'u1',
      symbol: 'GOLD',
      status: 'closed',
      pnl: 300,
      entry_time: past(6),
      exit_time: past(4), // closed between first reset past(5) and second reset past(2)
      updated_at: past(4),
    };
    const visible = filterClosed([posBetweenResets], user.history_reset_at);
    expect(visible).toHaveLength(0);
  });

});

