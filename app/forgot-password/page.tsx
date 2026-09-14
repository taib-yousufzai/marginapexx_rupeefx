'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import AnimatedLoader from '@/components/AnimatedLoader';
import { requestPasswordReset } from '@/lib/auth';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import '../login/page.css';

type ForgotPasswordState = 'idle' | 'loading' | 'success' | 'error';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [formError, setFormError] = useState('');
  const [pageState, setPageState] = useState<ForgotPasswordState>('idle');

  // On mount: apply theme from localStorage
  useEffect(() => {
    const sync = () => applyTheme(getSavedTheme());
    sync();
    window.addEventListener('themeChanged', sync);
    return () => window.removeEventListener('themeChanged', sync);
  }, []);

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    setEmailError('');
    setFormError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Client-side validation
    if (!email.trim()) {
      setEmailError('Email address is required');
      return;
    }

    if (!EMAIL_REGEX.test(email.trim())) {
      setEmailError('Please enter a valid email address');
      return;
    }

    setPageState('loading');
    setFormError('');

    const result = await requestPasswordReset(email.trim());

    if ('success' in result && result.success) {
      setPageState('success');
    } else {
      setFormError('Something went wrong. Please try again.');
      setPageState('error');
    }
  };

  // Success / confirmation screen
  if (pageState === 'success') {
    return (
      <div className="login-page">
        <div className="login-branding">
          <span className="login-brand-margin">MARGIN</span>
          <span className="login-brand-apex">APEX</span>
        </div>
        <div className="login-card">
          <h1 className="login-card-title">Check your email</h1>
          <p className="login-card-subtitle">
            We&apos;ve sent a password reset link to your email address. Check your inbox and
            click the link to set a new password.
          </p>
          <Link
            href="/login"
            className="login-submit-btn"
            style={{ textDecoration: 'none', marginTop: '16px', display: 'flex' }}
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  const isLoading = pageState === 'loading';

  return (
    <div className="login-page">
      {/* Branding */}
      <div className="login-branding">
        <span className="login-brand-margin">MARGIN</span>
        <span className="login-brand-apex">APEX</span>
      </div>

      {/* Auth card */}
      <div className="login-card">
        <h1 className="login-card-title">Forgot password?</h1>
        <p className="login-card-subtitle">
          Enter your email address and we&apos;ll send you a link to reset your password.
        </p>

        <form className="login-form" onSubmit={handleSubmit} noValidate>

          {/* Email field */}
          <div className="login-field-group">
            <label htmlFor="email" className="login-label">
              Email Address
            </label>
            <div className={`login-input-wrapper${emailError ? ' login-input-error' : ''}`}>
              <span className="login-input-icon">
                <i className="fas fa-envelope"></i>
              </span>
              <input
                id="email"
                type="email"
                className="login-input"
                value={email}
                onChange={handleEmailChange}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                disabled={isLoading}
              />
            </div>
            {emailError && (
              <span className="login-field-error" role="alert">
                {emailError}
              </span>
            )}
          </div>

          {/* Form-level error */}
          {formError && (
            <div className="login-form-error" role="alert">
              <i className="fas fa-circle-exclamation"></i>
              {' '}{formError}
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            className="login-submit-btn"
            disabled={isLoading}
            aria-label="Send password reset email"
          >
            {isLoading ? (
              <>
                <AnimatedLoader size="small" />
                {' '}Sending…
              </>
            ) : (
              'Send reset link'
            )}
          </button>
        </form>

        {/* Back to sign in link */}
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
          <span className="login-brand-margin">MARGIN</span>
          <span className="login-brand-apex">APEX</span>
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
