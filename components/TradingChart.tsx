'use client';

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import ChartContainer from '@/components/chart/ChartContainer';
import { ErrorModal } from '@/components/ErrorModal';
import { getDefaultWatchlistItems, getTabForItem, TAB_LABELS, TabLabel } from '@/app/watchlist/page';
import { Candle } from '@/components/chart/types';
import { useMyOrders } from '@/hooks/useMyOrders';
import type { MyOrder } from '@/lib/types/order';
import { useMyPositions, EnrichedPosition } from '@/hooks/useMyPositions';
import { useOrderEntry } from '@/hooks/useOrderEntry';
import { supabase } from '@/lib/supabaseClient';
import { api, ApiError } from '@/lib/api';
import OptionChainTable from '@/app/option-chain/OptionChainTable';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';

import useSWR from 'swr';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import { calculateMarginPortion } from '@/lib/trading/MarginCalculator';
import { mapSegmentToDbSegment, mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';
import { formatShortName, isForexSymbol } from '@/lib/datafeed/symbolResolver';
import { normalizeComexTicker } from '@/lib/watchlistUtils';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useTradeConfig } from '@/contexts/TradeConfigContext';
import { useBalance } from '@/hooks/useBalance';
import './trading-chart.css';

const fetcher = (url: string) => fetch(url).then(res => res.json());

const getUnderlyingSymbol = (sym: string) => {
  if (sym.includes('NIFTY 50')) return 'NIFTY';
  if (sym.includes('NIFTY BANK')) return 'BANKNIFTY';
  if (sym.includes('NIFTY FIN SERVICE')) return 'FINNIFTY';
  if (sym.includes('NIFTY MID SELECT')) return 'MIDCPNIFTY';
  if (sym.includes('SENSEX')) return 'SENSEX';
  if (sym.includes('BANKEX')) return 'BANKEX';

  const clean = sym.includes(':') ? sym.split(':')[1] : sym;

  const parsed = parseOptionSymbol(clean);
  if (parsed) {
    return parsed.underlying;
  }

  // Handle Futures e.g. CRUDEOIL26AUGFUT or NIFTY24SEPFUT
  const futMatch = clean.match(/^([A-Z]+)(\d{2}[A-Z0-9]{3})FUT$/i);
  if (futMatch) {
    return futMatch[1].toUpperCase();
  }
  return clean;
}

import { getSavedTheme } from '@/lib/theme';

function getAppTheme(): 'dark' | 'black' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  const saved = getSavedTheme();
  if (saved === 'black') return 'black';
  if (saved === 'light') return 'light';
  if (saved === 'blue' || saved === 'dark') return 'dark';
  if (document.documentElement.classList.contains('black') || document.body.classList.contains('black')) return 'black';
  if (document.documentElement.classList.contains('dark') || document.body.classList.contains('dark') || document.documentElement.classList.contains('blue') || document.body.classList.contains('blue')) return 'dark';
  if (document.documentElement.classList.contains('light') || document.body.classList.contains('light')) return 'light';
  return 'dark';
}

interface TradingChartProps {
  symbol: string;         // e.g., "BTCUSDT" or "NSE:INFY"
  segment: string;        // e.g., "CRYPTO" or "EQ"
  liveQuote?: any;        // Live quote object to update the last candle
  onClose?: () => void;
}

type Timeframe = '1m' | '2m' | '3m' | '5m' | '10m' | '15m' | '30m' | '60m' | 'day';

function CandleCountdown({ timeframe }: { timeframe: Timeframe }) {
  const [timeLeft, setTimeLeft] = useState('');
  useEffect(() => {
    if (timeframe === 'day') return;
    const resMs =
      timeframe === '1m' ? 60000 : timeframe === '2m' ? 120000 : timeframe === '3m' ? 180000 :
      timeframe === '5m' ? 300000 : timeframe === '10m' ? 600000 : timeframe === '15m' ? 900000 :
      timeframe === '30m' ? 1800000 : timeframe === '60m' ? 3600000 : 0;
    if (!resMs) return;
    const update = () => {
      const nowMs = Date.now();
      const next = Math.ceil(nowMs / resMs) * resMs;
      const diff = Math.max(0, next - nowMs);
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [timeframe]);

  if (timeframe === 'day' || !timeLeft) return null;
  return (
    <div style={{ marginLeft: '4px', fontSize: '12px', fontWeight: 600, color: '#f23645' }}>
      ({timeLeft})
    </div>
  );
}

const SwipeableItem = ({ children, onDelete }: { children: React.ReactNode, onDelete: () => void }) => {
  const [translateX, setTranslateX] = useState(0);
  const startX = useRef(0);
  const currentX = useRef(0);
  const isSwiping = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    isSwiping.current = true;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isSwiping.current) return;
    currentX.current = e.touches[0].clientX;
    const diff = currentX.current - startX.current;
    if (diff < 0) {
      setTranslateX(Math.max(diff, -80));
    } else {
      setTranslateX(Math.min(diff, 0));
    }
  };

  const handleTouchEnd = () => {
    isSwiping.current = false;
    if (translateX < -40) {
      setTranslateX(-80);
    } else {
      setTranslateX(0);
    }
  };

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: '12px' }}>
      <div style={{
        position: 'absolute', top: 0, bottom: 0, right: 0, width: '80px',
        background: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'white', zIndex: 0, opacity: translateX < 0 ? 1 : 0, transition: 'opacity 0.2s ease'
      }}>
        <button style={{ background: 'transparent', border: 'none', color: 'white', height: '100%', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { e.stopPropagation(); onDelete(); setTranslateX(0); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" /></svg>
        </button>
      </div>
      <div
        className={translateX < 0 ? 'swipe-active' : ''}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isSwiping.current ? 'none' : 'transform 0.2s ease',
          position: 'relative',
          zIndex: 1,
          background: 'transparent',
          width: '100%'
        }}
      >
        {children}
      </div>
    </div>
  )
}

const SEGMENT_TAB_MAP: Record<string, string> = {
  'NSE - Futures': 'INDEX-FUT',
  'BSE - Futures': 'INDEX-FUT',
  'NSE - Options': 'INDEX-OPT',
  'BSE - Options': 'INDEX-OPT',
  'NSE - Stock Futures': 'STOCK-FUT',
  'BSE - Stock Futures': 'STOCK-FUT',
  'NSE - Stock Options': 'STOCK-OPT',
  'BSE - Stock Options': 'STOCK-OPT',
  'MCX - Futures': 'MCX-FUT',
  'MCX - Options': 'MCX-OPT',
  'NSE - Equity': 'STOCKS',
  'BSE - Equity': 'STOCKS',
  'NSE-EQ': 'STOCKS',
  'BSE-EQ': 'STOCKS',
  'STOCKS': 'STOCKS',
  'Stocks': 'STOCKS',
  'Equity': 'STOCKS',
  'EQUITY': 'STOCKS',
  'Crypto': 'CRYPTO',
  'CRYPTO': 'CRYPTO',
  'Forex': 'FOREX',
  'FOREX': 'FOREX',
  'CDS - Futures': 'FOREX',
  'CDS - Options': 'FOREX',
  'COMEX - Futures': 'COMEX',
  'COMEX - Options': 'COMEX',
  'COMEX': 'COMEX',
  'COI': 'COMEX',
};

function getStoredWatchlistItems() {
  if (typeof window !== 'undefined' && (window as any).__watchlistItems && (window as any).__watchlistItems.length > 0) {
    return (window as any).__watchlistItems;
  }
  try {
    let bestKey = 'niveshX_watchlist';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('niveshX_watchlist_') || key.startsWith('marginApex_watchlist_'))) {
        bestKey = key;
        break;
      }
    }
    const rawUser = localStorage.getItem('marginApex_watchlist') || localStorage.getItem(bestKey);
    if (rawUser && rawUser !== 'null') {
      const parsed = JSON.parse(rawUser);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) { }
  return getDefaultWatchlistItems();
}

const ChartSearchOverlay = ({ onClose, onSelect, starredInstruments = [], toggleStar }: any) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeSearchTab, setActiveSearchTab] = useState<TabLabel>('All');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  const localScripts = getDefaultWatchlistItems();
  const normalizedQuery = searchQuery.replace(/\s+/g, ' ').trim();

  const searchReqIdRef = useRef(0);

  function wordStartMatch(text: string, term: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase();
    const q = term.toLowerCase();
    if (t.startsWith(q) || t.includes(q)) return true;
    const words = t.split(/[\s\-_\/:]/);
    return words.some(w => w.startsWith(q));
  }

  const SEGMENT_DEFAULTS: Record<string, string> = {
    'INDEX-FUT': 'NIFTY',
    'INDEX-OPT': 'NIFTY',
    'STOCK-FUT': 'RELIANCE',
    'STOCK-OPT': 'RELIANCE',
    'STOCKS': 'RELIANCE',
    'NSE-EQ': 'RELIANCE',
    'Equity': 'RELIANCE',
    'Stocks': 'RELIANCE',
    'US-EQ': 'TSLA',
    'MCX-FUT': 'GOLD',
    'MCX-OPT': 'GOLD',
    'COMEX': 'GOLD',
    'CRYPTO': 'BTC',
    'FOREX': 'USDINR',
  };

  const fetchLiveResults = async (q: string, tab: string, signal: AbortSignal) => {
    try {
      const url = `/api/market/instruments/search?q=${encodeURIComponent(q)}&tab=${encodeURIComponent(tab)}`;
      const data = await api.get<any[]>(url, { signal });
      return Array.isArray(data) ? data : [];
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('Chart search API error:', err);
      return [];
    }
  };

  useEffect(() => {
    const reqId = ++searchReqIdRef.current;
    setIsSearching(true);

    const qLower = normalizedQuery.toLowerCase();
    const localMatches = localScripts.filter(s => {
      if (activeSearchTab !== 'All' && getTabForItem(s) !== activeSearchTab) return false;
      if (normalizedQuery.length === 0) return true;
      return wordStartMatch(s.name, qLower) || wordStartMatch(s.symbol, qLower);
    });

    if (localMatches.length > 0 || normalizedQuery.length === 0) {
      setSearchResults(localMatches);
    }

    const abortController = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const actualQuery = normalizedQuery.length >= 1 ? normalizedQuery : (SEGMENT_DEFAULTS[activeSearchTab] || 'NIFTY');
        const liveMatches = await fetchLiveResults(actualQuery, activeSearchTab, abortController.signal);
        if (reqId !== searchReqIdRef.current) return;

        const merged = [...liveMatches];
        const liveSymbols = new Set(liveMatches.map((r: any) => r.symbol));

        for (const local of localMatches) {
          if (!liveSymbols.has(local.symbol)) {
            merged.push(local);
            liveSymbols.add(local.symbol);
          }
        }

        setSearchResults(merged);
      } catch (err) {
        console.error('Chart search error:', err);
      } finally {
        if (reqId === searchReqIdRef.current) {
          setIsSearching(false);
        }
      }
    }, 150);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [normalizedQuery, activeSearchTab]);

  const comexIds = React.useMemo(() => {
    const ids = (searchResults || []).map((r: any) => r.comexSymbol).filter((s: string | undefined): s is string => !!s);
    return Array.from(new Set(ids));
  }, [searchResults]);
  const { quotes: comexQuotes } = useComexQuotes(comexIds);

  const displayResults = searchResults;

  const renderResultItem = (res: any, idx: number) => {
    const isStarred = starredInstruments.some((p: any) => (p.kiteSymbol || p.symbol) === (res.kiteSymbol || res.symbol));
    let price = res.price || 0;
    let high = res.high || 0;
    let low = res.low || 0;
    const isForexUsd = ['GBPUSD', 'EURUSD'].includes((res.symbol || '').toUpperCase());
    // Keep raw currency prices for Forex/Crypto/COMEX

    return (
      <div
        key={`${res.kiteSymbol || res.symbol}-${idx}`}
        className="tc-search-result-item"
        style={{ cursor: 'pointer' }}
        onClick={() => onSelect(res)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
          {toggleStar && (
            <button
              className="tc-star-btn"
              onClick={(e) => { e.stopPropagation(); toggleStar(res); }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '22px', color: isStarred ? '#F59E0B' : '#D1D5DB', display: 'flex', alignItems: 'center', padding: 0 }}
            >
              {isStarred ? '★' : '☆'}
            </button>
          )}
          <div className="tc-res-info" style={{ flex: 1, minWidth: 0 }}>
            <div className="tc-res-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {res.name || res.symbol}
            </div>
            <div className="tc-res-segment" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span>{res.segment}</span>
              {res.contractDate && (
                <>
                  <span>•</span>
                  <span>{res.contractDate}</span>
                </>
              )}
            </div>
            {(high > 0 || low > 0) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#15803D', letterSpacing: 0.2 }}>
                  H {high.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span style={{ fontSize: '0.6rem', color: '#9CA3AF' }}>|</span>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#C62E2E', letterSpacing: 0.2 }}>
                  L {low.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, marginLeft: '12px' }}>
          {price > 0 && (
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary, #111827)', textAlign: 'right' }}>
              ₹{price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          )}
          <button
            className="tc-res-open-btn"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(res);
            }}
          >
            Open
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="tc-search-overlay-fullscreen">
      <div className="tc-search-header-fs" style={{ padding: '12px 16px', gap: '0', background: 'var(--container-bg, #FFFFFF)', zIndex: 10 }}>
        <div style={{ position: 'relative', width: '100%', display: 'flex', alignItems: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: '12px', zIndex: 1 }}>
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            ref={searchInputRef}
            className="tc-search-input-fs"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search stocks, options, futures..."
            style={{ width: '100%', paddingRight: '72px', paddingLeft: '40px' }}
          />
          <div style={{ position: 'absolute', right: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            {searchQuery && (
              <button
                className="tc-icon-btn"
                onClick={() => setSearchQuery('')}
                aria-label="Clear"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', color: '#9CA3AF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            )}
            <button
              className="tc-icon-btn"
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', color: '#9CA3AF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div className="tc-search-body-fs">
        <div className="tc-search-tabs">
          {TAB_LABELS.map(tab => (
            <div
              key={tab}
              className={`tc-search-tab ${activeSearchTab === tab ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSearchTab(tab); }}
            >
              {tab}
            </div>
          ))}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: '1px solid var(--border-color, #2d3748)',
          background: 'var(--header-bg, rgba(255,255,255,0.03))',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: '#8F9BB3',
          letterSpacing: '0.5px'
        }}>
          <span>{activeSearchTab} RESULTS</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isSearching ? <AnimatedLoader size="small" text="SEARCHING..." /> : `${displayResults.length} MATCHES`}
          </span>
        </div>

        <div className="tc-search-results-fs">
          {displayResults.length > 0 ? (
            searchQuery.trim().length === 0 && activeSearchTab === 'All' ? (
              <>
                {starredInstruments && starredInstruments.length > 0 && (
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#8F9BB3', padding: '4px 8px 8px', letterSpacing: '0.5px' }}>
                      FAVORITES
                    </div>
                    {starredInstruments.map((res: any, idx: number) => (
                      <SwipeableItem key={`fav-${res.kiteSymbol || res.symbol}-${idx}`} onDelete={() => toggleStar(res)}>
                        {renderResultItem(res, idx)}
                      </SwipeableItem>
                    ))}
                  </div>
                )}
                <div>
                  {starredInstruments && starredInstruments.length > 0 && (
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#8F9BB3', padding: '12px 8px 8px', letterSpacing: '0.5px' }}>
                      POPULAR INSTRUMENTS
                    </div>
                  )}
                  {displayResults.map((res: any, idx: number) => renderResultItem(res, idx))}
                </div>
              </>
            ) : (
              displayResults.map((res: any, idx: number) => renderResultItem(res, idx))
            )
          ) : isSearching ? (
            <div className="tc-search-msg" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
              <AnimatedLoader size="small" text="Searching instruments..." />
            </div>
          ) : (
            <div className="tc-search-msg">No results found for &quot;{normalizedQuery || activeSearchTab}&quot;</div>
          )}
        </div>
      </div>
    </div>
  );
};

let tradingChartRenderCount = 0;

function TradingChartComponent({ symbol: propSymbol, segment: propSegment = '', liveQuote: propLiveQuote, onClose }: TradingChartProps) {
  tradingChartRenderCount++;
  const [symbol, setSymbol] = useState(() => normalizeComexTicker(propSymbol));
  const [segment, setSegment] = useState(propSegment);
  const [loadId, setLoadId] = useState(() => Math.random().toString(36).substring(2, 8));

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${loadId} symbol=${propSymbol} event=TRADING_CHART_RENDER renderCount=${tradingChartRenderCount}`);

  // ── Keyboard Back Navigation (Esc / Alt+ArrowLeft) for Desktop / Computer ──
  useEffect(() => {
    const handleBackNav = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.altKey && e.key === 'ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        if (onCloseRef.current) {
          onCloseRef.current();
        } else {
          const sheet = document.getElementById('chartSheet');
          const overlay = document.getElementById('chartSheetOverlay');
          if (sheet) sheet.classList.remove('open');
          if (overlay) overlay.classList.remove('active');
          window.history.back();
        }
      }
    };

    window.addEventListener('keydown', handleBackNav);

    // Also attach to the TradingView iframe so clicking inside chart doesn't trap keyboard back
    const timer = setTimeout(() => {
      try {
        const iframe = document.querySelector('#chartSheet iframe, .tc-chart-area iframe') as HTMLIFrameElement | null;
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.addEventListener('keydown', handleBackNav);
        }
      } catch { /* cross-origin protection */ }
    }, 1200);

    return () => {
      window.removeEventListener('keydown', handleBackNav);
      clearTimeout(timer);
      try {
        const iframe = document.querySelector('#chartSheet iframe, .tc-chart-area iframe') as HTMLIFrameElement | null;
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.removeEventListener('keydown', handleBackNav);
        }
      } catch { }
    };
  }, []);

  useEffect(() => {
    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch (e) {}
    }
    return () => {
      if (typeof screen !== 'undefined' && screen.orientation && (screen.orientation as any).lock) {
        (screen.orientation as any).lock('portrait').catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const newId = Math.random().toString(36).substring(2, 8);
    setLoadId(newId);
    setSymbol(normalizeComexTicker(propSymbol));
    setSegment(propSegment);
    console.log(`[CHART PERF ${newId}] +0.0ms TradingChart propSymbol change: ${propSymbol}`);
  }, [propSymbol, propSegment]);

  const [themeMode, setThemeMode] = useState<'dark' | 'black' | 'blue' | 'light'>(() => getAppTheme());

  useEffect(() => {
    const updateTheme = () => {
      const current = getAppTheme();
      setThemeMode(current);
    };
    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('themeChanged', updateTheme);
    window.addEventListener('storage', updateTheme);

    return () => {
      observer.disconnect();
      window.removeEventListener('themeChanged', updateTheme);
      window.removeEventListener('storage', updateTheme);
    };
  }, []);

  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [chartType, setChartType] = useState<'candle' | 'area' | 'bar' | 'baseline'>('candle');
  const [openTopFlyout, setOpenTopFlyout] = useState<string | null>(null);
  const [isLandscape, setIsLandscape] = useState(false);
  const [isCssLandscape, setIsCssLandscape] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);
  const hasLoadedData = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [historicalCandles, setHistoricalCandles] = useState<Candle[]>([]);

  const [isSearchActive, setIsSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [starredInstruments, setStarredInstruments] = useState<any[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('niveshX_starred_instruments') || localStorage.getItem('marginApex_starred_instruments');
      if (stored) setStarredInstruments(JSON.parse(stored));
    } catch (e) { }
  }, []);

  // Landscape detection
  useEffect(() => {
    const checkLandscape = () => {
      const isSmallScreen = window.innerWidth <= 950;
      const landscape = window.innerWidth > window.innerHeight;
      setIsLandscape(isSmallScreen && landscape);
    };
    checkLandscape();

    const handleOrientationChange = () => {
      // Browsers often need a slight delay to update innerWidth/innerHeight after rotation
      setTimeout(() => {
        checkLandscape();
        window.dispatchEvent(new Event('resize'));
      }, 200);
    };

    window.addEventListener('resize', checkLandscape);
    window.addEventListener('orientationchange', handleOrientationChange);
    return () => {
      window.removeEventListener('resize', checkLandscape);
      window.removeEventListener('orientationchange', handleOrientationChange);
    };
  }, []);

  // Gyroscope-based rotation detection (bypasses OS/manifest portrait lock)
  const lastPhysicalOrientation = useRef<'portrait' | 'landscape' | null>(null);
  const targetOrientation = useRef<'portrait' | 'landscape' | null>(null);
  const orientationTimeout = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleDeviceOrientation = (event: any) => {
      const gamma = event.gamma;
      const beta = event.beta;
      if (gamma === null || beta === null) return;

      const absGamma = Math.abs(gamma);
      const absBeta = Math.abs(beta);

      let detected: 'portrait' | 'landscape' | null = null;
      
      // Phone is tilted sideways (landscape)
      if (absGamma > 50 && absBeta < 40) {
        detected = 'landscape';
      }
      // Phone is held upright (portrait)
      else if (absBeta > 50 && absGamma < 40) {
        detected = 'portrait';
      }

      if (detected && detected !== targetOrientation.current) {
        targetOrientation.current = detected;
        
        if (orientationTimeout.current) {
          clearTimeout(orientationTimeout.current);
        }
        
        // Add a 350ms delay so the rotation feels natural and doesn't flicker
        orientationTimeout.current = setTimeout(() => {
          if (lastPhysicalOrientation.current !== detected) {
            lastPhysicalOrientation.current = detected;
            setIsCssLandscape(detected === 'landscape');
          }
        }, 350);
      }
    };

    if (typeof window !== 'undefined' && window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', handleDeviceOrientation);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('deviceorientation', handleDeviceOrientation);
      }
    };
  }, []);

  const toggleStar = (item: any) => {
    const itemKey = item.kiteSymbol || item.symbol;
    if (!itemKey) return;
    setStarredInstruments(prev => {
      const isStarred = prev.some(p => (p.kiteSymbol || p.symbol) === itemKey);
      const next = isStarred
        ? prev.filter(p => (p.kiteSymbol || p.symbol) !== itemKey)
        : [...prev, item];
      try { localStorage.setItem('niveshX_starred_instruments', JSON.stringify(next)); } catch (e) { }
      return next;
    });
  };




  // For the legend overlay
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [priceChange, setPriceChange] = useState<number>(0);
  const [priceChangePct, setPriceChangePct] = useState<number>(0);

  // Active Drawing Tool state
  const [activeDrawingTool, setActiveDrawingTool] = useState<string | null>(null);

  const isCrypto = segment.toUpperCase() === 'CRYPTO' || symbol.endsWith('USDT');

  const isUnderlyingIndex = useMemo(() => {
    const s = symbol.toUpperCase();
    const spotIndices = [
      'NIFTY 50', 'NIFTY BANK', 'SENSEX', 'NIFTY FIN SERVICE', 'NIFTY MID SELECT', 'BANKEX',
      'NSE:NIFTY 50', 'NSE:NIFTY BANK', 'BSE:SENSEX', 'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY MID SELECT', 'BSE:BANKEX',
      'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'
    ];
    return spotIndices.includes(s) || s.endsWith('_INDEX');
  }, [symbol]);

  // --- Real Data Hooks ---
  const { orders, cancelOrder, refresh: refreshOrders } = useMyOrders();
  const { positions, refresh: refreshPositions, addOptimisticPosition } = useMyPositions();
  const { placeOrder, closePosition } = useOrderEntry();

  // --- Dashboard States ---
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [addingPosId, setAddingPosId] = useState<string | null>(null);
  const positionSnapshotRef = useRef<string | null>(null); // snapshot of position state at order time
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // tracks the active toast auto-dismiss timer
  const submitStartTimeRef = useRef<number>(0);
  const submittingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isOrderBlockVisible, setIsOrderBlockVisible] = useState<boolean>(false);
  const [isTradeOnChartActive, setIsTradeOnChartActive] = useState<boolean>(false);
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY');
  const [useLots, setUseLots] = useState<boolean>(() => {
    const s = (propSegment || '').toUpperCase();
    return !(s.includes('EQUITY') || s === 'NSE-EQ' || s.includes('CRYPTO'));
  });
  const [qtyValue, setQtyValue] = useState<number | string>(1);
  const [orderCarry, setOrderCarry] = useState<'normal' | 'carry'>('normal');
  const [orderType, setOrderType] = useState<'market' | 'limit' | 'slm' | 'gtt' | 'sl'>('market');
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [triggerPrice, setTriggerPrice] = useState<string>('');
  const [gttSlPrice, setGttSlPrice] = useState<string>('');
  const [gttTargetPrice, setGttTargetPrice] = useState<string>('');
  const [chainContract, setChainContract] = useState<{ name: string; expiry: string; ltp: number; iv: number; bid: number; ask: number; kiteId?: string } | null>(null);
  const [activeSegment, setActiveSegment] = useState<'chain' | 'orders' | 'positions'>('orders');
  const [isPanelExpanded, setIsPanelExpanded] = useState<boolean>(false);
  const [isInfoPanelCollapsed, setIsInfoPanelCollapsed] = useState<boolean>(true);
  const [isBottomSectionVisible, setIsBottomSectionVisible] = useState<boolean>(true);
  const [positionViewMode, setPositionViewMode] = useState<'cumulative' | 'detailed'>('cumulative');
  const [toast, setToast] = useState<{ visible: boolean; msg: string; isError?: boolean }>({ visible: false, msg: '' });
  // Config from the shared TradeConfigProvider — no local fetches needed
  const { tradingMode, getLotSize, getSegment } = useTradeConfig();
  // Balance from the global BalanceDataProvider — no local fetch needed
  const { balance, refresh: refreshBalance } = useBalance();

  const notifyOrderEvent = useCallback(() => {
    refreshOrders();
    refreshPositions();
    refreshBalance();
    window.dispatchEvent(new Event('order_placed'));
    window.dispatchEvent(new Event('order_executed'));
    window.dispatchEvent(new Event('position_updated'));
    window.dispatchEvent(new CustomEvent('position-closed'));
    window.dispatchEvent(new CustomEvent('position_closed'));
    setTimeout(() => {
      refreshOrders();
      refreshPositions();
      refreshBalance();
    }, 600);
  }, [refreshOrders, refreshPositions, refreshBalance]);

  // ── CHARTINH Integration States ──
  const [activeOrderTab, setActiveOrderTab] = useState<'open' | 'executed'>('open');
  const [isExitFlow, setIsExitFlow] = useState<boolean>(false);
  const [isAddMoreFlow, setIsAddMoreFlow] = useState<boolean>(false);
  const [exitPositionId, setExitPositionId] = useState<string | null>(null);
  const [addMoreSymbol, setAddMoreSymbol] = useState<string | null>(null);
  const [addMoreSegment, setAddMoreSegment] = useState<string | null>(null);
  const [addMoreLtp, setAddMoreLtp] = useState<number | null>(null);
  const [addMoreKiteInst, setAddMoreKiteInst] = useState<string | null>(null);
  const [postOrderSegment, setPostOrderSegment] = useState<'chain' | 'orders' | 'positions' | 'main' | null>(null);
  const [orderBlockTitle, setOrderBlockTitle] = useState<string>(symbol);
  const [modifyOrderId, setModifyOrderId] = useState<string | null>(null);
  const [showCharges, setShowCharges] = useState(false);

  const underlyingSym = getUnderlyingSymbol(symbol);
  const isIndex = (symbol.includes('NIFTY') || symbol.includes('SENSEX') || symbol.includes('BANKEX') || symbol === 'INDIA VIX') && !symbol.includes('FUT') && !symbol.includes('OPT') && !symbol.match(/(CE|PE)$/i);

  const { data: chainData, isLoading: chainLoading } = useSWR(
    activeSegment === 'chain' && !isCrypto && !segment.toUpperCase().includes('FOREX')
      ? `/api/market/option-chain?symbol=${underlyingSym}`
      : null,
    fetcher
  );

  const chainStrikes = useMemo(() => chainData?.strikes || [], [chainData]);
  const chainExpiry = chainData?.selectedExpiry || '';

  const symbolsToFetch = useMemo(() => {
    const syms: string[] = [symbol];
    // When in add-more or exit flow for a different instrument, also subscribe to its quotes
    if ((isAddMoreFlow || isExitFlow) && addMoreSymbol && addMoreSymbol !== symbol) {
      syms.push(addMoreSymbol);
    }
    if (activeSegment === 'chain' && chainStrikes.length) {
      chainStrikes.forEach((s: any) => {
        if (s.ce?.id) syms.push(s.ce.id);
        if (s.pe?.id) syms.push(s.pe.id);
      });
    }
    return syms;
  }, [symbol, activeSegment, chainStrikes, isAddMoreFlow, isExitFlow, addMoreSymbol]);

  const { quotes: marketQuotes } = useMarketQuotes(symbolsToFetch);
  const activeLiveQuote = marketQuotes[symbol] || (symbol === propSymbol ? propLiveQuote : null);

  const openChainOrder = (defaultAction: 'BUY' | 'SELL', contractName: string, expiry: string, ltp: number, iv: number, kiteId?: string) => {
    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
    else setIsPanelExpanded(false);
    const bid = ltp;
    const ask = parseFloat((ltp + Math.max(0.05, ltp * 0.005)).toFixed(2));
    const contract = { name: contractName, expiry, ltp, iv, bid, ask, kiteId };
    setChainContract(contract);
    setOrderSide(defaultAction);
    const displayPrice = defaultAction === 'BUY' ? ask : bid;
    setLimitPrice(displayPrice.toFixed(2));
    setTriggerPrice(displayPrice.toFixed(2));
    setGttSlPrice(defaultAction === 'BUY' ? (displayPrice * 0.99).toFixed(2) : (displayPrice * 1.01).toFixed(2));
    setGttTargetPrice(defaultAction === 'BUY' ? (displayPrice * 1.01).toFixed(2) : (displayPrice * 0.99).toFixed(2));
    setOrderType('market');
    setOrderCarry('normal');
    const isQtyDefault = segment.toUpperCase().includes('EQUITY') || segment.toUpperCase() === 'NSE-EQ' || segment.toUpperCase() === 'STOCKS' || segment.toUpperCase().includes('CRYPTO');
    setUseLots(!isQtyDefault);
    setQtyValue(1);
    setIsExitFlow(false);
    setIsAddMoreFlow(false);
    setExitPositionId(null);
    setPostOrderSegment('chain');
    setIsOrderBlockVisible(true);
  };

  // ── Advanced Drawing States & Toggles ──
  const [overlayIds, setOverlayIds] = useState<string[]>([]);
  const [isMagnetMode, setIsMagnetMode] = useState<boolean>(false);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [keepDrawingMode, setKeepDrawingMode] = useState<boolean>(false);
  const [hideDrawings, setHideDrawings] = useState<boolean>(false);
  const [openFlyout, setOpenFlyout] = useState<string | null>(null);
  // Maps each flyout group to its currently selected (last-used) tool
  const [groupSelected, setGroupSelected] = useState<Record<string, string>>({
    lines: 'segment',
    fibonacci: 'fibonacciRetracement',
    channels: 'parallelStraightLine',
    shapes: 'circle',
    annotation: 'simpleAnnotation',
    measure: 'priceRange',
  });

  const toggleLockDrawings = () => {
    setIsLocked(!isLocked);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  const toggleHideDrawings = () => {
    setHideDrawings(!hideDrawings);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  const clearAllDrawings = () => {
    setOverlayIds([]);
    setActiveDrawingTool(null);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  // Get lot size of instrument
  const lotSize = useMemo(() => getLotSize(symbol), [symbol, getLotSize]);

  // Update qtyValue when lotSize changes (if user hasn't typed a custom qty yet)
  useEffect(() => {
    if (!useLots && qtyValue === getLotSize(symbol)) {
      setQtyValue(lotSize);
    }
  }, [lotSize]);

  // Toast helper
  const showToast = (msg: string, isError = false) => {
    // Cancel any pending auto-dismiss so stale timers can't close the new toast early
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast({ visible: true, msg, isError });
    // Errors stay visible longer so the user can actually read them
    toastTimerRef.current = setTimeout(() => {
      setToast({ visible: false, msg: '' });
      toastTimerRef.current = null;
    }, isError ? 4000 : 2500);
  };

  // Safety guard: if the toast is visible but the timer was lost (e.g. after
  // Next.js fast refresh preserves state but resets refs), re-arm the dismiss.
  useEffect(() => {
    if (toast.visible && !toastTimerRef.current) {
      toastTimerRef.current = setTimeout(() => {
        setToast({ visible: false, msg: '' });
        toastTimerRef.current = null;
      }, toast.isError ? 4000 : 2500);
    }
    return () => {
      // Cleanup on unmount so we don't call setToast on a dead component
      if (!toast.visible && toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [toast.visible, toast.isError]);

  // Convert timeframe to Binance or Kite interval string
  const getIntervalString = () => {
    if (isCrypto) {
      switch (timeframe) {
        case '1m': return '1m';
        case '5m': return '5m';
        case '15m': return '15m';
        case '60m': return '1h';
        case 'day': return '1d';
        default: return '5m';
      }
    } else {
      switch (timeframe) {
        case '1m': return 'minute';
        case '5m': return '5minute';
        case '15m': return '15minute';
        case '60m': return '60minute';
        case 'day': return 'day';
        default: return '5minute';
      }
    }
  };

  // Get user's actual funds balance is now handled by BalanceDataProvider

  // Initialize Scalp toggle based on saved preference or trading mode from context
  useEffect(() => {
    const savedMode = localStorage.getItem('isTradeOnChartActive');
    if (savedMode !== null) {
      setIsTradeOnChartActive(savedMode === 'true');
    } else {
      setIsTradeOnChartActive(tradingMode === 'scalper');
    }
  // Only run once when tradingMode first becomes available
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradingMode]);

  // Ensure default quantity is reset to 1 when the symbol changes
  useEffect(() => {
    const isQtyDefault = segment.toUpperCase().includes('EQUITY') || segment.toUpperCase() === 'NSE-EQ' || segment.toUpperCase() === 'STOCKS' || segment.toUpperCase().includes('CRYPTO');
    setUseLots(!isQtyDefault);
    setQtyValue(1);
  }, [symbol]);


  // Historical data is fetched directly by the TV widget via Datafeed.getBars —
  // no duplicate React-side fetch needed. We just reset price display state when
  // the symbol/timeframe changes so the legend doesn't show stale values while
  // the widget is loading its own data.
  useEffect(() => {
    setLoading(true);
    setHistoricalCandles([]);
    setCurrentPrice(0);
    setPriceChange(0);
    setPriceChangePct(0);
    setError(null);
    hasLoadedData.current = false;

    // Backstop: if onFirstBar hasn't fired within 2.0 seconds (e.g. noData response,
    // Kite session expired, or instrument not found), clear the loading spinner so
    // the chart UI is at least usable rather than stuck.
    const loadingTimeout = setTimeout(() => {
      if (!hasLoadedData.current) {
        setLoading(false);
      }
    }, 2000);

    return () => clearTimeout(loadingTimeout);
  }, [symbol, timeframe, isCrypto]);

  // Update currentPrice/change with live quote once initial bar data has loaded.
  // Guards against derivatives (CE/PE/FUT) where activeLiveQuote is the underlying.
  useEffect(() => {
    if (!activeLiveQuote || loading) return;
    if (symbol.includes('CE') || symbol.includes('PE') || symbol.includes('FUT')) return;

    const lastPrice = activeLiveQuote.lastPrice;
    if (!lastPrice) return;

    setCurrentPrice(lastPrice);
    if (limitPrice === '') setLimitPrice(lastPrice.toFixed(2));

    setPriceChange(activeLiveQuote.change || 0);
    setPriceChangePct(activeLiveQuote.changePercent || 0);
  }, [activeLiveQuote, loading]);

  const displayExchange = isCrypto ? 'BINANCE' : (symbol.includes('SENSEX') || symbol.includes('BANKEX')) ? 'BSE' : 'NSE';
  const isUp = priceChange >= 0;

  // Drawing Tools Click handler
  const handleDrawingTool = (toolName: string) => {
    setActiveDrawingTool(activeDrawingTool === toolName ? null : toolName);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  // Stepper for quantity
  // In Lot mode: step by 0.5. In Qty mode: step by lotSize (whole units)
  const handleQtyStep = (delta: number) => {
    if (useLots) {
      setQtyValue(prev => Math.max(0.5, parseFloat((Number(prev) + delta * 0.5).toFixed(1))));
    } else {
      const step = isCrypto ? 0.01 : lotSize;
      const minQty = isCrypto ? 0.01 : lotSize;
      setQtyValue(prev => Math.max(minQty, parseFloat((Number(prev) + delta * step).toFixed(isCrypto ? 2 : 0))));
    }
  };

  // Toggle Lots vs Qty
  const handleUnitChange = (lotsActive: boolean) => {
    setUseLots(lotsActive);
    setQtyValue(prev => {
      const p = Number(prev);
      if (lotsActive) {
        // Convert qty -> lots, allow decimal (e.g. 12.5 qty / 25 lotSize = 0.5 lots)
        return Math.max(0.5, parseFloat((p / lotSize).toFixed(1)));
      } else {
        // Convert lots -> qty (always whole number except for crypto)
        return isCrypto ? parseFloat((p * lotSize).toFixed(2)) : Math.round(p * lotSize);
      }
    });
  };

  const handlePlaceOrder = async () => {
    if (isSubmitting) return;
    handleSubmitOrder();
  };

  // Place actual order
  const handleSubmitOrder = async () => {
    const qVal = Number(qtyValue) || 0;
    if (qVal <= 0) {
      showToast("Invalid quantity", true);
      return;
    }
    const finalQty = useLots ? (isCrypto ? qVal * lotSize : Math.round(qVal * lotSize)) : (isCrypto ? qVal : Math.round(qVal));
    const finalLots = useLots ? qVal : (finalQty / lotSize);

    // Determine the base execution price
    // For add-more/exit flow on a different instrument, use that position's LTP not the chart price
    // For chain contract orders, use the option contract's LTP not the underlying index price
    const basePrice = ((isAddMoreFlow || isExitFlow) && addMoreLtp) ? addMoreLtp : (chainContract ? chainContract.ltp : currentPrice);
    let finalPrice = basePrice;
    if (orderType === 'limit' || orderType === 'gtt') {
      finalPrice = parseFloat(limitPrice);
      if (isNaN(finalPrice) || finalPrice <= 0) {
        showToast('Please enter a valid price', true);
        return;
      }
    } else if (orderType === 'sl' || orderType === 'slm') {
      finalPrice = parseFloat(triggerPrice);
      if (isNaN(finalPrice) || finalPrice <= 0) {
        showToast('Please enter a valid trigger price', true);
        return;
      }
    }

    // Use the option segment for lookup when placing a chain contract order,
    // not the chart's underlying segment which may be "NSE - Equity" etc.
    const submitDbSeg = (() => {
      if (chainContract) {
        const name = chainContract.name.toUpperCase();
        const indexOptSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
        return indexOptSymbols.some(s => name.includes(s)) ? 'INDEX-OPT' : 'STOCK-OPT';
      }
      return mapSegmentWithSymbol(segment, symbol);
    })();
    const buySetting = getSegment(submitDbSeg, 'BUY');
    const sellSetting = getSegment(submitDbSeg, 'SELL');
    const segSetting = orderSide === 'SELL' ? sellSetting : buySetting;

    const intradayLeverage = segSetting?.intraday_leverage ?? 10;
    const holdingLeverage = segSetting?.holding_leverage ?? 10;
    const leverage = orderCarry === 'carry' ? holdingLeverage : intradayLeverage;
    const intradayType = segSetting?.intraday_type ?? 'Multiplier';
    const holdingType = segSetting?.holding_type ?? 'Multiplier';
    const levType = orderCarry === 'carry' ? holdingType : intradayType;

    const reqMargin = Math.round(levType === '%' ? (finalPrice * finalQty) * (leverage / 100) : (levType === 'Fixed' ? (finalQty / lotSize) * leverage : (finalPrice * finalQty) / leverage));
    if (reqMargin > balance) {
      showToast('Insufficient margin', true);
      return;
    }

    // Determine target symbol and segment — use position's symbol when in add-more or exit flow
    let orderSymbol = symbol;
    let orderSegment = segment;

    if (isAddMoreFlow && addMoreSymbol) {
      orderSymbol = addMoreSymbol;
      orderSegment = addMoreSegment || segment;
    } else if (isExitFlow && exitPositionId) {
      const p = positions.find(x => x.id === exitPositionId);
      if (p) {
        orderSymbol = p.symbol;
        orderSegment = p.settlement || (p as any).segment || segment;
      }
    }

    let orderKiteInstrument = (isAddMoreFlow || isExitFlow) && addMoreKiteInst ? addMoreKiteInst : orderSymbol;

    if (chainContract) {
      orderSymbol = chainContract.name;

      const underlying = symbol.toUpperCase().replace('_INDEX', '').replace('NSE:', '').replace('INDEX', '').trim();
      let prefix = 'NFO';
      if (underlying.includes('SENSEX') || underlying.includes('BANKEX')) prefix = 'BFO';
      else if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => underlying.startsWith(c))) prefix = 'MCX';

      orderKiteInstrument = chainContract.kiteId || `${prefix}:${orderSymbol}`;
      orderSegment = 'INDEX-OPT';
    } else {
      // For exit/add-more flows on options and futures, ensure kite instrument has prefix
      if (orderSymbol && (orderSymbol.endsWith('CE') || orderSymbol.endsWith('PE') || orderSymbol.endsWith('FUT') || orderSymbol.includes('FUT')) && !orderKiteInstrument.includes(':')) {
        let prefix = 'NFO';
        if (orderSymbol.startsWith('SENSEX') || orderSymbol.startsWith('BANKEX')) prefix = 'BFO';
        else if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => orderSymbol.startsWith(c))) prefix = 'MCX';
        else if (orderSymbol.startsWith('EURINR') || orderSymbol.startsWith('USDINR') || orderSymbol.startsWith('GBPINR') || orderSymbol.startsWith('JPYINR')) prefix = 'CDS';
        orderKiteInstrument = `${prefix}:${orderSymbol}`;
      }
    }

    if (modifyOrderId) {
      showToast('Modifying order...');
      const cancelRes = await cancelOrder(modifyOrderId);
      if (!cancelRes.success) {
        showToast(cancelRes.error || 'Failed to modify order (cancel failed)', true);
        return;
      }
    } else {
      showToast('Placing order...');
    }

    // Optimistic UI: Immediately close panel and show processing state
    setIsSubmitting(true);
    positionSnapshotRef.current = currentInstrumentPosition ? `${currentInstrumentPosition.id}:${currentInstrumentPosition.qty_open}` : '__none__';
    if (modifyOrderId) {
      setModifyOrderId(null);
    }
    setIsOrderBlockVisible(false);
    setChainContract(null);
    setIsExitFlow(false);
    setIsAddMoreFlow(false);
    setAddMoreSymbol(null);
    setAddMoreSegment(null);
    setAddMoreLtp(null);
    setAddMoreKiteInst(null);
    setExitPositionId(null);
    setOrderBlockTitle(symbol);
    
    const returnTo = postOrderSegment;
    setPostOrderSegment(null);
    if (returnTo && returnTo !== 'main') {
      setActiveSegment(returnTo as 'chain' | 'orders' | 'positions');
      setIsPanelExpanded(true);
    }

    placeOrder({
      symbol: orderSymbol,
      kite_instrument: orderKiteInstrument,
      segment: orderSegment,
      side: orderSide,
      qty: finalQty,
      lots: finalLots,
      order_type: orderType.toUpperCase() as any,
      product_type: orderCarry === 'carry' ? 'CARRY' : 'INTRADAY',
      client_price: finalPrice,
      trigger_price: (orderType === 'sl' || orderType === 'slm') ? parseFloat(triggerPrice) : undefined,
      stop_loss: gttSlPrice ? parseFloat(gttSlPrice) : undefined,
      target: gttTargetPrice ? parseFloat(gttTargetPrice) : undefined,
      is_exit: isExitFlow
    }).then(res => {
      if (res.success) {
        showToast(modifyOrderId ? 'Order Modified Successfully!' : `${orderSide} Order Placed Successfully!`);
        notifyOrderEvent();
      } else {
        showToast(res.error || 'Failed to place order', true);
      }
    }).catch(err => {
      showToast(err?.message || 'Failed to place order', true);
    }).finally(() => {
      setIsSubmitting(false);
      positionSnapshotRef.current = null;
    });
  };

  // Cancel actual order
  const handleCancelOrder = async (id: string) => {
    showToast('Cancelling order...');
    const res = await cancelOrder(id);
    if (res.success) {
      showToast('Order cancelled');
      notifyOrderEvent();
      if (modifyOrderId === id) {
        setModifyOrderId(null);
        setIsOrderBlockVisible(false);
        setOrderBlockTitle(symbol);
      }
    } else {
      showToast(res.error || 'Cancel failed', true);
    }
  };

  const handleModifyOrder = (o: MyOrder) => {
    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
    else setIsPanelExpanded(false);
    setModifyOrderId(o.id);
    setOrderSide(o.side);
    setQtyValue(o.qty);
    setUseLots(false);
    setOrderCarry(o.product_type === 'CARRY' ? 'carry' : 'normal');
    setOrderType(o.order_type.toLowerCase() as any);
    setLimitPrice(o.client_price ? o.client_price.toString() : '');
    setTriggerPrice(o.trigger_price ? o.trigger_price.toString() : '');
    setGttSlPrice(o.stop_loss ? o.stop_loss.toString() : '');
    setGttTargetPrice(o.target ? o.target.toString() : '');
    setIsExitFlow(false);
    setIsAddMoreFlow(false);
    setOrderBlockTitle(`Modify · ${o.symbol}`);
    setPostOrderSegment('orders');
    setIsOrderBlockVisible(true);
  };

  // Exit position via order panel (allows choosing Market/SL)
  const handleExitPosition = (pos: EnrichedPosition) => {
    if (isTradeOnChartActive) {
      handleQuickExit(pos);
      return;
    }

    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
    else setIsPanelExpanded(false);
    setIsExitFlow(true);
    setIsAddMoreFlow(false);
    setExitPositionId(pos.id);

    // Also set the target symbol info so the order block UI shows the correct position prices
    // instead of the chart's current instrument prices
    setAddMoreSymbol(pos.symbol);
    setAddMoreSegment(pos.settlement || (pos as any).segment || segment);
    setAddMoreKiteInst(pos.kite_instrument || pos.symbol);
    setAddMoreLtp(pos.current_ltp || pos.avg_price || pos.entry_price);

    setOrderSide(pos.side === 'BUY' ? 'SELL' : 'BUY');
    setQtyValue(pos.qty_open);
    setUseLots(false);
    setOrderCarry(pos.product_type === 'CARRY' ? 'carry' : 'normal');
    setOrderType('market');
    const posPrice = pos.current_ltp || pos.avg_price || pos.entry_price || currentPrice;
    setLimitPrice(posPrice.toFixed(2));
    setTriggerPrice(posPrice.toFixed(2));
    setOrderBlockTitle(`Exit · ${pos.symbol}`);
    setPostOrderSegment('main');
    setIsOrderBlockVisible(true);
  };

  const quickExitLock = useRef(false);
  const exitingPosIds = useRef<Set<string>>(new Set());
  const [, setForceRender] = useState(0);

  // All open/active positions (not filtered by symbol)
  const currentSymbolPositions = positions.filter(p => (p.status === 'open' || p.status === 'active'));
  // Sum pre-computed unrealised P&L (uses correct per-symbol LTP from useMyPositions)
  const pnlTotal = currentSymbolPositions.reduce((acc, pos) => acc + (pos.unrealised_pnl ?? 0), 0);

  // Instrument-specific position: find open position matching the currently viewed chart symbol
  const currentInstrumentPosition = useMemo(() => {
    const matchingPositions = positions.filter(p => {
      if (p.status !== 'open' && p.status !== 'active') return false;
      if (p.symbol === symbol) return true;
      if (p.kite_instrument === symbol) return true;
      if (p.symbol + 'USDT' === symbol) return true;
      if (symbol + 'USDT' === p.symbol) return true;
      return false;
    });
    if (matchingPositions.length === 0) return null;

    // Group them like Cumulative view
    const totalQty = matchingPositions.reduce((sum, p) => sum + p.qty_open, 0);
    const repPos = matchingPositions[0]; // just take first for other metadata
    return { ...repPos, qty_open: totalQty };
  }, [positions, symbol]);

  // Event-driven reconciliation for exit button loading/disabled states (Bug #1):
  // Automatically clear exiting status for any position ID that is no longer active in positions
  useEffect(() => {
    if (exitingPosIds.current.size > 0) {
      const activeIds = new Set(positions.filter(p => p.status === 'open' || p.status === 'active').map(p => p.id));
      let changed = false;
      for (const id of Array.from(exitingPosIds.current)) {
        if (!activeIds.has(id)) {
          exitingPosIds.current.delete(id);
          changed = true;
        }
      }
      if (changed) {
        setForceRender(prev => prev + 1);
      }
    }
  }, [positions]);

  // Reset transient position-derived quantity state when position count for the instrument becomes 0 (Bug #2)
  const prevInstrumentPosExistsRef = useRef<boolean>(false);
  useEffect(() => {
    const hasActivePosition = currentInstrumentPosition !== null;

    if (prevInstrumentPosExistsRef.current && !hasActivePosition) {
      // Position closed / exited completely — reset transient quantity to 1 lot (default instrument quantity)
      setQtyValue(1);
      setUseLots(true);
      setIsExitFlow(false);
      setIsAddMoreFlow(false);
      setExitPositionId(null);
    }

    prevInstrumentPosExistsRef.current = hasActivePosition;
  }, [currentInstrumentPosition]);

  // Direct quick-exit (instant market close of selected lot size)
  const handleQuickExit = async (pos: EnrichedPosition) => {
    if (quickExitLock.current || exitingPosIds.current.has(pos.id)) return;
    quickExitLock.current = true;
    exitingPosIds.current.add(pos.id);
    setForceRender(prev => prev + 1);

    try {
      const posLotSize = getLotSize(pos.symbol);
      const selectedQtyRaw = parseFloat(String(qtyValue)) || 0;
      const selectedQty = useLots ? selectedQtyRaw * posLotSize : selectedQtyRaw;
      const finalQty = selectedQty > 0 ? Math.min(pos.qty_open, selectedQty) : pos.qty_open;

      if (finalQty <= 0) {
        return;
      }

      const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const effectiveLots = finalQty / posLotSize;

      showToast(`Placing quick exit order...`);
      const exitTimeout = new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Exit order timed out' }), 15000)
      );
      const res = await Promise.race([
        placeOrder({
          symbol: pos.symbol,
          kite_instrument: pos.kite_instrument || pos.symbol,
          segment: pos.settlement || segment,
          side: exitSide,
          qty: finalQty,
          lots: effectiveLots,
          order_type: 'MARKET',
          product_type: pos.product_type || 'INTRADAY',
          client_price: pos.current_ltp || pos.avg_price || pos.entry_price || currentPrice,
          is_exit: true,
          linked_position_id: positionViewMode === 'detailed' ? pos.id : undefined
        }),
        exitTimeout
      ]);

      if (res.success) {
        showToast(`Quick exit order placed`);
        notifyOrderEvent();

        // Reset transient quantity state to 1 lot (configured default) upon exit completion
        setQtyValue(1);
        setUseLots(true);
        setIsExitFlow(false);
        setIsAddMoreFlow(false);
      } else {
        showToast(res.error || 'Exit failed', true);
      }
    } catch (err: any) {
      showToast(err?.message || 'Exit failed', true);
    } finally {
      quickExitLock.current = false;
      exitingPosIds.current.delete(pos.id);
      setIsSubmitting(false);
      setForceRender(prev => prev + 1);
    }
  };

  // Add more to a position (may be a different symbol from the current chart)
  const handleAddMorePosition = async (pos: EnrichedPosition) => {
    if (isSubmitting) return;
    if (!isTradeOnChartActive) {
      if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
      else setIsPanelExpanded(false);
    }
    setIsExitFlow(false);
    setIsAddMoreFlow(true);
    setExitPositionId(null);
    setAddMoreSymbol(pos.symbol);
    setAddMoreSegment(pos.settlement || segment);
    setAddMoreLtp(pos.current_ltp || pos.avg_price || pos.entry_price);
    setAddMoreKiteInst(pos.kite_instrument || pos.symbol);
    setOrderSide(pos.side);
    setQtyValue(pos.qty_open);
    setUseLots(false);
    setOrderCarry(pos.product_type === 'CARRY' ? 'carry' : 'normal');
    setOrderType('market');
    
    // Direct Execution for Scalping Mode (directly placing order, showing bm-loader)
    if (isTradeOnChartActive) {
      const posLotSize = getLotSize(pos.symbol);
      const qVal = posLotSize;
      const dbSeg = mapSegmentWithSymbol(segment, symbol);
      const segSetting = getSegment(dbSeg, pos.side);
      const leverage = pos.product_type === 'CARRY' ? (segSetting?.holding_leverage ?? 10) : (segSetting?.intraday_leverage ?? 10);
      const levType = pos.product_type === 'CARRY' ? (segSetting?.holding_type ?? 'Multiplier') : (segSetting?.intraday_type ?? 'Multiplier');
      const required = Math.round(levType === '%' ? (currentPrice * qVal) * (leverage / 100) : (levType === 'Fixed' ? (qVal / posLotSize) * leverage : (currentPrice * qVal) / leverage));

      if (required > balance) {
        showToast(`Insufficient margin! Need ₹${required.toLocaleString('en-IN')}`, true);
        return;
      }

      setIsSubmitting(true);
      setAddingPosId(pos.id);
      submitStartTimeRef.current = Date.now();
      positionSnapshotRef.current = `${pos.id}:${pos.qty_open}`;

      try {
        const addTimeout = new Promise<{ success: false; error: string }>((resolve) =>
          setTimeout(() => resolve({ success: false, error: 'Add to position timed out' }), 15000)
        );
        const res = await Promise.race([
          placeOrder({
            symbol: pos.symbol,
            kite_instrument: pos.kite_instrument || pos.symbol,
            segment: pos.settlement || segment,
            side: pos.side,
            qty: qVal,
            lots: 1,
            order_type: 'MARKET',
            product_type: pos.product_type === 'CARRY' ? 'CARRY' : 'INTRADAY',
            client_price: currentPrice || pos.current_ltp || pos.avg_price || 0,
            is_exit: false
          }),
          addTimeout
        ]);

        if (res.success) {
          showToast(`Successfully added ${qVal} to position!`);
          notifyOrderEvent();
        } else {
          showToast(res.error || 'Failed to add to position', true);
        }
      } catch (err: any) {
        showToast(err?.message || 'Failed to add to position', true);
      } finally {
        setIsSubmitting(false);
        setAddingPosId(null);
        positionSnapshotRef.current = null;
        window.dispatchEvent(new Event('global-loader-end'));
      }
      return;
    }

    setOrderBlockTitle(`Add More · ${pos.symbol}`);
    setPostOrderSegment('main');
    setIsOrderBlockVisible(true);
  };

  const quickEntryLock = useRef(false);

  const handleQuickMarketOrder = async (side: 'BUY' | 'SELL') => {
    if (quickEntryLock.current) return;
    quickEntryLock.current = true;
    setOrderSide(side);

    try {
      // Guard: don't place order if price feed hasn't loaded yet
      if (!currentPrice || currentPrice <= 0) {
        showToast('Price not loaded yet. Please wait a moment.', true);
        return;
      }

      // Guard against stale exit/add-more quantity when placing a new order
      let qVal = Number(qtyValue) || 1;
      if (isExitFlow || isAddMoreFlow || qVal <= 0) {
        qVal = 1;
        setQtyValue(1);
        setUseLots(true);
        setIsExitFlow(false);
        setIsAddMoreFlow(false);
      }

      if (qVal <= 0) {
        showToast("Invalid quantity", true);
        return;
      }
      const isScalper = tradingMode === 'scalper';
      const effectiveUseLots = isScalper ? true : useLots;

      const dbSeg = mapSegmentWithSymbol(segment, symbol);
      const segSetting = getSegment(dbSeg, side);
      const maxOrderLot = segSetting?.max_order_lot ?? segSetting?.max_lot ?? 50;

      // If qty exceeds max, show error, correct input to max, and abort — don't silently clamp.
      if (effectiveUseLots && maxOrderLot > 0 && qVal > maxOrderLot) {
        showToast(`Max allowed: ${maxOrderLot} lots (${maxOrderLot * lotSize} qty). Corrected to maximum.`, true);
        setQtyValue(String(maxOrderLot));
        return;
      }

      const finalQty = effectiveUseLots ? (isCrypto ? qVal * lotSize : Math.round(qVal * lotSize)) : (isCrypto ? qVal : Math.round(qVal));
      const intradayLeverage = segSetting?.intraday_leverage ?? 10;
      const intradayType = segSetting?.intraday_type ?? 'Multiplier';
      const required = Math.round(intradayType === '%' ? (currentPrice * finalQty) * (intradayLeverage / 100) : (intradayType === 'Fixed' ? (finalQty / lotSize) * intradayLeverage : (currentPrice * finalQty) / intradayLeverage));

      if (required > balance) {
        showToast(`Insufficient margin! Need ₹${required.toLocaleString('en-IN')}`, true);
        return;
      }

      showToast(`Placing quick ${side} order...`);
      // Build proper kite instrument id (with exchange prefix) for server-side quote fetch
      const kiteInst = (() => {
        const s = symbol;
        if (s.includes(':')) return s;
        const upper = s.toUpperCase();
        if (isCrypto || upper.endsWith('USDT') || ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'].some(c => upper === c || upper.startsWith(c + 'USDT'))) {
          return `BINANCE:${s.replace(/^BINANCE:/i, '')}`;
        }
        if (['GBPUSD', 'EURUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'].includes(upper)) {
          return `FOREX:${s}`;
        }
        if (upper.endsWith('=F') || upper.includes('=F')) return `COMEX:${s}`;
        if (upper.endsWith('CE') || upper.endsWith('PE') || upper.endsWith('FUT') || upper.includes('FUT')) {
          if (upper.startsWith('SENSEX') || upper.startsWith('BANKEX')) return `BFO:${s}`;
          if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => upper.startsWith(c))) return `MCX:${s}`;
          if (upper.startsWith('EURINR') || upper.startsWith('USDINR') || upper.startsWith('GBPINR') || upper.startsWith('JPYINR')) return `CDS:${s}`;
          return `NFO:${s}`;
        }
        return `NSE:${s}`;
      })();
      showToast(`Quick ${side} order placed!`);

      // Inject optimistic position immediately for instant UI feedback
      try {
        const dbSeg = mapSegmentWithSymbol(segment, symbol);
        addOptimisticPosition({
          symbol,
          settlement: dbSeg,
          side,
          qty_open: finalQty,
          lots: effectiveUseLots ? qVal : (finalQty / lotSize),
          entry_price: currentPrice,
          avg_price: currentPrice,
          ltp: currentPrice,
          product_type: 'INTRADAY',
          kite_instrument: kiteInst,
          _preOrderQty: currentInstrumentPosition?.qty_open ?? 0,
        } as any);
      } catch (optErr) {
        console.warn('[TradingChart] Optimistic position injection failed:', optErr);
      }

      // Flash the button
      const btn = document.getElementById(side === 'BUY' ? 'buyButton' : 'sellButton');
      if (btn) {
        btn.classList.remove('quick-flash');
        void btn.offsetWidth;
        btn.classList.add('quick-flash');
      }

      setActiveSegment('positions');

      // Release lock immediately — no waiting for API
      quickEntryLock.current = false;
      positionSnapshotRef.current = null;
      window.dispatchEvent(new Event('global-loader-end'));

      // Fire API in background
      placeOrder({
        symbol: symbol,
        kite_instrument: kiteInst,
        segment: segment,
        side: side,
        qty: finalQty,
        lots: effectiveUseLots ? qVal : (finalQty / lotSize),
        order_type: 'MARKET',
        product_type: 'INTRADAY',
        client_price: currentPrice,
        frontend_ask: activeLiveQuote?.ask || currentPrice,
        frontend_bid: activeLiveQuote?.bid || currentPrice,
        frontend_ltp: currentPrice,
        client_click_time: Date.now(),
        is_exit: false
      }).then(res => {
        if (res.success) {
          notifyOrderEvent();
        } else {
          showToast(res.error || 'Order may have failed — check positions', true);
          refreshPositions();
          refreshBalance();
        }
      }).catch(err => {
        showToast(err?.message || 'Quick order failed — check positions', true);
        refreshPositions();
      });
    } catch (err: any) {
      showToast(err?.message || 'Quick order failed', true);
      quickEntryLock.current = false;
      positionSnapshotRef.current = null;
      window.dispatchEvent(new Event('global-loader-end'));
    }
  };

  const handleQuickAddPosition = async (pos: EnrichedPosition) => {
    if (quickEntryLock.current || isSubmitting) return;
    quickEntryLock.current = true;
    setIsSubmitting(true);
    setAddingPosId(pos.id);

    try {
      const addQty = pos.qty_open;
      const dbSeg = mapSegmentWithSymbol(segment, symbol);
      const segSetting = getSegment(dbSeg, pos.side);
      const leverage = pos.product_type === 'CARRY' ? (segSetting?.holding_leverage ?? 10) : (segSetting?.intraday_leverage ?? 10);
      const levType = pos.product_type === 'CARRY' ? (segSetting?.holding_type ?? 'Multiplier') : (segSetting?.intraday_type ?? 'Multiplier');
      const required = Math.round(levType === '%' ? (currentPrice * addQty) * (leverage / 100) : (levType === 'Fixed' ? (addQty / lotSize) * leverage : (currentPrice * addQty) / leverage));

      if (required > balance) {
        showToast(`Insufficient margin! Need ₹${required.toLocaleString('en-IN')}`, true);
        return;
      }

      showToast(`Adding ${addQty} to ${pos.side} position...`);
      
      // Build proper kite instrument id (with exchange prefix) for server-side quote fetch
      const kiteInst = (() => {
        const s = symbol;
        if (s.includes(':')) return s;
        const upper = s.toUpperCase();
        if (isCrypto || upper.endsWith('USDT') || ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'].some(c => upper === c || upper.startsWith(c + 'USDT'))) {
          return `BINANCE:${s.replace(/^BINANCE:/i, '')}`;
        }
        if (['GBPUSD', 'EURUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'].includes(upper)) {
          return `FOREX:${s}`;
        }
        if (upper.endsWith('=F') || upper.includes('=F')) return `COMEX:${s}`;
        if (upper.endsWith('CE') || upper.endsWith('PE') || upper.endsWith('FUT') || upper.includes('FUT')) {
          if (upper.startsWith('SENSEX') || upper.startsWith('BANKEX')) return `BFO:${s}`;
          if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => upper.startsWith(c))) return `MCX:${s}`;
          if (upper.startsWith('EURINR') || upper.startsWith('USDINR') || upper.startsWith('GBPINR') || upper.startsWith('JPYINR')) return `CDS:${s}`;
          return `NFO:${s}`;
        }
        return `NSE:${s}`;
      })();

      const quickAddTimeout = new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Add to position timed out' }), 25000)
      );

      const res = await Promise.race([
        placeOrder({
          symbol: symbol,
          kite_instrument: kiteInst,
          segment: segment,
          side: pos.side,
          qty: addQty,
          lots: 0,
          order_type: 'MARKET',
          product_type: pos.product_type === 'CARRY' ? 'CARRY' : 'INTRADAY',
          client_price: currentPrice || pos.current_ltp || pos.avg_price || 0,
          frontend_ask: activeLiveQuote?.ask || currentPrice,
          frontend_bid: activeLiveQuote?.bid || currentPrice,
          frontend_ltp: currentPrice,
          client_click_time: Date.now(),
          is_exit: false
        }),
        quickAddTimeout
      ]);

      if (res.success) {
        showToast(`Successfully added ${addQty} to position!`);
        notifyOrderEvent();
      } else {
        showToast(res.error || 'Failed to add to position', true);
      }
    } catch (err: any) {
      showToast(err?.message || 'Failed to add to position', true);
    } finally {
      quickEntryLock.current = false;
      setIsSubmitting(false);
      setAddingPosId(null);
      positionSnapshotRef.current = null;
      window.dispatchEvent(new Event('global-loader-end'));
    }
  };

  // ── Safety Watchdog to prevent permanent button lockups ──
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isSubmitting || exitingPosIds.current.size > 0) {
      if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
      // Reduced from 18 s → 10 s: fail fast so the user can retry sooner.
      watchdogTimerRef.current = setTimeout(() => {
        console.warn('[TradingChart Watchdog] Auto-clearing stuck submitting/exiting state');
        setIsSubmitting(false);
        setAddingPosId(null);
        positionSnapshotRef.current = null;
        exitingPosIds.current.clear();
        quickEntryLock.current = false;
        quickExitLock.current = false;
        setForceRender(prev => prev + 1);
        window.dispatchEvent(new Event('global-loader-end'));
        // Refresh in case the order executed server-side while we were stuck
        refreshPositions();
        refreshBalance();
      }, 10000);
    } else {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    }
  }, [isSubmitting, refreshPositions, refreshBalance]);

  // ── Page-visibility safety net ──
  // Mobile browsers throttle setTimeout / useEffect when the tab is backgrounded.
  // If the user switches apps while waiting for an order, the watchdog (above) may
  // never fire, leaving isSubmitting = true indefinitely.
  // When the tab becomes visible again, check whether we've been stuck > 8 s and
  // force-clear if so, then refresh positions in case the order went through.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const elapsed = Date.now() - submitStartTimeRef.current;
      const stuck =
        (isSubmitting || quickEntryLock.current || exitingPosIds.current.size > 0) &&
        submitStartTimeRef.current > 0 &&
        elapsed > 8000;
      if (!stuck) return;
      console.warn('[TradingChart] Tab visible with stuck state after', elapsed, 'ms — force-clearing');
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      setIsSubmitting(false);
      setAddingPosId(null);
      positionSnapshotRef.current = null;
      exitingPosIds.current.clear();
      quickEntryLock.current = false;
      quickExitLock.current = false;
      submitStartTimeRef.current = 0;
      setForceRender(prev => prev + 1);
      window.dispatchEvent(new Event('global-loader-end'));
      // Refresh so newly-created positions are reflected immediately
      refreshPositions();
      refreshBalance();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isSubmitting, refreshPositions, refreshBalance]);

  useEffect(() => {
    return () => {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
      }
    };
  }, []);

  // ── Watch for position changes while submitting ──
  // Keep buttons in loading state until positions actually refresh and the UI changes
  useEffect(() => {
    if (!isSubmitting || positionSnapshotRef.current === null) return;

    const snapshotId = positionSnapshotRef.current.split(':')[0];

    let changed = false;

    if (snapshotId === '__none__') {
      // New position case: we had no open position before the order.
      // Clear isSubmitting as soon as ANY open/active position for this symbol appears.
      const hasNewPos = positions.some(
        p => p.symbol === symbol && (p.status === 'open' || p.status === 'active')
      );
      changed = hasNewPos;
    } else {
      // Existing position case: qty changed or position closed
      const targetPos = positions.find(
        p => p.id === snapshotId && (p.status === 'open' || p.status === 'active')
      );
      const snapshotQty = Number(positionSnapshotRef.current.split(':')[1]);
      const currentKey = targetPos ? `${targetPos.id}:${targetPos.qty_open}` : '__none__';
      changed = currentKey !== positionSnapshotRef.current || (targetPos?.qty_open !== snapshotQty);
    }

    if (changed) {
      setIsSubmitting(false);
      setAddingPosId(null);
      positionSnapshotRef.current = null;
      quickEntryLock.current = false;
      window.dispatchEvent(new Event('global-loader-end'));
      if (submittingTimeoutRef.current) {
        clearTimeout(submittingTimeoutRef.current);
        submittingTimeoutRef.current = null;
      }
    }
  }, [positions, isSubmitting, symbol]);

  // Calculated Required Margin for current order block state
  // Determine if the current chart symbol is itself an option/futures contract
  // (not the underlying index). In that case, activeLiveQuote belongs to the underlying
  // so we must NOT use its bid/ask for placing an option order.
  const symbolIsDerivative = symbol.includes('CE') || symbol.includes('PE') || symbol.includes('FUT');

  // When in add-more or exit flow for a different instrument, use that instrument's live quote
  // instead of the chart's current symbol's quote for bid/ask/LTP/margin
  const isTargetFlow = ((isAddMoreFlow || isExitFlow) && addMoreSymbol && addMoreSymbol !== symbol);
  const addMoreQuote = isTargetFlow ? marketQuotes[addMoreSymbol!] : null;

  // When a chain contract is open, the option segment must be used for settings lookup,
  // not the chart's underlying segment (e.g. "NSE - Equity" for NIFTY 50).
  const effectiveDbSeg = (() => {
    if (chainContract) {
      const name = chainContract.name.toUpperCase();
      const stockOptSymbols = ['SENSEX', 'BANKEX'];
      const indexOptSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
      const isIndexOpt = indexOptSymbols.some(s => name.includes(s)) || !stockOptSymbols.some(s => name.includes(s));
      return isIndexOpt ? 'INDEX-OPT' : 'STOCK-OPT';
    }
    // When in add-more or exit flow, use the position's segment for settings lookup
    if ((isAddMoreFlow || isExitFlow) && addMoreSegment) {
      return mapSegmentWithSymbol(addMoreSegment, symbol);
    }
    return mapSegmentWithSymbol(segment, symbol);
  })();

  const dbSeg = effectiveDbSeg;
  const buySetting = getSegment(dbSeg, 'BUY');
  const sellSetting = getSegment(dbSeg, 'SELL');
  const segSetting = orderSide === 'SELL' ? sellSetting : buySetting;

  let rawBid = isTargetFlow
    ? (addMoreQuote?.bid || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : ((!symbolIsDerivative && activeLiveQuote)
      ? (activeLiveQuote.bid || activeLiveQuote.lastPrice || currentPrice)
      : currentPrice);
  let rawAsk = isTargetFlow
    ? (addMoreQuote?.ask || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : ((!symbolIsDerivative && activeLiveQuote)
      ? (activeLiveQuote.ask || activeLiveQuote.lastPrice || currentPrice)
      : currentPrice);

  if (isCrypto) {
    const ltpToUse = isTargetFlow
      ? (addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
      : (!symbolIsDerivative && activeLiveQuote ? (activeLiveQuote.lastPrice || currentPrice) : currentPrice);

    if (ltpToUse > 0) {
      rawBid = (activeLiveQuote?.bid && activeLiveQuote.bid > 0) ? activeLiveQuote.bid : ltpToUse;
      rawAsk = (activeLiveQuote?.ask && activeLiveQuote.ask > 0) ? activeLiveQuote.ask : ltpToUse;
    }
  }

  const underlyingPriceOfScript = orderSide === 'SELL' ? rawBid : rawAsk;
  // When a chain contract is open, use the option's bid/ask price, not the underlying index price
  const priceOfScript = chainContract
    ? (orderSide === 'SELL' ? chainContract.bid : chainContract.ask)
    : underlyingPriceOfScript;

  const orderQty = useLots ? (parseFloat(String(qtyValue)) || 0) * lotSize : (parseFloat(String(qtyValue)) || 0);
  // Fall back to currentPrice if activeLiveQuote bid/ask is missing or zero
  const resolvedPrice = priceOfScript > 0 ? priceOfScript : currentPrice;
  const executionPrice = orderType === 'limit'
    ? (parseFloat(limitPrice) > 0 ? parseFloat(limitPrice) : resolvedPrice)
    : resolvedPrice;

  const liveOptionQuote = (chainContract && chainContract.kiteId) ? marketQuotes[chainContract.kiteId] : null;
  const liveAsk = isTargetFlow
    ? (addMoreQuote?.ask || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : (chainContract
      ? (liveOptionQuote?.ask || chainContract.ask)
      : rawAsk);
  const liveBid = isTargetFlow
    ? (addMoreQuote?.bid || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : (chainContract
      ? (liveOptionQuote?.bid || chainContract.bid)
      : rawBid);
  const liveLTP = isTargetFlow
    ? (addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : (chainContract
      ? (liveOptionQuote?.lastPrice || chainContract.ltp)
      : (!symbolIsDerivative && activeLiveQuote ? (activeLiveQuote.lastPrice || currentPrice) : currentPrice));

  const intradayLeverage = segSetting?.intraday_leverage ?? 10;
  const holdingLeverage = segSetting?.holding_leverage ?? 10;
  const leverage = orderCarry === 'carry' ? holdingLeverage : intradayLeverage;
  const intradayType = segSetting?.intraday_type ?? 'Multiplier';
  const holdingType = segSetting?.holding_type ?? 'Multiplier';
  const leverageType = orderCarry === 'carry' ? holdingType : intradayType;

  const chargePrice = orderType === 'limit' && limitPrice && parseFloat(limitPrice) > 0
    ? parseFloat(limitPrice) : resolvedPrice;
  const chargeQty = orderQty;
  const chargeExposure = chargeQty * chargePrice;

  // Fallback defaults if segSetting is missing or incomplete
  const fallbackCommType = 'Per Crore';
  let fallbackCommVal = 4500;
  const sUpper = (dbSeg || '').toUpperCase();
  if (sUpper.includes('FOREX') || sUpper.includes('CDS')) {
    fallbackCommVal = 2000;
  } else if (sUpper.includes('CRYPTO')) {
    fallbackCommVal = 1000;
  }

  const computeCharge = (commType: string, commVal: number) => {
    if (commType === 'Per Crore') return (chargeExposure * commVal) / 10000000;
    if (commType === 'Per Lot') return (chargeQty / lotSize) * commVal;
    if (commType === 'Per Trade' || commType === 'Flat') return commVal;
    return chargeExposure * 0.001;
  };

  const multiplier = (isExitFlow || isAddMoreFlow || modifyOrderId) ? 1 : 2;

  // Brokerage preview: Only intraday + GTT shown at entry.
  // Carry brokerage is DEFERRED to exit time (charged when position is closed as CARRY).
  const intradayCharge = (segSetting ? computeCharge(
    segSetting.commission_type || 'Per Crore',
    segSetting.commission_value ?? 0
  ) : 0) * multiplier;

  const gttCharge = (segSetting ? computeCharge(
    segSetting.gtt_commission_type || 'Per Trade',
    segSetting.gtt_commission_value ?? 10
  ) : computeCharge('Per Trade', 15));

  const carryCharge = (segSetting ? computeCharge(
    segSetting.carry_commission_type || segSetting.commission_type || 'Per Crore',
    segSetting.carry_commission_value ?? segSetting.commission_value ?? fallbackCommVal
  ) : computeCharge(fallbackCommType, fallbackCommVal)) * multiplier;

  // NOTE: GTT is an execution type, NOT a product type — carry charges must NOT auto-apply on GTT+INTRADAY
  const activeCarryCharge = orderCarry === 'carry' ? carryCharge : 0;
  const activeGttCharge = orderType === 'gtt' ? gttCharge : 0;

  const totalBrokerage = isExitFlow ? 0 : (
    intradayCharge + activeCarryCharge + activeGttCharge
  );
  const marginPortion = calculateMarginPortion({
    segment: dbSeg,
    side: orderSide,
    leverageType,
    leverage,
    totalQty: orderQty,
    lotSize,
    baseExposure: executionPrice * orderQty
  });
  const reqMargin = Math.round(marginPortion + totalBrokerage);

  // Render collapsible panel tabs content
  const renderPanelContent = () => {
    if (activeSegment === 'chain') {
      if (isCrypto || segment.toUpperCase().includes('FOREX')) {
        return <div className="empty-state">Option Chain not available for this segment.</div>;
      }
      if (chainLoading) {
        return (
          <div style={{ padding: '40px 0' }}>
            <AnimatedLoader text="Loading option chain..." fullScreen={false} />
          </div>
        );
      }
      if (!chainStrikes || chainStrikes.length === 0) {
        return <div className="empty-state">Option chain data is currently unavailable for {symbol}.</div>;
      }

      const handleTableTrade = (tradeSymbol: string, defaultAction: 'BUY' | 'SELL') => {
        // tradeSymbol = "NIFTY26JUN24000CE|221.45|0|NFO:NIFTY26JUN24000CE"
        const parts = tradeSymbol.split('|');
        if (parts.length < 2) return;
        const contractName = parts[0];
        const ltp = parseFloat(parts[1]) || 0;
        const kiteId = parts[3] || '';
        openChainOrder(defaultAction, contractName, chainExpiry, ltp, 0, kiteId);
      };

      // Transform real strikes for TradingChart format (needs tradeSymbol with | format for handleTableTrade)
      const mappedStrikes = chainStrikes.map((r: any) => {
        const ceQuote = r.ce?.id ? marketQuotes[r.ce.id] : null;
        const peQuote = r.pe?.id ? marketQuotes[r.pe.id] : null;
        const ceLtp = ceQuote ? ceQuote.lastPrice : (r.ce?.price || 0);
        const peLtp = peQuote ? peQuote.lastPrice : (r.pe?.price || 0);

        return {
          strike: r.strike,
          ce: { ...r.ce, symbol: r.ce ? `${r.ce.symbol}|${ceLtp}|0|${r.ce.id}` : '' },
          pe: { ...r.pe, symbol: r.pe ? `${r.pe.symbol}|${peLtp}|0|${r.pe.id}` : '' }
        };
      });

      return (
        <div className="tc-chain-container" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          <OptionChainTable
            symbol={underlyingSym}
            strikes={mappedStrikes}
            quotes={marketQuotes}
            spotPrice={chainData?.underlyingPrice || currentPrice || 71.00}
            onTrade={handleTableTrade}
            priceMode="LTP"
            stickyTop={0}
            hideMainHeader={true}
          />
        </div>
      );
    }

    if (activeSegment === 'orders') {
      const openOrders = orders.filter(o => o.status === 'PENDING');

      return (
        <>
          {openOrders.length === 0 ? (
            <div className="empty-state">No open orders.</div>
          ) : (
            openOrders.map(o => {
              const isBuy = o.side === 'BUY';
              const label = o.side;
              const labelBg = isBuy ? 'var(--green-bg)' : 'var(--red-bg)';
              const labelClr = isBuy ? 'var(--green-text)' : 'var(--red-text)';
              const timeStr = o.created_at ? new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              return (
                <div key={o.id} className="order-row">
                  <div className="order-info-row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 0%', minWidth: 0 }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{o.symbol}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ fontWeight: 700, color: labelClr, fontSize: '10px', background: labelBg, padding: '1px 6px', borderRadius: '4px' }}>{label}</span>
                        <span style={{ color: 'var(--pill-text)', fontSize: '11px' }}>{o.qty} qty</span>
                        {o.order_type && (
                          <span style={{ fontSize: '9px', background: 'var(--blue-bg)', color: 'var(--blue-text)', padding: '1px 6px', borderRadius: '4px', fontWeight: 600 }}>
                            {o.order_type.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', flexShrink: 0 }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '12px' }}>
                        ₹{(() => {
                          const type = (o.order_type || '').toUpperCase();
                          if (type === 'GTT') {
                            if (o.stop_loss && o.target) return `SL ${o.stop_loss.toFixed(2)} / TP ${o.target.toFixed(2)}`;
                            if (o.stop_loss) return `SL ₹${o.stop_loss.toFixed(2)}`;
                            if (o.target) return `TP ₹${o.target.toFixed(2)}`;
                          }
                          if (type === 'SL' || type === 'SLM') return (o.trigger_price ?? o.client_price ?? 0).toFixed(2);
                          return (o.client_price ?? o.fill_price ?? o.ltp_at_entry ?? 0).toFixed(2);
                        })()}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{timeStr}</span>
                    </div>
                  </div>
                  {o.status === 'PENDING' && (
                    <div className="order-actions">
                      <button className="order-action-btn modify-order-btn" onClick={() => handleModifyOrder(o)}>Modify</button>
                      <button className="order-action-btn delete-order-btn" onClick={() => handleCancelOrder(o.id)}>Delete</button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </>
      );
    }

    // Positions — Cumulative / Detailed view
    if (currentSymbolPositions.length === 0) {
      return <div className="empty-state">No active positions.</div>;
    }

    // ── Cumulative grouping ──
    const groupedPositionsMap = new Map<string, any>();
    for (const pos of currentSymbolPositions) {
      const key = `${pos.symbol}|${pos.side}|${pos.product_type}`;
      if (!groupedPositionsMap.has(key)) {
        groupedPositionsMap.set(key, { ...pos, _ids: [pos.id], _count: 1 });
      } else {
        const existing = groupedPositionsMap.get(key);
        const entryA = existing.avg_price || existing.entry_price || 0;
        const entryB = pos.avg_price || pos.entry_price || 0;
        const totalQty = existing.qty_open + pos.qty_open;
        existing.qty_open = totalQty;
        existing.avg_price = totalQty > 0 ? (entryA * existing._ids.length + entryB) / (existing._ids.length + 1) : entryA;
        existing.entry_price = existing.avg_price;
        existing.unrealised_pnl = (existing.unrealised_pnl || 0) + (pos.unrealised_pnl || 0);
        existing._ids.push(pos.id);
        existing._count += 1;
      }
    }
    const groupedPositions = Array.from(groupedPositionsMap.values());

    // Detailed = individual positions sorted newest first
    const detailedPositions = [...currentSymbolPositions].sort(
      (a, b) => new Date(b.entry_time || 0).getTime() - new Date(a.entry_time || 0).getTime()
    );

    const fmtPnl = (pnl: number) => `${pnl >= 0 ? '+' : '-'}₹${Math.abs(pnl).toFixed(2)}`;
    const fmtPrice = (v: number) => `₹${v.toFixed(2)}`;

    const positionsToRender = positionViewMode === 'cumulative' ? groupedPositions : detailedPositions;

    return (
      <>
        {/* Cumulative / Detailed Toggle */}
        <div style={{
          display: 'flex',
          borderBottom: '2px solid var(--border-light, #E8ECF0)',
          background: 'var(--container-bg, #fff)',
          flexShrink: 0,
          width: 'calc(100% + 1rem)',
          margin: '-0.5rem -0.5rem 0 -0.5rem'
        }}>
          <button
            onClick={() => setPositionViewMode('cumulative')}
            style={{
              flex: 1, padding: '7px 0', fontSize: '11px',
              fontWeight: positionViewMode === 'cumulative' ? 700 : 600,
              border: 'none', borderRadius: 0, cursor: 'pointer',
              background: 'transparent',
              color: positionViewMode === 'cumulative' ? ((themeMode === 'dark' || themeMode === 'black' || themeMode === 'blue') ? '#2962FF' : 'var(--navy, #101828)') : 'var(--text-secondary, #6b7280)',
              borderBottom: positionViewMode === 'cumulative' ? ((themeMode === 'dark' || themeMode === 'black') ? '2.5px solid #2962FF' : '2.5px solid var(--navy, #101828)') : '2.5px solid transparent',
              marginBottom: '-2px',
              transition: 'all 0.15s',
            }}
          >
            Cumulative
          </button>
          <button
            onClick={() => setPositionViewMode('detailed')}
            style={{
              flex: 1, padding: '7px 0', fontSize: '11px',
              fontWeight: positionViewMode === 'detailed' ? 700 : 600,
              border: 'none', borderRadius: 0, cursor: 'pointer',
              background: 'transparent',
              color: positionViewMode === 'detailed' ? ((themeMode === 'dark' || themeMode === 'black' || themeMode === 'blue') ? '#2962FF' : 'var(--navy, #101828)') : 'var(--text-secondary, #6b7280)',
              borderBottom: positionViewMode === 'detailed' ? ((themeMode === 'dark' || themeMode === 'black') ? '2.5px solid #2962FF' : '2.5px solid var(--navy, #101828)') : '2.5px solid transparent',
              marginBottom: '-2px',
              transition: 'all 0.15s',
            }}
          >
            Detailed
          </button>
        </div>

        {/* Position Rows */}
        {positionsToRender.map((pos, idx) => {
          const entryPrice = pos.avg_price || pos.entry_price || 0;
          const ltp = pos.current_ltp ?? pos.ltp ?? entryPrice;
          const pnl = pos.unrealised_pnl ?? pos.total_pnl ?? 0;
          const pnlColor = pnl >= 0 ? 'var(--green, #1db954)' : 'var(--red, #e53935)';
          const sideBg = pos.side === 'BUY' ? 'var(--green-bg)' : 'var(--red-bg)';
          const sideClr = pos.side === 'BUY' ? 'var(--green-text)' : 'var(--red-text)';
          const isExiting = exitingPosIds.current.has(pos.id);
          // entry time for detailed view
          const timeStr = pos.entry_time
            ? new Date(pos.entry_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';
          const tradeCount = pos._count || 1;

          return (
            <div key={positionViewMode === 'cumulative' ? `${pos.symbol}|${pos.side}|${pos.product_type}` : pos.id} className="position-row">
              <div className="position-info-row">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '130px' }}>{pos.symbol}</span>
                    {positionViewMode === 'detailed' && timeStr && (
                      <span style={{ fontSize: '9px', color: 'var(--text-muted)', flexShrink: 0 }}>{timeStr}</span>
                    )}
                    {positionViewMode === 'cumulative' && tradeCount > 1 && (
                      <span style={{ fontSize: '9px', background: 'var(--pill-bg, #F1F5F9)', color: 'var(--text-secondary)', padding: '1px 5px', borderRadius: '10px', flexShrink: 0 }}>
                        {tradeCount} trades
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <span style={{ fontWeight: 700, color: sideClr, fontSize: '10px', background: sideBg, padding: '1px 6px', borderRadius: '4px' }}>
                      {pos.side}
                    </span>
                    <span style={{ color: 'var(--pill-text)', fontSize: '11px' }}>{pos.qty_open} qty</span>
                    {pos.product_type && (
                      <span style={{ fontSize: '9px', fontWeight: 600, color: pos.product_type === 'CARRY' ? '#7C3AED' : 'var(--text-muted)', background: pos.product_type === 'CARRY' ? '#EDE9FE' : 'transparent', padding: pos.product_type === 'CARRY' ? '1px 5px' : '0', borderRadius: '4px' }}>
                        {pos.product_type}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', flexShrink: 0 }}>
                  <div style={{ color: pnlColor, fontWeight: 700, fontSize: '13px' }}>
                    {fmtPnl(pnl)}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', rowGap: '1px', columnGap: '5px', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '10px', textAlign: 'right' }}>Avg</span>
                    <span style={{ color: 'var(--text-primary)', fontSize: '10px', fontWeight: 500 }}>{fmtPrice(entryPrice)}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '10px', textAlign: 'right' }}>LTP</span>
                    <span style={{ color: 'var(--text-primary)', fontSize: '10px', fontWeight: 500 }}>{fmtPrice(ltp)}</span>
                  </div>
                </div>
              </div>
              <div className="position-actions">
                <button 
                  className={`position-action-btn add-position-btn${(isSubmitting && addingPosId !== pos.id) || exitingPosIds.current.size > 0 ? ' submitting-inactive' : ''}`} 
                  onClick={() => handleAddMorePosition(pos)} 
                  disabled={isSubmitting || exitingPosIds.current.size > 0}
                >
                  {isSubmitting && addingPosId === pos.id && <AnimatedLoader size="small" />}
                  {isSubmitting && addingPosId === pos.id ? 'Adding...' : '+ Add More'}
                </button>
                <button
                  className={`position-action-btn exit-position-btn${isSubmitting || (exitingPosIds.current.size > 0 && !isExiting) ? ' submitting-inactive' : ''}`}
                  onClick={() => handleExitPosition(pos)}
                  disabled={isSubmitting || isExiting || (exitingPosIds.current.size > 0 && !isExiting)}
                  style={{ 
                    opacity: (isSubmitting || isExiting || (exitingPosIds.current.size > 0 && !isExiting)) ? 0.5 : 1, 
                    cursor: (isSubmitting || isExiting || (exitingPosIds.current.size > 0 && !isExiting)) ? 'not-allowed' : 'pointer',
                    pointerEvents: (isSubmitting || exitingPosIds.current.size > 0) ? 'none' : 'auto'
                  }}
                >
                  {isExiting ? 'Exiting...' : 'Exit'}
                </button>
              </div>
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div
      suppressHydrationWarning
      className={`tc-wrapper ${themeMode} ${isPanelExpanded && !(isLandscape || isCssLandscape) ? 'panel-expanded' : ''}`}
      style={(isLandscape || isCssLandscape) ? {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: isCssLandscape ? '100dvh' : '100vw',
        height: isCssLandscape ? '100vw' : '100dvh',
        zIndex: 999999,
        borderRadius: 0,
        margin: 0,
        overflow: 'hidden',
        transform: isCssLandscape ? 'rotate(90deg) translateY(-100%)' : 'none',
        transformOrigin: isCssLandscape ? 'top left' : 'center',
        background: 'var(--container-bg, #071824)',
      } : undefined}
    >
      {/* Top Toolbar */}
      <div className="tc-top-toolbar" onMouseLeave={() => setOpenTopFlyout(null)}>
        {/* ── Back button ── */}
        <button
          className="tc-tb-btn tc-back-btn"
          title="Back (Esc)"
          aria-label="Back"
          onClick={() => {
            if (onCloseRef.current) {
              onCloseRef.current();
            } else {
              const sheet = document.getElementById('chartSheet');
              const overlay = document.getElementById('chartSheetOverlay');
              if (sheet) sheet.classList.remove('open');
              if (overlay) overlay.classList.remove('active');
              window.history.back();
            }
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary, #8b949e)',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: '6px',
            marginRight: '2px',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text-primary, #ffffff)';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-secondary, #8b949e)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"></line>
            <polyline points="12 19 5 12 12 5"></polyline>
          </svg>
        </button>

        {/* ── Symbol ── */}
        {isSearchActive ? (
          <ChartSearchOverlay
            starredInstruments={starredInstruments}
            toggleStar={toggleStar}
            onClose={() => setIsSearchActive(false)}
            onSelect={(res: any) => {
              // Reset all chart state for new symbol
              setHistoricalCandles([]);
              setCurrentPrice(0);
              setPriceChange(0);
              setPriceChangePct(0);
              setLoading(true);
              setError(null);
              hasLoadedData.current = false;

              // Reset order block
              setChainContract(null);
              setIsOrderBlockVisible(false);
              setIsPanelExpanded(false);
              setIsExitFlow(false);
              setIsAddMoreFlow(false);
              setExitPositionId(null);
              setActiveSegment('orders');

              // Set new symbol/segment matching the watchlist chart routing logic
              const symUpper = (res.symbol || '').toUpperCase();
              const isGlobalForex = isForexSymbol(res.symbol) || isForexSymbol(res.comexSymbol || '') || (res.segment?.toUpperCase() === 'FOREX' && !symUpper.includes('INR') && !symUpper.endsWith('FUT') && !symUpper.startsWith('CDS:'));
              const isChartComex = !isGlobalForex && !!res.comexSymbol && (!(res.kiteSymbol) || res.preferredView === 'comex');

              const newSymbol = isGlobalForex
                ? (res.comexSymbol || res.symbol)
                : isChartComex
                  ? (res.comexSymbol || res.symbol)
                  : (res.binanceSymbol || res.kiteSymbol || res.symbol);

              const isCryptoRes = !isGlobalForex && !isChartComex && (
                !!res.binanceSymbol ||
                ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC'].includes(res.symbol) ||
                (res.segment || '').toUpperCase().includes('CRYPTO')
              );

              const newSegment = isGlobalForex
                ? 'FOREX'
                : isChartComex
                  ? 'COMEX'
                  : isCryptoRes
                    ? 'CRYPTO'
                    : (res.segment || 'NSE');

              const newLoadId = Math.random().toString(36).substring(2, 8);
              const cleanNewSymbol = normalizeComexTicker(newSymbol);
              setLoadId(newLoadId);
              setSymbol(cleanNewSymbol);
              setSegment(newSegment);
              setIsSearchActive(false);
              setOrderBlockTitle(cleanNewSymbol);

              if (typeof window !== 'undefined' && typeof (window as any).__reactSetChartItem === 'function') {
                (window as any).__reactSetChartItem({
                  ...res,
                  symbol: newSymbol,
                  segment: newSegment,
                  kiteSymbol: res.kiteSymbol || newSymbol,
                });
              }
            }}
          />
        ) : (
          <div className="tc-symbol-btn" onClick={() => {
            setIsSearchActive(true);
            setTimeout(() => searchInputRef.current?.focus(), 100);
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span className="tc-symbol-name">
              {formatShortName(symbol.includes(':') ? symbol.split(':')[1] : symbol)}
            </span>
          </div>
        )}

        <div className="tc-divider"></div>

        {/* ── Interval flyout ── */}
        {(() => {
          const intervals: { label: string; tf: Timeframe }[] = [
            { label: '1m', tf: '1m' },
            { label: '2m', tf: '2m' },
            { label: '3m', tf: '3m' },
            { label: '5m', tf: '5m' },
            { label: '10m', tf: '10m' },
            { label: '15m', tf: '15m' },
            { label: '30m', tf: '30m' },
            { label: '1H', tf: '60m' },
            { label: 'D', tf: 'day' },
          ];
          const current = intervals.find(i => i.tf === timeframe) || intervals[1];
          return (
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <div
                className={`tc-tb-btn ${openTopFlyout === 'interval' ? 'tc-tb-btn-open' : ''}`}
                onMouseEnter={() => setOpenTopFlyout('interval')}
                onClick={() => setOpenTopFlyout(openTopFlyout === 'interval' ? null : 'interval')}
                title="Interval"
              >
                <span style={{ fontWeight: 700, fontSize: '13px' }}>{current.label}</span>
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M1 2l3 4 3-4z" /></svg>
              </div>
              
              {/* Native React Countdown - Bypasses TradingView entirely */}
              <CandleCountdown timeframe={timeframe} />

              {openTopFlyout === 'interval' && (
                <div className="tc-top-flyout" style={{ minWidth: '110px' }}>
                  <div className="tc-flyout-title">Interval</div>
                  {intervals.map(i => (
                    <div
                      key={i.tf}
                      className={`tc-flyout-item ${timeframe === i.tf ? 'active' : ''}`}
                      onClick={() => { setTimeframe(i.tf); setOpenTopFlyout(null); }}
                    >
                      <span>{i.label}</span>
                      {timeframe === i.tf && <span className="tc-flyout-check">✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        <div className="tc-divider"></div>

        {/* ── Chart Type flyout ── */}
        {(() => {
          const types: { key: 'candle' | 'area' | 'bar' | 'baseline'; label: string; icon: React.ReactNode }[] = [
            { key: 'candle', label: 'Candles', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="4" width="3" height="6" fill="currentColor" /><line x1="4.5" y1="1" x2="4.5" y2="4" /><line x1="4.5" y1="10" x2="4.5" y2="13" /><rect x="8" y="3" width="3" height="5" fill="none" /><line x1="9.5" y1="1" x2="9.5" y2="3" /><line x1="9.5" y1="8" x2="9.5" y2="13" /></svg> },
            { key: 'bar', label: 'Bars', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="4" y1="2" x2="4" y2="12" /><line x1="1" y1="5" x2="4" y2="5" /><line x1="4" y1="9" x2="7" y2="9" /><line x1="10" y1="3" x2="10" y2="11" /><line x1="7" y1="6" x2="10" y2="6" /><line x1="10" y1="8" x2="13" y2="8" /></svg> },
            { key: 'area', label: 'Area', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1 11 Q4 4 7 6 Q10 8 13 3" /><path d="M1 11 Q4 4 7 6 Q10 8 13 3 V11 Z" fill="currentColor" opacity="0.2" stroke="none" /></svg> },
            { key: 'baseline', label: 'Baseline', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><line x1="1" y1="7" x2="13" y2="7" strokeDasharray="2 1" /><path d="M1 7 Q4 3 7 5 Q10 7 13 4" /><path d="M1 7 Q4 11 7 9 Q10 7 13 10" /></svg> },
          ];
          const cur = types.find(t => t.key === chartType) || types[0];
          return (
            <div style={{ position: 'relative' }}>
              <div
                className={`tc-tb-btn ${openTopFlyout === 'charttype' ? 'tc-tb-btn-open' : ''}`}
                onMouseEnter={() => setOpenTopFlyout('charttype')}
                onClick={() => setOpenTopFlyout(openTopFlyout === 'charttype' ? null : 'charttype')}
                title="Chart Type"
              >
                {cur.icon}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M1 2l3 4 3-4z" /></svg>
              </div>
              {openTopFlyout === 'charttype' && (
                <div className="tc-top-flyout" style={{ minWidth: '140px' }}>
                  <div className="tc-flyout-title">Chart Type</div>
                  {types.map(t => (
                    <div
                      key={t.key}
                      className={`tc-flyout-item ${chartType === t.key ? 'active' : ''}`}
                      onClick={() => {
                        setChartType(t.key);
                        setOpenTopFlyout(null);
                      }}
                    >
                      <span className="tc-flyout-icon">{t.icon}</span>
                      <span>{t.label}</span>
                      {chartType === t.key && <span className="tc-flyout-check">✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        <div className="tc-divider"></div>

        {/* ── Indicators ── */}
        <div
          className="tc-tb-btn tc-tb-indicators"
          title="Indicators"
          onClick={() => document.dispatchEvent(new CustomEvent('tv-show-indicators'))}
        >
          <span style={{ fontSize: '14px', fontWeight: 700, fontStyle: 'italic' }}>Fx</span>
        </div>

        <div className="tc-divider"></div>

        {/* ── Tools ── */}
        <div
          className="tc-tb-btn tc-tb-indicators"
          title="Drawing Tools"
          onClick={() => document.dispatchEvent(new CustomEvent('tv-toggle-drawings'))}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M11 2l-7 7-2 4 4-2 7-7-2-2z" />
          </svg>
        </div>

        {/* ── Compare ── HIDDEN */}
        {/* ── Snapshot ── HIDDEN */}
        
        <div className="tc-divider"></div>

        {/* ── Mobile Rotate Screen (Moved next to tools) ── */}
        <div className="tc-tb-icon mobile-only" title="Toggle Landscape Layout" onClick={() => setIsCssLandscape(!isCssLandscape)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isCssLandscape ? 'rotate(-90deg)' : 'none', transition: 'transform 0.3s ease' }}>
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
            <line x1="12" y1="18" x2="12.01" y2="18"></line>
          </svg>
        </div>

        {/* ── Right side ── */}
        <div className="tc-top-right">

          {/* Settings */}
          <div className="tc-tb-icon" title="Chart Settings" onClick={() => showToast('Settings coming soon')} style={{ display: 'none' }}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7.5" cy="7.5" r="2" />
              <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M3 3l1.4 1.4M10.6 10.6L12 12M12 3l-1.4 1.4M4.4 10.6L3 12" />
            </svg>
          </div>

          {/* Fullscreen */}
          <div className="tc-tb-icon desktop-only" title="Fullscreen" onClick={() => {
            const el = document.getElementById('chartSheet');
            if (el) el.requestFullscreen?.();
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" />
            </svg>
          </div>
        </div>
      </div>

      {/* Content Split Container */}
      <div style={{ display: 'flex', flexDirection: (isLandscape || isCssLandscape) ? 'row' : 'column', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {/* Main Area */}
        <div className="tc-main-area" style={{ flex: 1, minWidth: 0, position: 'relative' }}>


          {/* Chart Container */}
          <div className="tc-chart-container" style={{ position: 'relative', overflow: 'hidden' }}>

            {/* Floating Rotate Screen Button removed and moved to header */}

            {/* Floating Order Panel Toggle */}
            {(isLandscape || isCssLandscape) && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 10,
                  width: '24px',
                  height: '56px',
                  background: 'var(--bg-card, #1E222D)',
                  border: '1px solid var(--border-color, #2B3139)',
                  borderRight: 'none',
                  borderRadius: '6px 0 0 6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '-2px 0 12px rgba(0,0,0,0.2)',
                  color: 'var(--text-secondary, #787B86)',
                  transition: 'all 0.2s ease'
                }}
                onClick={() => setIsPanelExpanded(!isPanelExpanded)}
              >
                <i className={`ti ${isPanelExpanded ? 'ti-chevron-right' : 'ti-chevron-left'}`} style={{ fontSize: '18px' }}></i>
              </div>
            )}

            {/* Loading screen overlay while chart is switching */}
            {loading && (
              <div style={{
                position: 'absolute',
                inset: 0,
                zIndex: 20,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--container-bg, #071824)',
                backdropFilter: 'blur(4px)',
                transition: 'opacity 0.2s ease',
              }}>
                <AnimatedLoader
                  text={`Loading ${formatShortName(symbol.includes(':') ? symbol.split(':')[1] : symbol)} chart...`}
                  fullScreen={false}
                />
              </div>
            )}

            <ChartContainer
              key={`${symbol}-${segment}-${loadId}`}
              loadId={loadId}
              symbol={symbol}
              segment={segment}
              timeframe={timeframe}
              chartType={chartType}
              candles={historicalCandles}
              liveQuote={activeLiveQuote}
              loading={loading}
              error={error}
              onFirstBar={(lastClose, prevClose) => {
                setCurrentPrice(lastClose);
                setLimitPrice(lastClose.toFixed(2));
                if (prevClose !== null) {
                  const change = lastClose - prevClose;
                  setPriceChange(change);
                  setPriceChangePct((change / prevClose) * 100);
                }
                hasLoadedData.current = true;
                setLoading(false);
              }}
            />
          </div>
        </div>

        <div
          style={(isLandscape || isCssLandscape) ? {
            width: isPanelExpanded ? '340px' : '0px',
            display: isPanelExpanded ? 'flex' : 'none',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            borderLeft: '1px solid var(--border-color, #eaecef)',
            background: 'var(--surface, #FFFFFF)',
            zIndex: 10,
            flexShrink: 0,
            height: '100%',
            overflow: 'hidden'
          } : {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            flexShrink: 0,
            overflow: 'hidden',
            zIndex: 10
          }}
        >

          {/* In landscape mode: push content to bottom ONLY if the info panel is collapsed */}
          {(isLandscape || isCssLandscape) && isInfoPanelCollapsed && <div style={{ flex: 1 }} />}

          {/* P&L Card */}
        {!isOrderBlockVisible && (
          <div className="pnl-card" id="pnlCard" style={(isLandscape || isCssLandscape) && !isInfoPanelCollapsed ? { display: 'none' } : {}}>
              {isTradeOnChartActive ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="pnl-toggle-btn" onClick={() => setIsBottomSectionVisible(!isBottomSectionVisible)} style={{ cursor: 'pointer' }}>
                      <i className={`ti ${isBottomSectionVisible ? 'ti-chevron-up' : 'ti-chevron-down'}`}></i>
                    </div>
                    <div>
                      <span className="pnl-text">P/L: </span>
                      <span className={`pnl-amount ${pnlTotal >= 0 ? 'positive' : 'negative'}`}>
                        {pnlTotal >= 0 ? '+' : ''}₹{pnlTotal.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button className="trade-btn sell" onClick={() => {
                      if (!currentInstrumentPosition) {
                        showToast('No active position for SL', true);
                        return;
                      }
                      if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                      else setIsPanelExpanded(false);
                      setIsExitFlow(true);
                      setIsAddMoreFlow(false);
                      setExitPositionId(currentInstrumentPosition.id);
                      setOrderSide(currentInstrumentPosition.side === 'BUY' ? 'SELL' : 'BUY');
                      setQtyValue(currentInstrumentPosition.qty_open);
                      setUseLots(false);
                      setOrderType('sl');
                      setPostOrderSegment('main');
                      setOrderBlockTitle(`SL Exit · ${currentInstrumentPosition.symbol}`);
                      setIsOrderBlockVisible(true);
                    }} style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'transparent', border: '1.5px solid var(--red, #e53935)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                      <span className="btn-label" style={{ color: 'var(--red, #e53935)', fontSize: '11px', fontWeight: 600 }}>SL</span>
                    </button>
                    <button className="trade-btn buy" onClick={() => {
                      if (!currentInstrumentPosition) {
                        showToast('No active position for TP', true);
                        return;
                      }
                      if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                      else setIsPanelExpanded(false);
                      setIsExitFlow(true);
                      setIsAddMoreFlow(false);
                      setExitPositionId(currentInstrumentPosition.id);
                      setOrderSide(currentInstrumentPosition.side === 'BUY' ? 'SELL' : 'BUY');
                      setQtyValue(currentInstrumentPosition.qty_open);
                      setUseLots(false);
                      setOrderType('limit');
                      setPostOrderSegment('main');
                      setOrderBlockTitle(`TP Exit · ${currentInstrumentPosition.symbol}`);
                      setIsOrderBlockVisible(true);
                    }} style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'transparent', border: '1.5px solid var(--green, #1db954)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                      <span className="btn-label" style={{ color: 'var(--green, #1db954)', fontSize: '11px', fontWeight: 600 }}>TP</span>
                    </button>
                    <div className="pnl-toggle-btn" onClick={() => { setIsTradeOnChartActive(false); localStorage.setItem('isTradeOnChartActive', 'false'); }} style={{ background: 'var(--pill-bg, #1a2432)', color: 'var(--text-primary)', cursor: 'pointer', marginLeft: '4px' }}>
                      <i className="ti ti-x"></i>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span className="pnl-text">P/L: </span>
                    <span className={`pnl-amount ${pnlTotal >= 0 ? 'positive' : 'negative'}`}>
                      {pnlTotal >= 0 ? '+' : ''}₹{pnlTotal.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                      title="Scalp"
                      onClick={() => {
                        const nextState = !isTradeOnChartActive;
                        setIsTradeOnChartActive(nextState);
                        localStorage.setItem('isTradeOnChartActive', nextState.toString());
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '4px 14px',
                        borderRadius: '4px',
                        background: isTradeOnChartActive ? 'var(--green-bg, #e8f5e9)' : 'transparent',
                        color: 'var(--green, #1db954)',
                        cursor: 'pointer',
                        border: '1px solid var(--green, #1db954)',
                      }}
                    >
                      <span style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap' }}>Scalp</span>
                    </div>
                    <div className="pnl-toggle-btn" onClick={() => setIsBottomSectionVisible(!isBottomSectionVisible)} style={{ cursor: 'pointer' }}>
                      <i className={`ti ${isBottomSectionVisible ? 'ti-chevron-up' : 'ti-chevron-down'}`}></i>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Bottom Section */}
          <div
            className={`bottom-section ${(!isBottomSectionVisible && !(isLandscape || isCssLandscape)) ? 'collapsed' : ''}`}
            id="bottomSection"
            style={(isLandscape || isCssLandscape) ? { display: 'flex', flexDirection: 'column', flex: !isInfoPanelCollapsed ? 1 : undefined, minHeight: !isInfoPanelCollapsed ? 0 : undefined } : {}}
          >
            {/* Trade Buttons — show Exit when position exists for current symbol, else Buy/Sell */}
            {!isUnderlyingIndex && !isOrderBlockVisible && (
              currentInstrumentPosition ? (
                <div className="trade-buttons" id="tradeButtons" style={(isLandscape || isCssLandscape) && !isInfoPanelCollapsed ? { display: 'none' } : {}}>
                  {currentInstrumentPosition.side === 'BUY' ? (
                    <>
                      <button 
                        className={`trade-btn exit-position-chart-btn${(isSubmitting || exitingPosIds.current.size > 0) && !exitingPosIds.current.has(currentInstrumentPosition.id) ? ' submitting-inactive' : ''}`} 
                        onClick={() => handleExitPosition(currentInstrumentPosition)}
                        disabled={isSubmitting || exitingPosIds.current.size > 0}
                        style={{ opacity: ((isSubmitting || exitingPosIds.current.size > 0) && !exitingPosIds.current.has(currentInstrumentPosition.id)) ? 0.5 : 1, pointerEvents: 'auto' }}
                      >
                        <span className="btn-label">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
                            <path d="M10 1l3 3-3 3" /><path d="M13 4H5" /><path d="M7 13H2a1 1 0 01-1-1V2a1 1 0 011-1h5" />
                          </svg>
                          {exitingPosIds.current.has(currentInstrumentPosition.id) ? 'EXITING...' : 'EXIT LONG'}
                        </span>
                      </button>
                      <button id="buyButton" className={`trade-btn buy${(isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'BUY') ? ' submitting-inactive' : ''}`} disabled={isSubmitting || exitingPosIds.current.size > 0} style={{ opacity: ((isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'BUY')) ? 0.5 : 1 }} onClick={() => {
                        if (isTradeOnChartActive) {
                          handleQuickMarketOrder('BUY');
                        } else {
                          if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                          else setIsPanelExpanded(false);
                          setIsExitFlow(false);
                          setIsAddMoreFlow(false);
                          setExitPositionId(null);
                          setOrderBlockTitle(symbol);
                          setPostOrderSegment('main');
                          setIsOrderBlockVisible(true);
                          setOrderSide('BUY');
                        }
                      }}>
                        <span className="btn-label">
                          {isSubmitting && !addingPosId && orderSide === 'BUY' && <AnimatedLoader size="small" />}
                          BUY
                        </span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button id="sellButton" className={`trade-btn sell${(isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'SELL') ? ' submitting-inactive' : ''}`} disabled={isSubmitting || exitingPosIds.current.size > 0} style={{ opacity: ((isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'SELL')) ? 0.5 : 1 }} onClick={() => {
                        if (isTradeOnChartActive) {
                          handleQuickMarketOrder('SELL');
                        } else {
                          if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                          else setIsPanelExpanded(false);
                          setIsExitFlow(false);
                          setIsAddMoreFlow(false);
                          setExitPositionId(null);
                          setOrderBlockTitle(symbol);
                          setPostOrderSegment('main');
                          setIsOrderBlockVisible(true);
                          setOrderSide('SELL');
                        }
                      }}>
                        <span className="btn-label">
                          {isSubmitting && !addingPosId && orderSide === 'SELL' && <AnimatedLoader size="small" />}
                          SELL
                        </span>
                      </button>
                      <button 
                        className={`trade-btn exit-position-chart-btn${(isSubmitting || exitingPosIds.current.size > 0) && !exitingPosIds.current.has(currentInstrumentPosition.id) ? ' submitting-inactive' : ''}`} 
                        onClick={() => handleExitPosition(currentInstrumentPosition)}
                        disabled={isSubmitting || exitingPosIds.current.size > 0}
                        style={{ opacity: ((isSubmitting || exitingPosIds.current.size > 0) && !exitingPosIds.current.has(currentInstrumentPosition.id)) ? 0.5 : 1, pointerEvents: 'auto' }}
                      >
                        <span className="btn-label">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
                            <path d="M10 1l3 3-3 3" /><path d="M13 4H5" /><path d="M7 13H2a1 1 0 01-1-1V2a1 1 0 011-1h5" />
                          </svg>
                          {exitingPosIds.current.has(currentInstrumentPosition.id) ? 'EXITING...' : 'EXIT SHORT'}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="trade-buttons" id="tradeButtons" style={(isLandscape || isCssLandscape) && !isInfoPanelCollapsed ? { display: 'none' } : {}}>
                  <button id="sellButton" className={`trade-btn sell${(isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'SELL') ? ' submitting-inactive' : ''}`} disabled={isSubmitting || exitingPosIds.current.size > 0} style={{ opacity: ((isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'SELL')) ? 0.5 : 1 }} onClick={() => {
                    if (isTradeOnChartActive) {
                      handleQuickMarketOrder('SELL');
                    } else {
                      if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                      else setIsPanelExpanded(false);
                      setIsExitFlow(false);
                      setIsAddMoreFlow(false);
                      setExitPositionId(null);
                      setOrderBlockTitle(symbol);
                      setPostOrderSegment('main');
                      setIsOrderBlockVisible(true);
                      setOrderSide('SELL');
                    }
                  }}>
                    <span className="btn-label">
                      {isSubmitting && !addingPosId && orderSide === 'SELL' && <AnimatedLoader size="small" />}
                      SELL
                    </span>
                  </button>
                  <button id="buyButton" className={`trade-btn buy${(isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'BUY') ? ' submitting-inactive' : ''}`} disabled={isSubmitting || exitingPosIds.current.size > 0} style={{ opacity: ((isSubmitting || exitingPosIds.current.size > 0) && !(isSubmitting && !addingPosId && orderSide === 'BUY')) ? 0.5 : 1 }} onClick={() => {
                    if (isTradeOnChartActive) {
                      handleQuickMarketOrder('BUY');
                    } else {
                      if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                      else setIsPanelExpanded(false);
                      setIsExitFlow(false);
                      setIsAddMoreFlow(false);
                      setExitPositionId(null);
                      setOrderBlockTitle(symbol);
                      setPostOrderSegment('main');
                      setIsOrderBlockVisible(true);
                      setOrderSide('BUY');
                    }
                  }}>
                    <span className="btn-label">
                      {isSubmitting && !addingPosId && orderSide === 'BUY' && <AnimatedLoader size="small" />}
                      BUY
                    </span>
                  </button>
                </div>
              )
            )}

            {/* Order Block */}
            {isOrderBlockVisible && (
              <div className="order-block visible" id="orderBlock">
                <div className="order-block-header">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                    <span className="order-block-title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {(chainContract ? chainContract.name : orderBlockTitle).replace(/NFO[:\s]?/gi, '').trim()}
                    </span>
                    <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginTop: '2px' }}>
                      <span style={{
                        color: orderSide === 'BUY' ? '#1db954' : '#e53935',
                        background: 'transparent',
                        padding: '0',
                        fontWeight: '600',
                        fontSize: '11px'
                      }}>
                        {orderSide === 'BUY' ? 'Ask' : 'Bid'}: ₹{Number(orderSide === 'BUY' ? liveAsk : liveBid).toFixed(2)}
                      </span>
                      <span style={{ color: '#8b949e', fontSize: '11px', fontWeight: '500' }}>
                        LTP: <span style={{ color: 'var(--text-primary)', fontWeight: '700' }}>₹{Number(liveLTP).toFixed(2)}</span>
                      </span>
                      {chainContract && chainContract.expiry && (
                        <span style={{ background: '#F0F2F5', color: '#8B92A8', padding: '1px 5px', borderRadius: '4px', fontSize: '10px', whiteSpace: 'nowrap' }}>
                          {chainContract.expiry}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <div
                      style={{ marginRight: '8px', cursor: 'pointer', background: 'var(--pill-bg, #1a2432)', width: '26px', height: '26px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--green, #1db954)', border: '1.2px solid var(--green, #1db954)' }}
                      onClick={() => {
                        const targetSymbol = chainContract ? chainContract.name : orderBlockTitle.replace(/Add More · |Exit · |Modify · /g, '').trim();
                        
                        // For exit/add-more flows on options and futures, ensure kite instrument has prefix
                        // Use the stored addMoreKiteInst if available, else derive from orderBlockTitle/chain
                        const baseKiteInst = (isAddMoreFlow || isExitFlow) && addMoreKiteInst 
                          ? addMoreKiteInst 
                          : (chainContract ? chainContract.name : ((isAddMoreFlow || isExitFlow || modifyOrderId) ? targetSymbol : symbol));
                          
                        let kiteInstForOrder = baseKiteInst;
                        
                        // Helper to detect if it's MCX
                        const isMcx = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => (chainContract?.name || targetSymbol).includes(c));
                        
                        if (['OPTIDX', 'FUTIDX', 'OPTSTK', 'FUTSTK', 'OPTCOM', 'FUTCOM', 'OPTCUR', 'FUTCUR'].includes(dbSeg)) {
                          kiteInstForOrder = isMcx ? `MCX:${baseKiteInst}` : `NFO:${baseKiteInst}`;
                        }
                        setSymbol(targetSymbol);
                        // Derive the correct display segment so mapSegmentToDbSegment works
                        if (chainContract) {
                          const n = chainContract.name.toUpperCase();
                          const isBse = n.includes('SENSEX') || n.includes('BANKEX');
                          if (isMcx) {
                            setSegment('MCX - Options');
                          } else if (isBse) {
                            setSegment('BSE - Options');
                          } else {
                            setSegment('NSE - Options');
                          }
                        } else if (targetSymbol.includes('CE') || targetSymbol.includes('PE')) {
                          setSegment('NSE - Options');
                        }
                        setIsPanelExpanded(false);
                        setIsOrderBlockVisible(false);
                        setChainContract(null);
                      }}
                      title="Open Chart"
                    >
                      <svg viewBox="0 0 24 24" style={{ width: '16px', height: '16px', display: 'block' }}>
                        <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                        <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                        <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                        <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />
                        <path d="M 4 14 L 8 9 L 13 12 L 20 4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                        <polyline points="15 4 20 4 20 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>

                    <div className="close-order-block" onClick={() => {
                      setIsOrderBlockVisible(false);
                      setChainContract(null);
                      if (isExitFlow || isAddMoreFlow) {
                        setIsPanelExpanded(true);
                        // Reset qty to 1 lot so stale exit-qty doesn't carry over
                        // into the next scalp buy/sell tap
                        setQtyValue(1);
                        setUseLots(true);
                      }
                      setIsExitFlow(false);
                      setIsAddMoreFlow(false);
                      setExitPositionId(null);
                      setOrderBlockTitle(symbol);
                    }}>
                      <i className="ti ti-x"></i>
                    </div>
                  </div>
                </div>
                <div className="order-block-content">
                  {chainContract && (
                    <div id="chainBSToggle" style={{ display: 'flex', gap: '6px', padding: '0 0 8px' }}>
                      <button
                        onClick={() => {
                          setOrderSide('SELL');
                          const bid = chainContract.bid;
                          setLimitPrice(bid.toFixed(2));
                          setTriggerPrice(bid.toFixed(2));
                        }}
                        style={{
                          flex: 1, padding: '8px', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', transition: 'all .2s', fontFamily: 'Inter,sans-serif', letterSpacing: '0.4px',
                          background: orderSide === 'SELL' ? '#e53935' : '#F0F2F5', color: orderSide === 'SELL' ? '#fff' : '#8B92A8'
                        }}
                      >
                        SELL
                      </button>
                      <button
                        onClick={() => {
                          setOrderSide('BUY');
                          const ask = chainContract.ask;
                          setLimitPrice(ask.toFixed(2));
                          setTriggerPrice(ask.toFixed(2));
                        }}
                        style={{
                          flex: 1, padding: '8px', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', transition: 'all .2s', fontFamily: 'Inter,sans-serif', letterSpacing: '0.4px',
                          background: orderSide === 'BUY' ? '#1db954' : '#F0F2F5', color: orderSide === 'BUY' ? '#fff' : '#8B92A8'
                        }}
                      >
                        BUY
                      </button>
                    </div>
                  )}

                  {/* chainContractDetail moved to header */}

                  <div className="top-row">
                    <div className="quantity-box">
                      <div className="qty-controls">
                        <button className="qty-btn" onClick={() => handleQtyStep(-1)}>−</button>
                        <input
                          type="number"
                          className="qty-value"
                          value={qtyValue}
                          step={useLots ? 0.5 : lotSize}
                          min={useLots ? 0.5 : lotSize}
                          onChange={(e) => {
                            setQtyValue(e.target.value);
                          }}
                          onBlur={() => {
                            const val = parseFloat(String(qtyValue));
                            if (useLots) {
                              setQtyValue(isNaN(val) || val <= 0 ? 0.5 : val);
                            } else {
                              const minVal = isCrypto ? 0.01 : lotSize;
                              setQtyValue(isNaN(val) || val <= 0 ? minVal : val);
                            }
                          }}
                        />
                        <button className="qty-btn" onClick={() => handleQtyStep(1)}>+</button>
                      </div>
                      <div className="unit-toggle" id="unitSwitch">
                        <div className={`unit-btn ${!useLots ? 'active' : ''}`} onClick={() => handleUnitChange(false)}>Qty</div>
                        <div className={`unit-btn ${useLots ? 'active' : ''}`} onClick={() => handleUnitChange(true)}>Lot</div>
                      </div>
                    </div>
                    <div className="carry-box" id="carryGroup">
                      <div className={`carry-option ${orderCarry === 'normal' ? 'active' : ''}`} onClick={() => setOrderCarry('normal')}>Intraday</div>
                      <div className={`carry-option ${orderCarry === 'carry' ? 'active' : ''}`} onClick={() => setOrderCarry('carry')}>Carry</div>
                    </div>
                  </div>

                  <div className="bottom-row">
                    <div className="market-limit-box" id="orderTypeGroup" style={{ flex: 6 }}>
                      <div className={`market-option ${orderType === 'market' ? 'active' : ''}`} onClick={() => setOrderType('market')}>Mkt</div>
                      <div className={`market-option ${orderType === 'limit' ? 'active' : ''}`} onClick={() => setOrderType('limit')}>{isExitFlow ? 'Tgt' : 'Lmt'}</div>
                      {!isExitFlow && <div className={`market-option ${orderType === 'slm' ? 'active' : ''}`} onClick={() => setOrderType('slm')}>SLM</div>}
                      {isExitFlow && <div className={`market-option ${orderType === 'sl' ? 'active' : ''}`} onClick={() => setOrderType('sl')}>SL</div>}
                      <div className={`market-option ${orderType === 'gtt' ? 'active' : ''}`} onClick={() => setOrderType('gtt')}>GTT</div>
                    </div>
                    {(orderType === 'limit' || (orderType === 'gtt' && !isExitFlow)) && (
                      <div className="limit-price-box visible" id="limitPriceBox" style={{ flex: 4 }}>
                        <span className="price-symbol">₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={limitPrice}
                          onChange={(e) => setLimitPrice(e.target.value)}
                          placeholder="price"
                        />
                      </div>
                    )}
                    {(orderType === 'sl' || orderType === 'slm') && (
                      <div className="limit-price-box visible" id="triggerPriceBox" style={{ flex: 4 }}>
                        <span className="price-symbol" style={{ fontSize: '9px', color: '#8B92A8', fontWeight: 'bold', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>Trigger ₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={triggerPrice}
                          onChange={(e) => setTriggerPrice(e.target.value)}
                          placeholder="trigger"
                        />
                      </div>
                    )}
                  </div>

                  {orderType === 'gtt' && (
                    <div className="gtt-row visible">
                      <div className="gtt-field sl-field">
                        <span className="gtt-tag">SL ₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={gttSlPrice}
                          onChange={(e) => setGttSlPrice(e.target.value)}
                          placeholder="Optional"
                        />
                      </div>
                      <div className="gtt-field tgt-field">
                        <span className="gtt-tag">Target ₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={gttTargetPrice}
                          onChange={(e) => setGttTargetPrice(e.target.value)}
                          placeholder="Optional"
                        />
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '0 4px', marginBottom: '8px' }}>
                    <span style={{ color: '#8b949e', fontWeight: 500 }}>Free Margin: <span style={{ color: 'var(--text-primary, #000)', fontWeight: 800 }}>₹{balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span></span>
                    <span style={{ color: '#8b949e', fontWeight: 500 }}>Required Margin: <span className={`${reqMargin > balance ? 'negative' : ''}`} style={{ color: 'var(--text-primary, #000)', fontWeight: 800 }}>₹{reqMargin.toLocaleString('en-IN')}</span></span>
                  </div>
                  <div className="order-margin-simple" style={{ flexDirection: 'column', gap: '0', alignItems: 'stretch', background: 'var(--pill-bg, rgba(139, 148, 158, 0.1))', border: 'none', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' }}>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        width: '100%',
                        boxSizing: 'border-box'
                      }}
                    >
                      <div
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
                        onClick={() => setShowCharges(!showCharges)}
                      >
                        <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>
                          Charges Breakdown {showCharges ? '▲' : '▼'}
                        </span>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--green)' }}>
                          ₹{totalBrokerage.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      {showCharges && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '2px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px' }}>
                            <span style={{ color: 'var(--text-muted)' }}>Intraday Brokerage</span>
                            <span style={{ color: 'var(--green)', fontWeight: 700 }}>
                              ₹{intradayCharge.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px' }}>
                            <span style={{ color: 'var(--text-muted)' }}>Carry Charges</span>
                            <span style={{ color: activeCarryCharge > 0 ? 'var(--green)' : 'var(--text-muted)', fontWeight: 700 }}>
                              ₹{activeCarryCharge.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px' }}>
                            <span style={{ color: 'var(--text-muted)' }}>GTT Charges</span>
                            <span style={{ color: activeGttCharge > 0 ? 'var(--green)' : 'var(--text-muted)', fontWeight: 700 }}>
                              ₹{activeGttCharge.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <button 
                    className={`submit-btn ${orderSide === 'BUY' ? 'submit-buy' : 'submit-sell'}`} 
                    disabled={isSubmitting} 
                    onClick={handlePlaceOrder}
                  >
                      {isSubmitting ? <AnimatedLoader size="small" /> : (modifyOrderId ? 'Update Order' : (isExitFlow ? 'Exit Position' : `${orderSide} ${useLots ? (Number(qtyValue) || 1) + ' Lot' : qtyValue + ' Qty'}`))}
                  </button>
                </div>
              </div>
            )}

            {/* Segment Row */}
            <div className="segment-row">
              <div className="segment-pills">
                <button className={`segment-pill ${activeSegment === 'chain' ? 'active' : ''}`} onClick={() => {
                  if (activeSegment === 'chain') {
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                    else if (isPanelExpanded) setIsPanelExpanded(false);
                  } else {
                    setActiveSegment('chain');
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(false);
                    else setIsPanelExpanded(true);
                    setIsOrderBlockVisible(false);
                  }
                }}>
                  <i className="ti ti-stack-2"></i>Chain
                </button>
                <button className={`segment-pill ${activeSegment === 'orders' ? 'active' : ''}`} onClick={() => {
                  if (activeSegment === 'orders') {
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                    else if (isPanelExpanded) setIsPanelExpanded(false);
                  } else {
                    setActiveSegment('orders');
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(false);
                    else setIsPanelExpanded(true);
                    setIsOrderBlockVisible(false);
                  }
                }}>
                  <i className="ti ti-list-check"></i>Orders
                </button>
                <button className={`segment-pill ${activeSegment === 'positions' ? 'active' : ''}`} onClick={() => {
                  if (activeSegment === 'positions') {
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                    else if (isPanelExpanded) setIsPanelExpanded(false);
                  } else {
                    setActiveSegment('positions');
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(false);
                    else setIsPanelExpanded(true);
                    setIsOrderBlockVisible(false);
                  }
                }}>
                  <i className="ti ti-briefcase"></i>Positions
                </button>
              </div>
              <div className="toggle-panel-btn" onClick={() => {
                if (isLandscape || isCssLandscape) {
                  setIsInfoPanelCollapsed(!isInfoPanelCollapsed);
                } else {
                  setIsPanelExpanded(!isPanelExpanded);
                  if (!isPanelExpanded) setIsOrderBlockVisible(false);
                }
              }}>
                <i className={`ti ${((isLandscape || isCssLandscape) ? !isInfoPanelCollapsed : isPanelExpanded) ? 'ti-chevron-up' : 'ti-chevron-down'}`}></i>
              </div>
            </div>

            <div
              className={`info-panel ${(!isPanelExpanded && !(isLandscape || isCssLandscape)) ? 'collapsed' : ''}`}
              id="infoPanel"
              style={(isLandscape || isCssLandscape) ? { display: isInfoPanelCollapsed ? 'none' : 'flex', flexDirection: 'column', width: '100%', flex: 1, minHeight: 0 } : {}}
            >
              <div
                className={`panel-content ${activeSegment === 'chain' ? 'chain-mode' : ''}`}
                style={(isLandscape || isCssLandscape) ? { flex: 1, minHeight: 0, maxHeight: 'none' } : {}}
              >
                {renderPanelContent()}
              </div>
            </div>
          </div>
        </div>
        {/* End of Right / Bottom Panel Area */}
      </div>
      {/* End of Content Split Container */}
      {toast.visible && (
        <div
          className={`toast-message toast-show ${toast.isError ? 'neg' : ''}`}
          onClick={() => {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
            setToast({ visible: false, msg: '' });
          }}
          style={{ cursor: 'pointer' }}
          title="Tap to dismiss"
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default React.memo(TradingChartComponent, (prevProps, nextProps) => {
  return (
    prevProps.symbol === nextProps.symbol &&
    prevProps.segment === nextProps.segment
  );
});


