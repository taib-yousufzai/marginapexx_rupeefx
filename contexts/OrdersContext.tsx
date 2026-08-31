'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { MyOrder } from '@/lib/types/order';
import { api, ApiError } from '@/lib/api';
import { getSharedSessionSync } from '@/lib/sharedSession';

export interface OrdersContextType {
  orders: MyOrder[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  cancelOrder: (id: string) => Promise<{ success: boolean; error?: string }>;
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
      globalOrdersCache = data.orders ?? [];
      setOrders(globalOrdersCache);
      setError(null);
    } catch (err) {
      console.error('[OrdersContext] Failed to fetch orders:', err);
      if (globalOrdersCache.length === 0) {
        if (err instanceof ApiError) {
          setError(`API error ${err.status}`);
        } else {
          setError('Network error loading orders');
        }
      }
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
      );
      
    channel.subscribe((status) => {
      isSubscribed = status === 'SUBSCRIBED';
    });

    // Refresh whenever any component places an order or closes a position
    const handleOrderPlaced = () => fetchOrders();
    window.addEventListener('order_placed', handleOrderPlaced);
    window.addEventListener('position-closed', handleOrderPlaced);
    window.addEventListener('position_closed', handleOrderPlaced);
    window.addEventListener('order_executed', handleOrderPlaced);

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
        fetchOrders();
      }, refreshInterval);
    }

    init();

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      supabase.removeChannel(channel);
      window.removeEventListener('order_placed', handleOrderPlaced);
      window.removeEventListener('position-closed', handleOrderPlaced);
      window.removeEventListener('position_closed', handleOrderPlaced);
      window.removeEventListener('order_executed', handleOrderPlaced);
    };
  }, [fetchOrders, refreshInterval]);


  const cancelOrder = useCallback(async (id: string) => {
    try {
      await api.patch(`/api/orders/${id}`, { status: 'CANCELLED' });
      await fetchOrders(); // Refresh list
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }, [fetchOrders]);

  return (
    <OrdersDataContext.Provider value={{ orders, loading, error, refresh: fetchOrders, cancelOrder }}>
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
