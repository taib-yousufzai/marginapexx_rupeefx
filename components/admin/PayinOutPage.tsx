'use client';
import React, { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { signOut } from '@/lib/auth';
import { apiCall, Toast, ToastState, SkeletonLine, SkeletonCard } from './AdminUtils';
import AnimatedLoader from '@/components/AnimatedLoader';
import { toCsvPayRequests } from '@/lib/csvExport';
import type { PayRequest } from '@/lib/csvExport';

export default function PayinOutPage({ isDemoMode }: { isDemoMode: boolean }) {
  const [tab, setTab] = useState<'deposit' | 'withdrawal' | 'rules'>('deposit');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [status, setStatus] = useState('All Status');
  const [rows, setRows] = useState('10');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);

  // Rules state
  const [withdrawEnabled, setWithdrawEnabled] = useState(true);
  const [allowedDays, setAllowedDays] = useState(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('16:00');
  const [minWithdraw, setMinWithdraw] = useState('100');
  const [minDeposit, setMinDeposit] = useState('300');

  // Dynamic data state
  const [requests, setRequests] = useState<PayRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);

  // Stats calculation (simplified for now, ideally from API)
  const stats = {
    pendingCount: requests.filter(r => r.status === 'PENDING').length,
    totalDepositApproved: requests.filter(r => r.status === 'APPROVED' && r.type === 'DEPOSIT').reduce((acc, r) => acc + r.amount, 0),
    totalWithdrawalApproved: requests.filter(r => r.status === 'APPROVED' && r.type === 'WITHDRAWAL').reduce((acc, r) => acc + r.amount, 0),
  };

  const allDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const toggleDay = (d: string) => setAllowedDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);

  // Fetch requests whenever filters change (not for rules tab)
  useEffect(() => {
    if (tab === 'rules') return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('type', tab.toUpperCase());
    if (status !== 'All Status') params.set('status', status);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (search) params.set('search', search);
    params.set('demo', String(isDemoMode));
    
    // Reset page to 1 when filters change
    setPage(1);
    
    apiCall(`/api/admin/payinout?${params.toString()}`, { method: 'GET' })
      .then(({ ok, status: httpStatus, data }) => {
        if (httpStatus === 401) { signOut(); return; }
        if (!ok) {
          const msg = (data as { error?: string })?.error ?? 'Failed to load requests';
          setError(msg);
          setRequests([]);
          return;
        }
        setRequests(data as PayRequest[]);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Network error');
        setRequests([]);
      })
      .finally(() => setLoading(false));
     
  }, [tab, dateFrom, dateTo, status, search, refreshKey, isDemoMode]);

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('admin_pay_requests')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pay_requests' },
        (payload) => {
          console.log('Realtime update received:', payload);
          setRefreshKey(prev => prev + 1);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Realtime subscription active for pay_requests');
        } else if (status === 'CLOSED') {
          console.log('Realtime subscription closed');
        } else if (status === 'CHANNEL_ERROR') {
          console.warn('Realtime subscription error');
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Fetch rules when rules tab is opened
  useEffect(() => {
    if (tab !== 'rules') return;
    setRulesLoading(true);
    apiCall('/api/admin/payinout/rules', { method: 'GET' })
      .then(({ ok, status: httpStatus, data }) => {
        if (httpStatus === 401) { signOut(); return; }
        if (!ok) {
          setToast({ message: (data as { error?: string })?.error ?? 'Failed to load rules', type: 'error' });
          return;
        }
        const r = data as {
          withdraw_enabled: boolean; allowed_days: string[];
          start_time: string; end_time: string;
          min_withdraw: number; min_deposit: number;
        };
        setWithdrawEnabled(r.withdraw_enabled);
        setAllowedDays(r.allowed_days);
        setStartTime(r.start_time);
        setEndTime(r.end_time);
        setMinWithdraw(String(r.min_withdraw));
        setMinDeposit(String(r.min_deposit));
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      })
      .finally(() => setRulesLoading(false));
     
  }, [tab]);

  const handleAccept = async (r: PayRequest) => {
    setActionLoading(prev => ({ ...prev, [r.id]: true }));
    try {
      const { ok, status: httpStatus, data } = await apiCall(`/api/admin/payinout/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'approve' }),
      });
      if (httpStatus === 401) { signOut(); return; }
      if (!ok) {
        setToast({ message: (data as { error?: string })?.error ?? 'Failed to approve', type: 'error' });
        return;
      }
      setRequests(prev => prev.map(req => req.id === r.id ? { ...req, status: 'APPROVED' } : req));
    } catch (err: unknown) {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    } finally {
      setActionLoading(prev => ({ ...prev, [r.id]: false }));
    }
  };

  const handleReject = async (r: PayRequest) => {
    setActionLoading(prev => ({ ...prev, [r.id]: true }));
    try {
      const { ok, status: httpStatus, data } = await apiCall(`/api/admin/payinout/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reject' }),
      });
      if (httpStatus === 401) { signOut(); return; }
      if (!ok) {
        setToast({ message: (data as { error?: string })?.error ?? 'Failed to reject', type: 'error' });
        return;
      }
      setRequests(prev => prev.map(req => req.id === r.id ? { ...req, status: 'REJECTED' } : req));
    } catch (err: unknown) {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    } finally {
      setActionLoading(prev => ({ ...prev, [r.id]: false }));
    }
  };

  const handleDelete = async (r: PayRequest) => {
    if (!window.confirm('Are you sure you want to delete this request?')) return;
    setActionLoading(prev => ({ ...prev, [r.id]: true }));
    try {
      const { ok, status: httpStatus, data } = await apiCall(`/api/admin/payinout/${r.id}`, {
        method: 'DELETE',
      });
      if (httpStatus === 401) { signOut(); return; }
      if (!ok) {
        setToast({ message: (data as { error?: string })?.error ?? 'Failed to delete', type: 'error' });
        return;
      }
      setRequests(prev => prev.filter(req => req.id !== r.id));
    } catch (err: unknown) {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    } finally {
      setActionLoading(prev => { const next = { ...prev }; delete next[r.id]; return next; });
    }
  };

  const handleSaveRules = async () => {
    setRulesSaving(true);
    try {
      const { ok, status: httpStatus, data } = await apiCall('/api/admin/payinout/rules', {
        method: 'PUT',
        body: JSON.stringify({
          withdraw_enabled: withdrawEnabled,
          allowed_days: allowedDays,
          start_time: startTime,
          end_time: endTime,
          min_withdraw: Number(minWithdraw),
          min_deposit: Number(minDeposit),
        }),
      });
      if (httpStatus === 401) { signOut(); return; }
      if (!ok) {
        setToast({ message: (data as { error?: string })?.error ?? 'Failed to save rules', type: 'error' });
        return;
      }
      setToast({ message: 'Rules saved successfully', type: 'success' });
    } catch (err: unknown) {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    } finally {
      setRulesSaving(false);
    }
  };

  const handleDownloadCsv = () => {
    const csv = toCsvPayRequests(requests);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payinout_${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setToast({ message: `${label} copied!`, type: 'success' });
  };

  const rowsNum = Number(rows);
  const totalPages = Math.max(1, Math.ceil(requests.length / rowsNum));
  const displayed = requests.slice((page - 1) * rowsNum, page * rowsNum);

  const statusColor = (s: string) => {
    if (s === 'APPROVED') return '#2ea043';
    if (s === 'PENDING') return '#e3b341';
    if (s === 'CANCELLED_BY_USER') return '#8b949e';
    return '#f85149'; // REJECTED
  };

  const statusLabel = (s: string) => s === 'CANCELLED_BY_USER' ? 'Cancelled by User' : s;

  return (
    <div className="adm-pay-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      
      {lightboxImg && (
        <div className="adm-lightbox" onClick={() => setLightboxImg(null)}>
          <div className="adm-lightbox-content" onClick={e => e.stopPropagation()}>
            <button className="adm-lightbox-close" onClick={() => setLightboxImg(null)}>✕</button>
            <img src={lightboxImg} alt="Screenshot" className="adm-lightbox-img" />
            <div className="adm-lightbox-caption">Payment Proof Screenshot</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 className="adm-page-title" style={{ margin: 0 }}>Pay In / Out</h2>
        <div className="adm-pay-tabs">
          <button className={`adm-pay-tab ${tab === 'deposit' ? 'active' : ''}`} onClick={() => { setTab('deposit'); setPage(1); }}>Deposits</button>
          <button className={`adm-pay-tab ${tab === 'withdrawal' ? 'active' : ''}`} onClick={() => { setTab('withdrawal'); setPage(1); }}>Withdrawals</button>
          <button className={`adm-pay-tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>Rules</button>
        </div>
      </div>

      {/* Summary Stats */}
      {tab !== 'rules' && (
        <div className="adm-pay-summary">
          <div className="adm-pay-stat-card pending">
            <span className="adm-pay-stat-label">Pending Requests</span>
            <span className="adm-pay-stat-value">{stats.pendingCount}</span>
            <span className="adm-pay-stat-sub">Action required</span>
          </div>
          <div className="adm-pay-stat-card approved">
            <span className="adm-pay-stat-label">Total Deposits (Page)</span>
            <span className="adm-pay-stat-value">₹{stats.totalDepositApproved.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            <span className="adm-pay-stat-sub">Approved this view</span>
          </div>
          <div className="adm-pay-stat-card">
            <span className="adm-pay-stat-label">Total Withdrawals (Page)</span>
            <span className="adm-pay-stat-value">₹{stats.totalWithdrawalApproved.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            <span className="adm-pay-stat-sub">Approved this view</span>
          </div>
        </div>
      )}

      {tab === 'rules' ? (
        <div className="adm-pay-rules">
          <div className="adm-card" style={{ padding: '24px' }}>
            <div className="adm-upd-section-title">Wallet & Withdrawal Rules</div>
            <div className="adm-pay-rules-sub">Operational controls for financial transactions.</div>
            <div className="adm-cu-divider" style={{ margin: '20px 0' }} />

            {rulesLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {Array.from({ length: 6 }).map((_, i) => <SkeletonLine key={i} height={36} />)}
              </div>
            ) : (<>
              <div className="adm-pay-rule-row" style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="adm-upd-label" style={{ marginBottom: 0 }}>Global Withdrawals</span>
                  <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>Enable or disable withdrawal requests platform-wide.</span>
                </div>
                <div className={`adm-toggle ${withdrawEnabled ? 'on' : ''}`} onClick={() => setWithdrawEnabled(v => !v)}>
                  <div className="adm-toggle-thumb" />
                </div>
              </div>

              <div className="adm-upd-field" style={{ marginBottom: 24 }}>
                <label className="adm-upd-label">Allowed Days for Withdrawals</label>
                <div className="adm-pay-days-grid">
                  {allDays.map(d => (
                    <label key={d} className="adm-cu-seg-item" style={{ background: allowedDays.includes(d) ? 'rgba(88, 166, 255, 0.1)' : '#0d1117', border: '1px solid', borderColor: allowedDays.includes(d) ? '#1f6feb' : '#21262d', borderRadius: '10px', padding: '10px 12px', cursor: 'pointer', transition: 'all 0.2s' }}>
                      <input type="checkbox" className="adm-cu-checkbox" checked={allowedDays.includes(d)} onChange={() => toggleDay(d)} style={{ display: 'none' }} />
                      <span style={{ color: allowedDays.includes(d) ? '#58a6ff' : '#8b949e', fontSize: '0.8rem', fontWeight: 600 }}>{d.slice(0, 3)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="adm-upd-grid2" style={{ marginBottom: 24 }}>
                <div className="adm-upd-field">
                  <label className="adm-upd-label">Daily Window Start</label>
                  <input type="time" className="adm-upd-input" value={startTime} onChange={e => setStartTime(e.target.value)} />
                </div>
                <div className="adm-upd-field">
                  <label className="adm-upd-label">Daily Window End</label>
                  <input type="time" className="adm-upd-input" value={endTime} onChange={e => setEndTime(e.target.value)} />
                </div>
              </div>

              <div className="adm-upd-grid2">
                <div className="adm-upd-field">
                  <label className="adm-upd-label">Min Withdrawal Amount (₹)</label>
                  <input className="adm-upd-input" type="number" value={minWithdraw} onChange={e => setMinWithdraw(e.target.value)} />
                </div>
                <div className="adm-upd-field">
                  <label className="adm-upd-label">Min Deposit Amount (₹)</label>
                  <input className="adm-upd-input" type="number" value={minDeposit} onChange={e => setMinDeposit(e.target.value)} />
                </div>
              </div>

              <div className="adm-cu-divider" style={{ margin: '30px 0 20px' }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  className="adm-btn-primary"
                  style={{ padding: '12px 32px', fontSize: '0.9rem', borderRadius: 12, background: 'linear-gradient(135deg, #1f6feb 0%, #1158c7 100%)', boxShadow: '0 4px 12px rgba(31, 111, 235, 0.3)' }}
                  disabled={rulesSaving}
                  onClick={handleSaveRules}
                >
                  {rulesSaving ? 'Saving…' : 'Update Wallet Rules'}
                </button>
              </div>
            </>)}
          </div>
        </div>
      ) : (<>
        {/* Filter Bar */}
        <div className="adm-card" style={{ padding: '16px 20px', marginBottom: 20 }}>
          <div className="adm-pay-controls" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
            <div className="adm-al-date-field">
              <label className="adm-al-label">From Date</label>
              <input type="date" className="adm-upd-input" style={{ height: 40 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </div>
            <div className="adm-al-date-field">
              <label className="adm-al-label">To Date</label>
              <input type="date" className="adm-upd-input" style={{ height: 40 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
            <div className="adm-al-date-field">
              <label className="adm-al-label">Status</label>
              <select className="adm-upd-input" style={{ height: 40, cursor: 'pointer' }} value={status} onChange={e => setStatus(e.target.value)}>
                {['All Status', 'APPROVED', 'PENDING', 'REJECTED', 'CANCELLED_BY_USER'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="adm-al-date-field">
              <label className="adm-al-label">Results Per Page</label>
              <select className="adm-upd-input" style={{ height: 40, cursor: 'pointer' }} value={rows} onChange={e => { setRows(e.target.value); setPage(1); }}>
                {['10', '25', '50', '100'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20, borderTop: '1px solid #21262d', paddingTop: 20 }}>
            <div style={{ position: 'relative' }}>
              <i className="fas fa-search" style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#8b949e', fontSize: '0.85rem' }} />
              <input
                className="adm-upd-input"
                style={{ width: '100%', paddingLeft: 40, height: 44, borderRadius: 10, boxSizing: 'border-box' }}
                placeholder="Search by User ID, Name or Reference..."
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="adm-pay-clear-btn" style={{ flex: 1, height: 44, borderRadius: 10 }} onClick={() => { setStatus('All Status'); setSearch(''); setDateFrom(''); setDateTo(''); }}>
                Reset
              </button>
              <button className="adm-btn-primary" style={{ flex: 2, height: 44, borderRadius: 10, background: '#238636' }} onClick={handleDownloadCsv}>
                <i className="fas fa-file-excel" style={{ marginRight: 8 }} /> Export CSV
              </button>
            </div>
          </div>
        </div>

        {/* Request cards */}
        {/* Request Table */}
        <div className="adm-card" style={{ padding: 0, overflowX: 'auto', marginBottom: 20 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ background: '#161b22', borderBottom: '1px solid #30363d', color: '#8b949e', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th style={{ padding: '16px', fontWeight: 600 }}>Date</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Username</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Broker</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Sub-Broker</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Type</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Amount</th>
                {tab === 'withdrawal' && <th style={{ padding: '16px', fontWeight: 600 }}>Bank Details</th>}
                <th style={{ padding: '16px', fontWeight: 600 }}>Remark</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Screenshot</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Status</th>
                <th style={{ padding: '16px', fontWeight: 600 }}>Updated</th>
                <th style={{ padding: '16px', fontWeight: 600, textAlign: 'center' }}>Accept</th>
                <th style={{ padding: '16px', fontWeight: 600, textAlign: 'center' }}>Reject</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={tab === 'withdrawal' ? 13 : 12} style={{ padding: 20 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {Array.from({ length: 3 }).map((_, i) => <SkeletonLine key={i} height={40} />)}
                    </div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={tab === 'withdrawal' ? 13 : 12} style={{ padding: 20 }}>
                    <div className="adm-dashed-box" style={{ borderColor: '#f85149', color: '#f85149' }}>{error}</div>
                  </td>
                </tr>
              ) : displayed.length === 0 ? (
                <tr>
                  <td colSpan={tab === 'withdrawal' ? 13 : 12} style={{ padding: 20 }}>
                    <div className="adm-dashed-box">No {tab} requests matching your criteria.</div>
                  </td>
                </tr>
              ) : displayed.map((r) => {
                const isPending = r.status === 'PENDING';
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #21262d', fontSize: '0.85rem' }}>
                    <td style={{ padding: '16px', color: '#8b949e' }}>
                      {new Date(r.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td style={{ padding: '16px', color: '#58a6ff', fontWeight: 500 }}>
                      {(r as any).user_name || (r as any).user_client_id || r.user_id.slice(0, 6)}
                    </td>
                    <td style={{ padding: '16px', color: '#c9d1d9' }}>—</td>
                    <td style={{ padding: '16px', color: '#c9d1d9' }}>—</td>
                    <td style={{ padding: '16px', color: '#c9d1d9', fontWeight: 600 }}>
                      {r.account_name === 'System Credit' ? 'CREDIT' : 
                       r.account_name === 'System Debit' ? 'DEBIT' : 
                       r.type}
                    </td>
                    <td style={{ padding: '16px', color: '#c9d1d9', fontWeight: 600 }}>₹{r.amount}</td>
                    {tab === 'withdrawal' && (
                      <td style={{ padding: '16px', color: '#c9d1d9', lineHeight: '1.5' }}>
                        {r.account_name === 'System Credit' || r.account_name === 'System Debit' ? (
                          <strong style={{ color: '#8b949e' }}>{r.account_name}</strong>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem', minWidth: '220px' }}>
                            {r.account_name && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span>
                                  <span style={{ color: '#8b949e', marginRight: '4px' }}>Name:</span>
                                  <strong>{r.account_name}</strong>
                                </span>
                                <button 
                                  onClick={() => handleCopy(r.account_name || '', 'Name')}
                                  title="Copy Name"
                                  style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', padding: '2px 4px', fontSize: '0.75rem' }}
                                >
                                  <i className="far fa-copy" />
                                </button>
                              </div>
                            )}
                            {r.account_no && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span>
                                  <span style={{ color: '#8b949e', marginRight: '4px' }}>Acc:</span>
                                  <strong>{r.account_no}</strong>
                                  {(r as any).user_bank_name && (
                                    <span style={{ color: '#58a6ff', marginLeft: '6px', fontSize: '0.7rem', background: 'rgba(88, 166, 255, 0.1)', padding: '1px 5px', borderRadius: '4px' }}>
                                      {(r as any).user_bank_name}
                                    </span>
                                  )}
                                </span>
                                <button 
                                  onClick={() => handleCopy(r.account_no || '', 'Account Number')}
                                  title="Copy Account Number"
                                  style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', padding: '2px 4px', fontSize: '0.75rem' }}
                                >
                                  <i className="far fa-copy" />
                                </button>
                              </div>
                            )}
                            {r.ifsc && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span>
                                  <span style={{ color: '#8b949e', marginRight: '4px' }}>IFSC:</span>
                                  <strong>{r.ifsc}</strong>
                                </span>
                                <button 
                                  onClick={() => handleCopy(r.ifsc || '', 'IFSC')}
                                  title="Copy IFSC"
                                  style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', padding: '2px 4px', fontSize: '0.75rem' }}
                                >
                                  <i className="far fa-copy" />
                                </button>
                              </div>
                            )}
                            {r.upi && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span>
                                  <span style={{ color: '#8b949e', marginRight: '4px' }}>UPI:</span>
                                  <strong style={{ color: '#58a6ff' }}>{r.upi}</strong>
                                </span>
                                <button 
                                  onClick={() => handleCopy(r.upi || '', 'UPI ID')}
                                  title="Copy UPI ID"
                                  style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', padding: '2px 4px', fontSize: '0.75rem' }}
                                >
                                  <i className="far fa-copy" />
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                    <td style={{ padding: '16px', color: '#c9d1d9' }}>
                      {r.type === 'DEPOSIT' && r.utr ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <code style={{ fontSize: '0.8rem', color: '#c9d1d9', background: '#21262d', padding: '2px 6px', borderRadius: '4px', border: '1px solid #30363d', fontFamily: 'monospace' }}>
                            {r.utr}
                          </code>
                          <button 
                            onClick={() => handleCopy(r.utr || '', 'UTR')}
                            title="Copy UTR"
                            style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', padding: '2px 4px', fontSize: '0.75rem' }}
                          >
                            <i className="far fa-copy" />
                          </button>
                        </div>
                      ) : r.reference_id ? (
                        <span style={{ color: '#8b949e' }}>System</span>
                      ) : (
                        <span style={{ color: '#8b949e' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '16px' }}>
                      {r.screenshot_url ? (
                        <span style={{ color: '#58a6ff', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setLightboxImg(r.screenshot_url!)}>View</span>
                      ) : (
                        <span style={{ color: '#8b949e' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '16px' }}>
                      <span style={{ 
                        padding: '4px 10px', 
                        borderRadius: '4px', 
                        fontSize: '0.75rem', 
                        fontWeight: 600,
                        background: r.status === 'APPROVED' ? '#238636' : r.status === 'REJECTED' ? '#da3633' : '#b08800',
                        color: '#fff'
                      }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: '16px', color: '#8b949e' }}>
                      {new Date(r.updated_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td style={{ padding: '16px', textAlign: 'center' }}>
                      <button 
                        onClick={() => handleAccept(r)}
                        disabled={!isPending || !!actionLoading[r.id]}
                        style={{ 
                          width: 28, height: 28, borderRadius: 4, border: 'none',
                          background: 'rgba(35, 134, 54, 0.15)', color: '#2ea043', 
                          fontWeight: 'bold', cursor: isPending ? 'pointer' : 'not-allowed',
                          opacity: isPending ? 1 : 0.4
                        }}>
                        {actionLoading[r.id] ? <AnimatedLoader size="small" /> : 'A'}
                      </button>
                    </td>
                    <td style={{ padding: '16px', textAlign: 'center' }}>
                      <button 
                        onClick={() => handleReject(r)}
                        disabled={!isPending || !!actionLoading[r.id]}
                        style={{ 
                          width: 28, height: 28, borderRadius: 4, border: 'none',
                          background: 'rgba(218, 54, 51, 0.15)', color: '#f85149', 
                          fontWeight: 'bold', cursor: isPending ? 'pointer' : 'not-allowed',
                          opacity: isPending ? 1 : 0.4
                        }}>
                        {actionLoading[r.id] ? <AnimatedLoader size="small" /> : 'R'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="adm-pos-pagination" style={{ marginTop: 24 }}>
          <span className="adm-pos-page-info">Showing page {page} of {totalPages}</span>
          <div className="adm-pos-page-btns">
            <button className="adm-pos-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              <i className="fas fa-chevron-left" />
            </button>
            <button className="adm-pos-page-btn active-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              <i className="fas fa-chevron-right" />
            </button>
          </div>
        </div>
      </>)}
    </div>
  );
}
