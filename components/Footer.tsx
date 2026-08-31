'use client';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import TickFlash from '@/components/TickFlash';
import { useMyPositions, EnrichedPosition } from '@/hooks/useMyPositions';
import { useBalance } from '@/hooks/useBalance';
import './Footer.css';

const mapSegmentToDbSegment = (s: string): string => {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed === 'NSE - Futures' || trimmed === 'BSE - Futures') return 'INDEX-FUT';
  if (trimmed === 'NSE - Options' || trimmed === 'BSE - Options') return 'INDEX-OPT';
  if (trimmed === 'NSE - Stock Futures' || trimmed === 'BSE - Stock Futures') return 'STOCK-FUT';
  if (trimmed === 'NSE - Stock Options' || trimmed === 'BSE - Stock Options') return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures') return 'MCX-FUT';
  if (trimmed === 'MCX - Options') return 'MCX-OPT';
  if (trimmed === 'NSE - Equity' || trimmed === 'BSE - Equity') return 'STOCKS';
  if (trimmed === 'Crypto' || trimmed === 'CRYPTO') return 'CRYPTO';
  if (trimmed === 'Forex' || trimmed === 'FOREX' || trimmed === 'CDS - Futures' || trimmed === 'CDS - Options') return 'FOREX';
  if (trimmed === 'COMEX - Futures' || trimmed === 'COMEX - Options' || trimmed === 'COMEX' || trimmed === 'COI') return 'COMEX';
  return trimmed;
};

interface FooterProps {
  activeTab: 'home' | 'watchlist' | 'order' | 'position' | 'history' | 'profile';
  hideDrawer?: boolean;
  positions?: EnrichedPosition[];
}

const Footer: React.FC<FooterProps> = ({ activeTab, hideDrawer = false, positions }) => {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const handleAreaRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const lastY = useRef(0);
  const velocity = useRef(0);
  const lastTimestamp = useRef(0);
  const [vh, setVh] = useState(800);

  useEffect(() => {
    setVh(window.innerHeight);
    const handleResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Balance and settlement from the global BalanceDataProvider
  const { balance, settlementAmount } = useBalance();
  const [autoSqoffPercent, setAutoSqoffPercent] = useState(90);

  useEffect(() => {
    let cancelled = false;
    let channel: any = null;

    const initAutoSqoff = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || cancelled) return;

      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('showcase_auto_sqoff')
          .eq('id', session.user.id)
          .single();
        if (profile && !cancelled) {
          setAutoSqoffPercent(Number((profile as any).showcase_auto_sqoff ?? 85));
        }
      } catch (err) {
        console.error('Failed to fetch profile settings in Footer', err);
      }

      // Subscribe to realtime profile changes for auto_sqoff only
      // (balance and settlement are handled by BalanceDataProvider)
      channel = supabase
        .channel(`profile-realtime-footer-sqoff-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${session.user.id}` },
          (payload) => {
            if (cancelled) return;
            const updated = payload.new as any;
            if (updated) {
              setAutoSqoffPercent(Number(updated.showcase_auto_sqoff ?? 85));
            }
          }
        )
        .subscribe();
    };

    initAutoSqoff();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  const { positions: fetchedPositions } = useMyPositions();
  const enrichedPositions = positions || fetchedPositions;

  // Live P&L, Used Margin (frozen) and Equity calculations — update on every tick
  const { floatingPnl, lossOnlyPnl, usedMargin, positionValue, liquidationLevel } = useMemo(() => {
    let totalUnrealised = 0;
    let totalLockedMargin = 0;
    let totalPositionValue = 0;
    let totalLossOnlyPnl = 0;

    enrichedPositions.filter(p => p.status === 'open' || p.status === 'active').forEach(p => {
      const pnl = p.total_pnl ?? 0;
      totalUnrealised += pnl;
      if (pnl < 0) totalLossOnlyPnl += pnl;
      totalLockedMargin += Number(p.locked_margin || p.margin_required || 0);
      totalPositionValue += Math.abs(p.qty_open) * p.current_ltp;
    });

    const liqLevel = -(balance * (autoSqoffPercent / 100));

    return {
      floatingPnl: totalUnrealised,
      lossOnlyPnl: totalLossOnlyPnl,
      usedMargin: totalLockedMargin,
      positionValue: totalPositionValue,
      liquidationLevel: liqLevel,
    };
  }, [enrichedPositions, balance, autoSqoffPercent]);

  const equity = balance + floatingPnl;
  const freeMargin = balance + floatingPnl - usedMargin;
  const fmt = (n: number) => Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const [openHeight, setOpenHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current) return;
    // Use ResizeObserver to get accurate height
    const ro = new ResizeObserver(() => {
      if (contentRef.current) {
        setOpenHeight(contentRef.current.offsetHeight + 4);
      }
    });
    ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, []);

  // Apply height whenever isOpen or vh changes
  useEffect(() => {
    if (!panelRef.current) return;
    panelRef.current.style.transition = 'height 0.4s cubic-bezier(0.2, 0.9, 0.3, 1)';
    panelRef.current.style.height = isOpen ? `${openHeight}px` : '0px';
    panelRef.current.style.background = isOpen ? 'var(--drawer-bg, #FFFFFF)' : 'transparent';
    // Hide inner content when closed so overflow:visible doesn't leak it
    if (contentRef.current) {
      contentRef.current.style.visibility = isOpen ? 'visible' : 'hidden';
    }
  }, [isOpen, vh]);

  // Reset drawer when switching pages
  useEffect(() => {
    setIsOpen(false);
  }, [activeTab]);

  // Drag to open/close
  const handleTouchStart = (e: React.TouchEvent | React.MouseEvent) => {
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    startY.current = clientY;
    lastY.current = clientY;
    lastTimestamp.current = Date.now();
    if (panelRef.current) panelRef.current.style.transition = 'none';
  };

  const handleTouchMove = (e: React.TouchEvent | React.MouseEvent) => {
    if (!startY.current) return;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const now = Date.now();
    velocity.current = (lastY.current - clientY) / (now - lastTimestamp.current + 1);
    lastY.current = clientY;
    lastTimestamp.current = now;
    const delta = clientY - startY.current;
    const base = isOpen ? openHeight : 0;
    const nextH = base - delta;
    const finalH = Math.max(0, Math.min(openHeight * 1.1, nextH));
    if (panelRef.current) panelRef.current.style.height = `${finalH}px`;
  };

  const handleTouchEnd = () => {
    startY.current = 0;
    if (!panelRef.current) return;
    // Use velocity to decide open or close
    if (velocity.current > 0.3) {
      setIsOpen(true);
    } else if (velocity.current < -0.3) {
      setIsOpen(false);
    } else {
      const currentH = parseFloat(panelRef.current.style.height) || 0;
      setIsOpen(currentH > openHeight / 2);
    }
  };

  const showDrawer = !hideDrawer;

  return (
    <>
      {showDrawer && (
        <div className="account-drawer-ark" ref={panelRef}>
          {/* Red line moves WITH the drawer - sits at drawer's top edge */}
          <div className="ark-drawer-top-line"></div>
          {/* Arrow handle protrudes above via overflow:visible */}
          <div
            className="ark-drag-handle-area"
            ref={handleAreaRef}
            onClick={() => setIsOpen(prev => !prev)}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleTouchStart}
            onMouseMove={(e) => startY.current ? handleTouchMove(e) : undefined}
            onMouseUp={handleTouchEnd}
            onMouseLeave={() => startY.current ? handleTouchEnd() : undefined}
          >
            <i className={`fas fa-chevron-up toggle-arrow${isOpen ? ' rotated' : ''}`}></i>
          </div>
          <div className="drawer-inner-scroll" ref={contentRef}>
            <div className="drawer-account-summary">
              <div className="summary-grid">
                <div className="summary-item">
                  <span className="summary-label">Balance</span>
                  <span className="summary-value"><TickFlash value={balance}>{balance < 0 ? '-' : ''}₹{fmt(balance)}</TickFlash></span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Free Margin</span>
                  <span className={`summary-value ${freeMargin >= 0 ? '' : 'negative'}`} suppressHydrationWarning>
                    <TickFlash value={freeMargin} suppressHydrationWarning>{freeMargin < 0 ? '-' : ''}₹{fmt(freeMargin)}</TickFlash>
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Floating P/L</span>
                  <span className={`summary-value ${floatingPnl >= 0 ? 'pnl-green' : 'negative'}`} suppressHydrationWarning>
                    <TickFlash value={floatingPnl} suppressHydrationWarning>{floatingPnl >= 0 ? '+' : '-'}₹{fmt(floatingPnl)}</TickFlash>
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Equity</span>
                  <span className="summary-value">
                    <TickFlash value={positionValue}>₹{fmt(positionValue)}</TickFlash>
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Used Margin</span>
                  <span className="summary-value">
                    <TickFlash value={usedMargin}>{usedMargin < 0 ? '-' : ''}₹{fmt(usedMargin)}</TickFlash>
                  </span>
                </div>
                <div className="summary-item">
                  <span className="summary-label">Liquidation ({autoSqoffPercent}%)</span>
                  <span className="summary-value">
                    <TickFlash value={liquidationLevel}>{liquidationLevel < 0 ? '-' : ''}₹{fmt(liquidationLevel)}</TickFlash>
                  </span>
                </div>

              </div>
            </div>
          </div>
        </div>
      )}

      <div className="footer-section">
        <div className="footer-nav" data-active={activeTab}>
          <Link href="/" prefetch={true} className={`footer-tab ${activeTab === 'home' ? 'active' : ''}`}>
            <i className="fas fa-home footer-icon"></i>
            <span className="footer-label">Home</span>
          </Link>
          <Link href="/watchlist" prefetch={true} className={`footer-tab ${activeTab === 'watchlist' ? 'active' : ''}`}>
            <i className="fas fa-list footer-icon"></i>
            <span className="footer-label">Watchlist</span>
          </Link>
          <Link href="/order" prefetch={true} className={`footer-tab ${activeTab === 'order' ? 'active' : ''}`}>
            <i className="fas fa-file-invoice-dollar footer-icon"></i>
            <span className="footer-label">Order</span>
          </Link>
          <Link href="/position" prefetch={true} className={`footer-tab ${activeTab === 'position' ? 'active' : ''}`}>
            <i className="fas fa-chart-line footer-icon"></i>
            <span className="footer-label">Position</span>
          </Link>
          <Link href="/history" prefetch={true} className={`footer-tab ${activeTab === 'history' ? 'active' : ''}`}>
            <i className="fas fa-history footer-icon"></i>
            <span className="footer-label">History</span>
          </Link>
        </div>
      </div>
    </>
  );
};

export default Footer;
