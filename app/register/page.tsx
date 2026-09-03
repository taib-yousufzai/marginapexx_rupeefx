'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { api, ApiError } from '@/lib/api';
import RiskRulesPopup from '@/components/RiskRulesPopup';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import '../login/page.css';

// ─── OTP Input component — 6 auto-advance boxes ───────────────────────────────
function OtpInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = Array.from({ length: 6 }, () => useRef<HTMLInputElement>(null));
  const digits = value.split('').concat(Array(6).fill('')).slice(0, 6);

  const handleKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      refs[i - 1].current?.focus();
    }
  };

  const handleChange = (i: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const ch = e.target.value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = ch;
    onChange(next.join(''));
    if (ch && i < 5) refs[i + 1].current?.focus();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    onChange(pasted.padEnd(6, '').slice(0, 6));
    refs[Math.min(pasted.length, 5)].current?.focus();
    e.preventDefault();
  };

  return (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={refs[i]}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={d}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          onPaste={handlePaste}
          style={{
            width: 48, height: 56, textAlign: 'center', fontSize: '1.5rem',
            fontWeight: 700, borderRadius: 10, border: '1.5px solid #d1d5db',
            outline: 'none', background: '#f9fafb', color: '#111',
            transition: 'border-color 0.2s',
          }}
          onFocus={e => (e.target.style.borderColor = '#16a34a')}
          onBlur={e => (e.target.style.borderColor = '#d1d5db')}
        />
      ))}
    </div>
  );
}

// ─── Main Register Form ────────────────────────────────────────────────────────
function RegisterForm() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [step, setStep] = useState<'form' | 'otp'>('form');

  // Step 1 fields
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [brokerRef, setBrokerRef] = useState<string | null>(null);

  // Field errors
  const [fullNameError, setFullNameError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [confirmEmailError, setConfirmEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmPasswordError, setConfirmPasswordError] = useState('');

  // Step 2 fields
  const [otp, setOtp] = useState('');
  const [deliveryStatus, setDeliveryStatus] = useState({ emailSent: false, smsSent: false });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  // Shared state
  const [formError, setFormError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Resend cooldown
  const [resendCooldown, setResendCooldown] = useState(0);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  const resetTurnstile = () => {
    setTurnstileToken(null);
    if (typeof window !== 'undefined' && (window as any).turnstile) {
      try {
        const container = document.getElementById('cf-turnstile');
        if (container && container.children.length > 0) {
          (window as any).turnstile.reset('#cf-turnstile');
        }
      } catch {
        // Widget may not be active in current DOM state
      }
    }
  };

  useEffect(() => {
    const ref = searchParams.get('ref');
    if (ref) setBrokerRef(ref);
    const sync = () => applyTheme(getSavedTheme());
    sync();
    window.addEventListener('themeChanged', sync);

    // Load Cloudflare Turnstile script if site key exists
    if (siteKey && typeof window !== 'undefined') {
      const existingScript = document.getElementById('cf-turnstile-script');
      const renderWidget = () => {
        if ((window as any).turnstile) {
          try {
            const container = document.getElementById('cf-turnstile');
            if (container && container.children.length === 0) {
              (window as any).turnstile.render('#cf-turnstile', {
                sitekey: siteKey,
                callback: (token: string) => setTurnstileToken(token),
                'expired-callback': () => setTurnstileToken(null),
                'error-callback': () => setTurnstileToken(null),
              });
            }
          } catch {
            // Ignore render error if already active
          }
        }
      };

      if (!existingScript) {
        const script = document.createElement('script');
        script.id = 'cf-turnstile-script';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = renderWidget;
        document.head.appendChild(script);
      } else {
        renderWidget();
      }
    }

    return () => {
      window.removeEventListener('themeChanged', sync);
    };
  }, [searchParams, siteKey]);

  // Countdown timer for resend
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown(c => c - 1), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  // ── Step 1: Send OTP ─────────────────────────────────────────────────────────
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    let hasError = false;
    if (!fullName.trim()) { setFullNameError('Full name is required'); hasError = true; }
    if (!email.trim()) { setEmailError('Email address is required'); hasError = true; }
    if (!confirmEmail.trim()) { setConfirmEmailError('Please confirm your email'); hasError = true; }
    if (email.trim() !== confirmEmail.trim()) { setConfirmEmailError('Emails do not match'); hasError = true; }
    if (!password) { setPasswordError('Password is required'); hasError = true; }
    else if (password.length < 8) { setPasswordError('Password must be at least 8 characters.'); hasError = true; }
    if (!confirmPassword) { setConfirmPasswordError('Please confirm your password'); hasError = true; }
    if (hasError) return;
    if (password !== confirmPassword) { setConfirmPasswordError('Passwords do not match'); return; }

    setIsLoading(true);
    setFormError('');

    try {
      const data = await api.post<{ emailSent: boolean; smsSent: boolean }>(
        '/api/register/send-otp',
        { email: email.trim(), fullName: fullName.trim(), phone: phone.trim(), brokerRef, turnstileToken },
      );
      setDeliveryStatus({ emailSent: data.emailSent, smsSent: data.smsSent });
      setStep('otp');
      setResendCooldown(60);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.details as Record<string, unknown> | undefined;
        setFormError((body?.error as string) || 'Failed to send OTP');
      } else {
        setFormError('Failed to send OTP');
      }
      resetTurnstile();
    } finally {
      setIsLoading(false);
    }
  };

  // ── Step 2: Verify OTP ───────────────────────────────────────────────────────
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (otp.length !== 6) { setFormError('Please enter the full 6-digit code'); return; }

    setIsLoading(true);
    setFormError('');

    try {
      await api.post<unknown>(
        '/api/register/verify-otp',
        { email: email.trim(), otp, password },
      );
      // Sign in the newly created user
      await supabase.auth.signInWithPassword({ email: email.trim(), password });
      setIsSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.details as Record<string, unknown> | undefined;
        setFormError((body?.error as string) || 'Verification failed');
      } else {
        setFormError('Verification failed');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // ── Resend OTP ───────────────────────────────────────────────────────────────
  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setFormError('');
    setOtp('');
    try {
      const data = await api.post<{ emailSent: boolean; smsSent: boolean }>(
        '/api/register/send-otp',
        { email: email.trim(), fullName: fullName.trim(), phone: phone.trim(), brokerRef },
      );
      setDeliveryStatus({ emailSent: data.emailSent, smsSent: data.smsSent });
    } catch {
      // Resend failures are silent — cooldown still applies
    }
    setResendCooldown(60);
  };

  // ── Success screen ───────────────────────────────────────────────────────────
  if (isSuccess) {
    return (
      <div className="login-page">
        <div className="login-branding">
          <span className="login-brand-margin">MARGIN</span>
          <span className="login-brand-apex">APEX</span>
        </div>
        <div className="login-card">
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: '3rem', marginBottom: 16, color: '#16a34a' }}><i className="fas fa-check-circle" /></div>
            <h2 className="login-card-title">Account Created!</h2>
            <p className="login-card-subtitle">Please read the terms to continue.</p>
          </div>
        </div>
        <RiskRulesPopup onAccept={() => router.replace('/')} />
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-branding">
        <span className="login-brand-margin">MARGIN</span>
        <span className="login-brand-apex">APEX</span>
      </div>

      <div className="login-card">
        {step === 'form' ? (
          <>
            <h1 className="login-card-title">Create account</h1>
            <p className="login-card-subtitle">Fill in your details to get started</p>

            <form className="login-form" onSubmit={handleSendOtp} noValidate>

              {/* Full Name */}
              <div className="login-field-group">
                <label htmlFor="fullName" className="login-label">Full Name</label>
                <div className={`login-input-wrapper${fullNameError ? ' login-input-error' : ''}`}>
                  <span className="login-input-icon"><i className="fas fa-user" /></span>
                  <input id="fullName" type="text" className="login-input" value={fullName}
                    onChange={e => { setFullName(e.target.value); setFullNameError(''); setFormError(''); }}
                    autoComplete="name" disabled={isLoading} />
                </div>
                {fullNameError && <span className="login-field-error" role="alert">{fullNameError}</span>}
              </div>

              {/* Phone Number */}
              <div className="login-field-group">
                <label htmlFor="phone" className="login-label">Phone Number</label>
                <div className={`login-input-wrapper${phoneError ? ' login-input-error' : ''}`}>
                  <span className="login-input-icon"><i className="fas fa-phone" /></span>
                  <input id="phone" type="tel" className="login-input" value={phone}
                    onChange={e => { setPhone(e.target.value); setPhoneError(''); setFormError(''); }}
                    autoComplete="tel" disabled={isLoading} placeholder="e.g. 9876543210" />
                </div>
                {phoneError && <span className="login-field-error" role="alert">{phoneError}</span>}
              </div>

              {/* Email */}
              <div className="login-field-group">
                <label htmlFor="email" className="login-label">Email Address</label>
                <div className={`login-input-wrapper${emailError ? ' login-input-error' : ''}`}>
                  <span className="login-input-icon"><i className="fas fa-envelope" /></span>
                  <input id="email" type="email" className="login-input" value={email}
                    onChange={e => { setEmail(e.target.value); setEmailError(''); setFormError(''); }}
                    autoComplete="email" disabled={isLoading} />
                </div>
                {emailError && <span className="login-field-error" role="alert">{emailError}</span>}
              </div>

              {/* Confirm Email */}
              <div className="login-field-group">
                <label htmlFor="confirmEmail" className="login-label">Confirm Email</label>
                <div className={`login-input-wrapper${confirmEmailError ? ' login-input-error' : ''}`}>
                  <span className="login-input-icon"><i className="fas fa-envelope" /></span>
                  <input id="confirmEmail" type="email" className="login-input" value={confirmEmail}
                    onChange={e => { setConfirmEmail(e.target.value); setConfirmEmailError(''); setFormError(''); }}
                    autoComplete="email" disabled={isLoading} onPaste={e => e.preventDefault()} />
                </div>
                {confirmEmailError && <span className="login-field-error" role="alert">{confirmEmailError}</span>}
              </div>

              {/* Password */}
              <div className="login-field-group">
                <label htmlFor="password" className="login-label">Password</label>
                <div className={`login-input-wrapper${passwordError ? ' login-input-error' : ''}`}>
                  <span className="login-input-icon"><i className="fas fa-lock" /></span>
                  <input id="password" type={showPassword ? 'text' : 'password'} className="login-input"
                    value={password} onChange={e => { setPassword(e.target.value); setPasswordError(''); setFormError(''); }}
                    autoComplete="new-password" disabled={isLoading} />
                  <button type="button" className="login-toggle-eye" onClick={() => setShowPassword(v => !v)}
                    tabIndex={-1} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                    <i className={`fas fa-eye${showPassword ? '-slash' : ''}`} />
                  </button>
                </div>
                {passwordError && <span className="login-field-error" role="alert">{passwordError}</span>}
              </div>

              {/* Confirm Password */}
              <div className="login-field-group">
                <label htmlFor="confirmPassword" className="login-label">Confirm Password</label>
                <div className={`login-input-wrapper${confirmPasswordError ? ' login-input-error' : ''}`}>
                  <span className="login-input-icon"><i className="fas fa-lock" /></span>
                  <input id="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} className="login-input"
                    value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setConfirmPasswordError(''); setFormError(''); }}
                    autoComplete="new-password" disabled={isLoading} />
                  <button type="button" className="login-toggle-eye" onClick={() => setShowConfirmPassword(v => !v)}
                    tabIndex={-1} aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}>
                    <i className={`fas fa-eye${showConfirmPassword ? '-slash' : ''}`} />
                  </button>
                </div>
                {confirmPasswordError && <span className="login-field-error" role="alert">{confirmPasswordError}</span>}
              </div>

              {siteKey && (
                <div style={{ display: 'flex', justifyContent: 'center', margin: '16px 0' }}>
                  <div id="cf-turnstile" />
                </div>
              )}

              {formError && (
                <div className="login-form-error" role="alert">
                  <i className="fas fa-circle-exclamation" style={{ marginRight: 6 }} />{formError}
                </div>
              )}

              <button type="submit" className="login-submit-btn" disabled={isLoading}>
                {isLoading ? 'Sending code…' : 'Send verification code'}
              </button>
            </form>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <Link href="/login" style={{ color: '#6b7280', fontSize: '0.875rem' }}>
                Already have an account? <span style={{ color: '#16a34a', fontWeight: 600 }}>Sign in</span>
              </Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="login-card-title">Verify your account</h1>
            <p className="login-card-subtitle">
              We sent a 6-digit code to{' '}
              {deliveryStatus.emailSent && deliveryStatus.smsSent ? (
                <><strong>{email}</strong> and your phone</>
              ) : deliveryStatus.smsSent ? (
                <>your phone</>
              ) : (
                <strong>{email}</strong>
              )}
            </p>

            <form className="login-form" onSubmit={handleVerifyOtp} noValidate>
              <div style={{ margin: '24px 0 12px' }}>
                <OtpInput value={otp} onChange={v => { setOtp(v); setFormError(''); }} />
              </div>
              <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '0.85rem', marginBottom: '24px' }}>
                <i className="far fa-clock" style={{ marginRight: 4 }}></i>
                The OTP will expire in 10 minutes
              </p>

              {formError && (
                <div className="login-form-error" role="alert">
                  <i className="fas fa-circle-exclamation" style={{ marginRight: 6 }} />{formError}
                </div>
              )}

              <button type="submit" className="login-submit-btn" disabled={isLoading || otp.length < 6}>
                {isLoading ? 'Verifying…' : 'Create account'}
              </button>
            </form>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                onClick={handleResend}
                disabled={resendCooldown > 0}
                style={{
                  background: 'none', border: 'none', cursor: resendCooldown > 0 ? 'default' : 'pointer',
                  color: resendCooldown > 0 ? '#9ca3af' : '#16a34a', fontSize: '0.875rem', fontWeight: 600
                }}
              >
                {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
              </button>
            </div>

            <div style={{ textAlign: 'center', marginTop: 8 }}>
              <button onClick={() => { setStep('form'); setOtp(''); setFormError(''); resetTurnstile(); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '0.875rem' }}>
                ← Change email
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Page wrapper ─────────────────────────────────────────────────────────────
export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="login-page" />}>
      <RegisterForm />
    </Suspense>
  );
}
