'use client';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { signOut } from '@/lib/auth';
import { apiCall, Toast, ToastState, ConfirmDialog, SkeletonLine, Position, PositionItem, positionItemToPosition } from './AdminUtils';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';

export default function PositionPage({ selectedUser, onOpenUserPanel, isDemoMode }: { selectedUser: { id: string; role: string; client_id?: string; full_name?: string; email?: string }, onOpenUserPanel?: () => void, isDemoMode: boolean }) {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rows, setRows] = useState('10');
  const [page, setPage] = useState(1);
  const [positions, setPositions] = useState<Position[]>([]);
  const [posLoading, setPosLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [editPos, setEditPos] = useState<Position | null>(null);
  const [editSl, setEditSl] = useState('');
  const [editTp, setEditTp] = useState('');
  const [editQtyOpen, setEditQtyOpen] = useState('');
  const [editAvgPrice, setEditAvgPrice] = useState('');
  const [editExitPrice, setEditExitPrice] = useState('');
  const [editQtyTotal, setEditQtyTotal] = useState('');
  const [editBrokerage, setEditBrokerage] = useState('');
  const [editSettlement, setEditSettlement] = useState('');
  const [editStatus, setEditStatus] = useState<'open' | 'active' | 'closed'>('open');
  const [editSide, setEditSide] = useState<'BUY' | 'SELL'>('BUY');
  const [weeklyPnl, setWeeklyPnl] = useState<number>(0);
  const [showClearHistoryModal, setShowClearHistoryModal] = useState(false);
  const [clearInputText, setClearInputText] = useState('');
  const [clearHistoryLoading, setClearHistoryLoading] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [dropdownSearch, setDropdownSearch] = useState('');
  const [userRoleMap, setUserRoleMap] = useState<Record<string, string>>({});
  const [openRoleDropdown, setOpenRoleDropdown] = useState<string | null>(null);

  const uid = selectedUser.id;

  const handleClearHistory = async () => {
    if (clearInputText !== 'CLEAR') return;
    const targetUid = uid || 'all';
    setClearHistoryLoading(true);
    try {
      const { ok, data } = await apiCall(`/api/admin/users/${targetUid}/clear-history`, { method: 'POST' });
      if (ok) {
        setToast({
          message: targetUid === 'all'
            ? 'Trading history cleared for ALL users successfully'
            : 'Trading history cleared successfully',
          type: 'success'
        });
        setShowClearHistoryModal(false);
        setClearInputText('');
        fetchPositions();
      } else {
        setToast({ message: (data as any)?.error || 'Failed to clear history', type: 'error' });
      }
    } catch (err: any) {
      setToast({ message: err?.message || 'Network error', type: 'error' });
    } finally {
      setClearHistoryLoading(false);
    }
  };

  const fetchPositions = useCallback((silent = false) => {
    const endpointId = uid || 'all';
    if (!silent) setPosLoading(true);
    let url = `/api/admin/users/${endpointId}/positions?tab=${encodeURIComponent(tab)}&rows=100000&demo=${isDemoMode}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&end_date=${encodeURIComponent(endDate)}`;
    
    apiCall(url, { method: 'GET' })
      .then(({ ok, status, data }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        const items = data as PositionItem[];
        setPositions(items.map(positionItemToPosition));
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      })
      .finally(() => setPosLoading(false));
  }, [uid, tab, isDemoMode, startDate, endDate]);

  useEffect(() => {
    fetchPositions();
  }, [uid, tab, isDemoMode, startDate, endDate]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchPositions(true); // silent refresh
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchPositions]);

  useEffect(() => {
    apiCall(`/api/admin/users?demo=${isDemoMode}`, { method: 'GET' }).then(({ ok, data }) => {
      if (ok && Array.isArray(data)) {
        if (!uid) {
          const totalWeekly = data.reduce((sum, u) => sum + (u.weeklyPnl || 0), 0);
          setWeeklyPnl(totalWeekly);
        } else {
          const u = data.find(x => x.id === uid);
          if (u && typeof u.weeklyPnl === 'number') {
            setWeeklyPnl(u.weeklyPnl);
          }
        }
        setAllUsers(data);
        // Build userId → role map for Select Multiple filter
        const roleMap: Record<string, string> = {};
        (data as Array<{ id: string; role: string }>).forEach(u => { roleMap[u.id] = u.role; });
        setUserRoleMap(roleMap);
      }
    });
  }, [uid, isDemoMode]);

  // Smartly resolve Kite instrument prefixes if they are missing
  const resolveKitePrefix = useCallback((key: string, settlementType: string) => {
    let baseKey = key;
    if (baseKey.includes(':')) {
      baseKey = baseKey.split(':').slice(1).join(':'); // Strip existing prefix
    }
    const seg = (settlementType || '').toUpperCase();
    let prefix = 'NSE:';
    if (baseKey.startsWith('SENSEX') || baseKey.startsWith('BANKEX')) {
      prefix = 'BFO:';
    } else if (
      seg.includes('MCX') ||
      seg.includes('NCO') ||
      baseKey.startsWith('CRUDEOIL') ||
      baseKey.startsWith('NATGAS') ||
      baseKey.startsWith('SILVER') ||
      baseKey.startsWith('GOLD') ||
      baseKey.startsWith('COPPER') ||
      baseKey.startsWith('ZINC') ||
      baseKey.startsWith('ALUMINIUM') ||
      baseKey.startsWith('LEAD') ||
      baseKey.startsWith('MENTHAOIL')
    ) {
      prefix = (seg === 'NCO' || seg === 'NCO-OPT') ? 'NCO:' : 'MCX:';
    } else if (
      seg.includes('CDS') ||
      seg.includes('FOREX') ||
      baseKey.startsWith('USDINR') ||
      baseKey.startsWith('EURINR') ||
      baseKey.startsWith('GBPINR') ||
      baseKey.startsWith('JPYINR')
    ) {
      prefix = 'CDS:';
    } else if (seg.includes('BSE') || seg.includes('BFO')) {
      prefix = 'BFO:';
    } else if (seg.includes('OPT') || seg.includes('FUT') || seg.includes('NFO')) {
      prefix = 'NFO:';
    }

    if (prefix === 'BFO:' && !baseKey.match(/\d/)) prefix = 'BSE:';
    if (prefix === 'NFO:' && !baseKey.match(/\d/)) prefix = 'NSE:';

    return `${prefix}${baseKey}`;
  }, []);

  // Group instrument keys to subscribe to quotes
  const { kiteKeys, binanceKeys, comexKeys } = useMemo(() => {
    const kite: string[] = [];
    const binance: string[] = [];
    const comex: string[] = [];

    positions.filter(p => p.status === 'open' || p.status === 'active').forEach(p => {
      const seg = (p.settlement || '').toUpperCase();
      if (seg.includes('CRYPTO') || seg === 'USDT' || (p.symbol && p.symbol.endsWith('USDT'))) {
        let sym = (p.symbol || '').replace('/', '');
        if (!sym.endsWith('USDT')) sym = sym + 'USDT';
        binance.push(sym);
      } else if (seg.includes('COMEX') || (p.symbol && p.symbol.endsWith('=F'))) {
        comex.push(p.symbol);
      } else {
        kite.push(resolveKitePrefix(p.symbol, p.settlement || ''));
      }
    });

    return { kiteKeys: kite, binanceKeys: binance, comexKeys: comex };
  }, [positions, resolveKitePrefix]);

  const marketSymbols = useMemo(() => [...kiteKeys, ...binanceKeys], [kiteKeys, binanceKeys]);
  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);
  const { quotes: comexQuotes } = useComexQuotes(comexKeys);

  const enrichedPositions = useMemo(() => {
    return positions.map(p => {
      if (p.status !== 'open' && p.status !== 'active') return p;
      const seg = (p.settlement || '').toUpperCase();
      let liveLtp = p.ltp || p.entry;

      if (seg.includes('CRYPTO') || seg === 'USDT' || (p.symbol && p.symbol.endsWith('USDT'))) {
        let binanceKey = (p.symbol || '').replace('/', '');
        if (!binanceKey.endsWith('USDT')) binanceKey = binanceKey + 'USDT';
        liveLtp = marketQuotes[binanceKey]?.lastPrice ?? liveLtp;
      } else if (seg.includes('COMEX') || (p.symbol && p.symbol.endsWith('=F'))) {
        liveLtp = comexQuotes[p.symbol]?.lastPrice ?? liveLtp;
      } else {
        const kiteKey = resolveKitePrefix(p.symbol, p.settlement || '');
        const symBare = p.symbol.includes(':') ? p.symbol.split(':')[1] : p.symbol;
        liveLtp = marketQuotes[kiteKey]?.lastPrice ?? marketQuotes[`NCO:${symBare}`]?.lastPrice ?? marketQuotes[`MCX:${symBare}`]?.lastPrice ?? marketQuotes[p.symbol]?.lastPrice ?? liveLtp;
      }

      const qtyOpen = Number(p.qty.split('/')[0]) || 0;
      let livePnl = p.pnl;
      if (qtyOpen > 0) {
        if (p.side === 'BUY') {
          livePnl = (liveLtp - p.avgPrice) * qtyOpen;
        } else {
          livePnl = (p.avgPrice - liveLtp) * qtyOpen;
        }
      }

      return { ...p, ltp: liveLtp, pnl: livePnl };
    });
  }, [positions, marketQuotes, comexQuotes, resolveKitePrefix]);

  const openPnl = enrichedPositions.reduce((s, p) => s + (p.status === 'open' || p.status === 'active' ? p.pnl : 0), 0);
  const totalSettlement = enrichedPositions.reduce((s, p) => s + (p.settlementAmount ?? 0), 0);

  const selectedBrokers = allUsers.filter(u => u.role === 'broker' && selectedUserIds.has(u.id)).map(u => u.id);

  const filtered = enrichedPositions.filter(p => {
    const matchesSearch =
      p.symbol.toLowerCase().includes(search.toLowerCase()) ||
      (p.client_id || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.user_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.user_id || '').toLowerCase().includes(search.toLowerCase());

    if (!matchesSearch) return false;

    if (selectedUserIds.size === 0) return true;
    
    // Direct match
    if (selectedUserIds.has(p.user_id)) return true;

    // Check if the position's user is under a selected broker
    const posUser = allUsers.find(u => u.id === p.user_id);
    if (posUser && posUser.parent_id && selectedBrokers.includes(posUser.parent_id)) return true;

    return false;
  });
  
  const totalTrades = filtered.length;
  const winningTrades = filtered.filter(p => (p.pnl || 0) > 0).length;
  const losingTrades = filtered.filter(p => (p.pnl || 0) < 0).length;
  const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(1) + '%' : '0%';
  const lossRate = totalTrades > 0 ? ((losingTrades / totalTrades) * 100).toFixed(1) + '%' : '0%';
  const totalPnl = filtered.reduce((s, p) => s + (p.pnl || 0), 0);
  const totalBrokerage = filtered.reduce((s, p) => s + (p.brokerage || 0), 0);

  const rowsNum = Number(rows);
  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsNum));
  const displayed = filtered.slice((page - 1) * rowsNum, page * rowsNum);

  const switchTab = (t: 'open' | 'closed') => { setTab(t); setSearch(''); setPage(1); };

  const handleSqoff = (posId: string) => {
    apiCall(`/api/admin/positions/${posId}/sqoff`, { method: 'POST' })
      .then(({ ok, status }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        setToast({ message: 'Square off successful', type: 'success' });
        fetchPositions();
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      });
  };

  const handleReopen = (pos: Position) => {
    apiCall(`/api/admin/positions/${pos.id}/reopen`, {
      method: 'POST',
    }).then(({ ok, status }) => {
      if (status === 401) { signOut(); return; }
      if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
      if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
      setToast({ message: 'Position reopened successfully', type: 'success' });
      fetchPositions();
    }).catch((err: unknown) => {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    });
  };

  const openEdit = (p: Position) => {
    setEditPos(p);
    setEditSl(p.slTp.split(' / ')[0] === '–' ? '' : p.slTp.split(' / ')[0]);
    setEditTp(p.slTp.split(' / ')[1] === '–' ? '' : p.slTp.split(' / ')[1]);
    setEditQtyOpen(p.qty.split('/')[0]);
    setEditAvgPrice(String(p.avgPrice || 0));
    setEditExitPrice(p.exit !== undefined ? String(p.exit) : '');
    setEditQtyTotal(p.qty.split('/')[1] || p.qty.split('/')[0] || '0');
    setEditBrokerage(String(p.brokerage || 0));
    setEditSettlement(p.settlement || '');
    setEditStatus(p.status);
    setEditSide(p.side as 'BUY' | 'SELL');
  };

  const handleEdit = () => {
    if (!editPos?.id) return;
    const body: Record<string, unknown> = {};
    body.status = editStatus;
    body.side = editSide;

    if (editStatus === 'closed') {
      body.avg_price = Number(editAvgPrice);
      body.exit_price = editExitPrice !== '' ? Number(editExitPrice) : null;
      body.qty_total = Number(editQtyTotal);
      body.qty_open = 0;
      body.brokerage = Number(editBrokerage);
      body.settlement = editSettlement !== '' ? editSettlement : null;
    } else {
      if (editSl !== '') body.sl = Number(editSl);
      else body.sl = null;
      if (editTp !== '') body.tp = Number(editTp);
      else body.tp = null;
      if (editQtyOpen !== '') body.qty_open = Number(editQtyOpen);
      if (editQtyTotal !== '') body.qty_total = Number(editQtyTotal);
      body.avg_price = Number(editAvgPrice);
      body.brokerage = Number(editBrokerage);
    }

    apiCall(`/api/admin/positions/${editPos.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then(({ ok, status }) => {
      if (status === 401) { signOut(); return; }
      if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
      if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
      setToast({ message: 'Position updated successfully', type: 'success' });
      setEditPos(null);
      fetchPositions();
    }).catch((err: unknown) => {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    });
  };

  const handleDelete = () => {
    if (!confirmDeleteId) return;
    setDeleteLoading(true);
    apiCall(`/api/admin/positions/${confirmDeleteId}`, { method: 'DELETE' })
      .then(({ ok, status }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        setToast({ message: 'Position deleted successfully', type: 'success' });
        setConfirmDeleteId(null);
        fetchPositions();
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      })
      .finally(() => setDeleteLoading(false));
  };

  return (
    <div className="adm-pos-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      {confirmDeleteId && (
        <ConfirmDialog
          message="Delete this position? This cannot be undone."
          onConfirm={handleDelete}
          onCancel={() => setConfirmDeleteId(null)}
          loading={deleteLoading}
        />
      )}
      {editPos && (() => {
        const entry = parseFloat(editAvgPrice) || 0;
        const exit = parseFloat(editExitPrice) || 0;
        const qty = parseFloat(editQtyTotal) || 0;
        const brok = parseFloat(editBrokerage) || 0;
        const entryValue = entry * qty;
        const exitValue = exit * qty;
        const rawPnl = editSide === 'BUY' ? (exit - entry) * qty : (entry - exit) * qty;
        const netPnl = rawPnl - brok;
        const isPositive = netPnl >= 0;
        const entrySideLabel = editSide === 'BUY' ? 'Buy' : 'Sell';
        const exitSideLabel = editSide === 'BUY' ? 'Sell' : 'Buy';
        const fmtVal = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // Shared inline styles for the competitor-matching design
        const labelSm: React.CSSProperties = { fontSize: '0.6rem', fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: '4px' };
        const inputSm: React.CSSProperties = { fontSize: '0.78rem', padding: '9px 10px', borderRadius: '8px', background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3', width: '100%', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums' };
        const readonlyBox: React.CSSProperties = { ...inputSm, background: '#161b22', color: '#8b949e', cursor: 'default', display: 'flex', alignItems: 'center', minHeight: '38px' };

        return (
        <div className="adm-modal-overlay" onClick={() => setEditPos(null)}>
          <div className="adm-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <span style={{ fontSize: '1.05rem', fontWeight: 700, color: '#e6edf3' }}>Edit Position</span>
              <button onClick={() => setEditPos(null)} style={{ background: 'none', border: 'none', color: '#8b949e', fontSize: '1.1rem', cursor: 'pointer', padding: '4px' }}>✕</button>
            </div>

            {/* Side dropdown */}
            <div style={{ marginBottom: '8px' }}>
              <label style={labelSm}>Side</label>
              <select
                value={editSide}
                onChange={e => setEditSide(e.target.value as any)}
                style={{ ...inputSm, appearance: 'auto', cursor: 'pointer' }}
              >
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </div>

            {/* Direction hint */}
            <div style={{ fontSize: '0.65rem', color: '#6e7681', fontWeight: 500, marginBottom: '12px' }}>
              (Entry = {entrySideLabel}) (Exit = {exitSideLabel})
            </div>

            {editStatus === 'closed' ? (
              <>
                {/* ── Entry Section ── */}
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#e6edf3', marginBottom: '8px' }}>
                    Entry ({entrySideLabel})
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.65fr 1.1fr', gap: '8px' }}>
                    <div>
                      <label style={labelSm}>Price</label>
                      <input type="number" step="any" value={editAvgPrice} onChange={e => setEditAvgPrice(e.target.value)} style={inputSm} />
                    </div>
                    <div>
                      <label style={labelSm}>Quantity</label>
                      <input type="number" value={editQtyTotal} onChange={e => setEditQtyTotal(e.target.value)} style={inputSm} />
                    </div>
                    <div>
                      <label style={labelSm}>Value</label>
                      <div style={readonlyBox}>{fmtVal(entryValue)}</div>
                    </div>
                  </div>
                </div>

                {/* ── Exit Section ── */}
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#e6edf3', marginBottom: '8px' }}>
                    Exit ({exitSideLabel})
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.65fr 1.1fr', gap: '8px' }}>
                    <div>
                      <label style={labelSm}>Price</label>
                      <input type="number" step="any" value={editExitPrice} onChange={e => setEditExitPrice(e.target.value)} style={inputSm} />
                    </div>
                    <div>
                      <label style={labelSm}>Quantity <span style={{ fontSize: '0.48rem', color: '#484f58' }}>(auto)</span></label>
                      <div style={readonlyBox}>{editQtyTotal}</div>
                    </div>
                    <div>
                      <label style={labelSm}>Value</label>
                      <div style={readonlyBox}>{fmtVal(exitValue)}</div>
                    </div>
                  </div>
                </div>

                {/* Brokerage & Settlement row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                  <div>
                    <label style={labelSm}>Brokerage</label>
                    <input type="number" step="any" value={editBrokerage} onChange={e => setEditBrokerage(e.target.value)} style={inputSm} />
                  </div>
                  <div>
                    <label style={labelSm}>Segment</label>
                    <input type="text" value={editSettlement} onChange={e => setEditSettlement(e.target.value)} placeholder="e.g. STOCKS" style={inputSm} />
                  </div>
                </div>

                {/* ── Realized P&L ── */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ ...labelSm, marginBottom: '6px' }}>Realized P&L</label>
                  <div style={{
                    padding: '14px 16px',
                    borderRadius: '10px',
                    border: `1.5px solid ${isPositive ? '#23895540' : '#da363340'}`,
                    background: isPositive ? 'rgba(35, 134, 54, 0.06)' : 'rgba(218, 54, 51, 0.06)',
                    textAlign: 'center',
                    fontSize: '1.35rem',
                    fontWeight: 800,
                    fontVariantNumeric: 'tabular-nums',
                    color: isPositive ? '#3fb950' : '#f85149',
                    letterSpacing: '-0.3px',
                  }}>
                    {netPnl.toFixed(2)}
                  </div>
                  {brok > 0 && (
                    <div style={{ fontSize: '0.65rem', color: '#6e7681', marginTop: '4px', textAlign: 'center' }}>
                      Gross: {rawPnl >= 0 ? '+' : ''}{rawPnl.toFixed(2)} | Brokerage: -{brok.toFixed(2)}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Status selection */}
                <div style={{ marginBottom: '8px' }}>
                  <label style={labelSm}>Status</label>
                  <select
                    value={editStatus === 'active' ? 'open' : editStatus}
                    onChange={e => setEditStatus(e.target.value as any)}
                    style={{ ...inputSm, appearance: 'auto', cursor: 'pointer' }}
                  >
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>

                {/* SL / TP Row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                  <div>
                    <label style={labelSm}>SL</label>
                    <input type="number" value={editSl} onChange={e => setEditSl(e.target.value)} placeholder="–" style={inputSm} />
                  </div>
                  <div>
                    <label style={labelSm}>TP</label>
                    <input type="number" value={editTp} onChange={e => setEditTp(e.target.value)} placeholder="–" style={inputSm} />
                  </div>
                </div>

                {/* ── Entry Section ── */}
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#e6edf3', marginBottom: '8px' }}>
                    Entry ({entrySideLabel})
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.65fr 1.1fr', gap: '8px' }}>
                    <div>
                      <label style={labelSm}>Price</label>
                      <input type="number" step="any" value={editAvgPrice} onChange={e => setEditAvgPrice(e.target.value)} style={inputSm} />
                    </div>
                    <div>
                      <label style={labelSm}>Qty Open</label>
                      <input type="number" value={editQtyOpen} onChange={e => setEditQtyOpen(e.target.value)} style={inputSm} />
                    </div>
                    <div>
                      <label style={labelSm}>Value</label>
                      <div style={readonlyBox}>
                        {fmtVal((parseFloat(editAvgPrice) || 0) * (parseFloat(editQtyOpen) || 0))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Exit Section (LTP) ── */}
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#e6edf3', marginBottom: '8px' }}>
                    Exit (LTP)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.65fr 1.1fr', gap: '8px' }}>
                    <div>
                      <label style={labelSm}>LTP</label>
                      <div style={readonlyBox}>
                        {(editPos.ltp ?? editPos.avgPrice ?? 0).toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <label style={labelSm}>Quantity <span style={{ fontSize: '0.48rem', color: '#484f58' }}>(auto)</span></label>
                      <div style={readonlyBox}>{editQtyOpen}</div>
                    </div>
                    <div>
                      <label style={labelSm}>Value</label>
                      <div style={readonlyBox}>
                        {fmtVal((editPos.ltp ?? editPos.avgPrice ?? 0) * (parseFloat(editQtyOpen) || 0))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Brokerage & Qty Total row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                  <div className="adm-sheet-field" style={{ marginBottom: 0 }}>
                    <label className="adm-sheet-label">Brokerage</label>
                    <input className="adm-sheet-input" type="number" step="any" value={editBrokerage} onChange={e => setEditBrokerage(e.target.value)} />
                  </div>
                  <div className="adm-sheet-field" style={{ marginBottom: 0 }}>
                    <label className="adm-sheet-label">Qty Total</label>
                    <input className="adm-sheet-input" type="number" value={editQtyTotal} onChange={e => setEditQtyTotal(e.target.value)} />
                  </div>
                </div>

                {/* ── Active P&L Preview ── */}
                {(() => {
                  const entryPrice = parseFloat(editAvgPrice) || 0;
                  const ltp = editPos.ltp ?? editPos.avgPrice ?? 0;
                  const qtyOpen = parseFloat(editQtyOpen) || 0;
                  const brokerage = parseFloat(editBrokerage) || 0;
                  const rawPnl = editSide === 'BUY'
                    ? (ltp - entryPrice) * qtyOpen
                    : (entryPrice - ltp) * qtyOpen;
                  const netPnl = rawPnl - brokerage;
                  const isPositive = netPnl >= 0;

                  return (
                    <div style={{ marginBottom: '16px', marginTop: '6px' }}>
                      <label style={{ ...labelSm, marginBottom: '6px' }}>Active P&L Preview (Based on LTP)</label>
                      <div style={{
                        padding: '14px 16px',
                        borderRadius: '10px',
                        border: `1.5px solid ${isPositive ? '#23895540' : '#da363340'}`,
                        background: isPositive ? 'rgba(35, 134, 54, 0.06)' : 'rgba(218, 54, 51, 0.06)',
                        textAlign: 'center',
                        fontSize: '1.35rem',
                        fontWeight: 800,
                        fontVariantNumeric: 'tabular-nums',
                        color: isPositive ? '#3fb950' : '#f85149',
                        letterSpacing: '-0.3px',
                      }}>
                        {isPositive ? '+' : ''}{netPnl.toFixed(2)}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}

            {/* Footer buttons — matches competitor layout */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }}>
              <button
                onClick={() => setEditPos(null)}
                style={{
                  padding: '8px 20px', borderRadius: '8px', fontSize: '0.78rem', fontWeight: 600,
                  background: '#21262d', border: '1px solid #30363d', color: '#c9d1d9', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleEdit}
                style={{
                  padding: '8px 20px', borderRadius: '8px', fontSize: '0.78rem', fontWeight: 600,
                  background: '#238636', border: '1px solid #2ea043', color: '#ffffff', cursor: 'pointer',
                }}
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      <div className="adm-pos-stats-grid">
        <div className="adm-pos-stat-card">
          <div className="adm-pos-stat-label">USER</div>
          <div className="adm-pos-stat-value" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {uid ? (selectedUser.full_name || selectedUser.client_id || selectedUser.email || (uid.length > 12 ? uid.slice(0, 12) + '...' : uid)).toUpperCase() : 'None'}
            {onOpenUserPanel && (
              <button 
                onClick={onOpenUserPanel} 
                style={{ 
                  background: '#161b22', border: '1px solid #30363d', color: '#4493f8', 
                  fontSize: '11px', cursor: 'pointer', padding: '2px 8px', borderRadius: '4px' 
                }}
              >
                Change
              </button>
            )}
            <button
              onClick={() => { setShowClearHistoryModal(true); setClearInputText(''); }}
              style={{
                background: 'rgba(218, 54, 51, 0.15)',
                border: '1px solid #f85149',
                color: '#f85149',
                fontSize: '11px',
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: '4px',
                fontWeight: 600,
                marginLeft: 'auto'
              }}
            >
              {!uid || uid === 'all' ? 'Clear History (All Users)' : 'Clear History'}
            </button>
          </div>
        </div>
        <div className="adm-pos-stat-card">
          <div className="adm-pos-stat-label">{tab === 'open' ? 'OPEN PNL' : 'REALIZED PNL'}</div>
          <div className={`adm-pos-stat-value ${totalPnl >= 0 ? 'pos' : 'neg'}`}>{(totalPnl ?? 0).toFixed(2)}</div>
        </div>
        {tab === 'closed' && (
          <div className="adm-pos-stat-card">
            <div className="adm-pos-stat-label" style={{ color: '#f85149' }}>TOTAL SETTLEMENT</div>
            <div className="adm-pos-stat-value" style={{ color: '#f85149' }}>-{(totalSettlement ?? 0).toFixed(2)}</div>
          </div>
        )}
        <div className="adm-pos-stat-card">
          <div className="adm-pos-stat-label">PROFIT RATE</div>
          <div className="adm-pos-stat-value pos">{winRate}</div>
        </div>
        <div className="adm-pos-stat-card">
          <div className="adm-pos-stat-label">LOSS RATE</div>
          <div className="adm-pos-stat-value neg">{lossRate}</div>
        </div>
        <div className="adm-pos-stat-card">
          <div className="adm-pos-stat-label">BROKERAGE</div>
          <div className="adm-pos-stat-value" style={{ color: '#8b949e' }}>{(totalBrokerage ?? 0).toFixed(2)}</div>
        </div>
        <div className="adm-pos-stat-card">
          <div className="adm-pos-stat-label">TRADES</div>
          <div className="adm-pos-stat-value" style={{ color: '#c9d1d9' }}>{totalTrades}</div>
        </div>
      </div>

      <div className="adm-pos-tabs">
        {(['open', 'closed'] as const).map(t => (
          <button key={t} className={`adm-pos-tab ${tab === t ? 'active' : ''}`} onClick={() => switchTab(t)}>
            {t === 'open' ? 'Open Position' : 'Closed Position'}
          </button>
        ))}
      </div>

      <>
          {/* Backdrop to close any open role dropdown */}
          {openRoleDropdown && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setOpenRoleDropdown(null)} />
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '0 0 4px 0' }}>
            {[
              { key: 'admin',  label: 'Admin',  roles: ['admin', 'super_admin'], color: '#f0883e', icon: 'fa-shield-alt' },
              { key: 'broker', label: 'Broker', roles: ['broker'],               color: '#a371f7', icon: 'fa-briefcase'  },
              { key: 'user',   label: 'Users',  roles: ['user'],                  color: '#3fb950', icon: 'fa-users'      },
            ].map(({ key, label, roles, color, icon }) => {
              let roleUsers = allUsers.filter(u => roles.includes(u.role));
              
              if (key === 'user') {
                const selectedBrokers = allUsers.filter(u => u.role === 'broker' && selectedUserIds.has(u.id)).map(u => u.id);
                if (selectedBrokers.length > 0) {
                  roleUsers = roleUsers.filter(u => selectedBrokers.includes(u.parent_id));
                }
              }

              const selectedRoleUserIds = roleUsers.filter(u => selectedUserIds.has(u.id)).map(u => u.id);
              const isActive = selectedRoleUserIds.length > 0;
              const isOpen   = openRoleDropdown === key;
              
              const filteredDropdownUsers = roleUsers.filter(u => {
                const q = dropdownSearch.toLowerCase();
                return (u.full_name || '').toLowerCase().includes(q) || 
                       (u.client_id || '').toLowerCase().includes(q) || 
                       (u.email || '').toLowerCase().includes(q);
              });

              return (
                <div key={key} style={{ position: 'relative' }}>
                  {/* Trigger button */}
                  <button
                    onClick={() => {
                      if (!isOpen) setDropdownSearch('');
                      setOpenRoleDropdown(isOpen ? null : key);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '6px 12px', borderRadius: '8px', cursor: 'pointer',
                      fontSize: '0.78rem', fontWeight: 600,
                      background: isActive ? `${color}22` : 'rgba(255,255,255,0.05)',
                      border: `1px solid ${isActive ? color : 'rgba(255,255,255,0.1)'}`,
                      color: isActive ? color : '#8b949e',
                      transition: 'all 0.15s',
                    }}
                  >
                    <i className={`fas ${icon}`} style={{ fontSize: '11px' }} />
                    {label}
                    {isActive && (
                      <span style={{
                        background: color,
                        color: '#fff',
                        borderRadius: '10px', fontSize: '10px',
                        padding: '1px 6px', fontWeight: 700,
                        transition: 'all 0.15s',
                      }}>
                        {selectedRoleUserIds.length}
                      </span>
                    )}
                    <i
                      className={`fas fa-chevron-${isOpen ? 'up' : 'down'}`}
                      style={{ fontSize: '9px', opacity: 0.6 }}
                    />
                  </button>

                  {/* Dropdown */}
                  {isOpen && (
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 6px)', left: 0,
                      background: '#161b22', border: '1px solid #30363d',
                      borderRadius: '10px', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                      zIndex: 1000, minWidth: '220px', overflow: 'hidden',
                    }}>
                      {/* Dropdown header */}
                      <div style={{
                        padding: '10px 14px 8px',
                        borderBottom: '1px solid #21262d',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}>
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#8b949e', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
                          <i className={`fas ${icon}`} style={{ marginRight: '6px', color }} />
                          {label}
                        </span>
                        {isActive && (
                          <button
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              setSelectedUserIds(prev => { 
                                const n = new Set(prev); 
                                roleUsers.forEach(u => n.delete(u.id)); 
                                return n; 
                              }); 
                            }}
                            style={{ background: 'none', border: 'none', color: '#f85149', fontSize: '10px', cursor: 'pointer', fontWeight: 600, padding: 0 }}
                          >
                            Clear
                          </button>
                        )}
                      </div>

                      {/* Search bar */}
                      <div style={{ padding: '8px 10px', borderBottom: '1px solid #21262d' }}>
                        <input
                           type="text"
                           placeholder={`Search ${label}...`}
                           value={dropdownSearch}
                           onChange={e => setDropdownSearch(e.target.value)}
                           style={{ width: '100%', padding: '6px 10px', borderRadius: '6px', background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3', fontSize: '0.75rem', outline: 'none' }}
                        />
                      </div>
                      
                      {/* Select All */}
                      <div
                         onClick={() => {
                            setSelectedUserIds(prev => {
                               const n = new Set(prev);
                               const allSelected = selectedRoleUserIds.length === roleUsers.length;
                               if (allSelected) {
                                  roleUsers.forEach(u => n.delete(u.id));
                               } else {
                                  roleUsers.forEach(u => n.add(u.id));
                               }
                               return n;
                            });
                         }}
                         style={{ padding: '8px 14px', cursor: 'pointer', borderBottom: '1px solid #21262d', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.02)' }}
                      >
                          <div style={{
                            width: '14px', height: '14px', borderRadius: '3px', flexShrink: 0,
                            border: `1.5px solid ${selectedRoleUserIds.length === roleUsers.length && roleUsers.length > 0 ? color : '#30363d'}`,
                            background: selectedRoleUserIds.length === roleUsers.length && roleUsers.length > 0 ? color : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}>
                            {selectedRoleUserIds.length === roleUsers.length && roleUsers.length > 0 && <i className="fas fa-check" style={{ fontSize: '8px', color: '#fff' }} />}
                          </div>
                          <span style={{ fontSize: '0.75rem', color: '#e6edf3', fontWeight: 600 }}>Select All</span>
                      </div>

                      {/* List of users */}
                      <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                         {filteredDropdownUsers.length === 0 ? (
                            <div style={{ padding: '12px', textAlign: 'center', color: '#8b949e', fontSize: '0.75rem' }}>No users found.</div>
                         ) : filteredDropdownUsers.map(u => {
                            const isChecked = selectedUserIds.has(u.id);
                            return (
                               <div
                                  key={u.id}
                                  onClick={() => {
                                     setSelectedUserIds(prev => {
                                        const n = new Set(prev);
                                        if (n.has(u.id)) n.delete(u.id); else n.add(u.id);
                                        return n;
                                     });
                                  }}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: '8px',
                                    padding: '8px 14px', cursor: 'pointer',
                                    background: isChecked ? `${color}12` : 'transparent',
                                    borderBottom: '1px solid rgba(255,255,255,0.03)'
                                  }}
                               >
                                 {/* Checkbox */}
                                 <div style={{
                                    width: '14px', height: '14px', borderRadius: '3px', flexShrink: 0,
                                    border: `1.5px solid ${isChecked ? color : '#30363d'}`,
                                    background: isChecked ? color : 'transparent',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                                  }}>
                                    {isChecked && <i className="fas fa-check" style={{ fontSize: '8px', color: '#fff' }} />}
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <span style={{ fontSize: '0.75rem', color: '#e6edf3', fontWeight: 500 }}>{u.full_name || u.email}</span>
                                    <span style={{ fontSize: '0.65rem', color: '#8b949e' }}>{u.client_id || u.email}</span>
                                  </div>
                               </div>
                            )
                         })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Clear all filters */}
            {selectedUserIds.size > 0 && (
              <button
                onClick={() => setSelectedUserIds(new Set())}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '6px 10px', borderRadius: '8px', cursor: 'pointer',
                  fontSize: '0.75rem', fontWeight: 600,
                  background: 'rgba(248,81,73,0.1)',
                  border: '1px solid rgba(248,81,73,0.3)',
                  color: '#f85149',
                }}
              >
                <i className="fas fa-times" style={{ fontSize: '10px' }} />
                Clear filters
              </button>
            )}
          </div>
        </>

      <div className="adm-ord-search-wrap" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
          <i className="fas fa-search adm-ord-search-icon" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
          <input className="adm-ord-search" placeholder="Search by user or symbol" value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }} style={{ width: '100%', paddingLeft: '36px' }} />
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input 
            type="date" 
            className="adm-ord-search" 
            value={startDate} 
            onChange={e => { setStartDate(e.target.value); setPage(1); }}
            title="Start Date"
          />
          <span style={{ color: '#8b949e' }}>to</span>
          <input 
            type="date" 
            className="adm-ord-search" 
            value={endDate} 
            onChange={e => { setEndDate(e.target.value); setPage(1); }}
            title="End Date"
          />
          {(startDate || endDate) && (
            <button 
              onClick={() => { setStartDate(''); setEndDate(''); setPage(1); }}
              style={{ background: 'transparent', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: '12px' }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="adm-ord-controls">
        <div className="adm-ord-rows-wrap">
          <span className="adm-ord-rows-label">Rows</span>
          <select className="adm-ord-rows-select" value={rows} onChange={e => { setRows(e.target.value); setPage(1); }}>
            {['10', '25', '50', '100'].map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <button className="adm-ord-download"><i className="fas fa-download" /> Download Excel</button>

      <div className="adm-ord-list" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {posLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div className="adm-pos-card" key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <SkeletonLine width={100} height={14} />
                  <SkeletonLine width={160} height={11} />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <SkeletonLine width={40} height={22} style={{ borderRadius: 4 }} />
                  <SkeletonLine width={60} height={22} style={{ borderRadius: 4 }} />
                </div>
              </div>
              <SkeletonLine width="100%" height={1} style={{ background: '#21262d' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                {Array.from({ length: 8 }).map((_, j) => <SkeletonLine key={j} height={12} width="70%" />)}
              </div>
            </div>
          ))
        ) : displayed.length === 0 ? (
          <div className="adm-mw-empty">No positions found.</div>
        ) : displayed.map((p, i) => (
          <div className="adm-pos-card" key={i}>
            <div className="adm-pos-card-header">
              <div className="adm-pos-card-title-group">
                <span className="adm-pos-card-symbol">{p.symbol}</span>
                <span className={`adm-pos-side-badge ${p.side === 'BUY' ? 'buy' : 'sell'}`}>{p.side}</span>
                {!uid && (
                  <span style={{ marginLeft: 8, fontSize: '11px', color: '#8b949e', background: '#21262d', padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' }}>
                    {p.client_id || p.user_name || p.user_id?.slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="adm-pos-card-pnl-group">
                <span className={`adm-pos-pnl-badge ${p.pnl >= 0 ? 'pos' : 'neg'}`}>
                  {p.pnl >= 0 ? '+' : ''}{(p.pnl ?? 0).toFixed(2)}
                </span>
              </div>
            </div>
            
            <div className="adm-pos-card-grid">
              <div className="adm-pos-card-metric">
                <span className="adm-pos-metric-label">Qty</span>
                <span className="adm-pos-metric-value">{p.qty}</span>
              </div>
              <div className="adm-pos-card-metric">
                <span className="adm-pos-metric-label">Avg Price</span>
                <span className="adm-pos-metric-value">{(p.avgPrice ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="adm-pos-card-metric">
                <span className="adm-pos-metric-label">Entry Price</span>
                <span className="adm-pos-metric-value">{(p.entry ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="adm-pos-card-metric">
                {tab !== 'closed' ? (
                  <>
                    <span className="adm-pos-metric-label">LTP</span>
                    <span className="adm-pos-metric-value ltp">{(p.ltp ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </>
                ) : (
                  <>
                    <span className="adm-pos-metric-label">Exit Price</span>
                    <span className="adm-pos-metric-value">{(p.exit ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </>
                )}
              </div>
              <div className="adm-pos-card-metric">
                <span className="adm-pos-metric-label">Duration</span>
                <span className="adm-pos-metric-value">{p.duration}</span>
              </div>
              <div className="adm-pos-card-metric">
                <span className="adm-pos-metric-label">Brokerage</span>
                <span className="adm-pos-metric-value">{(p.brokerage ?? 0).toFixed(2)}</span>
              </div>
              <div className="adm-pos-card-metric col-span-2">
                <span className="adm-pos-metric-label">SL / TP</span>
                <span className="adm-pos-metric-value">{p.slTp}</span>
              </div>
              {tab === 'closed' && (
                <>
                  <div className="adm-pos-card-metric col-span-2">
                    <span className="adm-pos-metric-label">Settlement</span>
                    <span className="adm-pos-metric-value settlement">{p.settlement || '-'}</span>
                  </div>
                  {p.settlementAmount && p.settlementAmount > 0 ? (
                    <div className="adm-pos-card-metric col-span-2">
                      <span className="adm-pos-metric-label" style={{ color: '#f85149' }}>Settlement Deficit</span>
                      <span className="adm-pos-metric-value" style={{ color: '#f85149', fontWeight: 600 }}>-₹{p.settlementAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  ) : null}
                  {p.closed_by && (
                    <div className="adm-pos-card-metric col-span-2">
                      <span className="adm-pos-metric-label">Closed By</span>
                      <span className="adm-pos-metric-value" style={{ background: '#30363d', padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>{p.closed_by.replace(/_/g, ' ')}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="adm-pos-card-footer">
              <div className="adm-pos-time-group">
                <div className="adm-pos-time-row">
                  <span className="adm-pos-time-label">Entry:</span>
                  <span className="adm-pos-time-value">{p.entryTime}</span>
                </div>
                {tab === 'closed' && (
                  <div className="adm-pos-time-row">
                    <span className="adm-pos-time-label">Exit:</span>
                    <span className="adm-pos-time-value">{p.exitTime}</span>
                  </div>
                )}
              </div>

              <div className="adm-pos-actions-group">
                {tab === 'open' && (
                  <>
                    <button className="adm-pos-btn-sqoff" onClick={() => handleSqoff(p.id)}>Square Off</button>
                    <button className="adm-pos-btn-edit" onClick={() => openEdit(p)}>Edit</button>
                    <button className="adm-pos-btn-delete" onClick={() => setConfirmDeleteId(p.id)}>Delete</button>
                  </>
                )}
                {tab === 'closed' && (
                  <>
                    <button className="adm-pos-btn-edit" onClick={() => openEdit(p)}>Edit</button>
                    <button className="adm-pos-btn-reopen" onClick={() => handleReopen(p)}>Reopen</button>
                    <button className="adm-pos-btn-delete" onClick={() => setConfirmDeleteId(p.id)}>Delete</button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="adm-pos-pagination">
        <span className="adm-pos-page-info">Page {page} of {totalPages}</span>
        <div className="adm-pos-page-btns">
          <button className="adm-pos-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <button className="adm-pos-page-btn active-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      </div>

      {showClearHistoryModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex',
          alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)'
        }}>
          <div style={{
            background: '#161b22', border: '1px solid #30363d', borderRadius: '12px',
            padding: '24px', maxWidth: '480px', width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
          }}>
            <h3 style={{ color: '#f85149', marginTop: 0, marginBottom: '12px', fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <i className="fas fa-exclamation-triangle"></i> Clear Trading History
            </h3>
            <p style={{ color: '#c9d1d9', fontSize: '0.86rem', lineHeight: '1.5', marginBottom: '16px' }}>
              Clear trading history for {!uid || uid === 'all' ? <strong>ALL accounts</strong> : 'this account'}? This will remove historical closed positions and historical trading records from the History view. It will <strong>NOT</strong> change wallet balance, ledger transactions, realized P&amp;L, open positions, or pending orders.
            </p>
            <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
              <p style={{ color: '#8b949e', fontSize: '0.8rem', margin: '0 0 8px 0' }}>
                Type <strong>CLEAR</strong> below to confirm:
              </p>
              <input
                type="text"
                value={clearInputText}
                onChange={e => setClearInputText(e.target.value)}
                placeholder="CLEAR"
                style={{
                  width: '100%', padding: '8px 12px', background: '#161b22',
                  border: '1px solid #30363d', borderRadius: '6px', color: '#f0f6fc',
                  fontSize: '0.9rem', outline: 'none'
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button
                onClick={() => { setShowClearHistoryModal(false); setClearInputText(''); }}
                disabled={clearHistoryLoading}
                style={{
                  padding: '8px 16px', background: '#21262d', border: '1px solid #30363d',
                  borderRadius: '6px', color: '#c9d1d9', cursor: 'pointer', fontSize: '0.85rem'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleClearHistory}
                disabled={clearInputText !== 'CLEAR' || clearHistoryLoading}
                style={{
                  padding: '8px 16px',
                  background: clearInputText === 'CLEAR' ? '#da3633' : '#484f58',
                  border: 'none', borderRadius: '6px', color: '#ffffff',
                  cursor: clearInputText === 'CLEAR' ? 'pointer' : 'not-allowed',
                  fontSize: '0.85rem', fontWeight: 600, opacity: clearHistoryLoading ? 0.6 : 1
                }}
              >
                {clearHistoryLoading ? 'Clearing...' : 'Confirm Clear History'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ height: 24 }} />
    </div>
  );
}
