'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo);
  }

  private handleReset = () => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('marginApex_open_positions_persisted');
        localStorage.removeItem('marginApex_closed_positions_persisted');
        localStorage.removeItem('marginApex_optimistic_positions_persisted');
        localStorage.removeItem('marginApex_optimistic_removals_persisted');
        localStorage.removeItem('marginApex_history_cache_persisted');
        localStorage.removeItem('history_cache_v2');
        sessionStorage.removeItem('history_cache_v2');
        localStorage.removeItem('marginApex_optimistic_orders_persisted');
        (window as any).__closedPositionsCache = undefined;
        (window as any).__historyCache = undefined;
        (window as any).__lastPositionsMap = undefined;
      }
    } catch {}
    this.setState({ hasError: false, error: null });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-primary, #ffffff)',
          background: 'var(--bg-body, #121212)'
        }}>
          <div style={{
            background: 'var(--bg-card, #1A1F2C)',
            border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
            borderRadius: '16px',
            padding: '32px 24px',
            maxWidth: '480px',
            width: '100%',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px'
          }}>
            <div style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              background: 'rgba(239, 68, 68, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#EF4444',
              fontSize: '24px'
            }}>
              <i className="fas fa-exclamation-triangle" />
            </div>

            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
              Unable to display this view
            </h2>

            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #94A3B8)', margin: 0, lineHeight: 1.5 }}>
              An unexpected display issue occurred. You can retry rendering or clear your local cache to restore the page.
            </p>

            <div style={{ display: 'flex', gap: '12px', width: '100%', marginTop: '8px' }}>
              <button
                onClick={this.handleRetry}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text-primary, #ffffff)',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Retry
              </button>

              <button
                onClick={this.handleReset}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: '10px',
                  border: 'none',
                  background: '#10B981',
                  color: '#ffffff',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Reset &amp; Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
