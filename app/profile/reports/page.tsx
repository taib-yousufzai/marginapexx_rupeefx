'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';

interface Order {
    id: string;
    symbol: string;
    segment: string;
    side: 'BUY' | 'SELL';
    status: string;
    qty: number;
    fill_price: number;
    order_type: string;
    created_at: string;
}

interface Position {
    id: string;
    symbol: string;
    segment: string;
    side: 'BUY' | 'SELL';
    qty: number;
    entry_price: number;
    exit_price: number | null;
    pnl: number | null;
    status: string;
    created_at: string;
    closed_at: string | null;
    closed_by?: string | null;
}

type Tab = 'pnl' | 'orders';

// ── Fake orders for preview (auto-replaced when real data loads) ──
const FAKE_ORDERS: Order[] = [
    { id: 'f1',  symbol: 'NIFTY FUT',     segment: 'NSE-FUT', side: 'BUY',  status: 'EXECUTED',  qty: 75,  fill_price: 22456.80, order_type: 'MARKET', created_at: new Date(Date.now() -  1 * 86400000).toISOString() },
    { id: 'f2',  symbol: 'NIFTY FUT',     segment: 'NSE-FUT', side: 'SELL', status: 'EXECUTED',  qty: 75,  fill_price: 22650.25, order_type: 'MARKET', created_at: new Date(Date.now() -  2 * 86400000).toISOString() },
    { id: 'f3',  symbol: 'RELIANCE FUT',  segment: 'NSE-FUT', side: 'SELL', status: 'EXECUTED',  qty: 250, fill_price: 2856.40,  order_type: 'LIMIT',  created_at: new Date(Date.now() -  5 * 86400000).toISOString() },
    { id: 'f4',  symbol: 'BANKNIFTY FUT', segment: 'NSE-FUT', side: 'BUY',  status: 'EXECUTED',  qty: 25,  fill_price: 48210.50, order_type: 'MARKET', created_at: new Date(Date.now() - 10 * 86400000).toISOString() },
    { id: 'f5',  symbol: 'BANKNIFTY FUT', segment: 'NSE-FUT', side: 'SELL', status: 'EXECUTED',  qty: 25,  fill_price: 47890.25, order_type: 'MARKET', created_at: new Date(Date.now() - 15 * 86400000).toISOString() },
    { id: 'f6',  symbol: 'GOLD FUT',      segment: 'MCX',     side: 'BUY',  status: 'EXECUTED',  qty: 10,  fill_price: 62340.00, order_type: 'MARKET', created_at: new Date(Date.now() - 22 * 86400000).toISOString() },
    { id: 'f7',  symbol: 'CRUDEOIL FUT',  segment: 'MCX',     side: 'SELL', status: 'CANCELLED', qty: 100, fill_price: 6820.00,  order_type: 'LIMIT',  created_at: new Date(Date.now() - 35 * 86400000).toISOString() },
    { id: 'f8',  symbol: 'BTC/USDT',      segment: 'CRYPTO',  side: 'BUY',  status: 'EXECUTED',  qty: 1,   fill_price: 68450.20, order_type: 'MARKET', created_at: new Date(Date.now() - 50 * 86400000).toISOString() },
    { id: 'f9',  symbol: 'HDFCBANK FUT',  segment: 'NSE-FUT', side: 'BUY',  status: 'EXECUTED',  qty: 550, fill_price: 1680.90,  order_type: 'MARKET', created_at: new Date(Date.now() - 65 * 86400000).toISOString() },
    { id: 'f10', symbol: 'TCS EQ',        segment: 'STOCKS',  side: 'SELL', status: 'EXECUTED',  qty: 20,  fill_price: 3982.50,  order_type: 'LIMIT',  created_at: new Date(Date.now() - 80 * 86400000).toISOString() },
];

// ── Fake positions for preview (auto-replaced when real data loads) ──
const FAKE_POSITIONS: Position[] = [
    { id: 'p1', symbol: 'NIFTY FUT',     segment: 'NSE-FUT', side: 'BUY',  qty: 75,  entry_price: 22456.80, exit_price: 22650.25, pnl:  14508.75, status: 'CLOSED', created_at: new Date(Date.now() -  1 * 86400000).toISOString(), closed_at: new Date(Date.now() -  1 * 86400000 + 3600000).toISOString() },
    { id: 'p2', symbol: 'RELIANCE FUT',  segment: 'NSE-FUT', side: 'SELL', qty: 250, entry_price: 2856.40,  exit_price: 2830.15,  pnl:   6562.50, status: 'CLOSED', created_at: new Date(Date.now() -  5 * 86400000).toISOString(), closed_at: new Date(Date.now() -  5 * 86400000 + 5400000).toISOString() },
    { id: 'p3', symbol: 'BANKNIFTY FUT', segment: 'NSE-FUT', side: 'BUY',  qty: 25,  entry_price: 48210.50, exit_price: 47890.25, pnl:  -8006.25, status: 'CLOSED', created_at: new Date(Date.now() - 12 * 86400000).toISOString(), closed_at: new Date(Date.now() - 12 * 86400000 + 7200000).toISOString() },
    { id: 'p4', symbol: 'GOLD FUT',      segment: 'MCX',     side: 'BUY',  qty: 10,  entry_price: 62340.00, exit_price: 62850.75, pnl:   5107.50, status: 'CLOSED', created_at: new Date(Date.now() - 20 * 86400000).toISOString(), closed_at: new Date(Date.now() - 20 * 86400000 + 3600000).toISOString() },
    { id: 'p5', symbol: 'INFY EQ',       segment: 'STOCKS',  side: 'SELL', qty: 50,  entry_price: 1598.40,  exit_price: 1612.80,  pnl:   -720.00, status: 'CLOSED', created_at: new Date(Date.now() - 28 * 86400000).toISOString(), closed_at: new Date(Date.now() - 28 * 86400000 + 2700000).toISOString() },
    { id: 'p6', symbol: 'BTC/USDT',      segment: 'CRYPTO',  side: 'BUY',  qty: 1,   entry_price: 68450.20, exit_price: 69120.50, pnl:    670.30, status: 'CLOSED', created_at: new Date(Date.now() - 40 * 86400000).toISOString(), closed_at: new Date(Date.now() - 40 * 86400000 + 18000000).toISOString() },
    { id: 'p7', symbol: 'HDFCBANK FUT',  segment: 'NSE-FUT', side: 'SELL', qty: 550, entry_price: 1680.90,  exit_price: 1672.30,  pnl:   4730.00, status: 'CLOSED', created_at: new Date(Date.now() - 55 * 86400000).toISOString(), closed_at: new Date(Date.now() - 55 * 86400000 + 3600000).toISOString() },
    { id: 'p8', symbol: 'TCS EQ',        segment: 'STOCKS',  side: 'BUY',  qty: 20,  entry_price: 3982.50,  exit_price: 4012.30,  pnl:    596.00, status: 'CLOSED', created_at: new Date(Date.now() - 70 * 86400000).toISOString(), closed_at: new Date(Date.now() - 70 * 86400000 + 5400000).toISOString() },
];

export default function ReportsPage() {
    useAuth();
    const [isAdmin, setIsAdmin]     = useState(false);
    const [tab, setTab]             = useState<Tab>('pnl');
    const [orders, setOrders]       = useState<Order[]>([]);
    const [positions, setPositions] = useState<Position[]>([]);
    const [loading, setLoading]     = useState(true);
    const [error, setError]         = useState<string | null>(null);

    const [fromDate, setFromDate] = useState('');
    const [toDate,   setToDate]   = useState('');

    useEffect(() => {
        const sync = () => applyTheme(getSavedTheme());
        sync();
        window.addEventListener('themeChanged', sync);

        // Set default dates on client only (avoids SSR hydration mismatch)
        const today     = new Date().toISOString().split('T')[0];
        const sevenAgo  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        setFromDate(sevenAgo);
        setToDate(today);

        api.get<{ user_metadata?: { role?: string } }>('/api/user/profile').then((data: any) => {
            const role = data?.role;
            if (role === 'admin' || role === 'super_admin') {
                setIsAdmin(true);
            }
        }).catch(() => {});

        return () => window.removeEventListener('themeChanged', sync);
    }, []);

    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [ordersData, positionsData] = await Promise.all([
                api.get<{ orders?: Order[] }>('/api/orders?limit=500'),
                api.get<{ positions?: Position[] }>('/api/positions?status=closed'),
            ]);
            setOrders(ordersData.orders ?? []);
            setPositions(positionsData.positions ?? []);
        } catch {
            setError('Failed to load. Please try again.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    /* ── date range filter ── */
    const inRange = (iso: string) => {
        if (!iso) return false;
        const d  = new Date(iso);
        const fr = new Date(fromDate);
        const to = new Date(toDate); to.setHours(23, 59, 59, 999);
        return d >= fr && d <= to;
    };

    /* ── orders ── */
    const filteredOrders     = orders.filter(o => inRange(o.created_at));
    const filteredFakeOrders = FAKE_ORDERS.filter(o => inRange(o.created_at));
    const displayOrders      = filteredOrders.length > 0 ? filteredOrders : filteredFakeOrders;
    const isFakeOrders       = filteredOrders.length === 0;

    /* ── positions ── */
    // Filter by closed_at or exit_time if available, otherwise fallback to created_at
    const getPosDate = (p: any) => p.exit_time || p.closed_at || p.created_at;
    const closedPositions       = positions.filter(p => (p.status?.toLowerCase() === 'closed' || p.pnl !== null) && inRange(getPosDate(p)));
    const filteredFakePositions = FAKE_POSITIONS.filter(p => inRange(p.created_at));
    const displayPositions      = closedPositions.length > 0 ? closedPositions : filteredFakePositions;
    const isFakePositions       = closedPositions.length === 0;

    /* ── P&L stats — always real data (shows 0 when empty) ── */
    const totalPnl    = closedPositions.reduce((s, p) => s + (p.pnl ?? 0), 0);
    const wins        = closedPositions.filter(p => (p.pnl ?? 0) > 0);
    const losses      = closedPositions.filter(p => (p.pnl ?? 0) < 0);
    const winRate     = closedPositions.length > 0 ? Math.round((wins.length / closedPositions.length) * 100) : 0;
    const bestTrade   = wins.length   > 0 ? Math.max(...wins.map(p => p.pnl ?? 0))   : null;
    const worstTrade  = losses.length > 0 ? Math.min(...losses.map(p => p.pnl ?? 0)) : null;
    const grossProfit = wins.reduce((s, p) => s + (p.pnl ?? 0), 0);
    const grossLoss   = losses.reduce((s, p) => s + (p.pnl ?? 0), 0);

    /* ── formatters ── */
    const fmtAmt  = (n: number) => '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const sign    = (n: number) => n >= 0 ? '+' : '−';

    return (
        <div className="desktop-layout">
                        <main className="main-viewport">
                <div className="rp-root">

            {/* ══ HEADER ══ */}
            <div className="rp-header">
                <div className="rp-header-inner">
                    <Link href="/profile" className="rp-back-btn">
                        <i className="fas fa-arrow-left"></i>
                    </Link>
                    <span className="rp-title">Reports & P&L</span>
                    <button className="rp-refresh-btn" onClick={fetchData} title="Refresh">
                        <i className="fas fa-sync-alt"></i>
                    </button>
                </div>

                {/* Quick chips + date range */}
                <div className="rp-date-row">
                    {([
                        { label: 'Today', days: 0 },
                        { label: '1W',    days: 7 },
                        { label: '1M',    days: 30 },
                        { label: '3M',    days: 90 },
                    ] as { label: string; days: number }[]).map(({ label, days }) => {
                        const f = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
                        const todayStr = new Date().toISOString().split('T')[0];
                        const isActive = fromDate === f && toDate === todayStr;
                        return (
                            <button
                                key={label}
                                className={`rp-chip-btn${isActive ? ' active' : ''}`}
                                onClick={() => { setFromDate(f); setToDate(new Date().toISOString().split('T')[0]); }}
                            >
                                {label}
                            </button>
                        );
                    })}
                    <div className="rp-date-custom">
                        <input type="date" className="rp-date-input" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                        <span className="rp-date-sep">–</span>
                        <input type="date" className="rp-date-input" value={toDate} onChange={e => setToDate(e.target.value)} />
                    </div>
                </div>

                {/* Tabs */}
                <div className="rp-tabs">
                    <button className={`rp-tab ${tab === 'pnl' ? 'active' : ''}`} onClick={() => setTab('pnl')}>
                        <i className="fas fa-chart-line"></i> P&L Report
                    </button>
                    <button className={`rp-tab ${tab === 'orders' ? 'active' : ''}`} onClick={() => setTab('orders')}>
                        <i className="fas fa-receipt"></i> Order History
                    </button>
                </div>
            </div>

            {/* ══ CONTENT ══ */}
            <div className="rp-content">
                {loading ? (
                    <div className="rp-loading">
                        <div className="rp-spinner"></div>
                        <p>Loading…</p>
                    </div>
                ) : error ? (
                    <div className="rp-error">
                        <i className="fas fa-exclamation-circle"></i>
                        <p>{error}</p>
                        <button onClick={fetchData} className="rp-retry-btn">Retry</button>
                    </div>

                ) : tab === 'pnl' ? (
                    <>
                        {/* Net P&L hero */}
                        <div className={`rp-pnl-hero ${totalPnl >= 0 ? 'profit' : 'loss'}`}>
                            <div className="rp-pnl-hero-label">Net P&L</div>
                            <div className="rp-pnl-hero-value">{sign(totalPnl)}{fmtAmt(totalPnl)}</div>
                            <div className="rp-pnl-hero-sub">
                                {closedPositions.length} closed trade{closedPositions.length !== 1 ? 's' : ''}
                            </div>
                        </div>

                        {/* Stats grid */}
                        <div className="rp-stats-grid">
                            <div className="rp-stat-card">
                                <div className="rp-stat-label">Win Rate</div>
                                <div className="rp-stat-value">{winRate}<span className="rp-stat-unit">%</span></div>
                            </div>
                            <div className="rp-stat-card">
                                <div className="rp-stat-label">Trades</div>
                                <div className="rp-stat-value">{closedPositions.length}</div>
                            </div>
                            <div className="rp-stat-card win">
                                <div className="rp-stat-label">Winning</div>
                                <div className="rp-stat-value">{wins.length}</div>
                            </div>
                            <div className="rp-stat-card loss">
                                <div className="rp-stat-label">Losing</div>
                                <div className="rp-stat-value">{losses.length}</div>
                            </div>
                        </div>

                        {/* Breakdown — only show when real data exists */}
                        {closedPositions.length > 0 && (
                            <div className="rp-breakdown">
                                <div className="rp-breakdown-row">
                                    <span className="rp-breakdown-label"><i className="fas fa-arrow-up"></i> Gross Profit</span>
                                    <span className="rp-breakdown-val profit">+{fmtAmt(grossProfit)}</span>
                                </div>
                                <div className="rp-breakdown-row">
                                    <span className="rp-breakdown-label"><i className="fas fa-arrow-down"></i> Gross Loss</span>
                                    <span className="rp-breakdown-val loss">−{fmtAmt(Math.abs(grossLoss))}</span>
                                </div>
                                {bestTrade !== null && (
                                    <div className="rp-breakdown-row">
                                        <span className="rp-breakdown-label"><i className="fas fa-trophy"></i> Best Trade</span>
                                        <span className="rp-breakdown-val profit">+{fmtAmt(bestTrade)}</span>
                                    </div>
                                )}
                                {worstTrade !== null && (
                                    <div className="rp-breakdown-row">
                                        <span className="rp-breakdown-label"><i className="fas fa-exclamation-triangle"></i> Worst Trade</span>
                                        <span className="rp-breakdown-val loss">−{fmtAmt(Math.abs(worstTrade))}</span>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Trade History */}
                        <div className="rp-section-label">Trade History</div>
                        {isFakePositions && (
                            <div className="rp-fake-banner">
                                <i className="fas fa-eye"></i>
                                Sample preview — your real trades will appear here
                            </div>
                        )}
                        <div className={`rp-list${isFakePositions ? ' rp-list-preview' : ''}`}>
                            {displayPositions.map(pos => (
                                <div key={pos.id} className="rp-card">
                                    <div className="rp-card-top">
                                        <div className="rp-card-left">
                                            <span className="rp-symbol">{pos.symbol}</span>
                                            <span className={`rp-badge ${pos.side === 'BUY' ? 'buy' : 'sell'}`}>{pos.side}</span>
                                            <span className="rp-chip">{pos.segment}</span>
                                            {isAdmin && pos.closed_by && (
                                                <span className="rp-chip" style={{ background: '#F1F5F9', color: '#64748B', border: '1px solid #E2E8F0' }}>
                                                    {pos.closed_by.replace(/_/g, ' ')}
                                                </span>
                                            )}
                                        </div>
                                        <span className={`rp-pnl-val ${(pos.pnl ?? 0) >= 0 ? 'pos' : 'neg'}`}>
                                            {sign(pos.pnl ?? 0)}{fmtAmt(pos.pnl ?? 0)}
                                        </span>
                                    </div>
                                    <div className="rp-card-meta">
                                        <span>Qty {pos.qty}</span>
                                        <span>Entry ₹{pos.entry_price?.toLocaleString('en-IN')}</span>
                                        {pos.exit_price != null && <span>Exit ₹{pos.exit_price.toLocaleString('en-IN')}</span>}
                                        <span>{fmtDate(pos.created_at)}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>

                ) : (
                    /* ══ ORDER HISTORY ══ */
                    <>
                        {isFakeOrders ? (
                            <div className="rp-fake-banner">
                                <i className="fas fa-eye"></i>
                                Sample preview — your real orders will appear here
                            </div>
                        ) : (
                            <div className="rp-order-count">
                                {filteredOrders.length} order{filteredOrders.length !== 1 ? 's' : ''} in this period
                            </div>
                        )}

                        <div className={`rp-list${isFakeOrders ? ' rp-list-preview' : ''}`}>
                            {displayOrders.map(order => (
                                <div key={order.id} className="rp-card">
                                    <div className="rp-card-top">
                                        <div className="rp-card-left">
                                            <span className="rp-symbol">{order.symbol}</span>
                                            <span className={`rp-badge ${order.side === 'BUY' ? 'buy' : 'sell'}`}>{order.side}</span>
                                            <span className="rp-chip">{order.segment}</span>
                                        </div>
                                        <span className="rp-order-price">
                                            ₹{order.fill_price?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                                        </span>
                                    </div>
                                    <div className="rp-card-meta">
                                        <span>Qty {order.qty}</span>
                                        <span>{order.order_type}</span>
                                        <span className={`rp-status status-${order.status?.toLowerCase()}`}>{order.status}</span>
                                        <span>{fmtDate(order.created_at)} {fmtTime(order.created_at)}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
        </div>
      </div>
      </main>
    </div>
  );
}
