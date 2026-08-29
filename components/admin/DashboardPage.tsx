'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { signOut } from '@/lib/auth';
import { apiCall, Toast, ToastState, SkeletonCard } from './AdminUtils';
import AnimatedLoader from '@/components/AnimatedLoader';

export type DashboardMetrics = {
  ledger_balance: number;
  net_balance?: number;
  mark_to_market: number;
  net_pnl?: number;
  total_brokerage?: number;
  margin_used?: number;
  net: number;
  total_deposits: number;
  total_withdrawals: number;
  avg_deposit: number;
  avg_withdrawal: number;
  avg_profit: number;
  avg_loss: number;
  profitable_clients: number;
  loss_making_clients: number;
  buy_position_count: number;
  sell_position_count: number;
  registered: number;
  added_funds: number;
  conversion: string;
};

// Helper for formatting numbers
const fmt = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n)) return '0.00';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Reusable stat row component
function StatRow({ label, value, icon, isPositive, isNegative }: { label: string, value: string | number, icon: string, isPositive?: boolean, isNegative?: boolean }) {
  let colorClass = '';
  if (isPositive) colorClass = 'pos';
  if (isNegative) colorClass = 'neg';

  return (
    <div className="adm-db-stat-row">
      <div className="adm-db-stat-label">
        <i className={icon} style={{ opacity: 0.7, width: 16, textAlign: 'center' }} />
        {label}
      </div>
      <div className={`adm-db-stat-value adm-db-value ${colorClass}`}>
        {value}
      </div>
    </div>
  );
}

export default function DashboardPage({ selectedUser, onOpenUserPanel, isDemoMode }: {
  selectedUser?: { id: string; role: string };
  onOpenUserPanel?: () => void;
  isDemoMode: boolean;
}) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  
  const [brokerId, setBrokerId] = useState('');
  const [subBrokerId, setSubBrokerId] = useState('');
  const [clientId, setClientId] = useState('');
  const [usersList, setUsersList] = useState<{ id: string; role: string; parent_id: string }[]>([]);

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [adminProfile, setAdminProfile] = useState<{ client_id?: string; referral_code?: string; id?: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    apiCall('/api/user/profile', { method: 'GET' }).then(({ ok, data }) => {
      if (ok && data) setAdminProfile(data as any);
    });
  }, []);

  const refCode = adminProfile?.referral_code || adminProfile?.client_id || adminProfile?.id || '';
  const referralLink = refCode ? `${typeof window !== 'undefined' ? window.location.origin : ''}/register?ref=${refCode}` : '';

  const handleCopyLink = () => {
    if (!referralLink) return;
    navigator.clipboard.writeText(referralLink);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  useEffect(() => {
    apiCall(`/api/admin/users?demo=${isDemoMode}`, { method: 'GET' }).then(({ ok, data }) => {
      if (ok) setUsersList(data as { id: string; role: string; parent_id: string }[]);
    });
  }, [isDemoMode]);

  useEffect(() => {
    if (selectedUser?.id) {
      setTimeout(() => {
        const u = usersList.find(x => x.id === selectedUser.id);
        if (u) {
          if (u.role === 'broker') { setBrokerId(u.id); setSubBrokerId(''); setClientId(''); }
          else if (u.role === 'sub_broker') { setBrokerId(u.parent_id || ''); setSubBrokerId(u.id); setClientId(''); }
          else { 
            setClientId(u.id); 
            const parent = usersList.find(x => x.id === u.parent_id);
            if (parent?.role === 'sub_broker') { setSubBrokerId(parent.id); setBrokerId(parent.parent_id || ''); }
            else if (parent?.role === 'broker') { setBrokerId(parent.id); setSubBrokerId(''); }
          }
        } else {
          setClientId(selectedUser.id);
        }
      }, 0);
    }
  }, [selectedUser, usersList, isDemoMode]);

  const fetchMetrics = useCallback((manual = false, silent = false) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (brokerId) params.set('broker_id', brokerId);
    if (subBrokerId) params.set('sub_broker_id', subBrokerId);
    if (clientId) params.set('client_id', clientId);
    params.set('demo', String(isDemoMode));
    
    const query = params.toString() ? `?${params.toString()}` : '';
    apiCall(`/api/admin/dashboard${query}`, { method: 'GET' })
      .then(({ ok, status, data }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        setMetrics(data as DashboardMetrics);
        if (manual) setToast({ message: 'Dashboard updated successfully', type: 'success' });
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      })
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, brokerId, subBrokerId, clientId, isDemoMode]);

  useEffect(() => {
    setTimeout(() => fetchMetrics(), 0);
    const interval = setInterval(() => {
      fetchMetrics(false, true); // silent refresh every second
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const brokers = usersList.filter(u => u.role === 'broker');
  const subBrokers = usersList.filter(u => u.role === 'sub_broker' && (!brokerId || u.parent_id === brokerId));
  const clients = usersList.filter(u => (u.role === 'user' || u.role === 'client') && (!subBrokerId ? (!brokerId || u.parent_id === brokerId) : u.parent_id === subBrokerId));

  const m2m = metrics?.mark_to_market ?? 0;
  const netPnl = metrics?.net_pnl ?? 0;
  const netBal = metrics?.net_balance ?? 0;
  const ledger = metrics?.ledger_balance ?? 0;
  const netDepWith = metrics?.net ?? 0;

  return (
    <div className="adm-db-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      
      {/* Top Filter Bar */}
      <div className="adm-db-top-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div className="adm-db-username" style={{ margin: 0, fontSize: '1.2rem' }}>
            <i className="fas fa-chart-pie" style={{ marginRight: 8, color: '#1f6feb' }} />
            Performance Dashboard
          </div>
          <div className="adm-db-filter-row">
            <span className="adm-db-filter-label">Date:</span>
            <div className="adm-db-date-group">
              <input type="date" className="adm-db-date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              <span className="adm-db-filter-dash">–</span>
              <input type="date" className="adm-db-date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
            <button className="adm-db-refresh" onClick={() => fetchMetrics(true)} disabled={loading} style={{ padding: '0 12px', borderRadius: 6, marginLeft: 8 }}>
              {loading ? <AnimatedLoader size="small" /> : <i className="fas fa-sync-alt" />}
            </button>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <select className="adm-db-date" style={{ flex: 1, minWidth: 150 }} value={brokerId} onChange={e => { setBrokerId(e.target.value); setSubBrokerId(''); setClientId(''); }}>
            <option value="">All Brokers</option>
            {brokers.map(b => <option key={b.id} value={b.id}>{b.id}</option>)}
          </select>
          <select className="adm-db-date" style={{ flex: 1, minWidth: 150 }} value={subBrokerId} onChange={e => { setSubBrokerId(e.target.value); setClientId(''); }}>
            <option value="">All Sub-Brokers</option>
            {subBrokers.map(b => <option key={b.id} value={b.id}>{b.id}</option>)}
          </select>
          <select className="adm-db-date" style={{ flex: 1, minWidth: 150 }} value={clientId} onChange={e => setClientId(e.target.value)}>
            <option value="">All Clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
          </select>
          <button className="adm-db-refresh" onClick={() => { setBrokerId(''); setSubBrokerId(''); setClientId(''); }} style={{ padding: '0 12px', borderRadius: 6 }} title="Clear Filters">
            <i className="fas fa-times" />
          </button>
        </div>
      </div>

      {referralLink && (
        <div style={{ marginTop: 16, padding: '16px', background: '#161b22', borderRadius: '10px', border: '1px solid #30363d' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#8b949e', letterSpacing: '0.5px' }}>
              <i className="fas fa-link" style={{ marginRight: 6, color: '#1f6feb' }} />
              ADMIN REFERRAL LINK
            </span>
            <span style={{ fontSize: '0.75rem', color: '#2ea043', background: 'rgba(46, 160, 67, 0.15)', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
              Code: {refCode}
            </span>
          </div>
          <p style={{ color: '#8b949e', fontSize: '0.8rem', marginBottom: '12px' }}>
            Share this link to onboard your brokers and direct clients. Users signing up via this link will be mapped directly under your administrative hierarchy.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              readOnly
              value={referralLink}
              className="adm-input"
              style={{ flex: 1, minWidth: 0, backgroundColor: '#0d1117', color: '#c9d1d9', cursor: 'text', borderRadius: 6, border: '1px solid #30363d', padding: '8px 12px', fontSize: '0.85rem' }}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button className="adm-btn-primary" onClick={handleCopyLink} style={{ whiteSpace: 'nowrap', minWidth: '90px', borderRadius: 6 }}>
              {copyFeedback ? <><i className="fas fa-check" style={{ marginRight: 6 }} />Copied</> : <><i className="fas fa-copy" style={{ marginRight: 6 }} />Copy</>}
            </button>
          </div>
        </div>
      )}

      {loading && !metrics ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
          <SkeletonCard rows={3} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
             <SkeletonCard rows={4} />
             <SkeletonCard rows={4} />
          </div>
        </div>
      ) : (
        <>
          {/* KPI Hero Cards */}
          <div className="adm-db-hero-grid" style={{ marginTop: 16 }}>
            <div className="adm-db-hero-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="adm-db-hero-title">Net Ledger Balance</div>
                <div className="adm-db-hero-icon-wrapper" style={{ background: 'rgba(46, 160, 67, 0.1)', color: '#2ea043' }}>
                  <i className="fas fa-wallet" />
                </div>
              </div>
              <div className="adm-db-hero-value">₹{fmt(ledger)}</div>
            </div>

            <div className="adm-db-hero-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="adm-db-hero-title">Total Mark-To-Market</div>
                <div className="adm-db-hero-icon-wrapper" style={{ background: m2m >= 0 ? 'rgba(46, 160, 67, 0.1)' : 'rgba(248, 81, 73, 0.1)', color: m2m >= 0 ? '#2ea043' : '#f85149' }}>
                  <i className={`fas fa-arrow-trend-${m2m >= 0 ? 'up' : 'down'}`} />
                </div>
              </div>
              <div className={`adm-db-hero-value adm-db-value ${m2m >= 0 ? 'pos' : 'neg'}`}>
                {m2m >= 0 ? '+' : ''}₹{fmt(m2m)}
              </div>
            </div>

            <div className="adm-db-hero-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="adm-db-hero-title">Net P&L</div>
                <div className="adm-db-hero-icon-wrapper" style={{ background: netPnl >= 0 ? 'rgba(46, 160, 67, 0.1)' : 'rgba(248, 81, 73, 0.1)', color: netPnl >= 0 ? '#2ea043' : '#f85149' }}>
                  <i className="fas fa-chart-line" />
                </div>
              </div>
              <div className={`adm-db-hero-value adm-db-value ${netPnl >= 0 ? 'pos' : 'neg'}`}>
                {netPnl >= 0 ? '+' : ''}₹{fmt(netPnl)}
              </div>
            </div>

            <div className="adm-db-hero-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="adm-db-hero-title">Total Brokerage</div>
                <div className="adm-db-hero-icon-wrapper" style={{ background: 'rgba(31, 111, 235, 0.1)', color: '#1f6feb' }}>
                  <i className="fas fa-hand-holding-usd" />
                </div>
              </div>
              <div className="adm-db-hero-value">₹{fmt(metrics?.total_brokerage ?? 0)}</div>
            </div>
          </div>

          {/* Categorized Panels */}
          <div className="adm-db-panel-grid">
            
            <div className="adm-db-panel">
              <div className="adm-db-panel-title">
                <i className="fas fa-exchange-alt" style={{ color: '#8957e5' }} />
                Fund Flow Analytics
              </div>
              <div className="adm-db-panel-content">
                <StatRow label="Net Flow" value={`${netDepWith >= 0 ? '+' : ''}₹${fmt(netDepWith)}`} icon="fas fa-balance-scale" isPositive={netDepWith >= 0} isNegative={netDepWith < 0} />
                <StatRow label="Total Deposits" value={`₹${fmt(metrics?.total_deposits ?? 0)}`} icon="fas fa-arrow-down" isPositive={true} />
                <StatRow label="Total Withdrawals" value={`₹${fmt(metrics?.total_withdrawals ?? 0)}`} icon="fas fa-arrow-up" isNegative={true} />
                <StatRow label="Avg Deposit" value={`₹${fmt(metrics?.avg_deposit ?? 0)}`} icon="fas fa-compress-arrows-alt" />
                <StatRow label="Avg Withdrawal" value={`₹${fmt(metrics?.avg_withdrawal ?? 0)}`} icon="fas fa-expand-arrows-alt" />
              </div>
            </div>

            <div className="adm-db-panel">
              <div className="adm-db-panel-title">
                <i className="fas fa-users" style={{ color: '#d29922' }} />
                Client Analytics
              </div>
              <div className="adm-db-panel-content">
                <StatRow label="Registered Users" value={metrics?.registered ?? 0} icon="fas fa-user-plus" />
                <StatRow label="Users Added Funds" value={metrics?.added_funds ?? 0} icon="fas fa-piggy-bank" />
                <StatRow label="Conversion Rate" value={metrics?.conversion ?? '0%'} icon="fas fa-percentage" />
                <StatRow label="Profitable Clients" value={metrics?.profitable_clients ?? 0} icon="fas fa-smile" isPositive={true} />
                <StatRow label="Loss-Making Clients" value={metrics?.loss_making_clients ?? 0} icon="fas fa-frown" isNegative={true} />
              </div>
            </div>

            <div className="adm-db-panel">
              <div className="adm-db-panel-title">
                <i className="fas fa-layer-group" style={{ color: '#2ea043' }} />
                Positions & Margins
              </div>
              <div className="adm-db-panel-content">
                <StatRow label="Net Balance" value={`₹${fmt(netBal)}`} icon="fas fa-coins" />
                <StatRow label="Margin Used" value={`₹${fmt(metrics?.margin_used ?? 0)}`} icon="fas fa-lock" />
                <StatRow label="Buy Positions" value={metrics?.buy_position_count ?? 0} icon="fas fa-level-up-alt" isPositive={true} />
                <StatRow label="Sell Positions" value={metrics?.sell_position_count ?? 0} icon="fas fa-level-down-alt" isNegative={true} />
                <StatRow label="B/S Ratio" value={(metrics?.sell_position_count ? ((metrics.buy_position_count ?? 0) / metrics.sell_position_count) : (metrics?.buy_position_count ?? 0)).toFixed(2)} icon="fas fa-divide" />
              </div>
            </div>

            <div className="adm-db-panel">
              <div className="adm-db-panel-title">
                <i className="fas fa-chart-bar" style={{ color: '#f85149' }} />
                Performance Metrics
              </div>
              <div className="adm-db-panel-content">
                <StatRow label="Average Profit" value={`₹${fmt(metrics?.avg_profit ?? 0)}`} icon="fas fa-arrow-trend-up" isPositive={true} />
                <StatRow label="Average Loss" value={`₹${fmt(metrics?.avg_loss ?? 0)}`} icon="fas fa-arrow-trend-down" isNegative={true} />
                <StatRow label="Total Brokerage" value={`₹${fmt(metrics?.total_brokerage ?? 0)}`} icon="fas fa-hand-holding-usd" />
                <StatRow label="Total M2M" value={`${m2m >= 0 ? '+' : ''}₹${fmt(m2m)}`} icon="fas fa-chart-area" isPositive={m2m >= 0} isNegative={m2m < 0} />
              </div>
            </div>

          </div>
        </>
      )}

      <div style={{ height: 24 }} />
    </div>
  );
}
