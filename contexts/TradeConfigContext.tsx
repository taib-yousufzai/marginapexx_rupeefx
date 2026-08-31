'use client';

/**
 * TradeConfigContext — single fetch, shared cache for:
 *   - segmentSettings  (/api/user/segments?mode=<trading_mode>)
 *   - scriptSettings   (/api/user/script-settings)
 *
 * Previously each of these was fetched independently in:
 *   TradeSheet · TradingChart · Watchlist · OptionChain · PositionsContext
 * (≈10 redundant requests on every page load)
 *
 * Improvements over v1:
 *   - Stale-after-30s TTL: prevents stale config in long-lived tabs
 *   - Frozen arrays: prevents accidental consumer mutations
 *   - Indexed lookups: O(1) getSegment / getScript / getLotSize helpers
 *   - isSegmentEnabled convenience helper
 *
 * Usage:
 *   const { segmentSettings, scriptSettings, tradingMode, loading, refresh,
 *           getSegment, getScript, getLotSize, isSegmentEnabled } = useTradeConfig();
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import { supabase } from '@/lib/supabaseClient';
import { getSharedSessionSync } from '@/lib/sharedSession';
import { api } from '@/lib/api';
import type { SegmentSetting, ScriptSetting } from '@/lib/types/tradeConfig';

// ─── Re-export types so consumers can import from one place ─────────────────
export type { SegmentSetting, ScriptSetting };

// ─── Stale TTL ───────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5_000; // 5 seconds — keep fresh so admin changes apply quickly

// ─── Context shape ───────────────────────────────────────────────────────────

export interface TradeConfigContextType {
  /** Full segment settings array for the current trading mode (frozen) */
  segmentSettings: readonly SegmentSetting[];
  /** Script-level lot size overrides — global, not per-user (frozen) */
  scriptSettings: readonly ScriptSetting[];
  /** The active trading mode ('normal' | 'scalper') */
  tradingMode: string;
  /** True while a fetch is in flight */
  loading: boolean;
  /** True once the first successful fetch has completed */
  loaded: boolean;
  /**
   * Re-fetch both endpoints (e.g. after trading-mode change).
   * Bypasses the TTL cache.
   */
  refresh: () => Promise<void>;

  // ── Indexed lookup helpers ─────────────────────────────────────────────────

  /**
   * O(1) — returns the segment setting for the given DB-segment key and side.
   * @example getSegment('INDEX-FUT', 'BUY')
   */
  getSegment: (segment: string, side: 'BUY' | 'SELL') => SegmentSetting | undefined;

  /**
   * O(1) — returns the script setting whose symbol is the longest prefix-match
   * for the given instrument name.
   * @example getScript('NIFTY24DECFUT') → { symbol: 'NIFTY', lot_size: 25 }
   */
  getScript: (instrumentName: string) => ScriptSetting | undefined;

  /**
   * Resolves lot size for an instrument name.
   * Falls back to the hardcoded defaults if no script setting matches.
   */
  getLotSize: (instrumentName: string) => number;

  /**
   * Returns true when `trade_allowed` is set for the given segment+side.
   * Defaults to true when the segment setting is missing.
   */
  isSegmentEnabled: (segment: string, side: 'BUY' | 'SELL') => boolean;
}

const TradeConfigContext = createContext<TradeConfigContextType | null>(null);

// ─── Module-level cache — survives re-mounts within the same JS module ───────

interface ConfigCache {
  segmentSettings: readonly SegmentSetting[];
  scriptSettings: readonly ScriptSetting[];
  /** Sorted descending by symbol length for getLotSize prefix-match */
  scriptSettingsSorted: readonly ScriptSetting[];
  segmentIndex: ReadonlyMap<string, SegmentSetting>;
  mode: string;
  fetchedAt: number; // Date.now() timestamp
}

let _cache: ConfigCache | null = null;

function buildCache(
  segments: SegmentSetting[],
  scripts: ScriptSetting[],
  mode: string,
): ConfigCache {
  const frozenSegments = Object.freeze(segments.map(s => Object.freeze({
    ...s,
    entry_buffer: (s.entry_buffer != null && String(s.entry_buffer).trim() !== '') ? Number(s.entry_buffer) : 0.3,
    bid_buffer: (s.bid_buffer != null && String(s.bid_buffer).trim() !== '') ? Number(s.bid_buffer) : ((s.entry_buffer != null && String(s.entry_buffer).trim() !== '') ? Number(s.entry_buffer) : 0.3),
  })));
  const frozenScripts = Object.freeze(scripts.map(s => Object.freeze({ ...s })));

  const segmentIndex = new Map<string, SegmentSetting>();
  for (const s of frozenSegments) {
    segmentIndex.set(`${s.segment.toUpperCase()}|${s.side.toUpperCase()}`, s);
  }

  const scriptsSorted = Object.freeze(
    [...frozenScripts].sort((a, b) => b.symbol.length - a.symbol.length),
  );

  return {
    segmentSettings: frozenSegments,
    scriptSettings: frozenScripts,
    scriptSettingsSorted: scriptsSorted,
    segmentIndex: Object.freeze(segmentIndex),
    mode,
    fetchedAt: Date.now(),
  };
}

// ─── Hardcoded lot-size fallbacks (last resort when no script setting matches) ─

function hardcodedLotSize(name: string): number {
  const n = name.toUpperCase();
  if (n.includes('BANKNIFTY') || n.includes('BANKEX')) return 30;
  if (n.includes('FINNIFTY')) return 60;
  if (n.includes('MIDCP') || n.includes('MIDCAP')) return 120;
  if (n.includes('SENSEX')) return 20;
  if (n.includes('NIFTY')) return 65;
  if (n.includes('GOLDM')) return 10;
  if (n.includes('GOLD')) return 100;
  if (n.includes('SILVERM')) return 5;
  if (n.includes('SILVER')) return 30;
  if (n.includes('CRUDEOILM')) return 10;
  if (n.includes('CRUDEOIL')) return 100;
  if (n.includes('NATGASMINI')) return 250;
  if (n.includes('NATURALGAS') || n.includes('NATGAS')) return 1250;
  return 1;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const TradeConfigProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [cache, setCache] = useState<ConfigCache | null>(_cache);
  const [loading, setLoading] = useState(!_cache);

  // Guard against concurrent in-flight fetches
  const fetchingRef = useRef(false);

  const fetchConfig = useCallback(async (force = false) => {
    // Serve from cache if fresh and not forced
    if (!force && _cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
      return;
    }
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);

    try {
      const { token } = getSharedSessionSync();
      if (!token) return;

      const mode = 'normal';

      const [segData, ssData] = await Promise.all([
        api.get<SegmentSetting[]>(`/api/user/segments?mode=${mode}`),
        api.get<ScriptSetting[]>('/api/user/script-settings'),
      ]);

      const built = buildCache(segData || [], ssData || [], mode);
      _cache = built;
      setCache(built);
    } catch (err) {
      console.warn('[TradeConfigProvider] failed to fetch config:', err);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  // Public refresh always bypasses the TTL
  const refresh = useCallback(() => fetchConfig(true), [fetchConfig]);

  useEffect(() => {
    if (!_cache) {
      fetchConfig();
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        fetchConfig(true);
      }
      if (event === 'SIGNED_OUT') {
        _cache = null;
        setCache(null);
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchConfig]);

  // ── Derived helpers (stable references via cache identity) ──────────────────

  const getSegment = useCallback(
    (segment: string, side: 'BUY' | 'SELL'): SegmentSetting | undefined =>
      cache?.segmentIndex.get(`${(segment || '').toUpperCase()}|${(side || '').toUpperCase()}`),
    [cache],
  );

  const getScript = useCallback(
    (instrumentName: string): ScriptSetting | undefined => {
      if (!cache) return undefined;
      const n = instrumentName.toUpperCase();
      return cache.scriptSettingsSorted.find(s => n.includes(s.symbol.toUpperCase()));
    },
    [cache],
  );

  const getLotSize = useCallback(
    (instrumentName: string): number => {
      const script = getScript(instrumentName);
      return script ? Number(script.lot_size) : hardcodedLotSize(instrumentName);
    },
    [getScript],
  );

  const isSegmentEnabled = useCallback(
    (segment: string, side: 'BUY' | 'SELL'): boolean => {
      const s = getSegment(segment, side);
      return s ? s.trade_allowed : true; // default open when not configured
    },
    [getSegment],
  );

  const contextValue: TradeConfigContextType = {
    segmentSettings: cache?.segmentSettings ?? [],
    scriptSettings: cache?.scriptSettings ?? [],
    tradingMode: cache?.mode ?? 'normal',
    loading,
    loaded: !!cache,
    refresh,
    getSegment,
    getScript,
    getLotSize,
    isSegmentEnabled,
  };

  return (
    <TradeConfigContext.Provider value={contextValue}>
      {children}
    </TradeConfigContext.Provider>
  );
};

// ─── Hook ────────────────────────────────────────────────────────────────────

export const useTradeConfig = (): TradeConfigContextType => {
  const ctx = useContext(TradeConfigContext);
  if (!ctx) {
    throw new Error('useTradeConfig must be used within a TradeConfigProvider');
  }
  return ctx;
};
