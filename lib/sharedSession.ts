'use client';

/**
 * Shared session utility for fast, non-blocking access to the Supabase auth session.
 * 
 * Problem: Multiple hooks/components call `supabase.auth.getSession()` on mount,
 * and each call can take 1-2 seconds if the session is stale or the SDK hits the
 * auth server. When 3+ hooks do this simultaneously, the page blocks for 3-6 seconds.
 * 
 * Solution: We read the token directly from localStorage (instant, synchronous),
 * which gives us the access_token immediately. We then lazily refresh the session
 * in the background (non-blocking) so that subsequent calls are fast.
 */

let cachedToken: string | null = null;
let cachedUserId: string | null = null;
let sessionPromise: Promise<{ token: string | null; userId: string | null }> | null = null;

function getTokenFromLocalStorage(): { token: string | null; userId: string | null } {
  if (typeof window === 'undefined') return { token: null, userId: null };
  
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    let storageKey = '';
    try {
      if (supabaseUrl) {
        const hostname = new URL(supabaseUrl).hostname;
        storageKey = hostname.split('.')[0];
      }
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
    if (!stored) return { token: null, userId: null };
    
    const parsed = JSON.parse(stored);
    const token = parsed?.access_token || null;
    
    // Check if the token is expired; if expiring soon (< 60s), schedule background refresh
    const expiresAt = parsed?.expires_at;
    if (expiresAt && Date.now() / 1000 > expiresAt) {
      return { token: null, userId: null };
    }
    if (expiresAt && Date.now() / 1000 > expiresAt - 60) {
      if (typeof window !== 'undefined') {
        setTimeout(() => { getSharedSession().catch(() => {}); }, 0);
      }
    }
    
    let userId: string | null = null;
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        userId = payload.sub || null;
      } catch {}
    }
    
    return { token, userId };
  } catch {
    return { token: null, userId: null };
  }
}

/**
 * Get the current session token and user ID.
 * First call reads from localStorage (instant). Falls back to getSession() only if needed.
 * Result is cached so all subsequent calls are instant.
 */
export async function getSharedSession(): Promise<{ token: string | null; userId: string | null }> {
  // If we have a cached token, verify it hasn't expired in memory
  if (cachedToken) {
    try {
      const payload = JSON.parse(atob(cachedToken.split('.')[1]));
      const exp = payload.exp;
      if (exp && Date.now() / 1000 < exp) {
        return { token: cachedToken, userId: cachedUserId };
      }
    } catch {
      cachedToken = null;
      cachedUserId = null;
    }
  }
  
  // Try localStorage (verifying expiration)
  const local = getTokenFromLocalStorage();
  if (local.token) {
    cachedToken = local.token;
    cachedUserId = local.userId;
    return local;
  }
  
  // Deduplicate: if someone else is already calling getSession(), wait for that
  if (sessionPromise) return sessionPromise;
  
  // Last resort: call getSession() (slow, but only happens once and triggers refresh)
  sessionPromise = (async () => {
    try {
      const { supabase: sb } = await import('@/lib/supabaseClient');
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        cachedToken = session.access_token;
        cachedUserId = session.user.id;
        return { token: cachedToken, userId: cachedUserId };
      }
    } catch (err) {
      console.error('[SharedSession] getSession failed:', err);
    } finally {
      sessionPromise = null;
    }
    return { token: null, userId: null };
  })();
  
  return sessionPromise;
}

/**
 * Synchronous version - returns whatever is cached or in localStorage.
 * Returns null if no session is available yet. Never blocks.
 */
export function getSharedSessionSync(): { token: string | null; userId: string | null } {
  if (cachedToken) {
    try {
      const payload = JSON.parse(atob(cachedToken.split('.')[1]));
      const exp = payload.exp;
      if (exp && Date.now() / 1000 < exp) {
        return { token: cachedToken, userId: cachedUserId };
      }
    } catch {
      cachedToken = null;
      cachedUserId = null;
    }
  }
  const local = getTokenFromLocalStorage();
  if (local.token) {
    cachedToken = local.token;
    cachedUserId = local.userId;
  } else {
    cachedToken = null;
    cachedUserId = null;
  }
  return local;
}

export function clearSharedSession(): void {
  cachedToken = null;
  cachedUserId = null;
  sessionPromise = null;
}

