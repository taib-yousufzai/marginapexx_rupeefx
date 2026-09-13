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

  // Inject a temporary placeholder position so the user sees it instantly
  // after a scalp order — before the DB write propagates. The real DB fetch
  // will replace this placeholder when it arrives.
  const addOptimisticPosition = useCallback((partialPos: Partial<MyPosition>) => {
    const tempId = `__optimistic__${Date.now()}`;
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
      product_type: partialPos.product_type || 'INTRADAY',
      kite_instrument: partialPos.kite_instrument || partialPos.symbol || '',
      entry_time: now,
      locked_margin: partialPos.locked_margin || 0,
      brokerage: 0,
      ...partialPos,
    } as MyPosition;

    optimisticPositionIds.current.add(tempId);
    setRawPositions(prev => [optimisticPos, ...prev]);

    // Auto-remove the optimistic placeholder after 4s (real data should arrive by then)
    setTimeout(() => {
      if (optimisticPositionIds.current.has(tempId)) {
        optimisticPositionIds.current.delete(tempId);
        setRawPositions(prev => prev.filter(p => p.id !== tempId));
      }
    }, 4000);
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
          const isCrypto = segUpper.includes('CRYPTO') || !!(p.symbol && p.symbol.endsWith('USDT'));
          const isComex = (p as any).preferredView === 'comex' || segUpper.includes('COMEX');

          let binanceSymbol = '';
          if (isCrypto) {
            binanceSymbol = (p.symbol || '').replace('/', '');
            if (!binanceSymbol.endsWith('USDT')) binanceSymbol += 'USDT';
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
        // Clear any optimistic placeholders now that real data has arrived
        optimisticPositionIds.current.clear();
        return newPositions;
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
        if (detail.is_exit && detail.linked_position_id) {
          removePositionLocally(detail.linked_position_id);
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
