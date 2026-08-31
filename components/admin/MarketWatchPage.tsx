'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { signOut } from '@/lib/auth';
import { apiCall, Toast, ToastState, TAB_INSTRUMENTS, WatchlistItem } from './AdminUtils';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';

interface InstrumentSuggestion {
  id?: string;
  tradingsymbol?: string;
  name?: string;
  segment?: string;
}

export default function MarketWatchPage() {
  const tabs = ['INDEX-FUT', 'INDEX-OPT', 'STOCK-FUT', 'STOCK-OPT', 'STOCKS', 'MCX-FUT', 'MCX-OPT', 'COMEX', 'CRYPTO', 'FOREX'];
  const [activeTab, setActiveTab] = useState('INDEX-FUT');
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);
  const [watchlists, setWatchlists] = useState<Record<string, string[]>>({});
  const [toast, setToast] = useState<ToastState>(null);

  // Fetch watchlist for the active tab
  const fetchWatchlist = useCallback(async () => {
    const { ok, status, data } = await apiCall(`/api/admin/watchlist?tab=${encodeURIComponent(activeTab)}`, { method: 'GET' });
    if (status === 401) { signOut(); return; }
    if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
    if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
    
    const items = data as WatchlistItem[];
    const symbols = items.map(item => item.symbol);
    
    if (symbols.length === 0 && TAB_INSTRUMENTS[activeTab]) {
      const defaults = TAB_INSTRUMENTS[activeTab];
      setWatchlists(prev => ({ ...prev, [activeTab]: defaults }));
      defaults.forEach(sym => {
        apiCall('/api/admin/watchlist', {
          method: 'POST',
          body: JSON.stringify({ tab: activeTab, symbol: sym })
        });
      });
    } else {
      setWatchlists(prev => ({ ...prev, [activeTab]: symbols }));
    }
  }, [activeTab]);

  useEffect(() => {
    setTimeout(() => fetchWatchlist(), 0);
  }, [fetchWatchlist]);

  const currentSymbols = useMemo(() => watchlists[activeTab] ?? [], [watchlists, activeTab]);

  // Integrated Quotes Hooks
  const kiteKeys = useMemo(() =>
    !['COMEX', 'CRYPTO', 'FOREX'].includes(activeTab) ? currentSymbols : []
    , [activeTab, currentSymbols]);

  const comexKeys = useMemo(() =>
    activeTab === 'COMEX' ? currentSymbols : []
    , [activeTab, currentSymbols]);

  const binanceKeys = useMemo(() =>
    ['CRYPTO', 'FOREX'].includes(activeTab) ? currentSymbols : []
    , [activeTab, currentSymbols]);

  const marketSymbols = useMemo(() => [...kiteKeys, ...binanceKeys], [kiteKeys, binanceKeys]);
  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);
  const { quotes: comexQuotes } = useComexQuotes(comexKeys, 2000);

  const allQuotes = useMemo(() => ({
    ...marketQuotes,
    ...comexQuotes
  }), [marketQuotes, comexQuotes]);

  const instruments = watchlists[activeTab] ?? [];
  const [remoteSuggestions, setRemoteSuggestions] = useState<InstrumentSuggestion[]>([]);
  const [searching, setSearching] = useState(false);

  // Real instrument search
  useEffect(() => {
    if (search.trim().length < 2) {
      setTimeout(() => setRemoteSuggestions([]), 0);
      return;
    }
    const delayDebounceFn = setTimeout(() => {
      setSearching(true);
      apiCall(`/api/admin/instruments/search?q=${encodeURIComponent(search)}&tab=${encodeURIComponent(activeTab)}`, { method: 'GET' })
        .then(({ ok, data }) => {
          if (ok) setRemoteSuggestions(data as InstrumentSuggestion[]);
        })
        .finally(() => setSearching(false));
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [search, activeTab]);

  const showDropdown = focused && search.trim().length >= 2;
  const suggestions = remoteSuggestions;

  const addInstrument = (sym: string) => {
    setSearch('');
    setFocused(false);
    apiCall('/api/admin/watchlist', {
      method: 'POST',
      body: JSON.stringify({ tab: activeTab, symbol: sym }),
    }).then(({ ok, status }) => {
      if (status === 401) { signOut(); return; }
      if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
      if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
      setWatchlists(prev => ({
        ...prev,
        [activeTab]: [...(prev[activeTab] ?? []).filter(x => x !== sym), sym],
      }));
    }).catch((err: unknown) => {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    });
  };

  const handleClear = () => {
    apiCall(`/api/admin/watchlist?tab=${encodeURIComponent(activeTab)}`, { method: 'DELETE' })
      .then(({ ok, status }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        setWatchlists(prev => ({ ...prev, [activeTab]: [] }));
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      });
  };

  const removeInstrument = (sym: string, idx: number) => {
    apiCall(`/api/admin/watchlist?tab=${encodeURIComponent(activeTab)}&symbol=${encodeURIComponent(sym)}`, { method: 'DELETE' })
      .then(({ ok, status }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        setWatchlists(prev => ({ ...prev, [activeTab]: prev[activeTab].filter((_, j) => j !== idx) }));
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      });
  };

  const fmt = (n: number | undefined) => n ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  return (
    <div className="adm-mw-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <div className="adm-mw-tabs">
        {tabs.map(tab => (
          <button
            key={tab}
            className={`adm-mw-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab); setSearch(''); setFocused(false); }}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="adm-mw-search-row">
        <div className="adm-mw-search-wrap">
          <i className="fas fa-search adm-mw-search-icon" />
          <input
            className="adm-mw-search"
            placeholder="Search and add instrument…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
          />
          {showDropdown && (
            <div className="adm-mw-dropdown">
              {searching ? (
                <div className="adm-mw-dd-empty" style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}><AnimatedLoader size="small" />Searching…</div>
              ) : suggestions.length === 0 ? (
                <div className="adm-mw-dd-empty">No results found</div>
              ) : (
                suggestions.map((item, idx) => {
                  const sym = (item.tradingsymbol || item.id || `unknown-${idx}`) as string;
                  const added = instruments.includes(sym);
                  return (
                    <div
                      key={sym}
                      className={`adm-mw-dd-row ${added ? 'added' : ''}`}
                      onMouseDown={() => !added && addInstrument(sym)}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span className="adm-mw-dd-sym">{item.tradingsymbol}</span>
                        <span style={{ fontSize: '10px', color: '#8b949e' }}>{item.name || item.id}</span>
                      </div>
                      <span className="adm-mw-dd-tag">{item.segment || activeTab}</span>
                      {added
                        ? <span className="adm-mw-dd-check"><i className="fas fa-check" /></span>
                        : <span className="adm-mw-dd-plus"><i className="fas fa-plus" /></span>
                      }
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
        <button className="adm-mw-trash" onClick={handleClear} title="Clear Watchlist">
          <i className="fas fa-trash" />
        </button>
      </div>

      <div className="adm-mw-table-wrap">
        <table className="adm-mw-table">
          <thead>
            <tr>
              <th style={{ width: '180px' }}>SYMBOL</th>
              <th style={{ textAlign: 'right' }}>LTP</th>
              <th style={{ textAlign: 'right' }}>CHANGE %</th>
              <th style={{ textAlign: 'right' }}>BID</th>
              <th style={{ textAlign: 'right' }}>ASK</th>
              <th style={{ textAlign: 'right' }}>OPEN</th>
              <th style={{ textAlign: 'right' }}>CLOSE</th>
              <th style={{ width: '40px' }}></th>
            </tr>
          </thead>
          <tbody>
            {instruments.length === 0 ? (
              <tr>
                <td colSpan={7} className="adm-mw-empty">No instruments added to this watchlist.</td>
              </tr>
            ) : (
              instruments.map((sym, i) => {
                const q = allQuotes[sym];
                const change = q ? q.lastPrice - q.close : 0;
                const changeColor = change > 0 ? '#10b981' : change < 0 ? '#f43f5e' : '#8b949e';

                return (
                  <tr key={i}>
                    <td className="adm-mw-sym-cell">
                      <div className="adm-mw-sym-name">{sym.includes(':') ? sym.split(':')[1] : sym}</div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: changeColor }}>{fmt(q?.lastPrice)}</td>
                    <td style={{ textAlign: 'right', color: changeColor, fontWeight: 500 }}>
                      {q ? `${change > 0 ? '+' : ''}${change.toFixed(2)} (${q.changePercent}%)` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmt(q?.bid)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(q?.ask)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(q?.open)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(q?.close)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="adm-mw-row-remove" onClick={() => removeInstrument(sym, i)} title="Remove">
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}