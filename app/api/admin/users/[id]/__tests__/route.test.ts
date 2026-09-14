/**
 * Example-based tests for Admin User Management API routes.
 *
 * Tests POST /api/admin/users (route.ts in parent dir)
 * Tests PATCH /api/admin/users/[id] and DELETE /api/admin/users/[id] (route.ts in [id] dir)
 *
 * Written TDD-first: these tests will fail with "Cannot find module" until
 * the handlers are implemented in tasks 5 and 6.
 *
 * Validates: Requirements 2.1–2.6, 3.2–3.9, 4.2–4.10, 5.2–5.8
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js createClient
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockCreateUser = vi.fn();
const mockDeleteUser = vi.fn();
const mockUpdateUserById = vi.fn();
const mockInsert = vi.fn();
const mockSingle = vi.fn();
const mockSelectSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: {
        createUser: mockCreateUser,
        deleteUser: mockDeleteUser,
        updateUserById: mockUpdateUserById,
      },
    },
    from: vi.fn(() => ({
      insert: mockInsert,
      upsert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
      eq: mockEq,
      single: mockSingle,
    })),
  })),
}));

vi.mock('@/lib/hierarchy', () => ({
  isUserInHierarchy: vi.fn().mockResolvedValue(true),
  getDescendantUserIds: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks are set up
// ---------------------------------------------------------------------------

import { POST } from '../../route';
import { PATCH, DELETE } from '../route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Request for POST /api/admin/users.
 */
function makePostRequest(
  body: Record<string, unknown> | string | null,
  authHeader?: string,
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader !== undefined) {
    headers['Authorization'] = authHeader;
  }
  const bodyStr =
    body === null
      ? undefined
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  return new Request('http://localhost/api/admin/users', {
    method: 'POST',
    headers,
    body: bodyStr,
  });
}

/**
 * Builds a minimal Request for PATCH /api/admin/users/[id].
 */
function makePatchRequest(
  id: string,
  body: Record<string, unknown> | string,
  authHeader?: string,
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader !== undefined) {
    headers['Authorization'] = authHeader;
  }
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`http://localhost/api/admin/users/${id}`, {
    method: 'PATCH',
    headers,
    body: bodyStr,
  });
}

/**
 * Builds a minimal Request for DELETE /api/admin/users/[id].
 */
function makeDeleteRequest(id: string, authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers['Authorization'] = authHeader;
  }
  return new Request(`http://localhost/api/admin/users/${id}`, {
    method: 'DELETE',
    headers,
  });
}

/**
 * Builds a mock Supabase User with the given role.
 */
function makeUser(role: string) {
  return { id: 'caller-uuid', user_metadata: { role } };
}

/**
 * Sets up the from().update().eq().select().single() chain mock.
 */
function setupUpdateChain(result: { data: unknown; error: unknown }) {
  mockSingle.mockResolvedValue(result);
  mockSelectSingle.mockReturnValue({ single: mockSingle });
  mockEq.mockReturnValue({ select: mockSelectSingle });
  mockUpdate.mockReturnValue({ eq: mockEq });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: getUser returns a valid admin user
  mockGetUser.mockResolvedValue({
    data: { user: makeUser('admin') },
    error: null,
  });

  // Default: createUser succeeds
  mockCreateUser.mockResolvedValue({
    data: { user: { id: 'new-user-uuid', email: 'test@example.com' } },
    error: null,
  });

  // Default: deleteUser succeeds (used in rollback)
  mockDeleteUser.mockResolvedValue({ data: {}, error: null });

  // Default: updateUserById succeeds
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });

  // Default: insert succeeds
  mockInsert.mockResolvedValue({ data: { id: 'new-user-uuid' }, error: null });

  // Default: select chain returns data: null, error: null (unique client_id by default)
  mockSelect.mockReturnValue({
    eq: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: null, error: null })
    })
  });

  // Default: update chain succeeds with a profile row
  setupUpdateChain({
    data: { id: 'target-uuid', email: 'user@example.com', scheduled_delete_at: '2099-01-01T00:00:00.000Z' },
    error: null,
  });

  // Set env vars
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
});

// ===========================================================================
// POST /api/admin/users
// ===========================================================================

describe('POST /api/admin/users', () => {

  // -------------------------------------------------------------------------
  // 201 — Success
  // Validates: Requirements 3.2, 3.3, 3.6
  // -------------------------------------------------------------------------

  describe('201 — Success', () => {
    it('returns 201 with { id, email } on success', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: makeUser('admin') },
        error: null,
      });
      mockCreateUser.mockResolvedValue({
        data: { user: { id: 'new-user-uuid', email: 'newuser@example.com' } },
        error: null,
      });
      mockInsert.mockResolvedValue({ data: { id: 'new-user-uuid' }, error: null });

      const req = makePostRequest(
        { email: 'newuser@example.com', password: 'securepass', role: 'user' },
        'Bearer valid-token',
      );
      const res = await POST(req);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({ id: 'new-user-uuid', email: 'newuser@example.com', client_id: expect.any(String) });
    });

    it('returns 201 and inserts default segment settings when active segments are specified', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: makeUser('admin') },
        error: null,
      });
      mockCreateUser.mockResolvedValue({
        data: { user: { id: 'new-user-uuid', email: 'newuser@example.com' } },
        error: null,
      });
      mockInsert.mockResolvedValue({ data: [], error: null });

      const req = makePostRequest(
        { email: 'newuser@example.com', password: 'securepass', role: 'user', segments: ['NSE-EQ', 'CRYPTO'] },
        'Bearer valid-token',
      );
      const res = await POST(req);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({ id: 'new-user-uuid', email: 'newuser@example.com', client_id: expect.any(String) });
      expect(mockInsert).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 400 — Validation errors
  // Validates: Requirements 3.8, 3.9, 6.4
  // -------------------------------------------------------------------------

  describe('400 — Validation errors', () => {
    it('returns 400 when email is missing', async () => {
      const req = makePostRequest(
        { password: 'securepass', role: 'user' },
        'Bearer valid-token',
      );
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: 'Missing required fields' });
    });

    it('returns 400 when password is missing', async () => {
      const req = makePostRequest(
        { email: 'test@example.com', role: 'user' },
        'Bearer valid-token',
      );
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: 'Missing required fields' });
    });

    it('returns 400 when password is shorter than 8 characters', async () => {
      const req = makePostRequest(
        { email: 'test@example.com', password: 'short', role: 'user' },
        'Bearer valid-token',
      );
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: 'Password must be at least 8 characters' });
    });

    it('returns 400 when body is not valid JSON', async () => {
      const req = makePostRequest('not-valid-json', 'Bearer valid-token');
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty('error');
    });
  });

  // -------------------------------------------------------------------------
  // 401 — Unauthorized
  // Validates: Requirements 2.1, 2.2, 2.3, 2.4
  // -------------------------------------------------------------------------

  describe('401 — Unauthorized', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const req = makePostRequest({ email: 'test@example.com', password: 'securepass' });
      const res = await POST(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 when token is invalid (getUser returns error)', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid JWT' },
      });
      const req = makePostRequest(
        { email: 'test@example.com', password: 'securepass' },
        'Bearer invalid-token',
      );
      const res = await POST(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 when getUser returns null user', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
      const req = makePostRequest(
        { email: 'test@example.com', password: 'securepass' },
        'Bearer expired-token',
      );
      const res = await POST(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });
  });

  // -------------------------------------------------------------------------
  // 403 — Forbidden
  // Validates: Requirements 2.5, 2.6
  // -------------------------------------------------------------------------

  describe('403 — Forbidden', () => {
    it('returns 403 when caller role is user (no CREATE_USER permission)', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: makeUser('user') },
        error: null,
      });
      const req = makePostRequest(
        { email: 'test@example.com', password: 'securepass', role: 'user' },
        'Bearer user-token',
      );
      const res = await POST(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/Forbidden/);
    });
  });

  // -------------------------------------------------------------------------
  // 422 — createUser error
  // Validates: Requirement 3.4
  // -------------------------------------------------------------------------

  describe('422 — createUser error', () => {
    it('returns 422 when createUser returns an error', async () => {
      mockCreateUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'User already registered' },
      });
      const req = makePostRequest(
        { email: 'existing@example.com', password: 'securepass', role: 'user' },
        'Bearer admin-token',
      );
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // 500 — Profile insert fails (rollback)
  // Validates: Requirement 3.5
  // -------------------------------------------------------------------------

  describe('500 — Profile insert fails with rollback', () => {
    it('returns 500 and calls deleteUser rollback when profile insert fails', async () => {
      mockCreateUser.mockResolvedValue({
        data: { user: { id: 'new-user-uuid', email: 'test@example.com' } },
        error: null,
      });
      mockInsert.mockResolvedValue({
        data: null,
        error: { message: 'insert failed' },
      });

      const req = makePostRequest(
        { email: 'test@example.com', password: 'securepass', role: 'user' },
        'Bearer admin-token',
      );
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({
        error: 'Database error: insert failed',
      });
      // Rollback: deleteUser must have been called with the new user's id
      expect(mockDeleteUser).toHaveBeenCalledWith('new-user-uuid');
    });
  });
});

// ===========================================================================
// PATCH /api/admin/users/[id]
// ===========================================================================

describe('PATCH /api/admin/users/[id]', () => {
  const TARGET_ID = 'target-user-uuid';

  // -------------------------------------------------------------------------
  // 200 — Success
  // Validates: Requirements 4.2, 4.7
  // -------------------------------------------------------------------------

  describe('200 — Success', () => {
    it('returns 200 { success: true } on success', async () => {
      setupUpdateChain({
        data: { id: TARGET_ID, email: 'user@example.com' },
        error: null,
      });

      const req = makePatchRequest(
        TARGET_ID,
        { full_name: 'Updated Name' },
        'Bearer admin-token',
      );
      const res = await PATCH(req, { params: { id: TARGET_ID } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true });
    });
  });

  // -------------------------------------------------------------------------
  // 400 — Short password
  // Validates: Requirement 4.10
  // -------------------------------------------------------------------------

  describe('400 — Short password', () => {
    it('returns 400 when password is present and shorter than 8 characters', async () => {
      const req = makePatchRequest(
        TARGET_ID,
        { password: 'short' },
        'Bearer admin-token',
      );
      const res = await PATCH(req, { params: { id: TARGET_ID } });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: 'Password must be at least 8 characters' });
    });
  });

  // -------------------------------------------------------------------------
  // 404 — Profile not found
  // Validates: Requirement 4.6
  // -------------------------------------------------------------------------

  describe('404 — Profile not found', () => {
    it('returns 404 when profile row not found (update returns no rows)', async () => {
      setupUpdateChain({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

      const req = makePatchRequest(
        TARGET_ID,
        { full_name: 'Ghost User' },
        'Bearer admin-token',
      );
      const res = await PATCH(req, { params: { id: TARGET_ID } });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: 'User not found' });
    });
  });

  // -------------------------------------------------------------------------
  // updateUserById with user_metadata when role or active is in body
  // Validates: Requirement 4.3
  // -------------------------------------------------------------------------

  describe('updateUserById — user_metadata sync', () => {
    it('calls updateUserById with user_metadata when role is in body', async () => {
      setupUpdateChain({
        data: { id: TARGET_ID, email: 'user@example.com' },
        error: null,
      });

      const req = makePatchRequest(
        TARGET_ID,
        { role: 'broker' },
        'Bearer admin-token',
      );
      await PATCH(req, { params: { id: TARGET_ID } });

      expect(mockUpdateUserById).toHaveBeenCalledWith(
        TARGET_ID,
        expect.objectContaining({ user_metadata: expect.objectContaining({ role: 'broker' }) }),
      );
    });

    it('calls updateUserById with user_metadata when active is in body', async () => {
      setupUpdateChain({
        data: { id: TARGET_ID, email: 'user@example.com' },
        error: null,
      });

      const req = makePatchRequest(
        TARGET_ID,
        { active: false },
        'Bearer admin-token',
      );
      await PATCH(req, { params: { id: TARGET_ID } });

      expect(mockUpdateUserById).toHaveBeenCalledWith(
        TARGET_ID,
        expect.objectContaining({ user_metadata: expect.objectContaining({ active: false }) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // updateUserById NOT called with password when absent or empty
  // Validates: Requirement 4.5
  // -------------------------------------------------------------------------

  describe('updateUserById — password NOT updated when absent or empty', () => {
    it('does NOT call updateUserById with password when password is absent', async () => {
      setupUpdateChain({
        data: { id: TARGET_ID, email: 'user@example.com' },
        error: null,
      });

      const req = makePatchRequest(
        TARGET_ID,
        { full_name: 'No Password Change' },
        'Bearer admin-token',
      );
      await PATCH(req, { params: { id: TARGET_ID } });

      // updateUserById should not have been called with a password key
      const calls = mockUpdateUserById.mock.calls;
      for (const call of calls) {
        const updateArg = call[1] as Record<string, unknown>;
        expect(updateArg).not.toHaveProperty('password');
      }
    });

    it('does NOT call updateUserById with password when password is empty string', async () => {
      setupUpdateChain({
        data: { id: TARGET_ID, email: 'user@example.com' },
        error: null,
      });

      const req = makePatchRequest(
        TARGET_ID,
        { password: '' },
        'Bearer admin-token',
      );
      await PATCH(req, { params: { id: TARGET_ID } });

      const calls = mockUpdateUserById.mock.calls;
      for (const call of calls) {
        const updateArg = call[1] as Record<string, unknown>;
        expect(updateArg).not.toHaveProperty('password');
      }
    });
  });

  // -------------------------------------------------------------------------
  // updateUserById called with password when present and non-empty
  // Validates: Requirement 4.4
  // -------------------------------------------------------------------------

  describe('updateUserById — password updated when present and non-empty', () => {
    it('calls updateUserById with password when password is present and non-empty', async () => {
      setupUpdateChain({
        data: { id: TARGET_ID, email: 'user@example.com' },
        error: null,
      });

      const req = makePatchRequest(
        TARGET_ID,
        { password: 'newpassword123' },
        'Bearer admin-token',
      );
      await PATCH(req, { params: { id: TARGET_ID } });

      expect(mockUpdateUserById).toHaveBeenCalledWith(TARGET_ID, { password: 'newpassword123' });
    });
  });
});

// ===========================================================================
// DELETE /api/admin/users/[id]
// ===========================================================================

describe('DELETE /api/admin/users/[id]', () => {
  const TARGET_ID = 'target-user-uuid';
  const SCHEDULED_DELETE_AT = '2099-01-02T00:00:00.000Z';

  beforeEach(async () => {
    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      if (redis && typeof (redis as any).flushall === 'function') {
        await (redis as any).flushall();
      }
    } catch {
      // Ignore if redis clear fails
    }

    mockGetUser.mockResolvedValue({
      data: { user: makeUser('super_admin') },
      error: null,
    });
  });

  // -------------------------------------------------------------------------
  // 200 — Success (soft delete)
  // Validates: Requirements 5.3, 5.4
  // -------------------------------------------------------------------------

  describe('200 — Success', () => {
    it('returns 200 { success: true, scheduled_delete_at } on success', async () => {
      setupUpdateChain({
        data: { scheduled_delete_at: SCHEDULED_DELETE_AT },
        error: null,
      });

      const req = makeDeleteRequest(TARGET_ID, 'Bearer super-admin-token');
      const res = await DELETE(req, { params: { id: TARGET_ID } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        scheduled_delete_at: SCHEDULED_DELETE_AT,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 404 — Profile not found
  // Validates: Requirement 5.6
  // -------------------------------------------------------------------------

  describe('404 — Profile not found', () => {
    it('returns 404 when profile row not found', async () => {
      setupUpdateChain({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

      const req = makeDeleteRequest(TARGET_ID, 'Bearer super-admin-token');
      const res = await DELETE(req, { params: { id: TARGET_ID } });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: 'User not found' });
    });
  });

  // -------------------------------------------------------------------------
  // Soft-delete only — auth.admin.deleteUser must NOT be called
  // Validates: Requirements 5.8
  // -------------------------------------------------------------------------

  describe('Soft-delete only', () => {
    it('does NOT call auth.admin.deleteUser (soft-delete only)', async () => {
      setupUpdateChain({
        data: { scheduled_delete_at: SCHEDULED_DELETE_AT },
        error: null,
      });

      const req = makeDeleteRequest(TARGET_ID, 'Bearer admin-token');
      await DELETE(req, { params: { id: TARGET_ID } });

      expect(mockDeleteUser).not.toHaveBeenCalled();
    });
  });
});
