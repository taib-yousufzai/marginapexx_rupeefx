'use client';
import React, { useState, useEffect, useRef } from 'react';
import { getSession } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { pageCache } from '@/lib/pageCache';
import './page.css';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import QRCode from 'react-qr-code';
import { useBalance } from '@/hooks/useBalance';
import { api, ApiError } from '@/lib/api';

type ActiveAccountResponse = {
  id: string;
  account_holder: string;
  bank_name: string;
  account_no: string;
  ifsc: string;
  upi_id: string;
  qr_image_url: string;
};

type SavedAccount = {
  id: string;
  account_name: string;
  account_no: string;
  ifsc: string;
  bank_name?: string;
  upi_id?: string;
  is_primary: boolean;
};

export default function FundsPage() {
  useAuth();
  const [isDemo, setIsDemo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [depositStep, setDepositStep] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState<string>('1000');

  const { balance, settlementAmount, loading: balanceLoading } = useBalance();
  const balanceError = null;

  const [accountName, setAccountName] = useState<string>('');
  const [bankName, setBankName] = useState<string>('');
  const [accountNo, setAccountNo] = useState<string>('');
  const [ifsc, setIfsc] = useState<string>('');
  const [upi, setUpi] = useState<string>('');

  const [activeAccount, setActiveAccount] = useState<ActiveAccountResponse | null>(null);
  const [activeAccountLoading, setActiveAccountLoading] = useState<boolean>(false);
  const [activeAccountError, setActiveAccountError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'UPI' | 'BANK_TRANSFER' | null>(null);

  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [isAddingAccount, setIsAddingAccount] = useState<boolean>(false);
  const [isAccountDrawerOpen, setIsAccountDrawerOpen] = useState<boolean>(false);

  const [rules, setRules] = useState<any>(null);
  const [showRules, setShowRules] = useState<boolean>(false);

  const [utr, setUtr] = useState<string>('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitted, setSubmitted] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setToast({ message: `${label} copied!`, type: 'success' });
    setTimeout(() => setToast(null), 2000);
  };

  const handleWhatsAppSupport = () => {
    window.open('https://wa.me/918796119115', '_blank');
  };

  const downloadQRCode = () => {
    const svg = document.querySelector(".qr-container svg") as SVGGraphicsElement;
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      canvas.width = 1000;
      canvas.height = 1000;
      if (ctx) {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 50, 50, 900, 900);
      }
      const pngFile = canvas.toDataURL("image/png");
      const downloadLink = document.createElement("a");
      downloadLink.download = `MarginApex_QR_${amount}.png`;
      downloadLink.href = pngFile;
      downloadLink.click();
    };
    img.src = `data:image/svg+xml;base64,${btoa(svgData)}`;
  };

  useEffect(() => {
    let cancelled = false;
    fetchSavedAccounts();
    api.get<{ demo_user?: boolean }>('/api/user/profile')
      .then(data => { if (!cancelled) setIsDemo(data.demo_user === true); })
      .catch(() => { });
    api.get<any>('/api/pay/rules')
      .then(data => { if (!cancelled) setRules(data); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  const fetchSavedAccounts = async () => {
    try {
      const data = await api.get<SavedAccount[]>('/api/pay/bank-accounts');
      setSavedAccounts(data);
      const primary = data.find(a => a.is_primary);
      if (primary) setSelectedAccountId(primary.id);
      else if (data.length > 0) setSelectedAccountId(data[0].id);
    } catch (err) {
      console.error('Failed to fetch bank accounts:', err);
    }
  };

  const handleTabChange = (tab: 'deposit' | 'withdraw') => {
    setActiveTab(tab);
    setDepositStep(1);
    setSubmitted(false);
    setSubmitError(null);
    setPaymentMethod(null);
    setAmount('1000');
  };

  const handleProceedToPay = async (method: 'UPI' | 'BANK_TRANSFER') => {
    setSubmitError(null);
    setActiveAccountError(null);
    setPaymentMethod(method);

    const numAmount = Number(amount);
    if (!amount || isNaN(numAmount) || numAmount < 1000) {
      setToast({ message: 'Minimum deposit is ₹1,000', type: 'error' });
      return;
    }

    setActiveAccountLoading(true);
    try {
      const account = await api.get<ActiveAccountResponse>('/api/pay/active-account');
      setActiveAccount(account);
      setActiveAccountLoading(false);
      setDepositStep(2);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setActiveAccount(null);
        setActiveAccountLoading(false);
        setDepositStep(2);
      } else if (err instanceof ApiError) {
        const details = err.details as Record<string, unknown> | undefined;
        setActiveAccountError((details?.error as string) ?? 'Failed to fetch payment account.');
        setActiveAccountLoading(false);
      } else {
        setActiveAccountError('Network error. Please try again.');
        setActiveAccountLoading(false);
      }
    }
  };

  const handleConfirmDeposit = async () => {
    setSubmitError(null);
    const numAmount = Number(amount);
    if (!amount || isNaN(numAmount) || numAmount < 1000) return;
    if (!activeAccount) return;
    if (utr && !/^\d{12}$/.test(utr)) {
      setSubmitError('Invalid UTR: Must be exactly 12 digits');
      return;
    }
    if (!screenshot) {
      setSubmitError('Payment screenshot is required');
      return;
    }

    setSubmitting(true);
    try {
      const session = await getSession();
      if (!session) return;

      const fileExt = screenshot.name.split('.').pop();
      const fileName = `${session.user.id}-${Date.now()}.${fileExt}`;
      const filePath = `payments/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('payments')
        .upload(filePath, screenshot);

      if (uploadError) throw new Error('Failed to upload screenshot.');

      const { data: { publicUrl } } = supabase.storage
        .from('payments')
        .getPublicUrl(filePath);

      await api.post('/api/pay/request', {
        type: 'DEPOSIT',
        amount: numAmount,
        payment_account_id: activeAccount.id,
        utr: utr || undefined,
        screenshot_url: publicUrl,
      });
      setSubmitted(true);
      setScreenshot(null);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as Record<string, unknown> | undefined;
        setSubmitError((details?.error as string) ?? 'Something went wrong.');
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Network error.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAccount = async () => {
    if (!accountName || !accountNo || !ifsc || !bankName) {
      setToast({ message: 'Please fill all required fields', type: 'error' });
      return;
    }
    setSubmitting(true);
    try {
      const newAcc = await api.post<SavedAccount>('/api/pay/bank-accounts', {
        account_name: accountName,
        bank_name: bankName,
        account_no: accountNo,
        ifsc,
        upi_id: upi || undefined,
        is_primary: savedAccounts.length === 0
      });
      setSavedAccounts([newAcc, ...savedAccounts]);
      setSelectedAccountId(newAcc.id);
      setIsAddingAccount(false);
      setAccountName(''); setBankName(''); setAccountNo(''); setIfsc(''); setUpi('');
      setToast({ message: 'Bank account saved!', type: 'success' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async () => {
    const numAmount = Number(amount);
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      setToast({ message: 'Please enter a valid withdrawal amount.', type: 'error' });
      return;
    }
    const acc = savedAccounts.find(a => a.id === selectedAccountId);
    if (!acc) {
      setToast({ message: 'Please select a destination account first.', type: 'error' });
      return;
    }
    if (numAmount > (balance || 0)) {
      setToast({ message: 'Insufficient balance for withdrawal.', type: 'error' });
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/pay/request', {
        type: 'WITHDRAWAL',
        amount: numAmount,
        account_name: acc.account_name,
        account_no: acc.account_no,
        ifsc: acc.ifsc,
        upi: acc.upi_id || undefined,
      });
      setSubmitted(true);
      setToast({ message: 'Withdrawal request submitted!', type: 'success' });
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as Record<string, unknown> | undefined;
        setSubmitError((details?.error as string) ?? 'Something went wrong.');
      } else {
        setSubmitError('Network error.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const withdrawDisabled = submitting || submitted;

  return (
    <div className="desktop-layout">

      <main className="main-viewport">
        <div className="app-container funds-shell">
          {/* ── Header (Mobile Only) ── */}
          <div className="nav-bar-full mobile-only">
            <Link href="/" className="nav-icon-btn"><i className="fas fa-arrow-left"></i></Link>
            <div className="nav-app-name">Manage <span style={{ color: '#006400', marginLeft: '4px' }}>Funds</span></div>
            <div style={{ width: '40px' }}></div>
          </div>

          {/* ── Desktop Page Header ── */}
          <div className="desktop-only" style={{ padding: '20px 24px 0 24px' }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Funds Management</h1>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>Deposit, withdraw and manage your trading capital</p>
          </div>

          <div className="main-scroll-wrapper" style={{ flex: 1, overflowY: 'auto' }}>
            <div className="main-content screen">
              <div className="content-padded" style={{ paddingTop: '20px' }}>

                <div className="balance-card" style={{ marginBottom: '24px' }}>
                  <p className="balance-label">Total Current Balance</p>
                  <h1 className="balance-amount">
                    {balanceLoading ? <span style={{ fontSize: '1.2rem', opacity: 0.7 }}>Loading…</span> : `₹${balance?.toFixed(2) ?? '0.00'}`}
                  </h1>
                  {balanceError && <p style={{ fontSize: '0.7rem', color: '#ff6464', marginBottom: '8px' }}>{balanceError}</p>}
                  <div className="balance-chip" style={{ marginTop: '0px' }}><i className="fas fa-shield-check"></i> 100% Encrypted & Secure</div>
                </div>

                {isDemo ? (
                  <div className="adm-dashed-box" style={{ marginTop: 40, textAlign: 'center', padding: '40px 20px', borderRadius: 16, background: 'var(--card-bg)' }}>
                    <i className="fas fa-ban" style={{ fontSize: '2rem', color: '#8b949e', marginBottom: 16 }}></i>
                    <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Not Available</h3>
                    <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>Funds management is disabled for demo accounts.</p>
                  </div>
                ) : (
                  <>
                    <div className="funds-toggle-wrapper" style={{ marginBottom: '24px' }}>
                      <div className={`funds-toggle-slider ${activeTab === 'withdraw' ? 'slide-right' : ''}`}></div>
                      <div className={`funds-cat-btn ${activeTab === 'deposit' ? 'active' : ''}`} onClick={() => handleTabChange('deposit')}>DEPOSIT</div>
                      <div className={`funds-cat-btn ${activeTab === 'withdraw' ? 'active' : ''}`} onClick={() => handleTabChange('withdraw')}>WITHDRAW</div>
                    </div>

                    <div className="payment-box">
                      {activeTab === 'deposit' && (
                        <div className="deposit-container">
                          <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                            <span style={{ fontSize: '0.7rem', color: '#006400', background: 'rgba(0,100,0,0.1)', padding: '4px 8px', borderRadius: '4px', fontWeight: 700 }}><i className="fas fa-clock"></i> 24*7 Deposits Available</span>
                          </div>
                          {!submitted && (
                            <div className="deposit-stepper" style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
                              {[1, 2, 3].map(s => (
                                <div key={s} style={{ flex: 1, height: '4px', background: depositStep >= s ? '#006400' : 'var(--border-card)', borderRadius: '2px' }} />
                              ))}
                            </div>
                          )}

                          {depositStep === 1 && !submitted && (
                            <div className="step-1-area fadeInUp">
                              <label>Amount (INR)</label>
                              <div className="amount-input-wrapper">
                                <span className="currency-symbol">₹</span>
                                <input type="number" className="amount-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                              </div>
                              <div className="quick-amounts">
                                {[1000, 2000, 5000, 10000].map(val => (
                                  <div key={val} className="quick-btn" onClick={() => setAmount(val.toString())}>+₹{val}</div>
                                ))}
                              </div>

                              <div className="method-choice-title" style={{ marginTop: '24px', fontSize: '0.75rem', fontWeight: 800, color: 'var(--text-muted)', marginBottom: '16px', textAlign: 'center', letterSpacing: '0.5px' }}>CHOOSE PAYMENT METHOD</div>
                              <div className="method-choice-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                                <button className="method-btn-direct" disabled={Number(amount) < 1000 || activeAccountLoading} onClick={() => handleProceedToPay('UPI')}>
                                  <i className="fas fa-qrcode"></i>
                                  <span>Pay via UPI</span>
                                </button>
                                <button className="method-btn-direct" disabled={Number(amount) < 1000 || activeAccountLoading} onClick={() => handleProceedToPay('BANK_TRANSFER')}>
                                  <i className="fas fa-university"></i>
                                  <span>Bank Transfer</span>
                                </button>
                              </div>
                              {Number(amount) < 1000 && <p style={{ fontSize: '0.7rem', color: '#c0392b', marginTop: '12px', textAlign: 'center', fontWeight: 600 }}>Minimum deposit is ₹1,000</p>}
                              {activeAccountError && <p style={{ fontSize: '0.7rem', color: '#c0392b', marginTop: '12px', textAlign: 'center' }}>{activeAccountError}</p>}
                              {submitError && <p style={{ fontSize: '0.7rem', color: '#c0392b', marginTop: '12px', textAlign: 'center' }}>{submitError}</p>}
                            </div>
                          )}

                          {depositStep === 2 && !submitted && (
                            <div className="step-2-area fadeInUp">
                              <div className="section-title" style={{ fontSize: '0.8rem', fontWeight: 800, marginBottom: '20px', color: 'var(--text-primary)' }}>
                                PAYMENT DETAILS ({paymentMethod === 'UPI' ? 'UPI' : 'BANK'})
                              </div>
                              <div className="payment-details-card">
                                <div className="amount-edit-row" style={{ marginBottom: '20px', padding: '16px', background: 'var(--icon-bg)', borderRadius: '16px', border: '1px solid var(--border-card)' }}>
                                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px', display: 'block' }}>CONFIRM DEPOSIT AMOUNT</label>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontSize: '1.5rem', fontWeight: 800 }}>₹</span>
                                    <input
                                      type="number"
                                      value={amount}
                                      onChange={(e) => setAmount(e.target.value)}
                                      style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', width: '100%' }}
                                    />
                                  </div>
                                </div>

                                {paymentMethod === 'UPI' ? (
                                  <div className="upi-payment-info" style={{ textAlign: 'center' }}>
                                    {activeAccount?.qr_image_url ? (
                                      <div className="qr-box-wrapper" style={{ marginBottom: '24px' }}>
                                        <div className="qr-container" style={{ background: 'white', padding: '20px', borderRadius: '24px', display: 'inline-block', boxShadow: '0 8px 30px rgba(0,0,0,0.08)', border: '1px solid #eee' }}>
                                          <img src={activeAccount.qr_image_url} alt="Payment QR" style={{ width: 200, height: 200, objectFit: 'contain' }} />
                                        </div>
                                        <button
                                          onClick={downloadQRCode}
                                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', margin: '16px auto 0', background: 'var(--icon-bg)', border: '1px solid var(--border-card)', padding: '10px 20px', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer' }}
                                        >
                                          <i className="fas fa-download"></i> Download QR
                                        </button>
                                      </div>
                                    ) : activeAccount?.upi_id ? (
                                      <div className="qr-box-wrapper" style={{ marginBottom: '24px' }}>
                                        <div className="qr-container" style={{ background: 'white', padding: '20px', borderRadius: '24px', display: 'inline-block', boxShadow: '0 8px 30px rgba(0,0,0,0.08)', border: '1px solid #eee' }}>
                                          <QRCode value={`upi://pay?pa=${activeAccount.upi_id}&pn=${encodeURIComponent(activeAccount.account_holder || '')}&am=${amount}&cu=INR`} size={200} />
                                        </div>
                                        <button
                                          onClick={downloadQRCode}
                                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', margin: '16px auto 0', background: 'var(--icon-bg)', border: '1px solid var(--border-card)', padding: '10px 20px', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer' }}
                                        >
                                          <i className="fas fa-download"></i> Download QR
                                        </button>
                                      </div>
                                    ) : (
                                      <div style={{ padding: '20px', marginBottom: '20px', background: 'var(--icon-bg)', borderRadius: '12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                        -
                                      </div>
                                    )}

                                    <div className="section-divider" style={{ height: '1px', background: 'var(--border-card)', margin: '20px 0', borderBottom: '1px dashed var(--border-card)' }}></div>

                                    <div className="copyable-row" onClick={() => (activeAccount?.upi_id ? copyToClipboard(activeAccount.upi_id, 'UPI ID') : null)}>
                                      <div><strong>UPI ID / VPA</strong><span>{activeAccount?.upi_id || '-'}</span></div>
                                      {activeAccount?.upi_id ? <i className="fas fa-copy copy-icon"></i> : null}
                                    </div>
                                    <div className="copyable-row" onClick={() => (activeAccount?.account_holder ? copyToClipboard(activeAccount.account_holder, 'Beneficiary') : null)}>
                                      <div><strong>Beneficiary Name</strong><span>{activeAccount?.account_holder || '-'}</span></div>
                                      {activeAccount?.account_holder ? <i className="fas fa-copy copy-icon"></i> : null}
                                    </div>

                                    <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '16px', lineHeight: '1.5' }}>
                                      <i className="fas fa-info-circle"></i> Scan the QR code or copy details to pay using any UPI app like PhonePe, Google Pay, or Paytm.
                                    </p>
                                  </div>
                                ) : (
                                  <div className="bank-payment-info">
                                    {[
                                      { label: 'Beneficiary', value: activeAccount?.account_holder || '-' },
                                      { label: 'Account No', value: activeAccount?.account_no || '-' },
                                      { label: 'IFSC Code', value: activeAccount?.ifsc || '-' },
                                      { label: 'Bank Name', value: activeAccount?.bank_name || '-' }
                                    ].map((item, idx) => (
                                      <div key={idx} className="copyable-row" onClick={() => item.value !== '-' && copyToClipboard(item.value, item.label)}>
                                        <div><strong>{item.label}</strong><span>{item.value}</span></div>
                                        {item.value !== '-' && <i className="fas fa-copy copy-icon"></i>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <button className="submit-funds-btn" style={{ marginTop: '24px' }} onClick={() => setDepositStep(3)}>
                                  I Have Paid <i className="fas fa-chevron-right"></i>
                                </button>
                                <button className="back-link" onClick={() => setDepositStep(1)} style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: '16px', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer' }}>
                                  <i className="fas fa-arrow-left"></i> Change Amount / Method
                                </button>
                              </div>
                            </div>
                          )}

                          {depositStep === 3 && !submitted && (
                            <div className="step-3-area fadeInUp">
                              <div className="section-title" style={{ fontSize: '0.8rem', fontWeight: 800, marginBottom: '20px', color: 'var(--text-primary)' }}>VERIFY TRANSACTION</div>
                              <div className="input-group" style={{ marginBottom: '20px' }}>
                                <label>12-DIGIT UTR NUMBER</label>
                                <input type="text" className="amount-input" style={{ fontSize: '1.2rem', padding: '15px', background: 'var(--icon-bg)', borderRadius: '12px' }} maxLength={12} placeholder="Enter UTR / Ref No" value={utr} onChange={(e) => setUtr(e.target.value.replace(/[^0-9]/g, ''))} />
                              </div>
                              <div className="upload-group" style={{ marginBottom: '24px' }}>
                                <label>PAYMENT SCREENSHOT</label>
                                <div className="screenshot-dropzone" style={{ border: '2px dashed var(--border-card)', borderRadius: '16px', padding: '30px', textAlign: 'center', cursor: 'pointer' }} onClick={() => fileInputRef.current?.click()}>
                                  {screenshot ? <span><i className="fas fa-file-image"></i> {screenshot.name}</span> : <span><i className="fas fa-cloud-upload"></i> Upload Screenshot</span>}
                                </div>
                                <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept="image/*" onChange={(e) => setScreenshot(e.target.files?.[0] || null)} />
                              </div>
                              <button className="submit-funds-btn" disabled={(utr.length > 0 && utr.length !== 12) || !screenshot || submitting} onClick={handleConfirmDeposit}>
                                {submitting ? 'Processing...' : 'Submit Deposit Request'}
                              </button>
                              {submitError && <p style={{ fontSize: '0.7rem', color: '#c0392b', marginTop: '12px', textAlign: 'center' }}>{submitError}</p>}
                            </div>
                          )}

                          {submitted && (
                            <div className="success-area fadeInUp" style={{ textAlign: 'center', padding: '20px 0' }}>
                              <div style={{ fontSize: '3rem', color: '#006400', marginBottom: '16px' }}><i className="fas fa-check-circle"></i></div>
                              <h3 style={{ fontWeight: 800, marginBottom: '8px' }}>Request Submitted</h3>
                              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '24px' }}>Your request for ₹{amount} is pending verification. Funds usually reflect within 60 mins.</p>
                              <button className="submit-funds-btn" onClick={() => handleTabChange('deposit')}>Done</button>
                            </div>
                          )}
                        </div>
                      )}

                      {activeTab === 'withdraw' && (
                        <div className="withdraw-container fadeInUp">
                          <div className="withdrawal-rules-list" style={{ marginBottom: '24px', background: 'var(--card-bg)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-card)' }}>
                            <h4 style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Important Details</h4>

                            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}><strong>Timings:</strong> {rules?.start_time || '10:00 AM'} to {rules?.end_time || '6:00 PM'} ({(rules?.allowed_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).join(', ')})</span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}><strong>Min Withdrawal:</strong> ₹{rules?.min_withdraw || '1000'}</span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}><strong>Daily Limit:</strong> No Limit</span>
                            </div>
                          </div>

                          <label>Withdrawal Amount</label>
                          <div className="amount-input-wrapper">
                            <span className="currency-symbol">₹</span>
                            <input type="number" className="amount-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                          </div>

                          <div className="withdrawal-breakdown-card">
                            <div className="breakdown-row"><span>Payout Amount</span><span>₹{amount || '0'}</span></div>
                            <div className="breakdown-row"><span>Processing Fee</span><span style={{ color: '#006400' }}>FREE</span></div>
                            <div className="breakdown-divider"></div>
                            <div className="breakdown-row"><strong>Total Payout</strong><strong style={{ color: '#006400' }}>₹{amount || '0'}</strong></div>
                          </div>

                          <div className="bank-selector-section" style={{ marginBottom: '24px' }}>
                            <label>Destination Account</label>
                            <div className="bank-selector-card" onClick={() => setIsAccountDrawerOpen(true)}>
                              <div className="bank-card-icon"><i className="fas fa-university"></i></div>
                              <div className="bank-card-info">
                                {selectedAccountId ? (
                                  <>
                                    <div className="bank-name-main">{savedAccounts.find(a => a.id === selectedAccountId)?.bank_name || 'Bank Account'}</div>
                                    <div className="bank-acc-no">{savedAccounts.find(a => a.id === selectedAccountId)?.account_no}</div>
                                  </>
                                ) : <div className="bank-placeholder">Select Account</div>}
                              </div>
                              <i className="fas fa-chevron-right"></i>
                            </div>
                          </div>
                          <button className="submit-funds-btn" disabled={withdrawDisabled} onClick={handleWithdraw}>
                            {submitting ? 'Processing...' : 'Withdraw Funds'}
                          </button>
                          {submitError && <p style={{ fontSize: '0.7rem', color: '#c0392b', marginTop: '12px', textAlign: 'center' }}>{submitError}</p>}
                        </div>
                      )}
                    </div>
                  </>
                )}

                <div className="whatsapp-community" onClick={handleWhatsAppSupport} style={{ marginTop: '24px' }}>
                  <div className="whatsapp-inner">
                    <div className="whatsapp-icon"><i className="fab fa-whatsapp"></i></div>
                    <div className="whatsapp-content">
                      <div className="whatsapp-headline">Facing any issue? Contact Support</div>
                      <div className="whatsapp-sub"><i className="fas fa-headset"></i> Get help on WhatsApp</div>
                    </div>
                    <div className="whatsapp-arrow"><i className="fas fa-chevron-right"></i></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Account Drawer */}
          <div className={`expiry-half-drawer-overlay ${isAccountDrawerOpen ? 'active' : ''}`} onClick={() => setIsAccountDrawerOpen(false)}>
            <div className="expiry-half-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="expiry-sheet-header"><h3>Select Bank Account</h3><div className="expiry-sheet-close" onClick={() => setIsAccountDrawerOpen(false)}><i className="fas fa-times"></i></div></div>
              <div className="accounts-list">
                {savedAccounts.map(acc => (
                  <div key={acc.id} className={`account-item ${selectedAccountId === acc.id ? 'active' : ''}`} onClick={() => { setSelectedAccountId(acc.id); setIsAccountDrawerOpen(false); }}>
                    <div className="acc-icon"><i className="fas fa-university"></i></div>
                    <div className="acc-details"><div className="acc-name">{acc.account_name}</div><div className="acc-no">{acc.account_no} • {acc.ifsc}</div></div>
                    {selectedAccountId === acc.id && <i className="fas fa-check-circle"></i>}
                  </div>
                ))}
                <div className="add-account-btn" onClick={() => { setIsAddingAccount(true); setIsAccountDrawerOpen(false); }}><i className="fas fa-plus"></i> Add New Account</div>
              </div>
            </div>
          </div>

          {/* Add Account Overlay - REFACTORED */}
          {isAddingAccount && (
            <div className="add-account-overlay fadeInUp">
              <div className="modal-header">
                <h4>Add New Bank Account</h4>
                <button className="close-btn" onClick={() => setIsAddingAccount(false)}>
                  <i className="fas fa-times"></i>
                </button>
              </div>

              <div className="form-group">
                <label>Bank Name</label>
                <input type="text" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. HDFC Bank, SBI, etc." />
              </div>

              <div className="form-group">
                <label>Account Holder Name</label>
                <input type="text" value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Full name as per bank record" />
              </div>

              <div className="form-group">
                <label>Account Number</label>
                <input type="text" value={accountNo} onChange={(e) => setAccountNo(e.target.value)} placeholder="000000000000" />
              </div>

              <div className="form-group">
                <label>IFSC Code</label>
                <input type="text" value={ifsc} onChange={(e) => setIfsc(e.target.value)} placeholder="e.g. SBIN0001234" />
              </div>

              <div className="form-group">
                <label>UPI ID</label>
                <input type="text" value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@upi" />
              </div>

              <button className="submit-funds-btn" onClick={handleSaveAccount} disabled={submitting} style={{ marginTop: 'auto' }}>
                {submitting ? 'Saving...' : 'Save & Use Account'}
              </button>
            </div>
          )}

          {toast && (
            <div className="toast-notification fadeInUp" style={{ position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)', background: toast.type === 'success' ? '#006400' : '#c0392b', color: 'white', padding: '12px 24px', borderRadius: '50px', zIndex: 1000, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <i className={`fas ${toast.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}`}></i>
              {toast.message}
            </div>
          )}

          <div className="mobile-only" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50 }}>
          </div>
        </div>
      </main>
    </div>
  );
}
