/**
 * Kite session persistence helpers.
 *
 * Uses the Supabase service-role client so these functions can run
 * server-side (API routes) without needing the user's JWT.
 *
 * Table: public.kite_sessions
 *   user_id       uuid  (FK → auth.users)
 *   kite_user_id  text
 *   access_token  text
 *   expires_at    timestamptz
 */

import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error('Missing Supabase env vars for admin client');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface KiteSessionData {
  kiteUserId: string;
  accessToken: string;
  expiresAt: Date;
}

/**
 * Upsert a Kite session for the given Supabase user.
 * Called from the OAuth callback after a successful token exchange.
 */
export async function saveKiteSession(
  supabaseUserId: string,
  data: KiteSessionData,
): Promise<void> {
  const admin = getAdminClient();

  const { error } = await admin
    .from('kite_sessions')
    .upsert(
      {
        user_id: supabaseUserId,
        kite_user_id: data.kiteUserId,
        access_token: data.accessToken,
        expires_at: data.expiresAt.toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (error) {
    throw new Error(`Failed to save Kite session: ${error.message}`);
  }
}

/**
 * Load a Kite session for the given Supabase user.
 * Returns null if no session exists or if it has expired.
 */
export async function loadKiteSession(
  supabaseUserId: string,
): Promise<KiteSessionData | null> {
  const admin = getAdminClient();

  const { data, error } = await admin
    .from('kite_sessions')
    .select('kite_user_id, access_token, expires_at')
    .eq('user_id', supabaseUserId)
    .single();

  if (error || !data) return null;

  const expiresAt = new Date(data.expires_at as string);
  if (expiresAt <= new Date()) {
    // Token expired — clean it up
    await admin.from('kite_sessions').delete().eq('user_id', supabaseUserId);
    return null;
  }

  return {
    kiteUserId: data.kite_user_id as string,
    accessToken: data.access_token as string,
    expiresAt,
  };
}

// ─── Shared Session Cache ───────────────────────────────────────────────────

let sharedSessionCache: KiteSessionData | null = null;
let lastSharedFetchTime = 0;
// 5 minutes: short enough that a new session written by auto-login is picked up
// at the next initKite() call without requiring a process restart.
// Previously 12h which caused the ticker to use stale expired tokens.
const SHARED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load the master/shared Kite session that is used for "everyone".
 * Uses the ZERODHA_SUPABASE_USER_ID from environment variables.
 * Results are cached in memory for 60 seconds.
 */
export async function getSharedKiteSession(): Promise<KiteSessionData | null> {
  const now = Date.now();
  if (now - lastSharedFetchTime < SHARED_CACHE_TTL) {
    if (!sharedSessionCache) return null;
    if (sharedSessionCache.expiresAt > new Date()) {
      return sharedSessionCache;
    }
  }

  const masterId = process.env.ZERODHA_SUPABASE_USER_ID;
  if (!masterId) {
    console.warn('ZERODHA_SUPABASE_USER_ID not configured for shared session');
    return null;
  }

  const session = await loadKiteSession(masterId);
  sharedSessionCache = session;
  lastSharedFetchTime = now;
  return session;
}

/**
 * Immediately busts the in-process session cache.
 * Call this after a successful auto-login so that the next
 * getSharedKiteSession() call re-reads from Supabase.
 */
export function invalidateSharedKiteSessionCache(): void {
  sharedSessionCache = null;
  lastSharedFetchTime = 0;
}

export async function deleteKiteSession(supabaseUserId: string): Promise<void> {
  const admin = getAdminClient();
  await admin.from('kite_sessions').delete().eq('user_id', supabaseUserId);
}

/**
 * Calculate the expiry time for a Kite access token.
 * Kite invalidates tokens at 06:00 IST = 00:30 UTC the next calendar day.
 */
export function kiteTokenExpiresAt(): Date {
  const now = new Date();
  // Next 00:30 UTC
  const expiry = new Date(now);
  expiry.setUTCHours(0, 30, 0, 0);
  if (expiry <= now) {
    // Already past 00:30 UTC today — use tomorrow
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }
  return expiry;
}
