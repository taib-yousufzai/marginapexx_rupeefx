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
import { getSharedSessionSync } from '@/lib/sharedSession';
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
}

const PositionsContext = createContext<PositionsContextType | null>(null);

export const cleanSym = (s?: string | null): string => {
  if (!s) return '';
  let str = s.replace(/^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
  const nonCrypto = ['GBPUSD', 'EURUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USDCHF', 'XAUUSD', 'XAGUSD', 'XTIUSD', 'XNGUSD', 'XCUUSD'];
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
  if (baseKey.startsWith('SENSEX') || baseKey.startsWith('BANKEX')) {
    prefix = 'BFO:';
  } else if (
    seg.includes('MCX') ||
    seg.includes('NCO') ||
    baseKey.startsWith('CRUDEOIL') ||
    baseKey.startsWith('NATGAS') ||
    baseKey.startsWith('SILVER') ||
    baseKey.startsWith('GOLD') ||
    baseKey.startsWith('COPPER') ||
    baseKey.startsWith('ZINC') ||
    baseKey.startsWith('ALUMINIUM') ||
    baseKey.startsWith('LEAD') ||
    baseKey.startsWith('MENTHAOIL')
  ) {
    prefix = (seg === 'NCO' || seg === 'NCO-OPT') ? 'NCO:' : 'MCX:';
  } else if (
    seg.includes('CDS') ||
    seg.includes('FOREX') ||
    baseKey.startsWith('USDINR') ||
    baseKey.startsWith('EURINR') ||
    baseKey.startsWith('GBPINR') ||
    baseKey.startsWith('JPYINR')
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

export const PositionsDataProvider = ({ children, refreshInterval = 5000 }: { children: React.ReactNode; refreshInterval?: number }) => {
  const [rawPositions, setRawPositions] = useState<MyPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inFlightConversions, setInFlightConversions] = useState<Record<string, string>>({});
  // segmentSettings now comes from TradeConfigProvider — no local fetch needed
  const { segmentSettings } = useTradeConfig();
  const optimisticallyRemovedIds = useRef<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  // Tracks IDs of positions that were added optimistically (not yet confirmed by DB)
  const optimisticPositionIds = useRef<Set<string>>(new Set());
  const lastOptimisticAddRef = useRef<{ signature: string; time: number }>({ signature: '', time: 0 });
  const processedOptIdsRef = useRef<Set<string>>(new Set());
  const optimisticDeltasRef = useRef<Map<string, { expectedQty: number; addedAt: number }>>(new Map());

  // Static properties map to cache computations that never change per position lifecycle
  const staticPositionPropsRef = useRef<Record<string, { entryTimeMs: number; dbSeg: string; resolvedKiteSymbol: string; isCrypto: boolean; isComex: boolean; binanceSymbol: string }>>({}); 

  const updatePositionLocally = useCallback((posId: string, updatedFields: Partial<MyPosition>) => {
    setRawPositions(prev =>
      prev.map(p => (p.id === posId ? { ...p, ...updatedFields } : p))
    );
  }, []);

  const removePositionLocally = useCallback((posId: string) => {
    optimisticallyRemovedIds.current.add(posId);
    setRawPositions(prev => prev.filter(p => p.id !== posId));
  }, []);

  const restorePositionLocally = useCallback((posId: string) => {
    optimisticallyRemovedIds.current.delete(posId);
    fetchPositions();
  }, []);

const addOptimisticPosition = useCallback((partialPos: Partial<MyPosition> & { opt_id?: string }) => {
  const targetClean = cleanSym(partialPos.symbol || partialPos.kite_instrument || '');
  const normProdType = (partialPos.product_type || 'INTRADAY').toUpperCase();
  const qty = partialPos.qty_open || 0;
  const side = partialPos.side || 'BUY';

  if (partialPos.opt_id) {
    if (processedOptIdsRef.current.has(partialPos.opt_id)) {
      return;
    }
    processedOptIdsRef.current.add(partialPos.opt_id);
    if (processedOptIdsRef.current.size > 300) {
      const first = processedOptIdsRef.current.values().next().value;
      if (first) processedOptIdsRef.current.delete(first);
    }
  } else {
    const sig = `${targetClean}|${side}|${normProdType}|${qty}`;
    const nowMs = Date.now();
    if (lastOptimisticAddRef.current.signature === sig && (nowMs - lastOptimisticAddRef.current.time) < 500) {
      return;
    }
    lastOptimisticAddRef.current = { signature: sig, time: nowMs };
  }

  const deltaKey = `${targetClean}|${side}|${normProdType}`;

  setRawPositions(prev => {
    // Find ANY existing open position for this symbol + side + product_type (optimistic OR real DB position)
    const existingIdx = prev.findIndex(
      p => cleanSym(p.symbol || p.kite_instrument) === targetClean && p.side === partialPos.side && (p.product_type || 'INTRADAY').toUpperCase() === normProdType && (p.status === 'open' || p.status === 'active' || !p.status)
    );

    if (existingIdx >= 0) {
      const updated = [...prev];
      const existing = updated[existingIdx];
      const addedQty = partialPos.qty_open || 0;
      const addedLots = (partialPos as any).lots || 0;
      const newQty = (existing.qty_open || 0) + addedQty;

      optimisticDeltasRef.current.set(deltaKey, { expectedQty: newQty, addedAt: Date.now() });

      updated[existingIdx] = {
        ...existing,
        qty_open: newQty,
        lots: (existing.lots || 0) + addedLots,
      };
      return updated;
    }

    const tempId = `__optimistic__${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    const optimisticPos: MyPosition = {
      id: tempId,
      user_id: '',
      symbol: partialPos.symbol || '',
      settlement: partialPos.settlement || '',
      side: partialPos.side || 'BUY',
      qty_open: partialPos.qty_open || 0,
      lots: (partialPos as any).lots || 0,
      entry_price: partialPos.entry_price || 0,
      avg_price: partialPos.avg_price || partialPos.entry_price || 0,
      ltp: partialPos.ltp || partialPos.entry_price || 0,
      status: 'open',
      kite_instrument: partialPos.kite_instrument || partialPos.symbol || '',
      entry_time: now,
      locked_margin: partialPos.locked_margin || 0,
      brokerage: 0,
      ...partialPos,
      product_type: normProdType as any,
    } as MyPosition;

    optimisticDeltasRef.current.set(deltaKey, { expectedQty: partialPos.qty_open || 0, addedAt: Date.now() });
    optimisticPositionIds.current.add(tempId);
    return [optimisticPos, ...prev];
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

  const fetchPositions = useCallback(async () => {
    try {
      // Don't fetch if there's no active session (e.g. on the login page)
      const { token } = getSharedSessionSync();
      if (!token) return;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const data = await api.get<{ positions: MyPosition[] }>('/api/positions', {
        signal: controller.signal,
      });

      // The DB is the single source of truth. Apply the server snapshot directly.
      // Filter out any IDs that are still in the optimistic-removal set (exit in flight).
      let newPositions: MyPosition[] = (data.positions || []).filter(
        p => !optimisticallyRemovedIds.current.has(p.id)
      );

      // Evict stale optimistic removals: if the server no longer returns the position
      // it was already closed — clear the set so future fetches stay clean.
      const serverIds = new Set(newPositions.map(p => p.id));
      for (const id of [...optimisticallyRemovedIds.current]) {
        if (!serverIds.has(id)) {
          optimisticallyRemovedIds.current.delete(id);
        }
      }

      // Precompute static properties for any newly loaded positions
      const staticProps = staticPositionPropsRef.current;
      newPositions.forEach(p => {
        if (!staticProps[p.id]) {
          const dbSeg = mapSegmentWithSymbol(p.settlement || '', p.symbol);
          const segUpper = dbSeg.toUpperCase();
          const isCrypto = segUpper.includes('CRYPTO') || !!(p.symbol && (p.symbol.endsWith('USDT') || p.symbol.endsWith('USD')));
          const isComex = (p as any).preferredView === 'comex' || segUpper.includes('COMEX');

          let binanceSymbol = '';
          if (isCrypto) {
            binanceSymbol = (p.symbol || '').replace(/^(CRYPTO:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
            if (binanceSymbol.endsWith('USD') && !binanceSymbol.endsWith('USDT')) {
              binanceSymbol = binanceSymbol.slice(0, -3) + 'USDT';
            } else if (!binanceSymbol.endsWith('USDT')) {
              binanceSymbol += 'USDT';
            }
          }

          staticProps[p.id] = {
            entryTimeMs: new Date(p.entry_time).getTime(),
            dbSeg,
            resolvedKiteSymbol: resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || ''),
            isCrypto,
            isComex,
            binanceSymbol
          };
        }
      });

      // Clean up optimisticallyRemovedIds for positions that the server no longer returns
      for (const id of Array.from(optimisticallyRemovedIds.current)) {
        if (!serverIds.has(id)) {
          optimisticallyRemovedIds.current.delete(id);
        }
      }

      // Apply optimistic quantity overrides if server DB hasn't caught up yet
      const now = Date.now();
      const processedPositions = newPositions.map((p: any) => {
        const targetClean = cleanSym(p.symbol || p.kite_instrument || '');
        const normProdType = (p.product_type || 'INTRADAY').toUpperCase();
        const deltaKey = `${targetClean}|${p.side}|${normProdType}`;
        const override = optimisticDeltasRef.current.get(deltaKey);

        if (override) {
          if (now - override.addedAt > 6000) {
            // Fail-safe expiry after 6 seconds
            optimisticDeltasRef.current.delete(deltaKey);
          } else if (p.qty_open >= override.expectedQty) {
            // Server caught up or exceeded expected quantity
            optimisticDeltasRef.current.delete(deltaKey);
          } else {
            // Keep optimistic quantity active until server catches up
            return { ...p, qty_open: Math.max(p.qty_open, override.expectedQty) };
          }
        }
        return p;
      });

      setRawPositions(prev => {
        const prevOpenIds = new Set(prev.map(p => p.id));
        let posClosedOnBackend = false;
        for (const id of prevOpenIds) {
          // Skip optimistic placeholders — they are not real DB IDs
          if (id.startsWith('__optimistic__')) continue;
          if (!serverIds.has(id) && !optimisticallyRemovedIds.current.has(id)) {
            posClosedOnBackend = true;
            break;
          }
        }
        if (posClosedOnBackend) {
          setTimeout(() => {
            window.dispatchEvent(new Event('position-closed'));
          }, 0);
        }

        // Preserve optimistic placeholders whose matching real server position has not arrived yet
        const unreplacedOptimistic = prev.filter(p => {
          if (!p.id.startsWith('__optimistic__')) return false;
          // Expire optimistic placeholder after 6 seconds as a fail-safe
          const idParts = p.id.split('_');
          const timeMs = parseInt(idParts[2] || '0', 10);
          if (timeMs > 0 && Date.now() - timeMs > 6000) return false;

          const optClean = cleanSym(p.symbol || p.kite_instrument || '');
          const normProduct = (p.product_type || 'INTRADAY').toUpperCase();
          const hasRealMatch = processedPositions.some((real: any) => {
            const realClean = cleanSym(real.symbol || real.kite_instrument || '');
            const realProduct = (real.product_type || 'INTRADAY').toUpperCase();
            return realClean === optClean && real.side === p.side && realProduct === normProduct;
          });
          return !hasRealMatch;
        });

        return [...unreplacedOptimistic, ...processedPositions];
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.warn('[PositionsContext] Transient error fetching positions:', err);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // One-shot eviction: clear the legacy localStorage cache written by the old code.
    // Existing users may still have stale positions under this key; remove it so they
    // never seed the UI from a ghost snapshot again.
    try { localStorage.removeItem('cached_open_positions'); } catch (_) {}

    fetchPositions();
    let isSubscribed = false;
    const channelName = `my-positions-realtime-${Math.random().toString(36).slice(2)}`;

    const debouncedFetch = (delay = 300) => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      fetchDebounceRef.current = setTimeout(() => {
        fetchPositions();
      }, delay);
    };

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => {
          debouncedFetch(200);
        }
      );

    channel.subscribe((status) => {
      isSubscribed = status === 'SUBSCRIBED';
    });

    const handleOrderPlacedWithData = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        if (detail.is_exit) {
          const exitQty = detail.qty || detail.qty_open || 0;
          if (detail.linked_position_id) {
            setRawPositions(prev => {
              const pos = prev.find(p => p.id === detail.linked_position_id);
              if (pos) {
                if (!exitQty || exitQty >= pos.qty_open) {
                  optimisticallyRemovedIds.current.add(pos.id);
                  return prev.filter(p => p.id !== pos.id);
                } else {
                  // Partial exit
                  const targetClean = cleanSym(pos.symbol || pos.kite_instrument || '');
                  const normProdType = (pos.product_type || 'INTRADAY').toUpperCase();
                  const deltaKey = `${targetClean}|${pos.side}|${normProdType}`;
                  const newQty = Math.max(0, pos.qty_open - exitQty);
                  optimisticDeltasRef.current.set(deltaKey, { expectedQty: newQty, addedAt: Date.now() });
                  return prev.map(p => p.id === pos.id ? { ...p, qty_open: newQty } : p);
                }
              }
              return prev;
            });
          } else if (detail.symbol) {
            const targetClean = cleanSym(detail.symbol);
            const side = detail.side || 'BUY';
            const normProdType = (detail.product_type || 'INTRADAY').toUpperCase();
            setRawPositions(prev => {
              const matching = prev.filter(p => cleanSym(p.symbol) === targetClean);
              if (matching.length > 0) {
                const totalQty = matching.reduce((sum, p) => sum + (p.qty_open || 0), 0);
                if (!exitQty || exitQty >= totalQty) {
                  matching.forEach(p => optimisticallyRemovedIds.current.add(p.id));
                  return prev.filter(p => cleanSym(p.symbol) !== targetClean);
                } else {
                  // Partial exit
                  const deltaKey = `${targetClean}|${side}|${normProdType}`;
                  const newQty = Math.max(0, totalQty - exitQty);
                  optimisticDeltasRef.current.set(deltaKey, { expectedQty: newQty, addedAt: Date.now() });
                  return prev.map(p => cleanSym(p.symbol) === targetClean ? { ...p, qty_open: Math.max(0, p.qty_open - exitQty) } : p);
                }
              }
              return prev;
            });
          }
        } else if (!detail.is_exit) {
          addOptimisticPosition(detail);
        }
      }
      // Immediate fetch — scalp mode needs instant position update
      fetchPositions();
      // Follow-up fetch in 800ms to catch any async DB propagation
      debouncedFetch(800);
    };

    const handleOrderPlaced = () => {
      // Immediate fetch for fast position panel update
      fetchPositions();
      // Follow-up fetch in 800ms
      debouncedFetch(800);
    };

    const handleOrderFailed = () => {
      optimisticallyRemovedIds.current.clear();
      fetchPositions();
    };
    
    window.addEventListener('order_placed', handleOrderPlaced);
    window.addEventListener('order_placed_with_data', handleOrderPlacedWithData);
    window.addEventListener('order_failed', handleOrderFailed);
    window.addEventListener('position-closed', handleOrderPlaced);
    window.addEventListener('position_closed', handleOrderPlaced);
    window.addEventListener('position_updated', handleOrderPlaced);
    window.addEventListener('order_executed', handleOrderPlaced);

    // Active polling fallback: even when subscribed to realtime channels,
    // poll every 8s as a safety net (paused when tab is in background)
    const pollTime = Math.max(refreshInterval, 8000);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchPositions();
      }
    }, pollTime);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchPositions();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
      supabase.removeChannel(channel);
      window.removeEventListener('order_placed', handleOrderPlaced);
      window.removeEventListener('order_placed_with_data', handleOrderPlacedWithData);
      window.removeEventListener('order_failed', handleOrderFailed);
      window.removeEventListener('position-closed', handleOrderPlaced);
      window.removeEventListener('position_closed', handleOrderPlaced);
      window.removeEventListener('position_updated', handleOrderPlaced);
      window.removeEventListener('order_executed', handleOrderPlaced);
    };
  }, [fetchPositions, refreshInterval]);

  const { kiteKeys, binanceKeys, comexKeys } = useMemo(() => {
    const kite: string[] = [];
    const binance: string[] = [];
    const comex: string[] = [];
    const props = staticPositionPropsRef.current;

    rawPositions.filter(p => p.status === 'open' || p.status === 'active').forEach(p => {
      const cached = props[p.id];
      if (cached) {
        if (cached.isCrypto) {
          binance.push(cached.binanceSymbol);
        } else if (cached.isComex) {
          comex.push(p.symbol);
        } else {
          kite.push(cached.resolvedKiteSymbol);
        }
      } else {
        const seg = (p.settlement || '').toUpperCase();
        if (seg.includes('CRYPTO') || seg === 'USDT' || (p.symbol && p.symbol.endsWith('USDT'))) {
          let sym = (p.symbol || '').replace('/', '');
          if (!sym.endsWith('USDT')) sym += 'USDT';
          binance.push(sym);
        } else if (seg.includes('COMEX') || (p.symbol && p.symbol.endsWith('=F'))) {
          comex.push(p.symbol);
        } else {
          kite.push(resolveKitePrefix(p.kite_instrument || p.symbol, p.settlement || ''));
        }
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
      settingsMap.set(`${s.segment}|${s.side}`, s);
    }

    const props = staticPositionPropsRef.current;

    return rawPositions.map(p => {
      const product_type = inFlightConversions[p.id] || p.product_type;
      let ltp = p.ltp || p.entry_price;
      let bid = ltp;
      let ask = ltp;

      const cached = props[p.id];
      const dbSeg = cached ? cached.dbSeg : mapSegmentWithSymbol(p.settlement || '', p.symbol);
      const isCrypto = cached ? cached.isCrypto : (p.settlement || '').toUpperCase().includes('CRYPTO');
      const isComex = cached ? cached.isComex : (p.settlement || '').toUpperCase().includes('COMEX');
      const entryTimeMs = cached ? cached.entryTimeMs : new Date(p.entry_time).getTime();

      const avgPrice = p.avg_price || p.entry_price;
      const contractExpired = isContractExpired(p.kite_instrument || p.symbol);

      let rawQuote: any = null;
      if (!contractExpired) {
        if (isCrypto) {
          const binanceKey = cached ? cached.binanceSymbol : (p.symbol || '').replace('/', '') + (p.symbol?.endsWith('USDT') ? '' : 'USDT');
          const shortSymbol = (p.symbol || '').replace('/', '').replace('USDT', '');
          const quote = marketQuotes[binanceKey] || marketQuotes[shortSymbol] || marketQuotes[p.symbol] || marketQuotes[`CRYPTO:${shortSymbol}`] || binanceQuotes[binanceKey] || binanceQuotes[shortSymbol];
          if (quote) {
            rawQuote = quote;
            ltp = quote.lastPrice ?? ltp;
            bid = (quote as any).bid ?? ltp;
            ask = (quote as any).ask ?? ltp;
          }
        } else if (isComex) {
          const quote = comexQuotes[p.symbol];
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
          const quote = marketQuotes[kiteKey] || marketQuotes[`NCO:${symbolWithoutPrefix}`] || marketQuotes[`MCX:${symbolWithoutPrefix}`] || marketQuotes[rawSymbol] || marketQuotes[symbolWithoutPrefix] || marketQuotes[`NFO:${symbolWithoutPrefix}`] || marketQuotes[`NSE:${symbolWithoutPrefix}`];
          if (quote) {
            rawQuote = quote;
            ltp = quote.lastPrice ?? ltp;
            bid = (quote.bid && quote.bid > 0) ? quote.bid : ltp;
            ask = (quote.ask && quote.ask > 0) ? quote.ask : ltp;
          }
        }
      }

      // Use pos.settlement directly — this is what close/route.ts uses when
      // looking up segment settings, so the buffer value matches exactly.
      const settingsKey = `${p.settlement ?? ''}|${p.side}`;
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

      const profitHoldSec = sideSetting ? Number(sideSetting.profit_hold_sec) : 120;
      const elapsedSec = Math.floor((Date.now() - entryTimeMs) / 1000);

      const isInProfit = unrealised > 0;
      // Lock when in profit and within hold window.
      // When segmentSettings haven't loaded yet (segmentSettingsLoaded = false) we
      // still apply the lock using the 120s default — this prevents a flash of
      // "exit allowed" on first render while settings are still fetching.
      const isLocked = !contractExpired
        && (p.status === 'open' || p.status === 'active')
        && elapsedSec < profitHoldSec
        && isInProfit;
      const remainingSec = isLocked ? (profitHoldSec - elapsedSec) : 0;

      return {
        ...p,
        product_type,
        current_ltp: ltp,
        unrealised_pnl: (p.status === 'closed') ? 0 : unrealised,
        total_pnl,
        pnl_percent: parseFloat(pnl_percent.toFixed(2)),
        hold_lock_active: isLocked,
        remaining_hold_seconds: remainingSec,
        required_hold_seconds: profitHoldSec
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
