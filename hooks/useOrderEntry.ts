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

    // 0. Client Pre-Flight Validation is delegated to server order engine with accurate leverage calculation

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
    if (!effectiveIsExit) {
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

    const posToClose = positionsContext?.positions?.find(p => p.id === positionId);

    // Optimistically remove position locally in 0ms
    if (positionsContext?.removePositionLocally) {
      positionsContext.removePositionLocally(positionId);
    }

    // Optimistically generate closed position and history entry for instant UI
    if (typeof window !== 'undefined' && posToClose) {
      const now = Date.now();
      const entryPrice = Number(posToClose.avg_price || posToClose.entry_price || 0);
      const exitPrice = Number(clientPrice || posToClose.current_ltp || posToClose.ltp || entryPrice);
      const qty = Number(posToClose.qty_open || posToClose.qty_total || (posToClose as any).qty || 1);
      const posSide = (posToClose.side || side || 'BUY') as 'BUY' | 'SELL';
      const pnl = (posToClose.total_pnl !== undefined && posToClose.total_pnl !== null)
        ? Number(posToClose.total_pnl)
        : (posSide === 'BUY' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty);
      const pnlPercent = (entryPrice * qty > 0) ? (pnl / (entryPrice * qty)) * 100 : 0;

      const rawSettlement = posToClose.settlement || settlement || '';
      let derivedSettlement = rawSettlement;
      if (!derivedSettlement) {
        const sym: string = (posToClose.symbol || symbol || '').toUpperCase();
        if (sym.endsWith('USDT') || sym.includes('CRYPTO')) derivedSettlement = 'Crypto';
        else if (sym.endsWith('=F') || sym.includes('COMEX')) derivedSettlement = 'COMEX';
        else if (sym.includes('MCX')) derivedSettlement = 'MCX';
        else derivedSettlement = 'NSE';
      }

      const optimisticHistoryItem = {
        id: positionId,
        scriptName: posToClose.symbol || symbol || '',
        type: posSide,
        orderType: posToClose.product_type || 'INTRADAY',
        qty,
        price: exitPrice,
        entryPrice,
        exitPrice,
        pnl,
        date: new Date(posToClose.entry_time || (posToClose as any).created_at || now).toLocaleString(),
        exitDate: new Date(now).toLocaleDateString(),
        status: 'closed',
        brokerage: Number((posToClose as any).brokerage || 0),
        closedBy: 'USER_ACTION',
        productType: posToClose.product_type || 'INTRADAY',
        settlement: derivedSettlement,
        settlementAmount: Math.abs(Number((posToClose as any).settlement_amount || 0)),
        timestamp: now,
      };

      const optimisticClosedPos = {
        ...posToClose,
        id: positionId,
        status: 'closed',
        exit_price: exitPrice,
        pnl,
        total_pnl: pnl,
        pnl_percent: pnlPercent,
        qty_total: qty,
        qty_open: 0,
        closed_at: new Date(now).toISOString(),
        exit_time: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      };

      try {
        const existingHistory = (window as any).__historyCache || [];
        const filteredHistory = existingHistory.filter((h: any) => h.id !== positionId);
        const updatedHistory = [optimisticHistoryItem, ...filteredHistory];
        (window as any).__historyCache = updatedHistory;
        localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
      } catch {}

      try {
        const existingClosed = (window as any).__closedPositionsCache || [];
        const filteredClosed = existingClosed.filter((p: any) => p.id !== positionId);
        const updatedClosed = [optimisticClosedPos, ...filteredClosed];
        (window as any).__closedPositionsCache = updatedClosed;
        localStorage.setItem('marginApex_closed_positions_persisted', JSON.stringify(updatedClosed));
      } catch {}

      window.dispatchEvent(new CustomEvent('position_closed_optimistic', {
        detail: {
          positions: [optimisticClosedPos],
          historyItems: [optimisticHistoryItem],
          position: optimisticClosedPos,
          historyItem: optimisticHistoryItem,
        }
      }));
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
        window.dispatchEvent(new Event('position_closed'));
        window.dispatchEvent(new Event('history_updated'));
      }

      return { success: true, ...result };
    } catch (err) {
      if (positionsContext?.restorePositionLocally) {
        positionsContext.restorePositionLocally(positionId);
      }
      if (typeof window !== 'undefined') {
        try {
          const existingHistory = (window as any).__historyCache || [];
          const updatedHistory = existingHistory.filter((h: any) => h.id !== positionId);
          (window as any).__historyCache = updatedHistory;
          localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
        } catch {}
        try {
          const existingClosed = (window as any).__closedPositionsCache || [];
          const updatedClosed = existingClosed.filter((p: any) => p.id !== positionId);
          (window as any).__closedPositionsCache = updatedClosed;
          localStorage.setItem('marginApex_closed_positions_persisted', JSON.stringify(updatedClosed));
        } catch {}
        window.dispatchEvent(new CustomEvent('position_closed_rollback', { detail: { positionIds: [positionId] } }));
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

    const positionsToClose = positionsContext?.positions?.filter(p => positionIds.includes(p.id)) || [];

    // Optimistically remove positions locally in 0ms
    if (positionsContext?.removePositionLocally) {
      positionIds.forEach(id => positionsContext.removePositionLocally(id));
    }

    if (typeof window !== 'undefined' && positionsToClose.length > 0) {
      const now = Date.now();
      const newHistoryItems: any[] = [];
      const newClosedPositions: any[] = [];

      for (const pos of positionsToClose) {
        const entryPrice = Number(pos.avg_price || pos.entry_price || 0);
        const exitPrice = Number(pos.current_ltp || pos.ltp || entryPrice);
        const qty = Number(pos.qty_open || pos.qty_total || (pos as any).qty || 1);
        const posSide = (pos.side || 'BUY') as 'BUY' | 'SELL';
        const pnl = (pos.total_pnl !== undefined && pos.total_pnl !== null)
          ? Number(pos.total_pnl)
          : (posSide === 'BUY' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty);
        const pnlPercent = (entryPrice * qty > 0) ? (pnl / (entryPrice * qty)) * 100 : 0;

        const rawSettlement = pos.settlement || '';
        let derivedSettlement = rawSettlement;
        if (!derivedSettlement) {
          const sym: string = (pos.symbol || '').toUpperCase();
          if (sym.endsWith('USDT') || sym.includes('CRYPTO')) derivedSettlement = 'Crypto';
          else if (sym.endsWith('=F') || sym.includes('COMEX')) derivedSettlement = 'COMEX';
          else if (sym.includes('MCX')) derivedSettlement = 'MCX';
          else derivedSettlement = 'NSE';
        }

        newHistoryItems.push({
          id: pos.id,
          scriptName: pos.symbol,
          type: posSide,
          orderType: pos.product_type || 'INTRADAY',
          qty,
          price: exitPrice,
          entryPrice,
          exitPrice,
          pnl,
          date: new Date(pos.entry_time || (pos as any).created_at || now).toLocaleString(),
          exitDate: new Date(now).toLocaleDateString(),
          status: 'closed',
          brokerage: Number((pos as any).brokerage || 0),
          closedBy: 'USER_ACTION',
          productType: pos.product_type || 'INTRADAY',
          settlement: derivedSettlement,
          settlementAmount: Math.abs(Number((pos as any).settlement_amount || 0)),
          timestamp: now,
        });

        newClosedPositions.push({
          ...pos,
          id: pos.id,
          status: 'closed',
          exit_price: exitPrice,
          pnl,
          total_pnl: pnl,
          pnl_percent: pnlPercent,
          qty_total: qty,
          qty_open: 0,
          closed_at: new Date(now).toISOString(),
          exit_time: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        });
      }

      try {
        const existingHistory = (window as any).__historyCache || [];
        const existingIdSet = new Set(positionIds);
        const updatedHistory = [...newHistoryItems, ...existingHistory.filter((h: any) => !existingIdSet.has(h.id))];
        (window as any).__historyCache = updatedHistory;
        localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
      } catch {}

      try {
        const existingClosed = (window as any).__closedPositionsCache || [];
        const existingIdSet = new Set(positionIds);
        const updatedClosed = [...newClosedPositions, ...existingClosed.filter((p: any) => !existingIdSet.has(p.id))];
        (window as any).__closedPositionsCache = updatedClosed;
        localStorage.setItem('marginApex_closed_positions_persisted', JSON.stringify(updatedClosed));
      } catch {}

      window.dispatchEvent(new CustomEvent('position_closed_optimistic', {
        detail: {
          positions: newClosedPositions,
          historyItems: newHistoryItems,
          position: newClosedPositions[0],
          historyItem: newHistoryItems[0],
        }
      }));
    }

    try {
      const result = await api.post<Record<string, unknown>>('/api/positions/close', { positionIds }, { timeout: 20000 });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed'));
        window.dispatchEvent(new Event('position_closed'));
        window.dispatchEvent(new Event('history_updated'));
      }

      return { success: true, ...result };
    } catch (err) {
      if (positionsContext?.restorePositionLocally) {
        positionIds.forEach(id => positionsContext.restorePositionLocally(id));
      }
      if (typeof window !== 'undefined') {
        const existingIdSet = new Set(positionIds);
        try {
          const existingHistory = (window as any).__historyCache || [];
          const updatedHistory = existingHistory.filter((h: any) => !existingIdSet.has(h.id));
          (window as any).__historyCache = updatedHistory;
          localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
        } catch {}
        try {
          const existingClosed = (window as any).__closedPositionsCache || [];
          const updatedClosed = existingClosed.filter((p: any) => !existingIdSet.has(p.id));
          (window as any).__closedPositionsCache = updatedClosed;
          localStorage.setItem('marginApex_closed_positions_persisted', JSON.stringify(updatedClosed));
        } catch {}
        window.dispatchEvent(new CustomEvent('position_closed_rollback', { detail: { positionIds } }));
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
