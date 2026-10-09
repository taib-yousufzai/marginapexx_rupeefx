'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AnimatedLoader from '@/components/AnimatedLoader';
import { supabase } from '@/lib/supabaseClient';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import '../login/page.css';

type ForgotPasswordStep = 'identifier' | 'otp' | 'success';

function ForgotPasswordForm() {
  const router = useRouter();

  const [step, setStep] = useState<ForgotPasswordStep>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [resolvedEmail, setResolvedEmail] = useState('');
  const [maskedDestination, setMaskedDestination] = useState('');

  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [identifierError, setIdentifierError] = useState('');
  const [otpError, setOtpError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmPasswordError, setConfirmPasswordError] = useState('');
  const [formError, setFormError] = useState('');

  const [isLoading, setIsLoading] = useState(false);

  // On mount: apply theme from localStorage
  useEffect(() => {
    const sync = () => applyTheme(getSavedTheme());
    sync();
    window.addEventListener('themeChanged', sync);
    return () => window.removeEventListener('themeChanged', sync);
  }, []);

  const handleIdentifierChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIdentifier(e.target.value);
    setIdentifierError('');
    setFormError('');
  };

  const handleOtpChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setOtp(e.target.value.replace(/\s+/g, ''));
    setOtpError('');
    setFormError('');
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = identifier.trim();
    if (!trimmed) {
      setIdentifierError('Email address or mobile number is required');
      return;
    }

    setIsLoading(true);
    setFormError('');

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: trimmed }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        setFormError(data.error || 'Unable to process reset request. Please try again.');
        setIsLoading(false);
        return;
      }

      if (data.resolvedEmail) {
        setResolvedEmail(data.resolvedEmail);
      } else if (trimmed.includes('@')) {
        setResolvedEmail(trimmed.toLowerCase());
      }

      const destinations: string[] = [];
      if (data.maskedEmail) destinations.push(data.maskedEmail);
      if (data.maskedPhone) destinations.push(data.maskedPhone);
      setMaskedDestination(destinations.join(' / ') || trimmed);

      setStep('otp');
    } catch (err: any) {
      setFormError('Failed to send verification code. Please check your network connection.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetWithOtp = async (e: React.FormEvent) => {
    e.preventDefault();

    let hasError = false;
    if (!otp.trim()) {
      setOtpError('Please enter the OTP code');
      hasError = true;
    }

    if (!newPassword) {
      setPasswordError('New password is required');
      hasError = true;
    } else if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      hasError = true;
    }

    if (!confirmPassword) {
      setConfirmPasswordError('Please confirm your new password');
      hasError = true;
    } else if (newPassword !== confirmPassword) {
      setConfirmPasswordError('Passwords do not match');
      hasError = true;
    }

    if (hasError) return;

    setIsLoading(true);
    setFormError('');

    const targetEmail = resolvedEmail || (identifier.includes('@') ? identifier.trim().toLowerCase() : '');

    try {
      const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
        email: targetEmail,
        token: otp.trim(),
        type: 'recovery',
      });

      if (verifyError || !verifyData.session) {
        setFormError(verifyError?.message || 'Invalid or expired OTP code. Please check and try again.');
        setIsLoading(false);
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        setFormError(updateError.message || 'Failed to update password. Please try again.');
        setIsLoading(false);
        return;
      }

      setStep('success');
      setTimeout(() => {
        router.replace('/login');
      }, 2500);
    } catch (err: any) {
      setFormError('Failed to reset password. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (step === 'success') {
    return (
      <div className="login-page">
        <div className="login-branding">
          <img src="/rupeefx-logo-transparent.png" alt="RupeeFX" style={{ height: '52px', objectFit: 'contain' }} />
        </div>
        <div className="login-card">
          <h1 className="login-card-title">Password Updated!</h1>
          <p className="login-card-subtitle">
            Your password has been reset successfully. Redirecting you to sign in…
          </p>
          <Link
            href="/login"
            className="login-submit-btn"
            style={{ textDecoration: 'none', marginTop: '16px', display: 'flex' }}
          >
            Sign in now
          </Link>
        </div>
      </div>
    );
  }

  if (step === 'otp') {
    return (
      <div className="login-page">
        <div className="login-branding">
          <img src="/rupeefx-logo-transparent.png" alt="RupeeFX" style={{ height: '52px', objectFit: 'contain' }} />
        </div>

        <div className="login-card">
          <h1 className="login-card-title">Enter Verification Code</h1>
          <p className="login-card-subtitle">
            We sent an OTP code to <strong style={{ color: 'var(--text-primary)' }}>{maskedDestination}</strong>. Enter it below with your new password.
          </p>

          <form className="login-form" onSubmit={handleResetWithOtp} noValidate>
            <div className="login-field-group">
              <label htmlFor="otp" className="login-label">
                OTP Code
              </label>
              <div className={`login-input-wrapper${otpError ? ' login-input-error' : ''}`}>
                <span className="login-input-icon">
                  <i className="fas fa-shield-halved"></i>
                </span>
                <input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  className="login-input"
                  placeholder="Enter OTP"
                  value={otp}
                  onChange={handleOtpChange}
                  autoComplete="one-time-code"
                  disabled={isLoading}
                  style={{ letterSpacing: '2px', fontWeight: 600 }}
                />
              </div>
              {otpError && (
                <span className="login-field-error" role="alert">
                  {otpError}
                </span>
              )}
            </div>

            <div className="login-field-group">
              <label htmlFor="newPassword" className="login-label">
                New Password
              </label>
              <div className={`login-input-wrapper${passwordError ? ' login-input-error' : ''}`}>
                <span className="login-input-icon">
                  <i className="fas fa-lock"></i>
                </span>
                <input
                  id="newPassword"
                  type={showNewPassword ? 'text' : 'password'}
                  className="login-input"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setPasswordError('');
                    setFormError('');
                  }}
                  autoComplete="new-password"
                  disabled={isLoading}
                  placeholder="At least 8 characters"
                />
                <button
                  type="button"
                  className="login-toggle-password"
                  onClick={() => setShowNewPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                >
                  <i className={showNewPassword ? 'fas fa-eye-slash' : 'fas fa-eye'}></i>
                </button>
              </div>
              {passwordError && (
                <span className="login-field-error" role="alert">
                  {passwordError}
                </span>
              )}
            </div>

            <div className="login-field-group">
              <label htmlFor="confirmPassword" className="login-label">
                Confirm Password
              </label>
              <div className={`login-input-wrapper${confirmPasswordError ? ' login-input-error' : ''}`}>
                <span className="login-input-icon">
                  <i className="fas fa-lock"></i>
                </span>
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  className="login-input"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setConfirmPasswordError('');
                    setFormError('');
                  }}
                  autoComplete="new-password"
                  disabled={isLoading}
                  placeholder="Re-enter new password"
                />
                <button
                  type="button"
                  className="login-toggle-password"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                >
                  <i className={showConfirmPassword ? 'fas fa-eye-slash' : 'fas fa-eye'}></i>
                </button>
              </div>
              {confirmPasswordError && (
                <span className="login-field-error" role="alert">
                  {confirmPasswordError}
                </span>
              )}
            </div>

            {formError && (
              <div className="login-form-error" role="alert">
                <i className="fas fa-circle-exclamation"></i>
                {' '}{formError}
              </div>
            )}

            <button
              type="submit"
              className="login-submit-btn"
              disabled={isLoading}
              aria-label="Set new password"
            >
              {isLoading ? (
                <>
                  <AnimatedLoader size="small" />
                  {' '}Updating password…
                </>
              ) : (
                'Set new password'
              )}
            </button>
          </form>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '16px', fontSize: '13px' }}>
            <button
              type="button"
              onClick={() => { setStep('identifier'); setFormError(''); }}
              style={{ background: 'none', border: 'none', color: '#38bdf8', cursor: 'pointer', padding: 0 }}
            >
              ← Change email / phone
            </button>
            <button
              type="button"
              onClick={handleSendOtp}
              disabled={isLoading}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary, #64748b)', cursor: 'pointer', padding: 0 }}
            >
              Resend OTP
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-branding">
        <img src="/rupeefx-logo-transparent.png" alt="RupeeFX" style={{ height: '52px', objectFit: 'contain' }} />
      </div>

      <div className="login-card">
        <h1 className="login-card-title">Forgot password?</h1>
        <p className="login-card-subtitle">
          Enter your registered email address or mobile number to receive an OTP code.
        </p>

        <form className="login-form" onSubmit={handleSendOtp} noValidate>
          <div className="login-field-group">
            <label htmlFor="identifier" className="login-label">
              Email or Mobile Number
            </label>
            <div className={`login-input-wrapper${identifierError ? ' login-input-error' : ''}`}>
              <span className="login-input-icon">
                <i className={identifier.replace(/\D/g, '').length >= 5 ? 'fas fa-phone' : 'fas fa-envelope'}></i>
              </span>
              <input
                id="identifier"
                type="text"
                className="login-input"
                value={identifier}
                onChange={handleIdentifierChange}
                autoComplete="username email tel"
                autoCapitalize="none"
                spellCheck={false}
                disabled={isLoading}
                placeholder="e.g. user@gmail.com or 9876543210"
              />
            </div>
            {identifierError && (
              <span className="login-field-error" role="alert">
                {identifierError}
              </span>
            )}
          </div>

          {formError && (
            <div className="login-form-error" role="alert">
              <i className="fas fa-circle-exclamation"></i>
              {' '}{formError}
            </div>
          )}

          <button
            type="submit"
            className="login-submit-btn"
            disabled={isLoading}
            aria-label="Send password reset OTP"
          >
            {isLoading ? (
              <>
                <AnimatedLoader size="small" />
                {' '}Sending OTP…
              </>
            ) : (
              'Send OTP code'
            )}
          </button>
        </form>

        <p className="login-signup-link" style={{ marginTop: '16px' }}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={
      <div className="login-page">
        <div className="login-branding">
          <img src="/rupeefx-logo-transparent.png" alt="RupeeFX" style={{ height: '52px', objectFit: 'contain' }} />
        </div>
        <div className="login-card">
          <p className="login-card-subtitle">Loading…</p>
        </div>
      </div>
    }>
      <ForgotPasswordForm />
    </Suspense>
  );
}
