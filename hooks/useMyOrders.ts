/**
 * useMyOrders
 *
 * Exposes internal platform orders, refactored to consume the global OrdersContext.
 */

'use client';

import { useOrdersData } from '@/contexts/OrdersContext';
import type { MyOrder } from '@/lib/types/order';

interface UseMyOrdersResult {
  orders:  MyOrder[];
  loading: boolean;
  error:   string | null;
  refresh: () => void;
  cancelOrder: (id: string) => Promise<{ success: boolean; error?: string }>;
  updateOrderLocally: (updatedOrder: MyOrder) => void;
}

export function useMyOrders(refreshInterval?: number): UseMyOrdersResult {
  return useOrdersData();
}
