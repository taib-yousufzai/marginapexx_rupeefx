'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import '../page.css';
import './page.css';

interface ProfileData {
    client_id?: string;
    full_name: string; email: string; phone: string;
    role: string; segments: string[]; created_at: string;
    date_of_birth: string; city: string; state: string;
    pan_number: string; bank_name: string; account_no: string; ifsc: string;
}

type FormState = {
    full_name: string; phone: string; date_of_birth: string;
    city: string; state: string; pan_number: string;
    bank_name: string; account_no: string; ifsc: string;
};

const EMPTY: FormState = {
    full_name:'', phone:'', date_of_birth:'',
    city:'', state:'', pan_number:'',
    bank_name:'', account_no:'', ifsc:'',
};

// ── Defined OUTSIDE component so React doesn't remount on every render ──
interface RowProps {
    icon: string; label: string; fieldKey: keyof FormState;
    type?: string; placeholder?: string;
    editing: boolean; value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}
function FormRow({ icon, label, fieldKey, type='text', placeholder, editing, value, onChange }: RowProps) {
    return (
        <div className="pd-field">
            <div className="pd-field-label"><i className={`fas ${icon}`}></i> {label}</div>
            {editing ? (
                <input
                    className="pd-input"
                    type={type}
                    value={value}
                    onChange={onChange}
                    placeholder={placeholder ?? `Enter ${label.toLowerCase()}`}
                />
            ) : (
                <div className="pd-field-value">{value?.trim() || '—'}</div>
            )}
        </div>
    );
}

export default function ProfileDetailsPage() {
    useAuth();
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [saving,  setSaving]  = useState(false);
    const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [form, setForm] = useState<FormState>(EMPTY);

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
                const data = await api.get<ProfileData>('/api/user/profile');
                if (!cancelled) {
                    setProfile(data);
                    setForm({
                        full_name: data.full_name ?? '', phone: data.phone ?? '',
                        date_of_birth: data.date_of_birth ?? '', city: data.city ?? '',
                        state: data.state ?? '', pan_number: data.pan_number ?? '',
                        bank_name: data.bank_name ?? '', account_no: data.account_no ?? '', ifsc: data.ifsc ?? '',
                    });
                }
            } catch {}
            if (!cancelled) setLoading(false);
        })();
        return () => { cancelled = true; };
    }, []);

    const setField = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm(prev => ({ ...prev, [k]: e.target.value }));

    const handleSave = async () => {
        setSaving(true); setSaveMsg(null);
        try {
            await api.patch('/api/user/profile',
                Object.fromEntries(Object.entries(form).map(([k,v]) => [k, v.trim()]))
            );
            setProfile(prev => prev ? { ...prev, ...form } : prev);
            setSaveMsg({ type: 'success', text: 'Profile updated successfully!' });
            setEditing(false);
        } catch {
            setSaveMsg({ type: 'error', text: 'Failed to save. Please try again.' });
        } finally { setSaving(false); }
    };

    const cancelEdit = () => {
        setForm({
            full_name: profile?.full_name ?? '', phone: profile?.phone ?? '',
            date_of_birth: profile?.date_of_birth ?? '', city: profile?.city ?? '',
            state: profile?.state ?? '', pan_number: profile?.pan_number ?? '',
            bank_name: profile?.bank_name ?? '', account_no: profile?.account_no ?? '', ifsc: profile?.ifsc ?? '',
        });
        setSaveMsg(null); setEditing(false);
    };

    const email = profile?.email || '';
    const userId = profile?.client_id || '';
    // Hero always shows saved profile data, not live form state
    const savedName = profile?.full_name || (email ? email.split('@')[0].replace(/[._-]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) : '');
    const avatarLetter = (savedName || 'U').charAt(0).toUpperCase();
    const clientId = profile?.client_id || '—';

    const fmtDate = (iso: string) => {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    };

    const roleLabel: Record<string,string> = { super_admin:'Super Admin', admin:'Admin', broker:'Broker', user:'User' };

    return (
        <div className="desktop-layout">
                        <main className="main-viewport">
                <div className="pd-root">
            <div className="pd-header">
                <div className="pd-header-inner">
                    <Link href="/profile" className="pd-back-btn"><i className="fas fa-arrow-left"></i></Link>
                    <span className="pd-title">Profile Details</span>
                    {editing
                        ? <button className="pd-edit-btn cancel" onClick={cancelEdit}>Cancel</button>
                        : <button className="pd-edit-btn" onClick={() => { setSaveMsg(null); setEditing(true); }}><i className="fas fa-pen"></i> Edit</button>
                    }
                </div>
            </div>

            <div className="pd-content">
                {loading ? (
                    <div className="pd-loading"><div className="pd-spinner"></div><p>Loading profile…</p></div>
                ) : (
                    <>
                        {/* Hero */}
                        <div className="profile-hero">
                            <div className="avatar">{avatarLetter}</div>
                            <div className="profile-info">
                                <h2>{savedName || 'User'}</h2>
                                <span className="user-email">{email}</span>
                                <span className="user-id">Client ID: {clientId}</span>
                            </div>
                        </div>

                        {saveMsg && (
                            <div className={`pd-msg ${saveMsg.type}`}>
                                <i className={`fas ${saveMsg.type==='success'?'fa-check-circle':'fa-exclamation-circle'}`}></i>
                                {saveMsg.text}
                            </div>
                        )}

                        {/* Personal Information */}
                        <div className="pd-section">
                            <div className="pd-section-title">Personal Information</div>
                            <div className="pd-card">
                                <FormRow icon="fa-user"          label="Full Name"     fieldKey="full_name"     editing={editing} value={form.full_name}     onChange={setField('full_name')} />
                                <div className="pd-field">
                                    <div className="pd-field-label"><i className="fas fa-envelope"></i> Email Address</div>
                                    <div className="pd-field-value readonly">{email || '—'}</div>
                                </div>
                                <FormRow icon="fa-phone"         label="Phone Number"  fieldKey="phone"         editing={editing} value={form.phone}         onChange={setField('phone')}     type="tel" />
                                <FormRow icon="fa-birthday-cake" label="Date of Birth" fieldKey="date_of_birth" editing={editing} value={form.date_of_birth} onChange={setField('date_of_birth')} type="date" />
                                <FormRow icon="fa-city"          label="City"          fieldKey="city"          editing={editing} value={form.city}          onChange={setField('city')} />
                                <FormRow icon="fa-map"           label="State"         fieldKey="state"         editing={editing} value={form.state}         onChange={setField('state')} />
                            </div>
                        </div>

                        {/* Trading & KYC */}
                        <div className="pd-section">
                            <div className="pd-section-title">Trading & KYC</div>
                            <div className="pd-card">
                                <FormRow icon="fa-id-card" label="PAN Number" fieldKey="pan_number" editing={editing} value={form.pan_number} onChange={setField('pan_number')} placeholder="ABCDE1234F" />
                                <div className="pd-field">
                                    <div className="pd-field-label"><i className="fas fa-id-badge"></i> Account Type</div>
                                    <div className="pd-field-value">{roleLabel[profile?.role ?? ''] ?? '—'}</div>
                                </div>
                                <div className="pd-field">
                                    <div className="pd-field-label"><i className="fas fa-layer-group"></i> Trading Segments</div>
                                    <div className="pd-field-value">
                                        {profile?.segments?.length
                                            ? profile.segments.map(s => <span key={s} className="pd-segment-tag">{s}</span>)
                                            : '—'}
                                    </div>
                                </div>
                                <div className="pd-field">
                                    <div className="pd-field-label"><i className="fas fa-fingerprint"></i> Client ID</div>
                                    <div className="pd-field-value readonly">{clientId}</div>
                                </div>
                                <div className="pd-field">
                                    <div className="pd-field-label"><i className="fas fa-calendar-alt"></i> Member Since</div>
                                    <div className="pd-field-value readonly">{fmtDate(profile?.created_at ?? '')}</div>
                                </div>
                            </div>
                        </div>

                        {/* Bank Details */}
                        <div className="pd-section">
                            <div className="pd-section-title">Bank Details</div>
                            <div className="pd-card">
                                <FormRow icon="fa-university"  label="Bank Name"      fieldKey="bank_name"  editing={editing} value={form.bank_name}  onChange={setField('bank_name')}  placeholder="e.g. State Bank of India" />
                                <FormRow icon="fa-hashtag"     label="Account Number" fieldKey="account_no" editing={editing} value={form.account_no} onChange={setField('account_no')} placeholder="Enter account number" />
                                <FormRow icon="fa-code-branch" label="IFSC Code"      fieldKey="ifsc"       editing={editing} value={form.ifsc}       onChange={setField('ifsc')}       placeholder="e.g. SBIN0001234" />
                            </div>
                        </div>

                        {editing && (
                            <button className="pd-save-btn" onClick={handleSave} disabled={saving}>
                                {saving ? <span style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}><AnimatedLoader size="small" /> Saving…</span> : <><i className="fas fa-check"></i> Save Changes</>}
                            </button>
                        )}
                    </>
                )}
        </div>
      </div>
      </main>
    </div>
  );
}
