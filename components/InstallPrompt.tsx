'use client';
import React, { useState, useEffect } from 'react';
import { ErrorModal } from '@/components/ErrorModal';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [show, setShow] = useState(false);
  const [modalMessage, setModalMessage] = useState<string | null>(null);
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isIPad, setIsIPad] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Detect iOS and iPad specifically
    const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
    const ios = /iPad|iPhone|iPod/.test(userAgent) || 
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const ipad = /iPad/.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    
    setIsIOS(ios);
    setIsIPad(ipad);

    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    if (isStandalone) return;

    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // Listen for Chrome/Android native install prompt
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Auto-show prompt after 2 seconds if not dismissed
    const hasBeenDismissed = localStorage.getItem('pwa_prompt_dismissed') === 'true';
    if (!hasBeenDismissed) {
      const timer = setTimeout(() => setShow(true), 2500);
      return () => {
        window.removeEventListener('beforeinstallprompt', handler);
        clearTimeout(timer);
      };
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  useEffect(() => {
    const handleCustomTrigger = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          localStorage.setItem('pwa_prompt_dismissed', 'true');
          setDismissed(true);
          setShow(false);
        }
        setDeferredPrompt(null);
      } else if (isIOS) {
        setShowIosGuide(true);
      } else {
        setModalMessage("To install: tap the Share/Menu button in your browser and select 'Add to Home Screen'");
      }
    };
    window.addEventListener('triggerPwaInstall', handleCustomTrigger as EventListener);
    return () => window.removeEventListener('triggerPwaInstall', handleCustomTrigger as EventListener);
  }, [deferredPrompt, isIOS]);

  const handleInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        localStorage.setItem('pwa_prompt_dismissed', 'true');
        setDismissed(true);
      }
      setDeferredPrompt(null);
      setShow(false);
    } else if (isIOS) {
      setShowIosGuide(true);
      setShow(false);
    } else {
      setModalMessage("To install: tap the Share/Menu button in your browser and select 'Add to Home Screen'");
      setShow(false);
    }
  };

  const handleClosePrompt = () => {
    localStorage.setItem('pwa_prompt_dismissed', 'true');
    setShow(false);
    setDismissed(true);
  };

  if (dismissed) {
    if (showIosGuide) {
      return (
        <IosInstallGuideModal
          isIPad={isIPad}
          onClose={() => setShowIosGuide(false)}
        />
      );
    }
    return <ErrorModal error={modalMessage} onClose={() => setModalMessage(null)} title="Install Instructions" />;
  }

  if (!show) {
    if (showIosGuide) {
      return (
        <IosInstallGuideModal
          isIPad={isIPad}
          onClose={() => setShowIosGuide(false)}
        />
      );
    }
    return <ErrorModal error={modalMessage} onClose={() => setModalMessage(null)} title="Install Instructions" />;
  }

  return (
    <>
      <div
        style={{
          position: 'fixed',
          bottom: 'var(--prompt-bottom, 130px)',
          left: 'var(--prompt-left, 50%)',
          right: 'var(--prompt-right, auto)',
          transform: 'var(--prompt-transform, translateX(-50%))',
          width: 'calc(100% - 32px)',
          maxWidth: '440px',
          background: 'linear-gradient(135deg, #0d0d0d 0%, #161616 100%)',
          border: '1px solid rgba(74, 222, 128, 0.25)',
          borderRadius: '18px',
          padding: '14px 16px',
          zIndex: 9000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.05)',
          color: 'white',
          fontFamily: "'Inter', sans-serif",
          animation: 'slideUpPrompt 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <style>{`
          @keyframes slideUpPrompt {
            from { transform: var(--prompt-transform-start, translate(-50%, 30px)); opacity: 0; }
            to   { transform: var(--prompt-transform, translate(-50%, 0));     opacity: 1; }
          }
          :root {
            --prompt-bottom: 130px;
            --prompt-left: 50%;
            --prompt-right: auto;
            --prompt-transform: translateX(-50%);
            --prompt-transform-start: translate(-50%, 30px);
          }
          @media (min-width: 1024px) {
            :root {
              --prompt-bottom: 30px;
              --prompt-left: auto;
              --prompt-right: 30px;
              --prompt-transform: none;
              --prompt-transform-start: translateY(30px);
            }
          }
        `}</style>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
          <div
            style={{
              background: 'rgba(74, 222, 128, 0.15)',
              width: '42px',
              height: '42px',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <i className="fas fa-download" style={{ color: '#4ADE80', fontSize: '1.1rem' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.88rem', fontWeight: 700, lineHeight: 1.2 }}>
              Install Margin Apex
            </div>
            <div style={{ fontSize: '0.68rem', color: '#9CA3AF', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {isIOS ? 'Tap to get detailed iOS installation steps' : 'Add to your Home Screen'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          <button
            onClick={handleClosePrompt}
            style={{
              background: 'transparent',
              border: '1px solid #333',
              color: '#9CA3AF',
              padding: '8px 12px',
              borderRadius: '12px',
              fontSize: '0.75rem',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ✕
          </button>
          <button
            onClick={handleInstall}
            style={{
              background: 'linear-gradient(135deg, #10B981, #059669)',
              border: 'none',
              color: 'white',
              padding: '8px 16px',
              borderRadius: '12px',
              fontSize: '0.82rem',
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
            }}
          >
            {isIOS ? 'Guide' : 'Install'}
          </button>
        </div>
      </div>

      {showIosGuide && (
        <IosInstallGuideModal
          isIPad={isIPad}
          onClose={() => setShowIosGuide(false)}
        />
      )}

      {/* Floating Bouncing iOS Pointer Help Indicator */}
      {isIOS && !showIosGuide && (
        <div
          style={{
            position: 'fixed',
            bottom: isIPad ? 'auto' : '15px',
            top: isIPad ? '15px' : 'auto',
            left: isIPad ? 'auto' : '50%',
            right: isIPad ? '15px' : 'auto',
            transform: isIPad ? 'none' : 'translateX(-50%)',
            zIndex: 8999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            pointerEvents: 'none',
            animation: 'bounceIndicator 2s infinite',
          }}
        >
          <style>{`
            @keyframes bounceIndicator {
              0%, 20%, 50%, 80%, 100% {
                transform: ${isIPad ? 'translateY(0)' : 'translateX(-50%) translateY(0)'};
              }
              40% {
                transform: ${isIPad ? 'translateY(-10px)' : 'translateX(-50%) translateY(-10px)'};
              }
              60% {
                transform: ${isIPad ? 'translateY(-5px)' : 'translateX(-50%) translateY(-5px)'};
              }
            }
          `}</style>
          
          {!isIPad && (
            <>
              <div style={{
                background: 'rgba(16, 185, 129, 0.95)',
                color: 'white',
                padding: '6px 12px',
                borderRadius: '20px',
                fontSize: '0.75rem',
                fontWeight: 600,
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                marginBottom: '8px',
                border: '1px solid rgba(255,255,255,0.15)',
              }}>
                Install App: Tap the Share button below
              </div>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <polyline points="19 12 12 19 5 12"></polyline>
              </svg>
            </>
          )}
        </div>
      )}

      <ErrorModal error={modalMessage} onClose={() => setModalMessage(null)} title="Install Instructions" />
    </>
  );
}

interface IosInstallGuideModalProps {
  isIPad: boolean;
  onClose: () => void;
}

function IosInstallGuideModal({ isIPad, onClose }: IosInstallGuideModalProps) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        backdropFilter: 'blur(8px)',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div
        style={{
          background: '#0d0d0d',
          border: '1px solid rgba(74, 222, 128, 0.2)',
          borderRadius: '24px',
          padding: '24px',
          width: '100%',
          maxWidth: '380px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
          color: '#ffffff',
          animation: 'modalSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <style>{`
          @keyframes modalSlideUp {
            from { transform: translateY(40px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
        `}</style>

        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div style={{
            width: '56px',
            height: '56px',
            borderRadius: '16px',
            background: 'rgba(16, 185, 129, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 12px auto',
            border: '1px solid rgba(16, 185, 129, 0.25)'
          }}>
            <i className="fas fa-mobile-alt" style={{ color: '#10B981', fontSize: '1.6rem' }} />
          </div>
          <h3 style={{ margin: '0', fontSize: '1.25rem', fontWeight: 800 }}>Install Margin Apex</h3>
          <p style={{ margin: '6px 0 0 0', fontSize: '0.8rem', color: '#9CA3AF' }}>
            Follow these steps to run in fullscreen mode on iOS Safari:
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
          {/* Step 1 */}
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            <div style={{
              background: '#1F2937',
              color: '#10B981',
              borderRadius: '50%',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 700,
              flexShrink: 0,
              marginTop: '2px',
            }}>
              1
            </div>
            <div style={{ fontSize: '0.85rem', lineHeight: '1.4', color: '#E5E7EB' }}>
              Tap the <strong>Share</strong> button {isIPad ? 'at the top right' : 'in the browser menu at the bottom center'}.
              <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  background: 'rgba(255,255,255,0.06)',
                  padding: '6px 12px',
                  borderRadius: '10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  border: '1px solid rgba(255,255,255,0.08)'
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                  <span style={{ fontSize: '0.7rem', color: '#9CA3AF' }}>Safari Share</span>
                </div>
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            <div style={{
              background: '#1F2937',
              color: '#10B981',
              borderRadius: '50%',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 700,
              flexShrink: 0,
              marginTop: '2px',
            }}>
              2
            </div>
            <div style={{ fontSize: '0.85rem', lineHeight: '1.4', color: '#E5E7EB' }}>
              Scroll down the menu list and select <strong>Add to Home Screen</strong>.
              <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  background: 'rgba(255,255,255,0.06)',
                  padding: '6px 12px',
                  borderRadius: '10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  border: '1px solid rgba(255,255,255,0.08)'
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                  <span style={{ fontSize: '0.7rem', color: '#9CA3AF' }}>Add to Home Screen</span>
                </div>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            <div style={{
              background: '#1F2937',
              color: '#10B981',
              borderRadius: '50%',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 700,
              flexShrink: 0,
              marginTop: '2px',
            }}>
              3
            </div>
            <div style={{ fontSize: '0.85rem', lineHeight: '1.4', color: '#E5E7EB' }}>
              Tap <strong>Add</strong> in the top right corner of the sheet to complete setup.
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          style={{
            width: '100%',
            padding: '14px',
            background: 'linear-gradient(135deg, #10B981, #059669)',
            border: 'none',
            borderRadius: '14px',
            fontWeight: '700',
            fontSize: '0.9rem',
            color: 'white',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
