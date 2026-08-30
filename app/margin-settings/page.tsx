'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';



interface SegmentSetting {
  id: string;
  segment: string;
  side: 'BUY' | 'SELL';
  trade_allowed: boolean;
  intraday_leverage: number;
  holding_leverage: number;
  strike_range: number;
  max_lot: number;
  max_order_lot: number;
  commission_type: string;
  commission_value: number;
  carry_commission_type: string;
  carry_commission_value: number;
  gtt_commission_type: string;
  gtt_commission_value: number;
  profit_hold_sec: number;
  loss_hold_sec: number;
  entry_buffer: number;
  exit_buffer: number;
}

export default function UnifiedSettingsPage() {
  useAuth();
  const router = useRouter();
  const [theme, setTheme] = useState<'light' | 'dark' | 'black' | 'blue'>('light');
  const [segments, setSegments] = useState<SegmentSetting[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<'normal' | 'scalper'>('normal');
  const [actualMode, setActualMode] = useState<'normal' | 'scalper'>('normal');
  const [modeLockedUntil, setModeLockedUntil] = useState<string | null>(null);
  const [isChoiceModalOpen, setIsChoiceModalOpen] = useState(false);
  const [isGoToScalperModalOpen, setIsGoToScalperModalOpen] = useState(false);
  const [isGoToNormalModalOpen, setIsGoToNormalModalOpen] = useState(false);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);

  const [isAlertModalOpen, setIsAlertModalOpen] = useState(false);
  const [alertModalContent, setAlertModalContent] = useState<{ title: string, bullets: string[] } | null>(null);

  const showAlert = (title: string, message: string) => {
    const lines = message.split('\n').filter(l => l.trim() !== '');
    setAlertModalContent({ title, bullets: lines });
    setIsAlertModalOpen(true);
  };

  useEffect(() => {
    const sync = () => {
      const saved = getSavedTheme();
      setTheme(saved);
      applyTheme(saved);
    };
    sync();
    window.addEventListener('themeChanged', sync);
    return () => window.removeEventListener('themeChanged', sync);
  }, []);

  // Fetch current user trading mode on mount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await api.get<{ trading_mode: 'normal' | 'scalper'; mode_locked_until: string | null }>('/api/user/trading-mode');
        if (!cancelled) {
          setActualMode(data.trading_mode);
          setActiveTab(data.trading_mode);
          setModeLockedUntil(data.mode_locked_until);
        }
      } catch (err) {
        if (!cancelled) console.error('Error fetching trading mode:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch segment settings whenever the viewed tab (activeTab) changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const data = await api.get<SegmentSetting[]>(`/api/user/segments?mode=${activeTab}`);
        if (!cancelled) {
          const sorted = (data || []).sort((a: SegmentSetting, b: SegmentSetting) => {
            const segCompare = a.segment.localeCompare(b.segment);
            if (segCompare !== 0) return segCompare;
            return a.side.localeCompare(b.side);
          });
          setSegments(sorted);
        }
      } catch (err) {
        if (!cancelled) console.error('Error fetching user segments:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const formatCommissionType = (type: string) => {
    if (!type) return 'Per Crore';
    return type
      .replace(/[_-]/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const handleChooseNormal = () => {
    setIsChoiceModalOpen(false);
    if (actualMode === 'scalper') {
      if (modeLockedUntil) {
        const lockedTime = new Date(modeLockedUntil).getTime();
        if (lockedTime > Date.now()) {
          const hours = ((lockedTime - Date.now()) / (1000 * 60 * 60)).toFixed(1);
          showAlert("Mode Locked", `Cannot switch back to Normal Mode yet. Scalper Mode is locked for another ${hours} hours (until ${new Date(modeLockedUntil).toLocaleString()}).`);
          return;
        }
      }
      setIsGoToNormalModalOpen(true);
    } else {
      showAlert("Notice", "You are already in Normal Mode.");
    }
  };

  const handleChooseScalper = () => {
    setIsChoiceModalOpen(false);
    if (actualMode === 'normal') {
      setIsGoToScalperModalOpen(true);
    } else {
      showAlert("Notice", "You are already in Scalper Mode. 48-hour lock is active.");
    }
  };

  const confirmScalperMode = async () => {
    setIsGoToScalperModalOpen(false);
    setLoading(true);
    try {
      const data = await api.post<{ trading_mode: string; mode_locked_until: string | null }>(
        '/api/user/trading-mode',
        { trading_mode: 'scalper' },
      );

      setActualMode('scalper');
      setActiveTab('scalper');
      setModeLockedUntil(data.mode_locked_until);
      showAlert("Scalper Mode Activated!", "Slightly Higher Brokerage\nLow Profit Hold Trade Time\nPerfect For Scalper");
    } catch (err: any) {
      const message = err instanceof ApiError
        ? (err.details as any)?.error ?? `API error ${err.status}`
        : err.message ?? "An unexpected error occurred";
      showAlert("Activation Failed", message);
    } finally {
      setLoading(false);
    }
  };

  const confirmNormalMode = async () => {
    setIsGoToNormalModalOpen(false);
    setLoading(true);
    try {
      await api.post<{ trading_mode: string; mode_locked_until: string | null }>(
        '/api/user/trading-mode',
        { trading_mode: 'normal' },
      );

      setActualMode('normal');
      setActiveTab('normal');
      setModeLockedUntil(null);
      showAlert("Normal Mode Activated!", "Slightly Low Brokerage\nHigher Profit Hold Trade Timer\nScalping Banned");
    } catch (err: any) {
      const message = err instanceof ApiError
        ? (err.details as any)?.error ?? `API error ${err.status}`
        : err.message ?? "An unexpected error occurred";
      showAlert("Switch Failed", message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`app-container ${theme}`}>

      {/* HEADER */}
      <div className="compact-header">
        <div className="header-row-top">
          <Link href="/" className="back-button">
            <i className="fas fa-arrow-left"></i>
          </Link>
          <div className="rectangle-toggle-group">
            <button
              className={`rect-toggle-btn ${activeTab === 'normal' ? 'active-toggle' : ''}`}
              onClick={() => setActiveTab('normal')}
            >
              Normal Mode {actualMode === 'normal' && <span style={{ color: '#10b981', marginLeft: '4px' }}>●</span>}
            </button>
            <button
              className={`rect-toggle-btn ${activeTab === 'scalper' ? 'active-toggle' : ''}`}
              onClick={() => setActiveTab('scalper')}
            >
              Scalper Mode {actualMode === 'scalper' && <span style={{ color: '#10b981', marginLeft: '4px' }}>●</span>}
            </button>
          </div>
        </div>
        <div className="header-row-bottom">
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#6B7280' }}>
            {actualMode === 'scalper' ? 'Scalper Mode Active' : 'Normal Mode Active'}
          </span>
          <div className="action-buttons-wrapper">
            <button className="select-mode-btn" onClick={() => setIsChoiceModalOpen(true)}>SELECT MODE →</button>
            <button className="rules-trigger-btn" onClick={() => setIsRulesModalOpen(true)}>RULES</button>
          </div>
        </div>
      </div>

      {/* CONTENT: NORMAL VIEW */}
      {activeTab === 'normal' && (
        <div className="margin-settings-content">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>Fetching your profile...</div>
          ) : segments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>No Segments Allowed.</div>
          ) : (
            <div className="segments-list">
              {segments.map((item) => {
                const isBuy = item.side.toUpperCase() === 'BUY';
                const isAllowed = item.trade_allowed;

                return (
                  <div key={item.id} className={`segment-premium-card ${isBuy ? 'side-buy' : 'side-sell'} ${!isAllowed ? 'trade-blocked' : ''}`}>
                    <div className="card-top-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h3 className="segment-label">{item.segment.toUpperCase()}</h3>
                        <span className={`badge-transaction ${isBuy ? 'buy' : 'sell'}`}>{item.side.toUpperCase()}</span>
                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="section-title-faint">LEVERAGE & RISK LIMITS</div>
                      <div className="segment-details-grid">
                        <div className="detail-item"><span className="detail-label">Intraday Leverage</span><span className="detail-value">{item.intraday_leverage}</span></div>
                        <div className="detail-item"><span className="detail-label">Holding Leverage</span><span className="detail-value">{item.holding_leverage}</span></div>
                        <div className="detail-item"><span className="detail-label">Max Lot</span><span className="detail-value">{item.max_lot}</span></div>
                        <div className="detail-item"><span className="detail-label">Max Order Lot</span><span className="detail-value">{item.max_order_lot}</span></div>
                        <div className="detail-item"><span className="detail-label">Strike Range</span><span className="detail-value">{item.strike_range || '0'}</span></div>
                        <div className="detail-item">
                          <span className="detail-label">GTT Comm. {item.gtt_commission_type ? formatCommissionType(item.gtt_commission_type) : ''}</span>
                          <span className="detail-value">{item.gtt_commission_value != null ? item.gtt_commission_value : '—'}</span>
                        </div>

                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="section-title-faint">TRADING & COMMISSIONS</div>
                      <div className="segment-details-grid">
                        <div className="detail-item">
                          <span className="detail-label">Intraday Commission Type</span>
                          <span className="detail-value">{formatCommissionType(item.commission_type)}</span>
                        </div>
                        <div className="detail-item">
                          <span className="detail-label">Intraday Commission Value</span>
                          <span className="detail-value">{item.commission_value}</span>
                        </div>
                        <div className="detail-item">
                          <span className="detail-label">Carry Commission Type</span>
                          <span className="detail-value">{item.carry_commission_type ? formatCommissionType(item.carry_commission_type) : '—'}</span>
                        </div>
                        <div className="detail-item">
                          <span className="detail-label">Carry Commission Value</span>
                          <span className="detail-value">{item.carry_commission_value != null ? item.carry_commission_value : '—'}</span>
                        </div>
                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="section-title-faint">SYSTEM RISK TIMERS</div>
                      <div className="segment-details-grid">
                        <div className="detail-item"><span className="detail-label">Min Hold Profit</span><span className="detail-value">{item.profit_hold_sec ? `${item.profit_hold_sec}s` : 'None'}</span></div>
                        <div className="detail-item"><span className="detail-label">Min Hold Loss</span><span className="detail-value">{item.loss_hold_sec ? `${item.loss_hold_sec}s` : 'None'}</span></div>
                      </div>
                    </div>

                    {!isAllowed && (
                      <div className="blocked-overlay">
                        <div className="blocked-content">
                          <span>Trading Blocked by Admin</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* CONTENT: SCALPER VIEW */}
      {activeTab === 'scalper' && (
        <div className="margin-settings-content">
          <div className="scalper-intro">
            <p>Scalper Mode is active. High-frequency execution parameter safeguards are being applied directly from the liquidity node.</p>
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>Fetching your profile...</div>
          ) : segments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>No Segments Allowed.</div>
          ) : (
            <div className="segments-list">
              {segments.map((item) => {
                const isBuy = item.side.toUpperCase() === 'BUY';
                const isAllowed = item.trade_allowed;

                return (
                  <div key={item.id} className={`segment-premium-card ${isBuy ? 'side-buy' : 'side-sell'} ${!isAllowed ? 'trade-blocked' : ''}`}>
                    <div className="card-top-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h3 className="segment-label">{item.segment.toUpperCase()}</h3>
                        <span className={`badge-transaction ${isBuy ? 'buy' : 'sell'}`}>{item.side.toUpperCase()}</span>
                      </div>
                      <span className="scalper-card-active-badge">ACTIVE</span>
                    </div>

                    <div className="settings-section">
                      <div className="section-title-faint">LEVERAGE & RISK LIMITS</div>
                      <div className="segment-details-grid">
                        <div className="detail-item"><span className="detail-label">Intraday Leverage</span><span className="detail-value">{item.intraday_leverage}</span></div>
                        <div className="detail-item"><span className="detail-label">Holding Leverage</span><span className="detail-value">{item.holding_leverage}</span></div>
                        <div className="detail-item"><span className="detail-label">Max Lot</span><span className="detail-value">{item.max_lot}</span></div>
                        <div className="detail-item"><span className="detail-label">Max Order Lot</span><span className="detail-value">{item.max_order_lot}</span></div>
                        <div className="detail-item"><span className="detail-label">Strike Range</span><span className="detail-value">{item.strike_range || '0'}</span></div>
                        <div className="detail-item">
                          <span className="detail-label">GTT Comm. {item.gtt_commission_type ? formatCommissionType(item.gtt_commission_type) : ''}</span>
                          <span className="detail-value">{item.gtt_commission_value != null ? item.gtt_commission_value : '—'}</span>
                        </div>

                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="section-title-faint">TRADING & COMMISSIONS</div>
                      <div className="segment-details-grid">
                        <div className="detail-item">
                          <span className="detail-label">Intraday Commission Type</span>
                          <span className="detail-value">{formatCommissionType(item.commission_type)}</span>
                        </div>
                        <div className="detail-item">
                          <span className="detail-label">Intraday Commission Value</span>
                          <span className="detail-value">{item.commission_value}</span>
                        </div>
                        <div className="detail-item">
                          <span className="detail-label">Carry Commission Type</span>
                          <span className="detail-value">{item.carry_commission_type ? formatCommissionType(item.carry_commission_type) : '—'}</span>
                        </div>
                        <div className="detail-item">
                          <span className="detail-label">Carry Commission Value</span>
                          <span className="detail-value">{item.carry_commission_value != null ? item.carry_commission_value : '—'}</span>
                        </div>
                      </div>
                    </div>

                    <div className="settings-section">
                      <div className="section-title-faint">SYSTEM RISK TIMERS</div>
                      <div className="segment-details-grid">
                        <div className="detail-item"><span className="detail-label">Min Hold Profit</span><span className="detail-value">{item.profit_hold_sec ? `${item.profit_hold_sec}s` : 'None'}</span></div>
                        <div className="detail-item"><span className="detail-label">Min Hold Loss</span><span className="detail-value">{item.loss_hold_sec ? `${item.loss_hold_sec}s` : 'None'}</span></div>
                      </div>
                    </div>

                    {!isAllowed && (
                      <div className="blocked-overlay">
                        <div className="blocked-content">
                          <span>Trading Blocked by Admin</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MODALS */}
      {/* 1. Select Mode Choice Modal */}
      <div className={`scalper-modal-overlay ${isChoiceModalOpen ? 'active' : ''}`} onClick={() => setIsChoiceModalOpen(false)}>
        <div className="scalper-modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3 className="modal-title">Select Trading Mode</h3>
            <button className="modal-close-x" onClick={() => setIsChoiceModalOpen(false)}>✕</button>
          </div>
          <div className="modal-body">
            <p className="modal-intro-text">Choose your preferred trading mode. <strong>Once selected, you cannot switch for 48 hours.</strong></p>

            <div className="mode-option-card" onClick={handleChooseNormal}>
              <div className="mode-option-title">Normal Mode</div>
              <ul className="mode-feature-list">
                <li>Slightly Low Brokerage</li>
                <li>Higher Profit Hold Trade Timer</li>
                <li>Scalping Banned</li>
              </ul>
            </div>

            <div className="mode-option-card" onClick={handleChooseScalper}>
              <div className="mode-option-title">Scalper Mode</div>
              <ul className="mode-feature-list">
                <li>Slightly Higher Brokerage</li>
                <li>Low Profit Hold Trade Time</li>
                <li>Perfect For Scalper</li>
              </ul>
            </div>

            <div className="warning-48h">
              <strong>Important:</strong> Once you select a mode, you cannot change it for 48 hours. Please choose carefully based on your trading strategy.
            </div>
          </div>
          <div className="modal-footer">
            <button className="modal-btn cancel" onClick={() => setIsChoiceModalOpen(false)}>Cancel</button>
          </div>
        </div>
      </div>

      {/* 2. Go to Scalper Modal */}
      <div className={`scalper-modal-overlay ${isGoToScalperModalOpen ? 'active' : ''}`} onClick={() => setIsGoToScalperModalOpen(false)}>
        <div className="scalper-modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3 className="modal-title">Scalper Settings Risk Disclosure</h3>
            <button className="modal-close-x" onClick={() => setIsGoToScalperModalOpen(false)}>✕</button>
          </div>
          <div className="modal-body">
            <p className="modal-intro-text">Please review and accept the following conditions to activate high-frequency Scalper Settings on your profile:</p>
            <div className="conditions-list">
              <div className="condition-item"><span className="condition-num">1</span><div className="condition-desc"><p>Read trading rules before trading.</p></div></div>
              <div className="condition-item"><span className="condition-num">2</span><div className="condition-desc"><p>Scalping includes quick trade actions.</p></div></div>
              <div className="condition-item"><span className="condition-num">3</span><div className="condition-desc"><p>Switching to scalper mode will not be chargeable for 48 hours, check the settings of scalper mode thoroughly before switching.</p></div></div>
              <div className="condition-item"><span className="condition-num">4</span><div className="condition-desc"><p>Trade with proper risk management and trade wisely.</p></div></div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="modal-btn cancel" onClick={() => setIsGoToScalperModalOpen(false)}>Cancel</button>
            <button className="modal-btn confirm" onClick={confirmScalperMode}>I Understand & Confirm</button>
          </div>
        </div>
      </div>

      {/* 3. Go to Normal Modal */}
      <div className={`scalper-modal-overlay ${isGoToNormalModalOpen ? 'active' : ''}`} onClick={() => setIsGoToNormalModalOpen(false)}>
        <div className="scalper-modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3 className="modal-title">Return to Standard Settings</h3>
            <button className="modal-close-x" onClick={() => setIsGoToNormalModalOpen(false)}>✕</button>
          </div>
          <div className="modal-body">
            <p className="modal-intro-text">Please confirm if you want to deactivate high-frequency Scalper Mode and switch your active trading profile parameters back to normal:</p>
            <div className="conditions-list">
              <div className="condition-item"><span className="condition-num">1</span><div className="condition-desc"><strong>Standard Risk Control Settings</strong><p>Trading leverages, Strike Range rules, and Max Order Lot ceilings will return to the system administrator's original configurations.</p></div></div>
              <div className="condition-item"><span className="condition-num">2</span><div className="condition-desc"><strong>Standard Routing Gateway</strong><p>Deactivates direct liquidity-node gateways. Orders will be routed using standard execution buffers.</p></div></div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="modal-btn cancel" onClick={() => setIsGoToNormalModalOpen(false)}>Cancel</button>
            <button className="modal-btn confirm" onClick={confirmNormalMode}>Confirm & Proceed</button>
          </div>
        </div>
      </div>

      {/* 4. Trading Rules Modal */}
      <div className={`scalper-modal-overlay ${isRulesModalOpen ? 'active' : ''}`} onClick={() => setIsRulesModalOpen(false)}>
        <div className="scalper-modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3 className="modal-title">Trading Rules, Fair Usage Policy & Code of Conduct</h3>
            <button className="modal-close-x" onClick={() => setIsRulesModalOpen(false)}>✕</button>
          </div>
          <div className="modal-body">
            <p className="modal-intro-text">Official trading guidelines for both Margin and Scalper modes:</p>
            <div className="conditions-list" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <div className="condition-item">
                <span className="condition-num">1</span>
                <div className="condition-desc">
                  <strong>Chamka Trading is strictly prohibited.</strong>
                  <p>Any artificial, manipulative, collusive, circular, non-genuine, or platform-exploiting trading activity intended to generate unfair gains, rankings, rewards, incentives, rebates, referrals, competition results, or account performance is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">2</span>
                <div className="condition-desc">
                  <strong>Maximum Position Holding Period</strong>
                  <p>No position may be carried forward for more than three (3) trading days. Users wishing to continue a market view must close the existing position and initiate a new position.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">3</span>
                <div className="condition-desc">
                  <strong>High-Frequency Trading (HFT) Prohibited</strong>
                  <p>High-frequency trading, excessive order placement, rapid-fire trading, algorithmic trading, latency exploitation, quote stuffing, excessive scalping, or similar behavior is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">4</span>
                <div className="condition-desc">
                  <strong>Minimum Trade Interval</strong>
                  <p>A minimum gap of two (2) minutes must be maintained between consecutive trades.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">5</span>
                <div className="condition-desc">
                  <strong>Artificial Volume Generation Prohibited</strong>
                  <p>Users may not place trades solely to generate turnover, activity, rankings, incentives, rewards, or competition points.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">6</span>
                <div className="condition-desc">
                  <strong>Excessive Churning Prohibited</strong>
                  <p>Repeated entry and exit of positions without genuine market rationale may be treated as abusive trading activity.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">7</span>
                <div className="condition-desc">
                  <strong>Platform Exploitation Prohibited</strong>
                  <p>Users may not exploit pricing errors, technical glitches, delayed feeds, software bugs, calculation anomalies, latency differences, system vulnerabilities, or unintended platform behavior.</p>
                </div>
              </div>
              <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '0.95rem', color: 'inherit' }}>Options Trading Rules</h4>
              <div className="condition-item">
                <span className="condition-num">8</span>
                <div className="condition-desc">
                  <strong>Expiry-Hour Option Selling Restriction</strong>
                  <p>Option selling during the final hours before expiry for the primary purpose of capturing accelerated time decay is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">9</span>
                <div className="condition-desc">
                  <strong>Commodity Option Concentration Restriction</strong>
                  <p>Users may not trade exclusively in commodity options.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">10</span>
                <div className="condition-desc">
                  <strong>Stock Option Concentration Restriction</strong>
                  <p>Users may not trade exclusively in stock options.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">11</span>
                <div className="condition-desc">
                  <strong>Mandatory Index Participation</strong>
                  <p>At least fifty percent (50%) of options exposure, volume, or activity must involve index options as determined by the Platform.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">12</span>
                <div className="condition-desc">
                  <strong>Momentum Exploitation Restriction</strong>
                  <p>Simultaneous purchase of both Call (CE) and Put (PE) contracts on the same instrument for volatility capture, event-based exploitation, momentum extraction, or platform gaming may be restricted or prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">13</span>
                <div className="condition-desc">
                  <strong>Expiry Manipulation Prohibited</strong>
                  <p>Trading strategies designed solely to exploit expiry-related pricing distortions, settlement mechanics, or platform calculations may be disallowed.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">14</span>
                <div className="condition-desc">
                  <strong>Risk-Free Structure Prohibited</strong>
                  <p>Trading structures designed primarily to create near risk-free outcomes, artificial hedges, or guaranteed ranking advantages may be restricted.</p>
                </div>
              </div>
              <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '0.95rem', color: 'inherit' }}>Account Usage Rules</h4>
              <div className="condition-item">
                <span className="condition-num">15</span>
                <div className="condition-desc">
                  <strong>One User, One Primary Account</strong>
                  <p>Each account must be used solely by its registered owner.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">16</span>
                <div className="condition-desc">
                  <strong>Account Handling Prohibited</strong>
                  <p>No user may permit another person to operate, manage, monitor, control, advise, or execute trades on their behalf.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">17</span>
                <div className="condition-desc">
                  <strong>Shared Access Prohibited</strong>
                  <p>Sharing passwords, login credentials, devices, sessions, authentication codes, or account access with another person is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">18</span>
                <div className="condition-desc">
                  <strong>Multiple Account Abuse Prohibited</strong>
                  <p>Users may not create, control, operate, benefit from, or participate through multiple accounts to gain an unfair advantage.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">19</span>
                <div className="condition-desc">
                  <strong>Linked Account Monitoring</strong>
                  <p>The Platform may identify and link accounts through common devices, IP addresses, payment methods, behavioral patterns, contact details, referral relationships, or other indicators.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">20</span>
                <div className="condition-desc">
                  <strong>Opposite Position Trading Prohibited</strong>
                  <p>Taking buy positions in one account and corresponding sell positions in another account for hedging, risk transfer, ranking manipulation, or coordinated benefit is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">21</span>
                <div className="condition-desc">
                  <strong>Account Leasing or Sale Prohibited</strong>
                  <p>Buying, selling, renting, transferring, gifting, or leasing accounts is prohibited.</p>
                </div>
              </div>
              <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '0.95rem', color: 'inherit' }}>Coordination &amp; Market Conduct Rules</h4>
              <div className="condition-item">
                <span className="condition-num">22</span>
                <div className="condition-desc">
                  <strong>Group Trading Prohibited</strong>
                  <p>Coordinated trading among friends, groups, communities, trading clubs, syndicates, organizations, or teams is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">23</span>
                <div className="condition-desc">
                  <strong>Signal-Based Manipulation Prohibited</strong>
                  <p>Coordinated signal sharing intended to influence competitions, rankings, rewards, or platform outcomes is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">24</span>
                <div className="condition-desc">
                  <strong>Operator Calls Prohibited</strong>
                  <p>Trading solely based on operator calls, manipulated tips, guaranteed-return schemes, pump-and-dump activity, or coordinated instructions is prohibited.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">25</span>
                <div className="condition-desc">
                  <strong>Collusion Prohibited</strong>
                  <p>Any arrangement between users intended to create unfair outcomes, transfer performance, evade rules, or manipulate results is prohibited.</p>
                </div>
              </div>
              <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '0.95rem', color: 'inherit' }}>Payments &amp; Verification</h4>
              <div className="condition-item">
                <span className="condition-num">26</span>
                <div className="condition-desc">
                  <strong>Same-Person Funding Requirement</strong>
                  <p>Deposits, subscriptions, payments, and account funding must originate from the same individual whose details are registered on the account.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">27</span>
                <div className="condition-desc">
                  <strong>Identity Verification</strong>
                  <p>The Platform may request identity, address, payment, banking, or ownership verification at any time.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">28</span>
                <div className="condition-desc">
                  <strong>Source Verification</strong>
                  <p>The Platform reserves the right to investigate payment sources, funding methods, and account ownership where suspicious activity is detected.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">29</span>
                <div className="condition-desc">
                  <strong>Verification Failure</strong>
                  <p>Failure to provide requested verification information may result in restrictions, suspension, or account termination.</p>
                </div>
              </div>
              <h4 style={{ marginTop: '16px', marginBottom: '8px', fontSize: '0.95rem', color: 'inherit' }}>Platform Authority &amp; Enforcement</h4>
              <div className="condition-item">
                <span className="condition-num">30</span>
                <div className="condition-desc">
                  <strong>Monitoring Rights</strong>
                  <p>The Platform may monitor, record, review, analyze, audit, and investigate any account, trade, communication, payment, login activity, or user behavior for compliance purposes.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">31</span>
                <div className="condition-desc">
                  <strong>Suspicious Activity Review</strong>
                  <p>The Platform may investigate unusual profitability, abnormal consistency, coordinated behavior, suspicious trading patterns, excessive returns, or activity inconsistent with normal educational trading.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">32</span>
                <div className="condition-desc">
                  <strong>Trade Cancellation Rights</strong>
                  <p>The Platform may cancel, modify, reverse, settle, reject, or adjust trades that violate these rules or are suspected of violating these rules.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">33</span>
                <div className="condition-desc">
                  <strong>Profit Adjustment Rights</strong>
                  <p>The Platform may remove, reduce, freeze, withhold, adjust, or invalidate profits, rankings, rewards, incentives, points, achievements, or competition results obtained through prohibited activity.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">34</span>
                <div className="condition-desc">
                  <strong>Competition Protection</strong>
                  <p>The Platform reserves the right to disqualify users from contests, leaderboards, rankings, rewards, incentives, and promotional programs where suspicious activity is identified.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">35</span>
                <div className="condition-desc">
                  <strong>Rule Circumvention Prohibited</strong>
                  <p>Any attempt to circumvent the intent or spirit of these rules shall be treated as a violation, even if the specific conduct is not expressly listed.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">36</span>
                <div className="condition-desc">
                  <strong>Discretionary Enforcement</strong>
                  <p>The Platform reserves the right to take corrective action whenever it reasonably believes user activity may compromise fairness, integrity, security, educational objectives, or user experience.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">37</span>
                <div className="condition-desc">
                  <strong>No Obligation to Provide Prior Notice</strong>
                  <p>Corrective actions may be taken with or without prior notice where the Platform considers immediate action necessary.</p>
                </div>
              </div>
              <div className="condition-item">
                <span className="condition-num">38</span>
                <div className="condition-desc">
                  <strong>Final Authority</strong>
                  <p>The interpretation, application, and enforcement of these Trading Rules shall remain solely with the Platform, and all decisions made by the Platform shall be final, binding, and conclusive.</p>
                </div>
              </div>
              <p style={{ marginBottom: '12px', fontSize: '0.9rem', lineHeight: '1.5' }}><strong>The Platform reserves the right to investigate and act against any activity that, in its sole judgment, violates the spirit of fair participation, even if such activity is not specifically listed in these rules.</strong></p>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Custom Alert / Success Modal (Professional Minimal) */}
      <div className={`scalper-modal-overlay ${isAlertModalOpen ? 'active' : ''}`} onClick={() => setIsAlertModalOpen(false)}>
        <div className="scalper-modal-card" onClick={e => e.stopPropagation()} style={{ padding: 0, borderRadius: '16px', overflow: 'hidden', maxWidth: '340px' }}>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #f1f5f9' }}>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
              {alertModalContent?.title || 'Notice'}
            </h3>
            <button onClick={() => setIsAlertModalOpen(false)} style={{ background: 'none', border: 'none', fontSize: '1.2rem', color: '#94a3b8', cursor: 'pointer', padding: '0 4px' }}>✕</button>
          </div>

          <div style={{ padding: '24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {alertModalContent?.bullets.map((bullet, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{
                    minWidth: '20px', height: '20px', background: '#22c55e', borderRadius: '6px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white',
                    fontSize: '0.75rem', marginTop: '1px'
                  }}>
                    <i className="fas fa-check"></i>
                  </div>
                  <div style={{ color: '#334155', fontSize: '0.95rem', fontWeight: 500, lineHeight: '1.4' }}>
                    {bullet.replace('• ', '')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ padding: '0 24px 24px 24px' }}>
            <button onClick={() => setIsAlertModalOpen(false)} style={{
              width: '100%', padding: '14px', background: '#0f172a', color: 'white',
              border: 'none', borderRadius: '10px', fontSize: '0.95rem', fontWeight: 600,
              cursor: 'pointer'
            }}>
              OK
            </button>
          </div>

        </div>
      </div>

    </div>
  );
}
