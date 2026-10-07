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
import { fetchUserBootstrap, getCachedBootstrapData, invalidateBootstrapCache } from '@/lib/bootstrapService';

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

export interface PositionReductionItem {
  posId: string;
  qty_open: number;
  qty_total?: number;
  isFullyClosed: boolean;
  positionObj?: Partial<MyPosition>;
}

export interface PositionsContextType {
  positions: EnrichedPosition[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updatePositionLocally: (posId: string, updatedFields: Partial<MyPosition>) => void;
  removePositionLocally: (posId: string, positionObj?: Partial<MyPosition>) => void;
  batchReducePositionsLocally: (reductions: PositionReductionItem[]) => void;
  restorePositionLocally: (posId?: string, fallbackPos?: Partial<MyPosition>) => void;
  startConversion: (posId: string, newType: string) => void;
  endConversion: (posId: string) => void;
  addOptimisticPosition: (pos: Partial<MyPosition>) => void;
  removeOptimisticPosition: (optIdOrTempId: string) => void;
}

const PositionsContext = createContext<PositionsContextType | null>(null);

export const cleanSym = (s?: string | null): string => {
  if (!s || typeof s !== 'string') return '';
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

const NON_CRYPTO_USD_SYMBOLS = ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD', 'XPTUSD', 'XPDUSD', 'GBPUSD', 'EURUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USDCHF'];

export const PositionsDataProvider = ({ children, refreshInterval = 2000 }: { children: React.ReactNode; refreshInterval?: number }) => {
  const [rawPositions, setRawPositions] = useState<MyPosition[]>(() => {
    const cachedBoot = getCachedBootstrapData();
    if (cachedBoot && Array.isArray(cachedBoot.positions)) {
      return cachedBoot.positions;
    }
    return [];
  });
  const [loading, setLoading] = useState(() => {
    const cachedBoot = getCachedBootstrapData();
    if (cachedBoot && Array.isArray(cachedBoot.positions)) return false;
    return true;
  });
  const [error, setError] = useState<string | null>(null);
  const [inFlightConversions, setInFlightConversions] = useState<Record<string, string>>({});
  const { segmentSettings } = useTradeConfig();

  // In-memory tracking for optimistic state
  const recentlyClosedTimesRef = useRef<Map<string, number>>(new Map());
  const optimisticPositionsRef = useRef<Map<string, MyPosition>>(new Map());
  const optimisticallyUpdatedPositionsRef = useRef<Map<string, { qty_open: number; qty_total?: number; time: number }>>(new Map());
  const recentlyRemovedPositionsRef = useRef<Map<string, MyPosition>>(new Map());
  const staticPositionPropsRef = useRef<Record<string, { entryTimeMs: number; dbSeg: string; resolvedKiteSymbol: string; isCrypto: boolean; isComex: boolean; binanceSymbol: string }>>({});

  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  const updatePositionLocally = useCallback((posId: string, updatedFields: Partial<MyPosition>) => {
    if (updatedFields.qty_open !== undefined) {
      optimisticallyUpdatedPositionsRef.current.set(posId, {
        qty_open: Number(updatedFields.qty_open),
        qty_total: updatedFields.qty_total !== undefined ? Number(updatedFields.qty_total) : undefined,
        time: Date.now()
      });
    }
    setRawPositions(prev =>
      prev.map(p => (p.id === posId ? { ...p, ...updatedFields } : p))
    );
  }, []);

  const removePositionLocally = useCallback((posId: string, positionObj?: Partial<MyPosition>) => {
    invalidateBootstrapCache();
    const now = Date.now();
    recentlyClosedTimesRef.current.set(posId, now);
    optimisticallyUpdatedPositionsRef.current.delete(posId);
    optimisticPositionsRef.current.delete(posId);

    const targetSymbol = cleanSym(positionObj?.symbol || '');
    if (targetSymbol) {
      for (const [id, op] of Array.from(optimisticPositionsRef.current.entries())) {
        if (cleanSym(op.symbol || op.kite_instrument) === targetSymbol) {
          recentlyClosedTimesRef.current.set(id, now);
          optimisticPositionsRef.current.delete(id);
        }
      }
    }

    setRawPositions(prev => {
      const target = prev.find(p => p.id === posId);
      const symbolToMatch = targetSymbol || cleanSym(target?.symbol || '');
      if (target) {
        recentlyRemovedPositionsRef.current.set(posId, target);
      } else if (positionObj && positionObj.symbol) {
        recentlyRemovedPositionsRef.current.set(posId, { id: posId, ...positionObj } as MyPosition);
      }

      if (symbolToMatch) {
        for (const [id, op] of Array.from(optimisticPositionsRef.current.entries())) {
          if (cleanSym(op.symbol || op.kite_instrument) === symbolToMatch) {
            recentlyClosedTimesRef.current.set(id, now);
            optimisticPositionsRef.current.delete(id);
          }
        }
      }

      const next = prev.filter(p => {
        if (p.id === posId) return false;
        if (symbolToMatch && (p.id.startsWith('__optimistic__') || p.id.startsWith('opt_')) && cleanSym(p.symbol || p.kite_instrument) === symbolToMatch) {
          return false;
        }
        return true;
      });

      if (typeof window !== 'undefined') {
        const lastMap = (window as any).__lastPositionsMap || new Map();
        if (target) lastMap.set(posId, target);
        else if (positionObj && positionObj.symbol) lastMap.set(posId, { id: posId, ...positionObj });
        (window as any).__lastPositionsMap = lastMap;
      }
      return next;
    });
  }, []);

  const batchReducePositionsLocally = useCallback((reductions: PositionReductionItem[]) => {
    if (!reductions || reductions.length === 0) return;
    invalidateBootstrapCache();
    const now = Date.now();
    const removedSet = new Set<string>();
    const removedSymbols = new Set<string>();

    reductions.forEach(r => {
      if (r.isFullyClosed || r.qty_open <= 0) {
        removedSet.add(r.posId);
        recentlyClosedTimesRef.current.set(r.posId, now);
        optimisticallyUpdatedPositionsRef.current.delete(r.posId);
        optimisticPositionsRef.current.delete(r.posId);
        const sym = cleanSym(r.positionObj?.symbol || '');
        if (sym) {
          removedSymbols.add(sym);
          for (const [id, op] of Array.from(optimisticPositionsRef.current.entries())) {
            if (cleanSym(op.symbol || op.kite_instrument) === sym) {
              recentlyClosedTimesRef.current.set(id, now);
              optimisticPositionsRef.current.delete(id);
            }
          }
        }
      } else {
        optimisticallyUpdatedPositionsRef.current.set(r.posId, {
          qty_open: r.qty_open,
          qty_total: r.qty_total,
          time: now
        });
      }
    });

    setRawPositions(prev => {
      const reductionMap = new Map(reductions.map(r => [r.posId, r]));
      const next: MyPosition[] = [];
      for (const p of prev) {
        const pSym = cleanSym(p.symbol || p.kite_instrument || '');
        if (removedSet.has(p.id) || ((p.id.startsWith('__optimistic__') || p.id.startsWith('opt_')) && removedSymbols.has(pSym))) {
          recentlyRemovedPositionsRef.current.set(p.id, p);
          optimisticPositionsRef.current.delete(p.id);
          continue;
        }
        const red = reductionMap.get(p.id);
        if (red) {
          next.push({
            ...p,
            qty_open: red.qty_open,
            qty_total: red.qty_total !== undefined ? red.qty_total : red.qty_open,
          });
        } else {
          next.push(p);
        }
      }

      if (typeof window !== 'undefined') {
        const lastMap = (window as any).__lastPositionsMap || new Map();
        reductions.forEach(r => {
          if (r.isFullyClosed || r.qty_open <= 0) {
            lastMap.delete(r.posId);
          } else {
            const existing = lastMap.get(r.posId) || r.positionObj;
            if (existing) {
              lastMap.set(r.posId, {
                ...existing,
                qty_open: r.qty_open,
                qty_total: r.qty_total !== undefined ? r.qty_total : r.qty_open
              });
            }
          }
        });
        (window as any).__lastPositionsMap = lastMap;
      }
      return next;
    });
  }, []);

  const addOptimisticPosition = useCallback((partialPos: Partial<MyPosition> & { opt_id?: string }) => {
    const tempId = partialPos.opt_id || (partialPos.id ? partialPos.id : `__optimistic__${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const now = Date.now();
    const cleanSymbol = (partialPos.symbol || '').trim();
    if (!cleanSymbol) return;

    // Clear recently removed guard for this symbol so re-entry trades appear immediately
    const cleanSymUpper = cleanSym(cleanSymbol);
    for (const [id, rp] of Array.from(recentlyRemovedPositionsRef.current.entries())) {
      if (cleanSym(rp.symbol || rp.kite_instrument) === cleanSymUpper) {
        recentlyRemovedPositionsRef.current.delete(id);
      }
    }

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
      brokerage: Number(partialPos.brokerage ?? (partialPos as any).entry_brokerage ?? (partialPos as any).expected_brokerage ?? 0),
      entry_brokerage: Number((partialPos as any).entry_brokerage ?? partialPos.brokerage ?? (partialPos as any).expected_brokerage ?? 0),
      pnl: 0,
      locked_margin: (partialPos as any).locked_margin || 0,
    } as any;

    optimisticPositionsRef.current.set(tempId, newPos);

    setRawPositions(prev => {
      if (prev.some(p => p.id === tempId)) return prev;
      return [newPos, ...prev];
    });
  }, []);

  const removeOptimisticPosition = useCallback((optIdOrTempId: string) => {
    optimisticPositionsRef.current.delete(optIdOrTempId);
    setRawPositions(prev => prev.filter(p => p.id !== optIdOrTempId));
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

      const isFresh = options?.fresh !== false;
      const queryUrl = isFresh ? `/api/positions?fresh=true&_t=${Date.now()}` : '/api/positions';
      const data = await api.get<{ positions: MyPosition[] }>(queryUrl, {
        signal: controller.signal,
      });
      const rawPositionsFromServer: MyPosition[] = data?.positions || [];

      const now = Date.now();
      // Clean up closed IDs older than 5 seconds
      for (const [id, closedAt] of Array.from(recentlyClosedTimesRef.current.entries())) {
        if (now - closedAt > 5000) {
          recentlyClosedTimesRef.current.delete(id);
        }
      }

      // Positions from the database are authoritative, excluding IDs closed within the last 5s
      const basePositions: MyPosition[] = rawPositionsFromServer
        .filter(p => !recentlyClosedTimesRef.current.has(p.id))
        .map(p => {
          const updated = optimisticallyUpdatedPositionsRef.current.get(p.id);
          if (updated && now - updated.time < 5000) {
            return {
              ...p,
              qty_open: updated.qty_open,
              qty_total: updated.qty_total !== undefined ? updated.qty_total : updated.qty_open,
            };
          }
          return p;
        });

      setRawPositions(prev => {
        // Collect active optimistic positions (< 3 seconds old and not closed)
        const activeOptPositions: MyPosition[] = [];
        const consumedServerQty = new Map<string, number>();

        // Sort optimistic positions chronologically
        const sortedOptPositions = Array.from(optimisticPositionsRef.current.values()).sort((a, b) => {
          const tA = (a as any).created_time_ms || (a.entry_time ? new Date(a.entry_time).getTime() : 0);
          const tB = (b as any).created_time_ms || (b.entry_time ? new Date(b.entry_time).getTime() : 0);
          return tA - tB;
        });

        for (const optPos of sortedOptPositions) {
          const optId = optPos.id;
          const createdTime = (optPos as any).created_time_ms || (optPos.entry_time ? new Date(optPos.entry_time).getTime() : 0);

          if (recentlyClosedTimesRef.current.has(optId) || (now - createdTime > 3000)) {
            optimisticPositionsRef.current.delete(optId);
            continue;
          }

          const optQty = Number(optPos.qty_open || optPos.qty_total || 1);
          const optSym = cleanSym(optPos.symbol || optPos.kite_instrument);
          const optSide = (optPos.side || '').toUpperCase();

          // Check if server already has a matching unconsumed position
          let matched = false;
          for (const sp of basePositions) {
            const spSym = cleanSym(sp.symbol || sp.kite_instrument);
            const spSide = (sp.side || '').toUpperCase();
            if (spSym !== optSym || spSide !== optSide) continue;

            const spTime = new Date(sp.entry_time || (sp as any).created_at || 0).getTime();
            if (spTime < createdTime - 5000) continue;

            const spTotalQty = Number(sp.qty_open || sp.qty_total || 0);
            const alreadyConsumed = consumedServerQty.get(sp.id) || 0;
            const remainingAvailable = spTotalQty - alreadyConsumed;

            if (remainingAvailable >= optQty || (remainingAvailable > 0 && spTotalQty <= optQty)) {
              consumedServerQty.set(sp.id, alreadyConsumed + Math.min(remainingAvailable, optQty));
              matched = true;
              break;
            }
          }

          if (matched) {
            optimisticPositionsRef.current.delete(optId);
          } else {
            activeOptPositions.push(optPos);
          }
        }

        const merged = [...activeOptPositions, ...basePositions];

        // Precompute static properties for newly loaded positions
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

  const restorePositionLocally = useCallback((posId?: string, fallbackPos?: Partial<MyPosition>) => {
    if (posId) {
      recentlyClosedTimesRef.current.delete(posId);
      const stashed = (fallbackPos && fallbackPos.symbol ? fallbackPos : null) || recentlyRemovedPositionsRef.current.get(posId);
      if (stashed && (stashed as MyPosition).symbol) {
        setRawPositions(prev => {
          if (prev.some(p => p.id === posId || (cleanSym(p.symbol) === cleanSym(stashed.symbol) && p.side === stashed.side))) {
            return prev;
          }
          return [{ id: posId, ...stashed } as MyPosition, ...prev];
        });
      }
    }
    fetchPositions({ fresh: true });
  }, [fetchPositions]);

  useEffect(() => {
    // One-shot eviction: clear the legacy localStorage cache written by the old code.
    try { localStorage.removeItem('cached_open_positions'); } catch (_) { }

    fetchPositions({ fresh: true });
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
      if (detail && !detail.is_exit) {
        addOptimisticPosition(detail);
      }
      fetchPositions({ fresh: true });
      debouncedFetch(800, true);
    };

    const handleOrderPlaced = () => {
      fetchPositions({ fresh: true });
      debouncedFetch(800, true);
    };

    const handleOrderFailed = () => {
      fetchPositions({ fresh: true });
    };

    const handlePositionClosedOptimistic = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const positions = detail?.positions || (detail?.position ? [detail.position] : []);
      const now = Date.now();
      const fullyClosedPositions = positions.filter((p: any) => p?.status === 'closed' || Number(p?.qty_open) === 0);
      const partialPositions = positions.filter((p: any) => p?.status !== 'closed' && Number(p?.qty_open) > 0);

      fullyClosedPositions.forEach((p: any) => {
        if (p?.id) {
          recentlyClosedTimesRef.current.set(p.id, now);
          optimisticallyUpdatedPositionsRef.current.delete(p.id);
          optimisticPositionsRef.current.delete(p.id);
        }
        const sym = cleanSym(p?.symbol || p?.kite_instrument || '');
        if (sym) {
          for (const [id, op] of Array.from(optimisticPositionsRef.current.entries())) {
            if (cleanSym(op.symbol || op.kite_instrument) === sym) {
              recentlyClosedTimesRef.current.set(id, now);
              optimisticPositionsRef.current.delete(id);
            }
          }
        }
      });
      partialPositions.forEach((p: any) => {
        if (p?.id) {
          optimisticallyUpdatedPositionsRef.current.set(p.id, {
            qty_open: Number(p.qty_open),
            qty_total: p.qty_total !== undefined ? Number(p.qty_total) : Number(p.qty_open),
            time: now
          });
        }
      });
      setRawPositions(prev => {
        const closedIdSet = new Set(fullyClosedPositions.map((p: any) => p?.id).filter(Boolean));
        const closedSymbolSet = new Set(fullyClosedPositions.map((p: any) => cleanSym(p?.symbol || p?.kite_instrument || '')).filter(Boolean));
        const partialMap = new Map(partialPositions.map((p: any) => [p.id, p]));
        const next = prev
          .filter(p => {
            if (closedIdSet.has(p.id)) return false;
            if ((p.id.startsWith('__optimistic__') || p.id.startsWith('opt_')) && closedSymbolSet.has(cleanSym(p.symbol || p.kite_instrument))) {
              return false;
            }
            return true;
          })
          .map(p => {
            const partial = partialMap.get(p.id);
            if (partial) {
              return {
                ...p,
                qty_open: Number(partial.qty_open),
                qty_total: partial.qty_total !== undefined ? Number(partial.qty_total) : Number(partial.qty_open),
              };
            }
            return p;
          });
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

    // Responsive 5s polling fallback — serves from Redis cache (3s TTL), not DB directly
    const pollTime = refreshInterval || 5000;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchPositions(); // No fresh=true: serve Redis cache to avoid hammering DB
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
      window.removeEventListener('user_bootstrap_updated', handleBootstrapUpdated);
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

    return rawPositions
      .filter(p => !recentlyClosedTimesRef.current.has(p.id))
      .map(p => {
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

  useEffect(() => {
    if (typeof window !== 'undefined' && enrichedPositions.length > 0) {
      const map = (window as any).__lastPositionsMap || new Map();
      enrichedPositions.forEach(p => {
        if (p && p.id) map.set(p.id, p);
      });
      (window as any).__lastPositionsMap = map;
    }
  }, [enrichedPositions]);

  return (
    <PositionsContext.Provider value={{
      positions: enrichedPositions,
      loading,
      error,
      refresh: fetchPositions,
      updatePositionLocally,
      removePositionLocally,
      batchReducePositionsLocally,
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
    return {
      positions: [],
      loading: false,
      error: null,
      refresh: async () => {},
      updatePositionLocally: () => {},
      removePositionLocally: () => {},
      batchReducePositionsLocally: () => {},
      restorePositionLocally: () => {},
      startConversion: () => {},
      endConversion: () => {},
      addOptimisticPosition: () => {},
      removeOptimisticPosition: () => {}
    };
  }
  return context;
};
