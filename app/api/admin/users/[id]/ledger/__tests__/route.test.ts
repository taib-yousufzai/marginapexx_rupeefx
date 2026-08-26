/**
 * Unit tests for POST /api/admin/users/[id]/ledger
 *
 * Feature: ledger-transaction-classification
 * Validates: Requirements 2.2, 3.1, 6.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js createClient
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockInsert = vi.fn();
const mockSelectSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
    from: vi.fn((table: string) => ({
      insert: mockInsert,
      select: mockSelect,
    })),
  })),
}));

// ---------------------------------------------------------------------------
// Import handler AFTER mocks are set up
// ---------------------------------------------------------------------------

import { POST } from '../route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  userId: string,
  body: Record<string, unknown>,
  authHeader = 'Bearer valid-token',
): Request {
  return new Request(`http://localhost/api/admin/users/${userId}/ledger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(body),
  });
}

function makeUser(role: string) {
  return { id: 'admin-uuid', user_metadata: { role } };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  // Default: valid super_admin caller
  mockGetUser.mockResolvedValue({
    data: { user: makeUser('super_admin') },
    error: null,
  });

  // Default: profile fetch succeeds
  mockSelectSingle.mockResolvedValue({
    data: {
      client_id: 'CL001',
      email: 'user@example.com',
      full_name: 'Test User',
      demo_user: false,
      balance: 1000,
      parent_id: null,
    },
    error: null,
  });

  mockEq.mockReturnValue({ single: mockSelectSingle });

  mockSelect.mockReturnValue({ eq: mockEq });

  // Default: all inserts succeed
  const mockInsertResult = {
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: 'test-pay-req-id' }, error: null }),
    then: function(resolve: any) { resolve({ data: {}, error: null }); }
  };
  mockInsert.mockReturnValue(mockInsertResult);
});

// ===========================================================================
// 400 — Validation errors
// Validates: Requirements 2.2, 6.1
// ===========================================================================

describe('POST /api/admin/users/[id]/ledger — 400 Validation errors', () => {
  it('returns 400 when amount is 0', async () => {
    const req = makeRequest('user-uuid', {
      amount: 0,
      type: 'Credit',
      entry_type: 'DEPOSIT',
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid amount' });
  });

  it('returns 400 when amount is negative', async () => {
    const req = makeRequest('user-uuid', {
      amount: -50,
      type: 'Credit',
      entry_type: 'DEPOSIT',
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid amount' });
  });

  it('returns 400 when amount is missing', async () => {
    const req = makeRequest('user-uuid', {
      type: 'Credit',
      entry_type: 'DEPOSIT',
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid amount' });
  });

  it('returns 400 when entry_type is invalid', async () => {
    const req = makeRequest('user-uuid', {
      amount: 100,
      type: 'Credit',
      entry_type: 'INVALID_TYPE',
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid entry_type' });
  });

  it('returns 400 when entry_type is missing', async () => {
    const req = makeRequest('user-uuid', {
      amount: 100,
      type: 'Credit',
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid entry_type' });
  });
});

// ===========================================================================
// 200 — Remarks is optional
// Validates: Requirement 3.1
// ===========================================================================

describe('POST /api/admin/users/[id]/ledger — Remarks is optional', () => {
  it('returns 200 when remarks (description) is absent', async () => {
    const req = makeRequest('user-uuid', {
      amount: 100,
      type: 'Credit',
      entry_type: 'DEPOSIT',
      // no description field
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 200 when remarks (description) is empty string', async () => {
    const req = makeRequest('user-uuid', {
      amount: 100,
      type: 'Credit',
      entry_type: 'DEPOSIT',
      description: '',
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 200 when remarks is provided', async () => {
    const req = makeRequest('user-uuid', {
      amount: 100,
      type: 'Credit',
      entry_type: 'DEPOSIT',
      description: 'Some remark',
    });
    const res = await POST(req, { params: { id: 'user-uuid' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ===========================================================================
// 200 — All valid entry_types are accepted
// Validates: Requirement 2.2
// ===========================================================================

describe('POST /api/admin/users/[id]/ledger — All valid entry_types accepted', () => {
  const validTypes = ['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT', 'CORRECTION', 'REFUND'] as const;

  for (const entry_type of validTypes) {
    it(`returns 200 for entry_type = ${entry_type}`, async () => {
      const req = makeRequest('user-uuid', {
        amount: 100,
        type: 'Credit',
        entry_type,
      });
      const res = await POST(req, { params: { id: 'user-uuid' } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  }
});
