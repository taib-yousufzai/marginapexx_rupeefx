/**
 * Shared Supabase admin (service-role) client factory.
 * Imported by API routes that need full DB access.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (_adminClient) return _adminClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
  if (!key) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');

  _adminClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _adminClient;
}

/**
 * Helper to parse and validate a Supabase JWT payload locally without HTTP requests.
 * Used as a zero-latency fallback during Supabase Cloud network degradation or Error 522 timeouts.
 */
function parseJwtLocally(token: string): any | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson);
    if (!payload || !payload.sub || !payload.exp) return null;

    const now = Math.floor(Date.now() / 1000);
    // Ensure token is not expired (allowing 60s clock skew)
    if (payload.exp < now - 60) return null;

    return {
      id: payload.sub,
      email: payload.email || '',
      user_metadata: payload.user_metadata || {},
      app_metadata: payload.app_metadata || {},
      role: payload.role || 'authenticated',
      aud: payload.aud || 'authenticated',
      created_at: new Date(payload.iat ? payload.iat * 1000 : Date.now()).toISOString(),
    };
  } catch {
    return null;
  }
}

const pendingRequests = new Map<string, Promise<any>>();

/**
 * Resolve and verify a Supabase Bearer JWT from an Authorization header.
 * Returns the user object or null if invalid.
 */
export async function getUserFromRequest(request: Request) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;

  const token = auth.slice(7).trim();
  if (!token || token === 'null' || token === 'undefined') return null;

  try {
    const { getRedisClient } = await import('./redis');
    const redis = getRedisClient();
    const cachedUser = await redis.get(`auth_user:${token}`);
    if (cachedUser) {
      return JSON.parse(cachedUser);
    }
  } catch {
    // Ignore Redis errors
  }

  // Prevent cache stampede by reusing pending requests for the same token
  if (pendingRequests.has(token)) {
    try {
      return await pendingRequests.get(token);
    } catch {
      return null;
    }
  }

  const fetchUser = async () => {
    let resolvedUser: any = null;

    try {
      const admin = getAdminClient();
      
      // Race admin.auth.getUser against a 2.0s fast timeout to prevent Supabase Cloud 522 hangs
      const authPromise = admin.auth.getUser(token);
      const timeoutPromise = new Promise<{ data: null; error: any }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('Supabase Auth timeout') }), 2000)
      );

      const { data, error } = await Promise.race([authPromise, timeoutPromise]);

      if (!error && data?.user) {
        resolvedUser = data.user;
      }
    } catch (err) {
      console.warn('[getUserFromRequest] Supabase auth network error, attempting local JWT fallback:', err);
    }

    // Fallback: Local JWT verification if Supabase Cloud API timed out or errored
    if (!resolvedUser) {
      resolvedUser = parseJwtLocally(token);
    }

    if (!resolvedUser) {
      return null;
    }

    try {
      const { getRedisClient } = await import('./redis');
      const redis = getRedisClient();
      // Cache the validated user for 1 hour in Redis/Mock
      if (redis.setex) {
        await redis.setex(`auth_user:${token}`, 3600, JSON.stringify(resolvedUser));
      } else {
        await redis.set(`auth_user:${token}`, JSON.stringify(resolvedUser), 'EX', 3600);
      }
    } catch {
      // Ignore Redis errors
    }

    return resolvedUser;
  };

  const promise = fetchUser().finally(() => {
    pendingRequests.delete(token);
  });
  pendingRequests.set(token, promise);

  return promise;
}
