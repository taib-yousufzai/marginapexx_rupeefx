'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useMyOrders } from '@/hooks/useMyOrders';
import { useKitePositions } from '@/hooks/useKitePositions';
import { useMobileBack } from '@/hooks/useMobileBack';
import { api } from '@/lib/api';

import type { TradeSheetItem } from '@/components/TradeSheet';
const TradeSheet = dynamic(() => import('@/components/TradeSheet'), { ssr: false });
import './page.css';
import dynamic from 'next/dynamic';

const TradingChart = dynamic(() => import('@/components/TradingChart'), { ssr: false });

export default function OrderPage() {
  useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const [tradeSheetItem, setTradeSheetItem] = useState<TradeSheetItem | null>(null);
  const [tradeSheetSide, setTradeSheetSide] = useState<'BUY' | 'SELL' | 'BOTH'>('BOTH');
  const [tradeSheetInitialOrder, setTradeSheetInitialOrder] = useState<any>(null);
  const [modifyingOrderId, setModifyingOrderId] = useState<string | null>(null);

  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [chartItem, setChartItem] = useState<any>(null);

  // ── Mobile Back Button Interception ──
  useMobileBack(isSheetOpen, () => {
    setIsSheetOpen(false);
    const sheet = document.getElementById('orderSheet');
    const overlay = document.getElementById('orderSheetOverlay');
    if (sheet) sheet.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    setTimeout(() => setSelectedOrder(null), 300);
  }, 'orderdetail');

  useMobileBack(!!chartItem, () => {
    setChartItem(null);
    const chartSheet = document.getElementById('chartSheet');
    const chartOverlay = document.getElementById('chartSheetOverlay');
    if (chartSheet) chartSheet.classList.remove('open');
    if (chartOverlay) chartOverlay.classList.remove('active');
  }, 'orderchart');

  useMobileBack(!!tradeSheetItem, () => {
    setTradeSheetItem(null);
  }, 'ordertrade');

  const openChart = (order: any) => {
    setIsSheetOpen(false);
    setSelectedOrder(null);
    setTimeout(() => {
      setChartItem({
        symbol: order.symbol,
        kiteSymbol: order.kite_instrument || order.symbol,
        segment: order.segment
      });
      const chartSheet = document.getElementById('chartSheet');
      const chartOverlay = document.getElementById('chartSheetOverlay');
      if (chartSheet) chartSheet.classList.add('open');
      if (chartOverlay) chartOverlay.classList.add('active');
    }, 80);
  };

  const { orders, loading: ordersLoading, error, cancelOrder, refresh } = useMyOrders();
  const { connected: kiteConnected } = useKitePositions();

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleCancel = async (id: string) => {
    const res = await cancelOrder(id);
    if (res.success) {
      showToast('Order cancelled successfully');
    } else {
      showToast(`Error: ${res.error}`);
    }
  };

  const handleModify = (order: any) => {
    setModifyingOrderId(order.id);
    setTradeSheetSide(order.side);
    setTradeSheetItem({
      name: order.symbol,
      symbol: order.symbol,
      kiteSymbol: order.kite_instrument,
      segment: order.segment,
      price: order.fill_price || 0,
    });
    setTradeSheetInitialOrder({
      qty: order.qty,
      order_type: order.order_type,
      product_type: order.product_type,
      client_price: order.client_price || order.fill_price,
      trigger_price: order.trigger_price,
      stop_loss: order.stop_loss,
      target: order.target,
    });
  };

  const handleTradeAgain = (order: any) => {
    setIsSheetOpen(false);
    setSelectedOrder(null);
    setTimeout(() => {
      router.push(`/watchlist?symbol=${encodeURIComponent(order.symbol)}&action=detail`);
    }, 80);
  };

  const openOrders = orders.filter(o => o.status === 'PENDING');
  const closedOrders = orders.filter(o => o.status !== 'PENDING');

  const activeList = tab === 'open' ? openOrders : closedOrders;
  const filtered = activeList.filter(o =>
    (o.symbol || '').toLowerCase().includes((search || '').toLowerCase())
  );

  const fmtPrice = (val: number | null) => {
    if (val === null || val === undefined) return '---';
    return `₹${val.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  };

  const fmtQty = (val: number) => val.toLocaleString('en-IN');

  const fmtTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const fmtDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div className="desktop-layout">
      
      <main className="main-viewport">
        <div className="app-container">
          <div className="ord-root">
            <div className="ord-shell">

              {/* Header - Mobile Only */}
              <div className="ord-header mobile-only">
                <div className="ord-header-left">
                  <div className="ord-brand">
                    <span>MARGIN<span className="apex-text">APEX</span></span>
                  </div>
                  <div className="ord-brand-sub">Platform Orders • Internal Execution</div>
                </div>
                {kiteConnected ? (
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 700, color: '#059669',
                    background: 'rgba(5,150,105,0.1)', padding: '3px 10px',
                    borderRadius: 20, display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#059669', display: 'inline-block' }} />
                    PRICE FEED LIVE
                  </span>
                ) : (
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 700, color: '#ef4444',
                    background: 'rgba(239,68,68,0.1)', padding: '3px 10px',
                    borderRadius: 20, display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                    PRICE FEED OFF
                  </span>
                )}
              </div>

              {/* Search */}
              <div className="ord-search-wrap">
                <div className="ord-search-box">
                  <i className="fas fa-search ord-search-icon" />
                  <input
                    type="text"
                    className="ord-search-input"
                    placeholder="Search symbol..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                  {search && (
                    <button className="ord-clear-btn" onClick={() => setSearch('')}>
                      <i className="fas fa-times-circle" />
                    </button>
                  )}
                </div>
              </div>

              {/* Tabs */}
              <div className="ord-tabs-wrap">
                <div className="ord-tabs">
                  <div className={`ord-tab${tab === 'open' ? ' active' : ''}`} onClick={() => setTab('open')}>
                    OPEN <span className="ord-tab-badge">{openOrders.length}</span>
                  </div>
                  <div className={`ord-tab${tab === 'closed' ? ' active' : ''}`} onClick={() => setTab('closed')}>
                    CLOSED <span className="ord-tab-badge">{closedOrders.length}</span>
                  </div>
                </div>
              </div>

              {/* List */}
              <div className="ord-list">

                {/* Loading */}
                {ordersLoading && (
                  <div className="w-full flex flex-col gap-3">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className="ord-card animate-pulse" style={{ opacity: 1 - (i * 0.15) }}>
                        <div className="flex justify-between items-start mb-3">
                          <div className="h-5 bg-gray-200 dark:bg-gray-800 rounded w-32"></div>
                          <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-16"></div>
                        </div>
                        <div className="flex justify-between items-center mb-2">
                          <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-20"></div>
                          <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-24"></div>
                        </div>
                        <div className="flex justify-between items-center mb-3">
                          <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-24"></div>
                          <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-28"></div>
                        </div>
                        <div className="flex justify-between items-center pt-3 border-t border-gray-100 dark:border-gray-800">
                          <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded-full w-24"></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Error — only show when we have no orders to display (avoid blanking a stale-but-populated list) */}
                {error && orders.length === 0 && (
                  <div className="ord-empty">
                    <i className="fas fa-exclamation-circle" style={{ color: '#ef4444' }} />
                    <p>{error}</p>
                  </div>
                )}

                {/* Empty List */}
                {!ordersLoading && filtered.length === 0 && (
                  <div className="ord-empty">
                    <i className={search ? 'fas fa-search' : tab === 'open' ? 'fas fa-clock' : 'fas fa-check-circle'} />
                    <p>{search ? `No results for "${search}"` : `No ${tab} orders found`}</p>

                  </div>
                )}

                {/* List of My Orders */}
                {!ordersLoading && filtered.map(order => {
                  const isBuy = order.side === 'BUY';
                  const isExecuted = order.status === 'EXECUTED';
                  const isRejected = order.status === 'REJECTED';
                  const isCancelled = order.status === 'CANCELLED';
                  const isPending = order.status === 'PENDING';

                  return (
                    <div
                      key={order.id}
                      className="ord-card"
                      onClick={() => {
                        if (!isPending) {
                          setSelectedOrder(order);
                          setIsSheetOpen(true);
                        }
                      }}
                      style={{ cursor: !isPending ? 'pointer' : 'default' }}
                    >
                      <div className="ord-row ord-row-top">
                        <span className="ord-symbol">{order.symbol}</span>
                        <span className={`ord-badge ${order.is_exit ? 'short' : (isBuy ? 'long' : 'short')}`}>
                          <i className={`fas fa-arrow-${order.is_exit ? 'up' : 'down'}`} />
                          {order.is_exit ? (isBuy ? 'SELL EXIT' : 'BUY EXIT') : (isBuy ? 'BUY' : 'SELL')}
                        </span>
                      </div>
                      <div className="ord-row ord-row-price">
                        <span className="ord-label">FILL PRICE</span>
                        <span className={`ord-price-val ${isBuy ? 'buy-price' : 'sell-price'}`}>
                          {fmtPrice(order.fill_price)}
                        </span>
                      </div>
                      <div className="ord-row ord-row-info">
                        <div className="ord-info-inline">
                          <span className="ord-label">QTY:</span>
                          <span className="ord-val">{fmtQty(order.qty)} ({Math.round(order.lots)} Lot)</span>
                        </div>
                        <div className="ord-info-inline right">
                          <span className="ord-label">TIME:</span>
                          <span className="ord-val">{fmtTime(order.created_at)}</span>
                        </div>
                      </div>
                      <div className="ord-row ord-row-date">
                        <span className="ord-label">DATE</span>
                        <span className="ord-date-val">{fmtDate(order.created_at)}</span>
                      </div>
                      {/* SL, Target, Trigger info */}
                      {(order.trigger_price || order.stop_loss || order.target) && (
                        <div className="ord-row" style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {order.trigger_price !== undefined && order.trigger_price !== null && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              <span className="ord-label" style={{ fontSize: '0.6rem' }}>TRIG:</span>
                              <span className="ord-val" style={{ fontSize: '0.65rem', fontWeight: 700 }}>{fmtPrice(order.trigger_price)}</span>
                            </div>
                          )}
                          {order.stop_loss !== undefined && order.stop_loss !== null && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              <span className="ord-label" style={{ fontSize: '0.6rem', color: '#dc2626' }}>SL:</span>
                              <span className="ord-val" style={{ fontSize: '0.65rem', fontWeight: 700, color: '#dc2626' }}>{fmtPrice(order.stop_loss)}</span>
                            </div>
                          )}
                          {order.target !== undefined && order.target !== null && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              <span className="ord-label" style={{ fontSize: '0.6rem', color: '#059669' }}>TGT:</span>
                              <span className="ord-val" style={{ fontSize: '0.65rem', fontWeight: 700, color: '#059669' }}>{fmtPrice(order.target)}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Product + variety tags */}
                      <div className="ord-row" style={{ marginTop: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="ord-type-pill" style={{ fontSize: '0.6rem' }}>{order.product_type}</span>
                          {order.info && order.info !== 'Exit - USER' && !order.info.includes('-') && (
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
                              {order.info}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span className="ord-label" style={{ fontSize: '0.6rem', letterSpacing: '0.3px' }}>TYPE:</span>
                          <span className="ord-type-pill" style={{ fontSize: '0.6rem' }}>
                            <i className="fas fa-tag" style={{ fontSize: '7px' }} /> {order.order_type}
                          </span>
                        </div>
                      </div>
                      <div className="ord-row ord-row-status">
                        <div className={`ord-status-text ${isPending ? 'status-open' : isExecuted ? 'status-filled' : isCancelled ? 'status-cancelled' : 'status-rejected'}`}>
                          {isPending && <><i className="fas fa-circle" /> PENDING</>}
                          {isExecuted && <><i className="fas fa-check-circle" /> EXECUTED</>}
                          {isCancelled && <><i className="fas fa-ban" /> CANCELLED</>}
                          {isRejected && <><i className="fas fa-times-circle" /> REJECTED</>}
                        </div>
                        {isPending && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              className="ord-modify-btn"
                              onClick={() => handleModify(order)}
                            >
                              <i className="fas fa-edit" /> Modify
                            </button>
                            <button
                              className="ord-cancel-btn"
                              onClick={() => handleCancel(order.id)}
                            >
                              <i className="fas fa-times" /> Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

                          </div>

            {/* Sheet for Closed Orders */}
            <div className={`ord-sheet-overlay${isSheetOpen ? ' open' : ''}`} onClick={() => setIsSheetOpen(false)} />
            <div className={`ord-sheet${isSheetOpen ? ' open' : ''}${selectedOrder ? ' ord-sheet--closed' : ''}`}>
              <div className="ord-sheet-handle"><div className="ord-sheet-handle-bar" /></div>
              {selectedOrder && (
                <div className="ord-sheet-content">
                  {/* Header row */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '6px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      <div className="os-symbol" style={{ color: 'var(--text-primary, #1A1A1A)', margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>{selectedOrder.symbol}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span className={`ord-badge ${selectedOrder.is_exit ? 'short' : (selectedOrder.side === 'BUY' ? 'long' : 'short')}`} style={{ fontSize: '0.65rem', padding: '2px 8px' }}>
                          <i className={`fas fa-arrow-${selectedOrder.is_exit ? 'up' : 'down'}`} style={{ marginRight: '4px' }} />
                          {selectedOrder.is_exit ? (selectedOrder.side === 'BUY' ? 'SELL EXIT' : 'BUY EXIT') : selectedOrder.side}
                        </span>
                        {selectedOrder.product_type && (
                          <span className="ord-type-pill" style={{ fontSize: '0.65rem', padding: '2px 8px' }}>{selectedOrder.product_type}</span>
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
                      onClick={() => openChart(selectedOrder)}
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

                  {/* Status Container */}
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
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Status</div>
                      <div
                        className={selectedOrder.status === 'EXECUTED' ? 'os-status-executed' : (selectedOrder.status === 'REJECTED' ? 'os-status-rejected' : selectedOrder.status === 'CANCELLED' ? 'os-status-cancelled' : 'os-status-other')}
                        style={{ fontSize: '1.5rem', fontWeight: 800, lineHeight: 1 }}
                      >
                        {selectedOrder.status}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', textAlign: 'right' }}>
                      <div>
                        <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '1px' }}>Fill Price</div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{fmtPrice(selectedOrder.fill_price)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Meta grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', width: '100%', marginBottom: '8px' }}>
                    <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Requested Price</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{fmtPrice(selectedOrder.client_price || selectedOrder.fill_price)}</div>
                    </div>
                    <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Quantity</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{fmtQty(selectedOrder.qty)} ({selectedOrder.lots} Lot)</div>
                    </div>
                    <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Order Type</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{selectedOrder.order_type}</div>
                    </div>
                    <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Segment</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{selectedOrder.segment}</div>
                    </div>
                    {selectedOrder.trigger_price !== undefined && selectedOrder.trigger_price !== null && (
                      <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                        <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Trigger Price</div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary, #1A1A1A)' }}>{fmtPrice(selectedOrder.trigger_price)}</div>
                      </div>
                    )}
                    {selectedOrder.stop_loss !== undefined && selectedOrder.stop_loss !== null && (
                      <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                        <div style={{ fontSize: '0.58rem', fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Stop Loss</div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 800, color: '#dc2626' }}>{fmtPrice(selectedOrder.stop_loss)}</div>
                      </div>
                    )}
                    {selectedOrder.target !== undefined && selectedOrder.target !== null && (
                      <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px' }}>
                        <div style={{ fontSize: '0.58rem', fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Target</div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 800, color: '#059669' }}>{fmtPrice(selectedOrder.target)}</div>
                      </div>
                    )}
                    <div style={{ background: 'var(--card-alt-bg, #F8F9FB)', border: '1px solid var(--border-card, #E2E6EA)', padding: '6px 10px', borderRadius: '12px', gridColumn: '1 / -1' }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-secondary, #6B7280)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>Time</div>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary, #1A1A1A)' }}>
                        {new Date(selectedOrder.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
                      </div>
                    </div>
                  </div>
                  {selectedOrder.info && selectedOrder.info !== 'Exit - USER' && (
                    <div className="ord-rejection" style={{ marginTop: 0, marginBottom: '8px' }}>
                      <i className="fas fa-info-circle" /> {selectedOrder.info}
                    </div>
                  )}

                  {/* Trade Again button */}
                  <button
                    style={{
                      width: '100%', padding: '11px', borderRadius: '50px',
                      border: '1.5px solid #059669', background: 'var(--card-bg, #fff)',
                      color: '#059669', fontSize: '0.95rem', fontWeight: 800,
                      cursor: 'pointer', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', gap: '8px', marginTop: '2px',
                      transition: 'all 0.18s',
                    }}
                    onClick={() => handleTradeAgain(selectedOrder)}
                  >
                    <i className="fas fa-rotate-right" />
                    Trade Again
                  </button>
                </div>
              )}
            </div>

            <div className={`ord-toast${toast ? ' show' : ''}`}>
              <i className="fas fa-circle-info" />
              <span>{toast}</span>
            </div>

            <TradeSheet
              item={tradeSheetItem}
              side={tradeSheetSide}
              onClose={() => {
                setTradeSheetItem(null);
                setTradeSheetInitialOrder(null);
                setModifyingOrderId(null);
              }}
              initialOrder={tradeSheetInitialOrder}
              isModify={!!modifyingOrderId}
              modifyingOrderId={modifyingOrderId}
              exitMode={modifyingOrderId ? (modifyingOrderId.startsWith('pos-sl-') || modifyingOrderId.startsWith('pos-target-')) : false}
              onSuccess={() => {
                refresh();
                if (modifyingOrderId) {
                  // Only cancel the old order if it is not a virtual position order
                  if (!modifyingOrderId.startsWith('pos-sl-') && !modifyingOrderId.startsWith('pos-target-') && !modifyingOrderId.startsWith('pos-gtt-')) {
                    cancelOrder(modifyingOrderId);
                  } else {
                    const positionId = modifyingOrderId.replace('pos-sl-', '').replace('pos-target-', '').replace('pos-gtt-', '');
                    const isSl = modifyingOrderId.startsWith('pos-sl-');
                    const isTarget = modifyingOrderId.startsWith('pos-target-');
                    const isGtt = modifyingOrderId.startsWith('pos-gtt-');

                    let clearData: any = {};
                    if (isSl) clearData = { stop_loss: null };
                    else if (isTarget) clearData = { target: null };
                    else if (isGtt) clearData = { stop_loss: null, target: null };

                    api.patch(`/api/positions/${positionId}`, clearData).then(() => {
                      refresh();
                    });
                  }
                  showToast('Order modified successfully');
                  setModifyingOrderId(null);
                }
              }}
            />
          </div>
        </div>
      </main>

      <div id="chartSheetOverlay" className="trade-sheet-overlay" onClick={() => { const sheet = document.getElementById('chartSheet'); const overlay = document.getElementById('chartSheetOverlay'); if (sheet) sheet.classList.remove('open'); if (overlay) overlay.classList.remove('active'); setChartItem(null); }}></div>
      <div id="chartSheet" className="trade-sheet" style={{ height: '100dvh', paddingBottom: '0', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, position: 'relative', width: '100%', overflow: 'hidden' }}>
          {chartItem && (
            <TradingChart
              symbol={chartItem.kiteSymbol || chartItem.symbol}
              segment={chartItem.segment}
            />
          )}
        </div>
      </div>
    </div>
  );
}
