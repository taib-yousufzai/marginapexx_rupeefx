'use client';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { signOut } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';
import { pageCache } from '@/lib/pageCache';
import AnimatedLoader from '@/components/AnimatedLoader';
import { api, ApiError } from '@/lib/api';
import { useBalance } from '@/hooks/useBalance';
import { getSavedTheme, applyTheme, Theme } from '@/lib/theme';
import './page.css';

export default function ProfilePage() {
    useAuth();
    const [isDemo, setIsDemo] = useState(false);
    const [themeName, setThemeName] = useState<Theme>('light');
    // Balance comes from the global BalanceDataProvider
    const { balance, loading: balanceLoading } = useBalance();
    const [unreadCount, setUnreadCount] = useState<number>(() => pageCache.get<number>('profile:unread') || 0);

    // Quick-edit modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [editName, setEditName] = useState('');
    const [editPhone, setEditPhone] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Profile data
    const [profileName, setProfileName] = useState<string>(() => pageCache.get<string>('profile:name') || '');
    const [profilePhone, setProfilePhone] = useState<string>(() => pageCache.get<string>('profile:phone') || '');
    const [profileClientId, setProfileClientId] = useState<string>(() => pageCache.get<string>('profile:client_id') || '');
    const [profileEmail, setProfileEmail] = useState<string>(() => pageCache.get<string>('profile:email') || '');

    const overlayRef = useRef<HTMLDivElement>(null);
    const [themeDropdownOpen, setThemeDropdownOpen] = useState(false);
    const themeDropdownRef = useRef<HTMLDivElement>(null);
    const [isStandalone, setIsStandalone] = useState(false);

    useEffect(() => {
        setIsStandalone(
            window.matchMedia('(display-mode: standalone)').matches ||
            (window.navigator as any).standalone === true
        );
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (cancelled) return;

            // Fetch profile data
            try {
                const data = await api.get<{
                    full_name?: string; phone?: string; client_id?: string; demo_user?: boolean; email?: string;
                }>('/api/user/profile');
                if (!cancelled) {
                    pageCache.set('profile:name', data.full_name ?? '');
                    pageCache.set('profile:phone', data.phone ?? '');
                    pageCache.set('profile:client_id', data.client_id ?? '');
                    pageCache.set('profile:email', data.email ?? '');
                    setProfileName(data.full_name ?? '');
                    setProfilePhone(data.phone ?? '');
                    setProfileClientId(data.client_id ?? '');
                    setProfileEmail(data.email ?? '');
                    setIsDemo(data.demo_user === true);
                }
            } catch {}

            // Fetch unread count
            try {
                const data = await api.get<{ unread_count?: number }>('/api/notifications?unread_only=true&limit=50');
                if (!cancelled) {
                    pageCache.set('profile:unread', data.unread_count ?? 0);
                    setUnreadCount(data.unread_count ?? 0);
                }
            } catch {}
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const sync = () => {
            setThemeName(getSavedTheme());
        };
        sync();
        window.addEventListener('themeChanged', sync);
        return () => window.removeEventListener('themeChanged', sync);
    }, []);

    useEffect(() => {
        if (modalOpen) document.body.style.overflow = 'hidden';
        else document.body.style.overflow = '';
        return () => { document.body.style.overflow = ''; };
    }, [modalOpen]);

    const openModal = () => {
        setEditName(profileName);
        setEditPhone(profilePhone);
        setSaveMsg(null);
        setModalOpen(true);
    };

    const closeModal = () => {
        setModalOpen(false);
        setSaveMsg(null);
    };

    const handleQuickSave = async () => {
        setSaving(true);
        setSaveMsg(null);
        try {
            await api.patch('/api/user/profile', { full_name: editName.trim(), phone: editPhone.trim() });
            setProfileName(editName.trim());
            setProfilePhone(editPhone.trim());
            setSaveMsg({ type: 'success', text: 'Saved!' });
            setTimeout(() => closeModal(), 900);
        } catch {
            setSaveMsg({ type: 'error', text: 'Failed to save. Try again.' });
        } finally {
            setSaving(false);
        }
    };

    const email = profileEmail;
    const clientId = profileClientId || '—';
    const displayName = profileName
        || (email ? email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'User');
    const formattedBalance = '₹' + balance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const setTheme = useCallback((newTheme: Theme) => {
        setThemeName(newTheme);
        applyTheme(newTheme);
        setThemeDropdownOpen(false);
    }, []);

    // Close theme dropdown on outside click
    useEffect(() => {
        if (!themeDropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (themeDropdownRef.current && !themeDropdownRef.current.contains(e.target as Node)) {
                setThemeDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [themeDropdownOpen]);

    return (
        <div className="desktop-layout">
            <main className="main-viewport">
                <div className="mobile-app profile-app">

                    {/* Header Gradient Area */}
                    <div className="profile-gradient-header" style={{ paddingTop: '24px' }}>
                        {/* Top Action Row */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                            <Link href="/" className="pg-back-btn">
                                <i className="fas fa-arrow-left"></i>
                            </Link>

                            <div style={{
                                backgroundColor: 'rgba(255,255,255,0.08)',
                                padding: '6px 14px',
                                borderRadius: '12px',
                                display: 'flex', alignItems: 'center', gap: '8px',
                                fontSize: '1rem', fontWeight: 700, color: '#FFFFFF',
                                border: '1px solid rgba(255,255,255,0.05)'
                            }}>
                                <i className="fas fa-fingerprint" style={{ color: '#94A3B8' }}></i> {clientId}
                            </div>
                        </div>

                        {/* User Details Row */}
                        <div className="pg-user-info" style={{ textAlign: 'left', display: 'block' }}>
                            <div className="pg-text-group">
                                <h1 style={{ fontSize: '1.4rem', marginBottom: '4px' }}>{displayName}</h1>
                                {profilePhone && <p style={{ justifyContent: 'flex-start', color: '#CBD5E1' }}><i className="fas fa-phone-alt" style={{ width: '16px' }}></i> {profilePhone}</p>}
                                <p style={{ justifyContent: 'flex-start', margin: 0, color: '#CBD5E1' }}><i className="fas fa-envelope" style={{ width: '16px' }}></i> {email}</p>
                            </div>
                        </div>
                    </div>

                    <div className="profile-main-content">
                        {/* Overlapping Margin Card */}
                        <div className="margin-overlap-card">
                            <div className="margin-text">
                                <span className="margin-label">Available Margin</span>
                                <span className="margin-amount">
                                    {balanceLoading ? <span style={{ opacity: 0.5, fontSize: '1.4rem' }}>Loading…</span> : formattedBalance}
                                </span>
                            </div>
                        </div>

                        {/* Horizontal Quick Actions Row */}
                        <div className="quick-actions-row">
                            {!isDemo && (
                                <>
                                    <Link href="/funds" className="quick-action-btn">
                                        <div className="qa-icon add"><i className="fas fa-plus"></i></div>
                                        <span className="qa-text">Add<br />Funds</span>
                                    </Link>
                                    <Link href="/funds?tab=withdraw" className="quick-action-btn">
                                        <div className="qa-icon withdraw"><i className="fas fa-arrow-down"></i></div>
                                        <span className="qa-text">Withdraw</span>
                                    </Link>
                                </>
                            )}
                            <Link href="/profile/reports" className="quick-action-btn">
                                <div className="qa-icon reports"><i className="fas fa-file-invoice"></i></div>
                                <span className="qa-text">Reports<br />&amp; P&amp;L</span>
                            </Link>
                            <Link href="/profile/security" className="quick-action-btn">
                                <div className="qa-icon security"><i className="fas fa-shield-alt"></i></div>
                                <span className="qa-text">Security</span>
                            </Link>
                        </div>

                        {/* Unified Settings List */}
                        <div className="unified-settings-card">
                            <Link href="/profile/details" className="us-item">
                                <div className="us-icon"><i className="fas fa-user-circle"></i></div>
                                <div className="us-text">Profile Details</div>
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </Link>

                            <div className="us-item theme-dropdown-wrapper" ref={themeDropdownRef} onClick={() => setThemeDropdownOpen(v => !v)}>
                                <div className="us-icon"><i className={`fas ${themeName !== 'light' ? 'fa-moon' : 'fa-sun'}`}></i></div>
                                <div className="us-text">Appearance</div>
                                <div className="theme-current">
                                    {themeName === 'blue' ? 'Blue' : themeName === 'black' ? 'Black' : themeName === 'dark' ? 'Dark' : 'Light'}
                                    <i className={`fas fa-chevron-down`} style={{ marginLeft: '4px', fontSize: '0.6rem', transition: '0.2s', transform: themeDropdownOpen ? 'rotate(180deg)' : 'none' }}></i>
                                </div>

                                {themeDropdownOpen && (
                                    <div className="theme-dropdown" onClick={e => e.stopPropagation()}>
                                        <button className={`theme-option ${themeName === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}>
                                            <i className="fas fa-sun" style={{ width: '18px' }}></i>
                                            <span>Light</span>
                                            {themeName === 'light' && <i className="fas fa-check theme-check"></i>}
                                        </button>
                                        <button className={`theme-option ${themeName === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}>
                                            <i className="fas fa-moon" style={{ width: '18px' }}></i>
                                            <span>Dark</span>
                                            {themeName === 'dark' && <i className="fas fa-check theme-check"></i>}
                                        </button>
                                        <button className={`theme-option ${themeName === 'black' ? 'active' : ''}`} onClick={() => setTheme('black')}>
                                            <i className="fas fa-circle" style={{ width: '18px' }}></i>
                                            <span>Black</span>
                                            {themeName === 'black' && <i className="fas fa-check theme-check"></i>}
                                        </button>
                                        <button className={`theme-option ${themeName === 'blue' ? 'active' : ''}`} onClick={() => setTheme('blue')}>
                                            <i className="fas fa-tint" style={{ width: '18px' }}></i>
                                            <span>Blue</span>
                                            {themeName === 'blue' && <i className="fas fa-check theme-check"></i>}
                                        </button>
                                    </div>
                                )}
                            </div>

                            <Link href="/profile/bank" className="us-item">
                                <div className="us-icon"><i className="fas fa-university"></i></div>
                                <div className="us-text">Bank Details</div>
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </Link>

                            <Link href="/profile/transactions" className="us-item">
                                <div className="us-icon"><i className="fas fa-history"></i></div>
                                <div className="us-text">Transaction History</div>
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </Link>

                            <Link href="/profile/refer" className="us-item">
                                <div className="us-icon"><i className="fas fa-gift"></i></div>
                                <div className="us-text">Refer &amp; Earn</div>
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </Link>

                            <Link href="/profile/rules" className="us-item">
                                <div className="us-icon"><i className="fas fa-book"></i></div>
                                <div className="us-text">Rules &amp; Guidelines</div>
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </Link>

                            <Link href="/profile/policies" className="us-item">
                                <div className="us-icon"><i className="fas fa-file-contract"></i></div>
                                <div className="us-text">Trading Policies</div>
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </Link>

                            <a href="https://wa.me/918796119115" target="_blank" rel="noopener noreferrer" className="us-item">
                                <div className="us-icon"><i className="fas fa-headset"></i></div>
                                <div className="us-text">Help &amp; Support</div>
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </a>

                            <Link href="/profile/notifications" className="us-item">
                                <div className="us-icon"><i className="fas fa-bell"></i></div>
                                <div className="us-text">Notifications</div>
                                {unreadCount > 0 && (
                                    <span style={{ background: '#DC2626', color: 'white', fontSize: '0.65rem', fontWeight: 800, padding: '2px 8px', borderRadius: '20px', marginRight: '4px' }}>
                                        {unreadCount > 99 ? '99+' : unreadCount}
                                    </span>
                                )}
                                <div className="us-caret"><i className="fas fa-chevron-right"></i></div>
                            </Link>

                            {isStandalone ? (
                                <div className="us-item" style={{ color: '#6B7280', cursor: 'default' }}>
                                    <div className="us-icon" style={{ color: '#6B7280' }}><i className="fas fa-check-circle"></i></div>
                                    <div className="us-text" style={{ color: '#6B7280' }}>App Installed</div>
                                    <div className="us-caret" style={{ color: '#E5E7EB' }}><i className="fas fa-check"></i></div>
                                </div>
                            ) : (
                                <div className="us-item" onClick={() => window.dispatchEvent(new Event('triggerPwaInstall'))} style={{ color: '#059669' }}>
                                    <div className="us-icon" style={{ color: '#059669' }}><i className="fas fa-download"></i></div>
                                    <div className="us-text" style={{ color: '#059669' }}>Install APK</div>
                                    <div className="us-caret" style={{ color: '#A7F3D0' }}><i className="fas fa-chevron-right"></i></div>
                                </div>
                            )}

                            <div className="us-item" onClick={() => signOut()} style={{ color: '#DC2626' }}>
                                <div className="us-icon" style={{ color: '#DC2626' }}><i className="fas fa-power-off"></i></div>
                                <div className="us-text" style={{ color: '#DC2626' }}>Logout</div>
                                <div className="us-caret" style={{ color: '#FECACA' }}><i className="fas fa-chevron-right"></i></div>
                            </div>
                        </div>

                    </div>



                    {/* Quick Edit Bottom Sheet */}
                    {modalOpen && (
                        <div className="qe-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) closeModal(); }}>
                            <div className="qe-sheet">
                                <div className="qe-handle"></div>
                                <div className="qe-header">
                                    <span className="qe-title">Quick Edit</span>
                                    <button className="qe-close" onClick={closeModal}><i className="fas fa-times"></i></button>
                                </div>
                                <div className="qe-body">
                                    <div className="qe-field">
                                        <label className="qe-label"><i className="fas fa-user"></i> Full Name</label>
                                        <input className="qe-input" type="text" value={editName} onChange={e => setEditName(e.target.value)} placeholder="Enter your full name" autoFocus />
                                    </div>
                                    <div className="qe-field">
                                        <label className="qe-label"><i className="fas fa-phone"></i> Phone Number</label>
                                        <input className="qe-input" type="tel" value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="Enter phone number" />
                                    </div>
                                    {saveMsg && (
                                        <div className={`qe-msg ${saveMsg.type}`}>
                                            <i className={`fas ${saveMsg.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}`}></i>
                                            {saveMsg.text}
                                        </div>
                                    )}
                                    <button className="qe-save-btn" onClick={handleQuickSave} disabled={saving}>
                                        {saving ? <span style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}><AnimatedLoader size="small" /> Saving…</span> : <><i className="fas fa-check"></i> Save Changes</>}
                                    </button>
                                    <Link href="/profile/details" className="qe-full-link" onClick={closeModal}>
                                        <i className="fas fa-id-card"></i> View full profile details
                                        <i className="fas fa-arrow-right"></i>
                                    </Link>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
