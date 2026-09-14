'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';

export default function OurCalculationPage() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    getSession().then((session) => {
      const role = session?.user?.user_metadata?.role;
      if (role === 'super_admin') {
        setAuthorized(true);
      } else {
        // Not a superadmin — redirect to home
        router.replace('/');
      }
      setChecking(false);
    });
  }, [router]);

  if (checking) {
    return (
      <div style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary, #f9fafb)',
      }}>
        <div style={{ fontSize: '0.9rem', color: '#6b7280' }}>Checking access...</div>
      </div>
    );
  }

  if (!authorized) return null;

  return (
    <div style={{
      minHeight: '100dvh',
      padding: '2rem',
      background: 'var(--bg-primary, #f9fafb)',
      color: 'var(--text-primary, #111827)',
    }}>
      <div style={{ maxWidth: '960px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '1.5rem' }}>
          Our Calculation
        </h1>

        <div style={{
          background: 'var(--bg-card, #ffffff)',
          borderRadius: '1rem',
          padding: '1.5rem',
          boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
        }}>
          <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.9rem' }}>
            Superadmin-only page. Add your content here.
          </p>
        </div>
      </div>
    </div>
  );
}
