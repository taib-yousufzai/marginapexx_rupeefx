import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface Profile {
  id: string;
  role: 'super_admin' | 'admin' | 'broker' | 'user';
  parent_id: string | null;
  history_reset_at?: string | null;
}

export interface Position {
  id: string;
  user_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'open' | 'active' | 'closed';
  qty_open: number;
  entry_price: number;
  ltp: number;
  pnl: number;
  created_at: string;
  updated_at: string;
}

// ─── Pure RBAC Authorization Helpers ─────────────────────────────────────────

export function isAuthorizedToViewUser(
  caller: Profile,
  targetUserId: string,
  profilesMap: Record<string, Profile>
): boolean {
  if (caller.role === 'super_admin') return true;
  if (caller.id === targetUserId) return true;

  const targetProfile = profilesMap[targetUserId];
  if (!targetProfile) return false;

  if (caller.role === 'broker') {
    return targetProfile.parent_id === caller.id;
  }

  if (caller.role === 'admin') {
    if (targetProfile.parent_id === caller.id) return true;
    if (targetProfile.parent_id) {
      const parentProfile = profilesMap[targetProfile.parent_id];
      if (parentProfile && parentProfile.parent_id === caller.id) {
        return true;
      }
    }
    return false;
  }

  return false;
}

export function filterPositionsForViewer(
  viewer: Profile,
  targetUserId: string,
  allPositions: Position[],
  profilesMap: Record<string, Profile>
): Position[] | { error: string; status: number } {
  // Authorization check
  const authorized = isAuthorizedToViewUser(viewer, targetUserId, profilesMap);
  if (!authorized) {
    return { error: 'Forbidden', status: 403 };
  }

  // Data Query check — Query by targetUserId, NOT viewer.id
  return allPositions.filter(p => p.user_id === targetUserId && ['open', 'active'].includes(p.status.toLowerCase()));
}

export function computeLiveMetrics(pos: Position, currentLtp: number): { unrealisedPnl: number; totalPnl: number } {
  const diff = pos.side === 'BUY' ? currentLtp - pos.entry_price : pos.entry_price - currentLtp;
  const unrealisedPnl = diff * pos.qty_open;
  return {
    unrealisedPnl,
    totalPnl: pos.status === 'closed' ? pos.pnl : unrealisedPnl,
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('BUG #2 — Live / Open Positions RBAC & Visibility Regression Suite', () => {
  let profiles: Record<string, Profile>;
  let positions: Position[];

  beforeEach(() => {
    // Role Hierarchy Setup:
    // Super Admin: sa-1
    // Admin 1: adm-1 (Parent: sa-1)
    // Admin 2: adm-2 (Unrelated Admin)
    // Broker 1: brk-1 (Parent: adm-1)
    // Broker 2: brk-2 (Parent: adm-2)
    // User 1: usr-1 (Parent: brk-1) — belongs to Broker 1 under Admin 1
    // User 2: usr-2 (Parent: adm-1) — directly under Admin 1
    // User 3: usr-3 (Parent: brk-2) — belongs to Broker 2 under Admin 2

    profiles = {
      'sa-1':  { id: 'sa-1',  role: 'super_admin', parent_id: null },
      'adm-1': { id: 'adm-1', role: 'admin',       parent_id: 'sa-1' },
      'adm-2': { id: 'adm-2', role: 'admin',       parent_id: 'sa-1' },
      'brk-1': { id: 'brk-1', role: 'broker',      parent_id: 'adm-1' },
      'brk-2': { id: 'brk-2', role: 'broker',      parent_id: 'adm-2' },
      'usr-1': { id: 'usr-1', role: 'user',        parent_id: 'brk-1', history_reset_at: new Date(Date.now() - 3600000).toISOString() },
      'usr-2': { id: 'usr-2', role: 'user',        parent_id: 'adm-1' },
      'usr-3': { id: 'usr-3', role: 'user',        parent_id: 'brk-2' },
    };

    const pastDate = new Date(Date.now() - 7200000).toISOString();

    positions = [
      { id: 'pos-usr1-open', user_id: 'usr-1', symbol: 'GOLD', side: 'BUY', status: 'open', qty_open: 10, entry_price: 50000, ltp: 51000, pnl: 10000, created_at: pastDate, updated_at: pastDate },
      { id: 'pos-usr2-open', user_id: 'usr-2', symbol: 'SILVER', side: 'SELL', status: 'open', qty_open: 5, entry_price: 70000, ltp: 69000, pnl: 5000, created_at: pastDate, updated_at: pastDate },
      { id: 'pos-usr3-open', user_id: 'usr-3', symbol: 'CRUDEOIL', side: 'BUY', status: 'active', qty_open: 20, entry_price: 6000, ltp: 6100, pnl: 2000, created_at: pastDate, updated_at: pastDate },
      { id: 'pos-adm1-open', user_id: 'adm-1', symbol: 'NIFTY', side: 'BUY', status: 'open', qty_open: 50, entry_price: 22000, ltp: 22100, pnl: 5000, created_at: pastDate, updated_at: pastDate },
    ];
  });

  // ── USER Tests ─────────────────────────────────────────────────────────────
  it("1. User can see their own OPEN position", () => {
    const res = filterPositionsForViewer(profiles['usr-1'], 'usr-1', positions, profiles);
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
    expect((res as Position[])[0].id).toBe('pos-usr1-open');
  });

  it("2. User cannot see another user's position", () => {
    const res = filterPositionsForViewer(profiles['usr-1'], 'usr-2', positions, profiles);
    expect(res).toEqual({ error: 'Forbidden', status: 403 });
  });

  it("3. User's own position remains visible regardless of admin/broker relationship", () => {
    const res = filterPositionsForViewer(profiles['usr-1'], 'usr-1', positions, profiles);
    expect(Array.isArray(res)).toBe(true);
    expect((res as Position[])[0].user_id).toBe('usr-1');
  });

  // ── BROKER Tests ───────────────────────────────────────────────────────────
  it("4. Broker can see their own user's OPEN position", () => {
    const res = filterPositionsForViewer(profiles['brk-1'], 'usr-1', positions, profiles);
    expect(Array.isArray(res)).toBe(true);
    expect((res as Position[])[0].id).toBe('pos-usr1-open');
  });

  it("5. Broker cannot see another broker's user's position", () => {
    const res = filterPositionsForViewer(profiles['brk-1'], 'usr-3', positions, profiles);
    expect(res).toEqual({ error: 'Forbidden', status: 403 });
  });

  // ── ADMIN Tests ────────────────────────────────────────────────────────────
  it("6. Admin can see their directly assigned user's OPEN position", () => {
    const res = filterPositionsForViewer(profiles['adm-1'], 'usr-2', positions, profiles);
    expect(Array.isArray(res)).toBe(true);
    expect((res as Position[])[0].id).toBe('pos-usr2-open');
  });

  it("7. Admin can see broker-under-admin user's OPEN position", () => {
    const res = filterPositionsForViewer(profiles['adm-1'], 'usr-1', positions, profiles);
    expect(Array.isArray(res)).toBe(true);
    expect((res as Position[])[0].id).toBe('pos-usr1-open');
  });

  it("8. Admin cannot see unrelated user's OPEN position", () => {
    const res = filterPositionsForViewer(profiles['adm-1'], 'usr-3', positions, profiles);
    expect(res).toEqual({ error: 'Forbidden', status: 403 });
  });

  // ── SUPER ADMIN Tests ──────────────────────────────────────────────────────
  it("9. Super Admin can see any authorized user's OPEN position", () => {
    const res = filterPositionsForViewer(profiles['sa-1'], 'usr-3', positions, profiles);
    expect(Array.isArray(res)).toBe(true);
    expect((res as Position[])[0].id).toBe('pos-usr3-open');
  });

  it("10. Super Admin can see broker user's OPEN position", () => {
    const res = filterPositionsForViewer(profiles['sa-1'], 'usr-1', positions, profiles);
    expect(Array.isArray(res)).toBe(true);
    expect((res as Position[])[0].id).toBe('pos-usr1-open');
  });

  // ── TARGET USER / SEPARATION Tests ────────────────────────────────────────
  it("11. Admin viewing User X gets User X's position, not Admin's positions", () => {
    const res = filterPositionsForViewer(profiles['adm-1'], 'usr-1', positions, profiles) as Position[];
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('pos-usr1-open');
    expect(res.some(p => p.id === 'pos-adm1-open')).toBe(false);
  });

  it("12. Super Admin viewing User X gets User X's position, not Super Admin's positions", () => {
    const res = filterPositionsForViewer(profiles['sa-1'], 'usr-2', positions, profiles) as Position[];
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('pos-usr2-open');
  });

  // ── LIVE POSITION / METRICS Tests ──────────────────────────────────────────
  it("13. Newly created OPEN position appears in Positions", () => {
    const newPos: Position = {
      id: 'pos-new',
      user_id: 'usr-1',
      symbol: 'BANKNIFTY',
      side: 'BUY',
      status: 'open',
      qty_open: 15,
      entry_price: 48000,
      ltp: 48000,
      pnl: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    positions.push(newPos);

    const res = filterPositionsForViewer(profiles['usr-1'], 'usr-1', positions, profiles) as Position[];
    expect(res.map(p => p.id)).toContain('pos-new');
  });

  it("14. Existing OPEN position remains visible after role-based filtering", () => {
    const res = filterPositionsForViewer(profiles['adm-1'], 'usr-1', positions, profiles) as Position[];
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].status).toMatch(/open|active/i);
  });

  it("15. Position's live price continues updating", () => {
    const pos = positions[0];
    const initialMetrics = computeLiveMetrics(pos, 51000);
    expect(initialMetrics.unrealisedPnl).toBe(10000); // (51000 - 50000) * 10

    // Price updates to 52000
    const updatedMetrics = computeLiveMetrics(pos, 52000);
    expect(updatedMetrics.unrealisedPnl).toBe(20000); // (52000 - 50000) * 10
  });

  it("16. Position P&L continues updating", () => {
    const pos = positions[1]; // SELL position, entry 70000, qty 5
    const metrics1 = computeLiveMetrics(pos, 69000);
    expect(metrics1.unrealisedPnl).toBe(5000); // (70000 - 69000) * 5

    // Price drops further to 68000
    const metrics2 = computeLiveMetrics(pos, 68000);
    expect(metrics2.unrealisedPnl).toBe(10000); // (70000 - 68000) * 5
  });

  it("17. history_reset_at does NOT hide an OPEN position", () => {
    // usr-1 created_at for pos-usr1-open is 2h ago; history_reset_at is 1h ago.
    // OPEN positions bypass history_reset_at filtering entirely.
    const res = filterPositionsForViewer(profiles['usr-1'], 'usr-1', positions, profiles) as Position[];
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('pos-usr1-open');
  });
});
