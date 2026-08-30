'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import AnimatedLoader from '@/components/AnimatedLoader';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';

interface Transaction {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED_BY_USER';
  created_at: string;
  // deposit fields
  utr?: string;
  upi?: string;
  screenshot_url?: string;
  // withdrawal fields
  account_name?: string;
  account_no?: string;
  ifsc?: string;
}

interface EditForm {
  amount: string;
  utr: string;
  upi: string;
  account_name: string;
  account_no: string;
  ifsc: string;
}

export default function TransactionHistoryPage() {
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'DEPOSIT' | 'WITHDRAWAL' | 'PENDING'>('ALL');
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ amount: '', utr: '', upi: '', account_name: '', account_no: '', ifsc: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => applyTheme(getSavedTheme());
    sync();
    window.addEventListener('themeChanged', sync);
    return () => window.removeEventListener('themeChanged', sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<Transaction[]>('/api/pay/history');
        if (!cancelled) setTransactions(data);
      } catch (e) {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const formatAmount = (amount: number) => {
    return '₹' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatDate = (dateString: string) => {
    const d = new Date(dateString);
    return d.toLocaleDateString('en-IN', { 
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  // Convert status to Title Case for better aesthetics
  const formatStatus = (status: string) => {
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  };

  const getDisplayType = (tx: Transaction) => {
    if (tx.account_name === 'System Credit') return 'Credit';
    if (tx.account_name === 'System Debit') return 'Debit';
    return tx.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal';
  };

  const filteredTransactions = transactions.filter(tx => {
    if (filter === 'ALL') return true;
    if (filter === 'PENDING') return tx.status === 'PENDING';
    return tx.type === filter;
  });

  const FILTERS: { key: typeof filter; label: string; icon: string }[] = [
    { key: 'ALL',        label: 'All',        icon: 'fa-list' },
    { key: 'DEPOSIT',    label: 'Deposit',    icon: 'fa-arrow-down' },
    { key: 'WITHDRAWAL', label: 'Withdrawal', icon: 'fa-arrow-up' },
    { key: 'PENDING',    label: 'Pending',    icon: 'fa-clock' },
  ];

  const openEdit = (tx: Transaction) => {
    setEditingTx(tx);
    setEditError(null);
    setEditForm({
      amount: String(tx.amount),
      utr: tx.utr || '',
      upi: tx.upi || '',
      account_name: tx.account_name || '',
      account_no: tx.account_no || '',
      ifsc: tx.ifsc || '',
    });
  };

  const closeEdit = () => { setEditingTx(null); setEditError(null); };

  const handleEditSave = async () => {
    if (!editingTx) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const payload: Record<string, unknown> = {
        id: editingTx.id,
        type: editingTx.type,
        amount: parseFloat(editForm.amount),
      };
      if (editingTx.type === 'DEPOSIT') {
        if (editForm.utr) payload.utr = editForm.utr;
        if (editForm.upi) payload.upi = editForm.upi;
      } else {
        if (editForm.account_name) payload.account_name = editForm.account_name;
        if (editForm.account_no)   payload.account_no   = editForm.account_no;
        if (editForm.ifsc)         payload.ifsc          = editForm.ifsc;
      }

      const data = await api.patch<{ id: string }>('/api/pay/request', payload);

      // Update local state — old row becomes CANCELLED_BY_USER, new row appears as PENDING
      setTransactions(prev => {
        const updated = prev.map(t =>
          t.id === editingTx.id ? { ...t, status: 'CANCELLED_BY_USER' as const } : t
        );
        const newTx: Transaction = {
          ...editingTx,
          id: data.id,
          amount: parseFloat(editForm.amount),
          status: 'PENDING',
          created_at: new Date().toISOString(),
          utr: editForm.utr || undefined,
          upi: editForm.upi || undefined,
          account_name: editForm.account_name || undefined,
          account_no: editForm.account_no || undefined,
          ifsc: editForm.ifsc || undefined,
        };
        return [newTx, ...updated];
      });
      closeEdit();
    } catch (e: any) {
      setEditError(e instanceof ApiError ? (e.details as any)?.error || `Error ${e.status}` : e.message || 'Something went wrong');
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="desktop-layout">
            <main className="main-viewport">
        <div className="app-container th-root">
          <div className="th-header">
            <Link href="/profile" className="th-back-btn" suppressHydrationWarning>
              <i className="fas fa-chevron-left"></i>
            </Link>
            <h1 className="th-title">Transaction History</h1>
            <div style={{width: 40}}></div>
          </div>

          <div className="th-content">
            {/* Filter chips */}
            <div className="th-filters">
              {FILTERS.map(f => (
                <button
                  key={f.key}
                  className={`th-filter-chip ${filter === f.key ? 'active' : ''} ${f.key.toLowerCase()}`}
                  onClick={() => setFilter(f.key)}
                  suppressHydrationWarning
                >
                  <i className={`fas ${f.icon}`}></i>
                  {f.label}
                </button>
              ))}
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#8F9BB3' }}>
                <AnimatedLoader />
                <p>Loading transactions...</p>
              </div>
            ) : filteredTransactions.length === 0 ? (
              <div className="th-empty">
                <i className="fas fa-history"></i>
                <p>{filter === 'ALL' ? 'No transactions found.' : `No ${filter.toLowerCase()} transactions found.`}</p>
              </div>
            ) : (
              <div className="th-list-container">
                {filteredTransactions.map(tx => (
                  <div key={tx.id} className="th-item">
                    <div className="th-info">
                      <div className={`th-icon ${tx.type.toLowerCase()} ${tx.status === 'CANCELLED_BY_USER' ? 'cancelled' : ''}`}>
                        <i className={`fas ${tx.status === 'CANCELLED_BY_USER' ? 'fa-ban' : tx.type === 'DEPOSIT' ? 'fa-arrow-down' : 'fa-arrow-up'}`}></i>
                      </div>
                      <div className="th-details">
                        <h3 className="th-type">{getDisplayType(tx)}</h3>
                        <p className="th-date">{formatDate(tx.created_at)}</p>
                      </div>
                    </div>
                    <div className="th-amount-status">
                      <div className={`th-amount ${tx.type.toLowerCase()} ${tx.status === 'CANCELLED_BY_USER' ? 'cancelled' : ''}`}>
                        {tx.type === 'DEPOSIT' ? `+${formatAmount(tx.amount)}` : `-${formatAmount(tx.amount)}`}
                      </div>
                      <div className="th-status-row">
                        <div className={`th-status-badge ${tx.status.toLowerCase().replace('_', '-')}`}>
                          <span className="status-dot"></span>
                          {tx.status === 'CANCELLED_BY_USER' ? 'Cancelled' : formatStatus(tx.status)}
                        </div>
                        {tx.status === 'PENDING' && (
                          <button className="th-edit-btn" onClick={() => openEdit(tx)} suppressHydrationWarning>
                            <i className="fas fa-pen"></i> Edit
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Edit pending request modal */}
          <div className={`th-modal-overlay ${editingTx ? 'open' : ''}`} onClick={closeEdit}></div>
          <div className={`th-modal ${editingTx ? 'open' : ''}`} onClick={e => e.stopPropagation()}>
            <div className="th-modal-header">
              <div>
                <h3>Edit {editingTx?.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} Request</h3>
                <p className="th-modal-sub">The current request will be cancelled and a new one submitted.</p>
              </div>
              <button className="th-modal-close" onClick={closeEdit} suppressHydrationWarning>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="th-modal-body">
              {editError && (
                <div className="th-edit-error">
                  <i className="fas fa-exclamation-circle"></i> {editError}
                </div>
              )}

              <div className="th-form-group">
                <label>Amount (₹) *</label>
                <input
                  type="number"
                  value={editForm.amount}
                  onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="Enter amount"
                  suppressHydrationWarning
                />
              </div>

              {editingTx?.type === 'DEPOSIT' && (
                <>
                  <div className="th-form-group">
                    <label>UTR / Reference Number</label>
                    <input
                      type="text"
                      value={editForm.utr}
                      onChange={e => setEditForm(f => ({ ...f, utr: e.target.value }))}
                      placeholder="e.g. 123456789012"
                      suppressHydrationWarning
                    />
                  </div>
                  <div className="th-form-group">
                    <label>UPI ID</label>
                    <input
                      type="text"
                      value={editForm.upi}
                      onChange={e => setEditForm(f => ({ ...f, upi: e.target.value }))}
                      placeholder="name@upi"
                      suppressHydrationWarning
                    />
                  </div>
                </>
              )}

              {editingTx?.type === 'WITHDRAWAL' && (
                <>
                  <div className="th-form-group">
                    <label>Account Holder Name</label>
                    <input
                      type="text"
                      value={editForm.account_name}
                      onChange={e => setEditForm(f => ({ ...f, account_name: e.target.value }))}
                      placeholder="Name as per bank"
                      suppressHydrationWarning
                    />
                  </div>
                  <div className="th-form-group">
                    <label>Account Number</label>
                    <input
                      type="text"
                      value={editForm.account_no}
                      onChange={e => setEditForm(f => ({ ...f, account_no: e.target.value }))}
                      placeholder="Enter account number"
                      suppressHydrationWarning
                    />
                  </div>
                  <div className="th-form-group">
                    <label>IFSC Code</label>
                    <input
                      type="text"
                      value={editForm.ifsc}
                      onChange={e => setEditForm(f => ({ ...f, ifsc: e.target.value }))}
                      placeholder="e.g. SBIN0001234"
                      suppressHydrationWarning
                    />
                  </div>
                </>
              )}

              <div className="th-modal-notice">
                <i className="fas fa-info-circle"></i>
                The original request will appear as <strong>Cancelled</strong> and a new pending request will be created with your updated details.
              </div>

              <button
                className="th-save-btn"
                onClick={handleEditSave}
                disabled={editSaving}
                suppressHydrationWarning
              >
                {editSaving
                  ? <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><AnimatedLoader size="small" /> Submitting...</span>
                  : <><i className="fas fa-paper-plane"></i> Submit New Request</>
                }
              </button>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
