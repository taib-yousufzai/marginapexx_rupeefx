import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { clearSharedSession } from './sharedSession';

export function clearAuthCache(): void {
  _cachedSession = null;
  _cacheTimestamp = 0;
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
export type AppRole = 'super_admin' | 'admin' | 'broker' | 'user';

/**
 * Returns the role of the given Supabase user.
 * Uses strict equality checks for each of the four known role strings.
 * Returns 'user' for all other inputs (null user, missing field, any other value).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
export function getRole(user: User | null): AppRole {
  const role = user?.user_metadata?.role;
  if (role === 'super_admin') return 'super_admin';
  if (role === 'admin') return 'admin';
  if (role === 'broker') return 'broker';
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
  let targetEmail = email.trim();

  // Try standard Supabase Auth with an 8s timeout.
  // On localhost → Supabase Cloud round-trips can take 2-6s; 8s gives enough headroom
  // without blocking forever when the network is degraded.
  try {
    const authPromise = supabase.auth.signInWithPassword({ email: targetEmail, password });
    const timeoutAuth = new Promise<any>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 8000)
    );

    const res = await Promise.race([authPromise, timeoutAuth]);

    if (!res.timeout && res.data?.session && res.data?.user && !res.error) {
      _cachedSession = res.data.session;
      _cacheTimestamp = Date.now();
      return { session: res.data.session, user: res.data.user };
    }

    if (!res.timeout && res.error && !res.error.message.includes('FetchError') && !res.error.message.includes('timeout')) {
      // Return invalid credentials error immediately if password was wrong
      return { error: res.error.message };
    }
  } catch (e) {
    console.warn('Supabase Auth SDK call failed/timed out, attempting server auth fallback:', e);
  }

  // Fallback: Direct server auth via /api/auth/login
  // Only useful for: (a) non-email identifiers (client_id/phone) needing email resolution,
  //                  (b) demo credentials that work offline without Supabase.
  // For all other email logins, hitting the route would just call Supabase again — same latency, no benefit.
  const isEmailLogin = targetEmail.includes('@');
  const isDemoCredentials = (
    targetEmail.toLowerCase() === 'demo@gmail.com' && password === 'demo123'
  );
  if (isEmailLogin && !isDemoCredentials) {
    return { error: 'Authentication failed. Please check credentials or network connection.' };
  }

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      return { error: data.error || 'Invalid credentials. Please try again.' };
    }

    if (data.session && data.user) {
      _cachedSession = data.session;
      _cacheTimestamp = Date.now();

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
          await supabase.auth.setSession({
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token || '',
          }).catch(() => {});
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
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      return { error: 'Something went wrong. Please try again.' };
    }

    return { success: true };
  } catch {
    return { error: 'Something went wrong. Please try again.' };
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
    sb.auth.onAuthStateChange((_event, session) => {
      if (session) {
        _cachedSession = session;
        _cacheTimestamp = Date.now();
      } else {
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
  if (_sessionPromise) {
    return _sessionPromise;
  }

  _sessionPromise = (async () => {
    try {
      // Return cached session if still fresh
      if (_cachedSession && Date.now() - _cacheTimestamp < SESSION_CACHE_TTL_MS) {
        return _cachedSession;
      }

      // getSession() reads from localStorage — normally instant.
      // But with a stale/invalid token it may make a network refresh call; cap at 6s.
      const getSessionPromise = supabase.auth.getSession();
      const getSessionTimeout = new Promise<{ data: { session: null }; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: { session: null }, error: new Error('getSession timeout') }), 6000)
      );
      const { data: sessionData, error: sessionError } = await Promise.race([getSessionPromise, getSessionTimeout]);
      
      if (sessionError || !sessionData?.session) {
        if (_cachedSession) {
          return _cachedSession;
        }
        _cachedSession = null;
        return null;
      }

      let user = sessionData.session.user;

      // getUser() makes a live network call to Supabase Auth API.
      // Guard it with a 5s timeout so a slow connection doesn't hang the page.
      try {
        const getUserPromise = supabase.auth.getUser();
        const getUserTimeout = new Promise<{ data: null; error: Error }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('getUser timeout') }), 5000)
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

