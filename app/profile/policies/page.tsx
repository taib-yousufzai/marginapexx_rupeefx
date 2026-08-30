'use client';
import React, { useEffect } from 'react';
import Link from 'next/link';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import '../security/page.css'; // Re-use the security page styling for consistency

export default function PoliciesPage() {
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
                            <span className="sec-title">Trading Policies</span>
                        </div>
                    </div>

                    <section className="sec-content" style={{ color: 'var(--text-color, #1e293b)' }}>
                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Risk Disclosure &amp; User Acknowledgment</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>
                            Please read these policies carefully. By accessing or using the Platform, you acknowledge that you have read, understood, and agreed to be bound by these Terms of Use and Risk Disclosures.
                        </p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Educational Purpose &amp; Simulation</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>Welcome to the Trading Simulation Platform. This Platform is provided solely for educational, informational, training, and simulation purposes.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>This Platform is not a stock exchange, brokerage, investment advisor, portfolio manager, financial institution, or provider of legal, tax, accounting, investment, or financial advice. The information, charts, prices, market data, indicators, analytics, educational materials, tools, and trading simulations available through the Platform are intended solely for educational and demonstration purposes. Nothing contained within the Platform constitutes financial advice, investment advice, a recommendation, solicitation, endorsement, or offer to buy or sell any security, derivative, commodity, currency, cryptocurrency, or financial instrument.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>The Platform operates exclusively as a simulated trading environment. No real currency, real money, real securities, real commodities, real cryptocurrencies, or other financial assets are traded, deposited, withdrawn, transferred, exchanged, or held through the Platform. Any account balance, portfolio value, profit, loss, ranking, reward, achievement, score, virtual currency, performance metric, or simulated account value displayed within the Platform is entirely fictitious, created solely for educational purposes, and possesses no monetary value, redemption value, transfer value, or entitlement of any kind.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Pricing, Execution &amp; Margin</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>All trading activity conducted within the Platform is based on Bid and Ask pricing. Users acknowledge that buy orders may execute at Ask prices and sell orders may execute at Bid prices. Bid-Ask spreads may fluctuate due to market conditions, pricing methodologies, liquidity assumptions, simulation models, system calculations, or other factors. As a result, account balances, trade outcomes, unrealized profits or losses, and position valuations may be affected by Bid-Ask spread differences. Any loss, discrepancy, valuation change, reduction in account value, execution variance, or trading outcome arising directly or indirectly from Bid-Ask spreads shall be considered final. No claim, refund, reimbursement, adjustment, compensation, recovery, dispute, or legal action shall be maintained against the Platform or its owner in relation to such differences.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>Where margin facilities, leveraged positions, financing features, or carry-forward positions are made available, users acknowledge that financing costs, margin carry charges, rollover fees, borrowing costs, overnight charges, administrative fees, interest charges, or similar assessments may be applied. Such charges may be calculated using methodologies determined solely by the Platform and may be modified from time to time. Users accept that these charges form part of the educational trading environment and may affect simulated account balances, profitability, and performance calculations.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Risks &amp; System Reliability</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>Trading and investing involve significant risk. Markets are inherently volatile and prices may move rapidly and unpredictably. Simulated performance, educational results, rankings, profits, or successful trading outcomes within the Platform do not guarantee future success or profitability in live financial markets. Users acknowledge that the Platform's simulation environment may differ substantially from real-world trading conditions, execution practices, liquidity conditions, market behavior, and pricing structures. Participation within the Platform is entirely voluntary and undertaken at the user's own risk.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>Market data, charts, analytics, indicators, educational materials, calculations, software features, and trading simulations may be delayed, estimated, derived, simulated, incomplete, unavailable, or inaccurate from time to time. The Platform, its owner, operators, affiliates, contractors, licensors, employees, and service providers make no representation or warranty, express or implied, regarding the accuracy, completeness, reliability, availability, timeliness, or suitability of any information presented. Users are solely responsible for evaluating and relying upon any information displayed within the Platform.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>Users further acknowledge that software systems may experience outages, maintenance periods, bugs, programming errors, communication failures, synchronization issues, server interruptions, cyber incidents, hardware failures, pricing anomalies, or other technical difficulties. The Platform does not guarantee uninterrupted service or error-free operation and shall not be responsible for any loss, inconvenience, damage, missed opportunity, or adverse outcome resulting from technical issues or system limitations.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Limitation of Liability</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>To the fullest extent permitted by applicable law, the Platform, its owner, directors, officers, employees, affiliates, contractors, licensors, partners, and service providers shall not be liable for any direct, indirect, incidental, consequential, punitive, exemplary, special, economic, or other damages, including but not limited to loss of profits, loss of opportunities, loss of business, loss of data, business interruption, reputational damage, or financial loss arising from or related to the use of the Platform.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>Users agree to defend, indemnify, and hold harmless the Platform, its owner, employees, affiliates, contractors, and service providers from and against any claims, actions, liabilities, losses, damages, costs, expenses, or legal fees arising from misuse of the Platform, violation of these Terms, breach of applicable laws, unauthorized activities, or infringement of the rights of any third party.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>The Platform reserves the right, at its sole discretion and without prior notice, to modify, suspend, discontinue, restrict, terminate, or alter any service, feature, calculation methodology, pricing model, educational content, margin policy, ranking system, account structure, competition, or functionality offered through the Platform. Continued use of the Platform following any modification shall constitute acceptance of the revised terms.</p>

                        <h2 style={{ fontSize: '18px', marginTop: '24px', marginBottom: '12px' }}>Acknowledgment</h2>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}>By using the Platform, you expressly acknowledge and agree that this Platform is intended solely for educational and simulation purposes; that no real currency, securities, or financial assets are involved; that all trades are based on Bid and Ask pricing; that losses or valuation differences arising from Bid-Ask spreads cannot be reclaimed from the Platform; that margin carry interest, financing costs, rollover charges, or holding charges may apply; that financial markets are subject to risk and volatility; that the Platform does not provide investment, legal, tax, or financial advice; that you voluntarily assume all risks associated with the use of the Platform; and that you release and discharge the Platform and its owner from liability to the fullest extent permitted by applicable law.</p>
                        <p style={{ marginBottom: '20px', lineHeight: '1.5' }}><strong>Trade Wisely. Markets Are Subject to Trading Risk.</strong></p>
                    </section>
                </div>
            </main>
        </div>
    );
}
