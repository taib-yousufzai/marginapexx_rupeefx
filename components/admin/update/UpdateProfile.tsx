'use client';
import React, { useState, useEffect } from 'react';
import { signOut } from '@/lib/auth';
import { apiCall, Toast, ToastState, UserListItem } from '../AdminUtils';

const ALL_SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'NSE-EQ', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

export default function UpdateProfile({ selectedUser, isBroker = false }: { selectedUser: { id: string; role: string }, isBroker?: boolean }) {
  const uid = selectedUser.id;

  const [activation, setActivation] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('User');
  const [parent, setParent] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [demoUser, setDemoUser] = useState(false);
  const [intradaySqOff, setIntradaySqOff] = useState(false);
  const [autoSqoff, setAutoSqoff] = useState('90');
  const [showcaseAutoSqoff, setShowcaseAutoSqoff] = useState('85');
  const [sqoffMethod, setSqoffMethod] = useState('Credit');
  const [tradingMode, setTradingMode] = useState('normal');
  const [segments, setSegments] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string>('');
  const [templates, setTemplates] = useState<any[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    if (!uid) return;
    setTimeout(() => {
      setPassword('');
      setLoading(true);
    }, 0);
    apiCall(`/api/admin/users/${uid}`, { method: 'GET' }).then(({ ok, status, data }) => {
      setLoading(false);
      if (status === 401) { signOut(); return; }
      if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
      if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
      const p = data as UserListItem;
      setEmail(p.email ?? '');
      setFullName(p.full_name ?? '');
      setPhone(p.phone ?? '');
      const roleMap: Record<string, string> = {
        user: 'User', sub_broker: 'Sub Broker', broker: 'Broker', admin: 'Admin', super_admin: 'Admin',
      };
      setRole(roleMap[p.role] ?? 'User');
      setParent(p.parent_id ?? '');
      setActivation(p.active ?? false);
      setReadOnly(p.read_only ?? false);
      setDemoUser(p.demo_user ?? false);
      setIntradaySqOff(p.intraday_sq_off ?? false);
      setAutoSqoff(String(p.auto_sqoff ?? 90));
      setShowcaseAutoSqoff(String((p as any).showcase_auto_sqoff ?? 85));
      setSqoffMethod(p.sqoff_method ?? 'Credit');
      setTradingMode(p.trading_mode ?? 'normal');
      setSegments(p.segments ?? []);
      
      setTemplateId(p.template_id ?? '');

      const tempUrl = isBroker ? '/api/broker/templates' : '/api/admin/templates';
      apiCall(tempUrl, { method: 'GET' }).then(res => {
        if (res.ok && Array.isArray(res.data)) {
          setTemplates(res.data);
        }
      });
    }).catch((err: unknown) => {
      setLoading(false);
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    });
  }, [uid]);

  const toggleSeg = (s: string) => setSegments(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  const handleSave = async () => {
    setLoading(true);
    const { ok, status } = await apiCall(`/api/admin/users/${uid}`, {
      method: 'PATCH',
      body: JSON.stringify({
        email,
        password: password || undefined,
        full_name: fullName,
        phone,
        role: role.toLowerCase().replace(' ', '_'),
        parent_id: parent,
        active: activation,
        read_only: readOnly,
        demo_user: demoUser,
        intraday_sq_off: intradaySqOff,
        auto_sqoff: Number(autoSqoff),
        showcase_auto_sqoff: Number(showcaseAutoSqoff),
        sqoff_method: sqoffMethod,
        trading_mode: tradingMode,
        segments,
        template_id: templateId || null,
      }),
    });
    setLoading(false);
    if (status === 401) { signOut(); return; }
    if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
    if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }

    setToast({ message: 'Profile updated successfully', type: 'success' });
  };

  return (
    <div className="adm-upd-root" style={{ padding: '0 0 40px 0' }}>
      <div className="adm-upd-card">
        <div className="adm-upd-card-header">
          <span className="adm-upd-card-title">User Settings</span>
          <div className="adm-upd-activation">
            <span className="adm-upd-label">Activation</span>
            <div className={`adm-toggle ${activation ? 'on' : ''}`} onClick={() => setActivation(v => !v)}>
              <div className="adm-toggle-thumb" />
            </div>
          </div>
        </div>

        <div className="adm-upd-field">
          <label className="adm-upd-label">Username</label>
          <input className="adm-upd-input" value={uid} readOnly />
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Assigned Template</label>
          <select className="adm-upd-input adm-upd-select" style={{ borderColor: '#30363d', background: '#0d1117' }} value={templateId} onChange={e => setTemplateId(e.target.value)}>
            <option value="">No Template (Custom Settings)</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name} {t.is_default ? '(Default)' : ''}</option>
            ))}
          </select>
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Email</label>
          <input className="adm-upd-input" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Password</label>
          <div className="adm-cu-input-wrap">
            <input className="adm-upd-input" style={{ paddingRight: 40 }} type={showPass ? 'text' : 'password'} placeholder="Leave blank to keep same" value={password} onChange={e => setPassword(e.target.value)} />
            <button className="adm-cu-eye" onClick={() => setShowPass(v => !v)}><i className={`fas ${showPass ? 'fa-eye-slash' : 'fa-eye'}`} /></button>
          </div>
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Full Name</label>
          <input className="adm-upd-input" value={fullName} onChange={e => setFullName(e.target.value)} />
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Phone Number</label>
          <input className="adm-upd-input" value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Role</label>
          <select className="adm-upd-input adm-upd-select" value={role} onChange={e => setRole(e.target.value)}>
            <option>User</option><option>Sub Broker</option><option>Broker</option><option>Admin</option>
          </select>
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Trading Mode</label>
          <select className="adm-upd-input adm-upd-select" value={tradingMode} onChange={e => setTradingMode(e.target.value)}>
            <option value="normal">Normal</option>
            <option value="scalper">Scalper</option>
          </select>
        </div>
        <div className="adm-upd-field">
          <label className="adm-upd-label">Parent Account</label>
          <div className="adm-upd-parent-wrap">
            <input className="adm-upd-input" value={parent} onChange={e => setParent(e.target.value)} />
            {parent && <button className="adm-upd-parent-clear" onClick={() => setParent('')}>✕</button>}
          </div>
        </div>
      </div>

      <div className="adm-upd-card">
        <div className="adm-upd-section-title">User Options &amp; Global Settings</div>
        <div className="adm-upd-toggles-row">
          <div className="adm-upd-toggle-item">
            <span className="adm-upd-label">Read Only</span>
            <div className={`adm-toggle ${readOnly ? 'on' : ''}`} onClick={() => setReadOnly(v => !v)}><div className="adm-toggle-thumb" /></div>
          </div>
          <div className="adm-upd-toggle-item">
            <span className="adm-upd-label">Demo User</span>
            <div className={`adm-toggle ${demoUser ? 'on' : ''}`} onClick={() => setDemoUser(v => !v)}><div className="adm-toggle-thumb" /></div>
          </div>
          <div className="adm-upd-toggle-item">
            <span className="adm-upd-label">Intraday Square Off</span>
            <div className={`adm-toggle ${intradaySqOff ? 'on' : ''}`} onClick={() => setIntradaySqOff(v => !v)}><div className="adm-toggle-thumb" /></div>
          </div>
        </div>

        <div className="adm-upd-section-title" style={{ marginTop: 8 }}>Global Settings</div>
        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Base Auto Sqoff %</label>
            <input className="adm-upd-input" value={autoSqoff} onChange={e => setAutoSqoff(e.target.value)} />
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Showcase Sqoff %</label>
            <input className="adm-upd-input" value={showcaseAutoSqoff} onChange={e => setShowcaseAutoSqoff(e.target.value)} />
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Auto Sqoff Method</label>
            <select className="adm-upd-input adm-upd-select" value={sqoffMethod} onChange={e => setSqoffMethod(e.target.value)}>
              <option>Credit</option><option>Debit</option><option>Net</option>
            </select>
          </div>
        </div>

        <div className="adm-upd-section-title" style={{ marginTop: 8 }}>Active Segments</div>
        <div className="adm-cu-segments-grid">
          {ALL_SEGMENTS.map(s => (
            <label className="adm-cu-seg-item" key={s}>
              <input type="checkbox" className="adm-cu-checkbox" checked={segments.includes(s)} onChange={() => toggleSeg(s)} />
              <span className="adm-cu-seg-label">{s}</span>
            </label>
          ))}
        </div>
      </div>

      <button className="adm-btn-primary" style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10 }} disabled={loading} onClick={handleSave}>
        {loading ? 'Saving…' : 'Save Profile Changes'}
      </button>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
