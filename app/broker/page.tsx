'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { signOut } from '@/lib/auth';
import '../admin-layout.css';
import './page.css';
import { ConfirmDialog } from '@/components/admin/AdminUtils';
import UpdatePage from '@/components/admin/UpdatePage';
import TemplatesPage from '@/components/admin/TemplatesPage';
import PaymentAccountsPage from '@/components/admin/PayAccountsPage';
import UserPanel from '@/components/admin/UserPanel';

// --- Constants ---
const PAGE_SIZE = 20;

// --- Types ---
type NavPage = 'dashboard' | 'users' | 'position' | 'order' | 'actledger' | 'accounts' | 'payinout' | 'templates' | 'pay-accounts' | 'update';

type ToastState = { message: string; type: 'success' | 'error' | 'info' } | null;

interface UserProfile {
  id: string;
  email: string;
  role: string;
  full_name: string | null;
  balance?: number;
  phone?: string;
}

interface UserListItem extends UserProfile {
  active: boolean;
  ledgerBal: number;
  mAvailable: number;
  openPnl: number;
  m2m: number;
  weeklyPnl: number;
  alltimePnl: number;
  marginUsed: number;
  holdingMargin: number;
  balance: number;
  brokerage: number;
  totalPositions: number;
  openPositions: number;
  totalOrders: number;
  read_only: boolean;
  demo_user: boolean;
  segments: string[];
  created_at: string;
  settlement_amount?: number;
}



const navItems: { id: NavPage; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'fas fa-th-large' },
  { id: 'users', label: 'Users', icon: 'fas fa-users' },
  { id: 'position', label: 'Positions', icon: 'fas fa-chart-pie' },
  { id: 'order', label: 'Orders', icon: 'fas fa-list-ul' },
  { id: 'actledger', label: 'Activity Logs', icon: 'fas fa-history' },
  { id: 'accounts', label: 'P&L Accounts', icon: 'fas fa-wallet' },
  { id: 'payinout', label: 'Pay In / Out', icon: 'fas fa-exchange-alt' },
  { id: 'templates', label: 'Templates', icon: 'fas fa-shield-alt' },
  { id: 'pay-accounts', label: 'Bank Details', icon: 'fas fa-university' },
];

// --- Shared Components ---

const Toast = ({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) => {
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(onDismiss, 3000);
      return () => clearTimeout(timer);
    }
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className={`adm-toast ${toast.type}`}>
      <div className="adm-toast-content">
        <i className={`fas ${toast.type === 'success' ? 'fa-check-circle' : toast.type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle'}`} />
        <span>{toast.message}</span>
      </div>
      <button className="adm-toast-close" onClick={onDismiss}>✕</button>
    </div>
  );
};

const SkeletonLine = ({ width = '100%', height = 12, style = {} }: { width?: string | number; height?: string | number; style?: React.CSSProperties }) => (
  <div className="adm-skeleton" style={{ width, height, ...style }} />
);

// --- Main Page Component ---

export default function BrokerPage() {
  const router = useRouter();
  const [broker, setBroker] = useState<UserProfile | null>(null);
  const [activePage, setActivePage] = useState<NavPage>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ id: string; role: string } | null>(null);
  const [selectedUserTab, setSelectedUserTab] = useState<'profile' | 'segments' | 'ledger'>('profile');
  const [userPanelOpen, setUserPanelOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const apiCall = useCallback(async (url: string, options: RequestInit = {}) => {
    // Use cached session token directly to avoid Supabase lock contention
    const session = supabase.auth.getSession ? (await supabase.auth.getSession()).data.session : null;
    const token = session?.access_token;
    if (!token) {
      router.replace('/login');
      return { ok: false, status: 401, data: null };
    }
    try {
      const headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      const res = await fetch(url, { ...options, headers });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }, [router]);

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      
      const { ok, data } = await apiCall('/api/broker/users/me');
      if (ok) {
        if (!['broker', 'admin', 'super_admin'].includes(data.role)) {
          router.replace('/');
          return;
        }
        setBroker(data as UserProfile);
      } else {
        router.replace('/login');
      }
      setAuthLoading(false);
    };
    checkAuth();
  }, [apiCall, router]);

  const handleLogout = async () => {
    await signOut();
    router.replace('/login');
  };

  if (authLoading) {
    return (
      <div className="adm-root" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="adm-loader" />
      </div>
    );
  }

  return (
    <div className="adm-root adm-dark">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      
      {/* Drawer (Sidebar) */}
      {sidebarOpen && <div className="adm-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`adm-drawer ${sidebarOpen ? 'open' : ''}`}>
        <button className="adm-drawer-close" onClick={() => setSidebarOpen(false)}>✕</button>
        <div className="adm-drawer-brand">
          BROKER<span style={{ color: '#2ea043' }}>PANEL</span>
        </div>
        <nav className="adm-nav">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`adm-nav-item ${activePage === item.id ? 'active' : ''}`}
              onClick={() => { setActivePage(item.id); setSidebarOpen(false); }}
            >
              <i className={`${item.icon} adm-nav-icon`} style={{ width: '20px', display: 'inline-block', textAlign: 'center', marginRight: '10px' }} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div style={{ padding: '16px', borderTop: '1px solid #21262d', marginTop: 'auto' }}>
          <div style={{ fontSize: '0.82rem', color: '#8b949e', fontWeight: 500, marginBottom: '10px', wordBreak: 'break-all' }}>
            {broker?.full_name || broker?.email}
          </div>
          <button className="adm-btn-ghost" onClick={handleLogout} style={{ width: '100%', display: 'flex', justifyContent: 'center', gap: '8px' }}>
            <i className="fas fa-sign-out-alt" /> Logout
          </button>
        </div>
      </aside>

      <UserPanel
        open={userPanelOpen}
        onClose={() => setUserPanelOpen(false)}
        onCreateUser={() => { setUserPanelOpen(false); alert('Use dashboard or invite link to create users'); }}
        selectedUser={selectedUser}
        onSelectUser={(u) => { setSelectedUser({ id: u.id, role: u.role }); setUserPanelOpen(false); }}
        isBroker={true}
      />

      {/* Content Area */}
      <main className="adm-main-area">
        {/* Top Bar */}
        <header className="adm-topbar">
          <button className="adm-hamburger" onClick={() => setSidebarOpen(true)}>
            <span /><span /><span />
          </button>
          <div style={{ fontWeight: 800, fontSize: '1.2rem', color: '#e6edf3' }}>
            BROKER<span style={{ color: '#006400' }}>PANEL</span>
          </div>
          <button className="adm-hamburger-right" onClick={() => setUserPanelOpen(true)}>
            <span /><span /><span />
          </button>
        </header>

        <div className="adm-content">
          <div className="adm-page-header">
            <h1 className="adm-page-title">{navItems.find(n => n.id === activePage)?.label}</h1>
            <div className="adm-breadcrumb">
              <span>Broker</span>
              <i className="fas fa-chevron-right" />
              <span>{navItems.find(n => n.id === activePage)?.label}</span>
            </div>
          </div>

          <PageContent 
            page={activePage} 
            broker={broker} 
            apiCall={apiCall} 
            setToast={setToast}
            setSelectedUser={setSelectedUser}
            selectedUser={selectedUser}
            selectedUserTab={selectedUserTab}
            setSelectedUserTab={setSelectedUserTab}
            onNavigate={setActivePage}
          />
        </div>
      </main>
    </div>
  );
}

// --- Page Switcher ---

function PageContent({ page, broker, apiCall, setToast, setSelectedUser, selectedUser, selectedUserTab, setSelectedUserTab, onNavigate }: any) {
  switch (page) {
    case 'dashboard': return <BrokerDashboard broker={broker} apiCall={apiCall} onNavigate={onNavigate} onSelectUser={setSelectedUser} />;
    case 'users': return <BrokerUsers apiCall={apiCall} onSelectUser={setSelectedUser} onNavigate={onNavigate} setSelectedUserTab={setSelectedUserTab} setToast={setToast} />;
    case 'position': return <BrokerPositions apiCall={apiCall} selectedUser={selectedUser} />;
    case 'order': return <BrokerOrders apiCall={apiCall} selectedUser={selectedUser} />;
    case 'actledger': return <BrokerActLogs apiCall={apiCall} />;
    case 'accounts': return <BrokerAccounts apiCall={apiCall} />;
    case 'payinout': return <BrokerPayInOut apiCall={apiCall} />;
    case 'templates': return <TemplatesPage isBroker={true} />;
    case 'pay-accounts': return <PaymentAccountsPage isBroker={true} />;
    case 'update': return <UpdatePage selectedUser={selectedUser} isBroker={true} initialTab={selectedUserTab} />;
    default: return (
      <div className="adm-card" style={{ padding: 40, textAlign: 'center' }}>
        <i className="fas fa-tools" style={{ fontSize: '3rem', color: '#30363d', marginBottom: 20 }} />
        <h2 style={{ color: '#e6edf3' }}>Section Under Construction</h2>
        <p style={{ color: '#8b949e' }}>This module is currently being optimized for the Broker Panel.</p>
      </div>
    );
  }
}

// --- Sub-Pages ---

function BrokerDashboard({ broker, apiCall, onNavigate, onSelectUser }: any) {
  const [stats, setStats] = useState({ totalUsers: 0, activeUsers: 0, todayPnl: 0 });
  const [loading, setLoading] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const refCode = broker?.client_id || broker?.referral_code || broker?.id || '';
  const referralLink = refCode ? `${typeof window !== 'undefined' ? window.location.origin : ''}/register?ref=${refCode}` : '';

  const handleCopyLink = () => {
    if (!referralLink) return;
    navigator.clipboard.writeText(referralLink);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  useEffect(() => {
    const fetchData = async () => {
      const { ok, data } = await apiCall('/api/broker/users');
      if (ok && Array.isArray(data)) {
        const users = data as UserListItem[];
        setStats({
          totalUsers: users.length,
          activeUsers: users.filter(u => u.active).length,
          todayPnl: users.reduce((acc, u) => acc + (u.openPnl || 0), 0),
        });
      } else {
        setStats({ totalUsers: 0, activeUsers: 0, todayPnl: 0 });
      }
      setLoading(false);
    };
    fetchData();
  }, [apiCall]);

  return (
    <div className="adm-db-root">
      <div className="adm-db-section">
        <div className="adm-db-section-header">
          <span className="adm-db-section-title">BROKER SUMMARY</span>
        </div>
        <div className="adm-db-grid">
          <div className="adm-db-cell">
            <div className="adm-db-cell-label">TOTAL USERS</div>
            <div className="adm-db-cell-value">{loading ? '...' : stats.totalUsers}</div>
          </div>
          <div className="adm-db-cell">
            <div className="adm-db-cell-label">ACTIVE USERS</div>
            <div className="adm-db-cell-value">{loading ? '...' : stats.activeUsers}</div>
          </div>
          <div className="adm-db-cell">
            <div className="adm-db-cell-label">TOTAL OPEN P&L</div>
            <div className={`adm-db-cell-value ${stats.todayPnl >= 0 ? 'pos' : 'neg'}`}>
              ₹{loading ? '...' : stats.todayPnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
          </div>
        </div>
      </div>

      {broker?.id && (
        <div className="adm-db-section" style={{ marginTop: 24 }}>
          <div className="adm-db-section-header">
            <span className="adm-db-section-title">YOUR REFERRAL LINK</span>
          </div>
          <div style={{ padding: '16px', background: '#161b22', borderRadius: '10px', border: '1px solid #30363d' }}>
            <p style={{ color: '#8b949e', fontSize: '0.85rem', marginBottom: '12px' }}>
              Share this link with users. When they register, they will be automatically assigned to you.
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                readOnly
                value={referralLink}
                className="adm-input"
                style={{ flex: 1, minWidth: 0, backgroundColor: '#0d1117', color: '#c9d1d9', cursor: 'text' }}
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button className="adm-btn-primary" onClick={handleCopyLink} style={{ whiteSpace: 'nowrap', minWidth: '90px' }}>
                {copyFeedback ? <><i className="fas fa-check" style={{ marginRight: 6 }} />Copied</> : <><i className="fas fa-copy" style={{ marginRight: 6 }} />Copy</>}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button
          className="adm-btn-primary"
          style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10 }}
          onClick={() => onNavigate('users')}
        >
          <i className="fas fa-users" style={{ marginRight: 8 }} />View All Users
        </button>
        <button
          className="adm-btn-ghost"
          style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10 }}
          onClick={() => onNavigate('position')}
        >
          <i className="fas fa-chart-pie" style={{ marginRight: 8 }} />View Positions
        </button>
      </div>
    </div>
  );
}

function BrokerUsers({ apiCall, onSelectUser, onNavigate, setSelectedUserTab, setToast }: any) {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ userId: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deletedUsers, setDeletedUsers] = useState<Record<string, string>>({});

  useEffect(() => {
    apiCall('/api/broker/users').then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) {
        setUsers(data);
      } else {
        setUsers([]);
      }
      setLoading(false);
    });
  }, [apiCall]);

  const handleDelete = () => {
    if (!confirmDialog) return;
    setDeleteLoading(true);
    apiCall(`/api/admin/users/${confirmDialog.userId}`, { method: 'DELETE' })
      .then(({ ok, status, data }: any) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        const { scheduled_delete_at } = data as { scheduled_delete_at: string };
        setDeletedUsers(prev => ({ ...prev, [confirmDialog.userId]: scheduled_delete_at }));
        setToast({ message: 'User scheduled for deletion', type: 'success' });
        setConfirmDialog(null);
      })
      .catch((err: any) => {
        setToast({ message: err?.message || 'Network error', type: 'error' });
      })
      .finally(() => setDeleteLoading(false));
  };

  const filtered = users.filter(u =>
    u.id.toLowerCase().includes(search.toLowerCase()) ||
    (u.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(search.toLowerCase())
  );

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="adm-page">
      {confirmDialog && (
        <ConfirmDialog
          message={`Delete user ${confirmDialog.userId}? This will schedule deletion after 30 days.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDialog(null)}
          loading={deleteLoading}
        />
      )}

      {/* ── Search ── */}
      <div style={{ position: 'relative', width: '100%' }}>
        <i className="fas fa-search" style={{
          position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
          color: '#8b949e', fontSize: '0.85rem', pointerEvents: 'none'
        }} />
        <input
          className="adm-input"
          style={{ paddingLeft: 38, width: '100%', boxSizing: 'border-box' }}
          placeholder="Search by ID or Name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* ── List ── */}
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <SkeletonLine key={i} height={190} style={{ borderRadius: 10 }} />
          ))
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 0' }}>
            <i className="fas fa-users" style={{ fontSize: '2.4rem', color: '#21262d', marginBottom: 14, display: 'block' }} />
            <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>No users found.</div>
          </div>
        ) : (
          filtered.map((u: any) => (
            <div key={u.id} className="adm-ord-card" style={{ padding: 16 }}>

              {/* ── Top row: name + status ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#e6edf3' }}>
                      {u.full_name || 'No Name'}
                    </span>
                    <span style={{
                      fontSize: '0.68rem', fontWeight: 600,
                      padding: '2px 7px', borderRadius: 4,
                      background: '#21262d', color: '#8b949e', border: '1px solid #30363d'
                    }}>{u.role}</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: 3 }}>{u.email}</div>
                  {u.phone && (
                    <div style={{ fontSize: '0.72rem', color: '#484f58', marginTop: 2 }}>
                      <i className="fas fa-phone" style={{ marginRight: 4 }} />{u.phone}
                    </div>
                  )}
                  <div style={{ fontSize: '0.68rem', color: '#484f58', marginTop: 3, fontFamily: 'monospace' }}>
                    ID: {u.id}
                  </div>
                </div>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: '0.72rem', fontWeight: 700,
                  padding: '4px 10px', borderRadius: 20, flexShrink: 0,
                  background: u.active ? '#2ea0431a' : '#f851491a',
                  color: u.active ? '#2ea043' : '#f85149',
                  border: `1px solid ${u.active ? '#2ea04340' : '#f8514940'}`
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: u.active ? '#2ea043' : '#f85149',
                    boxShadow: u.active ? '0 0 5px #2ea043' : 'none'
                  }} />
                  {u.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              {/* ── Stats grid ── */}
              <div className="adm-db-grid" style={{ gap: 8, marginBottom: 14 }}>
                <div className="adm-db-cell">
                  <div className="adm-db-cell-label">Balance</div>
                  <div className="adm-db-cell-value" style={{ fontSize: '0.88rem' }}>₹{fmt(u.balance || 0)}</div>
                </div>
                {u.settlement_amount !== undefined && u.settlement_amount !== 0 && (
                  <div className="adm-db-cell" style={{ borderLeft: '2px solid #f85149' }}>
                    <div className="adm-db-cell-label" style={{ color: '#f85149' }}>Settlement Deficit</div>
                    <div className="adm-db-cell-value bold" style={{ fontSize: '0.88rem', color: '#f85149' }}>₹{fmt(u.settlement_amount)}</div>
                  </div>
                )}
                <div className="adm-db-cell">
                  <div className="adm-db-cell-label">M2M</div>
                  <div className={`adm-db-cell-value ${(u.m2m || 0) >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: '0.88rem' }}>
                    ₹{fmt(u.m2m || 0)}
                  </div>
                </div>
                <div className="adm-db-cell">
                  <div className="adm-db-cell-label">Open P&L</div>
                  <div className={`adm-db-cell-value ${(u.openPnl || 0) >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: '0.88rem' }}>
                    ₹{fmt(u.openPnl || 0)}
                  </div>
                </div>
                <div className="adm-db-cell">
                  <div className="adm-db-cell-label">Weekly P&L</div>
                  <div className={`adm-db-cell-value ${(u.weeklyPnl || 0) >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: '0.88rem' }}>
                    ₹{fmt(u.weeklyPnl || 0)}
                  </div>
                </div>
              </div>

              {/* ── Buttons ── */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  className="adm-btn-primary"
                  style={{ flex: 1, fontSize: '0.78rem', padding: '6px 12px', minWidth: '80px' }}
                  onClick={() => { onSelectUser({ id: u.id, role: u.role }); onNavigate('position'); }}
                >
                  <i className="fas fa-chart-pie" style={{ marginRight: 6 }} />Positions
                </button>
                <button
                  className="adm-btn-ghost"
                  style={{ flex: 1, fontSize: '0.78rem', padding: '6px 12px', minWidth: '80px' }}
                  onClick={() => { onSelectUser({ id: u.id, role: u.role }); onNavigate('order'); }}
                >
                  <i className="fas fa-list-ul" style={{ marginRight: 6 }} />Orders
                </button>
                <button
                  className="adm-btn-ghost"
                  style={{ flex: 1, fontSize: '0.78rem', padding: '6px 12px', minWidth: '80px', borderColor: '#2f74e5', color: '#58a6ff' }}
                  onClick={() => { onSelectUser({ id: u.id, role: u.role }); setSelectedUserTab('profile'); onNavigate('update'); }}
                >
                  <i className="fas fa-edit" style={{ marginRight: 6 }} />Update
                </button>
                <button
                  className="adm-btn-ghost"
                  style={{ flex: 1, fontSize: '0.78rem', padding: '6px 12px', minWidth: '80px', borderColor: '#f0883e', color: '#f0883e' }}
                  onClick={() => { onSelectUser({ id: u.id, role: u.role }); setSelectedUserTab('ledger'); onNavigate('update'); }}
                >
                  <i className="fas fa-wallet" style={{ marginRight: 6 }} />Ledger
                </button>
                <button
                  className="adm-btn-ghost"
                  style={{ flex: 1, fontSize: '0.78rem', padding: '6px 12px', minWidth: '80px', borderColor: '#f85149', color: '#f85149' }}
                  onClick={() => setConfirmDialog({ userId: u.id })}
                >
                  <i className="fas fa-trash-alt" style={{ marginRight: 6 }} />Delete
                </button>
              </div>

              {(deletedUsers[u.id] || u.scheduled_delete_at) && (
                <DeletionBanner scheduledDeleteAt={deletedUsers[u.id] || u.scheduled_delete_at!} />
              )}

            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DeletionBanner({ scheduledDeleteAt }: { scheduledDeleteAt: string }) {
  const dateStr = scheduledDeleteAt ? new Date(scheduledDeleteAt).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }) : 'N/A';
  return (
    <div style={{
      background: '#7c2d12',
      color: '#fca5a5',
      borderRadius: 6,
      padding: '8px 12px',
      fontSize: '0.8rem',
      marginTop: 10,
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    }}>
      <i className="fas fa-trash-alt" />
      <span>Scheduled for deletion on {dateStr}</span>
    </div>
  );
}

function BrokerPositions({ apiCall, selectedUser }: any) {
  const [positions, setPositions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [activeUid, setActiveUid] = useState<string>(selectedUser?.id || '');
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const searchRef = React.useRef<HTMLDivElement>(null);

  // Load users
  useEffect(() => {
    apiCall('/api/broker/users').then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) setUsers(data);
      else setUsers([]);
    });
  }, [apiCall]);

  // Sync selectedUser from parent (when coming from Users tab)
  useEffect(() => {
    if (selectedUser?.id) {
      setActiveUid(selectedUser.id);
      const u = users.find(x => x.id === selectedUser.id);
      if (u) setSearchQuery(u.full_name || u.id);
    }
  }, [selectedUser, users]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Load positions when activeUid changes
  useEffect(() => {
    if (!activeUid) return;
    setLoading(true);
    apiCall(`/api/admin/users/${activeUid}/positions?demo=false`).then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) {
        setPositions(data); setIsDemo(false);
      } else {
        setPositions([]); setIsDemo(false);
      }
      setLoading(false);
    });
  }, [activeUid, apiCall]);

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const filteredUsers = users.filter(u =>
    (u.full_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const openPos   = positions.filter(p => p.status === 'open');
  const closedPos = positions.filter(p => p.status !== 'open');
  const shown     = tab === 'open' ? openPos : closedPos;
  const totalPnl  = openPos.reduce((a, p) => a + Number(p.pnl ?? 0), 0);
  const activeUser = users.find(u => u.id === activeUid);

  const selectUser = (u: UserListItem) => {
    setActiveUid(u.id);
    setSearchQuery(u.full_name || u.id);
    setDropdownOpen(false);
    setTab('open');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Search dropdown ── */}
      <div ref={searchRef} style={{ position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <i className="fas fa-search" style={{
            position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
            color: '#8b949e', fontSize: '0.85rem', pointerEvents: 'none'
          }} />
          <input
            className="adm-input"
            style={{ paddingLeft: 38, paddingRight: 36, width: '100%', boxSizing: 'border-box' }}
            placeholder="Search user..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setDropdownOpen(true); }}
            onFocus={() => setDropdownOpen(true)}
          />
          {searchQuery && (
            <button onClick={() => { setSearchQuery(''); setActiveUid(''); setDropdownOpen(false); }}
              style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}>
              ✕
            </button>
          )}
        </div>

        {/* Dropdown list */}
        {dropdownOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 100,
            background: '#161b22', border: '1px solid #30363d', borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden',
          }}>
            {filteredUsers.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: '#8b949e', fontSize: '0.85rem' }}>No users found</div>
            ) : (
              filteredUsers.map(u => (
                <button
                  key={u.id}
                  onClick={() => selectUser(u)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '11px 14px', background: activeUid === u.id ? '#21262d' : 'transparent',
                    border: 'none', borderBottom: '1px solid #21262d', cursor: 'pointer',
                    textAlign: 'left', transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#21262d')}
                  onMouseLeave={e => (e.currentTarget.style.background = activeUid === u.id ? '#21262d' : 'transparent')}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#e6edf3' }}>{u.full_name || 'No Name'}</div>
                    <div style={{ fontSize: '0.72rem', color: '#8b949e', marginTop: 1 }}>{u.email}</div>
                  </div>
                  <span style={{
                    fontSize: '0.68rem', fontWeight: 700, padding: '3px 8px', borderRadius: 20, flexShrink: 0,
                    background: u.active ? '#2ea0431a' : '#f851491a',
                    color: u.active ? '#2ea043' : '#f85149',
                    border: `1px solid ${u.active ? '#2ea04340' : '#f8514940'}`,
                  }}>
                    {u.active ? '● Active' : '○ Inactive'}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── No user selected ── */}
      {!activeUid ? (
        <div className="adm-card" style={{ padding: 48, textAlign: 'center' }}>
          <i className="fas fa-user-circle" style={{ fontSize: '2.5rem', color: '#30363d', marginBottom: 12 }} />
          <div style={{ color: '#8b949e', fontSize: '0.88rem' }}>Search and select a user to view positions.</div>
        </div>
      ) : (
        <>
          {/* ── User info + P&L bar ── */}
          <div className="adm-ord-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: '0.92rem', color: '#e6edf3' }}>
                  {activeUser?.full_name || activeUid}
                </span>
                {isDemo && <span style={{ fontSize: '0.62rem', padding: '2px 6px', borderRadius: 4, background: '#b08d571a', color: '#b08d57', border: '1px solid #b08d5740', fontWeight: 600 }}>DEMO</span>}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#8b949e' }}>{activeUser?.email || ''}</div>
              <div style={{ fontSize: '0.7rem', color: '#6e7681', fontFamily: 'monospace', marginTop: 1 }}>{activeUid}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, color: totalPnl >= 0 ? '#2ea043' : '#f85149', lineHeight: 1 }}>
                {totalPnl >= 0 ? '+' : ''}₹{fmt(totalPnl)}
              </div>
              <div style={{ fontSize: '0.6rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Open P&L</div>
            </div>
          </div>

          {/* ── Open / Closed tabs ── */}
          <div style={{ display: 'flex', gap: 8 }}>
            {(['open', 'closed'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontWeight: 600, fontSize: '0.82rem',
                background: tab === t ? (t === 'open' ? '#2ea043' : '#388bfd') : '#161b22',
                color: tab === t ? '#fff' : '#8b949e', transition: 'all 0.15s',
              }}>
                {t === 'open' ? `Open (${openPos.length})` : `Closed (${closedPos.length})`}
              </button>
            ))}
          </div>

          {/* ── Position cards ── */}
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => <SkeletonLine key={i} height={110} style={{ borderRadius: 10 }} />)
          ) : shown.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <i className="fas fa-chart-pie" style={{ fontSize: '2.2rem', color: '#21262d', marginBottom: 12, display: 'block' }} />
              <div style={{ color: '#8b949e', fontSize: '0.88rem' }}>No {tab} positions.</div>
            </div>
          ) : (
            shown.map((p: any) => {
              const pnl = Number(p.pnl ?? 0);
              const ltp = Number(p.ltp ?? 0);
              const avg = Number(p.avg_price ?? 0);
              const chg = avg > 0 ? ((ltp - avg) / avg * 100) : 0;
              return (
                <div key={p.id} className="adm-ord-card" style={{ padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.92rem', color: '#e6edf3' }}>{p.symbol}</div>
                      <div style={{ fontSize: '0.7rem', marginTop: 3 }}>
                        <span style={{
                          padding: '1px 6px', borderRadius: 3, marginRight: 6,
                          background: p.side === 'BUY' ? '#2ea0431a' : '#f851491a',
                          color: p.side === 'BUY' ? '#2ea043' : '#f85149',
                          border: `1px solid ${p.side === 'BUY' ? '#2ea04340' : '#f8514940'}`,
                          fontWeight: 700, fontSize: '0.68rem'
                        }}>{p.side}</span>
                        {p.exchange && <span style={{ color: '#484f58' }}>{p.exchange}</span>}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '1rem', fontWeight: 700, color: pnl >= 0 ? '#2ea043' : '#f85149' }}>
                        {pnl >= 0 ? '+' : ''}₹{fmt(pnl)}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: chg >= 0 ? '#2ea043' : '#f85149', marginTop: 1 }}>
                        {chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {([['Qty', String(p.qty)], ['Avg', `₹${fmt(avg)}`], ['LTP', `₹${fmt(ltp)}`]] as [string, string][]).map(([label, val]) => (
                      <div key={label} style={{ flex: 1, background: '#0d1117', borderRadius: 6, padding: '7px 10px' }}>
                        <div style={{ fontSize: '0.62rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e6edf3', marginTop: 2 }}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}



function BrokerOrders({ apiCall, selectedUser }: any) {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'executed' | 'limit' | 'rejected'>('executed');
  const [activeUid, setActiveUid] = useState<string>(selectedUser?.id || '');
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const searchRef = React.useRef<HTMLDivElement>(null);

  // Load users
  useEffect(() => {
    apiCall('/api/broker/users').then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) setUsers(data);
      else setUsers(DEMO_USERS);
    });
  }, [apiCall]);

  // Sync selectedUser from parent
  useEffect(() => {
    if (selectedUser?.id) {
      setActiveUid(selectedUser.id);
      const u = users.find(x => x.id === selectedUser.id);
      if (u) setSearchQuery(u.full_name || u.id);
    }
  }, [selectedUser, users]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node))
        setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Load orders when uid or tab changes
  useEffect(() => {
    if (!activeUid) return;
    setLoading(true);
    apiCall(`/api/broker/orders?user_id=${activeUid}&tab=${tab}`).then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) {
        setOrders(data);
      } else {
        setOrders([]);
      }
      setLoading(false);
    });
  }, [apiCall, activeUid, tab]);

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const filteredUsers = users.filter(u =>
    (u.full_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeUser = users.find(u => u.id === activeUid);

  // Filter orders by tab
  const shownOrders = orders;

  const selectUser = (u: UserListItem) => {
    setActiveUid(u.id);
    setSearchQuery(u.full_name || u.id);
    setDropdownOpen(false);
    setTab('executed');
  };

  const fmtTime = (t: string) => {
    try {
      return new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch { return t; }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Search dropdown ── */}
      <div ref={searchRef} style={{ position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <i className="fas fa-search" style={{
            position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
            color: '#8b949e', fontSize: '0.85rem', pointerEvents: 'none'
          }} />
          <input
            className="adm-input"
            style={{ paddingLeft: 38, paddingRight: 36, width: '100%', boxSizing: 'border-box' }}
            placeholder="Search user..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setDropdownOpen(true); }}
            onFocus={() => setDropdownOpen(true)}
          />
          {searchQuery && (
            <button onClick={() => { setSearchQuery(''); setActiveUid(''); setDropdownOpen(false); }}
              style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}>
              ✕
            </button>
          )}
        </div>
        {dropdownOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 100,
            background: '#161b22', border: '1px solid #30363d', borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden',
          }}>
            {filteredUsers.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: '#8b949e', fontSize: '0.85rem' }}>No users found</div>
            ) : filteredUsers.map(u => (
              <button key={u.id} onClick={() => selectUser(u)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 14px', background: activeUid === u.id ? '#21262d' : 'transparent',
                  border: 'none', borderBottom: '1px solid #21262d', cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#21262d')}
                onMouseLeave={e => (e.currentTarget.style.background = activeUid === u.id ? '#21262d' : 'transparent')}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#e6edf3' }}>{u.full_name || 'No Name'}</div>
                  <div style={{ fontSize: '0.72rem', color: '#8b949e', marginTop: 1 }}>{u.email}</div>
                </div>
                <span style={{
                  fontSize: '0.68rem', fontWeight: 700, padding: '3px 8px', borderRadius: 20, flexShrink: 0,
                  background: u.active ? '#2ea0431a' : '#f851491a',
                  color: u.active ? '#2ea043' : '#f85149',
                  border: `1px solid ${u.active ? '#2ea04340' : '#f8514940'}`,
                }}>{u.active ? '● Active' : '○ Inactive'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── No user selected ── */}
      {!activeUid ? (
        <div className="adm-card" style={{ padding: 48, textAlign: 'center' }}>
          <i className="fas fa-list-ul" style={{ fontSize: '2.5rem', color: '#30363d', marginBottom: 12 }} />
          <div style={{ color: '#8b949e', fontSize: '0.88rem' }}>Search and select a user to view orders.</div>
        </div>
      ) : (
        <>
          {/* ── User info bar ── */}
          <div className="adm-ord-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: '0.92rem', color: '#e6edf3' }}>
                  {activeUser?.full_name || activeUid}
                </span>
                {isDemo && <span style={{ fontSize: '0.62rem', padding: '2px 6px', borderRadius: 4, background: '#b08d571a', color: '#b08d57', border: '1px solid #b08d5740', fontWeight: 600 }}>DEMO</span>}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#8b949e' }}>{activeUser?.email || ''}</div>
              <div style={{ fontSize: '0.7rem', color: '#6e7681', fontFamily: 'monospace', marginTop: 1 }}>{activeUid}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#e6edf3', lineHeight: 1 }}>
                {isDemo ? (DEMO_ORDERS[activeUid]?.length ?? 0) : orders.length}
              </div>
              <div style={{ fontSize: '0.6rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total Orders</div>
            </div>
          </div>

          {/* ── Tabs ── */}
          <div style={{ display: 'flex', gap: 8 }}>
            {(['executed', 'limit', 'rejected'] as const).map(t => {
              const count = isDemo ? (DEMO_ORDERS[activeUid] || []).filter(o => o.status === t).length : 0;
              const colors: Record<string, string> = { executed: '#2ea043', limit: '#388bfd', rejected: '#f85149' };
              return (
                <button key={t} onClick={() => setTab(t)} style={{
                  flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: '0.78rem',
                  background: tab === t ? colors[t] : '#161b22',
                  color: tab === t ? '#fff' : '#8b949e', transition: 'all 0.15s',
                }}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}{isDemo ? ` (${count})` : ''}
                </button>
              );
            })}
          </div>

          {/* ── Order cards ── */}
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => <SkeletonLine key={i} height={90} style={{ borderRadius: 10 }} />)
          ) : shownOrders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <i className="fas fa-list-ul" style={{ fontSize: '2.2rem', color: '#21262d', marginBottom: 12, display: 'block' }} />
              <div style={{ color: '#8b949e', fontSize: '0.88rem' }}>No {tab} orders.</div>
            </div>
          ) : (
            shownOrders.map((o: any) => {
              const sc = o.status === 'executed' ? '#2ea043' : o.status === 'limit' ? '#388bfd' : '#f85149';
              const isBuy = o.side === 'BUY';
              return (
                <div key={o.id} style={{
                  background: '#161b22',
                  border: '1px solid #21262d',
                  borderRadius: 12,
                  overflow: 'hidden',
                }}>
                  {/* Top accent line */}
                  <div style={{ height: 2, background: `linear-gradient(90deg, ${isBuy ? '#2ea043' : '#f85149'}, transparent)` }} />

                  <div style={{ padding: '12px 14px' }}>
                    {/* Row 1 */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#e6edf3', letterSpacing: '0.01em' }}>{o.symbol}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
                          <span style={{
                            fontSize: '0.65rem', fontWeight: 800, padding: '2px 8px', borderRadius: 4,
                            background: isBuy ? '#2ea043' : '#f85149', color: '#fff', letterSpacing: '0.06em',
                          }}>{o.side}</span>
                          {o.exchange && (
                            <span style={{ fontSize: '0.68rem', color: '#8b949e', background: '#0d1117', padding: '2px 7px', borderRadius: 4, border: '1px solid #30363d' }}>
                              {o.exchange}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 800, color: '#e6edf3' }}>₹{fmt(o.price)}</div>
                        <div style={{ fontSize: '0.65rem', color: '#484f58', marginTop: 3 }}>
                          <i className="fas fa-clock" style={{ marginRight: 3, fontSize: '0.6rem' }} />{fmtTime(o.time)}
                        </div>
                      </div>
                    </div>

                    {/* Row 2 — stats */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <div style={{ flex: 1, background: '#0d1117', borderRadius: 7, padding: '7px 10px' }}>
                        <div style={{ fontSize: '0.58rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Qty</div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#e6edf3', marginTop: 2 }}>{o.qty}</div>
                      </div>
                      <div style={{ flex: 1, background: '#0d1117', borderRadius: 7, padding: '7px 10px' }}>
                        <div style={{ fontSize: '0.58rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Value</div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#e6edf3', marginTop: 2 }}>₹{fmt(o.qty * o.price)}</div>
                      </div>
                      <div style={{ flex: 1, background: '#0d1117', borderRadius: 7, padding: '7px 10px' }}>
                        <div style={{ fontSize: '0.58rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</div>
                        <div style={{ marginTop: 3 }}>
                          <span style={{
                            fontSize: '0.7rem', fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                            background: sc + '20', color: sc, border: `1px solid ${sc}40`,
                          }}>
                            {o.status === 'executed' ? '✓ Done' : o.status === 'limit' ? 'Pending' : '✕ Rejected'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {o.reason && (
                      <div style={{ marginTop: 8, fontSize: '0.7rem', color: '#f85149', background: '#f8514910', padding: '5px 10px', borderRadius: 6, border: '1px solid #f8514925', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <i className="fas fa-exclamation-triangle" style={{ flexShrink: 0, fontSize: '0.65rem' }} />{o.reason}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}



function BrokerActLogs({ apiCall }: any) {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'orders' | 'rejected' | 'logins'>('all');
  const [users, setUsers] = useState<UserListItem[]>([]);

  useEffect(() => {
    apiCall('/api/broker/users').then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) setUsers(data);
      else setUsers(DEMO_USERS);
    });
  }, [apiCall]);

  useEffect(() => {
    apiCall('/api/broker/actlogs').then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) {
        setLogs(data);
      } else {
        setLogs([]);
      }
      setLoading(false);
    });
  }, [apiCall]);

  const getUserName = (uid: string) => {
    const u = users.find(x => x.id === uid);
    return u?.full_name || uid;
  };

  const fmtTime = (t: string) => {
    try {
      return new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch { return t; }
  };

  const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const typeConfig: Record<string, { icon: string; color: string; label: string }> = {
    ORDER_PLACED:    { icon: 'fa-plus-circle',  color: '#388bfd', label: 'Order Placed'    },
    ORDER_REJECTED:  { icon: 'fa-times-circle', color: '#f85149', label: 'Order Rejected'  },
    POSITION_CLOSED: { icon: 'fa-check-circle', color: '#2ea043', label: 'Position Closed' },
    LOGIN:           { icon: 'fa-sign-in-alt',  color: '#8b949e', label: 'Login'           },
    LOGOUT:          { icon: 'fa-sign-out-alt', color: '#8b949e', label: 'Logout'          },
    BALANCE_CREDIT:  { icon: 'fa-wallet',       color: '#f0883e', label: 'Balance Credit'  },
    BALANCE_DEBIT:   { icon: 'fa-wallet',       color: '#f85149', label: 'Balance Debit'   },
    SQ_OFF:          { icon: 'fa-bolt',         color: '#f0883e', label: 'Square Off'      },
  };

  const filterFn = (l: any) => {
    if (activeFilter === 'orders')   return l.type?.startsWith('ORDER') && l.type !== 'ORDER_REJECTED';
    if (activeFilter === 'rejected') return l.type === 'ORDER_REJECTED';
    if (activeFilter === 'logins')   return l.type === 'LOGIN' || l.type === 'LOGOUT';
    return true;
  };

  const filtered = logs.filter(l => {
    if (!filterFn(l)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (l.type || '').toLowerCase().includes(q) ||
      (l.symbol || '').toLowerCase().includes(q) ||
      getUserName(l.target).toLowerCase().includes(q)
    );
  });

  const chips = [
    { key: 'all',      label: 'Total',    count: logs.length,                                              color: '#8b949e' },
    { key: 'orders',   label: 'Orders',   count: logs.filter(l => l.type?.startsWith('ORDER') && l.type !== 'ORDER_REJECTED').length, color: '#388bfd' },
    { key: 'rejected', label: 'Rejected', count: logs.filter(l => l.type === 'ORDER_REJECTED').length,     color: '#f85149' },
    { key: 'logins',   label: 'Logins',   count: logs.filter(l => l.type === 'LOGIN' || l.type === 'LOGOUT').length, color: '#2ea043' },
  ] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Search ── */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <i className="fas fa-search" style={{
          position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
          color: '#8b949e', fontSize: '0.85rem', pointerEvents: 'none',
        }} />
        <input
          className="adm-input"
          style={{ paddingLeft: 38, paddingRight: search ? 36 : 14, width: '100%', boxSizing: 'border-box' }}
          placeholder="Search by type, symbol or user..."
          value={search}
          onChange={e => { setSearch(e.target.value); setActiveFilter('all'); }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}>✕</button>
        )}
      </div>

      {/* ── Filter chips ── */}
      {!loading && (
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {chips.map(s => {
            const active = activeFilter === s.key;
            return (
              <button
                key={s.key}
                onClick={() => { setActiveFilter(s.key); setSearch(''); }}
                style={{
                  flex: 1, background: active ? s.color + '20' : '#161b22',
                  border: `1px solid ${active ? s.color + '60' : '#21262d'}`,
                  borderRadius: 8, padding: '8px 6px', textAlign: 'center',
                  cursor: 'pointer', transition: 'all 0.15s',
                  boxShadow: active ? `0 0 0 1px ${s.color}30` : 'none',
                }}
              >
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: active ? s.color : '#e6edf3', lineHeight: 1 }}>{s.count}</div>
                <div style={{ fontSize: '0.58rem', color: active ? s.color : '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 3 }}>{s.label}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Log list — scrollable ── */}
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: 6 }).map((_, i) => <SkeletonLine key={i} height={62} style={{ borderRadius: 8 }} />)}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <i className="fas fa-history" style={{ fontSize: '2rem', color: '#21262d', marginBottom: 12, display: 'block' }} />
            <div style={{ color: '#8b949e', fontSize: '0.88rem' }}>No activity logs found.</div>
          </div>
        ) : (
          <>
            <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 10, overflow: 'hidden' }}>
              {filtered.map((l: any, idx: number) => {
                const cfg = typeConfig[l.type] ?? { icon: 'fa-circle', color: '#8b949e', label: l.type };
                return (
                  <div key={l.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                    borderBottom: idx < filtered.length - 1 ? '1px solid #21262d' : 'none',
                  }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                      background: cfg.color + '18', border: `1px solid ${cfg.color}30`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <i className={`fas ${cfg.icon}`} style={{ fontSize: '0.75rem', color: cfg.color }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#e6edf3' }}>{cfg.label}</span>
                        {l.symbol && (
                          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#388bfd', background: '#388bfd12', padding: '1px 6px', borderRadius: 4, border: '1px solid #388bfd25' }}>
                            {l.symbol}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: '#8b949e', marginTop: 2 }}>
                        {getUserName(l.target)}
                        {l.qty  && <span style={{ marginLeft: 6 }}>· Qty {l.qty}</span>}
                        {l.price && <span style={{ marginLeft: 6 }}>· ₹{fmt(l.price)}</span>}
                        {l.reason && <span style={{ marginLeft: 6, color: '#f85149' }}>· {l.reason}</span>}
                      </div>
                    </div>
                    <div style={{ fontSize: '0.65rem', color: '#484f58', flexShrink: 0, textAlign: 'right' }}>
                      {fmtTime(l.time)}
                    </div>
                  </div>
                );
              })}
            </div>

          </>
        )}
      </div>
    </div>
  );
}



function BrokerAccounts({ apiCall }: any) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    apiCall('/api/broker/accounts').then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) {
        setAccounts(data);
      } else {
        setAccounts([]);
      }
      setLoading(false);
    });
  }, [apiCall]);

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const filtered = accounts.filter(a =>
    (a.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (a.email || '').toLowerCase().includes(search.toLowerCase())
  );

  // Summary totals
  const totalNetPnl   = accounts.reduce((s, a) => s + (a.net_pnl   ?? 0), 0);
  const totalBrokerage = accounts.reduce((s, a) => s + (a.brokerage ?? 0), 0);
  const totalSettlement = accounts.reduce((s, a) => s + (a.settlement ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Summary strip ── */}
      {!loading && (
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: 'Net P&L',    value: totalNetPnl,    color: totalNetPnl >= 0 ? '#2ea043' : '#f85149' },
            { label: 'Brokerage',  value: totalBrokerage, color: '#f0883e' },
            { label: 'Settlement', value: totalSettlement, color: '#388bfd' },
          ].map(s => (
            <div key={s.label} style={{ flex: 1, background: '#161b22', border: '1px solid #21262d', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: '0.88rem', fontWeight: 800, color: s.color, lineHeight: 1 }}>
                {s.value >= 0 ? '+' : '-'}₹{fmt(Math.abs(s.value))}
              </div>
              <div style={{ fontSize: '0.58rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Search ── */}
      <div style={{ position: 'relative' }}>
        <i className="fas fa-search" style={{
          position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
          color: '#8b949e', fontSize: '0.85rem', pointerEvents: 'none',
        }} />
        <input
          className="adm-input"
          style={{ paddingLeft: 38, paddingRight: search ? 36 : 14, width: '100%', boxSizing: 'border-box' }}
          placeholder="Search by name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}>✕</button>
        )}
      </div>

      {/* ── Account cards ── */}
      {loading ? (
        Array.from({ length: 3 }).map((_, i) => <SkeletonLine key={i} height={130} style={{ borderRadius: 10 }} />)
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <i className="fas fa-wallet" style={{ fontSize: '2rem', color: '#21262d', marginBottom: 12, display: 'block' }} />
          <div style={{ color: '#8b949e', fontSize: '0.88rem' }}>No accounts found.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((a: any) => {
            const isProfit = (a.net_pnl ?? 0) >= 0;
            return (
              <div key={a.id} style={{
                background: '#161b22',
                border: '1px solid #21262d',
                borderRadius: 12,
                overflow: 'hidden',
              }}>
                {/* Top accent */}
                <div style={{ height: 2, background: `linear-gradient(90deg, ${isProfit ? '#2ea043' : '#f85149'}, transparent)` }} />

                <div style={{ padding: '13px 14px' }}>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.92rem', color: '#e6edf3' }}>{a.full_name || 'No Name'}</div>
                      <div style={{ fontSize: '0.72rem', color: '#8b949e', marginTop: 2 }}>{a.email || ''}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.6rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Net P&L</div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 800, color: isProfit ? '#2ea043' : '#f85149', marginTop: 1 }}>
                        {isProfit ? '+' : ''}₹{fmt(a.net_pnl ?? 0)}
                      </div>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <div style={{ flex: 1, background: '#0d1117', borderRadius: 7, padding: '7px 10px' }}>
                      <div style={{ fontSize: '0.58rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Brokerage</div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f0883e', marginTop: 2 }}>₹{fmt(a.brokerage ?? 0)}</div>
                    </div>
                    <div style={{ flex: 1, background: '#0d1117', borderRadius: 7, padding: '7px 10px' }}>
                      <div style={{ fontSize: '0.58rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>P&L + Bkg</div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#e6edf3', marginTop: 2 }}>₹{fmt(a.pnl_bkg ?? 0)}</div>
                    </div>
                    <div style={{ flex: 1, background: '#0d1117', borderRadius: 7, padding: '7px 10px' }}>
                      <div style={{ fontSize: '0.58rem', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Settlement</div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#388bfd', marginTop: 2 }}>₹{fmt(a.settlement ?? 0)}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}


    </div>
  );
}



function BrokerPayInOut({ apiCall }: any) {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'ALL' | 'DEPOSIT' | 'WITHDRAWAL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');

  useEffect(() => {
    apiCall('/api/broker/payinout').then(({ ok, data }: any) => {
      if (ok && Array.isArray(data) && data.length > 0) {
        setRequests(data);
      } else {
        setRequests([]);
      }
      setLoading(false);
    });
  }, [apiCall]);

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (t: string) => {
    try { return new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }
    catch { return t; }
  };

  const filtered = requests.filter(r => {
    if (tab !== 'ALL' && r.type !== tab) return false;
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
    return true;
  });

  const totalDeposit    = requests.filter(r => r.type === 'DEPOSIT'    && r.status === 'APPROVED').reduce((s, r) => s + r.amount, 0);
  const totalWithdrawal = requests.filter(r => r.type === 'WITHDRAWAL' && r.status === 'APPROVED').reduce((s, r) => s + r.amount, 0);
  const totalPending    = requests.filter(r => r.status === 'PENDING').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Summary strip ── */}
      {!loading && (
        <div style={{ display: 'flex', background: '#161b22', border: '1px solid #21262d', borderRadius: 10, overflow: 'hidden' }}>
          {[
            { label: 'Deposited', value: `+₹${fmt(totalDeposit)}`,   color: '#3fb950' },
            { label: 'Withdrawn', value: `-₹${fmt(totalWithdrawal)}`, color: '#f85149' },
            { label: 'Pending',   value: String(totalPending),         color: totalPending > 0 ? '#d29922' : '#6e7681' },
          ].map((s, i, arr) => (
            <div key={s.label} style={{
              flex: 1, padding: '10px 6px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              borderRight: i < arr.length - 1 ? '1px solid #21262d' : 'none',
              minWidth: 0,
            }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: s.color, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', textAlign: 'center' }}>{s.value}</div>
              <div style={{ fontSize: '0.6rem', color: '#6e7681', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Type tabs ── */}
      <div style={{ display: 'flex', gap: 6 }}>
        {(['ALL', 'DEPOSIT', 'WITHDRAWAL'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '9px 0', borderRadius: 8,
            border: `1px solid ${tab === t ? '#30363d' : '#21262d'}`,
            background: tab === t ? '#21262d' : 'transparent',
            color: tab === t ? '#e6edf3' : '#6e7681',
            fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
            {t === 'ALL' ? 'All' : t === 'DEPOSIT' ? '↓ Pay In' : '↑ Pay Out'}
          </button>
        ))}
      </div>

      {/* ── Status tabs ── */}
      <div style={{ display: 'flex', gap: 6 }}>
        {(['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as const).map(s => {
          const active = statusFilter === s;
          const color = s === 'APPROVED' ? '#3fb950' : s === 'REJECTED' ? '#f85149' : s === 'PENDING' ? '#d29922' : '#6e7681';
          return (
            <button key={s} onClick={() => setStatusFilter(s)} style={{
              flex: 1, padding: '8px 0', borderRadius: 8,
              border: `1px solid ${active ? '#30363d' : '#21262d'}`,
              background: active ? '#21262d' : 'transparent',
              color: active ? color : '#6e7681',
              fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          );
        })}
      </div>

      {/* ── Request list ── */}
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: 4 }).map((_, i) => <SkeletonLine key={i} height={72} style={{ borderRadius: 10 }} />)}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <i className="fas fa-exchange-alt" style={{ fontSize: '2rem', color: '#21262d', marginBottom: 12, display: 'block' }} />
            <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>No requests found.</div>
          </div>
        ) : (
          <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 12, overflow: 'hidden' }}>
            {filtered.map((r: any, idx: number) => {
              const isDeposit = r.type === 'DEPOSIT';
              const amtColor = isDeposit ? '#3fb950' : '#f85149';
              const statusColor = r.status === 'APPROVED' ? '#3fb950' : r.status === 'REJECTED' ? '#f85149' : '#d29922';
              const statusLabel = r.status === 'APPROVED' ? 'Approved' : r.status === 'REJECTED' ? 'Rejected' : 'Pending';
              return (
                <div key={r.id} style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '16px 16px',
                  borderBottom: idx < filtered.length - 1 ? '1px solid #21262d' : 'none',
                }}>
                  {/* Icon */}
                  <div style={{
                    width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                    background: '#21262d',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1rem', color: isDeposit ? '#3fb950' : '#f85149',
                  }}>
                    {isDeposit ? '↓' : '↑'}
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#e6edf3' }}>{r.full_name || 'Unknown'}</div>
                    <div style={{ fontSize: '0.72rem', color: '#6e7681', marginTop: 3 }}>
                      {r.upi ? r.upi : r.account_no ? `${r.account_no} · ${r.ifsc}` : '—'}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#484f58', marginTop: 1 }}>{fmtDate(r.created_at)}</div>
                  </div>

                  {/* Amount + status */}
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: '0.98rem', fontWeight: 700, color: amtColor }}>
                      {isDeposit ? '+' : '-'}₹{fmt(r.amount)}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: statusColor, marginTop: 3, fontWeight: 500 }}>
                      {statusLabel}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}


      </div>
    </div>
  );
}
