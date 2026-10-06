import { api } from '@/lib/api';
import { getSharedSessionSync } from '@/lib/sharedSession';
import type { MyOrder, MyPosition } from '@/lib/types/order';
import type { SegmentSetting, ScriptSetting } from '@/lib/types/tradeConfig';

export interface BootstrapData {
  balance: number;
  settlementAmount: number;
  tradingMode: string;
  historyResetAt: string | null;
  positions: MyPosition[];
  orders: MyOrder[];
  segmentSettings: SegmentSetting[];
  scriptSettings: ScriptSetting[];
  timestamp: number;
}

let cachedBootstrapData: BootstrapData | null = null;
let pendingFetchPromise: Promise<BootstrapData | null> | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 3000; // 3-second cache to prevent rapid duplicate calls across contexts

/**
 * Fetch consolidated user bootstrap state in a single HTTP GET request.
 * Shares in-flight promises and caches for CACHE_TTL_MS.
 */
export async function fetchUserBootstrap(force = false): Promise<BootstrapData | null> {
  const { token } = getSharedSessionSync();
  if (!token) return null;

  const now = Date.now();
  if (!force && cachedBootstrapData && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedBootstrapData;
  }

  if (pendingFetchPromise) {
    return pendingFetchPromise;
  }

  pendingFetchPromise = (async () => {
    try {
      const data = await api.get<BootstrapData>('/api/user/bootstrap');
      cachedBootstrapData = {
        ...data,
        timestamp: Date.now(),
      };
      lastFetchTime = Date.now();

      // Dispatch custom window event so active context providers can sync state immediately
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('user_bootstrap_updated', { detail: cachedBootstrapData }));
      }

      return cachedBootstrapData;
    } catch (err: any) {
      if (err?.status !== 401) {
        console.warn('[BootstrapService] Failed to fetch bootstrap data:', err);
      }
      return cachedBootstrapData; // Return last known good cache if available
    } finally {
      pendingFetchPromise = null;
    }
  })();

  return pendingFetchPromise;
}

export function getCachedBootstrapData(): BootstrapData | null {
  return cachedBootstrapData;
}

export function invalidateBootstrapCache(): void {
  cachedBootstrapData = null;
  lastFetchTime = 0;
  pendingFetchPromise = null;
}
