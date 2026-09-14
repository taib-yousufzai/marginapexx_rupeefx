'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { api } from '@/lib/api';

import { getSharedSessionSync } from '@/lib/sharedSession';

export interface BalanceContextType {
  balance: number;
  settlementAmount: number;
  loading: boolean;
  refresh: () => Promise<void>;
  validatePreflight: (requiredMargin: number) => { valid: boolean; reason?: string };
}

const BalanceDataContext = createContext<BalanceContextType | null>(null);

export const BalanceDataProvider = ({ children }: { children: React.ReactNode }) => {
  const [balance, setBalance] = useState(0);
  const [settlementAmount, setSettlementAmount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Guard against concurrent in-flight fetches
  const fetchingRef = useRef(false);

  const fetchBalance = useCallback(async () => {
    if (fetchingRef.current) return;
    const { token } = getSharedSessionSync();
    if (!token) return;

    fetchingRef.current = true;
    try {
      const data = await api.get<{ balance?: number; settlementAmount?: number }>('/api/pay/balance');
      setBalance(Number(data.balance ?? 0));
      setSettlementAmount(Math.abs(Number(data.settlementAmount ?? 0)));
    } catch (err: any) {
      if (err?.status !== 401) {
        console.error('[BalanceProvider] failed to fetch balance:', err);
      }
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const init = async (session?: any) => {
      if (cancelled) return;
      if (!session) {
        const { token } = getSharedSessionSync();
        if (!token) {
          if (!cancelled) setLoading(false);
          return;
        }
      }

      // Initial fetch
      setLoading(true);
      try {
        const data = await api.get<{ balance?: number; settlementAmount?: number }>('/api/pay/balance');
        if (!cancelled) {
          setBalance(Number(data.balance ?? 0));
          setSettlementAmount(Math.abs(Number(data.settlementAmount ?? 0)));
        }
      } catch (err: any) {
        if (err?.status !== 401) {
          console.error('[BalanceProvider] failed to fetch balance:', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Realtime subscription — fires on any UPDATE to this user's profile row
      if (channel) supabase.removeChannel(channel);

      const userId = session?.user?.id;
      if (!userId) return;

      channel = supabase
        .channel(`balance-realtime-${userId}-${Date.now()}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'profiles',
            filter: `id=eq.${userId}`,
          },
          (payload) => {
            if (cancelled) return;
            const updated = payload.new as Record<string, unknown>;
            if (updated) {
              setBalance(Number(updated.balance ?? 0));
              setSettlementAmount(Math.abs(Number(updated.settlement_amount ?? 0)));
            }
          },
        )
        .subscribe();
    };

    // Re-fetch on order events (covers the cases where realtime lags)
    const handleOrderPlaced = () => {
      if (!cancelled) fetchBalance();
    };
    window.addEventListener('order_placed', handleOrderPlaced);
    window.addEventListener('position-closed', handleOrderPlaced);
    window.addEventListener('position_closed', handleOrderPlaced);

    // Auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        init(session);
      } else {
        if (!cancelled) setLoading(false);
      }
    });

    // Check current session immediately via non-blocking token check
    const { token } = getSharedSessionSync();
    if (token) {
      fetchBalance();
    } else {
      if (!cancelled) setLoading(false);
    }

    // Active balance polling fallback: fetch balance every 10 seconds as safety net
    // (paused when tab is hidden, immediate refresh when tab becomes visible)
    const timer = setInterval(() => {
      if (!cancelled && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        fetchBalance();
      }
    }, 10000);

    const handleVisibility = () => {
      if (!cancelled && document.visibilityState === 'visible') {
        fetchBalance();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
      subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
      window.removeEventListener('order_placed', handleOrderPlaced);
      window.removeEventListener('position-closed', handleOrderPlaced);
      window.removeEventListener('position_closed', handleOrderPlaced);
    };
  }, [fetchBalance]);

  const validatePreflight = useCallback((requiredMargin: number): { valid: boolean; reason?: string } => {
    if (balance > 0 && requiredMargin > balance) {
      return {
        valid: false,
        reason: `Insufficient margin. Required: ₹${requiredMargin.toLocaleString('en-IN', { maximumFractionDigits: 2 })}, Available: ₹${balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
      };
    }
    return { valid: true };
  }, [balance]);

  return (
    <BalanceDataContext.Provider value={{ balance, settlementAmount, loading, refresh: fetchBalance, validatePreflight }}>
      {children}
    </BalanceDataContext.Provider>
  );
};

export const useBalanceData = () => {
  const context = useContext(BalanceDataContext);
  if (!context) {
    throw new Error('useBalanceData must be used within a BalanceDataProvider');
  }
  return context;
};
