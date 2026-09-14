'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { api } from '@/lib/api';
import { isInstrumentInWatchlist } from '@/lib/watchlistUtils';

interface Instrument {
  name: string;
  symbol: string;
  segment: string;
  kiteSymbol?: string;
  comexSymbol?: string;
  price?: number;
  strike?: number;
  optionType?: string;
  contractDate?: string;
  lotSize?: number;
}

interface Segment {
  name: string;
  icon: string;
  count: number;
  subCategories?: { name: string; instruments: Instrument[] }[];
  instruments?: Instrument[];
}

const UNDERLYING_QUOTE_KEYS = [
  'NSE:NIFTY 50',
  'NSE:NIFTY BANK',
  'BSE:SENSEX',
  'BSE:BANKEX',
  'BSE:SENSEX50',
  'NSE:NIFTY FIN SERVICE',
  'NSE:NIFTY MID SELECT',
  'MCX:GOLD',
  'MCX:SILVER',
  'MCX:CRUDEOIL',
];

const OPTION_SUBCAT_MAP: Record<string, { underlying: string; tab: string; key: string }> = {
  'NIFTY Options': { underlying: 'NIFTY', tab: 'INDEX-OPT', key: 'NSE:NIFTY 50' },
  'SENSEX Options': { underlying: 'SENSEX', tab: 'INDEX-OPT', key: 'BSE:SENSEX' },
  'BANKEX Options': { underlying: 'BANKEX', tab: 'INDEX-OPT', key: 'BSE:BANKEX' },
  'SENSEX50 Options': { underlying: 'SENSEX50', tab: 'INDEX-OPT', key: 'BSE:SENSEX50' },
  'BANKNIFTY Options': { underlying: 'BANKNIFTY', tab: 'INDEX-OPT', key: 'NSE:NIFTY BANK' },
  'FINNIFTY Options': { underlying: 'FINNIFTY', tab: 'INDEX-OPT', key: 'NSE:NIFTY FIN SERVICE' },
  'MID CAP NIFTY Options': { underlying: 'MIDCPNIFTY', tab: 'INDEX-OPT', key: 'NSE:NIFTY MID SELECT' },
  'GOLD Options': { underlying: 'GOLD', tab: 'MCX-OPT', key: 'MCX:GOLD' },
  'SILVER Options': { underlying: 'SILVER', tab: 'MCX-OPT', key: 'MCX:SILVER' },
  'CRUDEOIL Options': { underlying: 'CRUDEOIL', tab: 'MCX-OPT', key: 'MCX:CRUDEOIL' },
};

function filterOptionStrikesBySpot(items: Instrument[], spotPrice: number, strikeCount = 11): Instrument[] {
  if (!items || items.length === 0) return [];
  if (!spotPrice || spotPrice <= 0) return items.slice(0, strikeCount * 2);

  const strikeSet = new Set<number>();
  items.forEach(i => {
    if (i.strike !== undefined && i.strike !== null) {
      strikeSet.add(Number(i.strike));
    }
  });

  const strikes = Array.from(strikeSet).sort((a, b) => a - b);
  if (strikes.length === 0) return items.slice(0, strikeCount * 2);

  let closestIdx = 0;
  let minDiff = Infinity;
  strikes.forEach((s, idx) => {
    const diff = Math.abs(s - spotPrice);
    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = idx;
    }
  });

  const range = strikeCount;
  const half = Math.floor(range / 2);
  let startIdx = closestIdx - half;
  let endIdx = closestIdx + half;

  if (startIdx < 0) {
    endIdx += Math.abs(startIdx);
    startIdx = 0;
  }
  if (endIdx >= strikes.length) {
    const excess = endIdx - (strikes.length - 1);
    startIdx = Math.max(0, startIdx - excess);
    endIdx = strikes.length - 1;
  }

  const selectedStrikes = new Set(strikes.slice(startIdx, endIdx + 1));
  return items
    .filter(i => selectedStrikes.has(Number(i.strike)))
    .sort((a, b) => (Number(a.strike) || 0) - (Number(b.strike) || 0));
}

const BASE_TRADING_SEGMENTS: Segment[] = [
  {
    name: 'Index-fut',
    icon: 'fa-chart-line',
    count: 6,
    instruments: [
      { name: 'NIFTY FUT', symbol: 'NIFTY_FUT', segment: 'NSE - Futures' },
      { name: 'SENSEX FUT', symbol: 'SENSEX_FUT', segment: 'BSE - Futures' },
      { name: 'BANKEX FUT', symbol: 'BANKEX_FUT', segment: 'BSE - Futures' },
      { name: 'BANKNIFTY FUT', symbol: 'BANKNIFTY_FUT', segment: 'NSE - Futures' },
      { name: 'FINNIFTY FUT', symbol: 'FINNIFTY_FUT', segment: 'NSE - Futures' },
      { name: 'MIDCAP NIFTY FUT', symbol: 'MIDCP_FUT', segment: 'NSE - Futures' },
    ]
  },
  {
    name: 'Index-opt',
    icon: 'fa-chart-gantt',
    count: 8,
    subCategories: [
      { name: 'NIFTY Options', instruments: [] },
      { name: 'SENSEX Options', instruments: [] },
      { name: 'BANKEX Options', instruments: [] },
      { name: 'BANKNIFTY Options', instruments: [] },
      { name: 'FINNIFTY Options', instruments: [] },
      { name: 'MID CAP NIFTY Options', instruments: [] }
    ]
  },
  {
    name: 'Mcx-fut',
    icon: 'fa-coins',
    count: 3,
    instruments: [
      { name: 'GOLD FUT', symbol: 'GOLD_FUT', segment: 'MCX - Futures' },
      { name: 'SILVER FUT', symbol: 'SILVER_FUT', segment: 'MCX - Futures' },
      { name: 'CRUDEOIL FUT', symbol: 'CRUDEOIL_FUT', segment: 'MCX - Futures' }
    ]
  },
  {
    name: 'Mcx-opt',
    icon: 'fa-circle-dot',
    count: 3,
    instruments: [
      { name: 'GOLD OPT', symbol: 'GOLD_OPT', segment: 'MCX - Options' },
      { name: 'SILVER OPT', symbol: 'SILVER_OPT', segment: 'MCX - Options' },
      { name: 'CRUDEOIL OPT', symbol: 'CRUDEOIL_OPT', segment: 'MCX - Options' }
    ]
  },
  {
    name: 'Stock-fut',
    icon: 'fa-building',
    count: 3,
    instruments: [
      { name: 'RELIANCE FUT', symbol: 'RELIANCE_FUT', segment: 'NSE - Stock Futures' },
      { name: 'TCS FUT', symbol: 'TCS_FUT', segment: 'NSE - Stock Futures' },
      { name: 'HDFCBANK FUT', symbol: 'HDFCBANK_FUT', segment: 'NSE - Stock Futures' }
    ]
  },
  {
    name: 'Stock-opt',
    icon: 'fa-layer-group',
    count: 3,
    instruments: [
      { name: 'RELIANCE OPT', symbol: 'RELIANCE_OPT', segment: 'NSE - Stock Options' },
      { name: 'TCS OPT', symbol: 'TCS_OPT', segment: 'NSE - Stock Options' },
      { name: 'HDFCBANK OPT', symbol: 'HDFCBANK_OPT', segment: 'NSE - Stock Options' }
    ]
  },
  {
    name: 'STOCKS',
    icon: 'fa-landmark',
    count: 4,
    instruments: [
      { name: 'RELIANCE', symbol: 'RELIANCE_EQ', segment: 'NSE - Equity' },
      { name: 'TCS', symbol: 'TCS_EQ', segment: 'NSE - Equity' },
      { name: 'HDFCBANK', symbol: 'HDFCBANK_EQ', segment: 'NSE - Equity' },
      { name: 'INFY', symbol: 'INFY_EQ', segment: 'NSE - Equity' }
    ]
  },
  {
    name: 'CRYPTO',
    icon: 'fa-bitcoin-sign',
    count: 3,
    instruments: [
      { name: 'BTC/USDT', symbol: 'BTCUSDT', segment: 'CRYPTO' },
      { name: 'ETH/USDT', symbol: 'ETHUSDT', segment: 'CRYPTO' },
      { name: 'DOGE/USDT', symbol: 'DOGEUSDT', segment: 'CRYPTO' }
    ]
  },
  {
    name: 'Comex',
    icon: 'fa-gem',
    count: 4,
    instruments: [
      { name: 'GOLD', symbol: 'XAUUSD', comexSymbol: 'XAUUSD', segment: 'COMEX - Futures' },
      { name: 'SILVER', symbol: 'XAGUSD', comexSymbol: 'XAGUSD', segment: 'COMEX - Futures' },
      { name: 'CRUDE OIL', symbol: 'XTIUSD', comexSymbol: 'XTIUSD', segment: 'COMEX - Futures' },
      { name: 'COPPER', symbol: 'XCUUSD', comexSymbol: 'XCUUSD', segment: 'COMEX - Futures' }
    ]
  },
  {
    name: 'Forex',
    icon: 'fa-globe',
    count: 4,
    instruments: [
      { name: 'USD/INR', symbol: 'USDINR_FUT', segment: 'CDS - Futures' },
      { name: 'EUR/INR', symbol: 'EURINR_FUT', segment: 'CDS - Futures' },
      { name: 'GBP/INR', symbol: 'GBPINR_FUT', segment: 'CDS - Futures' },
      { name: 'JPY/INR', symbol: 'JPYINR_FUT', segment: 'CDS - Futures' }
    ]
  },
  {
    name: 'US-EQ',
    icon: 'fa-flag-usa',
    count: 12,
    instruments: [
      { name: 'Apple Inc.', symbol: 'US:AAPL', segment: 'US - Equity' },
      { name: 'Tesla Inc.', symbol: 'US:TSLA', segment: 'US - Equity' },
      { name: 'Nvidia Corp.', symbol: 'US:NVDA', segment: 'US - Equity' },
      { name: 'Microsoft Corp.', symbol: 'US:MSFT', segment: 'US - Equity' },
      { name: 'Amazon.com Inc.', symbol: 'US:AMZN', segment: 'US - Equity' },
      { name: 'Alphabet Inc.', symbol: 'US:GOOGL', segment: 'US - Equity' },
      { name: 'Meta Platforms', symbol: 'US:META', segment: 'US - Equity' },
      { name: 'Netflix Inc.', symbol: 'US:NFLX', segment: 'US - Equity' },
      { name: 'AMD', symbol: 'US:AMD', segment: 'US - Equity' },
      { name: 'Intel Corp.', symbol: 'US:INTC', segment: 'US - Equity' },
      { name: 'SPDR S&P 500 ETF', symbol: 'US:SPY', segment: 'US - Equity' },
      { name: 'Invesco QQQ Trust', symbol: 'US:QQQ', segment: 'US - Equity' }
    ]
  }
];

const DISPLAY_NAME_MAP: Record<string, { name: string; icon: string }> = {
  'INDEX-FUT': { name: 'Index-fut', icon: 'fa-chart-line' },
  'INDEX-OPT': { name: 'Index-opt', icon: 'fa-chart-gantt' },
  'MCX-FUT': { name: 'Mcx-fut', icon: 'fa-coins' },
  'MCX-OPT': { name: 'Mcx-opt', icon: 'fa-circle-dot' },
  'STOCK-FUT': { name: 'Stock-fut', icon: 'fa-building' },
  'STOCK-OPT': { name: 'Stock-opt', icon: 'fa-layer-group' },
  'NSE-EQ': { name: 'STOCKS', icon: 'fa-landmark' },
  'EQUITY': { name: 'STOCKS', icon: 'fa-landmark' },
  'Equity': { name: 'STOCKS', icon: 'fa-landmark' },
  'STOCKS': { name: 'STOCKS', icon: 'fa-landmark' },
  'Stocks': { name: 'STOCKS', icon: 'fa-landmark' },
  'CRYPTO': { name: 'CRYPTO', icon: 'fa-bitcoin-sign' },
  'COMEX': { name: 'Comex', icon: 'fa-gem' },
  'FOREX': { name: 'Forex', icon: 'fa-globe' },
  'US-EQ': { name: 'US-EQ', icon: 'fa-flag-usa' },
  'US Equity': { name: 'US-EQ', icon: 'fa-flag-usa' },
};

interface TradingSegmentsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect?: (item: any) => void;
  addedSymbols?: Set<string>;
  watchlistItems?: any[];
}

export default function TradingSegmentsDrawer({ isOpen, onClose, onSelect, addedSymbols, watchlistItems }: TradingSegmentsDrawerProps) {
  const [mounted, setMounted] = React.useState(false);
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);
  const [expandedSubcategories, setExpandedSubcategories] = useState<Record<string, boolean>>({});
  const [allowedSegments, setAllowedSegments] = useState<string[]>([]);
  const [rawOptionInstruments, setRawOptionInstruments] = useState<Record<string, Instrument[]>>({});
  const [librarySegments, setLibrarySegments] = useState<Segment[] | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('cached_drawer_segments');
        if (cached) return JSON.parse(cached);
      } catch (_) {}
    }
    return null;
  });

  const { quotes } = useMarketQuotes(UNDERLYING_QUOTE_KEYS);

  React.useEffect(() => {
    setMounted(true);
    const fetchAllowedSegments = async () => {
      try {
        const profile = await api.get<{ segments?: string[] }>('/api/user/profile');
        if (profile && profile.segments) {
          setAllowedSegments(profile.segments);
        }
      } catch (err) {
        console.error('Failed to fetch allowed segments', err);
      }
    };
    fetchAllowedSegments();
  }, []);

  // Fetch full instrument hierarchy from library endpoint on mount so opening drawer is instant (0ms)
  useEffect(() => {
    let isSubscribed = true;

    async function loadLibrary() {
      try {
        const res = await api.get<{ success?: boolean; segments: any[] }>('/api/market/instruments/library');
        if (res && Array.isArray(res.segments) && isSubscribed) {
          const mapped: Segment[] = res.segments.map(s => {
            const display = DISPLAY_NAME_MAP[s.name] || { name: s.name, icon: s.icon || 'fa-folder' };
            const subCats = s.subCategories?.map((sc: any) => ({
              name: sc.name,
              instruments: (sc.instruments || []).map((i: any) => ({
                name: i.name || i.symbol,
                symbol: i.symbol,
                segment: i.segment || 'NSE - Stock Options',
                kiteSymbol: i.kiteSymbol || i.symbol,
                price: i.price || 0,
                strike: i.strike !== undefined ? Number(i.strike) : (i.strike_price !== undefined ? Number(i.strike_price) : undefined),
                optionType: i.optionType || i.option_type,
                contractDate: i.contractDate || i.expiry,
                lotSize: i.lotSize || i.lot_size,
              })),
            }));

            const insts = s.instruments?.map((i: any) => ({
              name: i.name || i.symbol,
              symbol: i.symbol,
              segment: i.segment || s.name,
              kiteSymbol: i.kiteSymbol || i.symbol,
              price: i.price || 0,
              contractDate: i.contractDate || i.expiry,
              lotSize: i.lotSize || i.lot_size,
            }));

            return {
              name: display.name,
              icon: display.icon,
              count: subCats ? subCats.length : (insts?.length || 0),
              subCategories: subCats,
              instruments: insts,
            };
          });
          setLibrarySegments(mapped);
          try {
            localStorage.setItem('cached_drawer_segments', JSON.stringify(mapped));
          } catch (_) {}
        }
      } catch (err) {
        console.error('Failed to load library segments', err);
      }
    }

    loadLibrary();
    return () => { isSubscribed = false; };
  }, []);

  // Fetch live option contracts for option subcategories when drawer opens
  useEffect(() => {
    if (!isOpen) return;

    let isSubscribed = true;
    async function loadOptionContracts() {
      const results: Record<string, Instrument[]> = {};
      await Promise.all(
        Object.entries(OPTION_SUBCAT_MAP).map(async ([subName, cfg]) => {
          try {
            const url = `/api/market/instruments/search?q=${encodeURIComponent(cfg.underlying)}&tab=${cfg.tab}&_t=${Date.now()}`;
            const res = await api.get<{ success: boolean; results: any[] }>(url);
            if (res && res.success && Array.isArray(res.results)) {
              results[subName] = res.results.map(r => ({
                name: r.name || r.tradingsymbol,
                symbol: r.symbol || r.tradingsymbol,
                segment: r.segment || 'NSE - Options',
                kiteSymbol: r.kiteSymbol || r.symbol,
                price: r.price || 0,
                strike: r.strike !== undefined ? Number(r.strike) : undefined,
                optionType: r.optionType,
                contractDate: r.contractDate,
                lotSize: r.lotSize,
              }));
            }
          } catch (e) {
            console.error(`Failed to load options for ${subName}`, e);
          }
        })
      );
      if (isSubscribed) {
        setRawOptionInstruments(results);
      }
    }

    loadOptionContracts();
    return () => { isSubscribed = false; };
  }, [isOpen]);

  // Compute dynamic segments with 11-strike window re-centered around live spot prices
  const tradingSegments = useMemo(() => {
    const baseSegments = librarySegments || BASE_TRADING_SEGMENTS;
    return baseSegments.map(seg => {
      if (!seg.subCategories) return seg;

      const subCategories = seg.subCategories.map(sub => {
        const rawItems = rawOptionInstruments[sub.name] || sub.instruments;
        const cfg = OPTION_SUBCAT_MAP[sub.name];
        if (cfg) {
          const liveSpot = quotes[cfg.key]?.lastPrice || 0;
          const rangeCount = 11;
          const filtered = filterOptionStrikesBySpot(rawItems, liveSpot, rangeCount).slice(0, 22);
          return {
            ...sub,
            instruments: filtered.length > 0 ? filtered : sub.instruments,
          };
        }
        return sub;
      });

      return {
        ...seg,
        subCategories,
        count: subCategories.length,
      };
    });
  }, [librarySegments, rawOptionInstruments, quotes]);

  if (!mounted) return null;

  const handleSegmentClick = (name: string) => {
    setExpandedSegment(expandedSegment === name ? null : name);
  };

  const SEGMENT_NAME_TO_DB_KEY: Record<string, string> = {
    'Index-fut': 'INDEX-FUT',
    'Index-opt': 'INDEX-OPT',
    'Mcx-fut': 'MCX-FUT',
    'Mcx-opt': 'MCX-OPT',
    'Stock-fut': 'STOCK-FUT',
    'Stock-opt': 'STOCK-OPT',
    'Stocks': 'STOCKS',
    'STOCKS': 'STOCKS',
    'Equity': 'STOCKS',
    'Nse-eq': 'STOCKS',
    'NSE-EQ': 'STOCKS',
    'Crypto': 'CRYPTO',
    'CRYPTO': 'CRYPTO',
    'Comex': 'COMEX',
    'Forex': 'FOREX',
    'US-EQ': 'US-EQ',
    'Us-eq': 'US-EQ',
    'US Equity': 'US-EQ',
  };

  const visibleSegments = tradingSegments.filter(seg => {
    if (allowedSegments.length === 0) return true;
    const dbKey = SEGMENT_NAME_TO_DB_KEY[seg.name] ?? seg.name.toUpperCase();
    return (
      allowedSegments.includes(dbKey) ||
      allowedSegments.includes(seg.name) ||
      ((seg.name === 'Stocks' || seg.name === 'STOCKS' || seg.name === 'Equity' || seg.name.toUpperCase() === 'EQUITY') && (allowedSegments.includes('STOCKS') || allowedSegments.includes('NSE-EQ') || allowedSegments.includes('Equity') || allowedSegments.includes('Stocks'))) ||
      (dbKey === 'US-EQ' && (allowedSegments.includes('US-EQ') || allowedSegments.includes('US Equity') || allowedSegments.includes('STOCKS') || allowedSegments.includes('NSE-EQ') || allowedSegments.length >= 8))
    );
  });

  return (
    <>
      <div
        className={`lib-overlay ${isOpen ? 'active' : ''}`}
        onClick={onClose}
      />
      <div className={`lib-drawer ${isOpen ? 'open' : ''}`}>
        <div className="lib-header">
          <div className="lib-title-grp">
            <i className="fas fa-folder lib-folder-icon"></i>
            <h3 className="lib-main-title">Trading Segments</h3>
          </div>
          <button className="lib-close-x" onClick={onClose}>
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="lib-scroll-content">
          {visibleSegments.map((seg) => (
            <div key={seg.name} className="lib-seg-group">
              <div
                className={`lib-seg-header ${expandedSegment === seg.name ? 'is-expanded' : ''}`}
                onClick={() => handleSegmentClick(seg.name)}
              >
                <i className={`fas fa-chevron-right lib-arrow ${expandedSegment === seg.name ? 'is-down' : ''}`}></i>
                <div className="lib-seg-info">
                  <i className={`fas ${seg.icon} lib-seg-icon`}></i>
                  <span className="lib-seg-name">{seg.name}</span>
                </div>
                <span className="lib-seg-count">{seg.count}</span>
              </div>

              {expandedSegment === seg.name && (
                <div className="lib-seg-children">
                  {seg.instruments?.map((inst, idx) => {
                    const isAdded = (addedSymbols?.has(inst.symbol) || addedSymbols?.has(inst.name)) || (watchlistItems && isInstrumentInWatchlist(inst, watchlistItems));
                    return (
                      <div key={`${inst.kiteSymbol || inst.symbol}-${idx}`} className="lib-inst-item" onClick={() => onSelect?.(inst)}>
                        <span className="lib-inst-name">{inst.name}</span>
                        <button
                          className="lib-add-btn"
                          style={isAdded ? { background: '#2C8E5A', color: '#fff', borderColor: '#2C8E5A' } : undefined}
                        >
                          {isAdded ? 'Added ✓' : '+ Add'}
                        </button>
                      </div>
                    );
                  })}
                  {seg.subCategories?.map(sub => {
                    const isSubOpen = !!expandedSubcategories[sub.name];
                    return (
                      <div key={sub.name} className="lib-subcat">
                        <div
                          className="lib-subcat-header"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedSubcategories(prev => ({ ...prev, [sub.name]: !isSubOpen }));
                          }}
                        >
                          <i
                            className={`fas fa-chevron-right lib-arrow ${isSubOpen ? 'is-down' : ''}`}
                            style={{ fontSize: '0.55rem', marginRight: '6px' }}
                          ></i>
                          <span className="lib-subcat-title">{sub.name}</span>
                          <span className="lib-subcat-count">{sub.instruments?.length || 0}</span>
                        </div>
                        {isSubOpen && sub.instruments?.map((inst, idx) => {
                          const isAdded = (addedSymbols?.has(inst.symbol) || addedSymbols?.has(inst.name)) || (watchlistItems && isInstrumentInWatchlist(inst, watchlistItems));
                          return (
                            <div key={`${inst.kiteSymbol || inst.symbol}-${idx}`} className="lib-inst-item" onClick={() => onSelect?.(inst)}>
                              <span className="lib-inst-name">{inst.name}</span>
                              <button
                                className="lib-add-btn"
                                style={isAdded ? { background: '#2C8E5A', color: '#fff', borderColor: '#2C8E5A' } : undefined}
                              >
                                {isAdded ? 'Added ✓' : '+ Add'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="lib-footer">
          <p><i className="fas fa-plus-circle"></i> Tap <span className="lib-red-text">+ Add</span> to watchlist | Browse all segments</p>
        </div>
      </div>

      <style jsx>{`
        .lib-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          opacity: 0;
          visibility: hidden;
          transition: all 0.3s ease;
          z-index: 10000;
        }
        .lib-overlay.active {
          opacity: 1;
          visibility: visible;
        }

        .lib-drawer {
          position: fixed;
          top: 0;
          right: -420px;
          width: 100%;
          max-width: 400px;
          height: 100vh;
          background: #ffffff;
          z-index: 10001;
          transition: right 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          display: flex;
          flex-direction: column;
          box-shadow: -10px 0 50px rgba(0,0,0,0.2);
        }
        .lib-drawer.open {
          right: 0;
        }

        .lib-header {
          padding: 24px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #f0f3f6;
          background: #fff;
        }

        .lib-title-grp {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .lib-folder-icon { color: #C62E2E; font-size: 1.25rem; }
        .lib-main-title { 
            margin: 0 !important; 
            font-size: 1.1rem !important; 
            font-weight: 800 !important; 
            color: #1a1a1a !important;
            text-transform: none !important;
            letter-spacing: normal !important;
        }

        .lib-close-x {
          background: #f3f4f6;
          border: none;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #4b5563;
          cursor: pointer;
          font-size: 1rem;
        }

        .lib-scroll-content {
          flex: 1;
          overflow-y: auto;
          padding: 10px 0;
          background: #fff;
        }

        .lib-seg-header {
          padding: 16px 20px;
          display: flex;
          align-items: center;
          cursor: pointer;
          transition: background 0.2s;
          border-bottom: 1px solid #f9fafb;
        }
        .lib-seg-header:hover { background: #f9fafb; }

        .lib-arrow {
          font-size: 0.7rem;
          color: #9ca3af;
          margin-right: 14px;
          transition: transform 0.2s;
        }
        .lib-arrow.is-down { transform: rotate(90deg); }

        .lib-seg-info {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .lib-seg-icon { font-size: 1.05rem; color: #C62E2E; width: 24px; text-align: center; }
        .lib-seg-name { font-size: 0.85rem; font-weight: 700; color: #1f2937; text-transform: uppercase; }

        .lib-seg-count {
          background: #f3f4f6;
          color: #6b7280;
          font-size: 0.7rem;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 10px;
        }

        .lib-seg-children {
          background: #fcfcfd;
          border-bottom: 1px solid #f3f4f6;
        }

        .lib-subcat-header {
          padding: 12px 20px 8px 40px;
          font-size: 0.75rem;
          font-weight: 700;
          color: #4b5563;
          display: flex;
          align-items: center;
          cursor: pointer;
          transition: color 0.2s;
        }
        .lib-subcat-header:hover { color: #111827; }
        .lib-subcat-title {
          flex: 1;
        }
        .lib-subcat-count {
          background: #f3f4f6;
          color: #6b7280;
          font-size: 0.7rem;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 10px;
          margin-left: auto;
        }

        .lib-inst-item {
          padding: 12px 20px 12px 58px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: pointer;
          transition: background 0.2s;
        }
        .lib-inst-item:hover { background: #f3f4f6; }
        .lib-inst-name { font-size: 0.85rem; font-weight: 600; color: #374151; }

        .lib-add-btn {
          background: #fff;
          border: 1px solid #e5e7eb;
          padding: 5px 12px;
          border-radius: 8px;
          font-size: 0.7rem;
          font-weight: 700;
          color: #C62E2E;
          cursor: pointer;
          transition: all 0.2s;
        }
        .lib-add-btn:hover { background: #C62E2E; color: #fff; border-color: #C62E2E; }

        .lib-footer {
          padding: 18px 20px;
          border-top: 1px solid #f0f3f6;
          font-size: 0.75rem;
          color: #6b7280;
          font-weight: 600;
          background: #fff;
        }
        .lib-red-text { color: #C62E2E; }

        /* Dark Mode */
        :global(.dark) .lib-drawer, 
        :global(.dark) .lib-header,
        :global(.dark) .lib-scroll-content,
        :global(.dark) .lib-footer { background: #111827; border-color: #1f2937; }
        
        :global(.dark) .lib-main-title,
        :global(.dark) .lib-seg-name { color: #f9fafb !important; }
        
        :global(.dark) .lib-subcat-header { color: #9ca3af; }
        :global(.dark) .lib-subcat-header:hover { color: #f9fafb; }
        :global(.dark) .lib-subcat-title { color: #e5e7eb; }
        :global(.dark) .lib-subcat-count { background: #374151; color: #9ca3af; }

        :global(.dark) .lib-inst-name { color: #d1d5db; }
        :global(.dark) .lib-seg-header:hover { background: #1f2937; }
        :global(.dark) .lib-seg-children { background: #0b0f1a; border-color: #1f2937; }
        :global(.dark) .lib-inst-item:hover { background: #1f2937; }
        :global(.dark) .lib-add-btn { background: #1f2937; border-color: #374151; }
        :global(.dark) .lib-seg-count { background: #374151; color: #9ca3af; }
        :global(.dark) .lib-close-x { background: #1f2937; color: #9ca3af; }
      `}</style>
    </>
  );
}
