'use client';
import React, { useState, useEffect } from 'react';
import { apiCall, Toast, ToastState, SkeletonLine, UserListItem } from './AdminUtils';

export default function AdminsPage({ isDemoMode, onNavigate }: { isDemoMode: boolean; onNavigate?: (page: string) => void }) {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastState>(null);
  
  // Drill-down state
  const [selectedAdmin, setSelectedAdmin] = useState<any>(null);
  const [selectedBroker, setSelectedBroker] = useState<any>(null);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await apiCall(`/api/admin/users?demo=${isDemoMode}`, {});
      if (res.ok && Array.isArray(res.data)) {
        setUsers(res.data as UserListItem[]);
      } else {
        setToast({ message: 'Failed to fetch users', type: 'error' });
      }
    } catch (e) {
      setToast({ message: 'Network error', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [isDemoMode]);

  const allAdmins = users.filter(u => u.role.toLowerCase() === 'admin');
  const allBrokers = users.filter(u => u.role.toLowerCase() === 'broker' || u.role.toLowerCase() === 'sub_broker');
  const allEndUsers = users.filter(u => u.role.toLowerCase() === 'user');

  // Stats calculation
  const adminStats = allAdmins.map(admin => {
    const adminBrokers = allBrokers.filter(b => b.parent_id === admin.id);
    const adminBrokerIds = adminBrokers.map(b => b.id);
    const adminUsers = allEndUsers.filter(u => adminBrokerIds.includes(u.parent_id || ''));
    
    return {
      ...admin,
      totalBrokers: adminBrokers.length,
      totalUsers: adminUsers.length,
      brokersList: adminBrokers,
    };
  });

  const filteredAdmins = adminStats.filter(a => 
    (a.full_name || '').toLowerCase().includes(search.toLowerCase()) || 
    a.id.toLowerCase().includes(search.toLowerCase()) ||
    (a.email || '').toLowerCase().includes(search.toLowerCase())
  );

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleUnlink = async (e: React.MouseEvent, userId: string, userName: string) => {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to remove ${userName || userId} from this parent?`)) return;
    
    setToast({ message: 'Unlinking...', type: 'success' });
    try {
      const res = await apiCall(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ parent_id: null })
      });
      if (res.ok) {
        setToast({ message: 'User removed from parent', type: 'success' });
        fetchUsers();
      } else {
        setToast({ message: 'Failed to unlink user', type: 'error' });
      }
    } catch {
      setToast({ message: 'Network error', type: 'error' });
    }
  };

  // View: Tier 3 (End Users under a Broker under an Admin)
  if (selectedBroker && selectedAdmin) {
    const updatedBroker = allBrokers.find(x => x.id === selectedBroker.id) || selectedBroker;
    const brokerUsers = allEndUsers.filter(u => u.parent_id === updatedBroker.id);
    
    const activeCount = brokerUsers.filter(u => u.active).length;
    const totalM2m = brokerUsers.reduce((sum, u) => sum + (u.m2m ?? 0), 0);
    const totalOpenPnl = brokerUsers.reduce((sum, u) => sum + (u.openPnl ?? 0), 0);
    const totalLedger = brokerUsers.reduce((sum, u) => sum + (u.balance ?? 0), 0);

    return (
      <div className="adm-users-root">
        <Toast toast={toast} onDismiss={() => setToast(null)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <button className="adm-btn-ghost" onClick={() => setSelectedBroker(null)}>
            <i className="fas fa-arrow-left" /> Back to {selectedAdmin.full_name}'s Brokers
          </button>
          <div style={{ fontSize: '1.2rem', fontWeight: 600, color: '#e6edf3' }}>{updatedBroker.full_name || 'Unnamed Broker'}</div>
          <div style={{ fontSize: '0.8rem', padding: '4px 8px', background: '#21262d', borderRadius: 4, fontFamily: 'monospace', color: '#8b949e' }}>
            ID: {updatedBroker.id}
          </div>
        </div>

        <div className="adm-users-stats">
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">TOTAL USERS</div>
            <div className="adm-users-stat-value">{brokerUsers.length}</div>
          </div>
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">ACTIVE USERS</div>
            <div className="adm-users-stat-value pos">{activeCount}</div>
          </div>
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">USERS PNL (M2M)</div>
            <div className={`adm-users-stat-value ${totalM2m >= 0 ? 'pos' : 'neg'}`}>
              {totalM2m >= 0 ? '+' : ''}₹{fmt(totalM2m)}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 24, fontSize: '1.1rem', fontWeight: 600, borderBottom: '1px solid #30363d', paddingBottom: 10, marginBottom: 16, color: '#e6edf3' }}>
          Users Under {updatedBroker.full_name || 'this Broker'} ({brokerUsers.length})
        </div>

        <div className="adm-users-list">
          {brokerUsers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>No users found for this broker.</div>
            </div>
          ) : (
            brokerUsers.map((u: any) => (
              <div key={u.id} className="adm-users-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, color: '#e6edf3', fontSize: '0.95rem' }}>{u.full_name || 'N/A'}</div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button 
                      className="adm-btn-ghost" 
                      style={{ padding: '4px 8px', fontSize: '0.75rem', color: '#f85149', borderColor: '#f8514940' }} 
                      onClick={(e) => handleUnlink(e, u.id, u.full_name)}
                    >
                      <i className="fas fa-unlink" style={{ marginRight: 6 }} />
                      Unlink
                    </button>
                    <span style={{ 
                      padding: '2px 8px', borderRadius: 12, fontSize: '0.75rem', fontWeight: 600,
                      background: u.active ? 'rgba(46,160,67,0.1)' : 'rgba(248,81,73,0.1)',
                      color: u.active ? '#2ea043' : '#f85149'
                    }}>
                      {u.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: '0.8rem', color: '#8b949e' }}>
                  <div>ID: <span style={{ color: '#e6edf3', fontFamily: 'monospace' }}>{u.id}</span></div>
                  <div>Email: <span style={{ color: '#e6edf3' }}>{u.email}</span></div>
                  <div>Balance: <span style={{ color: '#e6edf3' }}>₹{fmt(u.balance)}</span></div>
                  <div>Open P&L: <span style={{ color: (u.openPnl ?? 0) >= 0 ? '#2ea043' : '#f85149', fontWeight: 600 }}>{fmt(u.openPnl)}</span></div>
                  <div>M2M: <span style={{ color: (u.m2m ?? 0) >= 0 ? '#2ea043' : '#f85149', fontWeight: 600 }}>{fmt(u.m2m)}</span></div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // View: Tier 2 (Brokers under an Admin)
  if (selectedAdmin) {
    const updatedAdmin = adminStats.find(x => x.id === selectedAdmin.id) || selectedAdmin;
    const adminBrokers = updatedAdmin.brokersList;

    return (
      <div className="adm-users-root">
        <Toast toast={toast} onDismiss={() => setToast(null)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <button className="adm-btn-ghost" onClick={() => setSelectedAdmin(null)}>
            <i className="fas fa-arrow-left" /> Back to Admins
          </button>
          <div style={{ fontSize: '1.2rem', fontWeight: 600, color: '#e6edf3' }}>{updatedAdmin.full_name || 'Unnamed Admin'}</div>
          <div style={{ fontSize: '0.8rem', padding: '4px 8px', background: '#21262d', borderRadius: 4, fontFamily: 'monospace', color: '#8b949e' }}>
            ID: {updatedAdmin.id}
          </div>
        </div>

        <div className="adm-users-stats">
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">TOTAL REFERRED BROKERS</div>
            <div className="adm-users-stat-value">{adminBrokers.length}</div>
          </div>
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">TOTAL END USERS</div>
            <div className="adm-users-stat-value">{updatedAdmin.totalUsers}</div>
          </div>
        </div>

        <div style={{ marginTop: 24, fontSize: '1.1rem', fontWeight: 600, borderBottom: '1px solid #30363d', paddingBottom: 10, marginBottom: 16, color: '#e6edf3' }}>
          Brokers Under {updatedAdmin.full_name || 'this Admin'} ({adminBrokers.length})
        </div>

        <div className="adm-users-list">
          {adminBrokers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>No brokers found for this admin.</div>
            </div>
          ) : (
            adminBrokers.map((b: any) => {
              const brokerUsers = allEndUsers.filter(u => u.parent_id === b.id);
              const totalLedger = brokerUsers.reduce((sum, u) => sum + (u.balance ?? 0), 0);
              const totalM2m = brokerUsers.reduce((sum, u) => sum + (u.m2m ?? 0), 0);
              
              return (
                <div key={b.id} className="adm-users-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, cursor: 'pointer', transition: 'border-color 0.2s' }} onClick={() => setSelectedBroker(b)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 600, color: '#e6edf3', fontSize: '0.95rem' }}>{b.full_name || 'N/A'}</div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <button 
                        className="adm-btn-ghost" 
                        style={{ padding: '4px 8px', fontSize: '0.75rem', color: '#f85149', borderColor: '#f8514940' }} 
                        onClick={(e) => handleUnlink(e, b.id, b.full_name)}
                      >
                        <i className="fas fa-unlink" style={{ marginRight: 6 }} />
                        Unlink
                      </button>
                      <button className="adm-btn-ghost" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={(e) => { e.stopPropagation(); setSelectedBroker(b); }}>
                        View Users
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: '0.8rem', color: '#8b949e' }}>
                    <div>ID: <span style={{ color: '#e6edf3', fontFamily: 'monospace' }}>{b.id}</span></div>
                    <div>Email: <span style={{ color: '#e6edf3' }}>{b.email}</span></div>
                    <div>Total Users: <span style={{ color: '#e6edf3', fontWeight: 600 }}>{brokerUsers.length}</span></div>
                    <div>Users Ledger: <span style={{ color: '#e6edf3' }}>₹{fmt(totalLedger)}</span></div>
                    <div>Users M2M: <span style={{ color: totalM2m >= 0 ? '#2ea043' : '#f85149', fontWeight: 600 }}>{totalM2m >= 0 ? '+' : ''}₹{fmt(totalM2m)}</span></div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // View: Tier 1 (All Admins)
  return (
    <div className="adm-users-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      
      <div className="adm-users-stats">
        <div className="adm-users-stat">
          <div className="adm-users-stat-label">TOTAL ADMINS</div>
          <div className="adm-users-stat-value">{allAdmins.length}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="adm-ord-search-wrap" style={{ flex: 1, minWidth: 280 }}>
          <i className="fas fa-search adm-ord-search-icon" />
          <input className="adm-ord-search" placeholder="Search admins..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="adm-btn-ghost" onClick={fetchUsers} title="Refresh Data">
            <i className="fas fa-sync-alt" />
          </button>
          {onNavigate && (
            <button className="adm-btn-primary" onClick={() => onNavigate('create')}>
              <i className="fas fa-user-plus" style={{ marginRight: 8 }} />
              Create New Admin
            </button>
          )}
        </div>
      </div>

      <div className="adm-users-list">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div className="adm-users-card" key={i} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <SkeletonLine width="60%" height={16} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {Array.from({ length: 4 }).map((_, j) => <SkeletonLine key={j} height={12} width="80%" />)}
              </div>
            </div>
          ))
        ) : filteredAdmins.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <i className="fas fa-shield-alt" style={{ fontSize: '2.5rem', color: '#30363d', marginBottom: 12, display: 'block' }} />
            <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>No admins found.</div>
          </div>
        ) : (
          filteredAdmins.map(a => (
            <div key={a.id} className="adm-users-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, cursor: 'pointer', transition: 'border-color 0.2s' }} onClick={() => setSelectedAdmin(a)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600, color: '#e6edf3', fontSize: '0.95rem' }}>
                  <i className="fas fa-shield-alt" style={{ marginRight: '8px', color: '#1f6feb' }}></i>
                  {a.full_name || 'N/A'}
                </div>
                <button className="adm-btn-ghost" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={(e) => { e.stopPropagation(); setSelectedAdmin(a); }}>
                  View Brokers
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: '0.8rem', color: '#8b949e' }}>
                <div>ID: <span style={{ color: '#e6edf3', fontFamily: 'monospace' }}>{a.id}</span></div>
                <div>Email: <span style={{ color: '#e6edf3' }}>{a.email}</span></div>
                <div>Total Brokers: <span style={{ color: '#e6edf3', fontWeight: 600 }}>{a.totalBrokers}</span></div>
                <div>Total Users: <span style={{ color: '#e6edf3', fontWeight: 600 }}>{a.totalUsers}</span></div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
