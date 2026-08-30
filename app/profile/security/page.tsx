'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useAuth } from '@/hooks/useAuth';
import { updatePassword, getSession } from '@/lib/auth';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';

export default function SecurityPage() {
    useAuth();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword,     setNewPassword]     = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showCurrent, setShowCurrent] = useState(false);
    const [showNew,     setShowNew]     = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [saving,  setSaving]  = useState(false);
    const [msg,     setMsg]     = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [email,   setEmail]   = useState('');
    const [lastSignIn, setLastSignIn] = useState('');

    useEffect(() => {
        const sync = () => applyTheme(getSavedTheme());
        sync();
        window.addEventListener('themeChanged', sync);
        return () => window.removeEventListener('themeChanged', sync);
    }, []);

    useEffect(() => {
        getSession().then(s => {
            if (!s) return;
            setEmail(s.user.email ?? '');
            setLastSignIn(s.user.last_sign_in_at ?? '');
        });
    }, []);

    const getStrength = (pwd: string) => {
        if (!pwd) return { score: 0, label: '', color: '' };
        let score = 0;
        if (pwd.length >= 8)  score++;
        if (pwd.length >= 12) score++;
        if (/[A-Z]/.test(pwd)) score++;
        if (/[0-9]/.test(pwd)) score++;
        if (/[^A-Za-z0-9]/.test(pwd)) score++;
        if (score <= 1) return { score, label: 'Weak',   color: '#DC2626' };
        if (score <= 3) return { score, label: 'Fair',   color: '#E67E22' };
        return              { score, label: 'Strong', color: '#16A34A' };
    };
    const strength = getStrength(newPassword);

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setMsg(null);
        if (!currentPassword || !newPassword || !confirmPassword) {
            setMsg({ type: 'error', text: 'Please fill in all fields.' }); return;
        }
        if (newPassword.length < 8) {
            setMsg({ type: 'error', text: 'Password must be at least 8 characters.' }); return;
        }
        if (newPassword !== confirmPassword) {
            setMsg({ type: 'error', text: 'Passwords do not match.' }); return;
        }
        setSaving(true);
        try {
            const s = await getSession();
            if (!s) throw new Error();
            const { supabase } = await import('@/lib/supabaseClient');
            const { error: signInErr } = await supabase.auth.signInWithPassword({ email: s.user.email ?? '', password: currentPassword });
            if (signInErr) { setMsg({ type: 'error', text: 'Current password is incorrect.' }); setSaving(false); return; }
            const result = await updatePassword(newPassword);
            if ('error' in result) setMsg({ type: 'error', text: result.error });
            else {
                setMsg({ type: 'success', text: 'Password updated successfully!' });
                setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
            }
        } catch {
            setMsg({ type: 'error', text: 'Something went wrong. Please try again.' });
        } finally { setSaving(false); }
    };

    const fmtDate = (iso: string) => {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    };

    return (
        <div className="desktop-layout">
                        <main className="main-viewport">
                <div className="sec-root">
            <div className="sec-header">
                <div className="sec-header-inner">
                    <Link href="/profile" className="sec-back-btn"><i className="fas fa-arrow-left"></i></Link>
                    <span className="sec-title">Security & Passwords</span>
                </div>
            </div>

            <div className="sec-content">
                {/* Account info */}
                <div className="sec-section">
                    <div className="sec-section-title">Account Security</div>
                    <div className="sec-card">
                        <div className="sec-info-row">
                            <div className="sec-info-icon" style={{background:'#EEF2F8',color:'#1E40AF'}}><i className="fas fa-envelope"></i></div>
                            <div className="sec-info-body">
                                <div className="sec-info-label">Email Address</div>
                                <div className="sec-info-value">{email || '—'}</div>
                            </div>
                            <div className="sec-verified-badge"><i className="fas fa-check-circle"></i> Verified</div>
                        </div>
                        <div className="sec-info-row">
                            <div className="sec-info-icon" style={{background:'#F0FDF4',color:'#16A34A'}}><i className="fas fa-clock"></i></div>
                            <div className="sec-info-body">
                                <div className="sec-info-label">Last Sign In</div>
                                <div className="sec-info-value">{fmtDate(lastSignIn)}</div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Change password */}
                <div className="sec-section">
                    <div className="sec-section-title">Change Password</div>
                    <div className="sec-card">
                        <form onSubmit={handleChangePassword} className="sec-form">
                            <div className="sec-field">
                                <label className="sec-label"><i className="fas fa-lock"></i> Current Password</label>
                                <div className="sec-input-wrap">
                                    <input type={showCurrent?'text':'password'} className="sec-input" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)} placeholder="Enter current password" autoComplete="current-password" />
                                    <button type="button" className="sec-eye-btn" onClick={()=>setShowCurrent(!showCurrent)} tabIndex={-1}><i className={`fas ${showCurrent?'fa-eye-slash':'fa-eye'}`}></i></button>
                                </div>
                            </div>
                            <div className="sec-field">
                                <label className="sec-label"><i className="fas fa-key"></i> New Password</label>
                                <div className="sec-input-wrap">
                                    <input type={showNew?'text':'password'} className="sec-input" value={newPassword} onChange={e=>setNewPassword(e.target.value)} placeholder="Enter new password" autoComplete="new-password" />
                                    <button type="button" className="sec-eye-btn" onClick={()=>setShowNew(!showNew)} tabIndex={-1}><i className={`fas ${showNew?'fa-eye-slash':'fa-eye'}`}></i></button>
                                </div>
                                {newPassword && (
                                    <div className="sec-strength">
                                        <div className="sec-strength-bar">
                                            {[1,2,3,4,5].map(i => <div key={i} className="sec-strength-seg" style={{background: i<=strength.score ? strength.color : '#E2E8F0'}} />)}
                                        </div>
                                        <span className="sec-strength-label" style={{color:strength.color}}>{strength.label}</span>
                                    </div>
                                )}
                            </div>
                            <div className="sec-field">
                                <label className="sec-label"><i className="fas fa-check-double"></i> Confirm New Password</label>
                                <div className="sec-input-wrap">
                                    <input type={showConfirm?'text':'password'} className="sec-input" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} placeholder="Confirm new password" autoComplete="new-password" />
                                    <button type="button" className="sec-eye-btn" onClick={()=>setShowConfirm(!showConfirm)} tabIndex={-1}><i className={`fas ${showConfirm?'fa-eye-slash':'fa-eye'}`}></i></button>
                                </div>
                                {confirmPassword && newPassword !== confirmPassword && <div className="sec-mismatch"><i className="fas fa-times-circle"></i> Passwords do not match</div>}
                                {confirmPassword && newPassword === confirmPassword && <div className="sec-match"><i className="fas fa-check-circle"></i> Passwords match</div>}
                            </div>
                            {msg && (
                                <div className={`sec-msg ${msg.type}`}>
                                    <i className={`fas ${msg.type==='success'?'fa-check-circle':'fa-exclamation-circle'}`}></i>
                                    {msg.text}
                                </div>
                            )}
                            <button type="submit" className="sec-save-btn" disabled={saving}>
                                {saving ? <span style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}><AnimatedLoader size="small" /> Updating…</span> : <><i className="fas fa-shield-alt"></i> Update Password</>}
                            </button>
                        </form>
                    </div>
                </div>

                {/* Tips */}
                <div className="sec-tips">
                    <div className="sec-tips-title"><i className="fas fa-lightbulb"></i> Password Tips</div>
                    <ul className="sec-tips-list">
                        <li>Use at least 8 characters</li>
                        <li>Mix uppercase, lowercase, numbers & symbols</li>
                        <li>Avoid using personal info like your name or birthday</li>
                        <li>Don't reuse passwords from other sites</li>
                    </ul>
                </div>
        </div>
      </div>
      </main>
    </div>
  );
}
