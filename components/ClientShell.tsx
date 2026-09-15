'use client';

import React, { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import Footer from '@/components/Footer';
import AnimatedLoader from '@/components/AnimatedLoader';
import { ErrorModal } from '@/components/ErrorModal';

export default function ClientShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';

  const noShellRoutes = [
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/accept-invite',
    '/ourcalculation'
  ];
  
  const isNoShellRoute = noShellRoutes.includes(pathname) || pathname.startsWith('/admin');

  const activeTab = useMemo(() => {
    if (pathname.includes('/watchlist')) return 'watchlist';
    if (pathname.includes('/order')) return 'order';
    if (pathname.includes('/position')) return 'position';
    if (pathname.includes('/history')) return 'history';
    if (pathname.includes('/profile')) return 'profile';
    return 'home';
  }, [pathname]);

  const [isGlobalLoading, setIsGlobalLoading] = React.useState(false);
  const [loadingText, setLoadingText] = React.useState('Processing Order...');

  // ── Centralised order error modal ────────────────────────────────────
  // Single listener for the 'order_error' custom event fired by TradeSheet
  // (and any other order path). Replaces the per-page listeners in watchlist,
  // option-chain, and position pages — one modal, never duplicated.
  const [orderErrorMsg, setOrderErrorMsg] = React.useState<string | null>(null);

  // ── Global toast for async order errors ──────────────────────────────
  const [toastMsg, setToastMsg] = React.useState('');
  const [toastVisible, setToastVisible] = React.useState(false);

  React.useEffect(() => {
    if (!toastVisible) return;
    const timer = setTimeout(() => setToastVisible(false), 1000);
    return () => clearTimeout(timer);
  }, [toastVisible, toastMsg]);

  React.useEffect(() => {
    const onStart = (e: any) => {
      setLoadingText(e.detail || 'Processing Order...');
      setIsGlobalLoading(true);
    };
    const onEnd = () => setIsGlobalLoading(false);

    const onExitStart = (e: any) => {
      setLoadingText(e?.detail || 'Exiting Position...');
      setIsGlobalLoading(true);
    };
    const onExitEnd = () => setIsGlobalLoading(false);

    const onToast = (e: any) => {
      const msg = (e as CustomEvent).detail;
      if (!msg) return;
      setToastMsg(String(msg));
      setToastVisible(true);
    };

    const onOrderError = (e: Event) => {
      const msg = (e as CustomEvent).detail || 'Order failed.';
      const msgStr = String(msg);

      // In-flight background processing / timeout messages should never block the user with a modal
      if (
        msgStr.includes('processing in background') ||
        msgStr.includes('in progress')
      ) {
        setToastMsg(msgStr);
        setToastVisible(true);
        return;
      }

      setOrderErrorMsg(msgStr);
    };

    window.addEventListener('global-loader-start', onStart);
    window.addEventListener('global-loader-end', onEnd);
    window.addEventListener('exit-overlay-start', onExitStart);
    window.addEventListener('exit-overlay-end', onExitEnd);
    window.addEventListener('toast_msg', onToast);
    window.addEventListener('order_error', onOrderError);
    return () => {
      window.removeEventListener('global-loader-start', onStart);
      window.removeEventListener('global-loader-end', onEnd);
      window.removeEventListener('exit-overlay-start', onExitStart);
      window.removeEventListener('exit-overlay-end', onExitEnd);
      window.removeEventListener('toast_msg', onToast);
      window.removeEventListener('order_error', onOrderError);
    };
  }, []);

  if (isNoShellRoute) {
    return <>{children}</>;
  }

  return (
    <div className="desktop-layout">
      {isGlobalLoading && (
        <AnimatedLoader fullScreen={true} text={loadingText} />
      )}
      <Sidebar />
      <main className="main-viewport">
        <div className="app-container">
          {children}
        </div>
        <Footer activeTab={activeTab as any} />
      </main>

      {/* Global toast for async order failure messages */}
      <div
        className={`global-toast${toastVisible ? ' show' : ''}`}
        onClick={() => setToastVisible(false)}
        style={{
          position: 'fixed',
          bottom: 90,
          left: '50%',
          transform: `translateX(-50%) translateY(${toastVisible ? 0 : 20}px)`,
          background: '#2C313F',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          color: '#F8FAFC',
          padding: '10px 22px',
          borderRadius: 30,
          fontSize: '0.84rem',
          fontWeight: 600,
          zIndex: 200000,
          opacity: toastVisible ? 1 : 0,
          transition: 'opacity 0.3s, transform 0.3s',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          maxWidth: '90vw',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
          backdropFilter: 'blur(10px)',
        }}
      >
        {toastMsg}
      </div>

      {/* Centralised order error modal — single instance for the whole app */}
      <ErrorModal
        error={orderErrorMsg}
        onClose={() => setOrderErrorMsg(null)}
        title={
          orderErrorMsg?.includes('processing in background') ||
          orderErrorMsg?.includes('in progress')
            ? 'Order Processing'
            : 'Order Failed'
        }
      />
    </div>
  );
}
