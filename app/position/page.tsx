'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { getSession } from '@/lib/auth';
import { pageCache } from '@/lib/pageCache';
import { useMyPositions, EnrichedPosition } from '@/hooks/useMyPositions';
import { cleanSym } from '@/contexts/PositionsContext';
import { useMyOrders } from '@/hooks/useMyOrders';
import { useOrderEntry } from '@/hooks/useOrderEntry';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useMobileBack } from '@/hooks/useMobileBack';
import { useBalance } from '@/hooks/useBalance';
import { api, ApiError } from '@/lib/api';
import type { TradeSheetItem } from '@/components/TradeSheet';
import dynamic from 'next/dynamic';
import PullToRefresh from '@/components/PullToRefresh';
import { ErrorModal } from '@/components/ErrorModal';
import HoldLockCountdown from '@/components/HoldLockCountdown';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import { fmtSymbolName, isUsdInstrument } from '@/lib/format';
import TickFlash from '@/components/TickFlash';
import './page.css';

const TradeSheet = dynamic(() => import('@/components/TradeSheet'), { ssr: false });
const TradingChart = dynamic(() => import('@/components/TradingChart'), { ssr: false });


export default function PositionPage() {
  const router = useRouter();
  useAuth();

  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    getSession().then((session) => {
      const role = session?.user?.user_metadata?.role;
      if (role === 'admin' || role === 'super_admin') {
        setIsAdmin(true);
      }
    });
  }, []);

  useEffect(() => {
    const sync = () => {
      applyTheme(getSavedTheme());
    };
    sync();
    window.addEventListener('themeChanged', sync);
    return () => window.removeEventListener('themeChanged', sync);
  }, []);

  // Preload the TradeSheet dynamic-import chunk on page mount so the first Exit tap
  // never blocks on a network round-trip to fetch the JS bundle.
  useEffect(() => { import('@/components/TradeSheet'); }, []);
  const { positions, loading: posLoading, error: posError, refresh, updatePositionLocally,
    removePositionLocally,
    restorePositionLocally,
    startConversion,
    endConversion
  } = useMyPositions(5000);
  const { closePosition, closePositionsBatch, loading: closingPos } = useOrderEntry();

  // Listen for position-closed events fired by TradingChart so we eventually
  // refresh without waiting for the next 5-second poll cycle
  useEffect(() => {
    const handler = () => { setTimeout(() => { refresh(); fetchClosed(); }, 200); };
    window.addEventListener('position-closed', handler);
    return () => window.removeEventListener('position-closed', handler);
  }, [refresh]);

  // Closed positions are fetched separately (the main hook only returns open/active)
  const [closedPositions, setClosedPositions] = useState<EnrichedPosition[]>(() => {
    if (typeof window !== 'undefined') {
      if ((window as any).__closedPositionsCache) return (window as any).__closedPositionsCache;
      try {
        const stored = localStorage.getItem('marginApex_closed_positions_persisted');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            (window as any).__closedPositionsCache = parsed;
            return parsed;
          }
        }
      } catch (e) {}
    }
    return [];
  });
  const [closedLoading, setClosedLoading] = useState(false);

  const fetchClosed = async () => {
    if (closedPositions.length === 0 && !(typeof window !== 'undefined' && (window as any).__closedPositionsCache)) {
      setClosedLoading(true);
    }
    try {
      const data = await api.get<{ positions: any[] }>('/api/positions?status=closed');
      // Enrich closed positions with the computed fields expected by the UI.
      // Closed positions from the raw API don't go through useMyPositions enrichment,
      // so we derive the missing EnrichedPosition fields here.
      const enriched = (data.positions || []).map((p: any): EnrichedPosition => {
        const pnl = Number(p.pnl || 0);
        const qtyTotal = Number(p.qty_total || p.qty_open || p.qty || 1);
        const avgEntry = Number(p.avg_price || p.entry_price || 0);
        const exitPrice = Number(p.exit_price || p.ltp || avgEntry);
        const investment = avgEntry * qtyTotal;
        const pnl_percent = investment > 0 ? parseFloat(((pnl / investment) * 100).toFixed(2)) : 0;
        return {
          ...p,
          qty_total: qtyTotal,
          avg_price: avgEntry,
          entry_price: avgEntry,
          exit_price: exitPrice,
          current_ltp: exitPrice,
          unrealised_pnl: 0,
          total_pnl: pnl - Number(p.brokerage || 0),
          pnl,
          pnl_percent,
          hold_lock_active: false,
          remaining_hold_seconds: 0,
          required_hold_seconds: 0,
        };
      });
      // Sort newest to oldest closed positions by updated_at (closure date)
      enriched.sort((a: any, b: any) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime());
      
      setClosedPositions(prev => {
        const map = new Map<string, any>();
        for (const p of enriched) map.set(p.id, p);
        for (const p of prev) {
          if (!map.has(p.id) && (Date.now() - new Date(p.exit_time || p.updated_at || p.created_at || 0).getTime() < 60000)) {
            map.set(p.id, p);
          }
        }
        const cached = (typeof window !== 'undefined' && Array.isArray((window as any).__closedPositionsCache))
          ? (window as any).__closedPositionsCache
          : [];
        for (const p of cached) {
          if (!map.has(p.id) && (Date.now() - new Date(p.exit_time || p.updated_at || p.created_at || 0).getTime() < 60000)) {
            map.set(p.id, p);
          }
        }
        const result = Array.from(map.values()).sort((a: any, b: any) => 
          new Date(b.updated_at || b.exit_time || b.created_at || 0).getTime() - new Date(a.updated_at || a.exit_time || a.created_at || 0).getTime()
        );
        if (typeof window !== 'undefined') {
          (window as any).__closedPositionsCache = result;
          try { localStorage.setItem('marginApex_closed_positions_persisted', JSON.stringify(result)); } catch {}
        }
        return result;
      });
    } catch { /* non-critical */ } finally {
      setClosedLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).__closedPositionsCache && (window as any).__closedPositionsCache.length > 0) {
      setClosedPositions((window as any).__closedPositionsCache);
    }
    refresh(); // <---- Immediately refresh open positions when navigating to this page
    fetchClosed();
    // Closed positions don't need rapid polling — refresh on events + slow fallback
    const iv = setInterval(fetchClosed, 30000);
    const onOrderPlaced = () => {
      // Refresh open positions immediately + follow-up to catch DB propagation
      refresh();
      setTimeout(() => { refresh(); fetchClosed(); }, 200);
    };

    const handleOptimisticClosedPos = (e: any) => {
      const posList = e.detail?.positions || (e.detail?.position ? [e.detail.position] : []);
      if (posList.length === 0) return;
      setClosedPositions(prev => {
        const ids = new Set(posList.map((p: any) => p.id));
        const filtered = prev.filter(p => !ids.has(p.id));
        const merged = [...posList, ...filtered];
        if (typeof window !== 'undefined') {
          (window as any).__closedPositionsCache = merged;
          try { localStorage.setItem('marginApex_closed_positions_persisted', JSON.stringify(merged)); } catch {}
        }
        return merged;
      });
    };

    const handleOptimisticRollbackPos = (e: any) => {
      const ids: string[] = e.detail?.positionIds || [];
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      setClosedPositions(prev => {
        const filtered = prev.filter(p => !idSet.has(p.id));
        if (typeof window !== 'undefined') {
          (window as any).__closedPositionsCache = filtered;
          try { localStorage.setItem('marginApex_closed_positions_persisted', JSON.stringify(filtered)); } catch {}
        }
        return filtered;
      });
    };

    window.addEventListener('order_placed', onOrderPlaced);
    window.addEventListener('order_placed_with_data', onOrderPlaced);
    window.addEventListener('position_closed_optimistic', handleOptimisticClosedPos);
    window.addEventListener('position_closed_rollback', handleOptimisticRollbackPos);
    return () => {
      clearInterval(iv);
      window.removeEventListener('order_placed', onOrderPlaced);
      window.removeEventListener('order_placed_with_data', onOrderPlaced);
      window.removeEventListener('position_closed_optimistic', handleOptimisticClosedPos);
      window.removeEventListener('position_closed_rollback', handleOptimisticRollbackPos);
    };
  }, [refresh]);

  const { balance: balanceFromHook, settlementAmount } = useBalance();
  const balance = balanceFromHook;
  const { orders: rawOrders } = useMyOrders();

  const formatBalance = (val: number | null) => {
    if (val === null || val === undefined || isNaN(val)) return '...';
    return val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const [currentMain, setCurrentMain] = useState<'cumulative' | 'detailed'>('cumulative');
  const [currentSub, setCurrentSub] = useState<'open' | 'closed'>('open');
  const [selectedPos, setSelectedPos] = useState<EnrichedPosition | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [errorModalMsg, setErrorModalMsg] = useState<string | null>(null);

  // order_error is now handled centrally in ClientShell — no local listener needed.
  const [chartItem, setChartItem] = useState<any | null>(null);

  const openChart = (pos: EnrichedPosition) => {
    let seg = 'NSE - Equity';
    const settlement = (pos.settlement || '').toUpperCase();
    if (settlement.includes('CRYPTO') || pos.symbol.endsWith('USDT')) {
      seg = 'CRYPTO';
    } else if (settlement.includes('COMEX') || pos.symbol.endsWith('=F')) {
      seg = 'COMEX';
    } else if (pos.settlement) {
      seg = pos.settlement;
    }

    closeSheet();
    setTimeout(() => {
      setChartItem({
        name: pos.symbol,
        symbol: pos.symbol,
        kiteSymbol: pos.kite_instrument || pos.symbol,
        price: pos.current_ltp,
        segment: seg,
      });
      const chartSheet = document.getElementById('chartSheet');
      const chartOverlay = document.getElementById('chartSheetOverlay');
      if (chartSheet) chartSheet.classList.add('open');
      if (chartOverlay) chartOverlay.classList.add('active');
    }, 80);
  };


  // Exit All Modal
  const [isExitAllModalOpen, setIsExitAllModalOpen] = useState(false);
  const [isExitingAll, setIsExitingAll] = useState(false);

  // Group Exit Modal
  const [groupExitModalGroup, setGroupExitModalGroup] = useState<GroupedPosition | null>(null);

  // Add More trade sheet
  const [tradeSheetItem, setTradeSheetItem] = useState<TradeSheetItem | null>(null);
  const [tradeSheetSide, setTradeSheetSide] = useState<'BUY' | 'SELL' | 'BOTH'>('BUY');
  const [tradeSheetExitMode, setTradeSheetExitMode] = useState(false);
  const [tradeSheetProductType, setTradeSheetProductType] = useState<'INTRADAY' | 'CARRY' | undefined>(undefined);
  const [tradeSheetIsAddMore, setTradeSheetIsAddMore] = useState(false);
  const [tradeSheetLinkedPosId, setTradeSheetLinkedPosId] = useState<string | null>(null);
  const [tradeSheetInitialExitQty, setTradeSheetInitialExitQty] = useState<number | undefined>(undefined);

  // Inline expand for open positions
  const [expandedPosId, setExpandedPosId] = useState<string | null>(null);

  // Anti-scalping lock modal
  const [lockModalPos, setLockModalPos] = useState<EnrichedPosition | null>(null);

  // Conversion confirmation modal
  const [convertConfirmPos, setConvertConfirmPos] = useState<EnrichedPosition | null>(null);
  const [convertPreviewBrokerage, setConvertPreviewBrokerage] = useState<number | null>(null);
  const [isFetchingPreview, setIsFetchingPreview] = useState(false);
  // Track positions currently being converted to prevent double-taps / race conditions
  const convertingIdsRef = useRef<Set<string>>(new Set());

  // ── Pending-order warning popup ────────────────────────────────────────────
  // Shown when user tries to open a non-market exit sheet while a real PENDING
  // SL / GTT / LIMIT exit order already exists for that position or symbol.
  const [pendingOrderWarnMsg, setPendingOrderWarnMsg] = useState<string | null>(null);
  const [pendingOrderWarnCallback, setPendingOrderWarnCallback] = useState<(() => void) | null>(null);

  const checkPendingExitConflict = (posSymbol: string, exitSide: string, posId: string | null, isCumulative: boolean): string | null => {
    const realPendingExits = rawOrders.filter(o => {
      const isPending = ['PENDING', 'TRIGGER_PENDING'].includes((o.status as string) ?? '');
      const isExit = Boolean((o as any).is_exit);
      const sameSymbol = o.symbol === posSymbol;
      const oppositeSide = o.side === exitSide;
      const isNonMarket = !['MARKET'].includes((o.order_type as string) ?? '');
      // Skip virtual synthetic orders (pos-sl-*, pos-target-*, pos-gtt-*)
      const isReal = !String(o.id).startsWith('pos-');
      return isPending && isExit && sameSymbol && oppositeSide && isNonMarket && isReal;
    });

    if (realPendingExits.length === 0) return null;

    // A real exit order is "cumulative" if it has NO linked_position_id.
    // If it has a linked_position_id, it is detailed/position-specific.
    const isCumulativeOrder = (o: any) => !o.linked_position_id;
    const isDetailedOrder   = (o: any) => Boolean(o.linked_position_id);

    if (isCumulative) {
      // Trying to place a cumulative exit — block if any cumulative order exists
      if (realPendingExits.some(isCumulativeOrder)) {
        return "You already have a cumulative open order for this symbol. Please modify or cancel it first.";
      }
      // Block if any detailed order exists (mixing detailed+cumulative not allowed)
      if (realPendingExits.some(isDetailedOrder)) {
        return "You have open orders for specific positions (detailed view). Please cancel them before placing a cumulative order.";
      }
    } else {
      // Trying to place a detailed exit for a specific posId
      // Block only if there's a cumulative order (can't mix)
      if (realPendingExits.some(isCumulativeOrder)) {
        return "You have a cumulative open order for this symbol. Please cancel it before placing detailed orders.";
      }
      // Block only if THIS specific position already has an exit order
      if (posId && realPendingExits.some(o => o.linked_position_id === posId)) {
        return "You already have an open order for this specific position. Please modify or cancel it first.";
      }
      // Different positions can each have their own exit orders — no conflict
    }

    return null;
  };

  // Synchronous guard: prevents rapid taps from opening multiple TradeSheets before
  // React has committed the first state update. Must be a ref (not state) so it is
  // readable and settable within the same synchronous execution frame.
  const isOpeningTradeSheetRef = useRef(false);
  // ── Mobile Back Button Interception ──
  useMobileBack(isSheetOpen, () => {
    setIsSheetOpen(false);
    const sheet = document.getElementById('positionSheet');
    const overlay = document.getElementById('positionSheetOverlay');
    if (sheet) sheet.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    setTimeout(() => setSelectedPos(null), 300);
  }, 'posdetail');

  useMobileBack(!!chartItem, () => {
    setChartItem(null);
    const chartSheet = document.getElementById('chartSheet');
    const chartOverlay = document.getElementById('chartSheetOverlay');
    if (chartSheet) chartSheet.classList.remove('open');
    if (chartOverlay) chartOverlay.classList.remove('active');
  }, 'poschart');

  useMobileBack(!!tradeSheetItem, () => {
    setTradeSheetItem(null);
  }, 'postrade');

  useMobileBack(isExitAllModalOpen, () => {
    setIsExitAllModalOpen(false);
  }, 'posexitall');

  useMobileBack(!!lockModalPos, () => {
    setLockModalPos(null);
  }, 'poslock');

  const toggleExpand = (posId: string) => {
    setExpandedPosId(prev => prev === posId ? null : posId);
  };

  const openAddMore = (pos: EnrichedPosition) => {
    setTradeSheetItem({
      name: pos.symbol,
      symbol: pos.symbol,
      kiteSymbol: pos.kite_instrument || pos.symbol,
      segment: pos.settlement || 'INR',
      price: pos.current_ltp,
      change: `${pos.pnl_percent >= 0 ? '+' : ''}${pos.pnl_percent.toFixed(2)}%`,
    });
    setTradeSheetSide(pos.side);
    setTradeSheetExitMode(false);
    setTradeSheetProductType(pos.product_type as 'INTRADAY' | 'CARRY');
    setTradeSheetIsAddMore(true);
  };

  const openTradeExit = (pos: EnrichedPosition, isPartial: boolean) => {
    // Synchronous guard: if a TradeSheet open is already in flight, ignore the tap.
    // This must be a ref check — setState is asynchronous and would not protect against
    // rapid repeated taps within the same event loop tick.
    if (isOpeningTradeSheetRef.current) return;

    // Guard: if a real non-market pending exit order exists, show warning popup instead.
    const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const warningMsg = checkPendingExitConflict(pos.symbol, exitSide, pos.id, false);
    if (warningMsg) {
      setPendingOrderWarnMsg(warningMsg);
      setPendingOrderWarnCallback(() => () => {
        // User chose to proceed anyway — open the sheet
        isOpeningTradeSheetRef.current = true;
        closeSheet();
        setTradeSheetItem({
          name: pos.symbol,
          symbol: pos.symbol,
          kiteSymbol: pos.kite_instrument || pos.symbol,
          segment: pos.settlement || 'INR',
          price: pos.current_ltp,
          change: `${pos.pnl_percent >= 0 ? '+' : ''}${pos.pnl_percent.toFixed(2)}%`,
        });
        setTradeSheetSide(pos.side === 'BUY' ? 'SELL' : 'BUY');
        setTradeSheetExitMode(true);
        setTradeSheetProductType(pos.product_type as 'INTRADAY' | 'CARRY');
        setTradeSheetIsAddMore(false);
        setTradeSheetLinkedPosId(pos.id);
        setTradeSheetInitialExitQty(isPartial ? (pos.qty_open || pos.qty_total || (pos as any).qty) : undefined);
        requestAnimationFrame(() => { isOpeningTradeSheetRef.current = false; });
      });
      return;
    }

    isOpeningTradeSheetRef.current = true;

    // Close the detail bottom-sheet if open, then populate and open TradeSheet immediately.
    // React batches all these setState calls into a single render — no artificial delay needed.
    closeSheet();
    setTradeSheetItem({
      name: pos.symbol,
      symbol: pos.symbol,
      kiteSymbol: pos.kite_instrument || pos.symbol,
      segment: pos.settlement || 'INR',
      price: pos.current_ltp,
      change: `${pos.pnl_percent >= 0 ? '+' : ''}${pos.pnl_percent.toFixed(2)}%`,
    });
    setTradeSheetSide(pos.side === 'BUY' ? 'SELL' : 'BUY');
    setTradeSheetExitMode(true);
    setTradeSheetProductType(pos.product_type as 'INTRADAY' | 'CARRY');
    setTradeSheetIsAddMore(false);
    setTradeSheetLinkedPosId(pos.id);
    setTradeSheetInitialExitQty(isPartial ? (pos.qty_open || pos.qty_total || (pos as any).qty) : undefined);

    // Release guard after the next paint — by that point React has committed
    // the state update and the TradeSheet is visible.
    requestAnimationFrame(() => { isOpeningTradeSheetRef.current = false; });
  };

  const openGroupTradeExit = (group: GroupedPosition) => {
    const exitSide = group.side === 'BUY' ? 'SELL' : 'BUY';
    const isCumulative = group.ids.length > 1;
    const linkedId = isCumulative ? null : group.ids[0];
    
    const warningMsg = checkPendingExitConflict(group.representativePos.symbol, exitSide, linkedId, isCumulative);
    if (warningMsg) {
      setPendingOrderWarnMsg(warningMsg);
      setPendingOrderWarnCallback(() => () => {
        setTradeSheetItem({
          name: group.symbol,
          symbol: group.representativePos.symbol,
          kiteSymbol: group.representativePos.kite_instrument || group.symbol,
          segment: group.settlement || 'INR',
          price: group.current_ltp,
          change: `${group.pnl_percent >= 0 ? '+' : ''}${group.pnl_percent.toFixed(2)}%`,
        });
        setTradeSheetSide(group.side === 'BUY' ? 'SELL' : 'BUY');
        setTradeSheetExitMode(true);
        setTradeSheetProductType(group.product_type as 'INTRADAY' | 'CARRY');
        setTradeSheetIsAddMore(false);
        setTradeSheetLinkedPosId(linkedId);
        setTradeSheetInitialExitQty(group.qty_open);
      });
      return;
    }

    setTradeSheetItem({
      name: group.symbol,
      // Use the underlying DB symbol (pos.symbol), NOT the display symbol (group.symbol
      // which is kite_instrument without exchange prefix). The SQL position lookup uses
      // exact symbol match, so sending the display name causes "No open position to exit".
      symbol: group.representativePos.symbol,
      kiteSymbol: group.representativePos.kite_instrument || group.symbol,
      segment: group.settlement || 'INR',
      price: group.current_ltp,
      change: `${group.pnl_percent >= 0 ? '+' : ''}${group.pnl_percent.toFixed(2)}%`,
    });
    setTradeSheetSide(group.side === 'BUY' ? 'SELL' : 'BUY');
    setTradeSheetExitMode(true);
    setTradeSheetProductType(group.product_type as 'INTRADAY' | 'CARRY');
    setTradeSheetIsAddMore(false);
    setTradeSheetLinkedPosId(linkedId);
    setTradeSheetInitialExitQty(group.qty_open);
  };

  const openTradeAgain = (pos: EnrichedPosition) => {
    closeSheet();
    const symToUse = pos.kite_instrument || pos.symbol;
    setTimeout(() => {
      router.push(`/watchlist?symbol=${encodeURIComponent(symToUse)}&action=detail`);
    }, 80);
  };

  const openExitSheet = (pos: EnrichedPosition, totalQty?: number, isCumulative?: boolean) => {
    const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const isCumul = isCumulative ?? false;
    const linkedId = isCumul ? null : pos.id;

    // Guard: if a real non-market pending exit order exists, show warning popup.
    const warningMsg = checkPendingExitConflict(pos.symbol, exitSide, linkedId, isCumul);
    if (warningMsg) {
      setPendingOrderWarnMsg(warningMsg);
      setPendingOrderWarnCallback(() => () => {
        setTradeSheetItem({
          name: pos.symbol,
          symbol: pos.symbol,
          kiteSymbol: pos.kite_instrument || pos.symbol,
          segment: pos.settlement || 'INR',
          price: pos.current_ltp,
          change: `${pos.pnl_percent >= 0 ? '+' : ''}${pos.pnl_percent.toFixed(2)}%`,
        });
        setTradeSheetSide(pos.side === 'BUY' ? 'SELL' : 'BUY');
        setTradeSheetExitMode(true);
        setTradeSheetProductType(pos.product_type as 'INTRADAY' | 'CARRY');
        setTradeSheetIsAddMore(false);
        setTradeSheetLinkedPosId(isCumulative ? null : pos.id);
        setTradeSheetInitialExitQty(totalQty);
      });
      return;
    }

    setTradeSheetItem({
      name: pos.symbol,
      symbol: pos.symbol,
      kiteSymbol: pos.kite_instrument || pos.symbol,
      segment: pos.settlement || 'INR',
      price: pos.current_ltp,
      change: `${pos.pnl_percent >= 0 ? '+' : ''}${pos.pnl_percent.toFixed(2)}%`,
    });
    // Exit is the opposite side: BUY position → SELL to exit, SELL position → BUY to exit
    setTradeSheetSide(pos.side === 'BUY' ? 'SELL' : 'BUY');
    setTradeSheetExitMode(true);
    setTradeSheetProductType(pos.product_type as 'INTRADAY' | 'CARRY');
    setTradeSheetIsAddMore(false);
    setTradeSheetLinkedPosId(isCumulative ? null : pos.id);
    setTradeSheetInitialExitQty(totalQty);
  };

  const showToast = (msg: string, isError = false) => {
    setToast(msg);
    setTimeout(() => setToast(null), isError ? 4500 : 2000);
  };

  const toggleProductType = async (pos: EnrichedPosition) => {
    // Prevent double-tap: if this position is already mid-conversion, ignore
    if (convertingIdsRef.current.has(pos.id)) return;

    const newType = pos.product_type === 'INTRADAY' ? 'CARRY' : 'INTRADAY';

    // Only show the confirmation modal when converting to CARRY for the first time.
    // Once carry_brokerage_paid is true, brokerage has already been charged — no need
    // to warn the user again on subsequent INTRADAY ↔ CARRY switches.
    const needsConfirmation = newType === 'CARRY' && !(pos as any).carry_brokerage_paid;

    if (needsConfirmation) {
      setConvertConfirmPos(pos);
      // Fetch exact brokerage preview to show in the modal
      setIsFetchingPreview(true);
      setConvertPreviewBrokerage(null);
      try {
        const data = await api.get<{ carryBrokerage?: number }>(`/api/positions/${pos.id}/convert-preview?product_type=${newType}`);
        if (data.carryBrokerage !== undefined) {
          setConvertPreviewBrokerage(data.carryBrokerage);
        }
      } catch (err) {
        console.error('Failed to fetch conversion preview', err);
      } finally {
        setIsFetchingPreview(false);
      }
    } else {
      // Already paid carry brokerage, or converting back to INTRADAY — go directly
      await directConvert(pos);
    }
  };

  const confirmConvertProductType = async () => {
    if (!convertConfirmPos) return;
    const pos = convertConfirmPos;
    setConvertConfirmPos(null);
    await directConvert(pos);
  };

  const directConvert = async (pos: EnrichedPosition) => {
    // Prevent double-tap at this level too (e.g. confirm button tapped twice)
    if (convertingIdsRef.current.has(pos.id)) return;
    convertingIdsRef.current.add(pos.id);

    const originalType = pos.product_type;
    const newType = originalType === 'INTRADAY' ? 'CARRY' : 'INTRADAY';

    // 1. Optimistic Update (Immediate)
    if (startConversion) {
      startConversion(pos.id, newType);
    }
    if (selectedPos && selectedPos.id === pos.id) {
      setSelectedPos(prev => prev ? { ...prev, product_type: newType } : null);
    }

    try {
      await api.post<void>(`/api/positions/${pos.id}/convert`, { product_type: newType });

      showToast(`Position converted to ${newType} successfully`);
      // Await refresh to guarantee that rawPositions contains the updated DB value before we clear in-flight state
      await refresh();
    } catch (err: any) {
      console.error('Failed to convert position:', err);
      // Handle session-less / auth error feedback gracefully
      if (err instanceof ApiError && err.status === 401) {
        showToast('Unauthorized. Please login again.');
        if (endConversion) endConversion(pos.id);
        if (selectedPos && selectedPos.id === pos.id) {
          setSelectedPos(prev => prev ? { ...prev, product_type: originalType } : null);
        }
        convertingIdsRef.current.delete(pos.id);
        return;
      }
      const errorMsg = (err instanceof ApiError && err.details && typeof err.details === 'object' && 'error' in err.details)
        ? (err.details as any).error
        : err.message;
      showToast(`Conversion failed: ${errorMsg}`);

      // Revert bottom sheet state on server/network failure
      if (selectedPos && selectedPos.id === pos.id) {
        setSelectedPos(prev => prev ? { ...prev, product_type: originalType } : null);
      }
    } finally {
      // Release the double-tap guard and the optimistic in-flight lock
      convertingIdsRef.current.delete(pos.id);
      if (endConversion) {
        endConversion(pos.id);
      }
    }
  };

  const handleRowClick = (pos: EnrichedPosition) => {
    setSelectedPos(pos);
    setIsSheetOpen(true);
  };

  const closeSheet = () => {
    setIsSheetOpen(false);
    setSelectedPos(null);
  };

  // Track which position IDs are currently being closed to prevent double-submit
  const exitingPosIds = useRef<Set<string>>(new Set());
  const [exitingSet, setExitingSet] = useState<Set<string>>(new Set());

  const handleExit = (posId: string) => {
    if (exitingPosIds.current.has(posId)) return; // already in flight
    exitingPosIds.current.add(posId);
    setExitingSet(new Set(exitingPosIds.current));

    const posToClose = positions.find(p => p.id === posId);
    if (removePositionLocally) {
      removePositionLocally(posId);
    }

    // Close sheet immediately for snappy UI
    closeSheet();

    closePosition(
      posId,
      posToClose?.current_ltp ?? posToClose?.ltp ?? undefined,
      posToClose?.symbol ?? undefined,
      posToClose?.settlement ?? undefined,
      posToClose?.side ?? undefined
    ).then(res => {
      if (res.success) {
        showToast('Position closed successfully');
        refresh();
        window.dispatchEvent(new CustomEvent('position-closed'));
      } else {
        const errMsg = res.error || 'Failed to exit position';
        setErrorModalMsg(errMsg);
        if (posToClose && restorePositionLocally) {
          restorePositionLocally(posId);
        } else if (posToClose) refresh();
      }
    }).catch((err: any) => {
      const errMsg = err?.message || 'Failed to exit position';
      setErrorModalMsg(errMsg);
      if (posToClose && restorePositionLocally) {
        restorePositionLocally(posId);
      } else if (posToClose) refresh();
    }).finally(() => {
      exitingPosIds.current.delete(posId);
      setExitingSet(new Set(exitingPosIds.current));
    });
  };

  const openPositions = useMemo(() => {
    return positions.filter(p => !p.status || p.status.toLowerCase() === 'open' || p.status.toLowerCase() === 'active');
  }, [positions]);

  // closedPositions comes from the separate fetch above (positions hook only returns open/active)
  const hasOpenPositions = openPositions.length > 0;

  // Detailed view: open/active positions only — closed positions live in the Closed tab
  const detailedTickets = useMemo(() => {
    return [...openPositions].sort((a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime());
  }, [openPositions]);

  // ── Cumulative grouping: merge same symbol+side+product_type into one row ──
  interface GroupedPosition {
    key: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    product_type: string;
    settlement: string;
    qty_open: number;
    avg_price: number;          // weighted average entry price
    current_ltp: number;
    total_pnl: number;
    pnl_percent: number;
    hold_lock_active: boolean;
    ids: string[];              // all underlying position IDs
    representativePos: EnrichedPosition; // first position for actions
    is_closing?: boolean;
  }

  const groupedOpenPositions: GroupedPosition[] = useMemo(() => {
    const map = new Map<string, GroupedPosition>();

    for (const pos of openPositions) {
      const rawSymbol = pos.kite_instrument ? pos.kite_instrument.split(':').pop() || pos.symbol : pos.symbol;
      const displaySymbol = fmtSymbolName(rawSymbol, pos.name || (pos as any).instrument_name);
      const symKey = cleanSym(pos.symbol || rawSymbol);
      const key = `${symKey}|${pos.side}|${pos.product_type}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          symbol: displaySymbol,
          side: pos.side,
          product_type: pos.product_type || 'INTRADAY',
          settlement: pos.settlement || '',
          qty_open: pos.qty_open,
          avg_price: pos.avg_price || pos.entry_price,
          current_ltp: pos.current_ltp,
          total_pnl: pos.total_pnl,
          pnl_percent: pos.pnl_percent,
          hold_lock_active: pos.hold_lock_active,
          ids: [pos.id],
          representativePos: pos,
          is_closing: pos.is_closing,
        });
      } else {
        const newQty = existing.qty_open + pos.qty_open;
        const newAvg = newQty > 0
          ? (existing.avg_price * existing.qty_open + (pos.avg_price || pos.entry_price) * pos.qty_open) / newQty
          : existing.avg_price;
        const newPnl = existing.total_pnl + pos.total_pnl;
        const investment = newAvg * newQty;
        existing.qty_open = newQty;
        existing.avg_price = newAvg;
        existing.current_ltp = pos.current_ltp; // same symbol, LTP is same
        existing.total_pnl = newPnl;
        existing.pnl_percent = investment > 0 ? parseFloat(((newPnl / investment) * 100).toFixed(2)) : 0;
        existing.hold_lock_active = existing.hold_lock_active || pos.hold_lock_active;
        existing.is_closing = existing.is_closing || pos.is_closing;
        existing.ids.push(pos.id);
      }
    }
    return Array.from(map.values());
  }, [openPositions]);

  // ── Cumulative grouping for Closed Positions ──
  interface GroupedClosedPosition {
    key: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    product_type: string;
    settlement: string;
    qty_total: number;
    avg_price: number;
    exit_price: number;
    pnl: number;
    brokerage: number;
    pnl_percent: number;
    ids: string[];
    first_entry_time: string;
    last_exit_time: string;
    avg_duration_seconds: number;
    weighted_duration_sum?: number;
    total_margin: number;
    trades_count: number;
  }

  const groupedClosedPositions: GroupedClosedPosition[] = useMemo(() => {
    const map = new Map<string, GroupedClosedPosition>();
    for (const pos of closedPositions) {
      const rawSymbol = pos.kite_instrument ? pos.kite_instrument.split(':').pop() || pos.symbol : pos.symbol;
      const displaySymbol = fmtSymbolName(rawSymbol, pos.name || (pos as any).instrument_name);
      const key = `${displaySymbol}|${pos.side}|${pos.product_type}`;
      const existing = map.get(key);
      const posBrokerage = Number((pos as any).brokerage || 0);
      const posQty = Number(pos.qty_total || pos.qty_open || (pos as any).qty || 1);
      const posEntry = Number(pos.avg_price || pos.entry_price || 0);
      const posExit = Number(pos.exit_price || pos.current_ltp || 0);
      const posPnl = Number(pos.pnl || 0);

      const posEntryTime = pos.entry_time || (pos as any).created_at || new Date().toISOString();
      const posExitTime = pos.exit_time || (pos as any).closed_at || (pos as any).updated_at || posEntryTime;
      const posEntryTs = new Date(posEntryTime).getTime();
      const posExitTs = new Date(posExitTime).getTime();
      const posDuration = (pos.duration_seconds !== undefined && pos.duration_seconds !== null)
        ? Number(pos.duration_seconds)
        : Math.max(0, Math.round((posExitTs - posEntryTs) / 1000));
      const posMargin = Number((pos as any).locked_margin || (pos as any).margin_required || 0);

      if (!existing) {
        map.set(key, {
          key,
          symbol: displaySymbol,
          side: pos.side,
          product_type: pos.product_type || 'INTRADAY',
          settlement: pos.settlement || '',
          qty_total: posQty,
          avg_price: posEntry,
          exit_price: posExit,
          pnl: posPnl,
          brokerage: posBrokerage,
          pnl_percent: pos.pnl_percent || 0,
          ids: [pos.id],
          first_entry_time: posEntryTime,
          last_exit_time: posExitTime,
          avg_duration_seconds: posDuration,
          weighted_duration_sum: posDuration * posQty,
          total_margin: posMargin,
          trades_count: 1,
        });
      } else {
        const newQty = existing.qty_total + posQty;
        const newAvgEntry = newQty > 0
          ? (existing.avg_price * existing.qty_total + posEntry * posQty) / newQty
          : existing.avg_price;
        const newAvgExit = newQty > 0
          ? (existing.exit_price * existing.qty_total + posExit * posQty) / newQty
          : existing.exit_price;
        const newPnl = existing.pnl + posPnl;
        const newBrokerage = existing.brokerage + posBrokerage;
        const investment = newAvgEntry * newQty;
        const netPnl = newPnl - newBrokerage;

        const existingFirstTs = new Date(existing.first_entry_time).getTime();
        const firstEntryTime = posEntryTs < existingFirstTs ? posEntryTime : existing.first_entry_time;

        const existingLastTs = new Date(existing.last_exit_time).getTime();
        const lastExitTime = posExitTs > existingLastTs ? posExitTime : existing.last_exit_time;

        const newTradesCount = existing.trades_count + 1;
        const existingWeightedSum = existing.weighted_duration_sum ?? (existing.avg_duration_seconds * existing.qty_total);
        const newWeightedDurationSum = existingWeightedSum + (posDuration * posQty);
        const newAvgDuration = newQty > 0 ? Math.round(newWeightedDurationSum / newQty) : existing.avg_duration_seconds;
        const newTotalMargin = existing.total_margin + posMargin;

        existing.qty_total = newQty;
        existing.avg_price = newAvgEntry;
        existing.exit_price = newAvgExit;
        existing.pnl = newPnl;
        existing.brokerage = newBrokerage;
        existing.pnl_percent = investment > 0 ? parseFloat(((netPnl / investment) * 100).toFixed(2)) : 0;
        existing.ids.push(pos.id);
        existing.first_entry_time = firstEntryTime;
        existing.last_exit_time = lastExitTime;
        existing.weighted_duration_sum = newWeightedDurationSum;
        existing.avg_duration_seconds = newAvgDuration;
        existing.total_margin = newTotalMargin;
        existing.trades_count = newTradesCount;
      }
    }
    return Array.from(map.values());
  }, [closedPositions]);

  // ── Cumulative grouping for Pending Orders ──
  interface GroupedPendingOrder {
    key: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    product_type: string;
    settlement: string;
    qty: number;
    price: number;
    order_type: string;
    ids: string[];
  }

  const groupedPendingOrders: GroupedPendingOrder[] = useMemo(() => {
    const map = new Map<string, GroupedPendingOrder>();
    const pendingList = rawOrders.filter(o => o.status === 'PENDING' || o.status === 'OPEN' || o.status === 'VALIDATION_PENDING');
    for (const order of pendingList) {
      const key = `${order.symbol}|${order.side}|${order.product_type}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          symbol: order.symbol,
          side: order.side,
          product_type: order.product_type || 'INTRADAY',
          settlement: order.segment || '',
          qty: order.qty,
          price: order.trigger_price || order.client_price || order.fill_price || 0,
          order_type: order.order_type,
          ids: [order.id],
        });
      } else {
        const newQty = existing.qty + order.qty;
        const currentPrice = order.trigger_price || order.client_price || order.fill_price || 0;
        const newPrice = newQty > 0
          ? (existing.price * existing.qty + currentPrice * order.qty) / newQty
          : existing.price;
        existing.qty = newQty;
        existing.price = newPrice;
        existing.ids.push(order.id);
      }
    }
    return Array.from(map.values());
  }, [rawOrders]);

  const handleExitAllConfirm = () => {
    if (!hasOpenPositions) return;
    setIsExitAllModalOpen(false); // Close modal immediately for instant UX

    let successCount = 0;
    let failCount = 0;

    // Filter out locked positions from bulk exit
    const exitablePositions = openPositions.filter(p => !p.hold_lock_active);

    if (exitablePositions.length === 0) {
      showToast('All open positions are currently locked due to holding rules.');
      return;
    }

    const posIds = exitablePositions.map(p => p.id);
    if (removePositionLocally) {
      posIds.forEach(id => removePositionLocally(id));
    }

    showToast(`Closing ${posIds.length} position(s)...`);

    closePositionsBatch(posIds).then(result => {
      if (result.success && result.results) {
        let firstError = '';
        const successfulIds = new Set(result.results.filter((r: any) => r.success).map((r: any) => r.positionId));
        
        posIds.forEach(id => {
          if (!successfulIds.has(id)) {
            failCount++;
            if (restorePositionLocally) restorePositionLocally(id);
          } else {
            successCount++;
          }
        });

        result.results.forEach((res: any) => {
          if (!res.success && !firstError && res.error) firstError = res.error;
        });

        if (failCount === 0) {
          showToast(`Successfully closed ${successCount} position(s).`);
        } else {
          showToast(`Closed ${successCount}, failed ${failCount}. ${firstError ? `Error: ${firstError}` : ''}`, true);
        }
      } else {
        failCount = exitablePositions.length;
        if (restorePositionLocally) {
          posIds.forEach(id => restorePositionLocally(id));
        }
        showToast(`Closed ${successCount}, failed ${failCount}. Error: ${result.error || 'Unknown'}`, true);
      }
      refresh();
      window.dispatchEvent(new Event('position-closed'));
    }).catch((err: any) => {
      failCount = exitablePositions.length;
      if (restorePositionLocally) {
        posIds.forEach(id => restorePositionLocally(id));
      }
      showToast(`Bulk exit failed: ${err?.message || 'Unknown'}`, true);
      refresh();
    });
  };

  const handleGroupExitConfirm = () => {
    if (!groupExitModalGroup) return;
    const group = groupExitModalGroup;
    setGroupExitModalGroup(null);

    const posIds = group.ids;
    if (removePositionLocally) {
      posIds.forEach(id => removePositionLocally(id));
    }

    showToast(`Closing ${group.symbol} position(s)...`);

    closePositionsBatch(posIds).then(result => {
      if (result.success) {
        const successfulIds = new Set((result.results || []).filter((r: any) => r.success).map((r: any) => r.positionId));
        let hadFailures = false;
        let firstError = '';
        
        posIds.forEach(id => {
          if (!successfulIds.has(id)) {
            hadFailures = true;
            if (restorePositionLocally) restorePositionLocally(id);
          }
        });

        if (result.results) {
          result.results.forEach((res: any) => {
            if (!res.success && !firstError && res.error) firstError = res.error;
          });
        }

        if (hadFailures) {
          const msg = `Closed some, but failed for others. Error: ${firstError || 'Unknown'}`;
          setErrorModalMsg(msg);
        } else {
          showToast(`Successfully closed ${group.symbol} position(s).`);
        }
      } else {
        if (restorePositionLocally) {
          posIds.forEach(id => restorePositionLocally(id));
        }
        const msg = `Error closing ${group.symbol}: ${result.error || 'Unknown'}`;
        setErrorModalMsg(msg);
      }
      refresh();
      window.dispatchEvent(new Event('position-closed'));
    }).catch((err: any) => {
      if (restorePositionLocally) {
        posIds.forEach(id => restorePositionLocally(id));
      }
      setErrorModalMsg(`Error closing ${group.symbol}: ${err?.message || 'Unknown'}`);
      refresh();
    });
  };

  const totalPnl = useMemo(() => positions.reduce((acc, p) => acc + (p.total_pnl || 0), 0), [positions]);
  const realized = useMemo(() => closedPositions.reduce((acc, p) => acc + (p.pnl || 0), 0), [closedPositions]);
  const unrealized = useMemo(() => openPositions.reduce((acc, p) => acc + (p.total_pnl || 0), 0), [openPositions]);

  const fmtUSD = (val: number, settlement?: string, symbol?: string) => {
    const sym = '₹';
    const loc = 'en-IN';
    const sign = val >= 0 ? '+' : '-';
    return `${sign}${sym}${Math.abs(val).toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const fmtPrice = (val: number, settlement?: string, symbol?: string) => {
    const sym = '₹';
    const loc = 'en-IN';
    const isForex = (symbol && /^(EUR|GBP|USDJPY|USDCHF|AUD|NZD|CAD)/i.test(symbol));
    const decimals = isForex ? 4 : 2;
    return `${sym}${val.toLocaleString(loc, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  };

  return (
    <div className="desktop-layout">

      <main className="main-viewport">
        <div className="app-container">
          <div className="pos-root">
            <div className="pos-shell">
              {isExitingAll && (
                <div className="bm-overlay">
                  <div className="bm-loader">
                    <div className="bm-loader-bar"></div>
                    <div className="bm-loader-bar"></div>
                    <div className="bm-loader-bar"></div>
                  </div>
                </div>
              )}

              {/* ── Header (Mobile Only) ── */}
              <div className="pos-header mobile-only">
                <div className="pos-header-left">
                  <div className="pos-brand">
                    <span>MARGIN<span className="apex-text">APEX</span></span>
                  </div>

                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginRight: '8px' }}>
                  <button className="pos-wallet-btn" onClick={() => router.push('/funds')}>
                    <i className="fas fa-wallet" />
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 800 }}>₹{formatBalance(balance !== null ? balance : null)}</span>
                    </div>
                  </button>
                  <button
                    className={`pos-exit-btn${!hasOpenPositions ? ' disabled' : ''}`}
                    onClick={() => { if (hasOpenPositions) setIsExitAllModalOpen(true); }}
                  >
                    <i className="fas fa-sign-out-alt" />
                    <span>Exit All</span>
                  </button>
                </div>
              </div>

              {/* ── Desktop Page Header ── */}
              <div className="desktop-only" style={{ padding: '20px 24px 0 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Positions</h1>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>Internal Execution • Real-time P&amp;L</p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button className="pos-wallet-btn" onClick={() => router.push('/funds')}>
                    <i className="fas fa-wallet" />
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 800 }}>₹{formatBalance(balance !== null ? balance : null)}</span>
                    </div>
                  </button>
                  <button
                    className={`pos-exit-btn${!hasOpenPositions ? ' disabled' : ''}`}
                    onClick={() => { if (hasOpenPositions) setIsExitAllModalOpen(true); }}
                    style={{ padding: '10px 20px', fontSize: '0.9rem' }}
                  >
                    <i className="fas fa-sign-out-alt" />
                    <span>Exit All Positions</span>
                  </button>
                </div>
              </div>

              {/* ── Main Tabs ── */}
              <div className="pos-main-tabs">
                <div
                  className={`pos-main-tab${currentMain === 'cumulative' ? ' active' : ''}`}
                  onClick={() => { setCurrentMain('cumulative'); setExpandedPosId(null); }}
                >
                  Cumulative P&amp;L
                </div>
                <div
                  className={`pos-main-tab${currentMain === 'detailed' ? ' active' : ''}`}
                  onClick={() => { setCurrentMain('detailed'); setExpandedPosId(null); }}
                >
                  Detailed P&amp;L
                </div>
              </div>

              {/* ── Sticky Sub-Header (P&L + Sub-Tabs) ── */}
              <div className="pos-sticky-subheader">
                <div className="pos-pnl-card">
                  <div className="pos-pnl-card-title">
                    {currentSub === 'closed' ? "Today's P&L" : "Live P&L Summary"}
                  </div>
                  <div className={`pos-pnl-card-body${currentSub === 'closed' ? ' three-cols' : ''}`}>
                    {currentSub === 'closed' && (
                      <div className="pos-pnl-col left">
                        <div className="pos-pnl-label">Realized</div>
                        <div className={`pos-pnl-val${realized >= 0 ? ' green' : ' red'}`}>{fmtUSD(realized)}</div>
                      </div>
                    )}
                    <div className="pos-pnl-col center">
                      <div className={`pos-pnl-total${(currentSub === 'open' ? unrealized : realized) >= 0 ? ' green' : ' red'}`}>
                        {fmtUSD(currentSub === 'open' ? unrealized : realized)}
                      </div>
                    </div>
                    {currentSub === 'closed' && (
                      <div className="pos-pnl-col right">
                        <div className="pos-pnl-label">Unrealized</div>
                        <div className={`pos-pnl-val${unrealized >= 0 ? ' green' : ' red'}`}>{fmtUSD(unrealized)}</div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="pos-sub-tabs">
                  <div
                    className={`pos-sub-tab${currentSub === 'open' ? ' active' : ''}`}
                    onClick={() => { setCurrentSub('open'); setExpandedPosId(null); }}
                  >
                    Open Positions
                  </div>
                  <div
                    className={`pos-sub-tab${currentSub === 'closed' ? ' active' : ''}`}
                    onClick={() => { setCurrentSub('closed'); setExpandedPosId(null); }}
                  >
                    Closed Positions
                  </div>
                </div>
              </div>

              {/* ── Content ── */}
              <PullToRefresh className="pos-content" onRefresh={async () => { await refresh(); await fetchClosed(); }}>

                {posLoading && (
                  <div className="w-full flex flex-col gap-3">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className="pos-card animate-pulse" style={{ opacity: 1 - (i * 0.15) }}>
                        <div className="pos-card-main flex justify-between w-full">
                          <div className="flex flex-col gap-2">
                            <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-24"></div>
                            <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-32"></div>
                          </div>
                          <div className="flex flex-col gap-2 items-end">
                            <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-16"></div>
                            <div className="h-5 bg-gray-200 dark:bg-gray-800 rounded-lg w-20 mt-1"></div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!posLoading && (
                  currentMain === 'cumulative' ? (
                    currentSub === 'open' ? (
                      groupedOpenPositions.length === 0 ? (
                        <div className="pos-empty">
                          <i className="fas fa-chart-simple" />
                          <p>No open positions</p>
                        </div>
                      ) : groupedOpenPositions.map(group => (
                        <div key={group.key} className={`pos-card relative overflow-hidden transition-all duration-300${expandedPosId === group.key ? ' pos-card--expanded' : ''}${group.hold_lock_active ? ' pos-card--locked' : ''}`} onClick={() => toggleExpand(group.key)}>
                          <div className="pos-card-main relative z-0">
                            <div className="pos-card-left">
                              <div className="pos-card-symbol">
                                <span className="pos-symbol-text">{group.symbol}</span>
                              </div>
                              <div className="pos-card-details">
                                <span>Avg: <strong>{fmtPrice(group.avg_price, group.settlement)}</strong></span>
                                <span>Qty: <strong>{group.qty_open}</strong></span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '5px' }}>
                                {group.product_type && (
                                  <div
                                    className={`convert-type-btn ${group.product_type === 'CARRY' ? 'carry' : 'intraday'}`}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      await toggleProductType(group.representativePos);
                                    }}
                                  >
                                    {group.product_type === 'INTRADAY' ? 'INTRADAY ⇄ CARRY' : 'CARRY ⇄ INTRADAY'}
                                  </div>
                                )}
                                {group.ids.length > 1 && (
                                  <span style={{ fontSize: '0.65rem', fontWeight: 700, background: 'var(--card-alt-bg, #F1F5F9)', color: 'var(--text-secondary)', padding: '2px 6px', borderRadius: '20px' }}>
                                    {group.ids.length} trades
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="pos-card-right">
                              <span className={`pos-badge${group.side === 'BUY' ? ' long' : ' short'}`}>{group.side}</span>
                              <div className={`pos-card-pnl${group.total_pnl >= 0 ? ' green' : ' red'}`}>
                                <TickFlash value={group.total_pnl}>{fmtUSD(group.total_pnl, group.settlement, group.symbol)}</TickFlash>
                              </div>
                              <div className="pos-card-ltp">
                                {group.product_type && (
                                  <span className={`pos-product-badge ${group.product_type === 'CARRY' ? 'carry' : ''}`}>
                                    {group.product_type}
                                  </span>
                                )}
                                <span>LTP: <strong><TickFlash value={group.current_ltp}>{fmtPrice(group.current_ltp, group.settlement, group.symbol)}</TickFlash></strong></span>
                              </div>
                            </div>
                          </div>
                          {expandedPosId === group.key && (
                            <>
                              <div className="pos-card-actions" onClick={e => e.stopPropagation()}>
                              <button className="pca-btn pca-add" onClick={() => openAddMore(group.representativePos)}>
                                <i className="fas fa-plus-circle" /> Add More
                              </button>
                              <button
                                className={`pca-btn pca-exit${group.hold_lock_active ? ' disabled-lock' : ''}`}
                                onClick={() => {
                                  if (group.hold_lock_active) {
                                    setLockModalPos(group.representativePos);
                                    return;
                                  }
                                  // Always open TradeSheet for exit mode
                                  openGroupTradeExit(group);
                                }}
                              >
                                <i className="fas fa-times-circle" /> Exit
                              </button>
                              <button
                                style={{
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  width: '42px', height: '38px', borderRadius: '16px',
                                  border: '1.5px solid var(--border-card, #CBD5E1)',
                                  background: 'var(--card-bg, #ffffff)', color: 'var(--text-primary, #1F2937)',
                                  cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s'
                                }}
                                onClick={() => openChart(group.representativePos)}
                              >
                                <svg viewBox="0 0 24 24" style={{ width: '1.25rem', height: '1.25rem', display: 'inline-block', verticalAlign: 'middle' }}>
                                  <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                                  <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                                  <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                                  <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />
                                  <path d="M 4 14 L 8 9 L 13 12 L 20 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                  <polyline points="15 4 20 4 20 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            </div>
                          </>
                        )}
                        </div>
                      ))
                    ) : (
                      groupedClosedPositions.length === 0 ? (
                        <div className="pos-empty">
                          <i className="fas fa-history" />
                          <p>No closed positions</p>
                        </div>
                      ) : groupedClosedPositions.map(group => {
                        // Find the first underlying closed position to use as the detail sheet target
                        const representativePos = closedPositions.find(p => group.ids.includes(p.id));
                        return (
                          <div key={group.key} className="pos-card" style={{ cursor: 'pointer' }} onClick={() => {
                            if (representativePos) {
                              // Build a synthetic enriched position with the grouped averages for the sheet
                              handleRowClick({
                                ...representativePos,
                                avg_price: group.avg_price,
                                entry_price: group.avg_price,
                                exit_price: group.exit_price,
                                qty_total: group.qty_total,
                                qty_open: group.qty_total,
                                pnl: group.pnl,
                                total_pnl: group.pnl - group.brokerage,
                                pnl_percent: group.pnl_percent,
                                is_cumulative_group: true,
                                trades_count: group.trades_count,
                                first_entry_time: group.first_entry_time,
                                last_exit_time: group.last_exit_time,
                                avg_duration_seconds: group.avg_duration_seconds,
                                locked_margin: group.total_margin,
                              } as any);
                            }
                          }}>
                            <div className="pos-card-left">
                              <div className="pos-card-symbol">
                                <span className="pos-symbol-text">{group.symbol}</span>
                              </div>
                              <div className="pos-card-details">
                                <span>Avg Entry: <strong>{fmtPrice(group.avg_price, group.settlement)}</strong></span>
                                <span>Qty: <strong>{group.qty_total}</strong></span>
                              </div>
                              <div style={{ marginTop: '5px', display: 'flex', gap: '8px' }}>
                                {group.product_type && (
                                  <span className={`pos-product-badge ${group.product_type === 'CARRY' ? 'carry' : ''}`}>
                                    {group.product_type}
                                  </span>
                                )}
                                {group.ids.length > 1 && (
                                  <span style={{ fontSize: '0.65rem', fontWeight: 700, background: 'var(--card-alt-bg, #F1F5F9)', color: 'var(--text-secondary)', padding: '2px 6px', borderRadius: '20px' }}>
                                    {group.ids.length} trades
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="pos-card-right">
                              <span className={`pos-badge${group.side === 'BUY' ? ' long' : ' short'}`}>
                                {group.side}
                              </span>
                              <div className={`pos-card-pnl${group.pnl >= 0 ? ' green' : ' red'}`}>
                                {fmtUSD(group.pnl, group.settlement)}
                              </div>
                              <div className="pos-card-ltp">Avg Exit: <strong>{fmtPrice(group.exit_price, group.settlement)}</strong></div>
                            </div>
                          </div>
                        );
                      })
                    )
                  ) : (
                    /* Detailed View */
                    currentSub === 'open' ? (
                      detailedTickets.length === 0 ? (
                        <div className="pos-empty">
                          <i className="fas fa-list" />
                          <p>No trades available</p>
                        </div>
                      ) : detailedTickets.map(pos => {
                        const entryDate = new Date(pos.entry_time);
                        const timeStr = entryDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
                        const actualPos = pos;

                        return (
                          <div
                            key={pos.id}
                            className={`pos-detail-card${expandedPosId === pos.id ? ' pos-detail-card--expanded' : ''}${pos.hold_lock_active ? ' pos-card--locked' : ''}`}
                            onClick={() => {
                              if (pos.status === 'closed') {
                                handleRowClick(pos);
                              } else {
                                toggleExpand(pos.id);
                              }
                            }}
                          >
                            <div className="pos-detail-main-layout">
                              {/* Left Side: Symbol and Metadata */}
                              <div className="pos-detail-left-col">
                                <div className="pos-detail-symbol">
                                  <span className="pos-symbol-text">{fmtSymbolName(pos.kite_instrument ? pos.kite_instrument.split(':').pop() : pos.symbol, pos.name)}</span>
                                </div>
                                <div className="pos-detail-meta">
                                  <div className="pos-detail-meta-row">
                                    <span>Qty: <strong>{pos.qty_open || pos.qty_total}</strong></span>
                                    <span>Entry: <strong>{fmtPrice(pos.entry_price, pos.settlement)}</strong></span>
                                  </div>
                                  <div className="pos-detail-meta-row">
                                    <span>Time: <strong>{timeStr}</strong></span>
                                    {pos.status === 'closed'
                                      ? <span>Exit: <strong>{fmtPrice(pos.exit_price || 0, pos.settlement, pos.symbol)}</strong></span>
                                      : <span>Current: <strong><TickFlash value={pos.current_ltp}>{fmtPrice(pos.current_ltp, pos.settlement, pos.symbol)}</TickFlash></strong></span>
                                    }
                                  </div>
                                </div>
                                {pos.product_type && (
                                  <div
                                    className={`convert-type-btn ${pos.product_type === 'CARRY' ? 'carry' : 'intraday'}`}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      await toggleProductType(actualPos);
                                    }}
                                    style={{ marginTop: '5px', alignSelf: 'flex-start' }}
                                  >
                                    {pos.product_type === 'INTRADAY' ? 'INTRADAY ⇄ CARRY' : 'CARRY ⇄ INTRADAY'}
                                  </div>
                                )}
                              </div>

                              {/* Right Side: P&L and Status Badge */}
                              <div className="pos-detail-right-col">
                                <div className="pos-detail-pnl-group">
                                  <div className={`pos-detail-pnl${pos.total_pnl >= 0 ? ' green' : ' red'}`}>
                                    {fmtUSD(pos.total_pnl, pos.settlement)}
                                  </div>
                                  <div className="pos-detail-pct">{pos.pnl_percent >= 0 ? '+' : ''}{pos.pnl_percent.toFixed(2)}%</div>
                                  <span className="pos-detail-side">{pos.side}</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  {pos.product_type && (
                                    <span className={`pos-product-badge ${pos.product_type === 'CARRY' ? 'carry' : ''}`}>
                                      {pos.product_type}
                                    </span>
                                  )}
                                  <span className={`pos-status-badge ${pos.status}`}>
                                    {pos.status.toUpperCase()}
                                  </span>
                                </div>
                              </div>
                            </div>
                            {expandedPosId === pos.id && (pos.status === 'open' || pos.status === 'active') && (
                              <>
                                <div className="pos-card-actions" onClick={e => e.stopPropagation()}>
                                <button className="pca-btn pca-add" onClick={() => openAddMore(actualPos)}>
                                  <i className="fas fa-plus-circle" /> Add More
                                </button>
                                <button
                                  className={`pca-btn pca-exit${pos.hold_lock_active ? ' disabled-lock' : ''}`}
                                  onClick={() => {
                                    if (pos.hold_lock_active) {
                                      setLockModalPos(actualPos);
                                    } else {
                                      openTradeExit(actualPos, false);
                                    }
                                  }}
                                >
                                  <i className="fas fa-times-circle" /> Exit
                                </button>
                                <button
                                  style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    width: '42px', height: '38px', borderRadius: '16px',
                                    border: '1.5px solid var(--border-card, #CBD5E1)',
                                    background: 'var(--card-bg, #ffffff)', color: 'var(--text-primary, #1F2937)',
                                    cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s'
                                  }}
                                  onClick={() => openChart(pos)}
                                >
                                  <svg viewBox="0 0 24 24" style={{ width: '1.25rem', height: '1.25rem', display: 'inline-block', verticalAlign: 'middle' }}>
                                    <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                                    <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                                    <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                                    <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />
                                    <path d="M 4 14 L 8 9 L 13 12 L 20 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    <polyline points="15 4 20 4 20 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    closedPositions.length === 0 ? (
                        <div className="pos-empty">
                          <i className="fas fa-history" />
                          <p>No closed positions</p>
                        </div>
                      ) : closedPositions.map(pos => {
                        const entryDate = new Date(pos.entry_time || (pos as any).created_at || Date.now());
                        const exitDate = new Date(pos.exit_time || (pos as any).closed_at || (pos as any).updated_at || entryDate);
                        const entryTimeStr = entryDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
                        const exitTimeStr = exitDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

                        return (
                          <div
                            key={pos.id}
                            className="pos-detail-card"
                            onClick={() => handleRowClick(pos)}
                          >
                            <div className="pos-detail-main-layout">
                              {/* Left Side: Symbol and Metadata */}
                              <div className="pos-detail-left-col">
                                <div className="pos-detail-symbol">
                                  <span className="pos-symbol-text">{fmtSymbolName(pos.kite_instrument ? pos.kite_instrument.split(':').pop() : pos.symbol, pos.name)}</span>
                                </div>
                                <div className="pos-detail-meta">
                                  <div className="pos-detail-meta-row">
                                    <span>Qty: <strong>{pos.qty_total || pos.qty_open || (pos as any).qty || 1}</strong></span>
                                    <span>Entry: <strong>{fmtPrice(pos.entry_price || pos.avg_price || 0, pos.settlement, pos.symbol)}</strong></span>
                                  </div>
                                  <div className="pos-detail-meta-row">
                                    <span>Exit: <strong>{fmtPrice(pos.exit_price || 0, pos.settlement, pos.symbol)}</strong></span>
                                    <span>Time: <strong>{exitTimeStr || entryTimeStr}</strong></span>
                                  </div>
                                </div>
                                {(pos.product_type || (isAdmin && pos.closed_by)) && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '4px' }}>
                                    {pos.product_type && (
                                      <span className={`pos-product-badge${pos.product_type === 'CARRY' ? ' carry' : ''}`}>
                                        {pos.product_type}
                                      </span>
                                    )}
                                    {isAdmin && pos.closed_by && (
                                      <span className="pos-product-badge" style={{ background: 'var(--bg-secondary, #F1F5F9)', color: 'var(--text-secondary, #64748B)', border: '1px solid var(--border-card, #E2E8F0)' }}>
                                        {pos.closed_by.replace(/_/g, ' ')}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Right Side: P&L and Status Badge */}
                              <div className="pos-detail-right-col">
                                <div className="pos-detail-pnl-group">
                                  <div className={`pos-detail-pnl${(pos.pnl || 0) >= 0 ? ' green' : ' red'}`}>
                                    {fmtUSD(pos.pnl || 0, pos.settlement, pos.symbol)}
                                  </div>
                                  <div className="pos-detail-pct">{pos.pnl_percent >= 0 ? '+' : ''}{(pos.pnl_percent || 0).toFixed(2)}%</div>
                                  <span className="pos-detail-side">{pos.side}</span>
                                </div>
                                <div>
                                  <span className="pos-status-badge closed">
                                    CLOSED
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )
                  )
                )}
              </PullToRefresh>

            </div>

            {/* Sheet */}
            <div className={`pos-sheet-overlay${isSheetOpen ? ' open' : ''}`} onClick={closeSheet} />
            <div className={`pos-sheet${isSheetOpen ? ' open' : ''}${selectedPos?.status === 'closed' ? ' pos-sheet--closed' : ''}`}>
              <div className="pos-sheet-handle"><div className="pos-sheet-handle-bar" /></div>
              {selectedPos && (
                <div className="pos-sheet-content">
                  {selectedPos.status === 'closed' ? (
                    /* ── CLOSED POSITION SHEET ── */
                    <>
                      {/* Header row */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          <div className="ps-symbol" style={{ color: 'var(--text-primary, #1A1A1A)', margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>{selectedPos.symbol}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span className={`pos-badge ${selectedPos.side === 'BUY' ? 'long' : 'short'}`} style={{ fontSize: '0.65rem', padding: '2px 8px' }}>
                              {selectedPos.side === 'BUY' ? 'LONG' : 'SHORT'}
                            </span>
                            {selectedPos.product_type && (
                              <span className={`pos-product-badge${selectedPos.product_type === 'CARRY' ? ' carry' : ''}`} style={{ fontSize: '0.65rem', padding: '2px 8px' }}>{selectedPos.product_type}</span>
                            )}
                          </div>
                        </div>
                        <button
                          style={{
                            width: '42px',
                            height: '42px',
                            borderRadius: '12px',
                            border: '1.5px solid #059669',
                            background: 'var(--card-bg, #ffffff)',
                            color: '#059669',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            transition: 'all 0.15s'
                          }}
                          onClick={() => openChart(selectedPos)}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            style={{
                              width: '1.25rem',
                              height: '1.25rem',
                              display: 'inline-block',
                              verticalAlign: 'middle',
                            }}
                          >
                            <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                            <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                            <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                            <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />
                            <path
                              d="M 4 14 L 8 9 L 13 12 L 20 4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                            <polyline
                              points="15 4 20 4 20 9"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </div>

                      {/* Realised P&L Container */}
                      <div style={{
                        backgroundColor: 'var(--card-alt-bg, #F3F4F6)',
                        border: '1px solid var(--border-light, #E8ECF0)',
                        padding: '12px 16px',
                        borderRadius: '16px',
                        display: 'flex',
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                        marginBottom: '8px',
                        boxSizing: 'border-box'
                      }}>
                        {/* Left Side: Realised P&L Info */}
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                            {(selectedPos as any).is_cumulative_group ? 'Cumulative Realised P&L' : 'Realised P&L'}
                          </div>
                          {(() => {
                            return (
                              <>
                                <div style={{ fontSize: '2rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: selectedPos.pnl >= 0 ? '#059669' : '#DC2626', lineHeight: 1 }}>
                                  {fmtUSD(selectedPos.pnl, selectedPos.settlement)}
                                </div>
                                <div style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-secondary, #6B7280)', marginTop: '4px' }}>
                                  {selectedPos.pnl_percent >= 0 ? '+' : ''}{selectedPos.pnl_percent.toFixed(2)}%
                                </div>
                              </>
                            );
                          })()}
                        </div>

                        {/* Right Side: Entry & Exit Price Stack */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', textAlign: 'right' }}>
                          <div>
                            <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '1px' }}>
                              {(selectedPos as any).is_cumulative_group ? 'Avg Entry Price' : 'Entry Price'}
                            </div>
                            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{fmtPrice(selectedPos.entry_price, selectedPos.settlement)}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '1px' }}>
                              {(selectedPos as any).is_cumulative_group ? 'Avg Exit Price' : 'Exit Price'}
                            </div>
                            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{fmtPrice(selectedPos.exit_price || 0, selectedPos.settlement)}</div>
                          </div>
                        </div>
                      </div>

                      {/* Meta grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', width: '100%', marginBottom: '8px' }}>
                        <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                            {(selectedPos as any).is_cumulative_group ? 'Total Trades' : 'Avg Price'}
                          </div>
                          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>
                            {(selectedPos as any).is_cumulative_group 
                              ? `${(selectedPos as any).trades_count || 1} ${((selectedPos as any).trades_count || 1) === 1 ? 'Trade' : 'Trades'}` 
                              : fmtPrice(selectedPos.avg_price || selectedPos.entry_price, selectedPos.settlement)}
                          </div>
                        </div>
                        <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Quantity</div>
                          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{selectedPos.qty_total}</div>
                        </div>
                        <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                            {(selectedPos as any).is_cumulative_group ? 'Avg Duration' : 'Duration'}
                          </div>
                          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>
                            {(() => {
                              const s = (selectedPos as any).is_cumulative_group
                                ? ((selectedPos as any).avg_duration_seconds || 0)
                                : (selectedPos.duration_seconds || 0);
                              if (s < 60) return `${s}s`;
                              if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
                              return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
                            })()}
                          </div>
                        </div>
                        <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Used Margin</div>
                          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>
                            {fmtPrice(selectedPos.locked_margin || selectedPos.margin_required || 0, selectedPos.settlement)}
                          </div>
                        </div>
                        <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                            {(selectedPos as any).is_cumulative_group ? 'First Entry Time' : 'Entry Time'}
                          </div>
                          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary, #1A1A1A)' }}>
                            {(() => {
                              const tStr = (selectedPos as any).is_cumulative_group ? ((selectedPos as any).first_entry_time || selectedPos.entry_time) : selectedPos.entry_time;
                              return tStr ? new Date(tStr).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
                            })()}
                          </div>
                        </div>
                        <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                          <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                            {(selectedPos as any).is_cumulative_group ? 'Last Exit Time' : 'Exit Time'}
                          </div>
                          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary, #1A1A1A)' }}>
                            {(() => {
                              const tStr = (selectedPos as any).is_cumulative_group ? ((selectedPos as any).last_exit_time || selectedPos.exit_time) : selectedPos.exit_time;
                              return tStr ? new Date(tStr).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
                            })()}
                          </div>
                        </div>
                      </div>



                      {/* Trade Again button */}
                      <button
                        style={{
                          width: '100%', padding: '11px', borderRadius: '50px',
                          border: '1.5px solid #059669', background: '#fff',
                          color: '#059669', fontSize: '0.95rem', fontWeight: 800,
                          cursor: 'pointer', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', gap: '8px', marginTop: '2px',
                          transition: 'all 0.18s',
                        }}
                        onClick={() => openTradeAgain(selectedPos)}
                      >
                        <i className="fas fa-rotate-right" />
                        Trade Again
                      </button>
                    </>
                  ) : (
                    /* ── OPEN POSITION SHEET ── */
                    <>
                      {/* Header */}
                      <div className="ps-header-row">
                        <div className="ps-header-left">
                          <div className="ps-symbol">
                            <span className="pos-symbol-text">{fmtSymbolName(selectedPos.symbol, (selectedPos as any).name)}</span>
                            {selectedPos.product_type && (
                              <span
                                className="exchange-badge"
                                style={{
                                  fontSize: '0.55rem',
                                  fontWeight: '700',
                                  padding: '1px 6px',
                                  borderRadius: '20px',
                                  marginLeft: '6px',
                                  verticalAlign: 'middle',
                                  lineHeight: '1.6',
                                  display: 'inline-block',
                                  color: selectedPos.product_type === 'CARRY' ? '#FFFFFF' : '#2C8E5A',
                                  background: selectedPos.product_type === 'CARRY' ? '#4A148C' : '#E9F6EF'
                                }}
                              >
                                {selectedPos.product_type}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                            <div className="ps-segment" style={{ margin: 0 }}>INTERNAL POSITION</div>
                            {selectedPos.product_type && (
                              <div
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  // Always resolve the live position from the positions array to avoid
                                  // stale-snapshot bugs (selectedPos is set when the sheet opens and
                                  // doesn't automatically reflect optimistic product_type updates).
                                  const livePos = positions.find(p => p.id === selectedPos.id) ?? selectedPos;
                                  await toggleProductType(livePos);
                                }}
                                className={`convert-type-btn${selectedPos.product_type === 'CARRY' ? ' carry' : ' intraday'}`}
                              >
                                {selectedPos.product_type === 'INTRADAY' ? 'INTRADAY ⇄ CARRY' : 'CARRY ⇄ INTRADAY'}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="ps-header-right">
                          <div className={`ps-price ${selectedPos.total_pnl >= 0 ? 'ps-green' : 'ps-red'}`}>
                            <TickFlash value={selectedPos.current_ltp}>{fmtPrice(selectedPos.current_ltp, selectedPos.settlement, selectedPos.symbol)}</TickFlash>
                          </div>
                          <div className={`ps-change ${selectedPos.pnl_percent >= 0 ? 'ps-green' : 'ps-red'}`}>
                            {selectedPos.pnl_percent >= 0 ? '+' : ''}{selectedPos.pnl_percent.toFixed(2)}%
                          </div>
                        </div>
                      </div>

                      {/* Bid / Ask */}
                      <div className="ps-bidask-row">
                        <div>
                          <div className="ps-ba-label">BID</div>
                          <div className="ps-ba-bid">
                            {selectedPos.current_ltp > 0 ? (
                              <TickFlash value={selectedPos.bid || selectedPos.current_ltp}>
                                {fmtPrice(selectedPos.bid || (selectedPos.current_ltp - 0.20), selectedPos.settlement, selectedPos.symbol)}
                              </TickFlash>
                            ) : '---'}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ textAlign: 'right' }}>
                            <div className="ps-ba-label">ASK</div>
                            <div className="ps-ba-ask">
                              {selectedPos.current_ltp > 0 ? (
                                <TickFlash value={selectedPos.ask || selectedPos.current_ltp}>
                                  {fmtPrice(selectedPos.ask || (selectedPos.current_ltp + 0.20), selectedPos.settlement, selectedPos.symbol)}
                                </TickFlash>
                              ) : '---'}
                            </div>
                          </div>
                          <button
                            style={{
                              width: '36px',
                              height: '36px',
                              borderRadius: '10px',
                              border: '1.5px solid #059669',
                              background: 'var(--card-bg, #ffffff)',
                              color: '#059669',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              transition: 'all 0.15s'
                            }}
                            onClick={() => openChart(selectedPos)}
                            title="Open Chart"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              style={{ width: '1.1rem', height: '1.1rem', display: 'inline-block' }}
                            >
                              <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                              <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                              <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                              <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />
                              <path d="M 4 14 L 8 9 L 13 12 L 20 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                              <polyline points="15 4 20 4 20 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* Meta row */}
                      <div className="ps-meta-row">
                        <div>
                          <div className="ps-meta-label">Avg Price</div>
                          <div className="ps-meta-val">{fmtPrice(selectedPos.avg_price || selectedPos.entry_price, selectedPos.settlement)}</div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div className="ps-meta-label">Quantity</div>
                          <div className="ps-meta-val">{selectedPos.qty_open || selectedPos.qty_total}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div className="ps-meta-label">Side</div>
                          <span className={`pos-badge ${selectedPos.side === 'BUY' ? 'long' : 'short'}`} style={{ fontSize: '0.75rem', padding: '4px 14px' }}>{selectedPos.side}</span>
                        </div>
                      </div>



                      {/* P&L + Exit All */}
                      <div className="ps-pnl-section">
                        <div>
                          <div className="ps-pnl-label">Current P&amp;L</div>
                          <div className={`ps-pnl-value ${selectedPos.total_pnl >= 0 ? 'ps-green' : 'ps-red'}`}>
                            {fmtUSD(selectedPos.total_pnl, selectedPos.settlement)}
                          </div>
                        </div>
                        <button
                          className={`ps-btn-exit${(selectedPos.hold_lock_active || exitingSet.has(selectedPos.id)) ? ' disabled-lock' : ''}`}
                          onClick={() => { if (!selectedPos.hold_lock_active && !exitingSet.has(selectedPos.id)) openTradeExit(selectedPos, false); }}
                          disabled={selectedPos.hold_lock_active || exitingSet.has(selectedPos.id)}
                        >
                          Exit All
                        </button>
                      </div>

                      {/* Add More / Partial Exit */}
                      <div className="ps-action-row">
                        <button className="ps-btn-add" onClick={() => openAddMore(selectedPos)}>Add More</button>
                        <button
                          className={`ps-btn-partial${(selectedPos.hold_lock_active || exitingSet.has(selectedPos.id)) ? ' disabled-lock' : ''}`}
                          onClick={() => { if (!selectedPos.hold_lock_active && !exitingSet.has(selectedPos.id)) openTradeExit(selectedPos, true); }}
                          disabled={selectedPos.hold_lock_active || exitingSet.has(selectedPos.id)}
                        >
                          Partial Exit
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className={`pos-toast${toast ? ' show' : ''}`} onClick={() => setToast(null)} style={{ cursor: 'pointer' }}>
              <i className="fas fa-circle-info" />
              <span>{toast}</span>
            </div>

            {/* Profit Side Hold Timer Modal */}
            <div className={`pos-modal-overlay${lockModalPos ? ' open' : ''}`} onClick={() => setLockModalPos(null)}>
              <div className="pos-modal-card" onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '16px', padding: '12px 16px', background: 'var(--card-alt-bg)', borderRadius: '12px', border: '1px solid var(--border-light)' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Time Remaining</span>
                  <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                    {lockModalPos
                      ? <HoldLockCountdown pos={lockModalPos} style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)' }} />
                      : '00m 00s'}
                  </span>
                </div>

                <div className="pos-modal-title">Profit Side Hold Timer</div>
                <div className="pos-modal-desc" style={{ color: 'var(--text-secondary)' }}>
                  This position is currently in profit. You must hold profitable trades for a minimum period before exiting.
                </div>

                <div className="pos-modal-actions">
                  <button
                    className="pos-modal-btn cancel"
                    style={{ width: '100%' }}
                    onClick={() => setLockModalPos(null)}
                  >
                    Got it
                  </button>
                </div>
              </div>
            </div>

            {/* Exit All Confirmation Modal */}
            <div className={`pos-modal-overlay${isExitAllModalOpen ? ' open' : ''}`} onClick={() => !isExitingAll && setIsExitAllModalOpen(false)}>
              <div className="pos-modal-card" onClick={e => e.stopPropagation()}>
                <div className="pos-modal-icon">
                  <i className="fas fa-exclamation-triangle" />
                </div>
                <div className="pos-modal-title">Close All Positions?</div>
                <div className="pos-modal-desc">
                  Are you sure you want to exit all <strong>{openPositions.length}</strong> open positions? This action will execute market orders immediately and cannot be undone.
                </div>
                <div className="pos-modal-actions">
                  <button
                    className="pos-modal-btn cancel"
                    onClick={() => setIsExitAllModalOpen(false)}
                    disabled={isExitingAll}
                  >
                    Cancel
                  </button>
                  <button
                    className="pos-modal-btn confirm"
                    onClick={handleExitAllConfirm}
                    disabled={isExitingAll}
                  >
                    {isExitingAll ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><AnimatedLoader size="small" /> Closing...</span>
                    ) : (
                      'Confirm Exit All'
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Convert Confirm Modal */}
            <div className={`pos-modal-overlay${convertConfirmPos ? ' open' : ''}`} onClick={() => setConvertConfirmPos(null)}>
              <div className="pos-modal-card" onClick={e => e.stopPropagation()}>

                {convertConfirmPos?.product_type === 'INTRADAY' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '16px', padding: '12px 16px', background: 'var(--card-alt-bg)', borderRadius: '12px', border: '1px solid var(--border-light)' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Carry Brokerage</span>
                    {isFetchingPreview ? (
                      <AnimatedLoader size="small" />
                    ) : (
                      <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                        ₹{convertPreviewBrokerage != null ? convertPreviewBrokerage.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '0.00'}
                      </span>
                    )}
                  </div>
                )}

                <div className="pos-modal-title">Convert to {convertConfirmPos?.product_type === 'INTRADAY' ? 'CARRY' : 'INTRADAY'}</div>
                <div className="pos-modal-desc" style={{ color: 'var(--text-secondary)' }}>
                  {convertConfirmPos?.product_type === 'INTRADAY' ? (
                    <>
                      Converting to CARRY will immediately deduct a carry brokerage fee from your balance.
                    </>
                  ) : (
                    <>
                      When you convert a CARRY position back to INTRADAY, you will not be reimbursed for the CARRY brokerage you already paid.
                    </>
                  )}
                </div>
                <div className="pos-modal-actions">
                  <button
                    className="pos-modal-btn cancel"
                    onClick={() => setConvertConfirmPos(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="pos-modal-btn confirm"
                    style={{ backgroundColor: '#D97706', color: '#fff', border: 'none' }}
                    onClick={confirmConvertProductType}
                    disabled={isFetchingPreview}
                  >
                    Confirm Convert
                  </button>
                </div>
              </div>
            </div>

          </div>
        </div>
      </main>

      {/* ── Group Exit Confirmation Modal ── */}
      {groupExitModalGroup && (
        <div className="confirm-backdrop" onClick={() => setGroupExitModalGroup(null)}>
          <div className="confirm-card" onClick={e => e.stopPropagation()}>
            <div className="confirm-icon">
              <i className="fas fa-exclamation-triangle" />
            </div>
            <h3 className="confirm-title">Exit {groupExitModalGroup.symbol}?</h3>
            <p className="confirm-message">
              Are you sure you want to close {groupExitModalGroup.ids.length > 1 ? `all ${groupExitModalGroup.ids.length}` : 'this'} position(s) for this symbol?
            </p>
            <div className="confirm-actions">
              <button className="confirm-btn confirm-btn-cancel" onClick={() => setGroupExitModalGroup(null)}>
                Cancel
              </button>
              <button className="confirm-btn confirm-btn-exit" onClick={handleGroupExitConfirm}>
                Yes, Exit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Pending Order Warning Popup ── */}
      {pendingOrderWarnMsg && (
        <div className="confirm-backdrop" onClick={() => { setPendingOrderWarnMsg(null); setPendingOrderWarnCallback(null); }}>
          <div className="confirm-card" onClick={e => e.stopPropagation()}>
            <div className="confirm-icon" style={{ background: '#fffbeb' }}>
              <i className="fas fa-exclamation-triangle" style={{ color: '#d97706' }} />
            </div>
            <h3 className="confirm-title">Open Order Exists</h3>
            <p className="confirm-message">
              {pendingOrderWarnMsg}
            </p>
            <div className="confirm-actions">
              <button
                className="confirm-btn confirm-btn-cancel"
                style={{ flex: 1 }}
                onClick={() => { setPendingOrderWarnMsg(null); setPendingOrderWarnCallback(null); }}
              >
                Go Back
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Add More — full watchlist-style trade sheet */}
      <TradeSheet
        item={tradeSheetItem}
        side={tradeSheetSide}
        onClose={() => { setTradeSheetItem(null); setTradeSheetExitMode(false); setTradeSheetProductType(undefined); setTradeSheetIsAddMore(false); setTradeSheetLinkedPosId(null); setTradeSheetInitialExitQty(undefined); }}
        onSuccess={refresh}
        exitMode={tradeSheetExitMode}
        productType={tradeSheetProductType}
        isFromPositions={tradeSheetIsAddMore}
        linkedPosId={tradeSheetLinkedPosId}
        initialExitQty={tradeSheetInitialExitQty}
        hideLotText={true}
      />

      {/* Chart Sheet */}
      <div id="chartSheetOverlay" className="trade-sheet-overlay" onClick={() => { const sheet = document.getElementById('chartSheet'); const overlay = document.getElementById('chartSheetOverlay'); if (sheet) sheet.classList.remove('open'); if (overlay) overlay.classList.remove('active'); setChartItem(null); }}></div>
      <div id="chartSheet" className="trade-sheet" style={{ height: '100dvh', paddingBottom: '0', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, position: 'relative', width: '100%', overflow: 'hidden' }}>
          {chartItem && (
            <TradingChart
              symbol={chartItem.kiteSymbol || chartItem.symbol}
              segment={chartItem.segment}
              liveQuote={{ lastPrice: positions.find(p => p.symbol === chartItem.symbol)?.current_ltp ?? chartItem.price }}
              onClose={() => {
                const sheet = document.getElementById('chartSheet');
                const overlay = document.getElementById('chartSheetOverlay');
                if (sheet) sheet.classList.remove('open');
                if (overlay) overlay.classList.remove('active');
                setChartItem(null);
              }}
            />
          )}
        </div>
      </div>
      <ErrorModal error={errorModalMsg} onClose={() => setErrorModalMsg(null)} title="Order Failed" />
    </div>
  );
}
