/**
 * useOrderEntry
 * 
 * Manages the state and logic for placing an order through the MarginApex platform.
 */

import { useState, useCallback, useRef } from 'react';
import { api, ApiError } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { soundEngine } from '@/lib/audio';
import { useOrdersData } from '@/contexts/OrdersContext';
import { useBalanceData } from '@/contexts/BalanceContext';
import { usePositionsData, cleanSym } from '@/contexts/PositionsContext';
import { fmtDateTime, fmtDate } from '@/lib/format';
import type { MyOrder } from '@/lib/types/order';
import { calculateOrderBrokerage } from '@/lib/trading/BrokerageCalculator';
import {
  getClientHistoryCache,
  saveClientHistoryCache,
  prependToClientHistoryCache,
  removeFromClientHistoryCache,
  HistoryItem
} from '@/lib/historyCache';

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
  expected_brokerage?: number;
  expected_margin?: number;
}

export function useOrderEntry() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);
  const closingPositionsRef = useRef<Set<string>>(new Set());
  const isBatchClosingRef = useRef(false);

  // Softly obtain context hooks if rendered within providers
  let ordersContext: ReturnType<typeof useOrdersData> | null = null;
  let balanceContext: ReturnType<typeof useBalanceData> | null = null;
  let positionsContext: ReturnType<typeof usePositionsData> | null = null;
  try { ordersContext = useOrdersData(); } catch { }
  try { balanceContext = useBalanceData(); } catch { }
  try { positionsContext = usePositionsData(); } catch { }

  const placeOrder = useCallback(async (state: OrderEntryState) => {
    // Double-click synchronous lock
    if (isSubmittingRef.current) {
      return { success: false, isProcessing: true };
    }
    isSubmittingRef.current = true;
    setLoading(true);
    setError(null);

    const isImmediate = ['MARKET', 'SLM'].includes(state.order_type ?? '');

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
        const pStatus = (p.status || '').toLowerCase();
        const isOpen = !pStatus || pStatus === 'open' || pStatus === 'active';
        const pSide = (p.side || '').toUpperCase();
        return cleanSym(p.symbol || p.kite_instrument || '') === targetClean &&
          pSide === oppositeSide &&
          isOpen;
      }
    );
    const matchingOppositePos = matchingOppositePositions.find(p => state.linked_position_id ? p.id === state.linked_position_id : true) || matchingOppositePositions[0];
    const effectiveIsExit = Boolean(state.is_exit || matchingOppositePositions.length > 0);
    const effectiveLinkedPosId = state.linked_position_id || (matchingOppositePositions.length === 1 && (Number(matchingOppositePos?.qty_open || matchingOppositePos?.qty_total || 0) >= (state.qty || 1)) ? matchingOppositePos.id : undefined);

    if (typeof window !== 'undefined') {
      if (effectiveIsExit) {
        window.dispatchEvent(new CustomEvent('exit-overlay-start', { detail: `Closing ${state.symbol || 'Position'}...` }));
      } else {
        window.dispatchEvent(new CustomEvent('global-loader-start', { detail: `Placing ${state.side || 'BUY'} Order for ${state.symbol || ''}...` }));
      }
    }

    const targetProductType = state.product_type ?? 'INTRADAY';
    let calculatedExpectedBrokerage = Number(state.expected_brokerage || 0);
    if (calculatedExpectedBrokerage <= 0 && !effectiveIsExit) {
      try {
        const exposure = (state.qty || 1) * (state.client_price || 0);
        const brkRes = calculateOrderBrokerage({
          exposure,
          lots: state.lots || 1,
          productType: targetProductType,
          orderType: state.order_type || 'MARKET',
          isExit: false,
          dbSegment: state.segment,
        });
        calculatedExpectedBrokerage = brkRes.totalBrokerage;
      } catch {}
    }

    const submitPayload = {
      ...state,
      is_exit: effectiveIsExit,
      linked_position_id: effectiveLinkedPosId,
      expected_brokerage: calculatedExpectedBrokerage,
      brokerage: calculatedExpectedBrokerage,
    };

    try {
      const result = await api.post<{
        order_id: string;
        status: string;
        fill_price: number;
        message: string;
        order?: any;
        position?: any;
      }>('/api/orders', submitPayload, { timeout: 25000 });

      const finalOrderId = result.order_id || result.order?.id;
      const finalStatus = result.status || result.order?.status || (isImmediate ? 'EXECUTED' : 'PENDING');
      const finalFillPrice = result.fill_price || result.order?.fill_price || state.client_price;

      // 1. Mount server-confirmed position directly without optimistic guesses
      if (result.position) {
        if ((positionsContext as any)?.mountServerPosition) {
          (positionsContext as any).mountServerPosition(result.position);
        } else if (positionsContext?.addOptimisticPosition) {
          positionsContext.addOptimisticPosition(result.position);
        }
      } else if (effectiveIsExit && effectiveLinkedPosId && positionsContext?.removePositionLocally) {
        positionsContext.removePositionLocally(effectiveLinkedPosId);
      }

      // 2. Build confirmed order representation
      const confirmedOrder: MyOrder = result.order || ({
        id: finalOrderId,
        symbol: state.symbol,
        kite_instrument: state.kite_instrument,
        segment: state.segment || 'NSE',
        side: state.side,
        status: (finalStatus as any),
        qty: state.qty,
        lots: state.lots || 1,
        fill_price: finalFillPrice,
        ltp_at_entry: finalFillPrice,
        order_type: state.order_type,
        product_type: state.product_type,
        info: null,
        client_price: state.client_price,
        trigger_price: state.trigger_price,
        stop_loss: state.stop_loss,
        target: state.target,
        brokerage: calculatedExpectedBrokerage,
        created_at: new Date().toISOString(),
        created_time_ms: Date.now(),
      } as any);

      if ((ordersContext as any)?.addOptimisticOrder) {
        (ordersContext as any).addOptimisticOrder(confirmedOrder);
      }

      // 3. Audio feedback: ONLY on confirmed result
      if (finalStatus === 'EXECUTED') {
        soundEngine.playOrderExecuted();
      } else {
        soundEngine.playOrderSubmitted();
      }

      // 4. Update history & dispatch events
      if (typeof window !== 'undefined') {
        if (finalStatus === 'EXECUTED') {
          try {
            const historyItem: HistoryItem = {
              id: finalOrderId,
              scriptName: state.symbol,
              type: state.side,
              orderType: state.order_type || 'MARKET',
              qty: state.qty,
              price: finalFillPrice,
              pnl: 0,
              date: new Date().toLocaleString(),
              status: 'EXECUTED',
              brokerage: calculatedExpectedBrokerage,
              timestamp: Date.now(),
            };
            prependToClientHistoryCache(historyItem as any);
          } catch {}
        }

        if (effectiveIsExit) {
          window.dispatchEvent(new Event('position-closed'));
          window.dispatchEvent(new Event('history_updated'));
          setTimeout(() => {
            window.dispatchEvent(new Event('force_history_db_refresh'));
          }, 1500);
        }

        window.dispatchEvent(new CustomEvent('order_placed_with_data', {
          detail: {
            symbol: state.symbol,
            settlement: state.segment,
            side: state.side,
            qty_open: state.qty,
            entry_price: finalFillPrice,
            ltp: finalFillPrice,
            product_type: state.product_type,
            is_exit: effectiveIsExit,
            linked_position_id: effectiveLinkedPosId,
            brokerage: calculatedExpectedBrokerage,
            order: confirmedOrder,
          }
        }));
        window.dispatchEvent(new Event('order_placed'));

        if (state.order_type === 'SLM') {
          setTimeout(() => {
            window.dispatchEvent(new Event('order_placed'));
          }, 1200);
        }
      }

      return { success: true, order: result, fill_price: finalFillPrice };
    } catch (err) {
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

      soundEngine.playOrderRejected();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('order_error', { detail: message }));
      }
      console.warn('[useOrderEntry] Order placement rejected:', message);
      setError(message);
      return { success: false, isProcessing: false, error: message };
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('global-loader-end'));
        window.dispatchEvent(new Event('exit-overlay-end'));
      }
    }
  }, [ordersContext, positionsContext]);

  const closePosition = useCallback(async (
    positionId: string,
    clientPrice?: number,
    symbol?: string,
    settlement?: string,
    side?: string,
    positionObj?: any
  ) => {
    if (closingPositionsRef.current.has(positionId)) {
      return { success: false, isProcessing: true };
    }
    closingPositionsRef.current.add(positionId);
    setLoading(true);
    setError(null);

    // Capture position before removing locally for optimistic history update
    let existingPos = positionObj || positionsContext?.positions?.find(p => p.id === positionId);
    if (!existingPos && typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
      existingPos = (window as any).__lastPositionsMap.get(positionId);
    }
    if (!existingPos && symbol) {
      const cleanTarget = cleanSym(symbol);
      existingPos = positionsContext?.positions?.find(p => cleanSym(p.symbol || p.kite_instrument) === cleanTarget);
    }

    const posSymbol = existingPos?.symbol || symbol || 'Position';
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('exit-overlay-start', { detail: `Closing ${posSymbol}...` }));
    }

    const now = Date.now();
    const resolvedExitPrice = clientPrice || existingPos?.current_ltp || existingPos?.entry_price || 0;
    const entryPrice = Number(existingPos?.entry_price || existingPos?.avg_price || 0);
    const qty = Number(existingPos?.qty_total || existingPos?.qty_open || (existingPos as any)?.qty || 1);
    const posSide = (existingPos?.side || side || 'BUY').toUpperCase();
    const isBuy = posSide === 'BUY';
    const pnl = entryPrice > 0 ? (isBuy ? (resolvedExitPrice - entryPrice) * qty : (entryPrice - resolvedExitPrice) * qty) : 0;

    // Optimistically remove position immediately (<1ms) for snappy UI
    if (positionsContext?.removePositionLocally) {
      positionsContext.removePositionLocally(positionId, existingPos);
    }

    try {
      const result = await api.post<Record<string, unknown>>(`/api/positions/${positionId}/close`, {
        client_price: resolvedExitPrice,
        symbol: existingPos?.symbol || symbol,
        settlement: existingPos?.settlement || settlement,
        side: posSide,
        qty,
        entry_price: entryPrice,
        product_type: existingPos?.product_type || 'INTRADAY'
      }, { timeout: 45000 });

      const finalExitPrice = Number(result?.exit_price || result?.price || resolvedExitPrice);
      const finalPnl = entryPrice > 0 ? (isBuy ? (finalExitPrice - entryPrice) * qty : (entryPrice - finalExitPrice) * qty) : pnl;

      let existingBrokerage = Number(
        (result as any)?.brokerage ||
        existingPos?.brokerage || 
        (existingPos as any)?.total_brokerage || 
        (existingPos as any)?.entry_brokerage || 
        0
      );
      if (existingBrokerage <= 0 && typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
        const mapPos = (window as any).__lastPositionsMap.get(positionId);
        const mapBrk = Number(mapPos?.brokerage || mapPos?.entry_brokerage || 0);
        if (mapBrk > 0) existingBrokerage = mapBrk;
      }
      if (existingBrokerage <= 0 && entryPrice > 0) {
        try {
          const exposure = qty * entryPrice;
          const brkRes = calculateOrderBrokerage({
            exposure,
            lots: Number(existingPos?.lots || (existingPos as any)?.qty_total || 0) || 1,
            productType: existingPos?.product_type || 'INTRADAY',
            orderType: 'MARKET',
            isExit: false,
            dbSegment: existingPos?.settlement || settlement,
          });
          existingBrokerage = brkRes.totalBrokerage;
        } catch {}
      }

      const confirmedHistoryItem: HistoryItem = {
        id: positionId,
        scriptName: existingPos?.symbol || symbol || 'UNKNOWN',
        type: posSide as 'BUY' | 'SELL',
        orderType: existingPos?.product_type || 'INTRADAY',
        qty,
        price: finalExitPrice,
        entryPrice,
        exitPrice: finalExitPrice,
        pnl: finalPnl,
        date: new Date(existingPos?.created_at || now).toLocaleString(),
        exitDate: new Date(now).toLocaleDateString(),
        status: 'closed',
        brokerage: existingBrokerage,
        entry_brokerage: existingBrokerage,
        closedBy: 'USER_ACTION',
        productType: existingPos?.product_type || 'INTRADAY',
        settlement: existingPos?.settlement || settlement || 'NSE',
        settlementAmount: 0,
        timestamp: now,
      };

      const closedPos = {
        id: positionId,
        symbol: existingPos?.symbol || symbol || 'UNKNOWN',
        side: posSide,
        status: 'closed',
        exit_price: finalExitPrice,
        pnl: finalPnl,
        total_pnl: finalPnl,
        pnl_percent: entryPrice > 0 ? ((finalExitPrice - entryPrice) / entryPrice) * 100 * (isBuy ? 1 : -1) : 0,
        qty_total: qty,
        qty_open: 0,
        closed_at: new Date(now).toISOString(),
        exit_time: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      };

      // Confirmed removal from positions
      if (positionsContext?.removePositionLocally) {
        positionsContext.removePositionLocally(positionId, existingPos);
      }

      // Add confirmed item to client history cache
      prependToClientHistoryCache(confirmedHistoryItem);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('position_closed', {
          detail: {
            position: closedPos,
            positions: [closedPos],
            historyItem: confirmedHistoryItem,
            historyItems: [confirmedHistoryItem],
          }
        }));
        window.dispatchEvent(new Event('order_placed'));
        window.dispatchEvent(new Event('position-closed'));
        window.dispatchEvent(new Event('history_updated'));
      }

      soundEngine.playOrderExecuted();
      return { success: true, data: result };
    } catch (err) {
      let message = 'Unknown error';
      if (err instanceof ApiError) {
        message = (err.details as { error?: string } | null)?.error ?? (typeof err.details === 'string' && err.details.trim() ? err.details : null) ?? err.message ?? `ApiError ${err.status}`;
      } else if (err instanceof Error || (err && typeof err === 'object' && 'name' in err)) {
        const errName = (err as any).name;
        const errMessage = (err as any).message || String(err);
        if (errName === 'AbortError' || errMessage.includes('abort')) {
          message = 'Exit is being processed. Check Positions — if still open, try exit again.';
        } else if (errMessage.includes('NetworkError') || errMessage.includes('Failed to fetch')) {
          message = 'Network connection error. Please try again.';
        } else {
          message = errMessage;
        }
      }

      // If position is already closed, treat as success
      if (typeof message === 'string' && (message.toLowerCase().includes('already closed') || message.toLowerCase().includes('already_closed'))) {
        if (positionsContext?.removePositionLocally) {
          positionsContext.removePositionLocally(positionId, existingPos);
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('order_placed'));
          window.dispatchEvent(new Event('position-closed'));
          window.dispatchEvent(new Event('position_closed'));
          window.dispatchEvent(new Event('history_updated'));
        }
        return { success: true, already_closed: true };
      }

      // If failed, restore position locally
      if (positionsContext?.restorePositionLocally && existingPos) {
        positionsContext.restorePositionLocally(positionId, existingPos);
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('position_closed_rollback', { detail: { positionIds: [positionId] } }));
        window.dispatchEvent(new CustomEvent('order_error', { detail: message }));
      }

      setError(message);
      return { success: false, error: message };
    } finally {
      closingPositionsRef.current.delete(positionId);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('exit-overlay-end'));
        window.dispatchEvent(new Event('global-loader-end'));
      }
      setLoading(false);
    }
  }, [positionsContext]);

  const closePositionsBatch = useCallback(async (positionIds: (string | any)[]) => {
    if (isBatchClosingRef.current) {
      return { success: false, results: [] };
    }
    isBatchClosingRef.current = true;
    setLoading(true);
    setError(null);

    const now = Date.now();
    const rawList = Array.isArray(positionIds) ? positionIds : [positionIds];
    const ids = rawList.map((p: any) => (typeof p === 'string' ? p : p?.id)).filter(Boolean);

    if (ids.length === 0) {
      setLoading(false);
      return { success: true, results: [] };
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('exit-overlay-start', { detail: `Closing ${ids.length} Position(s)...` }));
    }

    // Optimistically remove positions immediately (<1ms) for snappy UI
    if (positionsContext?.removePositionLocally) {
      ids.forEach(id => {
        const pObj = (rawList.find((p: any) => typeof p === 'object' && p !== null && p.id === id) as any) || undefined;
        positionsContext.removePositionLocally(id, pObj);
      });
    }

    try {
      // Increased timeout for large batches (100+ positions)
      const timeoutMs = Math.max(60000, ids.length * 100); // 100ms per position, min 60s
      const result = await api.post<{ success: boolean; results: any[]; message?: string }>('/api/positions/close', { positionIds: ids }, { timeout: timeoutMs });

      const confirmedHistoryItems: HistoryItem[] = [];
      const confirmedClosedPositions: any[] = [];
      const batchResults = (result as any)?.results || [];

      ids.forEach(id => {
        let existingPos = positionsContext?.positions?.find(p => p.id === id);
        if (!existingPos && typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
          existingPos = (window as any).__lastPositionsMap.get(id);
        }
        if (!existingPos) {
          existingPos = rawList.find((p: any) => typeof p === 'object' && p !== null && p.id === id);
        }

        const resMatch = batchResults.find((r: any) => r.positionId === id);
        // If the server reported a failure for this specific position, don't record closed history item and restore
        if (resMatch && resMatch.success === false) {
          if (positionsContext?.restorePositionLocally) {
            positionsContext.restorePositionLocally(id, existingPos);
          }
          return;
        }

        const exitPrice = resMatch?.exit_price !== undefined ? Number(resMatch.exit_price) : (existingPos?.current_ltp || existingPos?.ltp || existingPos?.entry_price || 0);
        const entryPrice = Number(existingPos?.entry_price || existingPos?.avg_price || 0);
        const qty = Number(existingPos?.qty_total || existingPos?.qty_open || (existingPos as any)?.qty || 1);
        const posSide = (existingPos?.side || 'BUY').toUpperCase();
        const isBuy = posSide === 'BUY';
        const pnl = resMatch?.pnl !== undefined ? Number(resMatch.pnl) : (entryPrice > 0 ? (isBuy ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty) : 0);

        const entryTs = existingPos?.entry_time || existingPos?.created_at
          ? new Date(existingPos.entry_time || existingPos.created_at).getTime()
          : now;

        let existingBrokerage = resMatch?.brokerage !== undefined ? Number(resMatch.brokerage) : Number(
          existingPos?.brokerage || 
          (existingPos as any)?.total_brokerage || 
          (existingPos as any)?.entry_brokerage || 
          0
        );
        if (existingBrokerage <= 0 && entryPrice > 0) {
          try {
            const exposure = qty * entryPrice;
            const brkRes = calculateOrderBrokerage({
              exposure,
              lots: Number(existingPos?.lots || (existingPos as any)?.qty_total || 0) || 1,
              productType: existingPos?.product_type || 'INTRADAY',
              orderType: 'MARKET',
              isExit: false,
              dbSegment: existingPos?.settlement || 'NSE',
            });
            existingBrokerage = brkRes.totalBrokerage;
          } catch {}
        }

        confirmedHistoryItems.push({
          id,
          scriptName: existingPos?.symbol || 'UNKNOWN',
          type: posSide as 'BUY' | 'SELL',
          orderType: existingPos?.product_type || 'INTRADAY',
          qty,
          price: exitPrice,
          entryPrice,
          exitPrice,
          pnl,
          date: new Date(existingPos?.created_at || now).toLocaleString(),
          exitDate: new Date(now).toLocaleDateString(),
          status: 'closed',
          brokerage: existingBrokerage,
          entry_brokerage: existingBrokerage,
          closedBy: 'USER_ACTION',
          productType: existingPos?.product_type || 'INTRADAY',
          settlement: existingPos?.settlement || 'NSE',
          settlementAmount: 0,
          timestamp: now,
          entryTimestamp: entryTs,
        });

        confirmedClosedPositions.push({
          id,
          symbol: existingPos?.symbol || 'UNKNOWN',
          side: posSide,
          status: 'closed',
          exit_price: exitPrice,
          pnl,
          total_pnl: pnl,
          pnl_percent: entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 * (isBuy ? 1 : -1) : 0,
          qty_total: qty,
          qty_open: 0,
          closed_at: new Date(now).toISOString(),
          exit_time: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        });
      });

      if (confirmedHistoryItems.length > 0) {
        prependToClientHistoryCache(confirmedHistoryItems);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('position_closed', {
            detail: {
              positions: confirmedClosedPositions,
              historyItems: confirmedHistoryItems,
              position: confirmedClosedPositions[0],
              historyItem: confirmedHistoryItems[0],
            }
          }));
          window.dispatchEvent(new Event('order_placed'));
          window.dispatchEvent(new Event('position-closed'));
          window.dispatchEvent(new Event('history_updated'));
        }
      }

      soundEngine.playOrderExecuted();
      return { success: true, results: batchResults, message: result.message };
    } catch (err) {
      let message = 'Unknown error';
      if (err instanceof ApiError) {
        message = (err.details as { error?: string } | null)?.error ?? (typeof err.details === 'string' && err.details.trim() ? err.details : null) ?? err.message ?? `ApiError ${err.status}`;
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
        return {
          success: true,
          already_closed: true,
          results: ids.map(id => ({ positionId: id, success: true, already_closed: true }))
        };
      }

      // If failed, restore positions locally
      if (positionsContext?.restorePositionLocally) {
        ids.forEach(id => {
          const pObj = (rawList.find((p: any) => typeof p === 'object' && p !== null && p.id === id) as any) || undefined;
          positionsContext.restorePositionLocally(id, pObj);
        });
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('position_closed_rollback', { detail: { positionIds: Array.from(ids) } }));
        window.dispatchEvent(new CustomEvent('order_error', { detail: message }));
      }

      setError(message);
      return { success: false, error: message };
    } finally {
      isBatchClosingRef.current = false;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('exit-overlay-end'));
        window.dispatchEvent(new Event('global-loader-end'));
      }
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
