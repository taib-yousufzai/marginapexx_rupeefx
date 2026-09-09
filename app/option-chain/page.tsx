'use client';

import React, { useState, useEffect, Suspense, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useOrderEntry, OrderSide, OrderType, ProductType } from '@/hooks/useOrderEntry';
import { useActivePositions } from '@/hooks/useActivePositions';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import OptionChainTable from './OptionChainTable';
import TradingSegmentsDrawer from '@/components/TradingSegmentsDrawer';
import { WatchlistItem, getTabForItem } from '@/app/watchlist/page';
import AnimatedLoader from '@/components/AnimatedLoader';
import { calculateMarginPortion } from '@/lib/trading/MarginCalculator';
import { api, ApiError } from '@/lib/api';
import { useTradeConfig } from '@/contexts/TradeConfigContext';
import './option-chain.css';
import dynamic from 'next/dynamic';
const TradeSheet = dynamic(() => import('@/components/TradeSheet'), { ssr: false });
import { ErrorModal } from '@/components/ErrorModal';

const TradingChart = dynamic(() => import('@/components/TradingChart'), { ssr: false });

function addToWatchlist(item: {
  name: string;
  symbol: string;
  kiteSymbol: string;
  price: number;
  change: string;
  segment: string;
  contractDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  category?: string;
  lotSize?: number;
}, userId?: string) {
  const WATCHLIST_KEY = 'marginApex_watchlist';
  try {
    const key = userId ? `${WATCHLIST_KEY}_${userId}` : WATCHLIST_KEY;
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];

    const targetCat = item.category || 'WATCHLIST';
    // Check if already exists in the selected watchlist
    const exists = list.some((i: any) => i.symbol === item.symbol && (i.category || 'WATCHLIST') === targetCat);
    if (exists) return false;

    const newItem = { ...item, category: targetCat };
    list.push(newItem);
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

declare global {
  interface Window {
    __optionChainCache?: Record<string, any>;
  }
}

// Read cache safely from localStorage — used only for expiry list, never for strikes
function getLocalCache(key: string) {
  // Always return null — we never serve stale option chain data from cache.
  // The API is always called fresh so the ATM window reflects the current spot.
  return null;
}

function setLocalCache(_key: string, _data: any) {
  // No-op — caching disabled to ensure strikes are always fresh
}

function OptionChainContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();

  const [isDark, setIsDark] = React.useState(false);
  React.useEffect(() => {
    const check = () => setIsDark(document.body.classList.contains('dark'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);

  const { placeOrder, loading: placingOrder, error: orderError, setError: setOrderError } = useOrderEntry();

  const [selectedContract, setSelectedContract] = useState<{ symbol: string, type: 'CE' | 'PE', strike: number } | null>(null);
  const [chartItem, setChartItem] = useState<any>(null);
  const { positions: activePositions, refreshPositions } = useActivePositions();

  // Dual popup and Trade Sheet States
  const [sheetView, setSheetView] = useState<'DETAILS' | 'ORDER'>('DETAILS');
  const [sheetSide, setSheetSide] = useState<'BUY' | 'SELL'>('BUY');

  const [userId, setUserId] = useState<string>('');
  // segmentSettings and scriptSettings come from the shared TradeConfigProvider
  const { segmentSettings, scriptSettings } = useTradeConfig();

  useEffect(() => {
    async function fetchUserId() {
      try {
        const { getSharedSession } = await import('@/lib/sharedSession');
        const { token, userId: uid } = await getSharedSession();
        if (!token || !uid) return;
        setUserId(uid);
      } catch (err) {
        console.error('Failed to get session', err);
      }
    }
    fetchUserId();
  }, []);

  // Compute lot size: DB script_settings take priority over hardcoded fallbacks.
  // For MCX options (CRUDEOIL, GOLD, SILVER, NATURALGAS), the exchange publishes
  // lot_size=1 per contract — use that directly instead of the futures multiplier.
  const lotSize = (() => {
    const n = symbol.toUpperCase();
    const sortedSettings = [...scriptSettings].sort((a, b) => b.symbol.length - a.symbol.length);
    const dbMatch = sortedSettings.find(s => n.includes(s.symbol.toUpperCase()));
    if (dbMatch) return Number(dbMatch.lot_size);
    if (n.includes('BANKNIFTY') || n.includes('BANKEX')) return 30;
    if (n.includes('FINNIFTY')) return 60;
    if (n.includes('MIDCP') || n.includes('MIDCAP')) return 120;
    if (n.includes('SENSEX')) return 20;
    if (n.includes('NIFTY')) return 65;
    // MCX options: 1 contract = 1 lot (lot_size=1 in Zerodha master)
    return 1;
  })();

  // Removed handleQtyChange as it is handled by TradeSheet

  const handleAddToWatchlistClick = () => {
    if (!selectedContract) return;
    const strikeMatch = data?.strikes.find(s => s.ce?.symbol === selectedContract.symbol || s.pe?.symbol === selectedContract.symbol);
    const contractData = selectedContract.type === 'CE' ? strikeMatch?.ce : strikeMatch?.pe;
    if (!contractData) return;

    const kiteId = contractData.id;
    const quote = kiteId ? quotes[kiteId] : null;
    const price = quote ? quote.lastPrice : 0;
    const change = quote ? `${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%` : '0.00%';
    const open = quote ? quote.open : 0;
    const high = quote ? quote.high : 0;
    const low = quote ? quote.low : 0;
    const close = quote ? quote.close : 0;

    const success = addToWatchlist({
      name: `${symbol} ${selectedContract.strike.toLocaleString('en-IN')} ${selectedContract.type}`,
      symbol: selectedContract.symbol,
      kiteSymbol: kiteId || selectedContract.symbol,
      price,
      change,
      segment: (symbol.includes('GOLD') || symbol.includes('SILVER') || symbol.includes('CRUDE') || symbol.includes('NATGAS') || symbol.includes('NATURALGAS')) ? 'MCX - Options' : (symbol.includes('SENSEX') || symbol.includes('BANKEX') ? 'BSE - Options' : 'NSE - Options'),
      contractDate: selectedExpiry ? selectedExpiry : '',
      open,
      high,
      low,
      close,
      category: 'INDEX-OPT',
      lotSize: contractData.lotSize
    }, userId);

    if (success) {
      showToast('Added to Watchlist', false);
    } else {
      showToast('Already added to Watchlist', true);
    }
  };

  const lastSpotPriceRef = useRef<number>(0);

  // Toast State
  const [toast, setToast] = useState<{ msg: string; isError: boolean; visible: boolean }>({
    msg: '', isError: false, visible: false
  });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string, isError: boolean) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ msg, isError, visible: true });
    toastTimerRef.current = setTimeout(() => {
      setToast(t => ({ ...t, visible: false }));
    }, 3500);
  };

  // order_error is now handled centrally in ClientShell — no local state or listener needed.

  // Normalization for MIDCAP
  const normalizedSymbol = symbol === 'MIDCAP' ? 'MIDCPNIFTY' : symbol;

  // Compute user's strike range for INDEX-OPT from their segment settings
  const userStrikeRange = React.useMemo(() => {
    const isIndexOpt = normalizedSymbol.includes('NIFTY') || normalizedSymbol.includes('SENSEX') || normalizedSymbol.includes('BANKEX');
    const seg = isIndexOpt ? 'INDEX-OPT' : 'MCX-OPT';
    const setting = segmentSettings.find(s => s.segment === seg);
    return Number(setting?.strike_range ?? 0);
  }, [segmentSettings, normalizedSymbol]);

  // Compute bid_buffer for display spread in option chain (MCX-OPT / INDEX-OPT)
  // bid_buffer = 0 for NSE/BSE options (real exchange depth is used)
  // bid_buffer = user setting for MCX options (synthetic spread from LTP)
  const displayBidBuffer = React.useMemo(() => {
    const isIndexOpt = normalizedSymbol.includes('NIFTY') || normalizedSymbol.includes('SENSEX') || normalizedSymbol.includes('BANKEX');
    // Index options (NSE/BSE) use real exchange bid/ask — no synthetic buffer needed
    if (isIndexOpt) return 0;
    // MCX options: use user's configured bid_buffer
    const mcxSetting = segmentSettings.find(s => s.segment === 'MCX-OPT');
    return Number(mcxSetting?.bid_buffer ?? 0);
  }, [segmentSettings, normalizedSymbol]);

  const useLtpMode = React.useMemo(() => {
    const isIndexOpt = normalizedSymbol.includes('NIFTY') || normalizedSymbol.includes('SENSEX') || normalizedSymbol.includes('BANKEX');
    const seg = isIndexOpt ? 'INDEX-OPT' : 'MCX-OPT';
    const setting = segmentSettings.find(s => s.segment === seg);
    return setting?.exit_price_mode === 'LTP';
  }, [segmentSettings, normalizedSymbol]);


  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const [showCharges, setShowCharges] = useState(false);

  const cacheKey = `${normalizedSymbol}_${selectedExpiry || 'default'}`;
  
  const [data, setData] = useState<{
    expiries: string[];
    strikes: any[];
    expiry: string;
    underlyingPrice?: number;
    underlyingSymbol?: string;
  } | null>(getLocalCache(cacheKey));
  
  const [loading, setLoading] = useState(!getLocalCache(cacheKey));
  const [isSegmentsOpen, setIsSegmentsOpen] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);


  // Refresh positions when selected contract changes
  useEffect(() => {
    refreshPositions();
    const interval = setInterval(refreshPositions, 5000);
    return () => clearInterval(interval);
  }, [selectedContract, refreshPositions]);

  // Fetch initial option chain data
  useEffect(() => {
    const cached = getLocalCache(cacheKey);
    if (cached) {
      setData(cached);
      setLoading(false);
      setLoadingError(null);
      if (!selectedExpiry && (cached as { expiry?: string }).expiry) {
        setSelectedExpiry((cached as { expiry?: string }).expiry!);
      }
    }

    async function fetchData() {
      setLoading(true);
      setLoadingError(null);
      try {
        const spotPriceParam = lastSpotPriceRef.current > 0 ? `&spotPrice=${lastSpotPriceRef.current}` : '';
        const url = `/api/market/option-chain?symbol=${normalizedSymbol}${selectedExpiry ? `&expiry=${selectedExpiry}` : ''}${spotPriceParam}&_t=${Date.now()}`;
        const json = await api.get<{ success: boolean; expiry: string; error?: string; strikes: any[]; expiries: string[]; underlyingPrice?: number; underlyingSymbol?: string }>(url);
        if (json.success) {
          setLocalCache(cacheKey, json);
          setLocalCache(`${normalizedSymbol}_${json.expiry}`, json);
          setData(json);
          if (!selectedExpiry) setSelectedExpiry(json.expiry);
        } else {
          setLoadingError(json.error || 'Failed to fetch option chain');
        }
      } catch (err: any) {
        if (err instanceof ApiError && err.status === 403) {
          setLoadingError('locked');
        } else {
          console.error('Failed to fetch option chain', err);
          setLoadingError('Failed to fetch option chain');
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [normalizedSymbol, selectedExpiry, cacheKey]);

  // Extract all instrument IDs for real-time quotes
  const instrumentIds = React.useMemo(() => {
    if (!data) return [];
    const ids: string[] = data.underlyingSymbol ? [data.underlyingSymbol] : [];
    data.strikes.forEach(s => {
      if (s.ce?.id) ids.push(s.ce.id);
      if (s.pe?.id) ids.push(s.pe.id);
    });
    return ids;
  }, [data]);

  const { quotes } = useMarketQuotes(instrumentIds);
  const connected = true;

  const spotPrice = React.useMemo(() => {
    if (data?.underlyingSymbol) {
      const sym = data.underlyingSymbol;
      // Try full key first (e.g. "NSE:NIFTY 50"), then without exchange prefix,
      // then without spaces, to handle any key-format mismatch from the quote feed
      const q =
        quotes[sym] ||
        quotes[sym.split(':').pop() || sym] ||
        quotes[sym.replace(/\s+/g, '_')] ||
        quotes[sym.split(':').pop()?.replace(/\s+/g, '_') || sym];
      if (q && q.lastPrice) return q.lastPrice;
    }
    return data?.underlyingPrice || 0;
  }, [quotes, data]);

  React.useEffect(() => {
    if (spotPrice > 0) {
      lastSpotPriceRef.current = spotPrice;
    }
  }, [spotPrice]);

  // Reset refetch tracking whenever symbol or expiry changes
  useEffect(() => {
    hasRefetchedRef.current = false;
  }, [normalizedSymbol, selectedExpiry]);

  // Re-fetch when live spot price diverges from the API's underlyingPrice
  // or when the server used a median fallback due to missing cold-start Redis quotes.
  const hasRefetchedRef = useRef(false);
  useEffect(() => {
    if (hasRefetchedRef.current || !data?.underlyingPrice || !spotPrice || spotPrice <= 0) return;
    const apiAtm = data.underlyingPrice;
    const absDiff = Math.abs(spotPrice - apiAtm);
    const strikeStep = normalizedSymbol.includes('MIDCP') ? 25 : (normalizedSymbol.includes('NIFTY') ? 50 : 100);
    const usedFallback = (data as any)?.usedFallback;

    // Trigger re-fetch if server used median fallback OR if spot differs by >= 1 strike step
    if (usedFallback || absDiff >= strikeStep || (absDiff / apiAtm) > 0.0015) {
      hasRefetchedRef.current = true;
      lastSpotPriceRef.current = spotPrice;
      (async () => {
        try {
          const url = `/api/market/option-chain?symbol=${normalizedSymbol}${selectedExpiry ? `&expiry=${selectedExpiry}` : ''}&spotPrice=${spotPrice}&_t=${Date.now()}`;
          const json = await api.get<{ success: boolean; expiry: string; error?: string; strikes: any[]; expiries: string[]; underlyingPrice?: number; underlyingSymbol?: string; usedFallback?: boolean }>(url);
          if (json.success) {
            setData(json);
          }
        } catch { /* non-fatal — original data still displayed */ }
      })();
    }
  }, [spotPrice, data, normalizedSymbol, selectedExpiry]);

  const handleTrade = (instrSymbol: string, side: 'BUY' | 'SELL') => {
    const strikeMatch = data?.strikes.find(s => s.ce?.symbol === instrSymbol || s.pe?.symbol === instrSymbol);
    if (strikeMatch) {
      const type = strikeMatch.ce?.symbol === instrSymbol ? 'CE' : 'PE';
      setSelectedContract({ symbol: instrSymbol, type, strike: strikeMatch.strike });
      setSheetView('DETAILS');
      setSheetSide(side);
    }
  };

  const handleOpenChart = (instrSymbol: string, kiteIdParam?: string) => {
    const strikeMatch = data?.strikes.find(s => s.ce?.symbol === instrSymbol || s.pe?.symbol === instrSymbol);
    const contractData = strikeMatch?.ce?.symbol === instrSymbol ? strikeMatch?.ce : strikeMatch?.pe;
    const kiteId = kiteIdParam || contractData?.id || (instrSymbol.includes(':') ? instrSymbol : null);

    const isMcxOpt = symbol.includes('GOLD') || symbol.includes('SILVER') || symbol.includes('CRUDE') || symbol.includes('NATGAS') || symbol.includes('NATURALGAS');
    const isBfoOpt = symbol.includes('SENSEX') || symbol.includes('BANKEX');
    const isCdsOpt = symbol.includes('USDINR') || symbol.includes('EURINR') || symbol.includes('GBPINR') || symbol.includes('JPYINR');
    const optSegment = isMcxOpt ? 'MCX - Options' : (isBfoOpt ? 'BFO' : (isCdsOpt ? 'CDS' : 'NFO'));
    const prefix = isMcxOpt ? 'MCX' : (isBfoOpt ? 'BFO' : (isCdsOpt ? 'CDS' : 'NFO'));
    const fullKiteSymbol = kiteId || (instrSymbol.includes(':') ? instrSymbol : `${prefix}:${instrSymbol}`);

    setChartItem({
      symbol: instrSymbol,
      kiteSymbol: fullKiteSymbol,
      segment: optSegment
    });
    setSelectedContract(null);
    const chartSheet = document.getElementById('chartSheet');
    const chartOverlay = document.getElementById('chartSheetOverlay');
    if (chartSheet) chartSheet.classList.add('open');
    if (chartOverlay) chartOverlay.classList.add('active');
  };

  const closeTradeSheet = () => {
    setSelectedContract(null);
  };

  const [priceMode, setPriceMode] = useState<'BA' | 'LTP'>('BA');

  if (!mounted) return null;

  return (
    <div className={`oc-app-container${mounted && isDark ? ' dark' : ''}`} suppressHydrationWarning>
      <header className="app-header premium-header">
        <div className="header-wrapper">
          <div className="oc-capsule-header">
            {/* Left: back btn + symbol info */}
            <div className="oc-capsule-left">
              <div className="premium-back-btn" onClick={() => router.back()}>
                <i className="fas fa-arrow-left" style={{ fontSize: '0.9rem' }}></i>
              </div>
              <div className="oc-capsule-info">
                <div className="premium-symbol-name">{symbol}</div>
                <div className="oc-capsule-sub">
                  <span className="premium-badge">OPTION CHAIN</span>
                  {connected ? (
                    <div className="pulsing-dot connected"></div>
                  ) : (
                    <>
                      <div className="pulsing-dot connecting"></div>
                      <span className="connecting-text">Connecting...</span>
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* Right: B/A + LTP toggle */}
            <div className="oc-capsule-right">
              <div className="oc-mode-toggle">
                {(['BA', 'LTP'] as const).map(m => (
                  <button key={m} className={`oc-mode-btn${priceMode === m ? ' active' : ''}`} onClick={() => setPriceMode(m)}>
                    {m === 'BA' ? 'B/A' : 'LTP'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="main-content">
        <div className="content-wrapper">
          {/* Expiry Strip — capsule container with spot + dates */}
          <div className="expiry-strip">
            <div className="expiry-capsule-bar">
              {/* Spot Price — inner capsule like dates */}
              <div className="expiry-spot-inner-capsule">
                <div className="expiry-spot-pill">
                  <span className="expiry-spot-label">Spot</span>
                  <span className="expiry-spot-val">
                    ₹{spotPrice > 0 ? spotPrice.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '---'}
                  </span>
                </div>
              </div>
              {/* Divider */}
              <div className="expiry-divider"></div>
              {/* Chart Button */}
              <div className="oc-mode-toggle" style={{ marginLeft: 'auto', marginRight: '4px' }}>
                <button
                  className="oc-mode-btn active"
                  onClick={() => {
                    const isMcxOpt = symbol.includes('GOLD') || symbol.includes('SILVER') || symbol.includes('CRUDE') || symbol.includes('NATGAS') || symbol.includes('NATURALGAS');
                    const isBfoOpt = symbol.includes('SENSEX') || symbol.includes('BANKEX');
                    const optSegment = isMcxOpt ? 'MCX - Options' : (isBfoOpt ? 'BFO' : 'NFO');
                    setChartItem({
                      symbol: symbol,
                      kiteSymbol: data?.underlyingSymbol || symbol,
                      segment: optSegment
                    });
                    const chartSheet = document.getElementById('chartSheet');
                    const chartOverlay = document.getElementById('chartSheetOverlay');
                    if (chartSheet) chartSheet.classList.add('open');
                    if (chartOverlay) chartOverlay.classList.add('active');
                  }}
                  title="Open Chart"
                >
                  CHART
                </button>
              </div>
              {/* Date pills — inner capsule like B/A toggle */}
              <div className="expiry-dates-inner-capsule">
                <div className="expiry-dates-scroll">
                  {data?.expiries.map((exp) => {
                    const [year, monthNum, dayNum] = exp.split('-').map(Number);
                    const dateObj = new Date(year, monthNum - 1, dayNum);
                    const day = dateObj.getDate();
                    const month = dateObj.toLocaleDateString('en-IN', { month: 'short' });
                    const yr = String(year).slice(2);
                    return (
                      <button
                        key={exp}
                        className={`expiry-date-btn${selectedExpiry === exp ? ' active' : ''}`}
                        onClick={() => setSelectedExpiry(exp)}
                      >
                        {day} {month} {yr}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="oc-table-wrapper">
            {loadingError === 'locked' ? (
              <div className="premium-lock-container">
                <div className="premium-lock-card">
                  <div className="premium-lock-icon">
                    <i className="fas fa-lock"></i>
                  </div>
                  <h3 className="premium-lock-title">Segment Restricted</h3>
                  <p className="premium-lock-text">
                    You do not have access to trade in <strong>{symbol.includes('SENSEX') || symbol.includes('BANKEX') ? 'BSE Options' : 'NSE Options'}</strong>.
                  </p>
                  <div className="premium-lock-divider"></div>
                  <p className="premium-lock-hint">
                    Please contact your administrator or update your profile settings to enable this trading segment.
                  </p>
                  <button className="premium-lock-btn" onClick={() => router.push('/profile')}>
                    <i className="fas fa-user-cog"></i> Go to Profile Settings
                  </button>
                </div>
              </div>
            ) : !loading && (data?.strikes || []).length === 0 && loadingError ? (
              <div className="no-data-state">
                <i className="fas fa-search"></i>
                <p>No options found for {symbol}</p>
                <p className="sub">Try syncing instruments or check the symbol name.</p>
              </div>
            ) : (
              <>
                {toast.visible && (
                  <div className={`toast-msg${toast.isError ? ' error' : ''}`}>{toast.msg}</div>
                )}
                <OptionChainTable
                  symbol={symbol}
                  strikes={data?.strikes || []}
                  quotes={quotes}
                  spotPrice={spotPrice}
                  onTrade={handleTrade}
                  onOpenChart={handleOpenChart}
                  priceMode={priceMode}
                  strikeRange={0}
                  loading={loading}
                  bidBuffer={displayBidBuffer}
                  useLtpMode={useLtpMode}
                />
              </>
            )}
          </div>

                  </div>
      </main>

      {/* Critical CSS inlined — prevents FOUC when CSS chunk loads late during client navigation */}
      <style>{`
        .expiry-half-drawer-overlay {
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.55); z-index: 1000;
          opacity: 0; visibility: hidden; pointer-events: none;
          transition: opacity 0.3s ease, visibility 0.3s ease;
        }
        .expiry-half-drawer-overlay.active {
          opacity: 1; visibility: visible; pointer-events: auto;
        }
        .expiry-half-sheet {
          background: var(--card-bg, #F5F7FB);
          border-radius: 20px 20px 0 0;
          width: 100%; max-width: 500px; max-height: 85dvh;
          overflow-y: auto;
          box-shadow: 0 -8px 40px rgba(0,0,0,0.18);
          padding-bottom: env(safe-area-inset-bottom, 0px);
          position: fixed; bottom: 0; left: 0; right: 0; margin: 0 auto;
          transform: translateY(100%); visibility: hidden;
          transition: transform 0.38s cubic-bezier(0.25, 0.9, 0.35, 1.05), visibility 0s linear 0.38s;
          z-index: 1001;
        }
        .expiry-half-drawer-overlay.active .expiry-half-sheet {
          transform: translateY(0); visibility: visible;
          transition: transform 0.38s cubic-bezier(0.25, 0.9, 0.35, 1.05), visibility 0s linear 0s;
        }
        @media (max-width: 500px) { .expiry-half-sheet { max-width: 100%; } }
        .os-handle { display: flex; justify-content: center; padding: 10px 0 6px; }
        .os-handle-bar { width: 40px; height: 4px; background: var(--border-card, #e2e6ea); border-radius: 4px; }
        .os-sheet-header { padding: 14px 16px; border-bottom: 1px solid var(--border-light, #e8ecf0); display: flex; align-items: center; gap: 10px; }
        .os-back-btn { background: var(--icon-bg, #f0f2f5); border: none; width: 34px; height: 34px; border-radius: 50%; font-size: 0.9rem; cursor: pointer; color: var(--text-secondary, #6b7280); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .os-sheet-left { flex: 1; }
        .os-sheet-name { font-size: 1rem; font-weight: 800; color: var(--text-primary, #1a1a1a); margin-bottom: 4px; }
        .os-sheet-segment { display: inline-block; font-size: 0.6rem; font-weight: 600; color: #C62E2E; background: #FEF0F0; padding: 3px 10px; border-radius: 20px; }
        .os-sheet-right { text-align: right; }
        .os-cmp-label { font-size: 0.55rem; color: var(--text-muted, #9ca3af); text-transform: uppercase; }
        .os-cmp-val { font-size: 1.2rem; font-weight: 800; color: var(--text-primary, #1a1a1a); }
        .os-cmp-chg { font-size: 0.65rem; font-weight: 600; padding: 2px 8px; border-radius: 30px; display: inline-block; margin-top: 2px; }
        .os-cmp-chg.pos { color: #2C8E5A; background: #E9F6EF; }
        .os-cmp-chg.neg { color: #C62E2E; background: #FEF0F0; }
        .os-bidask { background: var(--card-alt-bg, #f8f9fb); margin: 10px 16px; padding: 10px 16px; border-radius: 20px; display: flex; justify-content: space-between; align-items: center; }
        .os-ba-col { flex: 1; text-align: center; }
        .os-ba-label { font-size: 0.6rem; color: var(--text-muted, #9ca3af); text-transform: uppercase; margin-bottom: 3px; }
        .os-ba-val { font-size: 1rem; font-weight: 700; }
        .os-ba-val.pos { color: #2C8E5A; }
        .os-ba-val.neg { color: #C62E2E; }
        .os-ba-divider { width: 1px; height: 32px; background: var(--border-light, #e8ecf0); margin: 0 8px; }
        .os-qty-section { background: var(--card-alt-bg, #f8f9fb); padding: 10px 14px; border-radius: 18px; margin: 0 16px 12px; box-sizing: border-box; }
        .os-qty-label { font-size: 0.7rem; font-weight: 500; color: var(--text-muted, #9ca3af); margin-bottom: 8px; }
        .os-qty-control { display: flex; align-items: center; justify-content: space-between; background: var(--card-bg, #fff); border-radius: 40px; padding: 3px; border: 1px solid var(--border-light, #e8ecf0); width: 100%; box-sizing: border-box; overflow: hidden; }
        .os-qty-btn { width: 38px; height: 38px; min-width: 38px; background: var(--icon-bg, #f0f2f5); border: none; border-radius: 30px; font-size: 1rem; font-weight: 600; color: #C62E2E; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .os-qty-input { flex: 1; min-width: 0; text-align: center; font-size: 1rem; font-weight: 700; border: none; outline: none; background: transparent; color: var(--text-primary, #1a1a1a); font-family: inherit; }
        .os-type-section { background: var(--card-alt-bg, #f8f9fb); padding: 10px 14px; border-radius: 18px; margin: 0 16px 12px; }
        .os-section-lbl { font-size: 0.7rem; font-weight: 500; color: var(--text-muted, #9ca3af); margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
        .os-type-btns { display: flex; gap: 8px; }
        .os-type-btn { flex: 1; padding: 8px; border: 1px solid var(--border-light, #e8ecf0); background: var(--card-bg, #fff); border-radius: 30px; font-size: 0.7rem; font-weight: 600; cursor: pointer; text-align: center; color: var(--text-secondary, #6b7280); font-family: inherit; transition: 0.15s; }
        .os-type-btn.active { background: #C62E2E; color: white; border-color: #C62E2E; }
        .os-price-input { width: 100%; margin-top: 10px; padding: 10px; border-radius: 30px; border: 1px solid var(--border-light, #e8ecf0); font-size: 0.85rem; background: var(--card-bg, #fff); color: var(--text-primary, #1a1a1a); outline: none; font-family: inherit; box-sizing: border-box; }
        .os-actions { padding: 4px 16px calc(16px + env(safe-area-inset-bottom, 0px)); display: flex; gap: 10px; }
        .os-btn-buy, .os-btn-sell { flex: 1; padding: 14px; border: none; border-radius: 40px; font-size: 0.9rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; transition: 0.15s; }
        .os-btn-buy { background: #2C8E5A; color: white; }
        .os-btn-sell { background: #C62E2E; color: white; }
        .os-btn-buy:disabled, .os-btn-sell:disabled { opacity: 0.6; cursor: not-allowed; }

        .premium-lock-container {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          min-height: 400px;
          width: 100%;
          box-sizing: border-box;
        }
        .premium-lock-card {
          background: #ffffff;
          border: 1px solid var(--border-light, #e8ecf0);
          border-radius: 24px;
          padding: 32px 24px;
          width: 100%;
          max-width: 380px;
          text-align: center;
          box-shadow: 0 10px 30px rgba(0,0,0,0.05);
          transition: transform 0.3s ease;
        }
        :global(.dark) .premium-lock-card {
          background: #1f2937;
          border-color: #374151;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        .premium-lock-icon {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          background: linear-gradient(135deg, #ff9a9e 0%, #fecfef 99%, #fecfef 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 20px;
          font-size: 1.5rem;
          color: #e11d48;
          box-shadow: 0 8px 20px rgba(225, 29, 72, 0.15);
          animation: pulseGlow 2s infinite ease-in-out;
        }
        @keyframes pulseGlow {
          0% { transform: scale(1); box-shadow: 0 8px 20px rgba(225, 29, 72, 0.15); }
          50% { transform: scale(1.05); box-shadow: 0 8px 25px rgba(225, 29, 72, 0.3); }
          100% { transform: scale(1); box-shadow: 0 8px 20px rgba(225, 29, 72, 0.15); }
        }
        .premium-lock-title {
          font-size: 1.25rem;
          font-weight: 800;
          color: var(--text-primary, #111827);
          margin: 0 0 10px 0;
        }
        :global(.dark) .premium-lock-title {
          color: #f9fafb;
        }
        .premium-lock-text {
          font-size: 0.88rem;
          color: var(--text-secondary, #4b5563);
          line-height: 1.5;
          margin: 0 0 20px 0;
        }
        :global(.dark) .premium-lock-text {
          color: #d1d5db;
        }
        .premium-lock-divider {
          height: 1px;
          background: var(--border-light, #e8ecf0);
          margin: 20px 0;
        }
        :global(.dark) .premium-lock-divider {
          background: #374151;
        }
        .premium-lock-hint {
          font-size: 0.78rem;
          color: var(--text-muted, #9ca3af);
          line-height: 1.4;
          margin: 0 0 24px 0;
        }
        .premium-lock-btn {
          width: 100%;
          padding: 14px;
          background: linear-gradient(135deg, #e11d48 0%, #be123c 100%);
          color: white;
          border: none;
          border-radius: 30px;
          font-size: 0.88rem;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          box-shadow: 0 4px 12px rgba(225, 29, 72, 0.25);
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .premium-lock-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 16px rgba(225, 29, 72, 0.35);
        }
        .premium-lock-btn:active {
          transform: translateY(0);
        }
      `}</style>

      <div
        className={`trade-sheet-overlay${selectedContract ? ' active' : ''}`}
        id={sheetView === 'ORDER' ? 'tradeSheetOverlay' : 'detailSheetOverlay'}
        onClick={() => {
          const sheet = document.getElementById(sheetView === 'ORDER' ? 'tradeSheet' : 'detailSheet');
          const overlay = document.getElementById(sheetView === 'ORDER' ? 'tradeSheetOverlay' : 'detailSheetOverlay');
          if (sheet) sheet.classList.remove('open');
          if (overlay) overlay.classList.remove('active');
          setTimeout(() => setSelectedContract(null), 380);
        }}
      ></div>

      <div
        className={`trade-sheet${selectedContract ? ' open' : ''}${sheetView === 'DETAILS' ? ' detail-sheet' : ''} ts-sheet--${sheetSide.toLowerCase()}`}
        id={sheetView === 'ORDER' ? 'tradeSheet' : 'detailSheet'}
        style={sheetView === 'DETAILS' ? { height: 'auto', maxHeight: '72dvh', paddingBottom: '16px' } : { transition: 'none', background: 'transparent', pointerEvents: 'none' }}
      >
        {selectedContract && (() => {
          const kiteId = data?.strikes.find(s => s.ce?.symbol === selectedContract.symbol || s.pe?.symbol === selectedContract.symbol)?.[selectedContract.type.toLowerCase()]?.id;
          const kiteToken = data?.strikes.find(s => s.ce?.symbol === selectedContract.symbol || s.pe?.symbol === selectedContract.symbol)?.[selectedContract.type.toLowerCase()]?.token;

          const getQuoteHelper = (id?: string, token?: number) => {
            if (!id && !token) return null;
            if (id && quotes[id]) return quotes[id];
            if (token && quotes[String(token)]) return quotes[String(token)];
            if (id) {
              const parts = id.split(':');
              const symbolOnly = parts.length > 1 ? parts[1] : id;
              if (quotes[symbolOnly]) return quotes[symbolOnly];
            }
            return null;
          };

          const quote = getQuoteHelper(kiteId, kiteToken);
          const strikeMatch = data?.strikes.find(s => s.ce?.symbol === selectedContract.symbol || s.pe?.symbol === selectedContract.symbol);
          const contractData = selectedContract.type === 'CE' ? strikeMatch?.ce : strikeMatch?.pe;

          const ltp = quote ? quote.lastPrice : (contractData?.price || 0);
          const chgPct = quote ? quote.changePercent : (contractData?.change || 0);
          const forceSynthetic = useLtpMode || displayBidBuffer > 0;
          let bid = quote?.bid && quote.bid > 0 ? quote.bid : null;
          let ask = quote?.ask && quote.ask > 0 ? quote.ask : null;

          if (forceSynthetic && ltp > 0) {
            if (!displayBidBuffer || displayBidBuffer <= 0) {
              bid = ltp;
              ask = ltp;
            } else {
              const decimalBuffer = Math.abs(displayBidBuffer) > 0.005 ? displayBidBuffer / 100 : displayBidBuffer;
              const bufAmount = Math.max(0.05, Math.round(ltp * decimalBuffer * 100) / 100);
              bid = Math.max(0.05, Math.round((ltp - bufAmount) * 100) / 100);
              ask = Math.round((ltp + bufAmount) * 100) / 100;
            }
          } else {
            bid = bid ?? (ltp > 0 ? Math.round(ltp * 0.999 * 100) / 100 : 0);
            ask = ask ?? (ltp > 0 ? Math.round(ltp * 1.001 * 100) / 100 : 0);
          }


          // Find active opposite positions for options direction guards
          const activePos = activePositions.find(p =>
            ((p.status as string) === 'open' || (p.status as string) === 'OPEN') && p.qty_open > 0 && p.symbol === selectedContract.symbol
          );

          if (sheetView === 'DETAILS') {
            return (
              <div style={{ padding: '0' }}>
                <div className="sheet-handle" style={{ display: 'flex' }}><div className="handle-bar" style={{ display: 'block' }}></div></div>
                <div style={{ padding: '12px 14px 4px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
                    <div>
                      <div style={{ fontSize: '1.05rem', fontWeight: '800', color: 'var(--text-primary)', marginBottom: '3px', lineHeight: '1.1', letterSpacing: '-0.3px' }}>{symbol} {selectedContract.strike.toLocaleString('en-IN')} {selectedContract.type}</div>
                      <span style={{ fontSize: '0.55rem', fontWeight: '700', color: '#DC2626', background: '#FEF2F2', padding: '3px 8px', borderRadius: '20px', lineHeight: '1', display: 'inline-block', letterSpacing: '0.5px' }}>{selectedContract.symbol}</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                    <div style={{ fontSize: '0.5rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '1px', letterSpacing: '0.5px' }}>CMP</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '800', color: 'var(--text-primary)', marginBottom: '4px', lineHeight: '1', letterSpacing: '-0.5px' }}>₹{ltp.toFixed(2)}</div>
                    <span style={{ fontSize: '0.65rem', fontWeight: '800', padding: '4px 8px', borderRadius: '6px', lineHeight: '1', color: chgPct >= 0 ? '#059669' : '#DC2626', background: chgPct >= 0 ? '#ECFDF5' : '#FEF2F2' }}>
                      {chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%
                    </span>
                  </div>
                </div>
                <div style={{ height: '1px', background: 'var(--border-light)', margin: '0 0 6px', width: '100%' }}></div>
                <div style={{ padding: '0 12px 10px 12px' }}>
                  <div style={{ background: 'var(--card-alt-bg)', border: '1px solid var(--border-card)', borderRadius: '14px', padding: '8px 12px', display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>BID</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: '700', color: '#059669' }}>₹{bid.toFixed(2)}</div>
                    </div>
                    <div style={{ width: '1px', background: 'var(--border-card)', height: '24px' }}></div>
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '3px' }}>ASK</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: '700', color: '#DC2626' }}>₹{ask.toFixed(2)}</div>
                    </div>
                  </div>

                  {/* ADD TO WATCHLIST */}
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{ fontSize: '0.52rem', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '6px' }}>ADD TO WATCHLIST</div>
                    <button
                      onClick={handleAddToWatchlistClick}
                      style={{
                        width: '100%',
                        padding: '10.5px',
                        background: '#15803D',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '50px',
                        fontWeight: '700',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        boxShadow: '0 2px 8px rgba(21,128,61,0.25)',
                        fontFamily: 'Inter, sans-serif',
                        transition: 'background 0.15s ease'
                      }}
                    >
                      <i className="fas fa-plus"></i> Add to Watchlist
                    </button>
                  </div>

                  {/* Open Trading Chart Button */}
                  <button
                    style={{
                      width: '100%',
                      padding: '9px',
                      borderRadius: '50px',
                      border: '1px solid rgba(21, 128, 61, 0.6)',
                      background: 'transparent',
                      color: '#15803D',
                      fontFamily: 'Inter, sans-serif',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      marginBottom: '8px',
                      transition: 'all 0.18s'
                    }}
                    onClick={() => handleOpenChart(selectedContract.symbol, kiteId)}
                  >
                    <svg 
                      viewBox="0 0 24 24" 
                      style={{
                        width: '1.1rem',
                        height: '1.1rem',
                        display: 'inline-block',
                        verticalAlign: 'middle',
                      }}
                    >
                      {/* Bars */}
                      <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                      <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                      <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                      <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />
                      
                      {/* Trendline */}
                      <path 
                        d="M 4 14 L 8 9 L 13 12 L 20 4" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="2" 
                        strokeLinecap="round" 
                        strokeLinejoin="round" 
                      />
                      {/* Arrowhead */}
                      <polyline 
                        points="15 4 20 4 20 9" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="2" 
                        strokeLinecap="round" 
                        strokeLinejoin="round" 
                      />
                    </svg>
                    Open Trading Chart
                  </button>



                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button 
                      style={{ 
                        flex: 1, 
                        background: '#15803D', 
                        color: 'white', 
                        border: 'none', 
                        padding: '11px 0', 
                        borderRadius: '30px', 
                        fontSize: '0.9rem', 
                        fontWeight: '800', 
                        cursor: 'pointer', 
                        display: 'flex', 
                        justifyContent: 'center', 
                        alignItems: 'center', 
                        gap: '6px'
                      }} 
                      onClick={() => { setSheetSide('BUY'); setSheetView('ORDER'); }}
                    >
                      {activePos?.side === 'SELL' ? 'EXIT SELL' : <><i className="fas fa-arrow-up"></i> BUY</>}
                    </button>
                    <button 
                      style={{ 
                        flex: 1, 
                        background: '#B91C1C', 
                        color: 'white', 
                        border: 'none', 
                        padding: '11px 0', 
                        borderRadius: '30px', 
                        fontSize: '0.9rem', 
                        fontWeight: '800', 
                        cursor: 'pointer', 
                        display: 'flex', 
                        justifyContent: 'center', 
                        alignItems: 'center', 
                        gap: '6px'
                      }} 
                      onClick={() => { setSheetSide('SELL'); setSheetView('ORDER'); }}
                    >
                      {activePos?.side === 'BUY' ? 'EXIT BUY' : <><i className="fas fa-arrow-down"></i> SELL</>}
                    </button>
                  </div>
                </div>
              </div>
            );
          }

          // ORDER / TRADE SHEET VIEW
          const tradeSheetItem = {
            name: `${symbol} ${selectedContract.strike.toLocaleString('en-IN')} ${selectedContract.type}`,
            symbol: selectedContract.symbol,
            kiteSymbol: kiteId || selectedContract.symbol,
            segment: (symbol.includes('GOLD') || symbol.includes('SILVER') || symbol.includes('CRUDE') || symbol.includes('NATGAS') || symbol.includes('NATURALGAS')) ? 'MCX - Options' : (symbol.includes('SENSEX') || symbol.includes('BANKEX') ? 'BSE - Options' : 'NSE - Options'),
            price: ltp, // Passed down to let TradeSheet know the initial price, but it will fetch live
            lot_size: lotSize, // Ensures TradeSheet uses the correct lot size
          };

          return (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="ts-header" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-light)' }}>
                <button className="ts-back-btn" onClick={() => setSheetView('DETAILS')} suppressHydrationWarning style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                  <i className="fas fa-chevron-left" style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}></i> <span style={{ marginLeft: '4px', fontSize: '0.85rem', fontWeight: 600 }}>Back to Details</span>
                </button>
              </div>
              <div style={{ flex: 1, position: 'relative' }}>
                <TradeSheet 
                  item={tradeSheetItem} 
                  side={sheetSide} 
                  onClose={closeTradeSheet} 
                />
              </div>
            </div>
          );
        })()}
      </div>

      {/* Order Entry Sheet */}

      {/* Order Entry Sheet removed — expiry-half-sheet handles all order entry */}

      <div className={`pos-toast${toast.visible ? ' show' : ''}`} style={{
        position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
        background: toast.isError ? '#C62E2E' : '#2C8E5A', color: '#fff',
        padding: '12px 24px', borderRadius: '40px', fontWeight: '600', zIndex: 9999,
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)', opacity: toast.visible ? 1 : 0,
        visibility: toast.visible ? 'visible' : 'hidden', transition: 'all 0.3s ease'
      }}>
        {toast.msg}
      </div>

      <TradingSegmentsDrawer
        isOpen={isSegmentsOpen}
        onClose={() => setIsSegmentsOpen(false)}
        onSelect={(item) => {
          if (item.segment.includes('Options')) {
            const newSymbol = item.name.split(' ')[0];
            router.push(`/option-chain?symbol=${newSymbol}`);
            setIsSegmentsOpen(false);
          }
        }}
      />

      <div id="chartSheetOverlay" className="trade-sheet-overlay" onClick={() => { const sheet = document.getElementById('chartSheet'); const overlay = document.getElementById('chartSheetOverlay'); if (sheet) sheet.classList.remove('open'); if (overlay) overlay.classList.remove('active'); setChartItem(null); }}></div>
      <div id="chartSheet" className="trade-sheet" style={{ height: '100dvh', paddingBottom: '0', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, position: 'relative', width: '100%', overflow: 'hidden' }}>
          {chartItem && (
            <TradingChart
              symbol={chartItem.kiteSymbol || chartItem.symbol}
              segment={chartItem.segment}
              liveQuote={quotes[chartItem.kiteSymbol]}
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
      {/* order errors are now shown by the centralised ErrorModal in ClientShell */}
    </div>
  );
}

export default function OptionChainPage() {
  return (
    <Suspense fallback={<AnimatedLoader text="Loading..." />}>
      <OptionChainContent />
    </Suspense>
  );
}

