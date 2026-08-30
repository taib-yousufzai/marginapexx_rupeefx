'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import AnimatedLoader from '@/components/AnimatedLoader';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';

interface Notification {
    id: string;
    type: string;
    title: string;
    message: string;
    read: boolean;
    created_at: string;
}

// Icon + color per notification type
const TYPE_META: Record<string, { icon: string; color: string; bg: string }> = {
    ORDER_EXECUTED:          { icon: 'fa-check-circle',    color: '#2C8E5A', bg: '#F0FDF4' },
    ORDER_REJECTED:          { icon: 'fa-times-circle',    color: '#C62E2E', bg: '#FEF2F2' },
    ORDER_CANCELLED:         { icon: 'fa-ban',             color: '#6B7280', bg: '#F3F4F6' },
    POSITION_OPENED:         { icon: 'fa-chart-line',      color: '#2563EB', bg: '#EFF6FF' },
    POSITION_CLOSED:         { icon: 'fa-flag-checkered',  color: '#7C3AED', bg: '#F5F3FF' },
    DEPOSIT_APPROVED:        { icon: 'fa-wallet',          color: '#2C8E5A', bg: '#F0FDF4' },
    DEPOSIT_REJECTED:        { icon: 'fa-times-circle',    color: '#C62E2E', bg: '#FEF2F2' },
    WITHDRAWAL_APPROVED:     { icon: 'fa-university',      color: '#2C8E5A', bg: '#F0FDF4' },
    WITHDRAWAL_REJECTED:     { icon: 'fa-times-circle',    color: '#C62E2E', bg: '#FEF2F2' },
    ACCOUNT_SUSPENDED:       { icon: 'fa-lock',            color: '#C62E2E', bg: '#FEF2F2' },
    ACCOUNT_READONLY:        { icon: 'fa-eye',             color: '#D97706', bg: '#FFFBEB' },
    ACCOUNT_DELETE_SCHEDULED:{ icon: 'fa-trash-alt',       color: '#C62E2E', bg: '#FEF2F2' },
    TRADE_DISABLED:          { icon: 'fa-ban',             color: '#D97706', bg: '#FFFBEB' },
    GENERAL:                 { icon: 'fa-bell',            color: '#2563EB', bg: '#EFF6FF' },
};

function getMeta(type: string) {
    return TYPE_META[type] ?? TYPE_META.GENERAL;
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins < 1)   return 'Just now';
    if (mins < 60)  return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7)   return `${days}d ago`;
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

// ── Fake notifications for preview (auto-replaced when real ones arrive) ──
const FAKE_NOTIFICATIONS: Notification[] = [
    {
        id: 'fn2', type: 'DEPOSIT_APPROVED', read: false,
        created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
        title: 'Deposit Approved',
        message: '₹10,000 has been credited to your trading account.',
    },
    {
        id: 'fn5', type: 'WITHDRAWAL_APPROVED', read: true,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        title: 'Withdrawal Processed',
        message: '₹5,000 withdrawal has been sent to your registered bank account.',
    },
    {
        id: 'fn7', type: 'DEPOSIT_REJECTED', read: true,
        created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        title: 'Deposit Request Rejected',
        message: 'Your deposit request of ₹2,000 was rejected. Please contact support.',
    },
    {
        id: 'fn8', type: 'ACCOUNT_READONLY', read: true,
        created_at: new Date(Date.now() - 7 * 86400000).toISOString(),
        title: 'Account Set to Read-Only',
        message: 'Your account has been set to read-only mode by your broker. Trading is paused.',
    },
];

export default function NotificationsPage() {
    useAuth();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [loading, setLoading]   = useState(true);
    const [marking, setMarking]   = useState(false);
    const [isFake,  setIsFake]    = useState(false);

    useEffect(() => {
        const sync = () => applyTheme(getSavedTheme());
        sync();
        window.addEventListener('themeChanged', sync);
        return () => window.removeEventListener('themeChanged', sync);
    }, []);

    const fetchNotifications = useCallback(async () => {
        setLoading(true);
        try {
            const data = await api.get<{ notifications?: Notification[] }>('/api/notifications?limit=50');
            const real = data.notifications ?? [];
            if (real.length > 0) {
                setNotifications(real);
                setIsFake(false);
            } else {
                setNotifications(FAKE_NOTIFICATIONS);
                setIsFake(true);
            }
        } catch {
            setNotifications(FAKE_NOTIFICATIONS);
            setIsFake(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

    const markRead = async (id: string) => {
        // Optimistic update
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
        try {
            await api.patch(`/api/notifications/${id}`, {});
        } catch {}
    };

    const markAllRead = async () => {
        setMarking(true);
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        try {
            await api.patch('/api/notifications/all', {});
        } catch {} finally {
            setMarking(false);
        }
    };

    const unreadCount = isFake ? 0 : notifications.filter(n => !n.read).length;

    return (
        <div className="desktop-layout">
                        <main className="main-viewport">
                <div className="notif-root">
            {/* Header */}
            <div className="notif-header">
                <div className="notif-header-inner">
                    <Link href="/profile" className="notif-back-btn">
                        <i className="fas fa-arrow-left"></i>
                    </Link>
                    <span className="notif-title">
                        Notifications
                        {unreadCount > 0 && <span className="notif-count-badge">{unreadCount}</span>}
                    </span>
                    {unreadCount > 0 && (
                        <button className="notif-mark-all-btn" onClick={markAllRead} disabled={marking}>
                            {marking ? <span style={{ display: 'inline-flex', alignItems: 'center' }}><AnimatedLoader size="small" /></span> : 'Mark all read'}
                        </button>
                    )}
                </div>
            </div>

            <div className="notif-content">
                {loading ? (
                    <div className="notif-loading">
                        <div className="notif-spinner"></div>
                        <p>Loading notifications…</p>
                    </div>
                ) : notifications.length === 0 ? (
                    <div className="notif-empty">
                        <div className="notif-empty-icon">
                            <i className="fas fa-bell-slash"></i>
                        </div>
                        <div className="notif-empty-title">All caught up!</div>
                        <div className="notif-empty-sub">No notifications yet. We'll alert you about orders, funds, and account updates.</div>
                    </div>
                ) : (
                    <>
                        {isFake && (
                            <div className="notif-fake-banner">
                                <i className="fas fa-eye"></i>
                                Sample preview — your real notifications will appear here
                            </div>
                        )}
                        <div className={`notif-list${isFake ? ' notif-list-preview' : ''}`}>
                            {notifications.map(n => {
                                const meta = getMeta(n.type);
                                return (
                                    <div
                                        key={n.id}
                                        className={`notif-item${n.read ? '' : ' unread'}`}
                                        onClick={() => !isFake && !n.read && markRead(n.id)}
                                    >
                                        <div className="notif-icon" style={{ background: meta.bg, color: meta.color }}>
                                            <i className={`fas ${meta.icon}`}></i>
                                        </div>
                                        <div className="notif-body">
                                            <div className="notif-item-title">{n.title}</div>
                                            <div className="notif-item-msg">{n.message}</div>
                                            <div className="notif-item-time">{timeAgo(n.created_at)}</div>
                                        </div>
                                        {!isFake && !n.read && <div className="notif-dot"></div>}
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
        </div>
      </div>
      </main>
    </div>
  );
}
