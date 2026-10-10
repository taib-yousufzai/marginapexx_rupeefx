'use client';

import React, { useState, useEffect } from 'react';
import './RiskRulesPopup.css';

interface RiskRulesPopupProps {
  onAccept: () => void;
}

export default function RiskRulesPopup({ onAccept }: RiskRulesPopupProps) {
  const [showRiskPopup, setShowRiskPopup] = useState(true);
  const [agreedToRisk, setAgreedToRisk] = useState(false);
  const [showRulesPopup, setShowRulesPopup] = useState(false);
  const [agreedToRules, setAgreedToRules] = useState(false);

  // Prevent hardware back-button bypass on Android/iOS
  useEffect(() => {
    const handlePopState = () => {
      // If user presses back while popups are open, sign them out immediately
      if (showRiskPopup || showRulesPopup) {
        // Clear Supabase session from localStorage manually to bypass Turbopack dynamic import bug
        try {
          for (const key in localStorage) {
            if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
              localStorage.removeItem(key);
            }
          }
        } catch (e) {}
        window.location.reload();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [showRiskPopup, showRulesPopup]);

  // Push dummy state when risk popup opens
  useEffect(() => {
    if (showRiskPopup && !showRulesPopup) {
      window.history.pushState({ popup: 'auth_flow' }, '');
    }
  }, [showRiskPopup, showRulesPopup]);

  return (
    <>
      {/* Risk Disclosure Popup */}
      {showRiskPopup && (
        <div className="risk-popup-overlay">
          <div className="risk-popup-content">
            <h2 className="risk-title">Risk Disclosure &amp; User Acknowledgment</h2>
            <h3 className="risk-subtitle">Please read carefully before continuing.</h3>

            <div className="risk-text-scroll">
              <p>Welcome to the Trading Simulation Platform. This Platform is provided solely for educational, informational, training, and simulation purposes. By accessing, registering for, logging into, or otherwise using the Platform, you acknowledge that you have read, understood, and agreed to be bound by these Terms of Use, Risk Disclosures, and User Acknowledgments. If you do not agree with any part of these terms, you should discontinue use of the Platform immediately.</p>

              <p>This Platform is not a stock exchange, brokerage, investment advisor, portfolio manager, financial institution, or provider of legal, tax, accounting, investment, or financial advice. The information, charts, prices, market data, indicators, analytics, educational materials, tools, and trading simulations available through the Platform are intended solely for educational and demonstration purposes. Nothing contained within the Platform constitutes financial advice, investment advice, a recommendation, solicitation, endorsement, or offer to buy or sell any security, derivative, commodity, currency, cryptocurrency, or financial instrument.</p>

              <p>The Platform operates exclusively as a simulated trading environment. No real currency, real money, real securities, real commodities, real cryptocurrencies, or other financial assets are traded, deposited, withdrawn, transferred, exchanged, or held through the Platform. Any account balance, portfolio value, profit, loss, ranking, reward, achievement, score, virtual currency, performance metric, or simulated account value displayed within the Platform is entirely fictitious, created solely for educational purposes, and possesses no monetary value, redemption value, transfer value, or entitlement of any kind.</p>

              <p>All trading activity conducted within the Platform is based on Bid and Ask pricing. Users acknowledge that buy orders may execute at Ask prices and sell orders may execute at Bid prices. Bid-Ask spreads may fluctuate due to market conditions, pricing methodologies, liquidity assumptions, simulation models, system calculations, or other factors. As a result, account balances, trade outcomes, unrealized profits or losses, and position valuations may be affected by Bid-Ask spread differences. Any loss, discrepancy, valuation change, reduction in account value, execution variance, or trading outcome arising directly or indirectly from Bid-Ask spreads shall be considered final. No claim, refund, reimbursement, adjustment, compensation, recovery, dispute, or legal action shall be maintained against the Platform or its owner in relation to such differences.</p>

              <p>Where margin facilities, leveraged positions, financing features, or carry-forward positions are made available, users acknowledge that financing costs, margin carry charges, rollover fees, borrowing costs, overnight charges, administrative fees, interest charges, or similar assessments may be applied. Such charges may be calculated using methodologies determined solely by the Platform and may be modified from time to time. Users accept that these charges form part of the educational trading environment and may affect simulated account balances, profitability, and performance calculations.</p>

              <p>Trading and investing involve significant risk. Markets are inherently volatile and prices may move rapidly and unpredictably. Simulated performance, educational results, rankings, profits, or successful trading outcomes within the Platform do not guarantee future success or profitability in live financial markets. Users acknowledge that the Platform's simulation environment may differ substantially from real-world trading conditions, execution practices, liquidity conditions, market behavior, and pricing structures. Participation within the Platform is entirely voluntary and undertaken at the user's own risk.</p>

              <p>Market data, charts, analytics, indicators, educational materials, calculations, software features, and trading simulations may be delayed, estimated, derived, simulated, incomplete, unavailable, or inaccurate from time to time. The Platform, its owner, operators, affiliates, contractors, licensors, employees, and service providers make no representation or warranty, express or implied, regarding the accuracy, completeness, reliability, availability, timeliness, or suitability of any information presented. Users are solely responsible for evaluating and relying upon any information displayed within the Platform.</p>

              <p>Users further acknowledge that software systems may experience outages, maintenance periods, bugs, programming errors, communication failures, synchronization issues, server interruptions, cyber incidents, hardware failures, pricing anomalies, or other technical difficulties. The Platform does not guarantee uninterrupted service or error-free operation and shall not be responsible for any loss, inconvenience, damage, missed opportunity, or adverse outcome resulting from technical issues or system limitations.</p>

              <p>To the fullest extent permitted by applicable law, the Platform, its owner, directors, officers, employees, affiliates, contractors, licensors, partners, and service providers shall not be liable for any direct, indirect, incidental, consequential, punitive, exemplary, special, economic, or other damages, including but not limited to loss of profits, loss of opportunities, loss of business, loss of data, business interruption, reputational damage, or financial loss arising from or related to the use of the Platform.</p>

              <p>Users agree to defend, indemnify, and hold harmless the Platform, its owner, employees, affiliates, contractors, and service providers from and against any claims, actions, liabilities, losses, damages, costs, expenses, or legal fees arising from misuse of the Platform, violation of these Terms, breach of applicable laws, unauthorized activities, or infringement of the rights of any third party.</p>

              <p>The Platform reserves the right, at its sole discretion and without prior notice, to modify, suspend, discontinue, restrict, terminate, or alter any service, feature, calculation methodology, pricing model, educational content, margin policy, ranking system, account structure, competition, or functionality offered through the Platform. Continued use of the Platform following any modification shall constitute acceptance of the revised terms.</p>

              <p>By selecting the acknowledgment checkbox and clicking "I Agree &amp; Continue", you expressly acknowledge and agree that this Platform is intended solely for educational and simulation purposes; that no real currency, securities, or financial assets are involved; that all trades are based on Bid and Ask pricing; that losses or valuation differences arising from Bid-Ask spreads cannot be reclaimed from the Platform; that margin carry interest, financing costs, rollover charges, or holding charges may apply; that financial markets are subject to risk and volatility; that the Platform does not provide investment, legal, tax, or financial advice; that you voluntarily assume all risks associated with the use of the Platform; and that you release and discharge the Platform and its owner from liability to the fullest extent permitted by applicable law.</p>

              <p className="risk-highlight"><strong>Trade Wisely. Markets Are Subject to Trading Risk.</strong></p>
            </div>

            <div className="risk-popup-footer">
              <label className="risk-checkbox-label">
                <input
                  type="checkbox"
                  checked={agreedToRisk}
                  onChange={(e) => setAgreedToRisk(e.target.checked)}
                />
                I have read, understood, and agree to the Terms of Use, Risk Disclosure, and User Acknowledgment.
              </label>
              <button
                className="risk-submit-btn"
                disabled={!agreedToRisk}
                onClick={() => {
                  setShowRiskPopup(false);
                  setShowRulesPopup(true);
                }}
              >
                [ I AGREE &amp; CONTINUE ]
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Trading Conduct Rules Popup */}
      {showRulesPopup && (
        <div className="risk-popup-overlay">
          <div className="risk-popup-content">
            <h2 className="risk-title">Trading Rules, Fair Usage Policy &amp; Code of Conduct</h2>
            <h3 className="risk-subtitle">Please read carefully before continuing.</h3>
            
            <div className="risk-text-scroll">
              <p><strong>Violation of any rule may result in trade cancellation, profit adjustment, account restrictions, temporary suspension, permanent termination, disqualification from competitions, forfeiture of rewards, or any other corrective action deemed appropriate by the Platform. The Platform's decision regarding violations shall be final and binding.</strong></p>
              
              <h4 style={{marginTop: '16px'}}>Trading Conduct Rules</h4>
              <p><strong>1. Chamka Trading is strictly prohibited.</strong><br/>Any artificial, manipulative, collusive, circular, non-genuine, or platform-exploiting trading activity intended to generate unfair gains, rankings, rewards, incentives, rebates, referrals, competition results, or account performance is prohibited.</p>
              
              <p><strong>2. Maximum Position Holding Period</strong><br/>No position may be carried forward for more than three (3) trading days. Users wishing to continue a market view must close the existing position and initiate a new position.</p>

              <p><strong>3. High-Frequency Trading (HFT) Prohibited</strong><br/>High-frequency trading, excessive order placement, rapid-fire trading, algorithmic trading, latency exploitation, quote stuffing, excessive scalping, or similar behavior is prohibited.</p>

              <p><strong>4. Minimum Trade Interval</strong><br/>A minimum gap of two (2) minutes must be maintained between consecutive trades.</p>

              <p><strong>5. Artificial Volume Generation Prohibited</strong><br/>Users may not place trades solely to generate turnover, activity, rankings, incentives, rewards, or competition points.</p>

              <p><strong>6. Excessive Churning Prohibited</strong><br/>Repeated entry and exit of positions without genuine market rationale may be treated as abusive trading activity.</p>

              <p><strong>7. Platform Exploitation Prohibited</strong><br/>Users may not exploit pricing errors, technical glitches, delayed feeds, software bugs, calculation anomalies, latency differences, system vulnerabilities, or unintended platform behavior.</p>

              <h4>Options Trading Rules</h4>
              <p><strong>8. Expiry-Hour Option Selling Restriction</strong><br/>Option selling during the final hours before expiry for the primary purpose of capturing accelerated time decay is prohibited.</p>
              
              <p><strong>9. Commodity Option Concentration Restriction</strong><br/>Users may not trade exclusively in commodity options.</p>
              
              <p><strong>10. Stock Option Concentration Restriction</strong><br/>Users may not trade exclusively in stock options.</p>
              
              <p><strong>11. Mandatory Index Participation</strong><br/>At least fifty percent (50%) of options exposure, volume, or activity must involve index options as determined by the Platform.</p>
              
              <p><strong>12. Momentum Exploitation Restriction</strong><br/>Simultaneous purchase of both Call (CE) and Put (PE) contracts on the same instrument for volatility capture, event-based exploitation, momentum extraction, or platform gaming may be restricted or prohibited.</p>
              
              <p><strong>13. Expiry Manipulation Prohibited</strong><br/>Trading strategies designed solely to exploit expiry-related pricing distortions, settlement mechanics, or platform calculations may be disallowed.</p>
              
              <p><strong>14. Risk-Free Structure Prohibited</strong><br/>Trading structures designed primarily to create near risk-free outcomes, artificial hedges, or guaranteed ranking advantages may be restricted.</p>

              <h4>Account Usage Rules</h4>
              <p><strong>15. One User, One Primary Account</strong><br/>Each account must be used solely by its registered owner.</p>

              <p><strong>16. Account Handling Prohibited</strong><br/>No user may permit another person to operate, manage, monitor, control, advise, or execute trades on their behalf.</p>

              <p><strong>17. Shared Access Prohibited</strong><br/>Sharing passwords, login credentials, devices, sessions, authentication codes, or account access with another person is prohibited.</p>

              <p><strong>18. Multiple Account Abuse Prohibited</strong><br/>Users may not create, control, operate, benefit from, or participate through multiple accounts to gain an unfair advantage.</p>

              <p><strong>19. Linked Account Monitoring</strong><br/>The Platform may identify and link accounts through common devices, IP addresses, payment methods, behavioral patterns, contact details, referral relationships, or other indicators.</p>

              <p><strong>20. Opposite Position Trading Prohibited</strong><br/>Taking buy positions in one account and corresponding sell positions in another account for hedging, risk transfer, ranking manipulation, or coordinated benefit is prohibited.</p>

              <p><strong>21. Account Leasing or Sale Prohibited</strong><br/>Buying, selling, renting, transferring, gifting, or leasing accounts is prohibited.</p>

              <h4>Coordination &amp; Market Conduct Rules</h4>
              <p><strong>22. Group Trading Prohibited</strong><br/>Coordinated trading among friends, groups, communities, trading clubs, syndicates, organizations, or teams is prohibited.</p>

              <p><strong>23. Signal-Based Manipulation Prohibited</strong><br/>Coordinated signal sharing intended to influence competitions, rankings, rewards, or platform outcomes is prohibited.</p>

              <p><strong>24. Operator Calls Prohibited</strong><br/>Trading solely based on operator calls, manipulated tips, guaranteed-return schemes, pump-and-dump activity, or coordinated instructions is prohibited.</p>

              <p><strong>25. Collusion Prohibited</strong><br/>Any arrangement between users intended to create unfair outcomes, transfer performance, evade rules, or manipulate results is prohibited.</p>

              <h4>Payments &amp; Verification</h4>
              <p><strong>26. Same-Person Funding Requirement</strong><br/>Deposits, subscriptions, payments, and account funding must originate from the same individual whose details are registered on the account.</p>

              <p><strong>27. Identity Verification</strong><br/>The Platform may request identity, address, payment, banking, or ownership verification at any time.</p>

              <p><strong>28. Source Verification</strong><br/>The Platform reserves the right to investigate payment sources, funding methods, and account ownership where suspicious activity is detected.</p>

              <p><strong>29. Verification Failure</strong><br/>Failure to provide requested verification information may result in restrictions, suspension, or account termination.</p>

              <h4>Platform Authority &amp; Enforcement</h4>
              <p><strong>30. Monitoring Rights</strong><br/>The Platform may monitor, record, review, analyze, audit, and investigate any account, trade, communication, payment, login activity, or user behavior for compliance purposes.</p>

              <p><strong>31. Suspicious Activity Review</strong><br/>The Platform may investigate unusual profitability, abnormal consistency, coordinated behavior, suspicious trading patterns, excessive returns, or activity inconsistent with normal educational trading.</p>

              <p><strong>32. Trade Cancellation Rights</strong><br/>The Platform may cancel, modify, reverse, settle, reject, or adjust trades that violate these rules or are suspected of violating these rules.</p>

              <p><strong>33. Profit Adjustment Rights</strong><br/>The Platform may remove, reduce, freeze, withhold, adjust, or invalidate profits, rankings, rewards, incentives, points, achievements, or competition results obtained through prohibited activity.</p>

              <p><strong>34. Competition Protection</strong><br/>The Platform reserves the right to disqualify users from contests, leaderboards, rankings, rewards, incentives, and promotional programs where suspicious activity is identified.</p>

              <p><strong>35. Rule Circumvention Prohibited</strong><br/>Any attempt to circumvent the intent or spirit of these rules shall be treated as a violation, even if the specific conduct is not expressly listed.</p>

              <p><strong>36. Discretionary Enforcement</strong><br/>The Platform reserves the right to take corrective action whenever it reasonably believes user activity may compromise fairness, integrity, security, educational objectives, or user experience.</p>

              <p><strong>37. No Obligation to Provide Prior Notice</strong><br/>Corrective actions may be taken with or without prior notice where the Platform considers immediate action necessary.</p>

              <p><strong>38. Final Authority</strong><br/>The interpretation, application, and enforcement of these Trading Rules shall remain solely with the Platform, and all decisions made by the Platform shall be final, binding, and conclusive.</p>

              <p><strong>The Platform reserves the right to investigate and act against any activity that, in its sole judgment, violates the spirit of fair participation, even if such activity is not specifically listed in these rules.</strong></p>

              <h4>User Acknowledgment</h4>
              <p>By clicking <strong>"I Agree &amp; Continue"</strong>, you confirm that you have read, understood, and agreed to comply with these Trading Rules, Fair Usage Policies, and enforcement provisions. You acknowledge that violations may result in corrective actions including trade cancellation, profit adjustment, account restrictions, suspension, permanent termination, reward forfeiture, or competition disqualification.</p>
            </div>
            
            <div className="risk-popup-footer">
              <label className="risk-checkbox-label">
                <input 
                  type="checkbox" 
                  checked={agreedToRules} 
                  onChange={(e) => setAgreedToRules(e.target.checked)} 
                />
                I have read, understood, and agree to the Trading Rules, Fair Usage Policy, and Code of Conduct.
              </label>
              <button 
                className="risk-submit-btn"
                disabled={!agreedToRules}
                onClick={() => {
                  onAccept();
                }}
              >
                [ I AGREE &amp; CONTINUE ]
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
