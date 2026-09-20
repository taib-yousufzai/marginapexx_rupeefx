/**
 * useOrderEntry
 * 
 * Manages the state and logic for placing an order through the MarginApex platform.
 */

import { useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { wsManager } from '@/contexts/MarketDataContext';
import { soundEngine } from '@/lib/audio';
import { useOrdersData } from '@/contexts/OrdersContext';
import { useBalanceData } from '@/contexts/BalanceContext';
import { usePositionsData, cleanSym } from '@/contexts/PositionsContext';
import { fmtDateTime, fmtDate } from '@/lib/format';
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
      created_time_ms: Date.now(),
    } as any;

    if (ordersContext?.addOptimisticOrder) {
      ordersContext.addOptimisticOrder(optimisticOrder);
    }

    // Auto-detect if user has an existing opposite-side position for this symbol
    const oppositeSide = (state.side || 'BUY').toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    const targetClean = cleanSym(state.symbol || state.kite_instrument || '');
    const contextPositions = positionsContext?.positions || [];
    const cachedPositionsMap = (typeof window !== 'undefined' && (window as any).__lastPositionsMap)
      ? Array.from((window as any).__lastPositionsMap.values() as Iterable<any>)
      : [];
    const allPositionsPool = [...contextPositions];
    for (const cp of cachedPositionsMap) {
      if (!allPositionsPool.some(p => p.id === cp.id)) {
        allPositionsPool.push(cp);
      }
    }

    const matchingOppositePositions = allPositionsPool.filter(
      p => {
        if (state.linked_position_id && p.id === state.linked_position_id) return true;
        const pStatus = (p.status || '').toLowerCase();
        const isOpen = !pStatus || pStatus === 'open' || pStatus === 'active';
        const pSide = (p.side || '').toUpperCase();
        return cleanSym(p.symbol || p.kite_instrument || '') === targetClean &&
               pSide === oppositeSide &&
               isOpen;
      }
    );
    const matchingOppositePos = matchingOppositePositions[0];
    const effectiveIsExit = Boolean(state.is_exit || matchingOppositePositions.length > 0);
    const effectiveLinkedPosId = state.linked_position_id || (matchingOppositePositions.length === 1 && (Number(matchingOppositePos?.qty_open || matchingOppositePos?.qty_total || 0) >= (state.qty || 1)) ? matchingOppositePos.id : undefined);

    const now = Date.now();
    const optimisticHistoryOrder = {
      id: tempId,
      scriptName: state.symbol,
      type: state.side,
      orderType: state.order_type || 'MARKET',
      qty: state.qty,
      price: state.client_price || 0,
      pnl: 0,
      date: new Date(now).toLocaleString(),
      status: 'EXECUTED',
      brokerage: 0,
      timestamp: now,
    };

    if (typeof window !== 'undefined') {
      try {
        const existingHistory = (window as any).__historyCache || [];
        const updatedHistory = [optimisticHistoryOrder, ...existingHistory.filter((h: any) => h.id !== tempId)];
        (window as any).__historyCache = updatedHistory;
        localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
      } catch {}
      window.dispatchEvent(new CustomEvent('order_placed_optimistic', { detail: { order: optimisticOrder } }));
    }

    const optimisticClosedPositions: any[] = [];
    const optimisticHistoryItems: any[] = [];

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
      if (matchingOppositePositions.length > 0) {
        let remExit = state.qty || 1;
        const sortedMatching = [...matchingOppositePositions].sort((a, b) => {
          if (effectiveLinkedPosId) {
            if (a.id === effectiveLinkedPosId) return -1;
            if (b.id === effectiveLinkedPosId) return 1;
          }
          return 0;
        });

        let totalClosedQty = 0;
        let weightedEntrySum = 0;
        let totalPnl = 0;
        let totalBrokerage = 0;
        let totalSettlementAmount = 0;
        let derivedSettlement = '';

        for (const p of sortedMatching) {
          if (remExit <= 0) break;
          const entryPrice = Number(p.avg_price || p.entry_price || 0);
          const exitPrice = Number(state.client_price || p.current_ltp || p.ltp || entryPrice);
          const curQty = Number(p.qty_open || p.qty_total || (p as any).qty || 1);
          const closedQty = Math.min(curQty, remExit);
          remExit -= closedQty;

          const posSide = (p.side || 'BUY') as 'BUY' | 'SELL';
          const pnl = posSide === 'BUY' ? (exitPrice - entryPrice) * closedQty : (entryPrice - exitPrice) * closedQty;
          const pnlPercent = (entryPrice * closedQty > 0) ? (pnl / (entryPrice * closedQty)) * 100 : 0;

          totalClosedQty += closedQty;
          weightedEntrySum += entryPrice * closedQty;
          totalPnl += pnl;
          totalBrokerage += Number((p as any).brokerage || 0);
          totalSettlementAmount += Math.abs(Number((p as any).settlement_amount || 0));

          if (!derivedSettlement) {
            const rawSettlement = p.settlement || '';
            derivedSettlement = rawSettlement;
            if (!derivedSettlement) {
              const sym: string = (p.symbol || state.symbol || '').toUpperCase();
              if (sym.endsWith('USDT') || sym.includes('CRYPTO')) derivedSettlement = 'Crypto';
              else if (sym.endsWith('=F') || sym.includes('COMEX')) derivedSettlement = 'COMEX';
              else if (sym.includes('MCX')) derivedSettlement = 'MCX';
              else derivedSettlement = 'NSE';
            }
          }

          const optimisticClosedPos = {
            ...p,
            id: p.id,
            status: 'closed',
            exit_price: exitPrice,
            pnl,
            total_pnl: pnl,
            pnl_percent: pnlPercent,
            qty_total: p.qty_total || p.qty_open || closedQty,
            qty_open: 0,
            closed_at: new Date(now).toISOString(),
            exit_time: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
          };

          optimisticClosedPositions.push(optimisticClosedPos);
          if (p.id) {
            if (typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
              (window as any).__lastPositionsMap.delete(p.id);
            }
            if (positionsContext?.removePositionLocally) {
              positionsContext.removePositionLocally(p.id);
            }
          }
        }

        if (effectiveLinkedPosId) {
          if (typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
            (window as any).__lastPositionsMap.delete(effectiveLinkedPosId);
          }
          if (positionsContext?.removePositionLocally) {
            positionsContext.removePositionLocally(effectiveLinkedPosId);
          }
        }

        const avgEntryPrice = totalClosedQty > 0 ? weightedEntrySum / totalClosedQty : 0;
        const exitPrice = Number(state.client_price || 0);
        const posSide = (sortedMatching[0]?.side || 'BUY') as 'BUY' | 'SELL';

        const optimisticHistoryItem = {
          id: sortedMatching.length === 1 ? sortedMatching[0].id : tempId,
          scriptName: sortedMatching[0]?.symbol || state.symbol,
          type: posSide,
          orderType: sortedMatching[0]?.product_type || state.product_type || 'INTRADAY',
          qty: totalClosedQty || state.qty || 1,
          price: exitPrice || avgEntryPrice,
          entryPrice: avgEntryPrice,
          exitPrice: exitPrice || avgEntryPrice,
          pnl: totalPnl,
          date: fmtDateTime(sortedMatching[0]?.entry_time || (sortedMatching[0] as any)?.created_at || new Date(now).toISOString()),
          exitDate: fmtDate(new Date(now).toISOString()),
          status: 'closed',
          brokerage: totalBrokerage,
          closedBy: 'USER_ACTION',
          productType: sortedMatching[0]?.product_type || state.product_type || 'INTRADAY',
          settlement: derivedSettlement || state.segment || 'NSE',
          settlementAmount: totalSettlementAmount,
          timestamp: now,
          trades_count: sortedMatching.length,
        };

        optimisticHistoryItems.push(optimisticHistoryItem);
      } else if (state.is_exit) {
        // Fallback for standalone exit orders
        const exitPrice = Number(state.client_price || 0);
        const posSide = state.side === 'BUY' ? 'SELL' : 'BUY';
        const closedQty = state.qty || 1;
        const fakeId = state.linked_position_id || tempId;
        const optimisticHistoryItem = {
          id: fakeId,
          scriptName: state.symbol,
          type: posSide,
          orderType: state.product_type || 'INTRADAY',
          qty: closedQty,
          price: exitPrice,
          entryPrice: exitPrice,
          exitPrice: exitPrice,
          pnl: 0,
          date: fmtDateTime(new Date(now).toISOString()),
          exitDate: fmtDate(new Date(now).toISOString()),
          status: 'closed',
          brokerage: 0,
          closedBy: 'USER_ACTION',
          productType: state.product_type || 'INTRADAY',
          settlement: state.segment || 'NSE',
          settlementAmount: 0,
          timestamp: now,
        };
        const optimisticClosedPos = {
          id: fakeId,
          symbol: state.symbol,
          side: posSide,
          status: 'closed',
          exit_price: exitPrice,
          pnl: 0,
          total_pnl: 0,
          pnl_percent: 0,
          qty_total: closedQty,
          qty_open: 0,
          closed_at: new Date(now).toISOString(),
          exit_time: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        };
        optimisticHistoryItems.push(optimisticHistoryItem);
        optimisticClosedPositions.push(optimisticClosedPos);
      }

      if (typeof window !== 'undefined' && optimisticHistoryItems.length > 0) {
        try {
          const existingHistory = (window as any).__historyCache || [];
          const newIds = new Set(optimisticHistoryItems.map(i => i.id));
          const updatedHistory = [...optimisticHistoryItems, ...existingHistory.filter((h: any) => !newIds.has(h.id))];
          (window as any).__historyCache = updatedHistory;
        } catch {}
        window.dispatchEvent(new CustomEvent('position_closed_optimistic', {
          detail: {
            positions: optimisticClosedPositions,
            historyItems: optimisticHistoryItems,
            position: optimisticClosedPositions[0],
            historyItem: optimisticHistoryItems[0],
          }
        }));
      }

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

    soundEngine.playOrderExecuted();

    try {
      const submitPayload = {
        ...state,
        is_exit: effectiveIsExit,
        linked_position_id: effectiveLinkedPosId,
      };

      let result: { order_id: string; status: string; fill_price: number; message?: string } | null = null;

      // ── Sub-Second Execution Pipeline: WebSocket Fast-Pipe ───────────────
      // If WebSocket connection to the ticker daemon engine is active, dispatch
      // the order directly via in-memory order engine for <20ms execution.
      try {
        const session = await getSession();
        const userId = session?.user?.id;
        if (userId && wsManager.isConnectingOrOpen) {
          const fastPayload = {
            ...submitPayload,
            id: tempId,
            user_id: userId,
            client_click_time: state.client_click_time || Date.now(),
          };
          const wsResp = await wsManager.placeOrderFast(fastPayload, 2000);
          if (wsResp.success && wsResp.result) {
            result = {
              order_id: wsResp.result.orderId || tempId,
              status: wsResp.result.status || 'EXECUTED',
              fill_price: wsResp.result.fill_price || state.client_price,
              message: `Executed in ${wsResp.result.execution_latency_ms || 15}ms via FastEngine`,
            };
          }
        }
      } catch (wsErr) {
        // Fast-pipe failed or timed out — fall through to standard API route
      }

      // Fallback: Standard API route
      if (!result) {
        result = await api.post<{ order_id: string; status: string; fill_price: number; message: string }>(
          '/api/orders',
          submitPayload,
          { timeout: 25000 }
        );
      }

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

      if (typeof window !== 'undefined') {
        try {
          const existingHistory = (window as any).__historyCache || [];
          const updatedHistory = existingHistory.map((h: any) => {
            if (h.id === tempId) {
              return {
                ...h,
                id: result.order_id || tempId,
                status: (result.status as any) || 'EXECUTED',
                price: result.fill_price || h.price,
              };
            }
            return h;
          });
          (window as any).__historyCache = updatedHistory;
          localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
        } catch {}

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
            order: confirmedOrder,
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
        if (effectiveIsExit && positionsContext?.restorePositionLocally) {
          positionsContext.restorePositionLocally(effectiveLinkedPosId || '');
        } else if (!effectiveIsExit && positionsContext?.removeOptimisticPosition) {
          positionsContext.removeOptimisticPosition(tempId);
        }

        if (typeof window !== 'undefined') {
          const failedIds = new Set<string>([
            tempId,
            ...(effectiveLinkedPosId ? [effectiveLinkedPosId] : []),
            ...optimisticHistoryItems.map(i => i.id)
          ]);
          try {
            const existingHistory = (window as any).__historyCache || [];
            const updatedHistory = existingHistory.filter((h: any) => !failedIds.has(h.id));
            (window as any).__historyCache = updatedHistory;
            localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
          } catch {}
          if (effectiveIsExit) {
            window.dispatchEvent(new CustomEvent('position_closed_rollback', { detail: { positionIds: Array.from(failedIds) } }));
          } else {
            window.dispatchEvent(new CustomEvent('order_failed', { detail: { orderId: tempId } }));
          }
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

    // Capture position before removing locally for optimistic history update
    const existingPos = positionsContext?.positions?.find(p => p.id === positionId);
    const now = Date.now();
    const resolvedExitPrice = clientPrice || existingPos?.current_ltp || existingPos?.entry_price || 0;
    const entryPrice = Number(existingPos?.entry_price || existingPos?.avg_price || 0);
    const qty = Number(existingPos?.qty_total || existingPos?.qty_open || (existingPos as any)?.qty || 1);
    const posSide = (existingPos?.side || side || 'BUY').toUpperCase();
    const isBuy = posSide === 'BUY';
    const pnl = entryPrice > 0 ? (isBuy ? (resolvedExitPrice - entryPrice) * qty : (entryPrice - resolvedExitPrice) * qty) : 0;

    const optimisticHistoryItem = {
      id: positionId,
      scriptName: existingPos?.symbol || symbol || 'UNKNOWN',
      type: posSide as 'BUY' | 'SELL',
      orderType: existingPos?.product_type || 'INTRADAY',
      qty,
      price: resolvedExitPrice,
      entryPrice,
      exitPrice: resolvedExitPrice,
      pnl,
      date: new Date(existingPos?.created_at || now).toLocaleString(),
      exitDate: new Date(now).toLocaleDateString(),
      status: 'closed',
      brokerage: Number(existingPos?.brokerage || 0),
      closedBy: 'USER_ACTION',
      productType: existingPos?.product_type || 'INTRADAY',
      settlement: existingPos?.settlement || settlement || 'NSE',
      settlementAmount: 0,
      timestamp: now,
    };

    const optimisticClosedPos = {
      id: positionId,
      symbol: existingPos?.symbol || symbol || 'UNKNOWN',
      side: posSide,
      status: 'closed',
      exit_price: resolvedExitPrice,
      pnl,
      total_pnl: pnl,
      pnl_percent: entryPrice > 0 ? ((resolvedExitPrice - entryPrice) / entryPrice) * 100 * (isBuy ? 1 : -1) : 0,
      qty_total: qty,
      qty_open: 0,
      closed_at: new Date(now).toISOString(),
      exit_time: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };

    // Optimistically remove position locally in 0ms for instant UI responsiveness
    if (positionsContext?.removePositionLocally) {
      positionsContext.removePositionLocally(positionId);
    }

    if (typeof window !== 'undefined') {
      try {
        const existingHistory = (window as any).__historyCache || [];
        const updatedHistory = [optimisticHistoryItem, ...existingHistory.filter((h: any) => h.id !== positionId)];
        (window as any).__historyCache = updatedHistory;
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

    soundEngine.playOrderExecuted();

    try {
      let result: any = null;

      // 1. Try Fast-Pipe WebSocket Exit (< 20ms)
      try {
        const session = await getSession();
        const userId = session?.user?.id;
        if (userId && wsManager.isConnectingOrOpen) {
          const wsResp = await wsManager.closePositionFast(userId, positionId, clientPrice, 2000);
          if (wsResp.success) {
            result = { success: true, ...wsResp.result };
          }
        }
      } catch (wsErr) {
        // Fast-pipe fallback
      }

      // 2. Fallback to REST API route
      if (!result) {
        result = await api.post<Record<string, unknown>>(`/api/positions/${positionId}/close`, {
          client_price: clientPrice,
          symbol,
          settlement,
          side
        }, { timeout: 20000 });
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed'));
        window.dispatchEvent(new Event('position_closed'));
        window.dispatchEvent(new Event('history_updated'));
      }

      return { success: true, ...result };
    } catch (err) {
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

      // If position is already closed (e.g. concurrent exit or fast-pipe already closed it), treat as success
      if (typeof message === 'string' && (message.toLowerCase().includes('already closed') || message.toLowerCase().includes('already_closed'))) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('order_placed'));
          window.dispatchEvent(new Event('position-closed'));
          window.dispatchEvent(new Event('position_closed'));
          window.dispatchEvent(new Event('history_updated'));
        }
        return { success: true, alreadyClosed: true };
      }

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
        window.dispatchEvent(new CustomEvent('position_closed_rollback', {
          detail: { positionIds: [positionId] }
        }));
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

    const now = Date.now();
    const optHistoryItems: any[] = [];
    const optClosedPositions: any[] = [];

    (positionIds || []).forEach(id => {
      const existingPos = positionsContext?.positions?.find(p => p.id === id);
      if (existingPos) {
        const exitPrice = existingPos.current_ltp || existingPos.entry_price || 0;
        const entryPrice = Number(existingPos.entry_price || existingPos.avg_price || 0);
        const qty = Number(existingPos.qty_total || existingPos.qty_open || (existingPos as any)?.qty || 1);
        const posSide = (existingPos.side || 'BUY').toUpperCase();
        const isBuy = posSide === 'BUY';
        const pnl = entryPrice > 0 ? (isBuy ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty) : 0;

        optHistoryItems.push({
          id,
          scriptName: existingPos.symbol || 'UNKNOWN',
          type: posSide,
          orderType: existingPos.product_type || 'INTRADAY',
          qty,
          price: exitPrice,
          entryPrice,
          exitPrice,
          pnl,
          date: new Date(existingPos.created_at || now).toLocaleString(),
          exitDate: new Date(now).toLocaleDateString(),
          status: 'closed',
          brokerage: Number(existingPos.brokerage || 0),
          closedBy: 'USER_ACTION',
          productType: existingPos.product_type || 'INTRADAY',
          settlement: existingPos.settlement || 'NSE',
          settlementAmount: 0,
          timestamp: now,
        });

        optClosedPositions.push({
          id,
          symbol: existingPos.symbol,
          side: posSide,
          status: 'closed',
          exit_price: exitPrice,
          pnl,
          total_pnl: pnl,
          pnl_percent: 0,
          qty_total: qty,
          qty_open: 0,
          closed_at: new Date(now).toISOString(),
          exit_time: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        });
      }
    });

    // Optimistically remove positions locally in 0ms
    if (positionsContext?.removePositionLocally) {
      positionIds.forEach(id => positionsContext.removePositionLocally(id));
    }

    if (typeof window !== 'undefined' && optHistoryItems.length > 0) {
      try {
        const existingHistory = (window as any).__historyCache || [];
        const optIds = new Set(optHistoryItems.map((i: any) => i.id));
        const updatedHistory = [...optHistoryItems, ...existingHistory.filter((h: any) => !optIds.has(h.id))];
        (window as any).__historyCache = updatedHistory;
        localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
      } catch {}
      window.dispatchEvent(new CustomEvent('position_closed_optimistic', {
        detail: {
          positions: optClosedPositions,
          historyItems: optHistoryItems,
          position: optClosedPositions[0],
          historyItem: optHistoryItems[0],
        }
      }));
    }

    soundEngine.playOrderExecuted();

    try {
      let result: any = null;

      // 1. Try Fast-Pipe WebSocket Exit All (< 35ms)
      try {
        const session = await getSession();
        const userId = session?.user?.id;
        if (userId && wsManager.isConnectingOrOpen) {
          const wsResp = await wsManager.closeAllPositionsFast(userId, undefined, 3000);
          if (wsResp.success) {
            result = { success: true, ...wsResp.result };
          }
        }
      } catch (wsErr) {
        // Fallback
      }

      // 2. Fallback to REST API route
      if (!result) {
        result = await api.post<Record<string, unknown>>('/api/positions/close', { positionIds }, { timeout: 20000 });
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed'));
        window.dispatchEvent(new Event('position_closed'));
        window.dispatchEvent(new Event('history_updated'));
      }

      return { success: true, ...result };
    } catch (err) {
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

      // If positions are already closed, treat as success
      if (typeof message === 'string' && (message.toLowerCase().includes('already closed') || message.toLowerCase().includes('already_closed'))) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('order_placed'));
          window.dispatchEvent(new Event('position-closed'));
          window.dispatchEvent(new Event('position_closed'));
          window.dispatchEvent(new Event('history_updated'));
        }
        return { success: true, alreadyClosed: true };
      }

      if (positionsContext?.restorePositionLocally) {
        positionIds.forEach(id => positionsContext.restorePositionLocally(id));
      }
      if (typeof window !== 'undefined') {
        try {
          const failedIds = new Set([...positionIds, ...optHistoryItems.map(i => i.id)]);
          const existingHistory = (window as any).__historyCache || [];
          const updatedHistory = existingHistory.filter((h: any) => !failedIds.has(h.id));
          (window as any).__historyCache = updatedHistory;
          localStorage.setItem('marginApex_history_cache_persisted', JSON.stringify(updatedHistory));
        } catch {}
        window.dispatchEvent(new CustomEvent('position_closed_rollback', {
          detail: { positionIds }
        }));
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
