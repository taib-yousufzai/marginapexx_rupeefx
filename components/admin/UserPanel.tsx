'use client';
import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth';
import AnimatedLoader from '@/components/AnimatedLoader';
import { apiCall, Toast, ToastState, SkeletonLine } from './AdminUtils';

export type UserListItem = {
  id: string; email: string; full_name: string | null; phone: string | null;
  role: string; parent_id: string | null; segments: string[] | null;
  active: boolean; read_only: boolean; demo_user: boolean;
  balance: number; created_at: string; scheduled_delete_at: string | null;
  client_id?: string;
};
const PAGE_SIZE = 100;
export default function UserPanel({ open, onClose, onCreateUser, selectedUser, onSelectUser, isDemoMode, isBroker }: {
  open: boolean;
  onClose: () => void;
  onCreateUser: () => void;
  selectedUser: { id: string; role: string } | null;
  onSelectUser: (u: UserListItem) => void;
  isDemoMode?: boolean;
  isBroker?: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    if (!open) return; // Only load when opened
    setUsersLoading(true);
    const endpoint = isBroker ? `/api/broker/users` : `/api/admin/users?demo=${isDemoMode}`;
    apiCall(endpoint, { method: 'GET' }).then(({ ok, status, data }) => {
      if (ok) {
        const items = (data as UserListItem[]).map(u => ({
          ...u,
          role: u.role.toUpperCase(),
        }));
        setUsers(items);
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
  }, [open, isDemoMode, isBroker, router]);

  const filtered = users.filter(u => 
    u.id.toLowerCase().includes(search.toLowerCase()) ||
    (u.client_id && u.client_id.toLowerCase().includes(search.toLowerCase())) ||
    (u.full_name && u.full_name.toLowerCase().includes(search.toLowerCase())) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      {open && <div className="adm-overlay" onClick={onClose} />}
      <div className={`adm-user-panel ${open ? 'open' : ''}`}>
        <div className="adm-up-header">
          <button className="adm-up-close" onClick={onClose}>✕</button>
        </div>

        <div className="adm-up-search-wrap">
          <i className="fas fa-search adm-up-search-icon" />
          <input
            className="adm-up-search"
            placeholder="Search by name"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>

        <div className="adm-up-create-row">
          <span className="adm-up-create-label">Create New User</span>
          <button className="adm-up-add-link" onClick={onCreateUser}>Add</button>
        </div>

        <div className="adm-up-list">
          {usersLoading
            ? (
              <div style={{ padding: '20px 0', width: '100%' }}>
                <AnimatedLoader text="Loading..." fullScreen={false} />
              </div>
            )
            : paged.map((u, i) => {
              const isSelected = selectedUser?.id === u.id;
              const displayName = u.full_name || u.email;
              const displayId = (u.client_id || u.id.slice(0, 8)).toUpperCase();
              return (
                <div
                  key={i}
                  className={`adm-up-row ${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectUser(u)}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1, paddingRight: '8px' }}>
                    <span className="adm-up-id" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayName}>
                      {displayName}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: '#8b949e', fontFamily: 'monospace' }}>{displayId}</span>
                  </div>
                  <span className={`adm-up-role ${u.role === 'SUB_BROKER' ? 'sub' : ''} ${isSelected ? 'sel' : ''}`}>
                    {u.role}
                  </span>
                </div>
              );
            })
          }
        </div>

        <div className="adm-up-pagination">
          <span className="adm-up-page-info">Page {page} of {totalPages}</span>
          <div className="adm-up-page-btns">
            <button className="adm-up-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</button>
            <button className="adm-up-page-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </div>
      </div>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
