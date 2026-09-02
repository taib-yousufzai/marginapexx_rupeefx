'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { signOut } from '@/lib/auth';
import { apiCall, Toast, ToastState, ConfirmDialog } from './AdminUtils';
import { sanitizeOrderInfo } from '@/lib/trading/orderSanitizer';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Order = {
  id: string;
  user_id: string;
  user_name?: string;
  user_client_id?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'EXECUTED' | 'CANCELLED' | 'REJECTED' | 'PENDING';
  qty: number;
  price: number;
  orderType: 'MARKET' | 'LIMIT';
  info: string;
  time: string;
};

type ViewMode = 'user' | 'global';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

function exportToCsv(orders: Order[], filename = 'orders.csv') {
  const headers = ['Symbol', 'User ID', 'Side', 'Status', 'Qty', 'Price', 'Type', 'Info', 'Time'];
  const rows = orders.map(o => [
    o.symbol,
    o.user_id,
    o.side,
    o.status,
    o.qty,
    o.price.toFixed(2),
    o.orderType,
    `"${o.info.replace(/"/g, "'")}"`,
    o.time,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OrdersPage({ selectedUser, onOpenUserPanel, isDemoMode }: { 
  selectedUser: { id: string; role: string; client_id?: string }, 
  onOpenUserPanel?: () => void,
  isDemoMode: boolean
}) {
  // Tab / view state
  const [tab, setTab] = useState<'executed' | 'limit' | 'rejected' | 'pending'>('executed');
  const [viewMode, setViewMode] = useState<ViewMode>('user');

  // Filters
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState('50');
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Data
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Toast / dialogs
  const [toast, setToast] = useState<ToastState>(null);
  const [confirmDialog, setConfirmDialog] = useState<'squareOff' | 'cancelAll' | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const uid = selectedUser.id;
  const isGlobal = viewMode === 'global';

  // ── Fetch orders ────────────────────────────────────────────────────────────

  const fetchOrders = useCallback(() => {
    const hasUser = uid && !isGlobal;
    const query = `tab=${encodeURIComponent(tab)}&rows=${rows}&page=${page}${dateFrom ? `&dateFrom=${dateFrom}` : ''}${dateTo ? `&dateTo=${dateTo}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}&demo=${String(isDemoMode)}`;
    
    const endpoint = isGlobal
      ? `/api/admin/orders?${query}`
      : uid
        ? `/api/admin/users/${uid}/orders?${query}`
        : null;

    if (!endpoint) return;
    if (!isGlobal && !uid) return;

    setLoading(true);
    apiCall(endpoint, { method: 'GET' })
      .then(({ ok, status, data }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Failed to load orders', type: 'error' }); return; }

        // Both user and global endpoints return { orders, total }
        const rawOrders = (data as { orders: Record<string, unknown>[]; total: number }).orders ?? [];
        const rawTotal  = (data as { orders: Record<string, unknown>[]; total: number }).total ?? rawOrders.length;

        const items = (rawOrders as {
          id: string; user_id?: string; user_name?: string; user_client_id?: string; symbol: string; side: string; status: string;
          qty: number; price: number; order_type: string; info: string; created_at?: string; time?: string;
        }[]).map(r => ({
          id: r.id,
          user_id: r.user_id ?? uid,
          user_name: r.user_name ?? '',
          user_client_id: r.user_client_id ?? '',
          symbol: r.symbol,
          side: r.side as Order['side'],
          status: r.status as Order['status'],
          qty: r.qty,
          price: r.price,
          orderType: r.order_type as Order['orderType'],
          info: sanitizeOrderInfo(r.info) ?? '',
          time: r.created_at ?? r.time ?? '',
        }));

        setOrders(items);
        setTotal(rawTotal);
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, tab, rows, page, dateFrom, dateTo, search, isGlobal, refreshKey]);

  useEffect(() => {
    setTimeout(() => fetchOrders(), 0);
  }, [fetchOrders]);

  // ── Emergency actions ───────────────────────────────────────────────────────

  const handleSquareOffAll = async () => {
    setActionLoading(true);
    try {
      const { ok, data } = await apiCall('/api/admin/orders/square-off-all', { method: 'POST' });
      if (!ok) { setToast({ message: 'Square-off failed', type: 'error' }); return; }
      const count = (data as { squaredOff: number })?.squaredOff ?? 0;
      setToast({ message: `${count} positions squared off`, type: 'success' });
      setRefreshKey(k => k + 1);
    } catch {
      setToast({ message: 'Network error', type: 'error' });
    } finally {
      setActionLoading(false);
      setConfirmDialog(null);
    }
  };

  const handleCancelAll = async () => {
    setActionLoading(true);
    try {
      const { ok, data } = await apiCall('/api/admin/orders/cancel-all', { method: 'POST' });
      if (!ok) { setToast({ message: 'Cancel-all failed', type: 'error' }); return; }
      const count = (data as { cancelled: number })?.cancelled ?? 0;
      setToast({ message: `${count} orders cancelled`, type: 'success' });
      setRefreshKey(k => k + 1);
    } catch {
      setToast({ message: 'Network error', type: 'error' });
    } finally {
      setActionLoading(false);
      setConfirmDialog(null);
    }
  };

  // ── Derived stats ───────────────────────────────────────────────────────────

  const buyCount  = orders.filter(o => o.side === 'BUY').length;
  const sellCount = orders.filter(o => o.side === 'SELL').length;
  const totalPages = Math.max(1, Math.ceil(total / Number(rows)));

  const tabs = [
    { key: 'executed', label: 'Executed' },
    { key: 'pending',  label: 'Pending' },
    { key: 'limit',    label: 'Limit / Cancelled' },
    { key: 'rejected', label: 'Rejected' },
  ] as const;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="adm-ord-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* Confirm dialogs */}
      {confirmDialog === 'squareOff' && (
        <ConfirmDialog
          message="SQUARE OFF ALL — This will force-close every open position across the entire platform. This action cannot be undone."
          onConfirm={handleSquareOffAll}
          onCancel={() => setConfirmDialog(null)}
          loading={actionLoading}
        />
      )}
      {confirmDialog === 'cancelAll' && (
        <ConfirmDialog
          message="CANCEL ALL — This will cancel every pending LIMIT order across the entire platform. This action cannot be undone."
          onConfirm={handleCancelAll}
          onCancel={() => setConfirmDialog(null)}
          loading={actionLoading}
        />
      )}

      {/* ── Header bar ── */}
      <div className="adm-ord-header">
        <div className="adm-ord-header-left">
          <div className="adm-ord-view-toggle">
            <button
              className={`adm-ord-vtab ${viewMode === 'user' ? 'active' : ''}`}
              onClick={() => { setViewMode('user'); setPage(1); }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              {uid ? `User: ${(selectedUser.client_id || uid.slice(0, 8)).toUpperCase()}…` : 'User View'}
              {viewMode === 'user' && onOpenUserPanel && (
                <span
                  onClick={(e) => { e.stopPropagation(); onOpenUserPanel(); }}
                  style={{
                    background: '#161b22', border: '1px solid #30363d', color: '#4493f8',
                    fontSize: '11px', cursor: 'pointer', padding: '2px 6px', borderRadius: '4px'
                  }}
                >
                  Change
                </span>
              )}
            </button>
            <button
              className={`adm-ord-vtab ${viewMode === 'global' ? 'active' : ''}`}
              onClick={() => { setViewMode('global'); setPage(1); }}
            >
              All Platform
            </button>
          </div>
        </div>
        <div className="adm-ord-header-right">
          <button
            className="adm-ord-action-btn danger"
            onClick={() => setConfirmDialog('squareOff')}
            title="Force-close all open positions"
          >
            <i className="fas fa-times-circle" /> Square Off All
          </button>
          <button
            className="adm-ord-action-btn warning"
            onClick={() => setConfirmDialog('cancelAll')}
            title="Cancel all pending limit orders"
          >
            <i className="fas fa-ban" /> Cancel All
          </button>
          <button
            className="adm-ord-action-btn export"
            onClick={() => exportToCsv(orders, `orders-${tab}-${new Date().toISOString().slice(0,10)}.csv`)}
            title="Export current view to CSV"
          >
            <i className="fas fa-file-csv" /> Export CSV
          </button>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="adm-ord-stats">
        <div className="adm-ord-stat">
          <div className="adm-ord-stat-label">TOTAL SHOWN</div>
          <div className="adm-ord-stat-value">{orders.length}{total > orders.length ? ` / ${total}` : ''}</div>
        </div>
        <div className="adm-ord-stat">
          <div className="adm-ord-stat-label">BUY</div>
          <div className="adm-ord-stat-value pos">{buyCount}</div>
        </div>
        <div className="adm-ord-stat">
          <div className="adm-ord-stat-label">SELL</div>
          <div className="adm-ord-stat-value neg">{sellCount}</div>
        </div>
        {isGlobal && (
          <div className="adm-ord-stat">
            <div className="adm-ord-stat-label">PAGE</div>
            <div className="adm-ord-stat-value">{page} / {totalPages}</div>
          </div>
        )}
      </div>

      {/* ── Status tabs ── */}
      <div className="adm-ord-tabs">
        {tabs.map(t => (
          <button
            key={t.key}
            className={`adm-ord-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => { setTab(t.key); setPage(1); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Filters ── */}
      <div className="adm-ord-filters">
        <div className="adm-ord-search-wrap">
          <i className="fas fa-search adm-ord-search-icon" />
          <input
            className="adm-ord-search"
            placeholder="Search symbol…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <div className="adm-ord-date-range">
          <label className="adm-ord-date-label">From</label>
          <input
            type="date"
            className="adm-ord-date"
            value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          />
          <label className="adm-ord-date-label">To</label>
          <input
            type="date"
            className="adm-ord-date"
            value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
          />
          {(dateFrom || dateTo) && (
            <button
              className="adm-ord-date-clear"
              onClick={() => { setDateFrom(''); setDateTo(''); setPage(1); }}
            >
              ✕ Clear
            </button>
          )}
        </div>
        <select className="adm-ord-rows" value={rows} onChange={e => { setRows(e.target.value); setPage(1); }}>
          <option value="25">25 rows</option>
          <option value="50">50 rows</option>
          <option value="100">100 rows</option>
          <option value="200">200 rows</option>
        </select>
        <button className="adm-ord-refresh" onClick={() => setRefreshKey(k => k + 1)} title="Refresh">
          <i className="fas fa-sync-alt" />
        </button>
      </div>

      {/* ── Table ── */}
      <div className="adm-ord-table-wrap">
        <table className="adm-ord-table">
          <thead>
            <tr>
              <th>SYMBOL</th>
              {isGlobal && <th>USER</th>}
              <th>SIDE</th>
              <th>STATUS</th>
              <th>QTY</th>
              <th>PRICE</th>
              <th>TYPE</th>
              <th>INFO</th>
              <th style={{ textAlign: 'right' }}>TIME</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="adm-ord-skeleton-row">
                  <td colSpan={isGlobal ? 9 : 8}>
                    <div className="adm-ord-skeleton-grid" style={{ gridTemplateColumns: `repeat(${isGlobal ? 9 : 8}, 1fr)` }}>
                      {Array.from({ length: isGlobal ? 9 : 8 }).map((__, j) => (
                        <div key={j} className="adm-ord-skeleton-cell" />
                      ))}
                    </div>
                  </td>
                </tr>
              ))
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={isGlobal ? 9 : 8} className="adm-ord-empty">
                  <i className="fas fa-inbox" style={{ fontSize: '2rem', opacity: 0.3, display: 'block', marginBottom: 8 }} />
                  No orders found
                </td>
              </tr>
            ) : orders.map((o, i) => (
              <tr key={o.id ?? i} className={i % 2 === 0 ? 'adm-ord-row-even' : ''}>
                <td><span className="adm-ord-sym-badge">{o.symbol}</span></td>
                {isGlobal && (
                  <td>
                    <span className="adm-ord-user-badge" title={o.user_id}>
                      {o.user_name || o.user_id.slice(0, 8) + '…'}
                    </span>
                    {o.user_client_id && (
                      <div style={{ fontSize: '0.65rem', color: '#8b949e', marginTop: 2 }}>{o.user_client_id}</div>
                    )}
                  </td>
                )}
                <td><span className={`adm-ord-side ${o.side.toLowerCase()}`}>{o.side}</span></td>
                <td><span className={`adm-ord-status ${o.status.toLowerCase()}`}>{o.status}</span></td>
                <td>{o.qty}</td>
                <td>{(o.price ?? 0).toFixed(2)}</td>
                <td><span className="adm-ord-type-badge">{o.orderType}</span></td>
                <td className="adm-ord-info">{sanitizeOrderInfo(o.info) || '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className="adm-ord-time">
                  {formatTime(o.time)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="adm-ord-pagination">
          <button
            className="adm-ord-page-btn"
            disabled={page === 1}
            onClick={() => setPage(1)}
          >
            «
          </button>
          <button
            className="adm-ord-page-btn"
            disabled={page === 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
          >
            ‹
          </button>
          <span className="adm-ord-page-info">Page {page} of {totalPages}</span>
          <button
            className="adm-ord-page-btn"
            disabled={page === totalPages}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          >
            ›
          </button>
          <button
            className="adm-ord-page-btn"
            disabled={page === totalPages}
            onClick={() => setPage(totalPages)}
          >
            »
          </button>
        </div>
      )}
    </div>
  );
}
