'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, getSession, getRole } from '@/lib/auth';
import RiskRulesPopup from '@/components/RiskRulesPopup';
import AnimatedLoader from '@/components/AnimatedLoader';
import { getSavedTheme, applyTheme } from '@/lib/theme';
import './page.css';

export default function LoginPage() {
  const router = useRouter();

  // Apply active theme on mount — same pattern as all other pages
  useEffect(() => {
    const sync = () => applyTheme(getSavedTheme());
    sync();
    window.addEventListener('themeChanged', sync);
    return () => window.removeEventListener('themeChanged', sync);
  }, []);

  // Form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [formError, setFormError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [showPopups, setShowPopups] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);

  const isLoggingInRef = useRef(false);

  // Redirect based on role if already authenticated
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('expired=1')) {
      return;
    }
    getSession().then((session) => {
      if (session && !isLoggingInRef.current) {
        const role = getRole(session.user);
        router.replace(role === 'admin' ? '/admin' : '/');
      }
    });
  }, [router]);

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(e.target.value);
    setUsernameError('');
    setFormError('');
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    setPasswordError('');
    setFormError('');
  };

  const handleDemoLogin = async () => {
    setUsername('demo@gmail.com');
    setPassword('demo123');
    setUsernameError('');
    setPasswordError('');
    setFormError('');
    setIsLoading(true);
    isLoggingInRef.current = true;

    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const result = await signIn('demo@gmail.com', 'demo123');

      if (!result.error) {
        const role = getRole(result.user ?? null);
        const isAdmin = role === 'admin' || role === 'super_admin';
        const route = isAdmin ? '/admin' : '/';
        
        if (isAdmin || result.user?.email === 'demo@gmail.com') {
          router.replace(route);
        } else {
          setPendingRoute(route);
          setShowPopups(true);
        }
        setIsLoading(false);
      } else {
        setFormError(result.error || 'Demo account unavailable. Please try again later.');
        setIsLoading(false);
      }
    } catch (err: any) {
      console.error('Demo login error:', err);
      setFormError(err.message || 'An unexpected error occurred. Please try again.');
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    // Validate empty fields first — do NOT call validateCredentials (Requirement 3.5)
    let hasError = false;
    if (!username) {
      setUsernameError('Email or username is required');
      hasError = true;
    }
    if (!password) {
      setPasswordError('Password is required');
      hasError = true;
    }
    if (hasError) return;

    setIsLoading(true);
    setFormError('');
    isLoggingInRef.current = true;

    // Small async tick so the loading state renders before the credential check
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const result = await signIn(username, password);

      if (!result.error) {
        const role = getRole(result.user ?? null);
        const isAdmin = role === 'admin' || role === 'super_admin';
        const route = isAdmin ? '/admin' : '/';
        
        if (isAdmin || result.user?.email === 'demo@gmail.com') {
          router.replace(route);
        } else {
          setPendingRoute(route);
          setShowPopups(true);
        }
        setIsLoading(false);
      } else {
        setFormError(result.error);
        setIsLoading(false);
      }
    } catch (err: any) {
      console.error('Login error:', err);
      setFormError(err.message || 'An unexpected error occurred. Please try again.');
      setIsLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Branding — matches nav bar style (Requirement 1.3) */}
      <div className="login-branding">
        <span className="login-brand-margin">MARGIN</span>
        <span className="login-brand-apex">APEX</span>
      </div>

      {/* Auth card */}
      <div className="login-card">
        <h1 className="login-card-title">Sign in</h1>
        <p className="login-card-subtitle">Enter your credentials to continue</p>

        {/* form onSubmit handles Enter-key submission (Requirement 7.3) */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>

          {/* Email / Username field (Requirement 2.1) */}
          <div className="login-field-group">
            <label htmlFor="username" className="login-label">
              Email / Username
            </label>
            <div className={`login-input-wrapper${usernameError ? ' login-input-error' : ''}`}>
              <span className="login-input-icon">
                <i className="fas fa-envelope"></i>
              </span>
              <input
                id="username"
                type="text"
                className="login-input"
                value={username}
                onChange={handleUsernameChange}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={isLoading}
                suppressHydrationWarning
              />
            </div>
            {usernameError && (
              <span className="login-field-error" role="alert">
                {usernameError}
              </span>
            )}
          </div>

          {/* Password field (Requirement 2.2) */}
          <div className="login-field-group">
            <label htmlFor="password" className="login-label">
              Password
            </label>
            <div className={`login-input-wrapper${passwordError ? ' login-input-error' : ''}`}>
              <span className="login-input-icon">
                <i className="fas fa-lock"></i>
              </span>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                className="login-input"
                value={password}
                onChange={handlePasswordChange}
                autoComplete="current-password"
                disabled={isLoading}
                suppressHydrationWarning
              />
              {/* Password visibility toggle (Requirement 2.3) */}
              <button
                type="button"
                className="login-toggle-password"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <i className={showPassword ? 'fas fa-eye-slash' : 'fas fa-eye'}></i>
              </button>
            </div>
            {passwordError && (
              <span className="login-field-error" role="alert">
                {passwordError}
              </span>
            )}
          </div>

          {/* Forgot password link (Requirement 1.1, 1.2, 1.3, 1.4) */}
          <p className="login-signup-link" style={{ marginTop: '-8px' }}>
            <a href="/forgot-password">Forgot password?</a>
          </p>

          {/* Form-level error (Requirement 3.3) */}
          {formError && (
            <div className="login-form-error" role="alert">
              <i className="fas fa-circle-exclamation"></i>
              {' '}{formError}
            </div>
          )}

          {/* Submit button (Requirements 4.5, 7.4) */}
          <button
            type="submit"
            className="login-submit-btn"
            disabled={isLoading}
            aria-label="Log in to Margin Apex"
            suppressHydrationWarning
          >
            {isLoading ? (
              <>
                <AnimatedLoader size="small" />
                {' '}Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>

          {/* Divider */}
          <div className="login-divider">
            <span className="login-divider-line" />
            <span className="login-divider-text">or</span>
            <span className="login-divider-line" />
          </div>

          {/* Demo login */}
          <button
            type="button"
            className="login-demo-btn"
            disabled={isLoading}
            onClick={handleDemoLogin}
            aria-label="Sign in with demo account"
          >
            <i className="fas fa-flask"></i>
            {' '}Try Demo Account
          </button>
        </form>

        <p className="login-signup-link">
          Don&apos;t have an account?
        </p>
        <a href="/register" className="login-create-btn">
          Create your account
        </a>
      </div>

      {/* Popups */}
      {showPopups && (
        <RiskRulesPopup
          onAccept={() => {
            if (pendingRoute) router.replace(pendingRoute);
          }}
        />
      )}
    </div>
  );
}
