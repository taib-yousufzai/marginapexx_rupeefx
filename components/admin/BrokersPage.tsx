'use client';
import React, { useState, useEffect } from 'react';
import { apiCall, Toast, ToastState, SkeletonLine, UserListItem } from './AdminUtils';

export default function BrokersPage({ isDemoMode, onNavigate }: { isDemoMode: boolean; onNavigate?: (page: string) => void }) {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<ToastState>(null);
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

  const allBrokers = users.filter(u => u.role.toLowerCase() === 'broker');
  const regularUsers = users.filter(u => u.role.toLowerCase() !== 'broker');

  const brokerStats = allBrokers.map(broker => {
    const brokerUsers = regularUsers.filter(u => u.parent_id === broker.id);
    const activeCount = brokerUsers.filter(u => u.active).length;
    const totalM2m = brokerUsers.reduce((sum, u) => sum + (u.m2m ?? 0), 0);
    const totalOpenPnl = brokerUsers.reduce((sum, u) => sum + (u.openPnl ?? 0), 0);
    const totalLedger = brokerUsers.reduce((sum, u) => sum + (u.balance ?? 0), 0);

    return {
      ...broker,
      totalUsers: brokerUsers.length,
      activeUsers: activeCount,
      totalM2m,
      totalOpenPnl,
      totalLedger,
      usersList: brokerUsers,
    };
  });

  const filteredBrokers = brokerStats.filter(b => 
    (b.full_name || '').toLowerCase().includes(search.toLowerCase()) || 
    b.id.toLowerCase().includes(search.toLowerCase()) ||
    (b.email || '').toLowerCase().includes(search.toLowerCase())
  );

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleUnlink = async (e: React.MouseEvent, userId: string, userName: string) => {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to remove ${userName || userId} from this broker?`)) return;
    
    setToast({ message: 'Unlinking...', type: 'success' });
    try {
      const res = await apiCall(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ parent_id: '' })
      });
      if (res.ok) {
        setToast({ message: 'User removed from broker', type: 'success' });
        fetchUsers(); // Refresh the data
      } else {
        setToast({ message: 'Failed to unlink user', type: 'error' });
      }
    } catch {
      setToast({ message: 'Network error', type: 'error' });
    }
  };

  if (selectedBroker) {
    const b = selectedBroker;
    // Re-evaluate b from state so we get updated data if it refreshes
    const updatedBroker = brokerStats.find(x => x.id === b.id) || b;
    return (
      <div className="adm-users-root">
        <Toast toast={toast} onDismiss={() => setToast(null)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <button className="adm-btn-ghost" onClick={() => setSelectedBroker(null)}>
            <i className="fas fa-arrow-left" /> Back to Brokers
          </button>
          <div style={{ fontSize: '1.2rem', fontWeight: 600, color: '#e6edf3' }}>{updatedBroker.full_name || 'Unnamed Broker'}</div>
          <div style={{ fontSize: '0.8rem', padding: '4px 8px', background: '#21262d', borderRadius: 4, fontFamily: 'monospace', color: '#8b949e' }}>
            ID: {updatedBroker.id}
          </div>
        </div>

        <div className="adm-users-stats">
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">TOTAL REFERRED USERS</div>
            <div className="adm-users-stat-value">{updatedBroker.totalUsers}</div>
          </div>
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">ACTIVE USERS</div>
            <div className="adm-users-stat-value pos">{updatedBroker.activeUsers}</div>
          </div>
          <div className="adm-users-stat">
            <div className="adm-users-stat-label">USERS TOTAL PNL (M2M)</div>
            <div className={`adm-users-stat-value ${updatedBroker.totalM2m >= 0 ? 'pos' : 'neg'}`}>
              {updatedBroker.totalM2m >= 0 ? '+' : ''}₹{fmt(updatedBroker.totalM2m)}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 24, fontSize: '1.1rem', fontWeight: 600, borderBottom: '1px solid #30363d', paddingBottom: 10, marginBottom: 16, color: '#e6edf3' }}>
          Users Under {updatedBroker.full_name || 'this Broker'} ({updatedBroker.usersList.length})
        </div>

        <div className="adm-users-list">
          {updatedBroker.usersList.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>No users found for this broker.</div>
            </div>
          ) : (
            updatedBroker.usersList.map((u: any) => (
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

  return (
    <div className="adm-users-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      
      <div className="adm-users-stats">
        <div className="adm-users-stat">
          <div className="adm-users-stat-label">TOTAL BROKERS</div>
          <div className="adm-users-stat-value">{allBrokers.length}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="adm-ord-search-wrap" style={{ flex: 1, minWidth: 280 }}>
          <i className="fas fa-search adm-ord-search-icon" />
          <input className="adm-ord-search" placeholder="Search brokers..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="adm-btn-ghost" onClick={fetchUsers} title="Refresh Data">
            <i className="fas fa-sync-alt" />
          </button>
          {onNavigate && (
            <button className="adm-btn-primary" onClick={() => onNavigate('create')}>
              <i className="fas fa-user-plus" style={{ marginRight: 8 }} />
              Create New Broker
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
        ) : filteredBrokers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <i className="fas fa-user-tie" style={{ fontSize: '2.5rem', color: '#30363d', marginBottom: 12, display: 'block' }} />
            <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>No brokers found.</div>
          </div>
        ) : (
          filteredBrokers.map(b => (
            <div key={b.id} className="adm-users-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, cursor: 'pointer', transition: 'border-color 0.2s' }} onClick={() => setSelectedBroker(b)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600, color: '#e6edf3', fontSize: '0.95rem' }}>{b.full_name || 'N/A'}</div>
                <button className="adm-btn-ghost" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={(e) => { e.stopPropagation(); setSelectedBroker(b); }}>
                  View Details
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: '0.8rem', color: '#8b949e' }}>
                <div>ID: <span style={{ color: '#e6edf3', fontFamily: 'monospace' }}>{b.id}</span></div>
                <div>Email: <span style={{ color: '#e6edf3' }}>{b.email}</span></div>
                <div>Users: <span style={{ color: '#e6edf3', fontWeight: 600 }}>{b.totalUsers} ({b.activeUsers} active)</span></div>
                <div>Ledger: <span style={{ color: '#e6edf3' }}>₹{fmt(b.totalLedger)}</span></div>
                <div>Users M2M: <span style={{ color: b.totalM2m >= 0 ? '#2ea043' : '#f85149', fontWeight: 600 }}>{b.totalM2m >= 0 ? '+' : ''}₹{fmt(b.totalM2m)}</span></div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
