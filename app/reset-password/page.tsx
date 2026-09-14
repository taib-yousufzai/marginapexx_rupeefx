'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AnimatedLoader from '@/components/AnimatedLoader';
import { updatePassword } from '@/lib/auth';
import { supabase } from '@/lib/supabaseClient';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import '../login/page.css';

type ResetPasswordState = 'verifying' | 'error' | 'ready' | 'loading' | 'success';

function ResetPasswordForm() {
  const router = useRouter();

  // Page-level state
  const [pageState, setPageState] = useState<ResetPasswordState>('verifying');

  // Form field state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Visibility toggles
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Field-level errors
  const [newPasswordError, setNewPasswordError] = useState('');
  const [confirmPasswordError, setConfirmPasswordError] = useState('');

  // Form-level error
  const [formError, setFormError] = useState('');

  // On mount: apply theme and subscribe to auth state changes
  useEffect(() => {
    // Apply theme
    const sync = () => applyTheme(getSavedTheme());
    sync();
    window.addEventListener('themeChanged', sync);

    // Subscribe to auth state changes to detect PASSWORD_RECOVERY event
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setPageState('ready');
      } else if (event === 'SIGNED_OUT') {
        setPageState('error');
      }
    });

    // Timeout: if no recovery event fires within 5 seconds, show error
    const timeout = setTimeout(() => {
      setPageState((current) => {
        if (current === 'verifying') return 'error';
        return current;
      });
    }, 5000);

    return () => {
      window.removeEventListener('themeChanged', sync);
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  // Field change handlers — clear field error and form error on change
  const handleNewPasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewPassword(e.target.value);
    setNewPasswordError('');
    setFormError('');
  };

  const handleConfirmPasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmPassword(e.target.value);
    setConfirmPasswordError('');
    setFormError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate: check empty fields first
    let hasError = false;
    if (!newPassword) {
      setNewPasswordError('New password is required');
      hasError = true;
    }
    if (!confirmPassword) {
      setConfirmPasswordError('Please confirm your new password');
      hasError = true;
    }
    if (hasError) return;

    // Validate: check length
    if (newPassword.length < 8) {
      setNewPasswordError('Password must be at least 8 characters');
      return;
    }

    // Validate: check match
    if (newPassword !== confirmPassword) {
      setConfirmPasswordError('Passwords do not match');
      return;
    }

    // Submit
    setPageState('loading');
    setFormError('');

    const result = await updatePassword(newPassword);

    if ('success' in result && result.success) {
      setPageState('success');
      setTimeout(() => {
        router.replace('/login');
      }, 3000);
    } else {
      setFormError('Failed to update password. Please try again or request a new reset link.');
      setPageState('ready');
    }
  };

  const isDisabled = pageState === 'loading';

  // ── Verifying state ──────────────────────────────────────────────────────────
  if (pageState === 'verifying') {
    return (
      <div className="login-page">
        <div className="login-branding">
          <span className="login-brand-margin">MARGIN</span>
          <span className="login-brand-apex">APEX</span>
        </div>
        <div className="login-card">
          <p className="login-card-subtitle">Verifying your reset link…</p>
        </div>
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────────
  if (pageState === 'error') {
    return (
      <div className="login-page">
        <div className="login-branding">
          <span className="login-brand-margin">MARGIN</span>
          <span className="login-brand-apex">APEX</span>
        </div>
        <div className="login-card">
          <h1 className="login-card-title">Reset link invalid</h1>
          <p className="login-card-subtitle">
            This reset link is invalid or has expired. Please request a new one.
          </p>
          <Link href="/forgot-password" className="login-submit-btn" style={{ textDecoration: 'none', display: 'flex' }}>
            Request a new reset link
          </Link>
        </div>
      </div>
    );
  }

  // ── Success state ────────────────────────────────────────────────────────────
  if (pageState === 'success') {
    return (
      <div className="login-page">
        <div className="login-branding">
          <span className="login-brand-margin">MARGIN</span>
          <span className="login-brand-apex">APEX</span>
        </div>
        <div className="login-card">
          <h1 className="login-card-title">Password updated</h1>
          <p className="login-card-subtitle">
            Your password has been updated successfully. Redirecting you to sign in…
          </p>
        </div>
      </div>
    );
  }

  // ── Ready / Loading state ────────────────────────────────────────────────────
  return (
    <div className="login-page">
      {/* Branding */}
      <div className="login-branding">
        <span className="login-brand-margin">MARGIN</span>
        <span className="login-brand-apex">APEX</span>
      </div>

      {/* Auth card */}
      <div className="login-card">
        <h1 className="login-card-title">Set new password</h1>
        <p className="login-card-subtitle">Enter and confirm your new password below</p>

        <form className="login-form" onSubmit={handleSubmit} noValidate>

          {/* New Password field */}
          <div className="login-field-group">
            <label htmlFor="newPassword" className="login-label">
              New Password
            </label>
            <div className={`login-input-wrapper${newPasswordError ? ' login-input-error' : ''}`}>
              <span className="login-input-icon">
                <i className="fas fa-lock"></i>
              </span>
              <input
                id="newPassword"
                type={showNewPassword ? 'text' : 'password'}
                className="login-input"
                value={newPassword}
                onChange={handleNewPasswordChange}
                autoComplete="new-password"
                disabled={isDisabled}
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
            {newPasswordError && (
              <span className="login-field-error" role="alert">
                {newPasswordError}
              </span>
            )}
          </div>

          {/* Confirm Password field */}
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
                onChange={handleConfirmPasswordChange}
                autoComplete="new-password"
                disabled={isDisabled}
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
            disabled={isDisabled}
            aria-label="Update password"
          >
            {isDisabled ? (
              <>
                <AnimatedLoader size="small" />
                {' '}Updating password…
              </>
            ) : (
              'Update password'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
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
      <ResetPasswordForm />
    </Suspense>
  );
}
