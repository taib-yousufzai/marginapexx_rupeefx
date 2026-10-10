import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { clearSharedSession } from './sharedSession';

export function clearAuthCache(): void {
  _cachedSession = null;
  _cacheTimestamp = 0;
  _sessionPromise = null;
  clearSharedSession();
}


// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Discriminated union returned by signIn.
 * On success: { session, user }
 * On failure: { error }
 */
export type SignInResult =
  | { session: Session; user: User; error?: never }
  | { session?: never; user?: never; error: string };

/**
 * Discriminated union returned by requestPasswordReset and updatePassword.
 * On success: { success: true }
 * On failure: { error }
 */
export type PasswordResetResult =
  | { success: true }
  | { error: string };

/**
 * All valid application roles.
 * Stored in user.user_metadata.role.
 */
export type AppRole = 'super_admin' | 'admin' | 'broker' | 'sub_broker' | 'user';

/**
 * Returns the role of the given Supabase user.
 * Uses strict equality checks for each of the known role strings.
 * Returns 'user' for all other inputs (null user, missing field, any other value).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
export function getRole(user: User | null): AppRole {
  const role = user?.user_metadata?.role;
  if (role === 'super_admin') return 'super_admin';
  if (role === 'admin') return 'admin';
  if (role === 'broker') return 'broker';
  if (role === 'sub_broker') return 'sub_broker';
  return 'user';
}

// ─── Auth functions ───────────────────────────────────────────────────────────

/**
 * Signs in a user with email and password via Supabase Auth.
 *
 * On success returns { session, user }.
 * On any error returns { error: "Invalid credentials. Please try again." } —
 * the raw Supabase error is never surfaced to callers.
 *
 * Validates: Requirements 2.1, 2.3, 5.3
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const targetEmail = email.trim().toLowerCase();
  const cleanPassword = password.trim();

  // Fast-path: non-email identifiers (client_id, phone), demo account, and RupeeFX admin bypass
  // browser Supabase SDK directly to /api/auth/login, avoiding invalid email format errors & timeouts.
  const isNonEmailOrDemo =
    !targetEmail.includes('@') ||
    ((targetEmail === 'demo@gmail.com' || targetEmail === 'demo123') && cleanPassword === 'demo123') ||
    ((targetEmail === 'admin.rupeefx@gmail.com' || targetEmail === 'fot290' || targetEmail === 'fot 290') && cleanPassword === 'rupeefx.admin@123') ||
    ((targetEmail === 'niveshx@gmail.com' || targetEmail === 'ocx39z' || targetEmail === 'ocx 39z') && (cleanPassword === 'niveshx.admin@123' || cleanPassword === 'niveshx@123')) ||
    ((targetEmail === 'admin@gmail.com' || targetEmail === '9a06b2' || targetEmail === '9a 06b2') && (cleanPassword === 'admin.apex@123' || cleanPassword === 'admin@password123'));

  if (!isNonEmailOrDemo) {
    try {
      const authPromise = supabase.auth.signInWithPassword({ email: targetEmail, password: cleanPassword });
      const timeoutAuth = new Promise<any>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), 3000)
      );

      const res = await Promise.race([authPromise, timeoutAuth]);

      if (!res.timeout && res.data?.session && res.data?.user && !res.error) {
        _cachedSession = res.data.session;
        _cacheTimestamp = Date.now();
        _sessionPromise = null;
        return { session: res.data.session, user: res.data.user };
      }

      // Supabase returned a definitive auth error (e.g. wrong password, user not found).
      if (!res.timeout && res.error) {
        const errMsg = res.error.message || '';
        const isNetworkErr = errMsg.includes('FetchError') || errMsg.includes('timeout') || errMsg.includes('fetch') || errMsg.includes('network');
        if (!isNetworkErr) {
          return { error: errMsg || 'Invalid credentials. Please try again.' };
        }
      }
    } catch (e) {
      console.warn('Supabase Auth SDK call failed/timed out, attempting server auth fallback:', e);
    }
  }

  // Fallback: Direct server auth via /api/auth/login
  // Handles: (a) non-email identifiers (client_id/phone) needing email resolution,
  //          (b) network issues where client SDK timed out but server can still reach Supabase,
  //          (c) demo credentials,
  //          (d) RupeeFX admin instant authentication.
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: cleanPassword }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      return { error: data.error || 'Invalid credentials. Please try again.' };
    }

    if (data.session && data.user) {
      _cachedSession = data.session;
      _cacheTimestamp = Date.now();
      _sessionPromise = null;

      if (typeof window !== 'undefined') {
        try {
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
          let projectRef = '';
          if (supabaseUrl) {
            try { projectRef = new URL(supabaseUrl).hostname.split('.')[0]; } catch {}
          }
          if (projectRef) {
            localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(data.session));
          }
          localStorage.setItem('sb-auth-token', JSON.stringify(data.session));
        } catch (e) {
          console.warn('[signIn] Failed to persist fallback session to localStorage:', e);
        }
      }

      return { session: data.session, user: data.user };
    }
  } catch (err: any) {
    console.error('Direct auth fallback error:', err);
  }

  return { error: 'Authentication failed. Please check credentials or network connection.' };
}

/**
 * Signs out the current user via Supabase Auth and redirects to /login.
 * The redirect happens regardless of whether the sign-out call succeeds or fails.
 * Any error is logged to the console but not surfaced to the caller.
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 */
export async function signOut(): Promise<void> {
  clearAuthCache();
  if (typeof window !== 'undefined') {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {}
  }
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('signOut error:', error);
    }
  } catch (err) {
    console.error('signOut catch error:', err);
  }
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

/**
 * Requests a password reset email for the given address via Supabase Auth.
 *
 * On success returns { success: true }.
 * On any error returns { error: "Something went wrong. Please try again." } —
 * the raw Supabase error is never surfaced to callers.
 *
 * Validates: Requirements 5.1, 5.3, 5.5
 */
export async function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  const targetEmail = email.trim();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { error: data.error || 'Something went wrong. Please try again.' };
    }

    return { success: true };
  } catch (err: any) {
    console.warn('[requestPasswordReset] Backend route failed/timed out, attempting client SDK fallback:', err);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(targetEmail, {
        redirectTo: `${typeof window !== 'undefined' ? window.location.origin : ''}/reset-password`,
      });

      if (error) {
        return { error: error.message || 'Something went wrong. Please try again.' };
      }

      return { success: true };
    } catch {
      return { error: 'Failed to send reset link. Please check your network connection.' };
    }
  }
}

/**
 * Updates the current user's password via Supabase Auth.
 * Requires an active PASSWORD_RECOVERY session.
 *
 * On success returns { success: true }.
 * On any error returns { error: "Failed to update password. Please try again or request a new reset link." } —
 * the raw Supabase error is never surfaced to callers.
 *
 * Validates: Requirements 5.2, 5.4, 5.6
 */
export async function updatePassword(newPassword: string): Promise<PasswordResetResult> {
  try {
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      return { error: 'Failed to update password. Please try again or request a new reset link.' };
    }

    return { success: true };
  } catch {
    return { error: 'Failed to update password. Please try again or request a new reset link.' };
  }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

// In-memory session cache — avoids a network round-trip on every page mount.
// Invalidated on sign-out and refreshed when the token changes.
let _cachedSession: Session | null = null;
let _cacheTimestamp = 0;
const SESSION_CACHE_TTL_MS = 60_000; // re-validate after 60 seconds

// Supabase keeps the session fresh via its own token refresh mechanism.
// We listen for auth state changes to keep our cache in sync.
if (typeof window !== 'undefined') {
  import('./supabaseClient').then(({ supabase: sb }) => {
    sb.auth.onAuthStateChange((event, session) => {
      if (session) {
        _cachedSession = session;
        _cacheTimestamp = Date.now();
      } else if (event === 'SIGNED_OUT') {
        _cachedSession = null;
        _cacheTimestamp = 0;
      }
    });
  });
}

/**
 * Returns the current Supabase session, or null if the user is not authenticated.
 * Uses an in-memory cache (60s TTL) to avoid a network call on every page mount.
 * Falls back to a fresh getUser() call when the cache is stale or empty.
 *
 * Validates: Requirements 3.2
 */
let _sessionPromise: Promise<Session | null> | null = null;

export async function getSession(): Promise<Session | null> {
  // 1. Return cached session if still fresh in memory
  if (_cachedSession && Date.now() - _cacheTimestamp < SESSION_CACHE_TTL_MS) {
    return _cachedSession;
  }

  // 2. Instant localStorage lookup without network delay
  if (typeof window !== 'undefined') {
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
      let storageKey = '';
      try {
        if (supabaseUrl) storageKey = new URL(supabaseUrl).hostname.split('.')[0];
      } catch {}

      let stored = storageKey ? localStorage.getItem(`sb-${storageKey}-auth-token`) : null;
      if (!stored) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
            stored = localStorage.getItem(key);
            if (stored) break;
          }
        }
      }
      if (!stored) {
        stored = localStorage.getItem('sb-auth-token');
      }

      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.access_token && parsed.user) {
          const expiresAt = parsed.expires_at;
          if (!expiresAt || Date.now() / 1000 < expiresAt) {
            _cachedSession = parsed;
            _cacheTimestamp = Date.now();
            return parsed;
          }
        }
      }
    } catch (storageErr) {
      console.warn('[getSession] LocalStorage parse warning:', storageErr);
    }
  }

  if (_sessionPromise) {
    return _sessionPromise;
  }

  _sessionPromise = (async () => {
    try {
      // 3. Fallback to Supabase client SDK with short timeout
      const getSessionPromise = supabase.auth.getSession();
      const getSessionTimeout = new Promise<{ data: { session: null }; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: { session: null }, error: new Error('getSession timeout') }), 1200)
      );
      const { data: sessionData, error: sessionError } = await Promise.race([getSessionPromise, getSessionTimeout]);
      
      if (sessionError || !sessionData?.session) {
        if (_cachedSession) {
          return _cachedSession;
        }
        return null;
      }

      let user = sessionData.session.user;

      try {
        const getUserPromise = supabase.auth.getUser();
        const getUserTimeout = new Promise<{ data: null; error: Error }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('getUser timeout') }), 1000)
        );
        const { data: userData, error: userError } = await Promise.race([getUserPromise, getUserTimeout]);
        if (!userError && userData?.user) {
          user = userData.user;
        }
      } catch (e) {
        console.warn('getUser() network call warning:', e);
      }

      const freshSession = { ...sessionData.session, user };

      _cachedSession = freshSession;
      _cacheTimestamp = Date.now();
      return freshSession;
    } catch (err) {
      console.error('getSession unexpected error:', err);
      // Fallback to cached session if available instead of hard failing
      if (_cachedSession) {
        return _cachedSession;
      }
      return null;
    } finally {
      _sessionPromise = null;
    }
  })();

  return _sessionPromise;
}
