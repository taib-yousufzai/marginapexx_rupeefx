'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { api } from '@/lib/api';

import { getSharedSession, getSharedSessionSync } from '@/lib/sharedSession';

export interface BalanceContextType {
  balance: number;
  rawBalance?: number;
  settlementAmount: number;
  loading: boolean;
  refresh: () => Promise<void>;
  validatePreflight: (requiredMargin: number) => { valid: boolean; reason?: string };
  lockOptimisticMargin: (amount: number, lockId: string) => void;
  releaseOptimisticMargin: (lockId: string) => void;
}

const BalanceDataContext = createContext<BalanceContextType | null>(null);

export const BalanceDataProvider = ({ children }: { children: React.ReactNode }) => {
  const [balance, setBalance] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('last_user_balance');
        if (cached !== null && !isNaN(Number(cached))) return Number(cached);
      } catch {}
    }
    return 0;
  });
  const [settlementAmount, setSettlementAmount] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('last_user_settlement');
        if (cached !== null && !isNaN(Number(cached))) return Number(cached);
      } catch {}
    }
    return 0;
  });
  const [loading, setLoading] = useState(true);
  const [optimisticLockedMargins, setOptimisticLockedMargins] = useState<Record<string, { amount: number; addedAt: number }>>({});

  const lockOptimisticMargin = useCallback((amount: number, lockId: string) => {
    if (amount <= 0 || !lockId) return;
    setOptimisticLockedMargins(prev => ({
      ...prev,
      [lockId]: { amount, addedAt: Date.now() }
    }));
  }, []);

  const releaseOptimisticMargin = useCallback((lockId: string) => {
    if (!lockId) return;
    setOptimisticLockedMargins(prev => {
      if (!prev[lockId]) return prev;
      const next = { ...prev };
      delete next[lockId];
      return next;
    });
  }, []);

  // Compute active locked margin (filtering out any >10s stale locks)
  const now = Date.now();
  const activeLockedMargin = Object.values(optimisticLockedMargins).reduce((sum, item) => {
    if (now - item.addedAt > 10000) return sum;
    return sum + item.amount;
  }, 0);

  const effectiveBalance = Math.max(0, balance - activeLockedMargin);

  // Guard against concurrent in-flight fetches
  const fetchingRef = useRef(false);

  const updateBalanceState = useCallback((newBal: number, newSettlement: number) => {
    setBalance(newBal);
    setSettlementAmount(newSettlement);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('last_user_balance', String(newBal));
        localStorage.setItem('last_user_settlement', String(newSettlement));
      } catch {}
    }
  }, []);

  const fetchBalance = useCallback(async () => {
    if (fetchingRef.current) return;
    let { token } = getSharedSessionSync();
    if (!token) {
      const session = await getSharedSession();
      token = session?.token || null;
    }
    if (!token) return;

    fetchingRef.current = true;
    try {
      const data = await api.get<{ balance?: number; settlementAmount?: number }>('/api/pay/balance');
      if (typeof data?.balance === 'number') {
        updateBalanceState(Number(data.balance), Math.abs(Number(data.settlementAmount ?? 0)));
      }
    } catch (err: any) {
      if (err?.status !== 401) {
        console.error('[BalanceProvider] failed to fetch balance:', err);
      }
    } finally {
      fetchingRef.current = false;
    }
  }, [updateBalanceState]);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const init = async (session?: any) => {
      if (cancelled) return;
      let token = session?.access_token || getSharedSessionSync().token;
      if (!token) {
        const s = await getSharedSession();
        token = s?.token || null;
      }
      if (!token) {
        if (!cancelled) setLoading(false);
        return;
      }

      // Initial fetch
      setLoading(true);
      try {
        const data = await api.get<{ balance?: number; settlementAmount?: number }>('/api/pay/balance');
        if (!cancelled && typeof data?.balance === 'number') {
          updateBalanceState(Number(data.balance), Math.abs(Number(data.settlementAmount ?? 0)));
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
            if (updated && typeof updated.balance === 'number') {
              updateBalanceState(Number(updated.balance), Math.abs(Number(updated.settlement_amount ?? 0)));
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
    if (effectiveBalance > 0 && requiredMargin > effectiveBalance) {
      return {
        valid: false,
        reason: `Insufficient margin. Required: ₹${requiredMargin.toLocaleString('en-IN', { maximumFractionDigits: 2 })}, Available: ₹${effectiveBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
      };
    }
    return { valid: true };
  }, [effectiveBalance]);

  return (
    <BalanceDataContext.Provider value={{
      balance: effectiveBalance,
      rawBalance: balance,
      settlementAmount,
      loading,
      refresh: fetchBalance,
      validatePreflight,
      lockOptimisticMargin,
      releaseOptimisticMargin
    }}>
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
