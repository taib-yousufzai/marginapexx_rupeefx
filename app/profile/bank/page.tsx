'use client';
import { ErrorModal } from '@/components/ErrorModal';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';

interface BankAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  ifsc: string;
  accountHolderName: string;
  upiId?: string;
  isPrimary: boolean;
}

type InlineEditState = {
  bankName: string;
  accountNumber: string;
  ifsc: string;
  accountHolderName: string;
  upiId: string;
};

export default function BankDetailsPage() {
  const router = useRouter();

  useEffect(() => {
    const sync = () => applyTheme(getSavedTheme());
    sync();
    window.addEventListener('themeChanged', sync);
    return () => window.removeEventListener('themeChanged', sync);
  }, []);

  const [loading, setLoading] = useState(true);
  const [modalError, setModalError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);

  // Which card is expanded (view mode)
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Which card is in inline-edit mode
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineForm, setInlineForm] = useState<InlineEditState>({
    bankName: '', accountNumber: '', ifsc: '', accountHolderName: '', upiId: ''
  });
  // Original values at edit-start, to detect dirty state
  const [inlineOriginal, setInlineOriginal] = useState<InlineEditState>({
    bankName: '', accountNumber: '', ifsc: '', accountHolderName: '', upiId: ''
  });
  const [inlineSaving, setInlineSaving] = useState(false);

  // Ref map: card id → DOM node, so we can detect outside clicks
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Close edit mode when clicking outside the editing card
  const inlineEditIdRef = useRef<string | null>(null);
  useEffect(() => { inlineEditIdRef.current = inlineEditId; }, [inlineEditId]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (!inlineEditIdRef.current) return;
      const cardNode = cardRefs.current.get(inlineEditIdRef.current);
      if (cardNode && !cardNode.contains(e.target as Node)) {
        // Check target is not inside a modal overlay
        const target = e.target as HTMLElement;
        if (target.closest('.bd-modal') || target.closest('.bd-modal-overlay')) return;
        setInlineEditId(null);
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick, true);
    return () => document.removeEventListener('pointerdown', handleOutsideClick, true);
  }, []);

  const isInlineDirty =
    inlineForm.bankName        !== inlineOriginal.bankName        ||
    inlineForm.accountNumber   !== inlineOriginal.accountNumber   ||
    inlineForm.ifsc            !== inlineOriginal.ifsc            ||
    inlineForm.accountHolderName !== inlineOriginal.accountHolderName ||
    inlineForm.upiId           !== inlineOriginal.upiId;

  const sortAccounts = (accs: BankAccount[]) =>
    [...accs].sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<any[]>('/api/pay/bank-accounts');
        if (!cancelled) {
          const mapped: BankAccount[] = data.map((acc: any) => ({
            id: acc.id,
            bankName: acc.bank_name || '',
            accountNumber: acc.account_no || '',
            ifsc: acc.ifsc || '',
            accountHolderName: acc.account_name || 'Account Holder',
            upiId: acc.upi_id || '',
            isPrimary: acc.is_primary || false,
          }));
          setAccounts(sortAccounts(mapped));
        }
      } catch (e) {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  /* ── Inline edit helpers ──────────────────────────────────────────────── */

  const startInlineEdit = (acc: BankAccount, e: React.MouseEvent) => {
    e.stopPropagation();
    setInlineEditId(acc.id);
    setExpandedId(acc.id);
    const initial = {
      bankName: acc.bankName,
      accountNumber: acc.accountNumber,
      ifsc: acc.ifsc,
      accountHolderName: acc.accountHolderName,
      upiId: acc.upiId || '',
    };
    setInlineForm(initial);
    setInlineOriginal(initial);
  };

  const cancelInlineEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setInlineEditId(null);
  };

  // Called after confirmation — actually does the API call
  const executeInlineSave = async () => {
    if (!inlineEditId) return;
    setInlineSaving(true);
    try {
      const payload = {
        id: inlineEditId,
        account_name: inlineForm.accountHolderName,
        account_no: inlineForm.accountNumber,
        ifsc: inlineForm.ifsc,
        bank_name: inlineForm.bankName,
        upi_id: inlineForm.upiId,
      };

      const saved = await api.patch<any>('/api/pay/bank-accounts', payload);

      const updated: BankAccount = {
        id: saved.id,
        bankName: saved.bank_name || '',
        accountNumber: saved.account_no || '',
        ifsc: saved.ifsc || '',
        accountHolderName: saved.account_name || '',
        upiId: saved.upi_id || '',
        isPrimary: saved.is_primary || false,
      };

      setAccounts(prev => sortAccounts(prev.map(a => a.id === inlineEditId ? updated : a)));
      setInlineEditId(null);
    } catch {
      setModalError('Failed to save. Please fill all required fields.');
    } finally {
      setInlineSaving(false);
    }
  };

  // Shows confirmation modal before saving
  const handleInlineSaveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isInlineDirty) return;
    setConfirmConfig({
      isOpen: true,
      title: 'Save Changes?',
      message: 'Are you sure you want to update these bank details?',
      confirmText: 'Yes, Save',
      isDanger: false,
      onConfirm: executeInlineSave,
    });
  };

  /* ── Add modal (for new accounts only) ───────────────────────────────── */

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    bankName: '', accountNumber: '', ifsc: '', accountHolderName: '', upiId: ''
  });
  const [addSaving, setAddSaving] = useState(false);

  const openAddModal = () => {
    setAddForm({ bankName: '', accountNumber: '', ifsc: '', accountHolderName: '', upiId: '' });
    setIsAddModalOpen(true);
  };

  const handleAddSave = async () => {
    setAddSaving(true);
    try {
      const payload = {
        account_name: addForm.accountHolderName,
        account_no: addForm.accountNumber,
        ifsc: addForm.ifsc,
        bank_name: addForm.bankName,
        upi_id: addForm.upiId,
        is_primary: accounts.length === 0 || undefined,
      };

      const saved = await api.post<any>('/api/pay/bank-accounts', payload);

      const newAcc: BankAccount = {
        id: saved.id,
        bankName: saved.bank_name || '',
        accountNumber: saved.account_no || '',
        ifsc: saved.ifsc || '',
        accountHolderName: saved.account_name || '',
        upiId: saved.upi_id || '',
        isPrimary: saved.is_primary || false,
      };

      setAccounts(prev => sortAccounts([newAcc, ...prev]));
      setIsAddModalOpen(false);
    } catch {
      setModalError('Failed to add account. Please fill all required fields.');
    } finally {
      setAddSaving(false);
    }
  };

  /* ── Confirm modal (delete / set primary) ────────────────────────────── */

  const [confirmConfig, setConfirmConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    isDanger: boolean;
    onConfirm: () => void;
  }>({ isOpen: false, title: '', message: '', confirmText: '', isDanger: false, onConfirm: () => {} });

  const closeConfirm = () => setConfirmConfig(prev => ({ ...prev, isOpen: false }));

  /* ── Set Primary ─────────────────────────────────────────────────────── */

  const executeSetPrimary = async (id: string) => {
    closeConfirm();
    try {
      await api.patch('/api/pay/bank-accounts', { id, is_primary: true });
      setAccounts(sortAccounts(accounts.map(a => ({ ...a, isPrimary: a.id === id }))));
    } catch { setModalError('Failed to update primary account.'); }
  };

  const confirmSetPrimary = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmConfig({
      isOpen: true,
      title: 'Set as Primary?',
      message: 'Make this your primary bank account for all transactions?',
      confirmText: 'Yes, Set Primary',
      isDanger: false,
      onConfirm: () => executeSetPrimary(id),
    });
  };

  /* ── Delete ──────────────────────────────────────────────────────────── */

  const [selectPrimaryModal, setSelectPrimaryModal] = useState<{ isOpen: boolean; deleteId: string | null }>({ isOpen: false, deleteId: null });
  const [newPrimarySelection, setNewPrimarySelection] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const executeDelete = async (id: string, newPrimaryId?: string) => {
    closeConfirm();
    setDeleting(true);
    try {
      const accToDelete = accounts.find(a => a.id === id);
      let primaryToSet = newPrimaryId;
      if (accToDelete?.isPrimary && !newPrimaryId && accounts.length === 2) {
        const other = accounts.find(a => a.id !== id);
        if (other) primaryToSet = other.id;
      }

      if (primaryToSet) {
        await api.patch('/api/pay/bank-accounts', { id: primaryToSet, is_primary: true });
      }

      await api.delete(`/api/pay/bank-accounts?id=${id}`);

      setAccounts(prev => {
        let next = prev.filter(a => a.id !== id);
        if (primaryToSet) next = next.map(a => ({ ...a, isPrimary: a.id === primaryToSet }));
        return sortAccounts(next);
      });
      setSelectPrimaryModal({ isOpen: false, deleteId: null });
      if (expandedId === id) setExpandedId(null);
      if (inlineEditId === id) setInlineEditId(null);
    } catch { setModalError('Failed to delete bank account.'); }
    finally { setDeleting(false); }
  };

  const confirmDelete = (acc: BankAccount, e: React.MouseEvent) => {
    e.stopPropagation();
    if (acc.isPrimary && accounts.length > 2) {
      setNewPrimarySelection(null);
      setSelectPrimaryModal({ isOpen: true, deleteId: acc.id });
      return;
    }
    setConfirmConfig({
      isOpen: true,
      title: 'Delete Account?',
      message: 'Remove this bank account? This cannot be undone.',
      confirmText: 'Yes, Delete',
      isDanger: true,
      onConfirm: () => executeDelete(acc.id),
    });
  };

  /* ── Toggle expand (only when not in edit mode) ───────────────────────── */

  const toggleExpand = (id: string) => {
    if (inlineEditId === id) return; // don't collapse while editing
    setExpandedId(prev => (prev === id ? null : id));
  };

  /* ── Render ───────────────────────────────────────────────────────────── */

  return (
    <div className="desktop-layout">
            <main className="main-viewport">
        <div className="app-container bd-root">
          {/* Header */}
          <div className="bd-header">
            <Link href="/profile" className="bd-back-btn" suppressHydrationWarning>
              <i className="fas fa-chevron-left"></i>
            </Link>
            <h1 className="bd-title">Bank Details</h1>
            <div style={{ width: 40 }} />
          </div>

          <div className="bd-content">
            <p className="bd-subtitle">Manage your linked bank accounts for withdrawals and deposits.</p>

            {loading ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--bd-muted, #8F9BB3)' }}>
                <AnimatedLoader />
              </div>
            ) : (
              <>
                <div className="bd-accounts-list">
                  {accounts.length === 0 ? (
                    <div className="bd-empty-state">
                      <div className="bd-empty-icon"><i className="fas fa-university" /></div>
                      <p>No bank accounts linked yet.</p>
                    </div>
                  ) : (
                    accounts.map(acc => {
                      const isExpanded = expandedId === acc.id;
                      const isEditing = inlineEditId === acc.id;

                      return (
                        <div
                          key={acc.id}
                          ref={el => { if (el) cardRefs.current.set(acc.id, el); else cardRefs.current.delete(acc.id); }}
                          className={`bd-card${acc.isPrimary ? ' primary-card' : ''}${isExpanded ? ' bd-card--expanded' : ''}${isEditing ? ' bd-card--editing' : ''}`}
                          onClick={() => toggleExpand(acc.id)}
                        >
                          {/* ── Header row ── */}
                          <div className="bd-card-header">
                            <div className="bd-bank-info">
                              <div className="bd-bank-icon">
                                <i className="fas fa-university" />
                              </div>
                              <div className="bd-bank-meta">
                                {/* Bank name — editable inline or static */}
                                {isEditing ? (
                                  <input
                                    className="bd-inline-input bd-inline-name"
                                    value={inlineForm.bankName}
                                    placeholder="Bank Name"
                                    onChange={e => setInlineForm(f => ({ ...f, bankName: e.target.value }))}
                                    onClick={e => e.stopPropagation()}
                                    suppressHydrationWarning
                                  />
                                ) : (
                                  <h3 className="bd-bank-name">{acc.bankName || 'Bank Account'}</h3>
                                )}
                                {acc.isPrimary && !isEditing && (
                                  <span className="bd-badge-primary">Primary</span>
                                )}
                              </div>
                            </div>

                            <div className="bd-card-actions" onClick={e => e.stopPropagation()}>
                              {isEditing ? null : (
                                <>
                                  <button
                                    type="button"
                                    className="bd-icon-btn edit"
                                    onClick={e => startInlineEdit(acc, e)}
                                    suppressHydrationWarning
                                    title="Edit"
                                  >
                                    <i className="fas fa-pen" />
                                  </button>
                                  <button
                                    type="button"
                                    className="bd-icon-btn delete"
                                    onClick={e => confirmDelete(acc, e)}
                                    suppressHydrationWarning
                                    title="Delete"
                                  >
                                    <i className="fas fa-trash" />
                                  </button>
                                </>
                              )}
                            </div>
                            {/* Chevron — shows expand state, not in edit mode */}
                            {!isEditing && (
                              <div className="bd-chevron" onClick={e => { e.stopPropagation(); toggleExpand(acc.id); }}>
                                <i className={`fas fa-chevron-right${isExpanded ? ' rotated' : ''}`} />
                              </div>
                            )}
                          </div>

                          {/* ── Expandable / editable section ── */}
                          <div className={`bd-card-expand${isExpanded ? ' open' : ''}`}>
                            <div className="bd-expand-inner">
                              <div className="bd-divider" />

                              {isEditing ? (
                                /* ── Inline edit fields ── */
                                <div
                                  className="bd-inline-fields"
                                  onClick={e => e.stopPropagation()}
                                >
                                  <div className="bd-inline-field-row">
                                    <label className="bd-inline-label">Account No.</label>
                                    <input
                                      className="bd-inline-input"
                                      value={inlineForm.accountNumber}
                                      placeholder="Account number"
                                      onChange={e => setInlineForm(f => ({ ...f, accountNumber: e.target.value }))}
                                      suppressHydrationWarning
                                    />
                                  </div>
                                  <div className="bd-inline-field-row">
                                    <label className="bd-inline-label">IFSC Code</label>
                                    <input
                                      className="bd-inline-input"
                                      value={inlineForm.ifsc}
                                      placeholder="e.g. SBIN0001234"
                                      onChange={e => setInlineForm(f => ({ ...f, ifsc: e.target.value }))}
                                      suppressHydrationWarning
                                    />
                                  </div>
                                  <div className="bd-inline-field-row">
                                    <label className="bd-inline-label">Holder Name</label>
                                    <input
                                      className="bd-inline-input"
                                      value={inlineForm.accountHolderName}
                                      placeholder="Name as per bank"
                                      onChange={e => setInlineForm(f => ({ ...f, accountHolderName: e.target.value }))}
                                      suppressHydrationWarning
                                    />
                                  </div>
                                  <div className="bd-inline-field-row">
                                    <label className="bd-inline-label">UPI ID</label>
                                    <input
                                      className="bd-inline-input"
                                      value={inlineForm.upiId}
                                      placeholder="name@upi"
                                      onChange={e => setInlineForm(f => ({ ...f, upiId: e.target.value }))}
                                      suppressHydrationWarning
                                    />
                                  </div>

                                  {/* ── Save / Cancel row ── */}
                                  <div className="bd-inline-action-row">
                                    <button
                                      type="button"
                                      className="bd-inline-cancel-btn"
                                      onClick={cancelInlineEdit}
                                      suppressHydrationWarning
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      className={`bd-inline-save-btn${isInlineDirty ? ' dirty' : ''}`}
                                      onClick={handleInlineSaveClick}
                                      disabled={inlineSaving || !isInlineDirty}
                                      suppressHydrationWarning
                                    >
                                      {inlineSaving
                                        ? <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><AnimatedLoader size="small" /> Saving...</span>
                                        : <><i className="fas fa-check" /> Save Changes</>}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                /* ── Read-only detail rows ── */
                                <div className="bd-detail-grid">
                                  <div className="bd-detail-item">
                                    <span className="bd-detail-label">Account No.</span>
                                    <span className="bd-detail-value">{acc.accountNumber || '—'}</span>
                                  </div>
                                  <div className="bd-detail-item">
                                    <span className="bd-detail-label">IFSC Code</span>
                                    <span className="bd-detail-value">{acc.ifsc || '—'}</span>
                                  </div>
                                  <div className="bd-detail-item">
                                    <span className="bd-detail-label">Holder Name</span>
                                    <span className="bd-detail-value">{acc.accountHolderName || '—'}</span>
                                  </div>
                                  {acc.upiId && (
                                    <div className="bd-detail-item">
                                      <span className="bd-detail-label">UPI ID</span>
                                      <span className="bd-detail-value">{acc.upiId}</span>
                                    </div>
                                  )}
                                </div>
                              )}

                              {!acc.isPrimary && !isEditing && (
                                <button
                                  className="bd-set-primary-btn"
                                  onClick={e => confirmSetPrimary(acc.id, e)}
                                  suppressHydrationWarning
                                >
                                  <i className="fas fa-star" />
                                  Set as Primary
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <button type="button" className="bd-add-btn" onClick={openAddModal} suppressHydrationWarning>
                  <i className="fas fa-plus" /> Add Bank Account
                </button>
              </>
            )}
          </div>

          {/* ── Add Account Modal ── */}
          <div className={`bd-modal-overlay ${isAddModalOpen ? 'open' : ''}`} onClick={() => setIsAddModalOpen(false)} />
          <div className={`bd-modal ${isAddModalOpen ? 'open' : ''}`}>
            <div className="bd-modal-header">
              <h3>Add Bank Account</h3>
              <button type="button" suppressHydrationWarning className="bd-modal-close" onClick={() => setIsAddModalOpen(false)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="bd-modal-body">
              {[
                { label: 'Bank Name', icon: 'fa-university', key: 'bankName', placeholder: 'e.g. HDFC, SBI' },
                { label: 'Account Number *', icon: 'fa-hashtag', key: 'accountNumber', placeholder: 'Enter account number' },
                { label: 'IFSC Code *', icon: 'fa-code-branch', key: 'ifsc', placeholder: 'e.g. SBIN0001234' },
                { label: 'Account Holder Name *', icon: 'fa-user', key: 'accountHolderName', placeholder: 'Name as per bank records' },
                { label: 'UPI ID', icon: 'fa-qrcode', key: 'upiId', placeholder: 'name@upi' },
              ].map(f => (
                <div key={f.key} className="bd-form-group">
                  <label><i className={`fas ${f.icon}`} /> {f.label}</label>
                  <input
                    type="text"
                    placeholder={f.placeholder}
                    value={addForm[f.key as keyof typeof addForm]}
                    onChange={e => setAddForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    suppressHydrationWarning
                  />
                </div>
              ))}
              <button type="button" className="bd-save-btn" onClick={handleAddSave} disabled={addSaving} suppressHydrationWarning>
                {addSaving ? <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><AnimatedLoader size="small" /> Saving...</span> : 'Add Account'}
              </button>
            </div>
          </div>

          {/* ── Confirm Modal ── */}
          <div className={`bd-modal-overlay ${confirmConfig.isOpen ? 'open' : ''}`} style={{ zIndex: 3000 }} onClick={closeConfirm} />
          <div
            className={`bd-modal bd-confirm-modal ${confirmConfig.isOpen ? 'open' : ''}`}
            style={{ zIndex: 3001 }}
          >
            <div className="bd-modal-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              <h3>{confirmConfig.title}</h3>
            </div>
            <div className="bd-modal-body" style={{ paddingTop: '10px' }}>
              <p style={{ color: '#6B728E', fontSize: '0.9rem', marginBottom: '24px', lineHeight: '1.6' }}>
                {confirmConfig.message}
              </p>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  type="button"
                  suppressHydrationWarning
                  className="bd-outline-btn"
                  onClick={closeConfirm}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  suppressHydrationWarning
                  className="bd-save-btn"
                  style={{ flex: 1, margin: 0, borderRadius: '14px', background: confirmConfig.isDanger ? '#C62E2E' : '#2C8E5A' }}
                  onClick={() => confirmConfig.onConfirm()}
                  disabled={deleting}
                >
                  {deleting ? 'Processing...' : confirmConfig.confirmText}
                </button>
              </div>
            </div>
          </div>

          {/* ── Select New Primary (before delete) ── */}
          <div className={`bd-modal-overlay ${selectPrimaryModal.isOpen ? 'open' : ''}`} style={{ zIndex: 3000 }} onClick={() => setSelectPrimaryModal({ isOpen: false, deleteId: null })} />
          <div
            className={`bd-modal bd-confirm-modal ${selectPrimaryModal.isOpen ? 'open' : ''}`}
            style={{ zIndex: 3001 }}
          >
            <div className="bd-modal-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              <h3>Select New Primary</h3>
            </div>
            <div className="bd-modal-body" style={{ paddingTop: '10px' }}>
              <p style={{ color: '#6B728E', fontSize: '0.9rem', marginBottom: '16px', lineHeight: '1.6' }}>
                You are deleting your primary account. Select another to become primary.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
                {accounts.filter(a => a.id !== selectPrimaryModal.deleteId).map(acc => (
                  <div
                    key={acc.id}
                    onClick={() => setNewPrimarySelection(acc.id)}
                    style={{
                      padding: '12px 16px', borderRadius: '14px', cursor: 'pointer', transition: '0.2s',
                      border: newPrimarySelection === acc.id ? '2px solid #2C8E5A' : '1px solid #EEF2F8',
                      background: newPrimarySelection === acc.id ? '#F0FDF4' : '#F8FAFF',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, color: '#1A1E2B', fontSize: '0.9rem' }}>{acc.bankName || 'Bank Account'}</div>
                      <div style={{ fontSize: '0.75rem', color: '#8F9BB3', marginTop: '2px' }}>{acc.accountNumber}</div>
                    </div>
                    {newPrimarySelection === acc.id && <i className="fas fa-check-circle" style={{ color: '#2C8E5A', fontSize: '1.1rem' }} />}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  type="button"
                  suppressHydrationWarning
                  className="bd-outline-btn"
                  onClick={() => setSelectPrimaryModal({ isOpen: false, deleteId: null })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  suppressHydrationWarning
                  className="bd-save-btn"
                  style={{ flex: 1, margin: 0, borderRadius: '14px', background: '#C62E2E' }}
                  onClick={() => {
                    if (newPrimarySelection && selectPrimaryModal.deleteId)
                      executeDelete(selectPrimaryModal.deleteId, newPrimarySelection);
                  }}
                  disabled={deleting || !newPrimarySelection}
                >
                  {deleting ? 'Deleting...' : 'Confirm Delete'}
                </button>
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
