'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth';
import AnimatedLoader from '@/components/AnimatedLoader';
import { apiCall, Toast, ToastState, SkeletonLine, UserListItem, ConfirmDialog, downloadCSV } from './AdminUtils';

type UserRow = {
  id: string; client_id?: string; fullName: string; role: string; active: boolean;
  ledgerBal: number; mAvailable: number; openPnl: number; m2m: number;
  weeklyPnl: number; alltimePnl: number; marginUsed: number; holdingMargin: number;
  broker: string; mobile: string; scheduled_delete_at: string | null;
  segments: string[]; read_only: boolean; demo_user: boolean;
  intraday_sq_off: boolean; auto_sqoff: number; showcase_auto_sqoff: number; sqoff_method: string;
  settlementAmount: number;
};

function mapUserListItem(u: UserListItem): UserRow {
  return {
    id: u.id,
    client_id: u.client_id,
    fullName: u.full_name ?? u.email,
    role: u.role.toUpperCase(),
    active: u.active,
    ledgerBal: u.balance,
    mAvailable: (u.balance + (u.openPnl ?? 0)) - (u.marginUsed ?? 0),
    openPnl: u.openPnl ?? 0,
    m2m: u.m2m ?? 0,
    weeklyPnl: u.weeklyPnl ?? 0,
    alltimePnl: 0, // Not currently computed in the list
    marginUsed: u.marginUsed ?? 0,
    holdingMargin: 0,
    broker: u.parent_id ?? 'DIRECT',
    mobile: u.phone ?? 'N/A',
    scheduled_delete_at: u.scheduled_delete_at,
    segments: u.segments ?? [],
    read_only: u.read_only,
    demo_user: u.demo_user,
    intraday_sq_off: u.intraday_sq_off,
    auto_sqoff: u.auto_sqoff,
    showcase_auto_sqoff: (u as any).showcase_auto_sqoff ?? 85,
    sqoff_method: u.sqoff_method,
    settlementAmount: u.settlement_amount ?? 0,
  };
}

function DeletionBanner({ scheduledDeleteAt }: { scheduledDeleteAt: string }) {
  const dateStr = scheduledDeleteAt ? new Date(scheduledDeleteAt).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }) : 'N/A';
  return (
    <div className="adm-users-del-banner">
      <i className="fas fa-trash-alt adm-users-del-icon" />
      <span>This user is scheduled for deletion on {dateStr}</span>
    </div>
  );
}

export default function UsersPage({ selectedUser: _selectedUser, onSelectUser, onNavigate, isDemoMode }: {
  selectedUser: { id: string; role: string };
  onSelectUser: (u: { id: string; role: string }) => void;
  onNavigate: (page: string) => void;
  isDemoMode: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState('10');
  const [page, setPage] = useState(1);
  const [confirmDialog, setConfirmDialog] = useState<{ userId: string } | null>(null);
  const [deletedUsers, setDeletedUsers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  const fetchUsers = useCallback((silent = false) => {
    if (!silent) setUsersLoading(true);
    apiCall(`/api/admin/users?demo=${isDemoMode}`, { method: 'GET' }).then(({ ok, status, data }) => {
      if (ok) {
        setUsers((data as UserListItem[]).map(mapUserListItem));
      } else if (status === 401) {
        signOut();
        router.replace('/login');
      } else if (status === 403) {
        setToast({ message: 'Access Denied', type: 'error' });
      } else {
        setToast({ message: 'Server Error', type: 'error' });
      }
      setUsersLoading(false);
    });
  }, [router, isDemoMode]);

  useEffect(() => {
    setTimeout(() => fetchUsers(), 0);
    const interval = setInterval(() => {
      fetchUsers(true); // silent refresh every second
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchUsers]);

  const handleDelete = () => {
    if (!confirmDialog) return;
    setLoading(true);
    apiCall(`/api/admin/users/${confirmDialog.userId}`, { method: 'DELETE' })
      .then(({ ok, status, data }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        const { scheduled_at } = data as { scheduled_at: string };
        setDeletedUsers(prev => ({ ...prev, [confirmDialog.userId]: scheduled_at }));
        setToast({ message: 'User scheduled for deletion', type: 'success' });
        setConfirmDialog(null);
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      })
      .finally(() => setLoading(false));
  };

  const handleDownloadExcel = () => {
    const exportData = filtered.map(u => ({
      ID: u.id,
      Name: u.fullName,
      Role: u.role,
      Status: u.active ? 'Active' : 'Inactive',
      'Ledger Balance': u.ledgerBal,
      'Open PnL': u.openPnl,
      M2M: u.m2m,
      'Weekly PnL': u.weeklyPnl,
      Broker: u.broker,
      Mobile: u.mobile,
      Segments: u.segments.join(', '),
      'Read Only': u.read_only ? 'Yes' : 'No',
      'Demo User': u.demo_user ? 'Yes' : 'No',
      'Intraday SQ Off': u.intraday_sq_off ? 'Yes' : 'No',
      'Auto SQ Off %': u.auto_sqoff,
      'Showcase SQ Off %': u.showcase_auto_sqoff,
      'SQ Off Method': u.sqoff_method,
    }));
    downloadCSV(exportData, `users_export_${new Date().toISOString().split('T')[0]}.csv`);
    setToast({ message: 'Export started', type: 'success' });
  };

  const filtered = users.filter(u =>
    u.id.toLowerCase().includes(search.toLowerCase()) ||
    (u.client_id && u.client_id.toLowerCase().includes(search.toLowerCase())) ||
    u.fullName.toLowerCase().includes(search.toLowerCase()) ||
    u.broker.toLowerCase().includes(search.toLowerCase())
  );

  const active = users.filter(u => u.active).length;
  const inactive = users.filter(u => !u.active).length;

  const rowsNum = Number(rows);
  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsNum));
  const displayed = filtered.slice((page - 1) * rowsNum, page * rowsNum);

  const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="adm-users-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      {confirmDialog && (
        <ConfirmDialog
          message={`Delete user ${confirmDialog.userId}? This will schedule deletion after 30 days.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDialog(null)}
          loading={loading}
        />
      )}

      <div className="adm-users-stats">
        <div className="adm-users-stat">
          <div className="adm-users-stat-label">ACTIVE</div>
          <div className="adm-users-stat-value pos">{active}</div>
        </div>
        <div className="adm-users-stat">
          <div className="adm-users-stat-label">INACTIVE</div>
          <div className="adm-users-stat-value neg">{inactive}</div>
        </div>
        <div className="adm-users-stat">
          <div className="adm-users-stat-label">TOTAL</div>
          <div className="adm-users-stat-value">{users.length}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="adm-ord-search-wrap" style={{ flex: 1, minWidth: 280 }}>
          <i className="fas fa-search adm-ord-search-icon" />
          <input className="adm-ord-search" placeholder="Search by name, ID or broker..." value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="adm-btn-ghost" onClick={() => fetchUsers()} title="Refresh Data">
            <i className="fas fa-sync-alt" />
          </button>
          <button className="adm-btn-primary" onClick={() => onNavigate('create')}>
            <i className="fas fa-user-plus" style={{ marginRight: 8 }} />
            Create New User
          </button>
        </div>
      </div>

      <div className="adm-ord-controls" style={{ marginTop: 12 }}>
        <div className="adm-ord-rows-wrap">
          <span className="adm-ord-rows-label">Rows</span>
          <select className="adm-ord-rows-select" value={rows} onChange={e => { setRows(e.target.value); setPage(1); }}>
            {['10', '25', '50', '100'].map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button className="adm-ord-download" onClick={handleDownloadExcel}>
          <i className="fas fa-download" style={{ marginRight: 8 }} /> 
          Download Excel
        </button>
      </div>

      <div className="adm-users-list">
        {usersLoading ? (
          <div style={{ padding: '40px 0', width: '100%' }}>
            <AnimatedLoader text="Loading users..." fullScreen={false} />
          </div>
        ) : displayed.length === 0 ? (
          <div className="adm-dashed-box">No users found.</div>
        ) : displayed.map((u, i) => (
          <div className="adm-users-card" key={u.id}>
            <div className="adm-users-card-header">
              <span className="adm-users-fullname">{u.fullName} <span className="adm-users-role-tag">({u.role})</span></span>
              <span className={`adm-users-status ${u.active ? 'active' : 'inactive'}`}>{u.active ? 'Active' : 'Inactive'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="adm-users-uid">{(u.client_id || u.id.slice(0, 8)).toUpperCase()} <span style={{ opacity: 0.5, fontSize: '0.7em' }}>{u.id.slice(0, 12)}</span></div>
              {u.broker !== 'DIRECT' && (
                <div className="adm-acc-broker-tag" style={{ margin: 0 }}>Managed by: {u.broker}</div>
              )}
            </div>
            <div className="adm-users-grid">
              <span className="adm-users-dl">Ledger Bal</span>
              <span className="adm-users-dv">{fmt(u.ledgerBal)}</span>
              {u.settlementAmount !== 0 && (
                <>
                  <span className="adm-users-dl" style={{ color: '#f85149' }}>Settlement Deficit</span>
                  <span className="adm-users-dv bold" style={{ color: '#f85149' }}>{fmt(u.settlementAmount)}</span>
                </>
              )}
              <span className="adm-users-dl">M. Available</span>
              <span className={`adm-users-dv ${u.mAvailable < 1000 ? 'warn' : ''}`}>{fmt(u.mAvailable)}</span>

              <span className="adm-users-dl live">Open PnL</span>
              <span className={`adm-users-dv ${u.openPnl < 0 ? 'neg' : u.openPnl > 0 ? 'pos' : ''}`}>{fmt(u.openPnl)}</span>
              <span className="adm-users-dl live">M2M</span>
              <span className={`adm-users-dv ${u.m2m < 0 ? 'neg' : u.m2m > 0 ? 'pos' : ''}`}>{fmt(u.m2m)}</span>

              <span className="adm-users-dl">Weekly PnL</span>
              <span className={`adm-users-dv ${u.weeklyPnl < 0 ? 'neg' : u.weeklyPnl > 0 ? 'pos' : ''}`}>{fmt(u.weeklyPnl)}</span>
              <span className="adm-users-dl">Margin Used</span>
              <span className="adm-users-dv">{fmt(u.marginUsed)}</span>

              <span className="adm-users-dl">Hierarchy</span>
              <span className="adm-users-dv bold">{u.broker}</span>
              <span className="adm-users-dl">Mobile</span>
              <span className="adm-users-dv">{u.mobile}</span>
            </div>
            <div className="adm-users-actions">
              <button className="adm-users-btn pos-btn" onClick={() => { onSelectUser({ id: u.id, role: u.role }); onNavigate('position'); }}>Positions</button>
              <button className="adm-users-btn orders-btn" onClick={() => { onSelectUser({ id: u.id, role: u.role }); onNavigate('orders'); }} style={{ backgroundColor: '#2f74e5', color: '#fff' }}>Orders</button>
              <button className="adm-users-btn ledger-btn" onClick={() => { onSelectUser({ id: u.id, role: u.role }); onNavigate('actledger'); }}>Ledger</button>
              <button className="adm-users-btn" style={{ backgroundColor: '#1f6feb', color: '#fff' }} onClick={() => { onSelectUser({ id: u.id, role: u.role }); onNavigate('transactions'); }}>Transactions</button>
              <button className="adm-users-btn update-btn" onClick={() => { onSelectUser({ id: u.id, role: u.role }); onNavigate('update'); }}>Update</button>
              <button className="adm-users-btn delete-btn" onClick={() => setConfirmDialog({ userId: u.id })}>Delete</button>
            </div>
            {(deletedUsers[u.id] || u.scheduled_delete_at) && (
              <DeletionBanner scheduledDeleteAt={deletedUsers[u.id] || u.scheduled_delete_at!} />
            )}
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
    </div>
  );
}
