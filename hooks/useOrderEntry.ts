/**
 * useOrderEntry
 * 
 * Manages the state and logic for placing an order through the MarginApex platform.
 */

import { useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { soundEngine } from '@/lib/audio';
import { useOrdersData } from '@/contexts/OrdersContext';
import { useBalanceData } from '@/contexts/BalanceContext';
import { usePositionsData, cleanSym } from '@/contexts/PositionsContext';
import type { MyOrder } from '@/lib/types/order';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT';
export type ProductType = 'INTRADAY' | 'CARRY';

export interface OrderEntryState {
  symbol: string;
  kite_instrument: string;
  segment: string;
  side: OrderSide;
  qty: number;
  lots: number;
  order_type: OrderType;
  product_type: ProductType;
  client_price: number;
  frontend_ask?: number;
  frontend_bid?: number;
  frontend_ltp?: number;
  client_click_time?: number;
  trigger_price?: number;
  stop_loss?: number;
  target?: number;
  is_exit?: boolean;
  linked_position_id?: string | null;
  orderAttemptId?: string;
}

export function useOrderEntry() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Softly obtain context hooks if rendered within providers
  let ordersContext: ReturnType<typeof useOrdersData> | null = null;
  let balanceContext: ReturnType<typeof useBalanceData> | null = null;
  let positionsContext: ReturnType<typeof usePositionsData> | null = null;
  try { ordersContext = useOrdersData(); } catch { }
  try { balanceContext = useBalanceData(); } catch { }
  try { positionsContext = usePositionsData(); } catch { }

  const placeOrder = useCallback(async (state: OrderEntryState) => {
    setLoading(true);
    setError(null);

    // 0. Client 0ms Pre-Flight Validation
    if (balanceContext && typeof (balanceContext as any).validatePreflight === 'function' && state.client_price && state.qty) {
      const estimatedMargin = state.client_price * state.qty;
      const check = (balanceContext as any).validatePreflight(estimatedMargin);
      if (check && !check.valid && check.reason) {
        soundEngine.playOrderRejected();
        setError(check.reason);
        setLoading(false);
        return { success: false, error: check.reason };
      }
    }

    // 1. Two-stage optimistic UI: create a pending submission order in <16ms
    const tempId = `opt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const optimisticOrder: MyOrder = {
      id: tempId,
      symbol: state.symbol,
      kite_instrument: state.kite_instrument,
      segment: state.segment || 'NSE',
      side: state.side,
      status: 'SUBMITTING',
      qty: state.qty,
      lots: state.lots || 1,
      fill_price: state.client_price,
      ltp_at_entry: state.client_price,
      order_type: state.order_type,
      product_type: state.product_type,
      info: null,
      client_price: state.client_price,
      brokerage: 0,
      created_at: new Date().toISOString(),
    };

    if (ordersContext?.addOptimisticOrder) {
      ordersContext.addOptimisticOrder(optimisticOrder);
    }

    // Auto-detect if user has an existing opposite-side position for this symbol
    const oppositeSide = state.side === 'BUY' ? 'SELL' : 'BUY';
    const targetClean = cleanSym(state.symbol || state.kite_instrument || '');
    const matchingOppositePos = positionsContext?.positions?.find(
      p => cleanSym(p.symbol || p.kite_instrument) === targetClean &&
           p.side === oppositeSide &&
           (p.status === 'open' || p.status === 'active' || !p.status)
    );
    const effectiveIsExit = Boolean(state.is_exit || matchingOppositePos);
    const effectiveLinkedPosId = state.linked_position_id || matchingOppositePos?.id || undefined;

    // Optimistically add position if entry order, or remove/reduce if exit order
    const estimatedMargin = (state.client_price && state.qty) ? state.client_price * state.qty : 0;
    if (!effectiveIsExit) {
      if (estimatedMargin > 0 && balanceContext?.lockOptimisticMargin) {
        balanceContext.lockOptimisticMargin(estimatedMargin, tempId);
      }
      if (positionsContext?.addOptimisticPosition) {
        positionsContext.addOptimisticPosition({
          symbol: state.symbol,
          settlement: state.segment,
          side: state.side,
          qty_open: state.qty,
          entry_price: state.client_price,
          ltp: state.client_price,
          product_type: state.product_type,
          kite_instrument: state.kite_instrument,
          opt_id: tempId,
        } as any);
      }
    } else if (effectiveIsExit) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('order_placed_with_data', {
          detail: {
            symbol: state.symbol,
            settlement: state.segment,
            side: state.side,
            qty: state.qty,
            qty_open: state.qty,
            entry_price: state.client_price,
            ltp: state.client_price,
            product_type: state.product_type,
            is_exit: true,
            linked_position_id: effectiveLinkedPosId,
            opt_id: tempId,
          }
        }));
      }
    }

    soundEngine.playOrderSubmitted();

    try {
      // Direct fast API dispatch (25000ms max timeout to prevent premature abort race conditions)
      const submitPayload = {
        ...state,
        is_exit: effectiveIsExit,
        linked_position_id: effectiveLinkedPosId,
      };
      const result = await api.post<{ order_id: string; status: string; fill_price: number; message: string }>('/api/orders', submitPayload, { timeout: 25000 });

      if (balanceContext?.releaseOptimisticMargin) {
        balanceContext.releaseOptimisticMargin(tempId);
      }

      // Create confirmed order representation
      const confirmedOrder: MyOrder = {
        ...optimisticOrder,
        id: result.order_id || tempId,
        status: (result.status as any) || 'EXECUTED',
        fill_price: result.fill_price || state.client_price,
      };

      if (ordersContext?.swapOptimisticOrder) {
        ordersContext.swapOptimisticOrder(tempId, confirmedOrder);
      }
      soundEngine.playOrderExecuted();

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('order_placed_with_data', {
          detail: {
            symbol: state.symbol,
            settlement: state.segment,
            side: state.side,
            qty_open: state.qty,
            entry_price: result.fill_price || state.client_price,
            ltp: result.fill_price || state.client_price,
            product_type: state.product_type,
            is_exit: effectiveIsExit,
            linked_position_id: effectiveLinkedPosId,
            opt_id: tempId,
          }
        }));
        window.dispatchEvent(new Event('order_placed'));
      }

      return { success: true, order: result, fill_price: result.fill_price };
    } catch (err) {
      if (balanceContext?.releaseOptimisticMargin) {
        balanceContext.releaseOptimisticMargin(tempId);
      }

      let message = 'Unknown error';
      if (err instanceof ApiError) {
        if (typeof err.details === 'string' && err.details.trim()) {
          message = err.details;
        } else if (err.details && typeof err.details === 'object') {
          const d = err.details as { details?: string; error?: string; message?: string };
          message = d.error || d.details || d.message || `ApiError ${err.status}`;
        } else {
          message = `ApiError ${err.status}`;
        }
      } else if (err instanceof Error || (err && typeof err === 'object' && 'name' in err)) {
        const errName = (err as any).name;
        const errMessage = (err as any).message || String(err);
        if (errName === 'AbortError' || errMessage.includes('abort')) {
          message = 'Order submission processing in background. Please check Order Book / Positions.';
        } else if (errMessage.includes('NetworkError') || errMessage.includes('Failed to fetch')) {
          message = 'Network connection error. Please try again.';
        } else {
          message = errMessage;
        }
      }

      const isBackgroundProcessing = message.includes('processing in background') || message.includes('in progress') || (err instanceof ApiError && err.status === 409);

      if (!isBackgroundProcessing) {
        // Rollback optimistic order on actual error
        if (ordersContext?.removeOptimisticOrder) {
          ordersContext.removeOptimisticOrder(tempId);
        }
        if (state.is_exit && positionsContext?.restorePositionLocally) {
          positionsContext.restorePositionLocally(state.linked_position_id || '');
        } else if (!state.is_exit && positionsContext?.removeOptimisticPosition) {
          positionsContext.removeOptimisticPosition(tempId);
        }
        soundEngine.playOrderRejected();
      }

      console.warn('[useOrderEntry] Order placement status:', message);
      setError(message);
      return { success: !isBackgroundProcessing, isProcessing: isBackgroundProcessing, error: message };
    } finally {
      setLoading(false);
    }
  }, [ordersContext, balanceContext, positionsContext]);

  const closePosition = useCallback(async (positionId: string, clientPrice?: number, symbol?: string, settlement?: string, side?: string) => {
    setLoading(true);
    setError(null);

    // Optimistically remove position locally in 0ms
    if (positionsContext?.removePositionLocally) {
      positionsContext.removePositionLocally(positionId);
    }

    try {
      const result = await api.post<Record<string, unknown>>(`/api/positions/${positionId}/close`, {
        client_price: clientPrice,
        symbol,
        settlement,
        side
      }, { timeout: 20000 });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed')); // Backward compatibility for some components
      }

      return { success: true, ...result };
    } catch (err) {
      if (positionsContext?.restorePositionLocally) {
        positionsContext.restorePositionLocally(positionId);
      }
      let message = 'Unknown error';
      if (err instanceof ApiError) {
        message = (err.details as { error?: string } | null)?.error ?? err.message ?? `ApiError ${err.status}`;
      } else if (err instanceof Error || (err && typeof err === 'object' && 'name' in err)) {
        const errName = (err as any).name;
        const errMessage = (err as any).message || String(err);
        if (errName === 'AbortError' || errMessage.includes('abort')) {
          message = 'Position exit timed out. Please try again.';
        } else if (errMessage.includes('NetworkError') || errMessage.includes('Failed to fetch')) {
          message = 'Network connection error. Please try again.';
        } else {
          message = errMessage;
        }
      }
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [positionsContext]);

  const closePositionsBatch = useCallback(async (positionIds: string[]) => {
    setLoading(true);
    setError(null);

    // Optimistically remove positions locally in 0ms
    if (positionsContext?.removePositionLocally) {
      positionIds.forEach(id => positionsContext.removePositionLocally(id));
    }

    try {
      const result = await api.post<Record<string, unknown>>('/api/positions/close', { positionIds }, { timeout: 20000 });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed'));
      }

      return { success: true, ...result };
    } catch (err) {
      if (positionsContext?.restorePositionLocally) {
        positionIds.forEach(id => positionsContext.restorePositionLocally(id));
      }
      let message = 'Unknown error';
      if (err instanceof ApiError) {
        message = (err.details as { error?: string } | null)?.error ?? `ApiError ${err.status}`;
      } else if (err instanceof Error || (err && typeof err === 'object' && 'name' in err)) {
        const errName = (err as any).name;
        const errMessage = (err as any).message || String(err);
        if (errName === 'AbortError' || errMessage.includes('abort')) {
          message = 'Batch position exit timed out. Please try again.';
        } else if (errMessage.includes('NetworkError') || errMessage.includes('Failed to fetch')) {
          message = 'Network connection error. Please try again.';
        } else {
          message = errMessage;
        }
      }
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [positionsContext]);

  return {
    placeOrder,
    closePosition,
    closePositionsBatch,
    loading,
    error,
    setError
  };
}
