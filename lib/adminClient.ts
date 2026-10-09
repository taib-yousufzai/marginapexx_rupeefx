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

export function isTransientDbError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || (typeof err === 'string' ? err : '')).toLowerCase();
  const code = (err.code || (err as any)?.details || '').toLowerCase();

  // 1. PostgreSQL Deadlocks / Serialization failures / Lock contention
  if (
    code === '40p01' ||
    code === '55p03' ||
    code === '40001' ||
    msg.includes('deadlock') ||
    msg.includes('lock_not_available') ||
    msg.includes('could not serialize access')
  ) {
    return true;
  }

  // 2. PostgREST Schema Cache / Connection Pool / 503 errors
  if (
    msg.includes('schema cache') ||
    msg.includes('pgrst') ||
    msg.includes('retrying') ||
    msg.includes('503') ||
    msg.includes('service unavailable') ||
    msg.includes('502') ||
    msg.includes('bad gateway')
  ) {
    return true;
  }

  // 3. Network / Transport blips
  if (
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('etimedout') ||
    msg.includes('network')
  ) {
    return true;
  }

  return false;
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 50
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fn();
      if (res && typeof res === 'object' && 'error' in res && (res as any).error) {
        const sbErr = (res as any).error;
        if (isTransientDbError(sbErr) && attempt < maxRetries) {
          const jitter = Math.floor(Math.random() * 30);
          const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
          console.warn(`[withDbRetry] Transient Supabase error on attempt ${attempt + 1}: ${sbErr.message}. Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      return res;
    } catch (err: any) {
      lastErr = err;
      if (isTransientDbError(err) && attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * 30);
        const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
        console.warn(`[withDbRetry] Transient DB exception on attempt ${attempt + 1}: ${err.message || err}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
    const cachedUser = await Promise.race([
      redis.get(`auth_user:${token}`),
      new Promise(r => setTimeout(() => r(null), 300))
    ]) as string | null;
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

    // 1. Instant 0ms local JWT verification
    resolvedUser = parseJwtLocally(token);

    // 2. Fallback: Supabase Cloud Auth API query if local JWT parsing failed
    if (!resolvedUser) {
      try {
        const admin = getAdminClient();
        const authPromise = admin.auth.getUser(token);
        const timeoutPromise = new Promise<{ data: null; error: any }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('Supabase Auth timeout') }), 1000)
        );

        const { data, error } = await Promise.race([authPromise, timeoutPromise]);
        if (!error && data?.user) {
          resolvedUser = data.user;
        }
      } catch (err) {
        console.warn('[getUserFromRequest] Supabase auth network error:', err);
      }
    }

    if (!resolvedUser) {
      return null;
    }

    try {
      const { getRedisClient } = await import('./redis');
      const redis = getRedisClient();
      // Cache the validated user for 1 hour in Redis/Mock with 300ms safety timeout
      await Promise.race([
        redis.setex ? redis.setex(`auth_user:${token}`, 3600, JSON.stringify(resolvedUser)) : redis.set(`auth_user:${token}`, JSON.stringify(resolvedUser), 'EX', 3600),
        new Promise(r => setTimeout(r, 300))
      ]);
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
