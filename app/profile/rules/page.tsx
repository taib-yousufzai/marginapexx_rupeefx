'use client';
import React, { useEffect } from 'react';
import Link from 'next/link';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import '../security/page.css'; // Re-use the security page styling for consistency

export default function RulesPage() {
    useEffect(() => {
        const sync = () => applyTheme(getSavedTheme());
        sync();
        window.addEventListener('themeChanged', sync);
        return () => window.removeEventListener('themeChanged', sync);
    }, []);

    return (
        <div className="desktop-layout">
                        <main className="main-viewport">
                <div className="sec-root">
                    <div className="sec-header">
                        <div className="sec-header-inner">
                            <Link href="/profile" className="sec-back-btn" suppressHydrationWarning>
                                <i className="fas fa-arrow-left"></i>
                            </Link>
                            <span className="sec-title">Rules &amp; Guidelines</span>
                        </div>
                    </div>

                    <section className="sec-content" style={{ color: 'var(--text-color, #1e293b)' }}>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>
                            <strong>Violation of any rule may result in trade cancellation, profit adjustment, account restrictions, temporary suspension, permanent termination, disqualification from competitions, forfeiture of rewards, or any other corrective action deemed appropriate by the Platform. The Platform's decision regarding violations shall be final and binding.</strong>
                        </p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Trading Conduct Rules</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>1. Chamka Trading is strictly prohibited.</strong><br/>Any artificial, manipulative, collusive, circular, non-genuine, or platform-exploiting trading activity intended to generate unfair gains, rankings, rewards, incentives, rebates, referrals, competition results, or account performance is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>2. Maximum Position Holding Period</strong><br/>No position may be carried forward for more than three (3) trading days. Users wishing to continue a market view must close the existing position and initiate a new position.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>3. High-Frequency Trading (HFT) Prohibited</strong><br/>High-frequency trading, excessive order placement, rapid-fire trading, algorithmic trading, latency exploitation, quote stuffing, excessive scalping, or similar behavior is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>4. Minimum Trade Interval</strong><br/>A minimum gap of two (2) minutes must be maintained between consecutive trades.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>5. Artificial Volume Generation Prohibited</strong><br/>Users may not place trades solely to generate turnover, activity, rankings, incentives, rewards, or competition points.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>6. Excessive Churning Prohibited</strong><br/>Repeated entry and exit of positions without genuine market rationale may be treated as abusive trading activity.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>7. Platform Exploitation Prohibited</strong><br/>Users may not exploit pricing errors, technical glitches, delayed feeds, software bugs, calculation anomalies, latency differences, system vulnerabilities, or unintended platform behavior.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Options Trading Rules</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>8. Expiry-Hour Option Selling Restriction</strong><br/>Option selling during the final hours before expiry for the primary purpose of capturing accelerated time decay is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>9. Commodity Option Concentration Restriction</strong><br/>Users may not trade exclusively in commodity options.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>10. Stock Option Concentration Restriction</strong><br/>Users may not trade exclusively in stock options.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>11. Mandatory Index Participation</strong><br/>At least fifty percent (50%) of options exposure, volume, or activity must involve index options as determined by the Platform.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>12. Momentum Exploitation Restriction</strong><br/>Simultaneous purchase of both Call (CE) and Put (PE) contracts on the same instrument for volatility capture, event-based exploitation, momentum extraction, or platform gaming may be restricted or prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>13. Expiry Manipulation Prohibited</strong><br/>Trading strategies designed solely to exploit expiry-related pricing distortions, settlement mechanics, or platform calculations may be disallowed.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>14. Risk-Free Structure Prohibited</strong><br/>Trading structures designed primarily to create near risk-free outcomes, artificial hedges, or guaranteed ranking advantages may be restricted.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Account Usage Rules</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>15. One User, One Primary Account</strong><br/>Each account must be used solely by its registered owner.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>16. Account Handling Prohibited</strong><br/>No user may permit another person to operate, manage, monitor, control, advise, or execute trades on their behalf.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>17. Shared Access Prohibited</strong><br/>Sharing passwords, login credentials, devices, sessions, authentication codes, or account access with another person is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>18. Multiple Account Abuse Prohibited</strong><br/>Users may not create, control, operate, benefit from, or participate through multiple accounts to gain an unfair advantage.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>19. Linked Account Monitoring</strong><br/>The Platform may identify and link accounts through common devices, IP addresses, payment methods, behavioral patterns, contact details, referral relationships, or other indicators.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>20. Opposite Position Trading Prohibited</strong><br/>Taking buy positions in one account and corresponding sell positions in another account for hedging, risk transfer, ranking manipulation, or coordinated benefit is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>21. Account Leasing or Sale Prohibited</strong><br/>Buying, selling, renting, transferring, gifting, or leasing accounts is prohibited.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Coordination &amp; Market Conduct Rules</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>22. Group Trading Prohibited</strong><br/>Coordinated trading among friends, groups, communities, trading clubs, syndicates, organizations, or teams is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>23. Signal-Based Manipulation Prohibited</strong><br/>Coordinated signal sharing intended to influence competitions, rankings, rewards, or platform outcomes is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>24. Operator Calls Prohibited</strong><br/>Trading solely based on operator calls, manipulated tips, guaranteed-return schemes, pump-and-dump activity, or coordinated instructions is prohibited.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>25. Collusion Prohibited</strong><br/>Any arrangement between users intended to create unfair outcomes, transfer performance, evade rules, or manipulate results is prohibited.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Payments &amp; Verification</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>26. Same-Person Funding Requirement</strong><br/>Deposits, subscriptions, payments, and account funding must originate from the same individual whose details are registered on the account.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>27. Identity Verification</strong><br/>The Platform may request identity, address, payment, banking, or ownership verification at any time.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>28. Source Verification</strong><br/>The Platform reserves the right to investigate payment sources, funding methods, and account ownership where suspicious activity is detected.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>29. Verification Failure</strong><br/>Failure to provide requested verification information may result in restrictions, suspension, or account termination.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Platform Authority &amp; Enforcement</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>30. Monitoring Rights</strong><br/>The Platform may monitor, record, review, analyze, audit, and investigate any account, trade, communication, payment, login activity, or user behavior for compliance purposes.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>31. Suspicious Activity Review</strong><br/>The Platform may investigate unusual profitability, abnormal consistency, coordinated behavior, suspicious trading patterns, excessive returns, or activity inconsistent with normal educational trading.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>32. Trade Cancellation Rights</strong><br/>The Platform may cancel, modify, reverse, settle, reject, or adjust trades that violate these rules or are suspected of violating these rules.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>33. Profit Adjustment Rights</strong><br/>The Platform may remove, reduce, freeze, withhold, adjust, or invalidate profits, rankings, rewards, incentives, points, achievements, or competition results obtained through prohibited activity.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>34. Competition Protection</strong><br/>The Platform reserves the right to disqualify users from contests, leaderboards, rankings, rewards, incentives, and promotional programs where suspicious activity is identified.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>35. Rule Circumvention Prohibited</strong><br/>Any attempt to circumvent the intent or spirit of these rules shall be treated as a violation, even if the specific conduct is not expressly listed.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>36. Discretionary Enforcement</strong><br/>The Platform reserves the right to take corrective action whenever it reasonably believes user activity may compromise fairness, integrity, security, educational objectives, or user experience.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>37. No Obligation to Provide Prior Notice</strong><br/>Corrective actions may be taken with or without prior notice where the Platform considers immediate action necessary.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>38. Final Authority</strong><br/>The interpretation, application, and enforcement of these Trading Rules shall remain solely with the Platform, and all decisions made by the Platform shall be final, binding, and conclusive.</p>

                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>
                            <strong>The Platform reserves the right to investigate and act against any activity that, in its sole judgment, violates the spirit of fair participation, even if such activity is not specifically listed in these rules.</strong>
                        </p>
                    </section>
                </div>
            </main>
        </div>
    );
}
