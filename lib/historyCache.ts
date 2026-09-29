/**
 * Shared in-memory and persistent storage helper for history items.
 * Ensures 0ms instant display of closed positions and orders across the app.
 */

export interface HistoryItem {
  id: string;
  scriptName: string;
  type: 'BUY' | 'SELL';
  orderType: string;
  qty: number;
  price: number;
  entryPrice?: number;
  exitPrice?: number;
  pnl: number;
  date: string;
  exitDate?: string;
  status: string;
  brokerage: number;
  intraday_brokerage?: number;
  carry_brokerage?: number;
  gtt_brokerage?: number;
  entry_intraday_brokerage?: number;
  entry_carry_brokerage?: number;
  entry_gtt_brokerage?: number;
  exit_intraday_brokerage?: number;
  exit_carry_brokerage?: number;
  exit_gtt_brokerage?: number;
  closedBy?: string;
  settlement?: string;
  settlementAmount?: number;
  productType?: string;
  timestamp: number;
  trades_count?: number;
}

const HISTORY_STORAGE_KEY = 'history_cache_v2';

export function getClientHistoryCache(): HistoryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    if (Array.isArray((window as any).__historyCache) && (window as any).__historyCache.length > 0) {
      return (window as any).__historyCache;
    }
    const sessionStored = sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (sessionStored) {
      const parsed = JSON.parse(sessionStored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        (window as any).__historyCache = parsed;
        return parsed;
      }
    }
    const localStored = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (localStored) {
      const parsed = JSON.parse(localStored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        (window as any).__historyCache = parsed;
        return parsed;
      }
    }
  } catch (_) {}
  return [];
}

export function saveClientHistoryCache(items: HistoryItem[]) {
  if (typeof window === 'undefined') return;
  try {
    const capped = items.length > 500 ? items.slice(0, 500) : items;
    (window as any).__historyCache = capped;
    const str = JSON.stringify(capped);
    sessionStorage.setItem(HISTORY_STORAGE_KEY, str);
    localStorage.setItem(HISTORY_STORAGE_KEY, str);
  } catch (_) {}
}

export function prependToClientHistoryCache(newItems: HistoryItem | HistoryItem[]): HistoryItem[] {
  if (typeof window === 'undefined') return [];
  const incoming = Array.isArray(newItems) ? newItems : [newItems];
  if (incoming.length === 0) return getClientHistoryCache();

  const current = getClientHistoryCache();
  const incomingIds = new Set(incoming.map(i => i.id));
  const merged = [...incoming, ...current.filter(i => !incomingIds.has(i.id))];
  
  // Sort newest first by timestamp
  merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const capped = merged.length > 500 ? merged.slice(0, 500) : merged;
  saveClientHistoryCache(capped);
  return capped;
}

export function removeFromClientHistoryCache(ids: string[]): HistoryItem[] {
  if (typeof window === 'undefined') return [];
  const idSet = new Set(ids);
  const current = getClientHistoryCache();
  const filtered = current.filter(i => !idSet.has(i.id));
  saveClientHistoryCache(filtered);
  return filtered;
}
