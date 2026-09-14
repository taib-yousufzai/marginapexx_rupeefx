'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ErrorModal } from '@/components/ErrorModal';
import { useAuth } from '@/hooks/useAuth';
import { getSession } from '@/lib/auth';
import { api } from '@/lib/api';
import AnimatedLoader from '@/components/AnimatedLoader';
import './page.css';

interface WatchlistItem {
  name: string;
  symbol: string;
  kiteSymbol: string;
  binanceSymbol?: string;
  price: number;
  change: string;
  segment: string;
}

interface ScannerResult {
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  last_price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  gap: number;
  gapPercent: number;
  updated_at: string;
}

const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { name: 'NIFTY 50 INDEX', symbol: 'NIFTY_INDEX', kiteSymbol: 'NSE:NIFTY 50', price: 0, change: '0%', segment: 'NSE - Futures' },
  { name: 'BANKNIFTY INDEX', symbol: 'BANKNIFTY_INDEX', kiteSymbol: 'NSE:NIFTY BANK', price: 0, change: '0%', segment: 'NSE - Futures' },
  { name: 'USD/INR', symbol: 'USDINR_FUT', kiteSymbol: 'CDS:USDINR26JULFUT', price: 0, change: '0%', segment: 'CDS - Futures' },
  { name: 'Gold', symbol: 'GOLD_FUT', kiteSymbol: 'MCX:GOLD26OCTFUT', price: 0, change: '0%', segment: 'MCX - Futures' },
  { name: 'Bitcoin', symbol: 'BTC', kiteSymbol: '', binanceSymbol: 'BTCUSDT', price: 0, change: '0%', segment: 'CRYPTO' },
  { name: 'Ethereum', symbol: 'ETH', kiteSymbol: '', binanceSymbol: 'ETHUSDT', price: 0, change: '0%', segment: 'CRYPTO' }
];

const WATCHLIST_KEY_PREFIX = 'marginApex_watchlist';

export default function LearningPage() {
  const router = useRouter();
  const params = useParams();
  const action = params.action as string;

  const [user, setUser] = useState<any>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  // Background auth check/redirect helper
  useAuth();

  useEffect(() => {
    getSession().then((session) => {
      if (session) {
        setUser(session.user);
      }
      setAuthLoading(false);
    });
  }, []);

  // Watchlist states (only to add scanner results to it in localStorage)
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);

  // Scanner filter states
  const [scanSegment, setScanSegment] = useState<string>('NSE');
  const [scanMomentum, setScanMomentum] = useState<string>('top_gainers');
  const [minPriceFilter, setMinPriceFilter] = useState<string>('');
  const [maxPriceFilter, setMaxPriceFilter] = useState<string>('');
  const [minVolFilter, setMinVolFilter] = useState<string>('');
  const [scannerResults, setScannerResults] = useState<ScannerResult[]>([]);
  const [scanningLoading, setScanningLoading] = useState(false);

  // --- Redirect if unauthenticated ---
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login');
    }
  }, [user, authLoading, router]);

  // --- Load Watchlist on auth complete ---
  useEffect(() => {
    if (!user) return;

    const key = `${WATCHLIST_KEY_PREFIX}_${user.id}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        setWatchlist(JSON.parse(saved));
      } catch {
        setWatchlist(DEFAULT_WATCHLIST);
      }
    } else {
      setWatchlist(DEFAULT_WATCHLIST);
      localStorage.setItem(key, JSON.stringify(DEFAULT_WATCHLIST));
    }
  }, [user]);

  // Save watchlist helper
  const saveWatchlist = (items: WatchlistItem[]) => {
    if (!user) return;
    setWatchlist(items);
    localStorage.setItem(`${WATCHLIST_KEY_PREFIX}_${user.id}`, JSON.stringify(items));
  };

  // --- Run Market Scanner ---
  const handleRunScanner = async () => {
    setScanningLoading(true);
    try {
      const params = new URLSearchParams({
        segment: scanSegment,
        momentum: scanMomentum,
        limit: '30'
      });

      if (minPriceFilter) params.append('minPrice', minPriceFilter);
      if (maxPriceFilter) params.append('maxPrice', maxPriceFilter);
      if (minVolFilter) params.append('minVolume', minVolFilter);

      const data = await api.get<ScannerResult[]>(`/api/market/scanner?${params.toString()}`);
      setScannerResults(data || []);
    } catch (err) {
      console.error('Scanner run failed:', err);
    } finally {
      setScanningLoading(false);
    }
  };

  // Run initial scan on load for AI page
  useEffect(() => {
    if (user && action === 'ai') {
      handleRunScanner();
    }
  }, [user, action, scanSegment, scanMomentum]);

  const handleDoubleclickScannerResult = (result: ScannerResult) => {
    const isCrypto = result.segment.toUpperCase() === 'CRYPTO';
    const kiteSymbol = isCrypto ? '' : `${result.exchange}:${result.symbol}`;
    const binanceSymbol = isCrypto ? result.symbol : '';

    const watchItem: WatchlistItem = {
      name: result.name,
      symbol: result.symbol,
      kiteSymbol,
      binanceSymbol,
      price: result.last_price,
      change: `${result.changePercent >= 0 ? '+' : ''}${result.changePercent}%`,
      segment: result.segment
    };

    const alreadyExists = watchlist.some(
      item => (isCrypto && item.binanceSymbol === binanceSymbol) || (!isCrypto && item.kiteSymbol === kiteSymbol)
    );

    if (!alreadyExists) {
      saveWatchlist([...watchlist, watchItem]);
      setModalError(`${result.symbol} added to watchlist!`);
    } else {
      setModalError(`${result.symbol} is already in watchlist!`);
    }
  };

  const getDetails = (act: string) => {
    switch (act) {
      case 'algo': return { title: 'Algorithmic Trading', icon: 'fas fa-robot', desc: 'Automate your trading strategies with our powerful algo engine.' };
      case 'ai': return { title: 'Scanner (Beta)', icon: 'fas fa-search-dollar', desc: 'Real-time market scanner powered by breakout indicators and momentum tracking.' };
      case 'indicator': return { title: 'Pro Indicators', icon: 'fas fa-chart-simple', desc: 'Unlock advanced technical indicators for your charts.' };
      case 'course': return { title: 'Masterclass Course', icon: 'fas fa-video', desc: 'Comprehensive video tutorials from market experts.' };
      case 'classes': return { title: 'Live Classes', icon: 'fas fa-chalkboard-user', desc: 'Join our weekly live trading sessions and Q&A.' };
      case 'books': return { title: 'Trading Library', icon: 'fas fa-book', desc: 'Download free e-books and research papers.' };
      default: return { title: 'Learning Hub', icon: 'fas fa-graduation-cap', desc: 'Expand your trading knowledge.' };
    }
  };

  if (authLoading) {
    return (
      <div className="empty-panel-state" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AnimatedLoader />
        <span>Authenticating session...</span>
      </div>
    );
  }

  const details = getDetails(action);

  return (
    <div className="desktop-layout">
      
      <main className="main-viewport">
        <div className="app-container">
          <div className="main-scroll-wrapper" style={{ paddingBottom: 'calc(var(--footer-nav-height, 65px) + env(safe-area-inset-bottom, 0px) + 24px)' }}>
            <div className="main-content">
              {action === 'ai' ? (
                <div className="full-scanner-workspace">
                  <div className="scanner-section-header">
                    <h2>Scanner (Beta)</h2>
                    <p className="scanner-subtitle">Real-time market scanner powered by breakout indicators and momentum tracking</p>
                  </div>

                  <div className="scanner-workspace-content">
                    <div className="scanner-filters-container">
                      <div className="filter-group">
                        <label className="filter-label">Segment</label>
                        <select
                          className="filter-select"
                          value={scanSegment}
                          onChange={(e) => setScanSegment(e.target.value)}
                        >
                          <option value="NSE">NSE Equity</option>
                          <option value="NFO">NFO Options</option>
                          <option value="MCX">MCX Commodity</option>
                          <option value="CRYPTO">Binance Crypto</option>
                          <option value="CDS">CDS Currency</option>
                        </select>
                      </div>

                      <div className="filter-group">
                        <label className="filter-label">Momentum</label>
                        <select
                          className="filter-select"
                          value={scanMomentum}
                          onChange={(e) => setScanMomentum(e.target.value)}
                        >
                          <option value="top_gainers">Top Gainers</option>
                          <option value="top_losers">Top Losers</option>
                          <option value="high_volume">Volume Leaders</option>
                          <option value="breakout_high">Breakout High</option>
                          <option value="breakout_low">Breakout Low</option>
                          <option value="gappers_up">Gappers Up</option>
                          <option value="gappers_down">Gappers Down</option>
                        </select>
                      </div>

                      <div className="filter-group">
                        <label className="filter-label">Min Price (₹)</label>
                        <input
                          type="number"
                          className="filter-input"
                          placeholder="Min"
                          value={minPriceFilter}
                          onChange={(e) => setMinPriceFilter(e.target.value)}
                        />
                      </div>

                      <div className="filter-group">
                        <label className="filter-label">Max Price (₹)</label>
                        <input
                          type="number"
                          className="filter-input"
                          placeholder="Max"
                          value={maxPriceFilter}
                          onChange={(e) => setMaxPriceFilter(e.target.value)}
                        />
                      </div>

                      <div className="filter-group button-group">
                        <button
                          className="scan-submit-btn"
                          onClick={handleRunScanner}
                          disabled={scanningLoading}
                        >
                          {scanningLoading ? (
                            <>
                              <AnimatedLoader size="small" />
                              <span>Scanning...</span>
                            </>
                          ) : (
                            <>
                              <i className="fas fa-search"></i>
                              <span>Run Scan</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="scanner-results-container">
                      {scannerResults.length === 0 ? (
                        <div className="empty-panel-state">
                          <i className="fas fa-radar fa-pulse"></i>
                          <span>No scanner matches. Adjust filters or run scan.</span>
                        </div>
                      ) : (
                        <div className="scanner-table-wrapper">
                          <table className="scanner-table-compact">
                            <thead>
                              <tr>
                                <th>Symbol</th>
                                <th>Name</th>
                                <th>Segment</th>
                                <th style={{ textAlign: 'right' }}>Last Price</th>
                                <th style={{ textAlign: 'right' }}>Change</th>
                                <th style={{ textAlign: 'right' }}>Volume</th>
                                <th style={{ textAlign: 'right' }}>Gap %</th>
                              </tr>
                            </thead>
                            <tbody>
                              {scannerResults.map((result, idx) => (
                                <tr
                                  key={idx}
                                  onDoubleClick={() => handleDoubleclickScannerResult(result)}
                                  title="Double-click to add to watchlist"
                                >
                                  <td className="scanner-symbol-cell">{result.symbol}</td>
                                  <td>{result.name}</td>
                                  <td><span className="scanner-seg-pill">{result.segment}</span></td>
                                  <td className="scanner-price-cell">
                                    ₹{result.last_price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className={`scanner-pct-cell ${result.changePercent >= 0 ? 'positive' : 'negative'}`}>
                                    {result.changePercent >= 0 ? '+' : ''}
                                    {result.changePercent.toFixed(2)}%
                                  </td>
                                  <td style={{ textAlign: 'right' }}>{result.volume.toLocaleString('en-IN')}</td>
                                  <td className={`scanner-pct-cell ${result.gapPercent >= 0 ? 'positive' : 'negative'}`} style={{ textAlign: 'right' }}>
                                    {result.gapPercent >= 0 ? '+' : ''}
                                    {result.gapPercent.toFixed(2)}%
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '30px' }}>
                    <button 
                      onClick={() => router.back()} 
                      style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', marginRight: '15px', color: 'var(--text-primary)' }}
                    >
                      <i className="fas fa-arrow-left"></i>
                    </button>
                    <h1 style={{ margin: 0, color: 'var(--text-primary)' }}>{details.title}</h1>
                  </div>
                  
                  <div style={{ padding: '40px', background: 'var(--card-bg, #fff)', borderRadius: '16px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', textAlign: 'center', border: '1px solid var(--border-light)' }}>
                    <i className={details.icon} style={{ fontSize: '4rem', color: '#1475e1', marginBottom: '20px' }}></i>
                    <h2 style={{ margin: '0 0 15px 0', color: 'var(--text-primary)' }}>{details.title}</h2>
                    <p style={{ color: 'var(--text-secondary, #666)', fontSize: '1.1rem', lineHeight: '1.6' }}>
                      {details.desc}
                    </p>
                    <button 
                      style={{ 
                        marginTop: '30px', 
                        background: '#1475e1', 
                        color: 'white', 
                        border: 'none', 
                        padding: '12px 24px', 
                        borderRadius: '8px', 
                        fontWeight: 'bold', 
                        cursor: 'pointer' 
                      }}
                      onClick={() => setModalError('Feature coming soon!')}
                    >
                      Get Started
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
                  </div>
      </main>
      <ErrorModal error={modalError} onClose={() => setModalError(null)} title="Notice" />
    </div>
  );
}
