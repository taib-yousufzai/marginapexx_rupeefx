'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter, usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { api, ApiError } from '@/lib/api';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import { fmtDate, fmtDateTime } from '@/lib/format';
import AnimatedLoader from '@/components/AnimatedLoader';
import {
  getClientHistoryCache,
  saveClientHistoryCache,
  prependToClientHistoryCache,
  removeFromClientHistoryCache,
  HistoryItem
} from '@/lib/historyCache';
import './page.css';

export type { HistoryItem };

export default function HistoryPage() {
  useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentTab, setCurrentTab] = useState<'position' | 'order'>('position');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [appliedFromDate, setAppliedFromDate] = useState('');
  const [appliedToDate, setAppliedToDate] = useState('');

  const [historyData, setHistoryData] = useState<HistoryItem[]>(() => getClientHistoryCache());
  const historyDataRef = useRef<HistoryItem[]>(historyData);
  historyDataRef.current = historyData;

  const [initialLoaded, setInitialLoaded] = useState(() => historyData.length > 0);
  const [loading, setLoading] = useState<boolean>(() => historyData.length === 0);
  const mainContentRef = useRef<HTMLDivElement>(null);

  // Scroll reset - runs synchronously before browser paint via ref callback
  const scrollResetRef = (node: HTMLDivElement | null) => {
    if (node) {
      node.scrollTop = 0;
    }
    (mainContentRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  };

  useEffect(() => {
    const syncTheme = () => applyTheme(getSavedTheme());
    syncTheme();
    window.addEventListener('themeChanged', syncTheme);

    supabase.auth.getSession().then(({ data: { session } }) => {
      const role = session?.user?.user_metadata?.role;
      if (role === 'admin' || role === 'super_admin') {
        setIsAdmin(true);
      }
    });

    return () => window.removeEventListener('themeChanged', syncTheme);
  }, []);

  const fetchSeqRef = useRef<number>(0);

  const fetchHistory = useCallback(async (silent = false, isManualRefresh = false) => {
    const seq = ++fetchSeqRef.current;
    try {
      if (!silent && historyDataRef.current.length === 0) {
        setLoading(true);
      }
      const freshParam = isManualRefresh ? '&fresh=true' : '';
      // Fetch both orders and positions history with fast Redis cache hits (<10ms)
      const [ordersRes, posRes] = await Promise.allSettled([
        api.get<{ orders: any[]; error?: string }>(`/api/orders?status=executed,rejected,cancelled&limit=500${freshParam}`),
        api.get<{ positions: any[]; error?: string }>(`/api/positions?status=closed&all=true${freshParam}`),
      ]);

      // If a newer request was dispatched while this was running, ignore this stale response
      if (seq !== fetchSeqRef.current) {
        return;
      }

      const ordersData = ordersRes.status === 'fulfilled' ? ordersRes.value : null;
      const posData = posRes.status === 'fulfilled' ? posRes.value : null;

      const ordersList = (ordersData && !ordersData.error && Array.isArray(ordersData.orders)) ? ordersData.orders : null;
      const positionsList = (posData && !posData.error && Array.isArray(posData.positions)) ? posData.positions : null;

      // If both API calls failed or timed out, never wipe out existing history
      if (ordersList === null && positionsList === null) {
        return;
      }

      const orderMap = new Map<string, HistoryItem>();
      const posMap = new Map<string, HistoryItem>();

      // Populate positions: if query succeeded, use real DB state
      if (positionsList !== null && positionsList.length > 0) {
        const formattedPos: HistoryItem[] = positionsList.filter(Boolean).map((p: any) => {
          const rawSettlement = p.settlement || '';
          let settlement = rawSettlement;
          if (!settlement) {
            const sym: string = (p.symbol || '').toUpperCase();
            if (sym.endsWith('USDT') || sym.includes('CRYPTO')) settlement = 'Crypto';
            else if (sym.endsWith('=F') || sym.includes('COMEX')) settlement = 'COMEX';
            else if (sym.includes('MCX')) settlement = 'MCX';
            else settlement = 'NSE';
          }
          const exitTime = p.closed_at || p.exit_time || p.updated_at || p.created_at;
          const exitTs = exitTime ? new Date(exitTime).getTime() : Date.now();
          return {
            id: p.id || `pos_${Math.random()}`,
            scriptName: p.symbol || 'UNKNOWN',
            type: (p.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
            orderType: p.product_type || 'INTRADAY',
            qty: Number(p.qty_total || p.qty_open || p.qty || 1),
            price: Number(p.exit_price || 0),
            entryPrice: Number(p.entry_price || p.avg_price || 0),
            exitPrice: Number(p.exit_price || 0),
            pnl: Number(p.pnl || 0),
            date: fmtDateTime(p.created_at),
            exitDate: fmtDate(exitTime),
            status: 'closed',
            brokerage: Number(p.brokerage || 0),
            entry_intraday_brokerage: Number(p.entry_intraday_brokerage || 0),
            entry_carry_brokerage: Number(p.entry_carry_brokerage || 0),
            entry_gtt_brokerage: Number(p.entry_gtt_brokerage || 0),
            exit_intraday_brokerage: Number(p.exit_intraday_brokerage || 0),
            exit_carry_brokerage: Number(p.exit_carry_brokerage || 0),
            exit_gtt_brokerage: Number(p.exit_gtt_brokerage || 0),
            closedBy: p.closed_by || 'USER_ACTION',
            productType: p.product_type || 'INTRADAY',
            settlement,
            settlementAmount: Math.abs(Number(p.settlement_amount || 0)),
            entry_brokerage: Number(p.entry_brokerage || 0),
            timestamp: isNaN(exitTs) ? Date.now() : exitTs,
            entryTimestamp: p.entry_time || p.created_at ? new Date(p.entry_time || p.created_at).getTime() : 0,
          };
        });
        for (const p of formattedPos) {
          if (p && p.id) posMap.set(p.id, p);
        }
      } else {
        // If positions query returned empty or failed, retain existing state so history never flashes empty
        for (const item of historyDataRef.current || []) {
          if (item && String(item.status || '').toLowerCase() === 'closed' && item.id) {
            posMap.set(item.id, item);
          }
        }
      }

      // Populate orders: if query succeeded, use real DB state
      if (ordersList !== null && ordersList.length > 0) {
        const formattedOrders: HistoryItem[] = ordersList.filter(Boolean).map((o: any) => {
          const createTs = o.created_at ? new Date(o.created_at).getTime() : Date.now();
          return {
            id: o.id || `ord_${Math.random()}`,
            scriptName: o.symbol || 'UNKNOWN',
            type: (o.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
            orderType: o.order_type || 'MARKET',
            qty: Number(o.qty || 0),
            price: Number(o.fill_price || 0),
            pnl: 0,
            date: fmtDateTime(o.created_at),
            status: o.status ? String(o.status).toLowerCase() : 'unknown',
            brokerage: Number(o.brokerage || 0),
            intraday_brokerage: Number(o.intraday_brokerage || 0),
            carry_brokerage: Number(o.carry_brokerage || 0),
            gtt_brokerage: Number(o.gtt_brokerage || 0),
            timestamp: isNaN(createTs) ? Date.now() : createTs,
          };
        });
        for (const o of formattedOrders) {
          if (o && o.id) orderMap.set(o.id, o);
        }
      } else {
        // If orders query returned empty or failed, retain existing state
        for (const item of historyDataRef.current || []) {
          if (item && String(item.status || '').toLowerCase() !== 'closed' && item.id) {
            orderMap.set(item.id, item);
          }
        }
      }

      // Reconcile and retain all confirmed closed items from local/session storage:
      // Real DB records take precedence in posMap / orderMap, while any client-cached items
      // are retained so trades never vanish upon page refresh or network lag.
      const existingItems = [
        ...(historyDataRef.current || []),
        ...getClientHistoryCache()
      ];

      for (const existing of existingItems) {
        if (!existing || !existing.id) continue;

        const isClosed = String(existing.status || '').toLowerCase() === 'closed';
        if (isClosed) {
          if (!posMap.has(existing.id)) {
            posMap.set(existing.id, { ...existing, status: 'closed' });
          }
        } else {
          if (!orderMap.has(existing.id)) {
            orderMap.set(existing.id, existing);
          }
        }
      }

      const merged = [
        ...Array.from(posMap.values()),
        ...Array.from(orderMap.values())
      ].filter(Boolean).sort((a, b) => {
        const diff = (b.timestamp || 0) - (a.timestamp || 0);
        if (diff !== 0) return diff;
        return (b.entryTimestamp || 0) - (a.entryTimestamp || 0);
      });

      if (seq !== fetchSeqRef.current) return;

      if (typeof window !== 'undefined') {
        saveClientHistoryCache(merged);
      }

      setHistoryData(merged);
    } catch (err) {
      console.warn('Failed to fetch history:', err);
    } finally {
      if (seq === fetchSeqRef.current) {
        setInitialLoaded(true);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    // Immediate 0ms hydration from cache on route navigation to /history
    if (pathname === '/history' || pathname?.includes('/history')) {
      const cached = getClientHistoryCache();
      if (cached.length > 0) {
        setHistoryData(cached);
        setInitialLoaded(true);
        setLoading(false);
      }
      fetchHistory(true, true);
    }
  }, [pathname, fetchHistory]);

  useEffect(() => {
    // Always fetch fresh from DB on mount so navigating here after a trade
    // doesn't show stale Redis-cached data.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerRefresh = (delay = 100) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchHistory(true, true);
      }, delay);
    };

    // Instant update when confirmed position closure event arrives
    const handleConfirmedClose = (e: any) => {
      const items = e.detail?.historyItems || (e.detail?.historyItem ? [e.detail.historyItem] : []);
      if (items.length > 0) {
        const updated = prependToClientHistoryCache(items);
        setHistoryData(updated);
        setInitialLoaded(true);
        setLoading(false);
      } else {
        const cached = getClientHistoryCache();
        if (cached.length > 0) {
          setHistoryData(cached);
          setInitialLoaded(true);
          setLoading(false);
        }
      }
      triggerRefresh(150);
    };

    // Instant optimistic update when an order is placed
    const handleOptimisticOrder = (e: any) => {
      const order = e.detail?.order || (e.detail?.symbol ? {
        id: e.detail.opt_id || `opt_${Date.now()}`,
        symbol: e.detail.symbol,
        side: e.detail.side,
        order_type: e.detail.product_type || 'INTRADAY',
        qty: e.detail.qty || e.detail.qty_open || 1,
        fill_price: e.detail.entry_price || e.detail.ltp || 0,
        status: 'EXECUTED',
        created_at: new Date().toISOString(),
      } : null);
      if (!order) return;
      const historyItem: HistoryItem = {
        id: order.id,
        scriptName: order.symbol,
        type: order.side,
        orderType: order.order_type || 'MARKET',
        qty: order.qty,
        price: order.fill_price || order.client_price || 0,
        pnl: 0,
        date: new Date(order.created_at || Date.now()).toLocaleString(),
        status: order.status || 'EXECUTED',
        brokerage: order.brokerage || 0,
        timestamp: new Date(order.created_at || Date.now()).getTime(),
      };
      const updated = prependToClientHistoryCache(historyItem);
      setHistoryData(updated);
      setInitialLoaded(true);
      setLoading(false);
      triggerRefresh(150);
    };

    const handleOptimisticRollback = (e: any) => {
      const ids: string[] = e.detail?.positionIds || (e.detail?.orderId ? [e.detail.orderId] : []);
      if (ids.length === 0) return;
      const filtered = removeFromClientHistoryCache(ids);
      setHistoryData(filtered);
      triggerRefresh(50);
    };

    // Smooth background refresh on trade events without wiping UI
    const handleCloseOrOrderEvent = () => {
      const cached = getClientHistoryCache();
      if (cached.length > 0) {
        setHistoryData(cached);
        setInitialLoaded(true);
        setLoading(false);
      }
      triggerRefresh(50);
    };

    // Cache updated directly by helper
    const handleCacheUpdated = (e: any) => {
      const all = e.detail?.all || getClientHistoryCache();
      if (Array.isArray(all) && all.length > 0) {
        setHistoryData(all);
        setInitialLoaded(true);
        setLoading(false);
      }
      triggerRefresh(150);
    };

    // Storage event for multi-tab synchronization
    const handleStorage = (e: StorageEvent) => {
      if (!e.key || e.key === 'history_cache_v2' || e.key.includes('history')) {
        const cached = getClientHistoryCache();
        if (cached.length > 0) {
          setHistoryData(cached);
          setInitialLoaded(true);
          setLoading(false);
        }
      }
    };

    // BroadcastChannel for cross-component / cross-tab instant messaging
    let bc: BroadcastChannel | null = null;
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        bc = new BroadcastChannel('marginapexx_history_bus');
        bc.onmessage = () => {
          const cached = getClientHistoryCache();
          if (cached.length > 0) {
            setHistoryData(cached);
            setInitialLoaded(true);
            setLoading(false);
          }
          triggerRefresh(100);
        };
      }
    } catch (_) {}

    // Listen for all order and position lifecycle events
    const genericEventList = [
      'order_placed',
      'position-closed',
      'position_updated',
      'order_executed',
      'order_cancelled',
      'order_failed',
      'balance_updated',
      'market_order_update',
    ];

    genericEventList.forEach(evt => window.addEventListener(evt, handleCloseOrOrderEvent));
    window.addEventListener('position_closed', handleConfirmedClose);
    window.addEventListener('position_closed_optimistic', handleConfirmedClose);
    window.addEventListener('history_updated', handleConfirmedClose);
    window.addEventListener('history_cache_updated', handleCacheUpdated);
    window.addEventListener('position_closed_rollback', handleOptimisticRollback);
    window.addEventListener('order_placed_optimistic', handleOptimisticOrder);
    window.addEventListener('order_placed_with_data', handleOptimisticOrder);
    window.addEventListener('storage', handleStorage);

    // Instant sync when tab/app becomes visible or focused
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        const cached = getClientHistoryCache();
        if (cached.length > 0) {
          setHistoryData(cached);
        }
        triggerRefresh(50);
      }
    };
    const handleFocus = () => {
      const cached = getClientHistoryCache();
      if (cached.length > 0) {
        setHistoryData(cached);
      }
      triggerRefresh(50);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);

    // Active polling fallback every 15 seconds when visible (Realtime handles instant changes)
    // Always pass fresh=true so the poll bypasses Redis and gets real DB data.
    const pollInterval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        fetchHistory(true, true);
      }
    }, 15000);

    // Supabase Realtime channel with user-specific filtering
    let channel: any = null;
    supabase.auth.getSession().then(({ data: { session } }) => {
      const userId = session?.user?.id;
      if (!userId) return;
      channel = supabase
        .channel(`user-history-${userId}-${Date.now()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'positions', filter: `user_id=eq.${userId}` }, () => handleCloseOrOrderEvent())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `user_id=eq.${userId}` }, () => handleCloseOrOrderEvent())
        .subscribe();
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(pollInterval);
      if (bc) {
        try {
          bc.close();
        } catch (_) {}
      }
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('storage', handleStorage);
      genericEventList.forEach(evt => window.removeEventListener(evt, handleCloseOrOrderEvent));
      window.removeEventListener('position_closed', handleConfirmedClose);
      window.removeEventListener('position_closed_optimistic', handleConfirmedClose);
      window.removeEventListener('history_updated', handleConfirmedClose);
      window.removeEventListener('history_cache_updated', handleCacheUpdated);
      window.removeEventListener('position_closed_rollback', handleOptimisticRollback);
      window.removeEventListener('order_placed_optimistic', handleOptimisticOrder);
      window.removeEventListener('order_placed_with_data', handleOptimisticOrder);
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [fetchHistory]);

  const handleApplyFilter = () => {
    setAppliedFromDate(fromDate);
    setAppliedToDate(toDate);
  };

  const handleClearFilter = () => {
    setFromDate('');
    setToDate('');
    setAppliedFromDate('');
    setAppliedToDate('');
  };

  const filteredData = useMemo(() => {
    let base = historyData.filter(item => {
      const isClosed = String(item.status || '').toLowerCase() === 'closed';
      if (currentTab === 'position') return isClosed;
      return !isClosed;
    });

    const activeFrom = appliedFromDate || fromDate;
    const activeTo = appliedToDate || toDate;

    if (activeFrom) {
      const parts = activeFrom.split('-').map(Number);
      if (parts.length === 3 && !parts.some(isNaN)) {
        const [y, m, d] = parts;
        const fromTs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
        base = base.filter(item => (item.timestamp || 0) >= fromTs);
      }
    }
    if (activeTo) {
      const parts = activeTo.split('-').map(Number);
      if (parts.length === 3 && !parts.some(isNaN)) {
        const [y, m, d] = parts;
        const toTs = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
        base = base.filter(item => (item.timestamp || 0) <= toTs);
      }
    }

    base.sort((a, b) => {
      const diff = (b.timestamp || 0) - (a.timestamp || 0);
      if (diff !== 0) return diff;
      return (b.entryTimestamp || 0) - (a.entryTimestamp || 0);
    });

    return base;
  }, [historyData, currentTab, appliedFromDate, appliedToDate, fromDate, toDate]);

  const getItemBrokerage = useCallback((h: HistoryItem) => {
    const direct = Number(h.brokerage || 0);
    if (direct > 0) return direct;
    const entryBrk = Number((h as any).entry_brokerage || 0);
    if (entryBrk > 0) return entryBrk;
    const intraday = Number(h.entry_intraday_brokerage || 0) + Number(h.exit_intraday_brokerage || 0) + Number(h.intraday_brokerage || 0);
    const carry = Number(h.entry_carry_brokerage || 0) + Number(h.exit_carry_brokerage || 0) + Number(h.carry_brokerage || 0);
    const gtt = Number(h.entry_gtt_brokerage || 0) + Number(h.exit_gtt_brokerage || 0) + Number(h.gtt_brokerage || 0);
    return intraday + carry + gtt;
  }, []);

  const summary = useMemo(() => {
    const posHistory = filteredData.filter(h => String(h.status || '').toLowerCase() === 'closed');
    const gp = posHistory.filter(h => h.pnl > 0).reduce((acc, h) => acc + h.pnl, 0);
    const gl = posHistory.filter(h => h.pnl < 0).reduce((acc, h) => acc + Math.abs(h.pnl), 0);
    const b = filteredData.reduce((acc, h) => acc + getItemBrokerage(h), 0);
    const s = posHistory.reduce((acc, h) => acc + (h.settlementAmount ?? 0), 0);
    return { gp, gl, b, s, n: gp - gl - b - s };
  }, [filteredData, getItemBrokerage]);

  const formatPrice = (val: number) => {
    const sign = val >= 0 ? '' : '-';
    return `${sign}₹${Math.abs(val).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <>
      <style>{`
      .tooltip:hover::after {
        content: attr(data-tooltip);
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-card);
        border: 1px solid var(--border-color);
        color: var(--text-primary);
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 0.75rem;
        white-space: pre;
        z-index: 10;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      }
    `}</style>
      <div className="history-root">
        {/* ── Header (Mobile Only) ── */}
        <div className="app-header mobile-only">
          <div className="header-top">
            <div className="logo-area">
              <div className="logo-text">Weekly Trade History</div>
            </div>
            <div className="header-buttons">
              <button
                suppressHydrationWarning
                className={`header-btn ${currentTab === 'position' ? 'active' : ''}`}
                onClick={() => setCurrentTab('position')}
              >
                Position History
              </button>
              <button
                suppressHydrationWarning
                className={`header-btn ${currentTab === 'order' ? 'active' : ''}`}
                onClick={() => setCurrentTab('order')}
              >
                Order History
              </button>
            </div>
          </div>
          <div className="date-filter-row">
            <div className="filter-group">
              <i className="fas fa-calendar-alt"></i>
              <div className="date-input-wrapper">
                {!fromDate && <div className="date-placeholder">From</div>}
                <input
                  type="date"
                  className="date-input-compact"
                  value={fromDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setFromDate(val);
                    setAppliedFromDate(val);
                  }}
                />
              </div>
            </div>
            <span style={{ color: '#C62E2E', fontSize: '0.7rem' }}>→</span>
            <div className="filter-group">
              <i className="fas fa-calendar-alt"></i>
              <div className="date-input-wrapper">
                {!toDate && <div className="date-placeholder">To</div>}
                <input
                  type="date"
                  className="date-input-compact"
                  value={toDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setToDate(val);
                    setAppliedToDate(val);
                  }}
                />
              </div>
            </div>
            <div className="filter-buttons" style={{ marginLeft: 'auto' }}>
              <button className="filter-btn apply" onClick={handleApplyFilter}>Apply</button>
              <button className="filter-btn clear" onClick={handleClearFilter}>Clear</button>
            </div>
          </div>
        </div>

        {/* ── Desktop Page Header ── */}
        <div className="desktop-only" style={{ padding: '20px 24px 0 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Weekly Trade History</h1>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>Historical execution logs & performance</p>
            </div>
            <div className="header-buttons" style={{ display: 'flex', gap: 10, background: 'var(--bg-card)', padding: 4, borderRadius: 12, border: '1px solid var(--border-color)' }}>
              <button
                className={`header-btn ${currentTab === 'position' ? 'active' : ''}`}
                onClick={() => setCurrentTab('position')}
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                Position History
              </button>
              <button
                className={`header-btn ${currentTab === 'order' ? 'active' : ''}`}
                onClick={() => setCurrentTab('order')}
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                Order History
              </button>
            </div>
          </div>

          <div className="date-filter-row" style={{ background: 'var(--bg-card)', padding: '12px 16px', borderRadius: 12, border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 15 }}>
            <div className="filter-group">
              <i className="fas fa-calendar-alt" style={{ color: 'var(--text-secondary)' }}></i>
              <input
                type="date"
                className="date-input-compact"
                value={fromDate}
                onChange={(e) => {
                  const val = e.target.value;
                  setFromDate(val);
                  setAppliedFromDate(val);
                }}
              />
            </div>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>to</span>
            <div className="filter-group">
              <i className="fas fa-calendar-alt" style={{ color: 'var(--text-secondary)' }}></i>
              <input
                type="date"
                className="date-input-compact"
                value={toDate}
                onChange={(e) => {
                  const val = e.target.value;
                  setToDate(val);
                  setAppliedToDate(val);
                }}
              />
            </div>
            <div className="filter-buttons" style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button className="filter-btn apply" onClick={handleApplyFilter} style={{ padding: '8px 24px' }}>Apply Filter</button>
              <button className="filter-btn clear" onClick={handleClearFilter} style={{ padding: '8px 16px' }}>Reset</button>
            </div>
          </div>

          {/* ── Desktop Performance KPI Cards ── */}
          <div className="desktop-summary-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 16 }}>
            <div className="summary-card" style={{ background: 'var(--bg-card)', padding: '14px 18px', borderRadius: 12, border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <i className="fas fa-chart-bar"></i> Gross P&L
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, marginTop: 6 }} className={summary.gp - summary.gl >= 0 ? 'pnl positive' : 'pnl negative'}>
                {formatPrice(summary.gp - summary.gl)}
              </div>
            </div>
            <div className="summary-card" style={{ background: 'var(--bg-card)', padding: '14px 18px', borderRadius: 12, border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <i className="fas fa-receipt"></i> Total Brokerage
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, marginTop: 6, color: 'var(--text-primary)' }}>
                {formatPrice(summary.b)}
              </div>
            </div>
            <div className="summary-card" style={{ background: 'var(--bg-card)', padding: '14px 18px', borderRadius: 12, border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <i className="fas fa-chart-line"></i> Net P&L
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, marginTop: 6 }} className={summary.n >= 0 ? 'pnl positive' : 'pnl negative'}>
                {formatPrice(summary.n)}
              </div>
            </div>
            <div className="summary-card" style={{ background: 'var(--bg-card)', padding: '14px 18px', borderRadius: 12, border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <i className="fas fa-handshake"></i> Settlement
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, marginTop: 6, color: summary.s > 0 ? '#C62E2E' : 'var(--text-primary)' }}>
                {summary.s > 0 ? `-₹${summary.s.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '₹0.00'}
              </div>
            </div>
          </div>
        </div>

        <div className="main-content" ref={scrollResetRef}>
          <div className="history-list">
            {loading ? (
              <div style={{ padding: '60px 0', textAlign: 'center' }}>
                <AnimatedLoader text={currentTab === 'position' ? "Loading position history..." : "Loading order history..."} />
              </div>
            ) : filteredData.length === 0 ? (
              <div className="empty-history">
                <i className={currentTab === 'position' ? "fas fa-folder-open" : "fas fa-list-ul"}></i>
                <p>No history found</p>
              </div>
            ) : (
              filteredData.filter(Boolean).map((item) => {
                const itemType = (item.type || 'BUY').toLowerCase();
                const scriptName = item.scriptName || 'UNKNOWN';
                const displaySymbol = (scriptName || '').replace(/^(COMEX:|CRYPTO:|BINANCE:|FOREX:|NSE:|BSE:|MCX:|NFO:|US:|US-EQ:)/i, '');
                return (
                  <div key={item.id} className="history-card" style={{ cursor: 'pointer' }} onClick={() => router.push(`/watchlist?symbol=${encodeURIComponent(scriptName)}&action=detail`)}>
                    <div className="history-card-header">
                      <div className="script-info">
                        <span className="script-name">{displaySymbol}</span>
                        <div className="script-badges">
                          <span className={`order-type-badge ${itemType}`}>
                            {item.type || 'BUY'}
                          </span>
                          <span style={{ fontSize: '0.55rem', color: '#9AA4BF' }}>{item.orderType || 'INTRADAY'}</span>
                          {currentTab === 'order' && (
                            <span className={`order-type-badge ${String(item.status || '').toLowerCase() === 'executed' ? 'completed' : 'pending'}`}>
                              {item.status || 'unknown'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className={currentTab === 'position' ? `pnl ${item.pnl >= 0 ? 'positive' : 'negative'}` : 'price-value'}>
                        {currentTab === 'position' ? (() => {
                          const brokerage = item.brokerage || 0;
                          const isPositive = item.pnl >= 0;
                          const pctBase = item.entryPrice ? (item.pnl / (item.entryPrice * item.qty)) * 100 : 0;
                          const pctStr = pctBase.toFixed(2);
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                              <span className={isPositive ? 'positive' : 'negative'}>
                                {`${isPositive ? '+' : ''}${formatPrice(item.pnl)}`}
                              </span>
                              <span style={{ fontSize: '0.7rem', fontWeight: 600, marginTop: '2px' }}>
                                {`(${isPositive ? '+' : ''}${pctStr}%)`}
                              </span>
                              {brokerage > 0 && (
                                <span style={{ fontSize: '0.6rem', color: '#6e7681', marginTop: '1px' }}>
                                  {`Brk: -${formatPrice(brokerage)}`}
                                </span>
                              )}
                            </div>
                          );
                        })() : (
                          formatPrice(item.price)
                        )}
                      </div>
                    </div>
                    <div className="history-card-details">
                      <span className="detail-item"><i className="fas fa-layer-group"></i> {item.qty}</span>
                      {currentTab === 'position' ? (
                        <>
                          <span className="detail-item"><i className="fas fa-arrow-right"></i> {formatPrice(item.entryPrice || 0)}</span>
                          <span className="detail-item"><i className="fas fa-arrow-left"></i> {formatPrice(item.exitPrice || 0)}</span>
                          <span className="detail-item"><i className="far fa-calendar"></i> {item.exitDate}</span>
                        </>
                      ) : (
                        <>
                          <span className="detail-item"><i className="fas fa-clock"></i> {item.orderType}</span>
                          <span className="detail-item"><i className="far fa-calendar"></i> {item.date.split(' ')[0]}</span>
                        </>
                      )}
                    </div>
                    <div className="history-card-details" style={{ marginTop: '4px' }}>
                      <span className="detail-item tooltip" data-tooltip={(() => {
                        if (currentTab === 'order') {
                          const total = (item.intraday_brokerage || 0) + (item.carry_brokerage || 0) + (item.gtt_brokerage || 0);
                          if (total === 0 && (item.brokerage || 0) > 0) {
                            return item.productType === 'CARRY'
                              ? `Intraday: ₹0\nCarry: ₹${item.brokerage}\nGTT: ₹0`
                              : `Intraday: ₹${item.brokerage}\nCarry: ₹0\nGTT: ₹0`;
                          }
                          return `Intraday: ₹${item.intraday_brokerage || 0}\nCarry: ₹${item.carry_brokerage || 0}\nGTT: ₹${item.gtt_brokerage || 0}`;
                        } else {
                          const intraday = (item.entry_intraday_brokerage || 0) + (item.exit_intraday_brokerage || 0);
                          const carry = (item.entry_carry_brokerage || 0) + (item.exit_carry_brokerage || 0);
                          const gtt = (item.entry_gtt_brokerage || 0) + (item.exit_gtt_brokerage || 0);
                          if (intraday + carry + gtt === 0 && (item.brokerage || 0) > 0) {
                            return item.productType === 'CARRY'
                              ? `Intraday: ₹0\nCarry: ₹${item.brokerage}\nGTT: ₹0`
                              : `Intraday: ₹${item.brokerage}\nCarry: ₹0\nGTT: ₹0`;
                          }
                          return `Intraday: ₹${intraday}\nCarry: ₹${carry}\nGTT: ₹${gtt}`;
                        }
                      })()} style={{ position: 'relative' }}>
                        <i className="fas fa-receipt"></i> {formatPrice(getItemBrokerage(item))}
                      </span>
                      {currentTab === 'position' && (
                        <span className="detail-item" style={{ color: '#64748b', fontSize: '0.7rem' }}>
                          <i className="fas fa-handshake"></i> ₹{(item.settlementAmount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      )}
                      {currentTab === 'position' && isAdmin && item.closedBy && (
                        <span className="detail-item" style={{ color: '#64748b', fontSize: '0.7rem' }}>
                          <i className={item.closedBy === 'USER_ACTION' ? 'fas fa-user' : 'fas fa-robot'}></i> {
                            item.closedBy === 'AUTO_LIQUIDATION' ? 'Auto Sq-Off' :
                              item.closedBy === 'ADMIN_ACTION' ? 'Admin Sq-Off' :
                                item.closedBy === 'STOP_LOSS' ? 'Stop Loss' :
                                  item.closedBy === 'TARGET_HIT' ? 'Target Hit' :
                                    item.closedBy === 'SYSTEM_ACTION' ? 'System Sq-Off' :
                                      item.closedBy === 'USER_ACTION' ? 'User Exit' :
                                        item.closedBy === 'GTT_TARGET' ? 'GTT Target' :
                                          item.closedBy === 'GTT_STOP_LOSS' ? 'GTT SL' :
                                            item.closedBy
                          }
                        </span>
                      )}
                      {currentTab === 'order' && <span className="detail-item"><i className="fas fa-hourglass-half"></i> {item.date.split(' ')[1] || ''}</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Summary — in normal flow inside .history-root, sits below scrollable cards */}
        <div className="history-footer mobile-only">
          <div className="footer-row">
            <span className="footer-label"><i className="fas fa-chart-bar"></i> Gross P&L</span>
            <span className={`footer-value ${summary.gp - summary.gl >= 0 ? 'net-profit' : 'net-loss'}`}>
              {formatPrice(summary.gp - summary.gl)}
            </span>
          </div>
          <div className="footer-row">
            <span className="footer-label"><i className="fas fa-receipt"></i> Brokerage</span>
            <span className="footer-value">{formatPrice(summary.b)}</span>
          </div>
          <div className="footer-row">
            <span className="footer-label"><i className="fas fa-chart-line"></i> Net P&L</span>
            <span className={`footer-value ${summary.n >= 0 ? 'net-profit' : 'net-loss'}`}>
              {formatPrice(summary.n)}
            </span>
          </div>
          <div className="footer-row">
            <span className="footer-label"><i className="fas fa-handshake"></i> Settlement</span>
            <span className="footer-value" style={{ color: summary.s > 0 ? '#C62E2E' : 'inherit' }}>
              {summary.s > 0 ? `-₹${summary.s.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '₹0.00'}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
