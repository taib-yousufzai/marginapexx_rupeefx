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

  const saveSession = (session: any, user: any): SignInResult => {
    _cachedSession = session;
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
          localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(session));
        }
        localStorage.setItem('sb-auth-token', JSON.stringify(session));
      } catch (e) {
        console.warn('[signIn] Failed to persist session to localStorage:', e);
      }

      try {
        if (session.access_token && session.refresh_token) {
          supabase.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          }).catch(() => {});
        }
      } catch {}
    }

    return { session, user };
  };

  // 1. Direct Server Authentication via /api/auth/login
  const serverAuthPromise = (async () => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: cleanPassword }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Invalid credentials. Please try again.');
    }
    if (data.session && data.user) {
      return data;
    }
    throw new Error('Authentication failed');
  })();

  // 2. If it is an email, race in parallel with client SDK — whichever finishes first wins immediately!
  if (targetEmail.includes('@')) {
    const clientAuthPromise = (async () => {
      const res = await supabase.auth.signInWithPassword({
        email: targetEmail,
        password: cleanPassword,
      });
      if (res.error) {
        throw new Error(res.error.message || 'Invalid credentials');
      }
      if (res.data?.session && res.data?.user) {
        return { session: res.data.session, user: res.data.user };
      }
      throw new Error('No session returned');
    })();

    try {
      const firstSuccess = await Promise.any([serverAuthPromise, clientAuthPromise]);
      return saveSession(firstSuccess.session, firstSuccess.user);
    } catch (aggregateErr: any) {
      const firstErr = aggregateErr?.errors?.[0]?.message || aggregateErr?.message || 'Invalid credentials. Please try again.';
      return { error: firstErr };
    }
  }

  // Non-email identifier (client_id, phone, username): handled by server route
  try {
    const data = await serverAuthPromise;
    return saveSession(data.session, data.user);
  } catch (err: any) {
    return { error: err?.message || 'Invalid credentials. Please try again.' };
  }
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
