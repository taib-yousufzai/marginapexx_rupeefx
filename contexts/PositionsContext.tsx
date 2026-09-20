'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { api } from '@/lib/api';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';
import { useBinanceQuotes } from '@/hooks/useBinanceQuotes';
import { MyPosition } from '@/lib/types/order';
import { useTradeConfig } from '@/contexts/TradeConfigContext';
import { mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';
import { getSharedSession, getSharedSessionSync } from '@/lib/sharedSession';
import { isContractExpired } from '@/lib/contractExpiry';

export interface EnrichedPosition extends MyPosition {
  current_ltp: number;
  unrealised_pnl: number;
  total_pnl: number;
  pnl_percent: number;
  hold_lock_active: boolean;
  remaining_hold_seconds: number;
  required_hold_seconds: number;
  is_closing?: boolean;
}

export interface PositionsContextType {
  positions: EnrichedPosition[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updatePositionLocally: (posId: string, updatedFields: Partial<MyPosition>) => void;
  removePositionLocally: (posId: string) => void;
  restorePositionLocally: (posId: string) => void;
  startConversion: (posId: string, newType: string) => void;
  endConversion: (posId: string) => void;
  addOptimisticPosition: (pos: Partial<MyPosition>) => void;
  removeOptimisticPosition: (optIdOrTempId: string) => void;
}

const PositionsContext = createContext<PositionsContextType | null>(null);

export const cleanSym = (s?: string | null): string => {
  if (!s) return '';
  let str = s.replace(/^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)/i, '')
             .replace(/[\/\s\_\-]/g, '')
             .replace(/(PERP|\.P|FUT)$/i, '')
             .toUpperCase();
  if (['XAUUSD', 'COMEX:XAUUSD', 'GC=F', 'GC', 'GOLD'].includes(str)) return 'XAUUSD';
  if (['XAGUSD', 'COMEX:XAGUSD', 'SI=F', 'SI', 'SILVER'].includes(str)) return 'XAGUSD';
  if (['XTIUSD', 'COMEX:XTIUSD', 'CL=F', 'CL', 'WTI', 'CRUDE', 'CRUDEOIL'].includes(str)) return 'XTIUSD';
  if (['XCUUSD', 'COMEX:XCUUSD', 'HG=F', 'HG', 'COPPER'].includes(str)) return 'XCUUSD';
  if (['XNGUSD', 'COMEX:XNGUSD', 'NG=F', 'NG', 'NATGAS', 'NATURALGAS'].includes(str)) return 'XNGUSD';
  if (str === 'DODGE' || str === 'DODGEUSDT') return 'DOGEUSDT';
  const nonCrypto = ['GBPUSD', 'EURUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USDCHF', 'XAUUSD', 'XAGUSD', 'XTIUSD', 'XNGUSD', 'XCUUSD', 'GOLD', 'SILVER', 'COPPER', 'CRUDE', 'NATGAS'];
  const knownBaseCrypto = ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC', 'LINK', 'UNI', 'BCH', 'SHIB', 'PEPE', 'TRX', 'NEAR', 'SUI', 'APT', 'FET', 'RNDR', 'INJ', 'TIA', 'OP', 'ARB'];
  if (knownBaseCrypto.includes(str)) {
    str += 'USDT';
  } else if (str.endsWith('USD') && !str.endsWith('USDT') && !nonCrypto.includes(str)) {
    str = str.slice(0, -3) + 'USDT';
  }
  return str;
};



const mapSegmentToDbSegment = (s: string): string => {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed === 'NSE - Futures' || trimmed === 'BSE - Futures') return 'INDEX-FUT';
  if (trimmed === 'NSE - Options' || trimmed === 'BSE - Options') return 'INDEX-OPT';
  if (trimmed === 'NSE - Stock Futures' || trimmed === 'BSE - Stock Futures') return 'STOCK-FUT';
  if (trimmed === 'NSE - Stock Options' || trimmed === 'BSE - Stock Options') return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures') return 'MCX-FUT';
  if (trimmed === 'MCX - Options') return 'MCX-OPT';
  if (trimmed === 'NSE - Equity' || trimmed === 'BSE - Equity') return 'STOCKS';
  if (trimmed === 'Crypto' || trimmed === 'CRYPTO') return 'CRYPTO';
  if (trimmed === 'Forex' || trimmed === 'FOREX' || trimmed === 'CDS - Futures' || trimmed === 'CDS - Options') return 'FOREX';
  if (trimmed === 'COMEX - Futures' || trimmed === 'COMEX - Options' || trimmed === 'COMEX' || trimmed === 'COI') return 'COMEX';
  if (trimmed === 'US - Equity' || trimmed === 'US-EQ' || trimmed === 'US Equity' || trimmed === 'US') return 'US-EQ';
  return trimmed;
};

export const resolveComexSymbol = (sym?: string | null): string => {
  if (!sym) return '';
  const upper = sym.toUpperCase().replace(/[\/\s\_]/g, '');
  if (upper === 'XAUUSD' || upper === 'GC=F' || upper === 'GC') return 'XAUUSD';
  if (upper === 'XAGUSD' || upper === 'SI=F' || upper === 'SI') return 'XAGUSD';
  if (upper === 'XTIUSD' || upper === 'CL=F' || upper === 'CL' || upper === 'WTI') return 'XTIUSD';
  if (upper === 'XCUUSD' || upper === 'HG=F' || upper === 'HG') return 'XCUUSD';
  if (upper === 'XNGUSD' || upper === 'NG=F' || upper === 'NG') return 'XNGUSD';
  return sym;
};

const resolveKitePrefix = (key: string, settlement: string) => {
  if (!key) return '';
  if (key.startsWith('US:')) return key;
  let baseKey = key;
  if (baseKey.includes(':')) {
    baseKey = baseKey.split(':').slice(1).join(':'); // Strip existing prefix
  }
  const seg = (settlement || '').toUpperCase();
  if (seg.includes('US')) return `US:${baseKey}`;
  let prefix = 'NSE:';
  const cleanUpper = baseKey.toUpperCase().replace(/[\/\s\_]/g, '');
  if (cleanUpper.startsWith('SENSEX') || cleanUpper.startsWith('BANKEX')) {
    prefix = 'BFO:';
  } else if (
    seg.includes('MCX') ||
    seg.includes('NCO') ||
    ['CRUDE', 'CRUDEOIL', 'NATGAS', 'NATURALGAS', 'SILVER', 'GOLD', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'MENTHAOIL', 'NICKEL'].some(c => cleanUpper.startsWith(c))
  ) {
    prefix = (seg === 'NCO' || seg === 'NCO-OPT') ? 'NCO:' : 'MCX:';
  } else if (
    seg.includes('CDS') ||
    seg.includes('FOREX') ||
    cleanUpper.startsWith('USDINR') ||
    cleanUpper.startsWith('EURINR') ||
    cleanUpper.startsWith('GBPINR') ||
    cleanUpper.startsWith('JPYINR')
  ) {
    prefix = 'CDS:';
  } else if (seg.includes('BSE') || seg.includes('BFO')) {
    prefix = 'BFO:';
  } else if (seg.includes('OPT') || seg.includes('FUT') || seg.includes('NFO')) {
    prefix = 'NFO:';
  }

  // Catch base indexes
  if (prefix === 'BFO:' && !baseKey.match(/\d/)) prefix = 'BSE:';
  if (prefix === 'NFO:' && !baseKey.match(/\d/)) prefix = 'NSE:';

  return `${prefix}${baseKey}`;
};

const POSITIONS_PERSIST_KEY = 'marginApex_open_positions_persisted';
const OPTIMISTIC_POSITIONS_PERSIST_KEY = 'marginApex_optimistic_positions_persisted';
const OPTIMISTIC_REMOVALS_PERSIST_KEY = 'marginApex_optimistic_removals_persisted';

function getPersistedOptimisticPositions(): MyPosition[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OPTIMISTIC_POSITIONS_PERSIST_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.filter((p: any) => {
      const createdTime = p.created_time_ms || (p.entry_time ? new Date(p.entry_time).getTime() : 0);
      return createdTime > 0 && (now - createdTime < 20000);
    });
  } catch {
    return [];
  }
}

function savePersistedOptimisticPositions(positions: MyPosition[]) {
  if (typeof window === 'undefined') return;
  try {
    const optList = positions.filter(p => p.id.startsWith('__optimistic__'));
    if (optList.length === 0) {
      localStorage.removeItem(OPTIMISTIC_POSITIONS_PERSIST_KEY);
    } else {
      localStorage.setItem(OPTIMISTIC_POSITIONS_PERSIST_KEY, JSON.stringify(optList));
    }
  } catch {}
}

function getPersistedOptimisticRemovals(): Map<string, number> {
  const map = new Map<string, number>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = localStorage.getItem(OPTIMISTIC_REMOVALS_PERSIST_KEY);
    if (!raw) return map;
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [id, ts] of Object.entries(obj)) {
      const timeMs = Number(ts);
      if (now - timeMs < 25000) {
        map.set(id, timeMs);
      }
    }
  } catch {}
  return map;
}

function savePersistedOptimisticRemovals(removals: Map<string, number>) {
  if (typeof window === 'undefined') return;
  try {
    if (removals.size === 0) {
      localStorage.removeItem(OPTIMISTIC_REMOVALS_PERSIST_KEY);
    } else {
      const obj: Record<string, number> = {};
      for (const [id, ts] of removals.entries()) {
        obj[id] = ts;
      }
      localStorage.setItem(OPTIMISTIC_REMOVALS_PERSIST_KEY, JSON.stringify(obj));
    }
  } catch {}
}

const NON_CRYPTO_USD_SYMBOLS = ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD', 'XPTUSD', 'XPDUSD', 'GBPUSD', 'EURUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USDCHF'];

export const PositionsDataProvider = ({ children, refreshInterval = 5000 }: { children: React.ReactNode; refreshInterval?: number }) => {
  const [rawPositions, setRawPositions] = useState<MyPosition[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(POSITIONS_PERSIST_KEY);
        const optPositions = getPersistedOptimisticPositions();
        const removals = getPersistedOptimisticRemovals();
        let list: MyPosition[] = [];
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) list = parsed;
        }
        list = list.filter(p => !removals.has(p.id));
        return [...optPositions, ...list];
      } catch {}
    }
    return [];
  });
  const [loading, setLoading] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(POSITIONS_PERSIST_KEY);
        const optPositions = getPersistedOptimisticPositions();
        if (stored || optPositions.length > 0) return false;
      } catch {}
    }
    return true;
  });
  const [error, setError] = useState<string | null>(null);
  const [inFlightConversions, setInFlightConversions] = useState<Record<string, string>>({});
  // segmentSettings now comes from TradeConfigProvider — no local fetch needed
  const { segmentSettings } = useTradeConfig();
  const optimisticallyRemovedTimes = useRef<Map<string, number>>(getPersistedOptimisticRemovals());
  const optimisticallyRemovedIds = useRef<Set<string>>(new Set(optimisticallyRemovedTimes.current.keys()));
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  // Tracks IDs of positions that were added optimistically (not yet confirmed by DB)
  const optimisticPositionIds = useRef<Set<string>>(new Set(getPersistedOptimisticPositions().map(p => p.id)));
  const lastOptimisticAddRef = useRef<{ signature: string; time: number }>({ signature: '', time: 0 });
  const processedOptIdsRef = useRef<Set<string>>(new Set());

  // Static properties map to cache computations that never change per position lifecycle
  const staticPositionPropsRef = useRef<Record<string, { entryTimeMs: number; dbSeg: string; resolvedKiteSymbol: string; isCrypto: boolean; isComex: boolean; binanceSymbol: string }>>({}); 

  const updatePositionLocally = useCallback((posId: string, updatedFields: Partial<MyPosition>) => {
    setRawPositions(prev =>
      prev.map(p => (p.id === posId ? { ...p, ...updatedFields } : p))
    );
  }, []);

  const removePositionLocally = useCallback((posId: string) => {
    optimisticallyRemovedIds.current.add(posId);
    optimisticallyRemovedTimes.current.set(posId, Date.now());
    savePersistedOptimisticRemovals(optimisticallyRemovedTimes.current);
    setRawPositions(prev => {
      const next = prev.filter(p => p.id !== posId);
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(POSITIONS_PERSIST_KEY, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  }, []);

  const addOptimisticPosition = useCallback((partialPos: Partial<MyPosition> & { opt_id?: string }) => {
    const tempId = partialPos.opt_id || (partialPos.id ? partialPos.id : `__optimistic__${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const now = Date.now();
    const cleanSymbol = (partialPos.symbol || '').trim();
    if (!cleanSymbol) return;

    const newPos: MyPosition = {
      id: tempId,
      user_id: '',
      symbol: cleanSymbol,
      kite_instrument: partialPos.kite_instrument || cleanSymbol,
      settlement: partialPos.settlement || '',
      side: (partialPos.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
      qty_open: Number(partialPos.qty_open || partialPos.qty_total || 1),
      qty_total: Number(partialPos.qty_total || partialPos.qty_open || 1),
      entry_price: Number(partialPos.entry_price || partialPos.avg_price || partialPos.ltp || 0),
      avg_price: Number(partialPos.avg_price || partialPos.entry_price || partialPos.ltp || 0),
      ltp: Number(partialPos.ltp || partialPos.entry_price || 0),
      product_type: (partialPos.product_type || 'INTRADAY') as any,
      status: 'open',
      created_at: new Date(now).toISOString(),
      entry_time: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      created_time_ms: now,
      brokerage: 0,
      pnl: 0,
      locked_margin: (partialPos as any).locked_margin || 0,
    } as any;

    optimisticPositionIds.current.add(tempId);

    setRawPositions(prev => {
      if (prev.some(p => p.id === tempId)) return prev;
      const next = [newPos, ...prev];
      if (typeof window !== 'undefined') {
        savePersistedOptimisticPositions(next);
      }
      return next;
    });
  }, []);

  const removeOptimisticPosition = useCallback((optIdOrTempId: string) => {
    optimisticPositionIds.current.delete(optIdOrTempId);
    setRawPositions(prev => {
      const next = prev.filter(p => p.id !== optIdOrTempId);
      if (typeof window !== 'undefined') {
        savePersistedOptimisticPositions(next);
      }
      return next;
    });
  }, []);

  const startConversion = useCallback((posId: string, newType: string) => {
    setInFlightConversions(prev => ({ ...prev, [posId]: newType }));
  }, []);

  const endConversion = useCallback((posId: string) => {
    setInFlightConversions(prev => {
      const next = { ...prev };
      delete next[posId];
      return next;
    });
  }, []);

  const fetchPositions = useCallback(async (options?: { fresh?: boolean }) => {
    try {
      // Ensure we have an active session token before fetching
      let { token } = getSharedSessionSync();
      if (!token) {
        const session = await getSharedSession();
        token = session?.token || null;
      }
      if (!token) return;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const queryUrl = options?.fresh ? `/api/positions?_t=${Date.now()}` : '/api/positions';
      const data = await api.get<{ positions: MyPosition[] }>(queryUrl, {
        signal: controller.signal,
      });

      const rawPositionsFromServer: MyPosition[] = data.positions || [];

      // Clean up optimisticallyRemovedIds strictly based on 30s TTL
      const now = Date.now();
      for (const id of Array.from(optimisticallyRemovedIds.current)) {
        const removedAt = optimisticallyRemovedTimes.current.get(id) || 0;
        if (now - removedAt > 30000) {
          optimisticallyRemovedIds.current.delete(id);
          optimisticallyRemovedTimes.current.delete(id);
        }
      }

      // Filter out any IDs that are in optimistic removal in the last 30s
      let basePositions: MyPosition[] = rawPositionsFromServer.filter(
        p => !optimisticallyRemovedIds.current.has(p.id)
      );

      // Reconcile optimistic positions with server response
      const persistedOpt = getPersistedOptimisticPositions();

      setRawPositions(prev => {
        const existingOptMap = new Map<string, MyPosition>();
        [...persistedOpt, ...prev.filter(p => p.id.startsWith('__optimistic__') || p.id.startsWith('opt_'))].forEach(p => {
          existingOptMap.set(p.id, p);
        });

        const activeOptPositions: MyPosition[] = [];
        for (const [optId, optPos] of existingOptMap.entries()) {
          const createdTime = (optPos as any).created_time_ms || (optPos.entry_time ? new Date(optPos.entry_time).getTime() : 0);
          if (now - createdTime > 20000) {
            optimisticPositionIds.current.delete(optId);
            continue;
          }
          // Check if server already has a matching position for this symbol & side
          const hasMatchingServerPos = basePositions.some(sp => {
            const sameSym = cleanSym(sp.symbol || sp.kite_instrument) === cleanSym(optPos.symbol || optPos.kite_instrument);
            const sameSide = (sp.side || '').toUpperCase() === (optPos.side || '').toUpperCase();
            const spTime = new Date(sp.entry_time || (sp as any).created_at || 0).getTime();
            return sameSym && sameSide && (spTime >= createdTime - 5000);
          });

          if (hasMatchingServerPos) {
            optimisticPositionIds.current.delete(optId);
          } else {
            activeOptPositions.push(optPos);
          }
        }

        const merged = [...activeOptPositions, ...basePositions];

        // Precompute static properties for any newly loaded positions
        const staticProps = staticPositionPropsRef.current;
        merged.forEach(p => {
          if (!staticProps[p.id]) {
            const dbSeg = mapSegmentWithSymbol(p.settlement || '', p.symbol);
            const segUpper = dbSeg.toUpperCase();
            const cleanSymUpper = (p.symbol || '').replace(/^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
            const isComex = (p as any).preferredView === 'comex' || segUpper.includes('COMEX') || (p.symbol && (p.symbol.endsWith('=F') || NON_CRYPTO_USD_SYMBOLS.slice(0, 7).some(c => cleanSymUpper.includes(c))));
            const isCrypto = !isComex && (segUpper.includes('CRYPTO') || (p.symbol && (p.symbol.endsWith('USDT') || (p.symbol.endsWith('USD') && !NON_CRYPTO_USD_SYMBOLS.includes(cleanSymUpper)))));

            let binanceSymbol = '';
            if (isCrypto) {
              binanceSymbol = (p.symbol || '').replace(/^(CRYPTO:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
              if (binanceSymbol === 'DODGE' || binanceSymbol === 'DODGEUSDT') {
                binanceSymbol = 'DOGEUSDT';
              } else if (binanceSymbol.endsWith('USD') && !binanceSymbol.endsWith('USDT')) {
                binanceSymbol = binanceSymbol.slice(0, -3) + 'USDT';
              } else if (!binanceSymbol.endsWith('USDT')) {
                binanceSymbol += 'USDT';
              }
            }

            staticProps[p.id] = {
              entryTimeMs: new Date(p.entry_time).getTime(),
              dbSeg,
              resolvedKiteSymbol: resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || ''),
              isCrypto: Boolean(isCrypto),
              isComex: Boolean(isComex),
              binanceSymbol
            };
          }
        });

        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem(POSITIONS_PERSIST_KEY, JSON.stringify(merged.filter(p => !p.id.startsWith('__optimistic__') && !p.id.startsWith('opt_'))));
            savePersistedOptimisticPositions(merged);
          } catch {}
        }

        return merged;
      });
    } catch (err: any) {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (!err?.message?.includes('aborted')) {
        console.warn('[PositionsContext] Transient error fetching positions:', err);
      }
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const restorePositionLocally = useCallback((posId?: string) => {
    if (posId) {
      optimisticallyRemovedIds.current.delete(posId);
      optimisticallyRemovedTimes.current.delete(posId);
    } else {
      optimisticallyRemovedIds.current.clear();
      optimisticallyRemovedTimes.current.clear();
    }
    savePersistedOptimisticRemovals(optimisticallyRemovedTimes.current);
    fetchPositions({ fresh: true });
  }, [fetchPositions]);

  useEffect(() => {
    // One-shot eviction: clear the legacy localStorage cache written by the old code.
    try { localStorage.removeItem('cached_open_positions'); } catch (_) {}

    fetchPositions();
    let isSubscribed = false;
    const channelName = `my-positions-realtime-${Math.random().toString(36).slice(2)}`;

    const debouncedFetch = (delay = 300, fresh = true) => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      fetchDebounceRef.current = setTimeout(() => {
        fetchPositions({ fresh });
      }, delay);
    };

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => {
          debouncedFetch(200, true);
        }
      );

    channel.subscribe((status) => {
      isSubscribed = status === 'SUBSCRIBED';
    });

    const handleOrderPlacedWithData = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        if (detail.is_exit) {
          const exitQty = Number(detail.qty || detail.qty_open || 0);
          const targetClean = cleanSym(detail.symbol || (detail as any).kite_instrument || '');
          const now = Date.now();

          setRawPositions(prev => {
            const matchingPositions = prev.filter(p => {
              if (detail.linked_position_id && p.id === detail.linked_position_id) return true;
              if (targetClean && cleanSym(p.symbol || p.kite_instrument || '') === targetClean) return true;
              return false;
            });

            if (matchingPositions.length === 0) return prev;

            const totalQty = matchingPositions.reduce((sum, p) => sum + (p.qty_open || 0), 0);

            if (!exitQty || exitQty >= totalQty) {
              matchingPositions.forEach(p => {
                optimisticallyRemovedIds.current.add(p.id);
                optimisticallyRemovedTimes.current.set(p.id, now);
              });
              savePersistedOptimisticRemovals(optimisticallyRemovedTimes.current);
              const removeIds = new Set(matchingPositions.map(p => p.id));
              const next = prev.filter(p => !removeIds.has(p.id));
              if (typeof window !== 'undefined') {
                try {
                  localStorage.setItem(POSITIONS_PERSIST_KEY, JSON.stringify(next.filter(p => !p.id.startsWith('__optimistic__') && !p.id.startsWith('opt_'))));
                  savePersistedOptimisticPositions(next);
                } catch {}
              }
              return next;
            } else {
              let remExit = exitQty;
              const sortedMatching = [...matchingPositions].sort((a, b) => {
                if (detail.linked_position_id) {
                  if (a.id === detail.linked_position_id) return -1;
                  if (b.id === detail.linked_position_id) return 1;
                }
                return 0;
              });

              const updatedMap = new Map<string, number | null>();
              for (const p of sortedMatching) {
                if (remExit <= 0) break;
                const curQty = p.qty_open || 0;
                if (curQty <= remExit) {
                  remExit -= curQty;
                  optimisticallyRemovedIds.current.add(p.id);
                  optimisticallyRemovedTimes.current.set(p.id, now);
                  updatedMap.set(p.id, null);
                } else {
                  const newQ = curQty - remExit;
                  remExit = 0;
                  updatedMap.set(p.id, newQ);
                }
              }
              savePersistedOptimisticRemovals(optimisticallyRemovedTimes.current);

              const next = prev.map(p => {
                if (updatedMap.has(p.id)) {
                  const newQ = updatedMap.get(p.id);
                  if (newQ === null) return null;
                  return { ...p, qty_open: newQ };
                }
                return p;
              }).filter((p): p is MyPosition => p !== null);
              if (typeof window !== 'undefined') {
                try {
                  localStorage.setItem(POSITIONS_PERSIST_KEY, JSON.stringify(next.filter(p => !p.id.startsWith('__optimistic__') && !p.id.startsWith('opt_'))));
                  savePersistedOptimisticPositions(next);
                } catch {}
              }
              return next;
            }
          });
        } else if (!detail.is_exit) {
          addOptimisticPosition(detail);
        }
      }
      // Immediate fetch with fresh cache buster
      fetchPositions({ fresh: true });
      // Follow-up fetch in 800ms
      debouncedFetch(800, true);
    };

    const handleOrderPlaced = () => {
      fetchPositions({ fresh: true });
      debouncedFetch(800, true);
    };

    const handleOrderFailed = () => {
      optimisticallyRemovedIds.current.clear();
      optimisticallyRemovedTimes.current.clear();
      savePersistedOptimisticRemovals(optimisticallyRemovedTimes.current);
      fetchPositions({ fresh: true });
    };

    const handlePositionClosedOptimistic = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const positions = detail?.positions || (detail?.position ? [detail.position] : []);
      const now = Date.now();
      positions.forEach((p: any) => {
        if (p?.id) {
          optimisticallyRemovedIds.current.add(p.id);
          optimisticallyRemovedTimes.current.set(p.id, now);
        }
      });
      savePersistedOptimisticRemovals(optimisticallyRemovedTimes.current);
      setRawPositions(prev => {
        const closedIdSet = new Set(positions.map((p: any) => p?.id).filter(Boolean));
        const next = prev.filter(p => !closedIdSet.has(p.id));
        savePersistedOptimisticPositions(next);
        return next;
      });
    };
    
    window.addEventListener('order_placed', handleOrderPlaced);
    window.addEventListener('order_placed_with_data', handleOrderPlacedWithData);
    window.addEventListener('position_closed_optimistic', handlePositionClosedOptimistic);
    window.addEventListener('order_failed', handleOrderFailed);
    window.addEventListener('position-closed', handleOrderPlaced);
    window.addEventListener('position_closed', handleOrderPlaced);
    window.addEventListener('position_updated', handleOrderPlaced);
    window.addEventListener('order_executed', handleOrderPlaced);

    // Responsive 5s polling fallback for open positions
    const pollTime = refreshInterval || 5000;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchPositions();
      }
    }, pollTime);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchPositions({ fresh: true });
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        fetchPositions({ fresh: true });
      }
    });

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
      supabase.removeChannel(channel);
      authSub.unsubscribe();
      window.removeEventListener('order_placed', handleOrderPlaced);
      window.removeEventListener('order_placed_with_data', handleOrderPlacedWithData);
      window.removeEventListener('position_closed_optimistic', handlePositionClosedOptimistic);
      window.removeEventListener('order_failed', handleOrderFailed);
      window.removeEventListener('position-closed', handleOrderPlaced);
      window.removeEventListener('position_closed', handleOrderPlaced);
      window.removeEventListener('position_updated', handleOrderPlaced);
      window.removeEventListener('order_executed', handleOrderPlaced);
    };
  }, [fetchPositions, refreshInterval, addOptimisticPosition]);

  const { kiteKeys, binanceKeys, comexKeys } = useMemo(() => {
    const kite: string[] = [];
    const binance: string[] = [];
    const comex: string[] = [];
    const props = staticPositionPropsRef.current;

    rawPositions.filter(p => !p.status || p.status === 'open' || p.status === 'active' || p.status.toLowerCase() === 'open' || p.status.toLowerCase() === 'active').forEach(p => {
      const cached = props[p.id];
      const dbSeg = cached ? cached.dbSeg : mapSegmentWithSymbol(p.settlement || '', p.symbol);
      const segUpper = dbSeg.toUpperCase();
      const cleanSymUpper = (p.symbol || '').replace(/^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
      const isComex = cached ? cached.isComex : ((p as any).preferredView === 'comex' || segUpper.includes('COMEX') || (p.symbol && (p.symbol.endsWith('=F') || NON_CRYPTO_USD_SYMBOLS.slice(0, 7).some(c => cleanSymUpper.includes(c)))));
      const isCrypto = cached ? cached.isCrypto : (!isComex && (segUpper.includes('CRYPTO') || (p.symbol && (p.symbol.endsWith('USDT') || (p.symbol.endsWith('USD') && !NON_CRYPTO_USD_SYMBOLS.includes(cleanSymUpper))))));

      if (isCrypto) {
        let sym = cached ? cached.binanceSymbol : (p.symbol || '').replace('/', '').toUpperCase();
        if (!sym.endsWith('USDT')) sym += 'USDT';
        binance.push(sym);
      } else if (isComex) {
        const comexSym = resolveComexSymbol(p.symbol);
        comex.push(comexSym);
        if (p.symbol && p.symbol !== comexSym) comex.push(p.symbol);
      } else {
        const resolvedKite = cached ? cached.resolvedKiteSymbol : resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || '');
        kite.push(resolvedKite);
        if (p.symbol && p.symbol !== resolvedKite) kite.push(p.symbol);
        const cleanUnspaced = (p.symbol || '').replace(/\s+/g, '').toUpperCase();
        if (cleanUnspaced && !kite.includes(cleanUnspaced)) kite.push(cleanUnspaced);
      }
    });

    return { kiteKeys: kite, binanceKeys: binance, comexKeys: comex };
  }, [rawPositions]);

  const marketSymbols = useMemo(() => [...kiteKeys, ...binanceKeys], [kiteKeys, binanceKeys]);
  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);
  const { quotes: comexQuotes } = useComexQuotes(comexKeys, refreshInterval);
  const { quotes: binanceQuotes } = useBinanceQuotes(binanceKeys);

  const enrichedPositions = useMemo(() => {
    const settingsMap = new Map<string, any>();
    for (const s of segmentSettings) {
      settingsMap.set(`${(s.segment || '').toUpperCase()}|${(s.side || '').toUpperCase()}`, s);
    }

    const props = staticPositionPropsRef.current;

    return rawPositions.map(p => {
      const product_type = inFlightConversions[p.id] || p.product_type;
      let ltp = p.ltp || p.entry_price;
      let bid = ltp;
      let ask = ltp;

      const cached = props[p.id];
      const dbSeg = cached ? cached.dbSeg : mapSegmentWithSymbol(p.settlement || '', p.symbol);
      const segUpper = dbSeg.toUpperCase();
      const cleanSymUpper = (p.symbol || '').replace(/^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
      const isComex = cached ? cached.isComex : ((p as any).preferredView === 'comex' || segUpper.includes('COMEX') || (p.symbol && (p.symbol.endsWith('=F') || NON_CRYPTO_USD_SYMBOLS.slice(0, 7).some(c => cleanSymUpper.includes(c)))));
      const isCrypto = cached ? cached.isCrypto : (!isComex && (segUpper.includes('CRYPTO') || (p.symbol && (p.symbol.endsWith('USDT') || (p.symbol.endsWith('USD') && !NON_CRYPTO_USD_SYMBOLS.includes(cleanSymUpper))))));
      const entryTimeMs = cached ? cached.entryTimeMs : new Date(p.entry_time).getTime();

      const avgPrice = p.avg_price || p.entry_price;
      const contractExpired = isContractExpired(p.kite_instrument || p.symbol);

      let rawQuote: any = null;
      if (!contractExpired) {
        if (isCrypto) {
          const binanceKey = cached ? cached.binanceSymbol : (p.symbol || '').replace('/', '').toUpperCase() + (p.symbol?.endsWith('USDT') ? '' : 'USDT');
          const shortSymbol = (p.symbol || '').replace('/', '').replace('USDT', '').toUpperCase();
          const quote = marketQuotes[binanceKey] || marketQuotes[shortSymbol] || marketQuotes[p.symbol] || marketQuotes[`CRYPTO:${shortSymbol}`] || binanceQuotes[binanceKey] || binanceQuotes[shortSymbol];
          if (quote) {
            rawQuote = quote;
            ltp = quote.lastPrice ?? ltp;
            bid = (quote as any).bid ?? ltp;
            ask = (quote as any).ask ?? ltp;
          }
        } else if (isComex) {
          const comexSym = resolveComexSymbol(p.symbol);
          const quote = comexQuotes[comexSym] || comexQuotes[p.symbol] || marketQuotes[comexSym] || marketQuotes[p.symbol];
          if (quote) {
            rawQuote = quote;
            ltp = quote.lastPrice ?? ltp;
            bid = quote.bid ?? ltp;
            ask = quote.ask ?? ltp;
          }
        } else {
          const kiteKey = cached ? cached.resolvedKiteSymbol : resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || '');
          const rawSymbol = p.kite_instrument || p.symbol || '';
          const symbolWithoutPrefix = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;
          const cleanUnspaced = symbolWithoutPrefix.replace(/\s+/g, '').toUpperCase();
          const rawUnspaced = rawSymbol.replace(/\s+/g, '').toUpperCase();
          const quote = marketQuotes[kiteKey] ||
                        marketQuotes[`MCX:${cleanUnspaced}`] ||
                        marketQuotes[`MCX:${symbolWithoutPrefix}`] ||
                        marketQuotes[`NCO:${cleanUnspaced}`] ||
                        marketQuotes[`NCO:${symbolWithoutPrefix}`] ||
                        marketQuotes[`NFO:${cleanUnspaced}`] ||
                        marketQuotes[`NSE:${cleanUnspaced}`] ||
                        marketQuotes[rawSymbol] ||
                        marketQuotes[symbolWithoutPrefix] ||
                        marketQuotes[cleanUnspaced] ||
                        marketQuotes[rawUnspaced];
          if (quote) {
            rawQuote = quote;
            ltp = quote.lastPrice ?? ltp;
            bid = (quote.bid && quote.bid > 0) ? quote.bid : ltp;
            ask = (quote.ask && quote.ask > 0) ? quote.ask : ltp;
          }
        }
      }

      // Use pos.settlement / dbSeg for segment settings lookup
      const settingsKey = `${(p.settlement || dbSeg || '').toUpperCase()}|${(p.side || '').toUpperCase()}`;
      const sideSetting = settingsMap.get(settingsKey);
      
      let unrealised = 0;
      if ((p.status === 'open' || p.status === 'active') && p.qty_open !== 0) {
        if (p.side === 'BUY') {
          unrealised = (ltp - avgPrice) * p.qty_open;
        } else {
          unrealised = (avgPrice - ltp) * p.qty_open;
        }
      }

      const total_pnl = (p.status === 'closed') ? p.pnl : unrealised;
      const investment = avgPrice * p.qty_open; 
      const pnl_percent = investment > 0 ? (total_pnl / investment) * 100 : 0;

      const profitHoldSec = sideSetting?.profit_hold_sec != null ? Number(sideSetting.profit_hold_sec) : 0;
      const lossHoldSec = sideSetting?.loss_hold_sec != null ? Number(sideSetting.loss_hold_sec) : 0;
      const elapsedSec = Math.floor((Date.now() - entryTimeMs) / 1000);

      const isInProfit = unrealised > 0;
      const requiredHoldSec = isInProfit ? profitHoldSec : lossHoldSec;
      const isLocked = !contractExpired
        && (p.status === 'open' || p.status === 'active')
        && requiredHoldSec > 0
        && elapsedSec < requiredHoldSec;
      const remainingSec = isLocked ? (requiredHoldSec - elapsedSec) : 0;

      return {
        ...p,
        product_type,
        current_ltp: ltp,
        unrealised_pnl: (p.status === 'closed') ? 0 : unrealised,
        total_pnl,
        pnl_percent: parseFloat(pnl_percent.toFixed(2)),
        hold_lock_active: isLocked,
        remaining_hold_seconds: remainingSec,
        required_hold_seconds: requiredHoldSec
      } as EnrichedPosition;
    });
  }, [
    rawPositions,
    marketQuotes,
    comexQuotes,
    binanceQuotes,
    segmentSettings,
    inFlightConversions
  ]);

  return (
    <PositionsContext.Provider value={{
      positions: enrichedPositions,
      loading,
      error,
      refresh: fetchPositions,
      updatePositionLocally,
      removePositionLocally,
      restorePositionLocally,
      startConversion,
      endConversion,
      addOptimisticPosition,
      removeOptimisticPosition,
    }}>
      {children}
    </PositionsContext.Provider>
  );
};

export const usePositionsData = () => {
  const context = useContext(PositionsContext);
  if (!context) {
    throw new Error('usePositionsData must be used within a PositionsDataProvider');
  }
  return context;
};
