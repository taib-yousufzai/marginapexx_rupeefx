'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { api } from '@/lib/api';

export interface BalanceContextType {
  balance: number;
  settlementAmount: number;
  loading: boolean;
  /**
   * Explicitly re-fetch balance from the API.
   * Normally not needed — the provider updates automatically via:
   *   1. Supabase realtime on profile row UPDATE
   *   2. `order_placed` window event listener
   * Only use this in edge cases where neither fires in time.
   */
  refresh: () => Promise<void>;
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
    fetchingRef.current = true;
    try {
      const data = await api.get<{ balance?: number; settlementAmount?: number }>('/api/pay/balance');
      setBalance(Number(data.balance ?? 0));
      setSettlementAmount(Math.abs(Number(data.settlementAmount ?? 0)));
    } catch (err) {
      console.error('[BalanceProvider] failed to fetch balance:', err);
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const init = async (session?: any) => {
      if (cancelled) return;

      // Initial fetch
      setLoading(true);
      try {
        const data = await api.get<{ balance?: number; settlementAmount?: number }>('/api/pay/balance');
        if (!cancelled) {
          setBalance(Number(data.balance ?? 0));
          setSettlementAmount(Math.abs(Number(data.settlementAmount ?? 0)));
        }
      } catch (err) {
        console.error('[BalanceProvider] failed to fetch balance:', err);
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

    // Check current session immediately
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        init(session);
      } else {
        setTimeout(() => {
          if (!cancelled) setLoading(false);
        }, 500);
      }
    });

    // Active balance polling fallback: fetch balance every 10 seconds to ensure
    // accurate account balance under any network/realtime latency.
    const timer = setInterval(() => {
      if (!cancelled) fetchBalance();
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
      window.removeEventListener('order_placed', handleOrderPlaced);
      window.removeEventListener('position-closed', handleOrderPlaced);
      window.removeEventListener('position_closed', handleOrderPlaced);
    };
  }, [fetchBalance]);

  return (
    <BalanceDataContext.Provider value={{ balance, settlementAmount, loading, refresh: fetchBalance }}>
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
