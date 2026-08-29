'use client';
import React, { useState } from 'react';
import { apiCall, Toast, ToastState } from './AdminUtils';

const SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'NSE-EQ', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

export default function CreateUserForm({ onBack, onCreated, isDemoMode, callerRole }: { onBack: () => void; onCreated: (id: string, role: string) => void; isDemoMode?: boolean; callerRole?: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState(callerRole === 'super_admin' ? 'Admin' : callerRole === 'admin' ? 'Broker' : 'User');
  const [parent, setParent] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [active, setActive] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [demoUser, setDemoUser] = useState(isDemoMode || false);
  const [intradaySqOff, setIntradaySqOff] = useState(false);
  const [autoSqoff, setAutoSqoff] = useState('90');
  const [showcaseAutoSqoff, setShowcaseAutoSqoff] = useState('85');
  const [sqoffMethod, setSqoffMethod] = useState('Credit');
  const [segments, setSegments] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const usernameAvailable = username.length >= 3;

  const toggleSegment = (s: string) =>
    setSegments(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  const handleCreate = async () => {
    if (!username.trim()) return;
    setLoading(true);
    const { ok, data } = await apiCall('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        username,
        full_name: fullName,
        phone,
        role: role.toLowerCase().replace(' ', '_'),
        parent_id: parent,
        segments,
        active,
        read_only: readOnly,
        demo_user: demoUser,
        intraday_sq_off: intradaySqOff,
        auto_sqoff: Number(autoSqoff),
        showcase_auto_sqoff: Number(showcaseAutoSqoff),
        sqoff_method: sqoffMethod,
      }),
    });
    if (ok) {
      const d = data as { id: string; role?: string };
      onCreated(d.id, d.role ?? role.toUpperCase().replace(' ', '_'));
    } else {
      const errorMsg = (data as any).error || (data as any).message || 'Failed to create user';
      setToast({ message: errorMsg, type: 'error' });
      setLoading(false);
    }
  };

  return (
    <div className="adm-cu-root">
      <div className="adm-cu-header">
        <button className="adm-cu-back" onClick={onBack}>‹</button>
        <div>
          <div className="adm-cu-title">Create New User</div>
          <div className="adm-cu-sub">Fill user details to create a new broker / subbroker / user.</div>
        </div>
      </div>

      <div className="adm-cu-scroll">
        <div className="adm-cu-field">
          <label className="adm-cu-label">Username</label>
          <input
            className={`adm-cu-input ${usernameAvailable && username ? 'valid' : ''}`}
            placeholder="FOT290"
            value={username}
            onChange={e => setUsername(e.target.value)}
          />
          {usernameAvailable && username && (
            <div className="adm-cu-available">✓ Username is available</div>
          )}
        </div>

        <div className="adm-cu-field">
          <label className="adm-cu-label">Password</label>
          <div className="adm-cu-input-wrap">
            <input
              className="adm-cu-input"
              placeholder="Enter password"
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            <button className="adm-cu-eye" onClick={() => setShowPass(v => !v)}>
              <i className={`fas ${showPass ? 'fa-eye-slash' : 'fa-eye'}`} />
            </button>
          </div>
        </div>

        <div className="adm-cu-field">
          <label className="adm-cu-label">Full Name</label>
          <input className="adm-cu-input" placeholder="Enter full name" value={fullName} onChange={e => setFullName(e.target.value)} />
        </div>

        <div className="adm-cu-field">
          <label className="adm-cu-label">Email</label>
          <input className="adm-cu-input" placeholder="user@example.com" type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </div>

        <div className="adm-cu-field">
          <label className="adm-cu-label">Phone Number</label>
          <input className="adm-cu-input" placeholder="1234567890" type="tel" value={phone} onChange={e => setPhone(e.target.value)} />
        </div>

        <div className="adm-cu-field">
          <label className="adm-cu-label">Role</label>
          <select className="adm-cu-input adm-cu-select" value={role} onChange={e => setRole(e.target.value)}>
            {callerRole === 'super_admin' && <option>Admin</option>}
            {(callerRole === 'super_admin' || callerRole === 'admin') && <option>Broker</option>}
            <option>User</option>
          </select>
        </div>

        <div className="adm-cu-field">
          <label className="adm-cu-label">Parent Account</label>
          <input className="adm-cu-input" placeholder="Search parent by username or name..." value={parent} onChange={e => setParent(e.target.value)} />
        </div>

        <div className="adm-cu-field">
          <label className="adm-cu-label">Copy Settings From (optional)</label>
          <input className="adm-cu-input" placeholder="Search by username or full name..." value={copyFrom} onChange={e => setCopyFrom(e.target.value)} />
        </div>

        <div className="adm-cu-divider" />

        <div className="adm-cu-section-title">User Settings</div>
        <div className="adm-cu-toggles-grid">
          <div className="adm-cu-toggle-item">
            <span className="adm-cu-toggle-label">Active</span>
            <div className={`adm-toggle ${active ? 'on' : ''}`} onClick={() => setActive(v => !v)}>
              <div className="adm-toggle-thumb" />
            </div>
          </div>
          <div className="adm-cu-toggle-item">
            <span className="adm-cu-toggle-label">Read Only</span>
            <div className={`adm-toggle ${readOnly ? 'on' : ''}`} onClick={() => setReadOnly(v => !v)}>
              <div className="adm-toggle-thumb" />
            </div>
          </div>
          <div className="adm-cu-toggle-item">
            <span className="adm-cu-toggle-label">Demo User</span>
            <div className={`adm-toggle ${demoUser ? 'on' : ''}`} onClick={() => setDemoUser(v => !v)}>
              <div className="adm-toggle-thumb" />
            </div>
          </div>
          <div className="adm-cu-toggle-item">
            <span className="adm-cu-toggle-label">Intraday Square Off</span>
            <div className={`adm-toggle ${intradaySqOff ? 'on' : ''}`} onClick={() => setIntradaySqOff(v => !v)}>
              <div className="adm-toggle-thumb" />
            </div>
          </div>
        </div>

        <div className="adm-cu-section-title">Global Settings</div>
        <div className="adm-cu-global-row">
          <div className="adm-cu-field" style={{ flex: 1 }}>
            <label className="adm-cu-label">Base Auto Sqoff %</label>
            <input className="adm-cu-input" type="number" value={autoSqoff} onChange={e => setAutoSqoff(e.target.value)} />
          </div>
          <div className="adm-cu-field" style={{ flex: 1 }}>
            <label className="adm-cu-label">Showcase Sqoff %</label>
            <input className="adm-cu-input" type="number" value={showcaseAutoSqoff} onChange={e => setShowcaseAutoSqoff(e.target.value)} />
          </div>
          <div className="adm-cu-field" style={{ flex: 1 }}>
            <label className="adm-cu-label">Auto Sqoff Method</label>
            <select className="adm-cu-input adm-cu-select" value={sqoffMethod} onChange={e => setSqoffMethod(e.target.value)}>
              <option>Credit</option>
              <option>Debit</option>
              <option>Net</option>
            </select>
          </div>
        </div>

        <div className="adm-cu-section-title">Exchange Segments</div>
        <div className="adm-cu-segments-grid">
          {SEGMENTS.map(s => (
            <label className="adm-cu-seg-item" key={s}>
              <input
                type="checkbox"
                className="adm-cu-checkbox"
                checked={segments.includes(s)}
                onChange={() => toggleSegment(s)}
              />
              <span className="adm-cu-seg-label">{s}</span>
            </label>
          ))}
        </div>

        <div className="adm-cu-section-title">Segment Settings</div>
        <div className="adm-cu-divider" />

        <div className="adm-cu-actions">
          <button className="adm-sheet-cancel" onClick={onBack}>Cancel</button>
          <button className="adm-btn-primary" style={{ padding: '10px 24px' }} onClick={handleCreate} disabled={loading}>
            {loading ? 'Creating…' : 'Create User'}
          </button>
        </div>

        <div style={{ height: 24 }} />
      </div>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
