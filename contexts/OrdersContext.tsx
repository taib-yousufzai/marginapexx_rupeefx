'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { MyOrder } from '@/lib/types/order';
import { api, ApiError } from '@/lib/api';
import { getSharedSessionSync } from '@/lib/sharedSession';

import { soundEngine } from '@/lib/audio';

export interface OrdersContextType {
  orders: MyOrder[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  cancelOrder: (id: string) => Promise<{ success: boolean; error?: string }>;
  updateOrderLocally: (updatedOrder: MyOrder) => void;
  addOptimisticOrder: (order: MyOrder) => void;
  removeOptimisticOrder: (tempId: string) => void;
  swapOptimisticOrder: (tempId: string, realOrder: MyOrder) => void;
}

const OrdersDataContext = createContext<OrdersContextType | null>(null);

const ORDERS_PERSIST_KEY = 'marginApex_orders_persisted';
const OPTIMISTIC_ORDERS_PERSIST_KEY = 'marginApex_optimistic_orders_persisted';
const OPTIMISTIC_ORDER_REMOVALS_KEY = 'marginApex_optimistic_order_removals_persisted';

let globalOrdersCache: MyOrder[] = [];

function getPersistedOptimisticOrders(): MyOrder[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OPTIMISTIC_ORDERS_PERSIST_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.filter((o: any) => {
      const createdTime = (o as any).created_time_ms || (o.created_at ? new Date(o.created_at).getTime() : 0);
      return createdTime > 0 && (now - createdTime < 25000);
    });
  } catch {
    return [];
  }
}

function savePersistedOptimisticOrders(orders: MyOrder[]) {
  if (typeof window === 'undefined') return;
  try {
    const optList = orders.filter(o => o.id.startsWith('opt_') || o.id.startsWith('__optimistic__') || o.status === 'SUBMITTING');
    if (optList.length === 0) {
      localStorage.removeItem(OPTIMISTIC_ORDERS_PERSIST_KEY);
    } else {
      localStorage.setItem(OPTIMISTIC_ORDERS_PERSIST_KEY, JSON.stringify(optList));
    }
  } catch { }
}

function getPersistedOptimisticRemovals(): Map<string, number> {
  const map = new Map<string, number>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = localStorage.getItem(OPTIMISTIC_ORDER_REMOVALS_KEY);
    if (!raw) return map;
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [id, ts] of Object.entries(obj)) {
      const timeMs = Number(ts);
      if (now - timeMs < 25000) {
        map.set(id, timeMs);
      }
    }
  } catch { }
  return map;
}

function savePersistedOptimisticRemovals(removals: Map<string, number>) {
  if (typeof window === 'undefined') return;
  try {
    if (removals.size === 0) {
      localStorage.removeItem(OPTIMISTIC_ORDER_REMOVALS_KEY);
    } else {
      const obj: Record<string, number> = {};
      for (const [id, ts] of removals.entries()) {
        obj[id] = ts;
      }
      localStorage.setItem(OPTIMISTIC_ORDER_REMOVALS_KEY, JSON.stringify(obj));
    }
  } catch { }
}

export const OrdersDataProvider = ({ children, refreshInterval = 5000 }: { children: React.ReactNode; refreshInterval?: number }) => {
  const [orders, setOrders] = useState<MyOrder[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(ORDERS_PERSIST_KEY);
        const optOrders = getPersistedOptimisticOrders();
        const removals = getPersistedOptimisticRemovals();
        let list: MyOrder[] = [];
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) list = parsed;
        }
        list = list.filter(o => !removals.has(o.id));
        const mergedMap = new Map<string, MyOrder>();
        for (const o of optOrders) mergedMap.set(o.id, o);
        for (const o of list) {
          if (!mergedMap.has(o.id)) mergedMap.set(o.id, o);
        }
        const initialList = Array.from(mergedMap.values());
        globalOrdersCache = initialList;
        return initialList;
      } catch { }
    }
    return globalOrdersCache;
  });
  const [loading, setLoading] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(ORDERS_PERSIST_KEY);
        const optOrders = getPersistedOptimisticOrders();
        if (stored || optOrders.length > 0) return false;
      } catch { }
    }
    return globalOrdersCache.length === 0;
  });
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const saveOrdersToCache = useCallback((newOrders: MyOrder[]) => {
    globalOrdersCache = newOrders;
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(ORDERS_PERSIST_KEY, JSON.stringify(newOrders));
      } catch { }
    }
  }, []);

  const fetchOrders = useCallback(async (options?: { fresh?: boolean }) => {
    try {
      const url = options?.fresh ? '/api/orders?limit=100&fresh=true' : '/api/orders?limit=100';
      const data = await api.get<{ orders: MyOrder[] }>(url);
      const fetchedOrders = data.orders ?? [];

      setOrders(prev => {
        const fetchedIds = new Set(fetchedOrders.map(o => o.id));
        const now = Date.now();
        const persistedOpt = getPersistedOptimisticOrders();
        const removals = getPersistedOptimisticRemovals();

        // Combine previous in-memory state with persisted optimistic orders
        const allCurrent = [...persistedOpt, ...prev];

        const activeLocalOrders = allCurrent.filter(o => {
          if (removals.has(o.id)) return false;
          if (fetchedIds.has(o.id)) return false;
          if (o.status === 'SUBMITTING') return true;
          const createdTime = (o as any).created_time_ms || (o.created_at ? new Date(o.created_at).getTime() : 0);
          const age = now - (isNaN(createdTime) ? now : createdTime);
          return age < 25000 && (o.id.startsWith('opt_') || o.id.startsWith('__optimistic__') || o.status === 'SUBMITTING');
        });

        // Dedup by ID
        const mergedMap = new Map<string, MyOrder>();
        for (const o of activeLocalOrders) {
          mergedMap.set(o.id, o);
        }
        for (const o of fetchedOrders) {
          if (!removals.has(o.id)) {
            mergedMap.set(o.id, o);
          }
        }

        const merged = Array.from(mergedMap.values());
        saveOrdersToCache(merged);
        savePersistedOptimisticOrders(merged);
        return merged;
      });
      setError(null);
    } catch (err: any) {
      if (err?.name !== 'AbortError' && !err?.message?.includes('aborted')) {
        console.warn('[OrdersContext] Transient error fetching orders:', err);
      }
      // Retain existing orders cache and suppress UI error banner
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [saveOrdersToCache]);

  useEffect(() => {
    let cancelled = false;
    let isSubscribed = false;
    const channelName = `my-orders-realtime-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => {
          fetchOrders();
        }
      )
      // Also listen to positions table — virtual SL/Target pending orders are
      // generated from open positions, so a new/updated position must trigger a refresh.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        () => {
          fetchOrders();
        }
      );

    channel.subscribe((status) => {
      isSubscribed = status === 'SUBSCRIBED';
    });

    // Refresh whenever any component places an order or closes a position
    const handleOrderPlaced = () => fetchOrders({ fresh: true });
    const handleOrderExecuted = () => {
      soundEngine.playOrderExecuted();
      fetchOrders({ fresh: true });
    };
    const handlePositionClosed = (e: any) => {
      const posList = e?.detail?.positions || (e?.detail?.position ? [e.detail.position] : []);
      const posIds = new Set(posList.map((p: any) => p.id));
      if (posIds.size > 0) {
        setOrders(prev => {
          const filtered = prev.filter(o => {
            if (o.id.startsWith('pos-')) {
              const linkedId = o.id.replace('pos-sl-', '').replace('pos-target-', '').replace('pos-gtt-', '');
              if (posIds.has(linkedId) || (o.linked_position_id && posIds.has(o.linked_position_id))) return false;
            }
            return true;
          });
          saveOrdersToCache(filtered);
          return filtered;
        });
      }
      fetchOrders({ fresh: true });
    };

    window.addEventListener('order_placed', handleOrderPlaced);
    window.addEventListener('position-closed', handlePositionClosed);
    window.addEventListener('position_closed', handlePositionClosed);
    window.addEventListener('position_closed_optimistic', handlePositionClosed);
    window.addEventListener('order_executed', handleOrderExecuted);

    async function init() {
      // Wait for a valid session before fetching — prevents a 401 flash on
      // first load when Supabase hasn't yet restored the session from storage.
      const { token } = getSharedSessionSync();
      if (!token) {
        setLoading(false);
        return;
      }
      if (cancelled) return;
      await fetchOrders();
      if (cancelled) return;
      intervalRef.current = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          fetchOrders({ fresh: true });
        }
      }, Math.max(refreshInterval, 3000));
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchOrders();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    init();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (intervalRef.current) clearInterval(intervalRef.current);
      supabase.removeChannel(channel);
      window.removeEventListener('order_placed', handleOrderPlaced);
      window.removeEventListener('position-closed', handleOrderPlaced);
      window.removeEventListener('position_closed', handleOrderPlaced);
      window.removeEventListener('order_executed', handleOrderPlaced);
    };
  }, [fetchOrders, refreshInterval]);


  const updateOrderLocally = useCallback((updatedOrder: MyOrder) => {
    setOrders(prev => {
      const exists = prev.some(o => o.id === updatedOrder.id);
      const newOrders = exists
        ? prev.map(o => (o.id === updatedOrder.id ? { ...o, ...updatedOrder } : o))
        : [updatedOrder, ...prev];
      saveOrdersToCache(newOrders);
      savePersistedOptimisticOrders(newOrders);
      return newOrders;
    });
  }, [saveOrdersToCache]);

  const addOptimisticOrder = useCallback((optimisticOrder: MyOrder) => {
    setOrders(prev => {
      const orderWithTimestamp = {
        ...optimisticOrder,
        created_time_ms: Date.now(),
      };
      const newOrders = [orderWithTimestamp, ...prev.filter(o => o.id !== optimisticOrder.id)];
      saveOrdersToCache(newOrders);
      savePersistedOptimisticOrders(newOrders);
      return newOrders;
    });
  }, [saveOrdersToCache]);

  const removeOptimisticOrder = useCallback((tempId: string) => {
    setOrders(prev => {
      const newOrders = prev.filter(o => o.id !== tempId);
      saveOrdersToCache(newOrders);
      savePersistedOptimisticOrders(newOrders);
      return newOrders;
    });
  }, [saveOrdersToCache]);

  const swapOptimisticOrder = useCallback((tempId: string, realOrder: MyOrder) => {
    setOrders(prev => {
      const newOrders = prev.map(o => (o.id === tempId ? realOrder : o));
      saveOrdersToCache(newOrders);
      savePersistedOptimisticOrders(newOrders);
      const removals = getPersistedOptimisticRemovals();
      removals.set(tempId, Date.now());
      savePersistedOptimisticRemovals(removals);
      return newOrders;
    });
  }, [saveOrdersToCache]);

  const cancelOrder = useCallback(async (id: string) => {
    let previousOrder: MyOrder | undefined;

    // Handle local optimistic order cancel immediately
    if (id.startsWith('opt_') || id.startsWith('__optimistic__')) {
      removeOptimisticOrder(id);
      const removals = getPersistedOptimisticRemovals();
      removals.set(id, Date.now());
      savePersistedOptimisticRemovals(removals);
      return { success: true };
    }

    // 1. Optimistically mark order as CANCELLED in 0ms
    setOrders(prev => {
      previousOrder = prev.find(o => o.id === id);
      if (!previousOrder) return prev;
      const newOrders = prev.map(o => (o.id === id ? { ...o, status: 'CANCELLED' as const } : o));
      saveOrdersToCache(newOrders);
      return newOrders;
    });

    try {
      await api.patch(`/api/orders/${id}`, { status: 'CANCELLED' });
      await fetchOrders(); // Reconcile list
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('order_cancelled'));
        window.dispatchEvent(new Event('history_updated'));
      }
      return { success: true };
    } catch (err: any) {
      const message = err?.message || (typeof err === 'object' && err?.error ? String(err.error) : 'Unknown error');
      const isAlreadyHandled = message.toLowerCase().includes('already') || message.toLowerCase().includes('not found');

      if (isAlreadyHandled) {
        // Do NOT rollback to pending if it's already executed/cancelled or pruned
        const removals = getPersistedOptimisticRemovals();
        removals.set(id, Date.now());
        savePersistedOptimisticRemovals(removals);
        await fetchOrders();
        return { success: true };
      }

      // 2. Rollback to original order snapshot on actual unexpected failure
      if (previousOrder) {
        const snap = previousOrder;
        setOrders(prev => {
          const restored = prev.map(o => (o.id === id ? snap : o));
          saveOrdersToCache(restored);
          return restored;
        });
      }
      return { success: false, error: message };
    }
  }, [fetchOrders, removeOptimisticOrder, saveOrdersToCache]);

  return (
    <OrdersDataContext.Provider value={{
      orders,
      loading,
      error,
      refresh: fetchOrders,
      cancelOrder,
      updateOrderLocally,
      addOptimisticOrder,
      removeOptimisticOrder,
      swapOptimisticOrder,
    }}>
      {children}
    </OrdersDataContext.Provider>
  );
};

export const useOrdersData = () => {
  const context = useContext(OrdersDataContext);
  if (!context) {
    return {
      orders: [],
      loading: false,
      error: null,
      refresh: async () => {},
      cancelOrder: async () => ({ success: false, error: 'Context not initialized' }),
      updateOrderLocally: () => {},
      addOptimisticOrder: () => '',
      removeOptimisticOrder: () => {},
      swapOptimisticOrder: () => {},
    };
  }
  return context;
};
