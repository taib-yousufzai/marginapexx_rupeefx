import { describe, it, expect, vi } from 'vitest';
import { isUserInHierarchy, getDescendantUserIds, assertUserInHierarchy } from '@/lib/hierarchy';
import { hasPermission } from '@/lib/permissions';

describe('Role-Based Hierarchy & Access Control Tests', () => {
  // Mock profiles database
  const profilesMap: Record<string, { id: string; role: string; parent_id: string | null }> = {
    'super_admin_id': { id: 'super_admin_id', role: 'super_admin', parent_id: null },
    'admin_1_id':     { id: 'admin_1_id', role: 'admin', parent_id: 'super_admin_id' },
    'admin_2_id':     { id: 'admin_2_id', role: 'admin', parent_id: 'super_admin_id' },
    'broker_1a_id':   { id: 'broker_1a_id', role: 'broker', parent_id: 'admin_1_id' },
    'broker_2a_id':   { id: 'broker_2a_id', role: 'broker', parent_id: 'admin_2_id' },
    'user_1a_id':     { id: 'user_1a_id', role: 'user', parent_id: 'broker_1a_id' },
    'user_1_direct':  { id: 'user_1_direct', role: 'user', parent_id: 'admin_1_id' },
    'user_2a_id':     { id: 'user_2a_id', role: 'user', parent_id: 'broker_2a_id' },
    'user_indep_id':  { id: 'user_indep_id', role: 'user', parent_id: null },
    'demo_user_1':    { id: 'demo_user_1', role: 'user', parent_id: null, demo_user: true },
  };

  const createMockSupabase = () => {
    return {
      from: vi.fn((table: string) => {
        if (table !== 'profiles') throw new Error(`Unexpected table ${table}`);
        return {
          select: vi.fn((cols: string) => {
            return {
              eq: vi.fn((col: string, val: string) => {
                return {
                  single: vi.fn(async () => {
                    const row = profilesMap[val];
                    if (!row) return { data: null, error: { message: 'Not found' } };
                    return { data: { role: row.role, parent_id: row.parent_id, demo_user: row.demo_user ?? false }, error: null };
                  }),
                };
              }),
              // For getDescendantUserIds: .select('id, parent_id')
              then: (resolve: any) => {
                const all = Object.values(profilesMap).map(p => ({ id: p.id, parent_id: p.parent_id }));
                return resolve({ data: all, error: null });
              },
            };
          }),
        };
      }),
    } as any;
  };

  describe('1. Super Admin Boundary Verification', () => {
    it('Super Admin can see and access every admin, broker, and user', async () => {
      const mockDb = createMockSupabase();

      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'admin_1_id', 'super_admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'admin_2_id', 'super_admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'broker_1a_id', 'super_admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'broker_2a_id', 'super_admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'user_1a_id', 'super_admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'user_2a_id', 'super_admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'user_indep_id', 'super_admin')).toBe(true);

      // getDescendantUserIds returns null (unrestricted across system)
      const descendants = await getDescendantUserIds(mockDb, 'super_admin_id', 'super_admin');
      expect(descendants).toBeNull();
    });
  });

  describe('2. Admin Boundary Verification', () => {
    it('Admin can see their own brokers and users under those brokers', async () => {
      const mockDb = createMockSupabase();

      // Admin 1 can see self
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'admin_1_id', 'admin')).toBe(true);
      // Admin 1 can see direct broker (broker_1a_id)
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'broker_1a_id', 'admin')).toBe(true);
      // Admin 1 can see user under their broker (user_1a_id)
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'user_1a_id', 'admin')).toBe(true);
      // Admin 1 can see direct user (user_1_direct)
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'user_1_direct', 'admin')).toBe(true);
    });

    it('Admin CANNOT see other admins or brokers/users belonging to other admins', async () => {
      const mockDb = createMockSupabase();

      // Admin 1 cannot see Admin 2
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'admin_2_id', 'admin')).toBe(false);
      // Admin 1 cannot see Broker 2A (belongs to Admin 2)
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'broker_2a_id', 'admin')).toBe(false);
      // Admin 1 cannot see User 2A (belongs to Broker 2A under Admin 2)
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'user_2a_id', 'admin')).toBe(false);
      // Admin 1 cannot see Independent user
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'user_indep_id', 'admin')).toBe(false);
    });

    it('Admin getDescendantUserIds only returns descendants within Admin 1 branch', async () => {
      const mockDb = createMockSupabase();
      const descendants = await getDescendantUserIds(mockDb, 'admin_1_id', 'admin');

      expect(descendants).not.toBeNull();
      expect(descendants).toContain('broker_1a_id');
      expect(descendants).toContain('user_1a_id');
      expect(descendants).toContain('user_1_direct');

      // Must NOT contain Admin 2 or any of Admin 2's subordinates
      expect(descendants).not.toContain('admin_2_id');
      expect(descendants).not.toContain('broker_2a_id');
      expect(descendants).not.toContain('user_2a_id');
      expect(descendants).not.toContain('user_indep_id');
    });

    it('assertUserInHierarchy returns 403 when accessing outside branch', async () => {
      const mockDb = createMockSupabase();
      const denied = await assertUserInHierarchy(mockDb, 'admin_1_id', 'user_2a_id', 'admin');
      expect(denied).not.toBeNull();
      expect(denied?.status).toBe(403);

      const allowed = await assertUserInHierarchy(mockDb, 'admin_1_id', 'user_1a_id', 'admin');
      expect(allowed).toBeNull();
    });
  });

  describe('3. Broker Boundary Verification', () => {
    it('Broker can see users whose parent is the broker', async () => {
      const mockDb = createMockSupabase();

      // Broker 1A can see self
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'broker_1a_id', 'broker')).toBe(true);
      // Broker 1A can see User 1A
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'user_1a_id', 'broker')).toBe(true);
    });

    it('Broker CANNOT see admins, other brokers, or users of other brokers', async () => {
      const mockDb = createMockSupabase();

      // Broker 1A cannot see their parent Admin 1
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'admin_1_id', 'broker')).toBe(false);
      // Broker 1A cannot see Super Admin
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'super_admin_id', 'broker')).toBe(false);
      // Broker 1A cannot see other Broker 2A
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'broker_2a_id', 'broker')).toBe(false);
      // Broker 1A cannot see User 2A
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'user_2a_id', 'broker')).toBe(false);
      // Broker 1A cannot see Direct user under Admin
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'user_1_direct', 'broker')).toBe(false);
    });

    it('Broker getDescendantUserIds returns strictly broker users', async () => {
      const mockDb = createMockSupabase();
      const descendants = await getDescendantUserIds(mockDb, 'broker_1a_id', 'broker');

      expect(descendants).toEqual(['user_1a_id']);
    });
  });

  describe('4. User Boundary Verification', () => {
    it('User can see their own data only', async () => {
      const mockDb = createMockSupabase();

      // User 1A can see self
      expect(await isUserInHierarchy(mockDb, 'user_1a_id', 'user_1a_id', 'user')).toBe(true);
      // User 1A CANNOT see Broker 1A
      expect(await isUserInHierarchy(mockDb, 'user_1a_id', 'broker_1a_id', 'user')).toBe(false);
      // User 1A CANNOT see Admin 1
      expect(await isUserInHierarchy(mockDb, 'user_1a_id', 'admin_1_id', 'user')).toBe(false);
      // User 1A CANNOT see other users
      expect(await isUserInHierarchy(mockDb, 'user_1a_id', 'user_2a_id', 'user')).toBe(false);
      expect(await isUserInHierarchy(mockDb, 'user_1a_id', 'user_indep_id', 'user')).toBe(false);

      // getDescendantUserIds returns empty array
      const descendants = await getDescendantUserIds(mockDb, 'user_1a_id', 'user');
      expect(descendants).toEqual([]);
    });

    it('User cannot access management permissions', () => {
      expect(hasPermission('user', 'VIEW_USERS')).toBe(false);
      expect(hasPermission('user', 'CREATE_USER')).toBe(false);
      expect(hasPermission('user', 'VIEW_ALL_ACCOUNTS')).toBe(false);
      expect(hasPermission('user', 'MANAGE_TEMPLATES')).toBe(false);

      // User CAN access own data permissions
      expect(hasPermission('user', 'VIEW_OWN_POSITIONS')).toBe(true);
      expect(hasPermission('user', 'VIEW_OWN_ORDERS')).toBe(true);
      expect(hasPermission('user', 'VIEW_OWN_LEDGER')).toBe(true);
      expect(hasPermission('user', 'VIEW_OWN_PROFILE')).toBe(true);
    });
  });

  describe('5. Cross-Feature Action Isolation Verification', () => {
    it('Payin/Payout: user, broker, admin, and super admin access scoping', async () => {
      const mockDb = createMockSupabase();

      // User scope: strictly self
      const userDescendants = await getDescendantUserIds(mockDb, 'user_1a_id', 'user');
      expect(userDescendants).toEqual([]);

      // Broker scope: strictly broker's child users
      const brokerDescendants = await getDescendantUserIds(mockDb, 'broker_1a_id', 'broker');
      expect(brokerDescendants).toEqual(['user_1a_id']);

      // Admin scope: all users/brokers under that admin only
      const adminDescendants = await getDescendantUserIds(mockDb, 'admin_1_id', 'admin');
      expect(adminDescendants).toContain('user_1a_id');
      expect(adminDescendants).toContain('user_1_direct');
      expect(adminDescendants).not.toContain('user_2a_id');

      // Super Admin scope: global (null)
      const superDescendants = await getDescendantUserIds(mockDb, 'super_admin_id', 'super_admin');
      expect(superDescendants).toBeNull();
    });

    it('Bank & Payment Accounts: user bank accounts and deposit payment accounts isolation', async () => {
      const mockDb = createMockSupabase();

      // User attempting to access or modify bank account of another user is denied
      const deniedUserAccess = await assertUserInHierarchy(mockDb, 'user_1a_id', 'user_2a_id', 'user');
      expect(deniedUserAccess).not.toBeNull();
      expect(deniedUserAccess?.status).toBe(403);

      // Broker attempting to manage an account of another broker's user is denied
      const deniedBrokerCrossAccess = await assertUserInHierarchy(mockDb, 'broker_1a_id', 'user_2a_id', 'broker');
      expect(deniedBrokerCrossAccess).not.toBeNull();
      expect(deniedBrokerCrossAccess?.status).toBe(403);

      // Admin attempting to manage an account of another admin's user is denied
      const deniedAdminCrossAccess = await assertUserInHierarchy(mockDb, 'admin_1_id', 'user_2a_id', 'admin');
      expect(deniedAdminCrossAccess).not.toBeNull();
      expect(deniedAdminCrossAccess?.status).toBe(403);
    });

    it('Orders & Positions: orders and positions actions are strictly isolated by branch', async () => {
      const mockDb = createMockSupabase();

      // Single position / order square-off, cancel, reopen assertion:
      // Allowed within branch:
      expect(await assertUserInHierarchy(mockDb, 'admin_1_id', 'user_1a_id', 'admin')).toBeNull();
      expect(await assertUserInHierarchy(mockDb, 'broker_1a_id', 'user_1a_id', 'broker')).toBeNull();
      expect(await assertUserInHierarchy(mockDb, 'super_admin_id', 'user_2a_id', 'super_admin')).toBeNull();

      // Forbidden across branches:
      expect((await assertUserInHierarchy(mockDb, 'admin_1_id', 'user_2a_id', 'admin'))?.status).toBe(403);
      expect((await assertUserInHierarchy(mockDb, 'broker_1a_id', 'user_2a_id', 'broker'))?.status).toBe(403);
      expect((await assertUserInHierarchy(mockDb, 'broker_2a_id', 'user_1a_id', 'broker'))?.status).toBe(403);
      expect(await assertUserInHierarchy(mockDb, 'user_1a_id', 'user_1a_id', 'user')).toBeNull();
      expect((await assertUserInHierarchy(mockDb, 'user_1a_id', 'user_2a_id', 'user'))?.status).toBe(403);
    });

    it('Demo Accounts: belong to everyone, accessible by all admins and brokers regardless of parent hierarchy', async () => {
      const mockDb = createMockSupabase();

      // All admins and brokers can access the demo account
      expect(await isUserInHierarchy(mockDb, 'admin_1_id', 'demo_user_1', 'admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'admin_2_id', 'demo_user_1', 'admin')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'broker_1a_id', 'demo_user_1', 'broker')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'broker_2a_id', 'demo_user_1', 'broker')).toBe(true);
      expect(await isUserInHierarchy(mockDb, 'super_admin_id', 'demo_user_1', 'super_admin')).toBe(true);

      // Permission guards allow access without 403
      expect(await assertUserInHierarchy(mockDb, 'admin_1_id', 'demo_user_1', 'admin')).toBeNull();
      expect(await assertUserInHierarchy(mockDb, 'broker_2a_id', 'demo_user_1', 'broker')).toBeNull();

      // Regular live user still cannot access other demo account
      expect(await isUserInHierarchy(mockDb, 'user_1a_id', 'demo_user_1', 'user')).toBe(false);
      expect((await assertUserInHierarchy(mockDb, 'user_1a_id', 'demo_user_1', 'user'))?.status).toBe(403);
    });
  });
});
