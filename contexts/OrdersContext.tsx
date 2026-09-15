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

let globalOrdersCache: MyOrder[] = [];

export const OrdersDataProvider = ({ children, refreshInterval = 5000 }: { children: React.ReactNode; refreshInterval?: number }) => {
  const [orders, setOrders] = useState<MyOrder[]>(globalOrdersCache);
  const [loading, setLoading] = useState(globalOrdersCache.length === 0);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await api.get<{ orders: MyOrder[] }>('/api/orders?limit=100');
      const fetchedOrders = data.orders ?? [];

      setOrders(prev => {
        const fetchedIds = new Set(fetchedOrders.map(o => o.id));
        const now = Date.now();

        // Preserve SUBMITTING orders and recent local orders (< 8s old) not yet in DB read response
        const pendingLocalOrders = prev.filter(o => {
          if (fetchedIds.has(o.id)) return false;
          if (o.status === 'SUBMITTING') return true;
          const createdTime = new Date(o.created_at || now).getTime();
          const age = now - (isNaN(createdTime) ? now : createdTime);
          return age < 8000;
        });

        const merged = [...pendingLocalOrders, ...fetchedOrders];
        globalOrdersCache = merged;
        return merged;
      });
      setError(null);
    } catch (err) {
      console.warn('[OrdersContext] Transient error fetching orders:', err);
      // Retain existing orders cache and suppress UI error banner
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

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
    const handleOrderPlaced = () => fetchOrders();
    const handleOrderExecuted = () => {
      soundEngine.playOrderExecuted();
      fetchOrders();
    };
    window.addEventListener('order_placed', handleOrderPlaced);
    window.addEventListener('position-closed', handleOrderPlaced);
    window.addEventListener('position_closed', handleOrderPlaced);
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
          fetchOrders();
        }
      }, Math.max(refreshInterval, 8000));
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
      globalOrdersCache = newOrders;
      return newOrders;
    });
  }, []);

  const addOptimisticOrder = useCallback((optimisticOrder: MyOrder) => {
    setOrders(prev => {
      const newOrders = [optimisticOrder, ...prev];
      globalOrdersCache = newOrders;
      return newOrders;
    });
  }, []);

  const removeOptimisticOrder = useCallback((tempId: string) => {
    setOrders(prev => {
      const newOrders = prev.filter(o => o.id !== tempId);
      globalOrdersCache = newOrders;
      return newOrders;
    });
  }, []);

  const swapOptimisticOrder = useCallback((tempId: string, realOrder: MyOrder) => {
    setOrders(prev => {
      const newOrders = prev.map(o => (o.id === tempId ? realOrder : o));
      globalOrdersCache = newOrders;
      return newOrders;
    });
  }, []);

  const cancelOrder = useCallback(async (id: string) => {
    let previousOrder: MyOrder | undefined;

    // 1. Optimistically mark order as CANCELLED in 0ms
    setOrders(prev => {
      previousOrder = prev.find(o => o.id === id);
      if (!previousOrder) return prev;
      const newOrders = prev.map(o => (o.id === id ? { ...o, status: 'CANCELLED' as const } : o));
      globalOrdersCache = newOrders;
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
    } catch (err) {
      // 2. Rollback to original order snapshot on failure
      if (previousOrder) {
        const snap = previousOrder;
        setOrders(prev => {
          const restored = prev.map(o => (o.id === id ? snap : o));
          globalOrdersCache = restored;
          return restored;
        });
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }, [fetchOrders]);

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
    throw new Error('useOrdersData must be used within an OrdersDataProvider');
  }
  return context;
};
