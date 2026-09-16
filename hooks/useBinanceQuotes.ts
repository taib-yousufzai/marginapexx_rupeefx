'use client';

import { useState, useEffect, useRef, useMemo } from 'react';

export interface BinanceQuote {
  symbol: string;
  lastPrice: number;
  prevClosePrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  time: number;
  bid: number;
  ask: number;
}

/**
 * Connects directly to Binance Public WebSocket combined stream
 * and falls back to REST API for high-frequency live crypto quotes.
 */
export function useBinanceQuotes(symbols: string[]) {
  const [quotes, setQuotes] = useState<Record<string, BinanceQuote>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pendingUpdatesRef = useRef<Record<string, BinanceQuote>>({});
  const wsRef = useRef<WebSocket | null>(null);

  // Clean & normalize symbol list (e.g. ['ETHUSDT', 'BTCUSDT'])
  const cleanSymbols = useMemo(() => {
    return Array.from(new Set(
      symbols
        .filter(s => s && !s.includes(':'))
        .map(s => {
          let upper = s.trim().toUpperCase().replace('/', '');
          if (upper === 'DODGE' || upper === 'DODGEUSDT') return 'DOGEUSDT';
          return upper.endsWith('USDT') ? upper : `${upper}USDT`;
        })
    ));
  }, [symbols]);

  // Flush buffered WebSocket ticks to React state at 200ms throttle
  useEffect(() => {
    const interval = setInterval(() => {
      const pending = pendingUpdatesRef.current;
      if (Object.keys(pending).length > 0) {
        setQuotes(prev => ({ ...prev, ...pending }));
        pendingUpdatesRef.current = {};
      }
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // Connect to Binance Public Combined Stream WebSocket
  useEffect(() => {
    if (cleanSymbols.length === 0) {
      setQuotes({});
      setLoading(false);
      return;
    }

    let isMounted = true;

    // Create stream list e.g. "ethusdt@ticker/btcusdt@ticker"
    const streams = cleanSymbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (isMounted) {
        setLoading(false);
        setError(null);
      }
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const data = payload.data;
        if (data && data.s) {
          const symUpper = data.s.toUpperCase();
          const lp = parseFloat(data.c || '0');
          const bp = parseFloat(data.b || data.c || '0');
          const ap = parseFloat(data.a || data.c || '0');

          const quote: BinanceQuote = {
            symbol: symUpper,
            lastPrice: lp,
            prevClosePrice: parseFloat(data.x || data.o || '0'),
            openPrice: parseFloat(data.o || '0'),
            highPrice: parseFloat(data.h || '0'),
            lowPrice: parseFloat(data.l || '0'),
            volume: parseFloat(data.v || '0'),
            time: data.E || Date.now(),
            bid: bp,
            ask: ap,
          };

          const shortSymbol = symUpper.replace('USDT', '');
          pendingUpdatesRef.current[symUpper] = quote;
          pendingUpdatesRef.current[shortSymbol] = quote;
          if (shortSymbol === 'DOGE') {
            pendingUpdatesRef.current['DODGE'] = quote;
            pendingUpdatesRef.current['DODGEUSDT'] = quote;
          }
        }
      } catch (err) {
        console.error('[useBinanceQuotes] WS parse error:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('[useBinanceQuotes] Direct WS error, falling back to REST', err);
    };

    // REST fallback fetcher for initial load & backstop
    const fetchRestFallback = async () => {
      try {
        const queryString = new URLSearchParams({ symbols: cleanSymbols.join(',') }).toString();
        const res = await fetch(`/api/binance/quotes?${queryString}`);
        if (res.ok) {
          const result = await res.json();
          if (result.success && result.data && isMounted) {
            setQuotes(prev => ({ ...result.data, ...prev }));
            setLoading(false);
          }
        }
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Fetch error');
      }
    };

    fetchRestFallback();

    return () => {
      isMounted = false;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [cleanSymbols]);

  return { quotes, loading, error };
}
