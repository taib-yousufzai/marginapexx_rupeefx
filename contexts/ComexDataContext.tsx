'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';

export interface ComexQuoteData {
  symbol: string;
  contractSymbol: string;
  name: string;
  lastPrice: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  currency: string;
  bid?: number;
  ask?: number;
}

type ComexDataContextType = {
  quotes: Record<string, ComexQuoteData>;
  subscribe: (symbols: string[]) => void;
  unsubscribe: (symbols: string[]) => void;
};

const ComexDataContext = createContext<ComexDataContextType>({
  quotes: {},
  subscribe: () => {},
  unsubscribe: () => {},
});

export const ComexDataProvider = ({ children }: { children: React.ReactNode }) => {
  const [quotes, setQuotes] = useState<Record<string, ComexQuoteData>>({});
  const activeSymbolsRef = useRef<Set<string>>(new Set());
  const errorRef = useRef<string | null>(null);
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isFetchingRef = useRef<boolean>(false);

  const fetchQuotes = useCallback(async () => {
    if (isFetchingRef.current) return;
    const symbols = Array.from(activeSymbolsRef.current);
    if (symbols.length === 0) return;

    isFetchingRef.current = true;
    try {
      const res = await fetch(
        `/api/market/comex?symbols=${symbols.map(s => encodeURIComponent(s)).join(',')}`,
        { cache: 'no-store' }
      );

      if (!res.ok) {
        errorRef.current = `COMEX API error: ${res.status}`;
        return;
      }

      const data = await res.json() as {
        quotes: Record<string, ComexQuoteData>;
        error?: string;
      };

      if (data.error) {
        errorRef.current = data.error;
        return;
      }

      setQuotes(prev => ({ ...prev, ...(data.quotes ?? {}) }));
      errorRef.current = null;
    } catch {
      errorRef.current = 'Network error';
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Fetch initially
    fetchQuotes();
    // Poll every 3000ms for commodity prices
    const interval = setInterval(fetchQuotes, 3000);
    return () => clearInterval(interval);
  }, [fetchQuotes]);

  const subscribe = useCallback((symbols: string[]) => {
    let added = false;
    const validSymbols = symbols.filter(Boolean);
    validSymbols.forEach(s => {
      if (!activeSymbolsRef.current.has(s)) {
        activeSymbolsRef.current.add(s);
        added = true;
      }
    });

    if (added) {
      if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
      fetchTimeoutRef.current = setTimeout(fetchQuotes, 100);
    }
  }, [fetchQuotes]);

  const unsubscribe = useCallback((symbols: string[]) => {
    // HTTP polling; leave the ref counting out for simplicity
  }, []);

  return (
    <ComexDataContext.Provider value={{ quotes, subscribe, unsubscribe }}>
      {children}
    </ComexDataContext.Provider>
  );
};

export const useGlobalComexQuotes = () => useContext(ComexDataContext);
