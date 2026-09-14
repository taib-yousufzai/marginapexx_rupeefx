'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';

export default function RulesPage() {
  const router = useRouter();
  const [theme, setTheme] = useState<'light' | 'dark' | 'black' | 'blue'>('light');

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

  const rules = [
    {
      title: "1. Trading Hours & Execution",
      icon: "fas fa-clock",
      content: [
        "Equity and derivative segments are active during standard exchange hours.",
        "System may automatically square off open positions 15 minutes before market close to avoid margin penalty.",
        "Scalper Mode requires auto-exit executions within 10-15 seconds. Ensure sufficient liquidity."
      ]
    },
    {
      title: "2. Margin & Leverage Policies",
      icon: "fas fa-chart-line",
      content: [
        "Intraday leverage is strictly controlled by your segment profile (e.g., 5x on select equities).",
        "If MTM loss exceeds 80% of your available margin, the risk system will trigger an auto-liquidation.",
        "Overnight holding requires 100% of the prescribed exchange margin. No leverage is permitted for delivery."
      ]
    },
    {
      title: "3. Order Types & Restrictions",
      icon: "fas fa-shield-alt",
      content: [
        "Market orders during high volatility (e.g., news events) are subject to slippage. Limit orders are recommended.",
        "Options trading is restricted to the strike range specified in your margin settings.",
        "Max lot sizes are enforced per order. Split large orders to comply with the Max Order Lot limits."
      ]
    },
    {
      title: "4. Scalper Mode Conditions",
      icon: "fas fa-bolt",
      content: [
        "Enabling Scalper Mode locks your account for 48 hours to prevent arbitrage abuse.",
        "A higher brokerage of ₹85/crore is applicable due to direct liquidity routing.",
        "Maximum order frequency is capped at 12 orders per minute."
      ]
    },
    {
      title: "5. Risk Management & Liability",
      icon: "fas fa-exclamation-triangle",
      content: [
        "All trades are executed at the trader's own risk. MarginApex is not liable for losses due to network latency.",
        "Stop-loss orders are mandatory for high-leverage positions.",
        "Any attempt to exploit latency or manipulate order buffers will result in immediate account suspension."
      ]
    }
  ];

  return (
    <div className={`desktop-layout ${theme}`}>
            <main className="main-viewport">
        <div className="app-container">
          <div className="compact-header">
            <div className="header-row-top">
              <button className="back-button" onClick={() => router.back()}>
                <i className="fas fa-arrow-left"></i>
              </button>
              <h1 className="header-title">Rules &amp; Regulations</h1>
            </div>
            <div className="header-row-bottom">
              <span className="instruction-label">Please review our trading policies</span>
            </div>
          </div>

          <div className="main-scroll-wrapper" style={{ paddingBottom: 'calc(var(--footer-nav-height, 65px) + 24px)' }}>
            <div className="rules-content">
              <div className="rules-intro">
                <i className="fas fa-info-circle"></i>
                <p>Welcome to MarginApex. By trading on this platform, you agree to adhere to the following risk management and execution guidelines.</p>
              </div>

              <div className="rules-grid">
                {rules.map((rule, idx) => (
                  <div key={idx} className="rule-card">
                    <div className="rule-card-header">
                      <div className="rule-icon"><i className={rule.icon}></i></div>
                      <h2 className="rule-title">{rule.title}</h2>
                    </div>
                    <ul className="rule-list">
                      {rule.content.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="rules-footer">
                <p>For more details on your specific limits, please visit your <span style={{ color: 'var(--footer-active, #1475e1)', cursor: 'pointer', fontWeight: 600 }} onClick={() => router.push('/margin-settings')}>Margin Settings</span>.</p>
              </div>
            </div>
          </div>
                  </div>
      </main>
    </div>
  );
}
