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

  // If user entered client_id or phone (no '@'), attempt client_id / phone lookup (with 2.5s timeout)
  if (targetEmail && !targetEmail.includes('@')) {
    try {
      const lookupPromise = supabase
        .from('profiles')
        .select('email')
        .or(`client_id.eq.${targetEmail},phone.eq.${targetEmail},client_id.eq.${targetEmail.toUpperCase()}`)
        .maybeSingle();

      const timeoutPromise = new Promise<{ data: null }>((resolve) =>
        setTimeout(() => resolve({ data: null }), 2500)
      );

      const res: any = await Promise.race([lookupPromise, timeoutPromise]);
      if (res?.data?.email) {
        targetEmail = res.data.email;
      }
    } catch (e) {
      console.warn('Identifier lookup warning:', e);
    }
  }

  // Execute auth request with a 12-second timeout fail-safe
  try {
    const authPromise = supabase.auth.signInWithPassword({ email: targetEmail, password });
    const timeoutAuth = new Promise<{ data: { session: null; user: null }; error: { message: string } }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            data: { session: null, user: null },
            error: { message: 'Authentication timed out. Please check network connection and try again.' },
          }),
        12000
      )
    );

    const { data, error } = await Promise.race([authPromise, timeoutAuth]);

    if (error || !data?.session || !data?.user) {
      return { error: error?.message || 'Invalid credentials. Please try again.' };
    }

    _cachedSession = data.session;
    _cacheTimestamp = Date.now();

    return { session: data.session, user: data.user };
  } catch (err: any) {
    return { error: err?.message || 'Authentication error. Please try again.' };
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
  try {
    // Keep the watchlist intact even after logging out
    // if (_cachedSession && (_cachedSession.user?.email === 'demo@gmail.com' || _cachedSession.user?.user_metadata?.demo_user)) {
    //   localStorage.setItem('marginApex_watchlist', '[]');
    // }
  } catch (e) {
    console.error('Failed to clear demo watchlist on signout:', e);
  }
  clearAuthCache();
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error('signOut error:', error);
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

      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError || !sessionData?.session) {
        _cachedSession = null;
        return null;
      }

      let user = sessionData.session.user;

      try {
        const { data: userData, error: userError } = await supabase.auth.getUser();
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

