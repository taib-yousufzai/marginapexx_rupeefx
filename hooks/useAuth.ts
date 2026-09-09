'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getSharedSessionSync, getSharedSession } from '@/lib/sharedSession';

/**
 * Checks auth in the background without blocking render.
 * The page renders immediately — if the user is not authenticated,
 * they get redirected to /login after the check completes.
 *
 * Usage:
 *   useAuth();  // in any page component
 */
export function useAuth() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    getSession().then(async (session) => {
      if (cancelled) return;
      if (!session) {
        // Double check shared session before redirecting
        const sync = getSharedSessionSync();
        if (sync.token) return;
        const asyncSession = await getSharedSession().catch(() => ({ token: null }));
        if (asyncSession.token) return;

        if (!(window as any).__disableAuthRedirect && !cancelled) {
          router.replace('/login');
        }
      }
    });
    return () => { cancelled = true; };
  }, [router]);
}
