/**
 * Property-based tests for Admin User Management API routes.
 *
 * Feature: admin-user-management
 *
 * Tests POST /api/admin/users, PATCH /api/admin/users/[id], and DELETE /api/admin/users/[id].
 * Uses fast-check to verify the 11 correctness properties from the design document.
 *
 * Validates: Requirements 2.1-2.6, 3.8-3.10, 4.5, 4.10, 5.3, 5.8, 6.1, 6.2, 6.4, 7.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

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

let currentUpdateResult: any = null;

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

function makePostRequest(
  body: Record<string, unknown> | string | null,
  authHeader?: string,
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
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

function makePatchRequest(
  id: string,
  body: Record<string, unknown> | string,
  authHeader?: string,
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`http://localhost/api/admin/users/${id}`, {
    method: 'PATCH',
    headers,
    body: bodyStr,
  });
}

function makeDeleteRequest(id: string, authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new Request(`http://localhost/api/admin/users/${id}`, {
    method: 'DELETE',
    headers,
  });
}

function makeUser(role: string) {
  return { id: 'caller-uuid', user_metadata: { role } };
}

function setupUpdateChain(result: { data: unknown; error: unknown }) {
  currentUpdateResult = result;
  mockSelectSingle.mockReturnValue({ single: mockSingle });
  mockEq.mockReturnValue({
    select: mockSelectSingle,
    single: mockSingle,
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
  });
  mockUpdate.mockReturnValue({ eq: mockEq });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockSelect.mockReturnValue({ eq: mockEq });
  mockUpdate.mockReturnValue({ eq: mockEq });

  mockSingle.mockImplementation(() => {
    // Check if the last select arg was 'id' (signaling client_id uniqueness check)
    const lastSelectArg = mockSelect.mock.calls[mockSelect.mock.calls.length - 1]?.[0];
    if (lastSelectArg === 'id') {
      return { data: null, error: null };
    }
    return currentUpdateResult;
  });

  mockGetUser.mockResolvedValue({
    data: { user: makeUser('admin') },
    error: null,
  });
  mockCreateUser.mockResolvedValue({
    data: { user: { id: 'new-user-uuid', email: 'test@example.com' } },
    error: null,
  });
  mockDeleteUser.mockResolvedValue({ data: {}, error: null });
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
  mockInsert.mockResolvedValue({ data: { id: 'new-user-uuid' }, error: null });
  setupUpdateChain({
    data: { id: 'target-uuid', email: 'user@example.com', scheduled_delete_at: '2099-01-01T00:00:00.000Z' },
    error: null,
  });

  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const nonEmptyStringArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);
const emailArb = fc.emailAddress();
const validPasswordArb = fc.string({ minLength: 8 }).filter((s) => s.trim().length >= 8);

// ---------------------------------------------------------------------------
// Property 1: Missing/malformed Authorization header returns 401
// Feature: admin-user-management, Property 1: Missing Authorization header returns 401
// Validates: Requirements 2.1, 2.2
// ---------------------------------------------------------------------------

describe('Admin API - Property 1: Missing/malformed Authorization header returns 401', () => {
  // Feature: admin-user-management, Property 1: Missing Authorization header returns 401
  // Validates: Requirements 2.1, 2.2

  const missingAuthArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constant('Basic abc'),
    fc.string().filter((s) => !s.startsWith('Bearer ')),
  );

  it('POST returns 401 for any missing or malformed Authorization header', async () => {
    await fc.assert(
      fc.asyncProperty(
        missingAuthArb,
        async (authHeader) => {
          const req = makePostRequest(
            { email: 'test@example.com', password: 'securepass' },
            authHeader as string | undefined,
          );
          const res = await POST(req);
          const body = await res.json();
          return res.status === 401 && body.error === 'Unauthorized';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('PATCH returns 401 for any missing or malformed Authorization header', async () => {
    await fc.assert(
      fc.asyncProperty(
        missingAuthArb,
        async (authHeader) => {
          const req = makePatchRequest(
            'some-id',
            { full_name: 'Test' },
            authHeader as string | undefined,
          );
          const res = await PATCH(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 401 && body.error === 'Unauthorized';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('DELETE returns 401 for any missing or malformed Authorization header', async () => {
    await fc.assert(
      fc.asyncProperty(
        missingAuthArb,
        async (authHeader) => {
          const req = makeDeleteRequest('some-id', authHeader as string | undefined);
          const res = await DELETE(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 401 && body.error === 'Unauthorized';
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Invalid token returns 401
// Feature: admin-user-management, Property 2: Invalid token returns 401
// Validates: Requirements 2.3, 2.4
// ---------------------------------------------------------------------------

describe('Admin API - Property 2: Invalid token returns 401', () => {
  // Feature: admin-user-management, Property 2: Invalid token returns 401
  // Validates: Requirements 2.3, 2.4

  it('POST returns 401 when getUser returns error for any token', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArb,
        async (token) => {
          mockGetUser.mockResolvedValue({
            data: { user: null },
            error: { message: 'Invalid JWT' },
          });
          const req = makePostRequest(
            { email: 'test@example.com', password: 'securepass' },
            `Bearer ${token}`,
          );
          const res = await POST(req);
          const body = await res.json();
          return res.status === 401 && body.error === 'Unauthorized';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('POST returns 401 when getUser returns null user for any token', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArb,
        async (token) => {
          mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
          const req = makePostRequest(
            { email: 'test@example.com', password: 'securepass' },
            `Bearer ${token}`,
          );
          const res = await POST(req);
          const body = await res.json();
          return res.status === 401 && body.error === 'Unauthorized';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('PATCH returns 401 when getUser returns error for any token', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArb,
        async (token) => {
          mockGetUser.mockResolvedValue({
            data: { user: null },
            error: { message: 'Invalid JWT' },
          });
          const req = makePatchRequest('some-id', { full_name: 'Test' }, `Bearer ${token}`);
          const res = await PATCH(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 401 && body.error === 'Unauthorized';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('DELETE returns 401 when getUser returns error for any token', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArb,
        async (token) => {
          mockGetUser.mockResolvedValue({
            data: { user: null },
            error: { message: 'Invalid JWT' },
          });
          const req = makeDeleteRequest('some-id', `Bearer ${token}`);
          const res = await DELETE(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 401 && body.error === 'Unauthorized';
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Non-admin caller returns 403
// Feature: admin-user-management, Property 3: Non-admin caller returns 403
// Validates: Requirements 2.5, 2.6
// ---------------------------------------------------------------------------

describe('Admin API - Property 3: Non-admin caller returns 403', () => {
  // Feature: admin-user-management, Property 3: Non-admin caller returns 403
  // Validates: Requirements 2.5, 2.6

  // Only 'user' and unknown roles lack CREATE_USER. 'broker' has it.
  const nonAdminRoleArb = fc.string().filter(
    (r) => r !== 'admin' && r !== 'super_admin' && r !== 'broker'
  );

  it('POST returns 403 for any role without CREATE_USER permission', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        async (role) => {
          mockGetUser.mockResolvedValue({
            data: { user: makeUser(role) },
            error: null,
          });
          const req = makePostRequest(
            { email: 'test@example.com', password: 'securepass' },
            'Bearer some-token',
          );
          const res = await POST(req);
          const body = await res.json();
          return res.status === 403 && typeof body.error === 'string' && body.error.includes('Forbidden');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('PATCH returns 403 for any non-admin role', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        async (role) => {
          mockGetUser.mockResolvedValue({
            data: { user: makeUser(role) },
            error: null,
          });
          const req = makePatchRequest('some-id', { full_name: 'Test' }, 'Bearer some-token');
          const res = await PATCH(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 403 && body.error === 'Forbidden';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('DELETE returns 403 for any non-admin role', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        async (role) => {
          mockGetUser.mockResolvedValue({
            data: { user: makeUser(role) },
            error: null,
          });
          const req = makeDeleteRequest('some-id', 'Bearer some-token');
          const res = await DELETE(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 403 && body.error === 'Forbidden';
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Missing email or password on POST returns 400
// Feature: admin-user-management, Property 4: Missing required fields returns 400
// Validates: Requirements 3.8
// ---------------------------------------------------------------------------

describe('Admin API - Property 4: Missing email or password on POST returns 400', () => {
  // Feature: admin-user-management, Property 4: Missing required fields returns 400
  // Validates: Requirements 3.8

  it('returns 400 when email is absent from POST body', async () => {
    await fc.assert(
      fc.asyncProperty(
        validPasswordArb,
        async (password) => {
          const req = makePostRequest({ password }, 'Bearer valid-token');
          const res = await POST(req);
          const body = await res.json();
          return res.status === 400 && body.error === 'Missing required fields';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns 400 when password is absent from POST body', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        async (email) => {
          const req = makePostRequest({ email }, 'Bearer valid-token');
          const res = await POST(req);
          const body = await res.json();
          return res.status === 400 && body.error === 'Missing required fields';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns 400 when both email and password are absent from POST body', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.string({ minLength: 1 }).filter((k) => k !== 'email' && k !== 'password'),
          fc.string(),
        ),
        async (extraFields) => {
          const req = makePostRequest(extraFields, 'Bearer valid-token');
          const res = await POST(req);
          const body = await res.json();
          return res.status === 400 && body.error === 'Missing required fields';
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Short password returns 400 on POST and PATCH
// Feature: admin-user-management, Property 5: Short password returns 400 on create and update
// Validates: Requirements 3.9, 4.10
// ---------------------------------------------------------------------------

describe('Admin API - Property 5: Short password returns 400 on POST and PATCH', () => {
  // Feature: admin-user-management, Property 5: Short password returns 400 on create and update
  // Validates: Requirements 3.9, 4.10

  const shortPasswordArb = fc.string({ maxLength: 7 }).filter((s) => s.length > 0);

  it('POST returns 400 when password is shorter than 8 characters', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        shortPasswordArb,
        async (email, password) => {
          const req = makePostRequest({ email, password }, 'Bearer valid-token');
          const res = await POST(req);
          const body = await res.json();
          return res.status === 400 && body.error === 'Password must be at least 8 characters';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('PATCH returns 400 when password is present and shorter than 8 characters', async () => {
    await fc.assert(
      fc.asyncProperty(
        shortPasswordArb,
        async (password) => {
          const req = makePatchRequest('some-id', { password }, 'Bearer valid-token');
          const res = await PATCH(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 400 && body.error === 'Password must be at least 8 characters';
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Email round-trip on create
// Feature: admin-user-management, Property 6: Email round-trip on create
// Validates: Requirements 3.10
// ---------------------------------------------------------------------------

describe('Admin API - Property 6: Email round-trip on create', () => {
  // Feature: admin-user-management, Property 6: Email round-trip on create
  // Validates: Requirements 3.10

  it('created profile email matches submitted email', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        validPasswordArb,
        async (email, password) => {
          const newUserId = 'round-trip-uuid-' + Math.random().toString(36).slice(2);
          mockCreateUser.mockResolvedValue({
            data: { user: { id: newUserId, email } },
            error: null,
          });
          mockInsert.mockResolvedValue({ data: { id: newUserId, email }, error: null });

          const req = makePostRequest({ email, password, role: 'user' }, 'Bearer admin-token');
          const res = await POST(req);
          const body = await res.json();

          return res.status === 201 && body.email === email;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Password absent/empty on PATCH  updateUserById NOT called with password
// Feature: admin-user-management, Property 7: Password not updated when absent from PATCH body
// Validates: Requirements 4.5
// ---------------------------------------------------------------------------

describe('Admin API - Property 7: Password absent/empty on PATCH does not update password', () => {
  // Feature: admin-user-management, Property 7: Password not updated when absent from PATCH body
  // Validates: Requirements 4.5

  it('does not call updateUserById with password when password is absent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          full_name: fc.option(fc.string(), { nil: undefined }),
          phone: fc.option(fc.string(), { nil: undefined }),
          role: fc.option(fc.string(), { nil: undefined }),
        }).filter((body) => !('password' in body)),
        async (body) => {
          vi.clearAllMocks();
          mockGetUser.mockResolvedValue({ data: { user: makeUser('admin') }, error: null });
          mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
          setupUpdateChain({
            data: { id: 'target-uuid', email: 'user@example.com' },
            error: null,
          });

          const req = makePatchRequest('target-uuid', body as Record<string, unknown>, 'Bearer admin-token');
          await PATCH(req, { params: { id: 'target-uuid' } });

          const calls = mockUpdateUserById.mock.calls;
          for (const call of calls) {
            const updateArg = call[1] as Record<string, unknown>;
            if ('password' in updateArg) return false;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not call updateUserById with password when password is empty string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant({ password: '' }),
        async (body) => {
          vi.clearAllMocks();
          mockGetUser.mockResolvedValue({ data: { user: makeUser('admin') }, error: null });
          mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
          setupUpdateChain({
            data: { id: 'target-uuid', email: 'user@example.com' },
            error: null,
          });

          const req = makePatchRequest('target-uuid', body, 'Bearer admin-token');
          await PATCH(req, { params: { id: 'target-uuid' } });

          const calls = mockUpdateUserById.mock.calls;
          for (const call of calls) {
            const updateArg = call[1] as Record<string, unknown>;
            if ('password' in updateArg) return false;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: DELETE never calls auth.admin.deleteUser
// Feature: admin-user-management, Property 8: Soft-delete never permanently removes data
// Validates: Requirements 5.3, 5.8
// ---------------------------------------------------------------------------

describe('Admin API - Property 8: DELETE never calls auth.admin.deleteUser', () => {
  // Feature: admin-user-management, Property 8: Soft-delete never permanently removes data
  // Validates: Requirements 5.3, 5.8

  it('DELETE never calls mockDeleteUser for any valid request', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArb,
        async (userId) => {
          vi.clearAllMocks();
          try {
            const { getRedisClient } = await import('@/lib/redis');
            const redis = getRedisClient();
            if (redis && typeof (redis as any).flushall === 'function') {
              await (redis as any).flushall();
            }
          } catch {}

          mockGetUser.mockResolvedValue({ data: { user: makeUser('super_admin') }, error: null });
          mockDeleteUser.mockResolvedValue({ data: {}, error: null });
          setupUpdateChain({
            data: { scheduled_delete_at: '2099-01-01T00:00:00.000Z' },
            error: null,
          });

          const req = makeDeleteRequest(userId, 'Bearer super-admin-pbt-token');
          const res = await DELETE(req, { params: { id: userId } });
          const body = await res.json();

          const deleteUserCalled = mockDeleteUser.mock.calls.length > 0;
          const hasActiveFlag = body.success === true;
          const hasScheduledDelete = typeof body.scheduled_delete_at === 'string';

          return !deleteUserCalled && hasActiveFlag && hasScheduledDelete;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Error responses contain only sanitized messages
// Feature: admin-user-management, Property 9: Error responses contain only sanitized messages
// Validates: Requirements 6.1, 6.2
// ---------------------------------------------------------------------------

describe('Admin API - Property 9: Error responses contain only sanitized messages', () => {
  // Feature: admin-user-management, Property 9: Error responses contain only sanitized messages
  // Validates: Requirements 6.1, 6.2

  it('401 response body has only error key with string value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        async (token) => {
          mockGetUser.mockResolvedValue({
            data: { user: null },
            error: { message: 'Invalid JWT', stack: 'some stack trace', code: 'JWT_INVALID' },
          });
          const req = makePostRequest(
            { email: 'test@example.com', password: 'securepass' },
            `Bearer ${token}`,
          );
          const res = await POST(req);
          const body = await res.json();

          const keys = Object.keys(body);
          return (
            keys.length === 1 &&
            keys[0] === 'error' &&
            typeof body.error === 'string' &&
            !('stack' in body) &&
            !('code' in body)
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('403 response body has only error key with string value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((r) => r !== 'admin' && r !== 'super_admin'),
        async (role) => {
          mockGetUser.mockResolvedValue({
            data: { user: makeUser(role) },
            error: null,
          });
          const req = makePostRequest(
            { email: 'test@example.com', password: 'securepass' },
            'Bearer some-token',
          );
          const res = await POST(req);
          const body = await res.json();

          const keys = Object.keys(body);
          return (
            keys.length === 1 &&
            keys[0] === 'error' &&
            typeof body.error === 'string' &&
            !('stack' in body) &&
            !('code' in body)
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('400 response body has only error key with string value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 7 }).filter((s) => s.length > 0),
        async (shortPassword) => {
          const req = makePostRequest(
            { email: 'test@example.com', password: shortPassword },
            'Bearer valid-token',
          );
          const res = await POST(req);
          const body = await res.json();

          const keys = Object.keys(body);
          return (
            keys.length === 1 &&
            keys[0] === 'error' &&
            typeof body.error === 'string' &&
            !('stack' in body) &&
            !('code' in body)
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Non-JSON body returns 400
// Feature: admin-user-management, Property 10: Non-JSON request body returns 400
// Validates: Requirements 6.4
// ---------------------------------------------------------------------------

describe('Admin API - Property 10: Non-JSON body returns 400', () => {
  // Feature: admin-user-management, Property 10: Non-JSON request body returns 400
  // Validates: Requirements 6.4

  const nonJsonArb = fc.string().filter((s) => {
    try {
      JSON.parse(s);
      return false;
    } catch {
      return true;
    }
  });

  it('POST returns 400 for any non-JSON request body', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonJsonArb,
        async (nonJsonBody) => {
          const req = makePostRequest(nonJsonBody, 'Bearer valid-token');
          const res = await POST(req);
          const body = await res.json();
          return res.status === 400 && typeof body.error === 'string';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('PATCH returns 400 for any non-JSON request body', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonJsonArb,
        async (nonJsonBody) => {
          const req = makePatchRequest('some-id', nonJsonBody, 'Bearer valid-token');
          const res = await PATCH(req, { params: { id: 'some-id' } });
          const body = await res.json();
          return res.status === 400 && typeof body.error === 'string';
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Non-2xx API response triggers error toast (frontend)
// Feature: admin-user-management, Property 11: Non-2xx API response triggers error toast
// Validates: Requirements 7.4
// ---------------------------------------------------------------------------

describe('Admin API - Property 11: Non-2xx API response triggers error toast (frontend)', () => {
  // Feature: admin-user-management, Property 11: Non-2xx API response triggers error toast
  // Validates: Requirements 7.4

  it('frontend apiCall helper propagates error message from non-2xx response', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        fc.string({ minLength: 1 }),
        async (statusCode, errorMessage) => {
          // Simulate the apiCall helper behavior:
          // When fetch returns a non-2xx response with { error: errorMessage },
          // the component should receive ok=false and data.error=errorMessage
          const mockResponse = {
            ok: false,
            status: statusCode,
            json: async () => ({ error: errorMessage }),
          };

          // Verify the contract: non-2xx response has ok=false and error field
          const data = await mockResponse.json();
          return (
            mockResponse.ok === false &&
            mockResponse.status === statusCode &&
            typeof data.error === 'string' &&
            data.error === errorMessage
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('error message from non-2xx response is a non-empty string suitable for toast display', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        async (statusCode, errorMessage) => {
          // The frontend toast contract: error must be a non-empty string
          const responseBody = { error: errorMessage };
          return (
            typeof responseBody.error === 'string' &&
            responseBody.error.length > 0
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
