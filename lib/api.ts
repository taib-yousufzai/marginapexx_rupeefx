'use client';

import { getSharedSession, getSharedSessionSync, clearSharedSession } from '@/lib/sharedSession';
import { clearAuthCache } from '@/lib/auth';


// ─── Public Types ────────────────────────────────────────────────────────────

export interface RequestOptions {
  /** Caller-provided abort signal. Composed with any internal timeout signal. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. No timeout applied when omitted. */
  timeout?: number;
  /** @internal Retry flag to prevent infinite loops */
  _retry?: boolean;
}

export class ApiError extends Error {
  /** HTTP status code (e.g. 401, 404, 500). */
  readonly status: number;
  /** `code` field from the JSON error body, if present. */
  readonly code?: string;
  /** Full parsed error body (object) or raw text when JSON parsing fails. */
  readonly details?: unknown;

  constructor(status: number, details?: unknown, code?: string) {
    let msg = `ApiError ${status}`;
    if (details && typeof details === 'object' && details !== null && 'error' in details && typeof (details as Record<string, unknown>).error === 'string') {
      msg = (details as Record<string, unknown>).error as string;
    } else if (typeof details === 'string' && details.trim()) {
      msg = details;
    }
    super(msg);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

// ─── Dev Metrics (development only) ─────────────────────────────────────────

interface ApiMetricsEntry {
  path: string;
  method: string;
  durationMs: number;
  success: boolean;
  aborted: boolean;
}

declare global {
  interface Window {
    __apiMetrics?: ApiMetricsEntry[];
  }
}

// ─── Internal ApiClient interface ────────────────────────────────────────────

interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

// ─── Core implementation ──────────────────────────────────────────────────────

async function apiCall<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const { token } = getSharedSessionSync();

  // Build headers
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
  }

  // Signal composition
  let signal: AbortSignal | undefined;
  let timeoutController: AbortController | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const { signal: callerSignal } = options ?? {};
  const effectiveTimeout = options?.timeout ?? 15000;

  if (effectiveTimeout > 0) {
    timeoutController = new AbortController();
    timerId = setTimeout(() => timeoutController!.abort(), effectiveTimeout);
  }

  if (callerSignal && timeoutController) {
    // Both signals: combine via AbortSignal.any if available, otherwise manual
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([callerSignal, timeoutController.signal]);
    } else {
      const combined = new AbortController();
      const abort = () => combined.abort();
      callerSignal.addEventListener('abort', abort, { once: true });
      timeoutController.signal.addEventListener('abort', abort, { once: true });
      signal = combined.signal;
    }
  } else if (callerSignal) {
    signal = callerSignal;
  } else if (timeoutController) {
    signal = timeoutController.signal;
  }

  const startTime = Date.now();
  let success = false;
  let aborted = false;

  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined && method !== 'GET' && method !== 'DELETE'
        ? JSON.stringify(body)
        : undefined,
      signal,
      cache: 'no-store',
    });

    if (res.ok) {
      success = true;
      return res.json() as Promise<T>;
    }

    if (res.status === 401) {
      if (typeof window !== 'undefined') {
        const path = window.location.pathname;
        if (path !== '/login' && path !== '/register' && path !== '/forgot-password' && path !== '/reset-password') {
          // Attempt a session refresh and retry once if not already retried
          if (!options?._retry) {
            try {
              const fresh = await getSharedSession();
              if (fresh && fresh.token && fresh.token !== token) {
                return apiCall<T>(method, path, body, { ...options, _retry: true });
              }
            } catch {}
          }

          // Check whether an active session still exists before kicking user to login
          try {
            const { supabase: sb } = await import('@/lib/supabaseClient');
            const { data: { session } } = await sb.auth.getSession();
            if (session) {
              // Active session is still valid; do not force-redirect or clear auth
              throw new ApiError(401, 'Unauthorized request');
            }
          } catch (e) {
            if (e instanceof ApiError) throw e;
          }

          clearSharedSession();
          clearAuthCache();
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
          window.location.href = '/login?expired=1';
          return new Promise<T>(() => {});
        }
      }
    }


    // Error path: parse body for structured error info
    let details: unknown;
    let code: string | undefined;
    const rawText = await res.text();
    try {
      const parsed = rawText ? JSON.parse(rawText) : null;
      details = parsed ?? rawText;
      if (parsed && typeof parsed === 'object' && 'code' in parsed) {
        code = String((parsed as Record<string, unknown>).code);
      }
    } catch {
      details = rawText;
    }
    throw new ApiError(res.status, details, code);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'AbortError' || (err instanceof DOMException && err.name === 'AbortError'))
    ) {
      aborted = true;
    }
    throw err;
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }

    if (process.env.NODE_ENV === 'development') {
      const durationMs = Date.now() - startTime;
      if (!window.__apiMetrics) window.__apiMetrics = [];
      window.__apiMetrics.push({ path, method, durationMs, success, aborted });
    }
  }
}

// ─── Public API object ────────────────────────────────────────────────────────

export const api: ApiClient = {
  get:    (path, opts)       => apiCall('GET',    path, undefined, opts),
  post:   (path, body, opts) => apiCall('POST',   path, body,      opts),
  patch:  (path, body, opts) => apiCall('PATCH',  path, body,      opts),
  put:    (path, body, opts) => apiCall('PUT',    path, body,      opts),
  delete: (path, opts)       => apiCall('DELETE', path, undefined, opts),
};
