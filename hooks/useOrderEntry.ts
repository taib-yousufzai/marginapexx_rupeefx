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

    const isImmediate = ['MARKET', 'SLM'].includes(state.order_type ?? '');

    // 1. Two-stage optimistic UI: create a pending submission order in <16ms
    const tempId = `opt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const optimisticOrder: MyOrder = {
      id: tempId,
      symbol: state.symbol,
      kite_instrument: state.kite_instrument,
      segment: state.segment || 'NSE',
      side: state.side,
      status: isImmediate ? 'SUBMITTING' : 'PENDING',
      qty: state.qty,
      lots: state.lots || 1,
      fill_price: state.client_price,
      ltp_at_entry: state.client_price,
      order_type: state.order_type,
      product_type: state.product_type,
      info: null,
      client_price: state.client_price,
      trigger_price: state.trigger_price,
      stop_loss: state.stop_loss,
      target: state.target,
      brokerage: 0,
      created_at: new Date().toISOString(),
      created_time_ms: Date.now(),
    } as any;

    if ((ordersContext as any)?.addOptimisticOrder) {
      (ordersContext as any).addOptimisticOrder(optimisticOrder);
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
        if (state.linked_position_id) return p.id === state.linked_position_id;
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
    console.log('[DEBUG-OE] submitOrder called — is_exit:', effectiveIsExit, 'linkedPosId:', effectiveLinkedPosId, 'symbol:', state.symbol, 'qty:', state.qty, 'order_type:', state.order_type);

    const optimisticClosedPositions: any[] = [];
    const optimisticHistoryItems: any[] = [];

    if (isImmediate) {
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

      prependToClientHistoryCache(optimisticHistoryOrder as any);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('order_placed_optimistic', { detail: { order: optimisticOrder } }));
      }

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
            const remainingQty = curQty - closedQty;

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
              status: remainingQty <= 0 ? 'closed' : 'open',
              exit_price: exitPrice,
              pnl,
              total_pnl: pnl,
              pnl_percent: pnlPercent,
              qty_total: closedQty,
              qty_open: remainingQty,
              closed_at: new Date(now).toISOString(),
              exit_time: new Date(now).toISOString(),
              updated_at: new Date(now).toISOString(),
            };

            optimisticClosedPositions.push(optimisticClosedPos);
            if (p.id) {
              if (remainingQty <= 0) {
                // Fully closed: remove from active positions map and context
                if (typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
                  (window as any).__lastPositionsMap.delete(p.id);
                }
                if (positionsContext?.removePositionLocally) {
                  positionsContext.removePositionLocally(p.id);
                }
              } else {
                // Partially closed: update remaining quantity in place
                const updatedPos = { ...p, qty_open: remainingQty, qty_total: remainingQty };
                if (typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
                  (window as any).__lastPositionsMap.set(p.id, updatedPos);
                }
                if (positionsContext?.updatePositionLocally) {
                  positionsContext.updatePositionLocally(p.id, { qty_open: remainingQty, qty_total: remainingQty });
                }
              }
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

        if (optimisticHistoryItems.length > 0) {
          prependToClientHistoryCache(optimisticHistoryItems as any);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('position_closed_optimistic', {
              detail: {
                positions: optimisticClosedPositions,
                historyItems: optimisticHistoryItems,
                position: optimisticClosedPositions[0],
                historyItem: optimisticHistoryItems[0],
              }
            }));
            window.dispatchEvent(new Event('history_updated'));
          }
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
    } else {
      soundEngine.playOrderSubmitted();
    }

    try {
      const submitPayload = {
        ...state,
        is_exit: effectiveIsExit,
        linked_position_id: effectiveLinkedPosId,
      };

      let result: { order_id: string; status: string; fill_price: number; message?: string } | null = null;

      // ── Sub-Second Execution Pipeline: WebSocket Fast-Pipe (MARKET/SLM ONLY) ───────────────
      // Fast-pipe is reserved exclusively for immediate market executions.
      // Non-immediate orders (LIMIT, SL, GTT) are submitted directly to /api/orders.
      if (isImmediate) {
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
        status: (result.status as any) || (isImmediate ? 'EXECUTED' : 'PENDING'),
        fill_price: result.fill_price || state.client_price,
      };

      if ((ordersContext as any)?.swapOptimisticOrder) {
        (ordersContext as any).swapOptimisticOrder(tempId, confirmedOrder);
      }

      if (typeof window !== 'undefined') {
        if (isImmediate) {
          try {
            const existingHistory = getClientHistoryCache();
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
            saveClientHistoryCache(updatedHistory);
          } catch { }
        }

        if (isImmediate || confirmedOrder.status === 'EXECUTED') {
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
        }
        window.dispatchEvent(new Event('order_placed'));

        // For SLM orders, backend inserts a linked SL exit order slightly after the main order response.
        // Fire a delayed second refresh so the linked SL order appears quickly without waiting for polling.
        if (state.order_type === 'SLM') {
          setTimeout(() => {
            window.dispatchEvent(new Event('order_placed'));
          }, 1200);
        }
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
        if ((ordersContext as any)?.removeOptimisticOrder) {
          (ordersContext as any).removeOptimisticOrder(tempId);
        }
        if (effectiveIsExit && effectiveLinkedPosId && positionsContext?.restorePositionLocally) {
          console.log('[DEBUG-OE] ERROR PATH: restorePositionLocally called with:', effectiveLinkedPosId);
          // Only restore a SPECIFIC position exit. For cumulative exits
          // (effectiveLinkedPosId = null) we must NOT call restorePositionLocally('')
          // because that clears ALL optimistic removals — causing every
          // in-progress exit to reappear, even if the server actually closed it.
          // The 30-second TTL on optimisticallyRemovedIds will naturally expire
          // the removal and allow a fresh server fetch to resolve truth.
          positionsContext.restorePositionLocally(effectiveLinkedPosId);
        } else if (!effectiveIsExit && positionsContext?.removeOptimisticPosition) {
          positionsContext.removeOptimisticPosition(tempId);
        }

        if (typeof window !== 'undefined') {
          const failedIds = Array.from(new Set<string>([
            tempId,
            ...(effectiveLinkedPosId ? [effectiveLinkedPosId] : []),
            ...optimisticHistoryItems.map(i => i.id)
          ]));
          removeFromClientHistoryCache(failedIds);
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

  const closePosition = useCallback(async (
    positionId: string,
    clientPrice?: number,
    symbol?: string,
    settlement?: string,
    side?: string,
    positionObj?: any
  ) => {
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

    const now = Date.now();
    const resolvedExitPrice = clientPrice || existingPos?.current_ltp || existingPos?.entry_price || 0;
    const entryPrice = Number(existingPos?.entry_price || existingPos?.avg_price || 0);
    const qty = Number(existingPos?.qty_total || existingPos?.qty_open || (existingPos as any)?.qty || 1);
    const posSide = (existingPos?.side || side || 'BUY').toUpperCase();
    const isBuy = posSide === 'BUY';
    const pnl = entryPrice > 0 ? (isBuy ? (resolvedExitPrice - entryPrice) * qty : (entryPrice - resolvedExitPrice) * qty) : 0;

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
          client_price: resolvedExitPrice,
          symbol: existingPos?.symbol || symbol,
          settlement: existingPos?.settlement || settlement,
          side: posSide,
          qty,
          entry_price: entryPrice,
          product_type: existingPos?.product_type || 'INTRADAY'
        }, { timeout: 45000 });
      }

      const finalExitPrice = Number(result?.exit_price || result?.price || resolvedExitPrice);
      const finalPnl = entryPrice > 0 ? (isBuy ? (finalExitPrice - entryPrice) * qty : (entryPrice - finalExitPrice) * qty) : pnl;

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
        brokerage: Number(existingPos?.brokerage || 0),
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
      return { success: true, ...result };
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

      // If position is already closed (e.g. concurrent exit or fast-pipe already closed it), treat as success
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
        return { success: true, alreadyClosed: true };
      }

      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [positionsContext]);

  const closePositionsBatch = useCallback(async (positionIds: (string | any)[]) => {
    setLoading(true);
    setError(null);

    const now = Date.now();
    const rawList = Array.isArray(positionIds) ? positionIds : [positionIds];
    const ids = rawList.map((p: any) => (typeof p === 'string' ? p : p?.id)).filter(Boolean);

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
        result = await api.post<Record<string, unknown>>('/api/positions/close', { positionIds }, { timeout: 45000 });
      }

      const confirmedHistoryItems: HistoryItem[] = [];
      const confirmedClosedPositions: any[] = [];

      ids.forEach(id => {
        let existingPos = positionsContext?.positions?.find(p => p.id === id);
        if (!existingPos && typeof window !== 'undefined' && (window as any).__lastPositionsMap) {
          existingPos = (window as any).__lastPositionsMap.get(id);
        }
        if (!existingPos) {
          existingPos = rawList.find((p: any) => typeof p === 'object' && p !== null && p.id === id);
        }

        const exitPrice = existingPos?.current_ltp || existingPos?.ltp || existingPos?.entry_price || 0;
        const entryPrice = Number(existingPos?.entry_price || existingPos?.avg_price || 0);
        const qty = Number(existingPos?.qty_total || existingPos?.qty_open || (existingPos as any)?.qty || 1);
        const posSide = (existingPos?.side || 'BUY').toUpperCase();
        const isBuy = posSide === 'BUY';
        const pnl = entryPrice > 0 ? (isBuy ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty) : 0;

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
          brokerage: Number(existingPos?.brokerage || 0),
          closedBy: 'USER_ACTION',
          productType: existingPos?.product_type || 'INTRADAY',
          settlement: existingPos?.settlement || 'NSE',
          settlementAmount: 0,
          timestamp: now,
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

      // Confirmed removal from positions in 0ms
      if (positionsContext?.removePositionLocally) {
        ids.forEach(id => {
          const pObj = (rawList.find((p: any) => typeof p === 'object' && p !== null && p.id === id) as any) || undefined;
          positionsContext.removePositionLocally(id, pObj);
        });
      }

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
      return { success: true, ...result };
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
        return { success: true, alreadyClosed: true };
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
