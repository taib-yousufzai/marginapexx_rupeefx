'use client';

import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { normalizeOptionQuoteDepth } from '@/lib/trading/quoteNormalization';

export interface QuoteData {
  lastPrice: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
}

type MarketDataContextType = {
  quotes: Record<string, QuoteData>;
  subscribe: (symbols: string[]) => void;
  unsubscribe: (symbols: string[]) => void;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  lastError: string | null;
  reconnectCount: number;
};

const MarketDataContext = createContext<MarketDataContextType>({
  quotes: {},
  subscribe: () => { },
  unsubscribe: () => { },
  connectionStatus: 'disconnected',
  lastError: null,
  reconnectCount: 0,
});

const COMEX_ALIAS_MAP: Record<string, string[]> = {
  'XAUUSD': ['GC=F', 'GC', 'COMEX:XAUUSD', 'COMEX:GOLD', 'COMEX:GC'],
  'GC=F': ['XAUUSD', 'GC', 'COMEX:XAUUSD', 'COMEX:GOLD'],
  'XAGUSD': ['SI=F', 'SI', 'COMEX:XAGUSD', 'COMEX:SILVER', 'COMEX:SI'],
  'SI=F': ['XAGUSD', 'SI', 'COMEX:XAGUSD', 'COMEX:SILVER'],
  'XTIUSD': ['CL=F', 'CL', 'WTI', 'USOIL', 'COMEX:XTIUSD', 'COMEX:CRUDE', 'COMEX:CL', 'COMEX:WTI'],
  'CL=F': ['XTIUSD', 'CL', 'WTI', 'COMEX:XTIUSD', 'COMEX:CRUDE'],
  'XCUUSD': ['HG=F', 'HG', 'COMEX:XCUUSD', 'COMEX:COPPER', 'COMEX:HG'],
  'HG=F': ['XCUUSD', 'HG', 'COMEX:XCUUSD', 'COMEX:COPPER'],
  'XNGUSD': ['NG=F', 'NG', 'COMEX:XNGUSD', 'COMEX:NATGAS', 'COMEX:NG'],
  'NG=F': ['XNGUSD', 'NG', 'COMEX:XNGUSD', 'COMEX:NATGAS'],
};

// Singleton manager
class MarketWSManager {
  private ws: WebSocket | null = null;
  private binanceWs: WebSocket | null = null;
  private listeners: Set<(type: string, data: any) => void> = new Set();
  public symbolRefCount: Map<string, number> = new Map();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private wsUrl: string;

  // Event handler references for cleanup
  private handleVisibilityChange: (() => void) | null = null;
  private handleWake: (() => void) | null = null;
  private handleOnline: (() => void) | null = null;

  // Pending subscriptions to send when WebSocket connects
  private pendingSubscriptions: string[] = [];

  // Track connection start time for timeout
  private connectionStartTime: number = 0;

  public connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  public lastError: string | null = null;
  public reconnectCount = 0;

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  public lastMessageReceivedTime = 0;

  constructor() {
    // Connect to production Railway ticker WebSocket (or custom configured env)
    let url = process.env.NEXT_PUBLIC_TICKER_WS_URL;
    if (!url || url.includes('vercel.app')) {
      url = 'wss://marginapexx-production.up.railway.app';
    }

    this.wsUrl = url;
    console.log('[MarketWSManager] Initialized with WebSocket URL:', url);

    if (typeof window !== 'undefined') {
      let lastHiddenTime = 0;

      // Store handler references for cleanup
      this.handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          lastHiddenTime = Date.now();
        } else if (document.visibilityState === 'visible') {
          console.log('[MarketWSManager] Visibility visible. Checking connection status...');
          const elapsed = lastHiddenTime > 0 ? Date.now() - lastHiddenTime : 0;

          if (elapsed > 5000) {
            console.log(`[MarketWSManager] Tab hidden for ${elapsed}ms. Proactively recycling socket for iOS resilience.`);
            this.disconnectCleanly();
            if (this.symbolRefCount.size > 0) {
              this.connect();
            }
          } else if (!this.ws || (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING)) {
            if (this.symbolRefCount.size > 0) {
              this.connect();
            }
          }
          lastHiddenTime = 0;
        };
      };

      this.handleWake = () => {
        console.log('[MarketWSManager] Lifecycle wake/focus event. Verifying socket health...');
        if (!this.ws || (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING)) {
          if (this.symbolRefCount.size > 0) {
            this.connect();
          }
        }
      };

      this.handleOnline = () => {
        console.log('[MarketWSManager] Device online event detected.');
        if ((!this.ws || this.ws.readyState !== WebSocket.OPEN) && this.symbolRefCount.size > 0) {
          this.connect();
        }
      };

      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      window.addEventListener('pageshow', this.handleWake);
      window.addEventListener('focus', this.handleWake);
      window.addEventListener('online', this.handleOnline);
    }
  }

  private disconnectCleanly() {
    this.stopHeartbeat();

    if (this.ws) {
      console.log('[MarketWSManager] Disconnecting current WebSocket cleanly...');
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (e) {
        console.error('[MarketWSManager] error closing ws:', e);
      }
      this.ws = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private connectBinance() {
    if (typeof window === 'undefined') return;
    const defaultCryptos = ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'BNBUSDT', 'PAXGUSDT', 'EURUSDT', 'GBPUSDT'];
    const cryptoSymbols: string[] = [...defaultCryptos];
    const CRYPTO_BASES = ['BTC', 'ETH', 'DOGE', 'DODGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC', 'PAXG'];
    for (const sym of Array.from(this.symbolRefCount.keys())) {
      let upper = sym.toUpperCase().replace(/^CRYPTO:/, '').trim();
      if (upper === 'DODGE') upper = 'DOGE';
      if (upper === 'DODGEUSDT') upper = 'DOGEUSDT';
      if (upper.endsWith('USDT')) {
        cryptoSymbols.push(upper);
      } else if (CRYPTO_BASES.includes(upper)) {
        cryptoSymbols.push(`${upper}USDT`);
      }
    }

    const uniqueStreams = Array.from(new Set(cryptoSymbols)).map(s => `${s.toLowerCase()}@ticker`);
    if (uniqueStreams.length === 0) return;

    if (this.binanceWs && (this.binanceWs.readyState === WebSocket.CONNECTING || this.binanceWs.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      const wsUrl = `wss://stream.binance.com:9443/stream?streams=${uniqueStreams.join('/')}`;
      console.log('[MarketWSManager] Connecting direct Binance WS stream:', wsUrl);
      const bws = new WebSocket(wsUrl);
      this.binanceWs = bws;

      bws.onmessage = (event) => {
        this.lastMessageReceivedTime = Date.now();
        try {
          const payload = JSON.parse(event.data);
          const data = payload?.data;
          if (data && data.s) {
            const symUpper = data.s.toUpperCase();
            const lp = parseFloat(data.c || '0');
            const bp = parseFloat(data.b || data.c || '0');
            const ap = parseFloat(data.a || data.c || '0');
            const pChange = parseFloat(data.p || '0');
            const pChangePct = parseFloat(data.P || '0');
            const openVal = parseFloat(data.o || '0');
            const close = parseFloat(data.x || (openVal > 0 ? openVal : (lp - pChange)) || lp);

            const quoteObj = {
              timestamp: new Date(data.E || Date.now()).toISOString(),
              last_price: lp,
              volume: parseFloat(data.v || '0'),
              ohlc: {
                open: openVal > 0 ? openVal : close,
                high: parseFloat(data.h || lp),
                low: parseFloat(data.l || lp),
                close,
              },
              net_change: pChange !== 0 ? pChange : (lp - close),
              changePercent: pChangePct !== 0 ? pChangePct : (close > 0 ? ((lp - close) / close * 100) : 0),
              bid: bp,
              ask: ap,
            };

            const shortSymbol = symUpper.replace('USDT', '');
            this.notifyListeners('update', { symbol: symUpper, quote: quoteObj });
            this.notifyListeners('update', { symbol: shortSymbol, quote: quoteObj });
            this.notifyListeners('update', { symbol: `CRYPTO:${shortSymbol}`, quote: quoteObj });

            if (shortSymbol === 'DOGE') {
              this.notifyListeners('update', { symbol: 'DODGE', quote: quoteObj });
              this.notifyListeners('update', { symbol: 'DODGEUSDT', quote: quoteObj });
              this.notifyListeners('update', { symbol: 'CRYPTO:DODGE', quote: quoteObj });
            }

            if (symUpper === 'PAXGUSDT') {
              this.notifyListeners('update', { symbol: 'XAUUSD', quote: quoteObj });
              this.notifyListeners('update', { symbol: 'GC=F', quote: quoteObj });
              this.notifyListeners('update', { symbol: 'COMEX:XAUUSD', quote: quoteObj });
              this.notifyListeners('update', { symbol: 'COMEX:GOLD', quote: quoteObj });
            }
          }
        } catch (e) {
          console.error('[MarketWSManager] Binance WS parse error:', e);
        }
      };

      bws.onerror = (err) => {
        console.warn('[MarketWSManager] Binance WS error:', err);
      };
    } catch (e) {
      console.error('[MarketWSManager] Error creating Binance WS:', e);
    }
  }

  private usStockInterval: ReturnType<typeof setInterval> | null = null;

  private connectUSStocks() {
    if (typeof window === 'undefined') return;
    if (this.usStockInterval) return;

    const pollUSQuotes = async () => {
      const US_STOCKS = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'INTC', 'SPY', 'QQQ', 'DIA', 'ES=F', 'NQ=F', 'YM=F'];
      const usSymbols: string[] = [...US_STOCKS];
      
      for (const sym of Array.from(this.symbolRefCount.keys())) {
        const clean = sym.replace(/^(US:|FOREX:|NSE:|BSE:|NFO:)/i, '').trim().toUpperCase();
        if (sym.toUpperCase().startsWith('US:') || US_STOCKS.includes(clean)) {
          usSymbols.push(clean);
        }
      }

      const unique = Array.from(new Set(usSymbols));
      try {
        const res = await fetch(`/api/market/us-quotes?symbols=${encodeURIComponent(unique.join(','))}`);
        if (!res.ok) return;
        const json = await res.json();
        const quotesMap = json?.quotes || {};

        for (const [sym, q] of Object.entries(quotesMap)) {
          const raw = q as any;
          const price = raw.price || 0;
          if (price <= 0) continue;

          const quoteObj = {
            timestamp: new Date().toISOString(),
            last_price: price,
            volume: 0,
            ohlc: {
              open: raw.prevClose || price,
              high: raw.high || price,
              low: raw.low || price,
              close: raw.prevClose || price,
            },
            net_change: price - (raw.prevClose || price),
            bid: raw.bid || price,
            ask: raw.ask || price,
          };

          this.notifyListeners('update', { symbol: sym, quote: quoteObj });
          this.notifyListeners('update', { symbol: `US:${sym}`, quote: quoteObj });
          this.notifyListeners('update', { symbol: `NSE:${sym}`, quote: quoteObj });
        }
      } catch (e) {
        // fail silently
      }
    };

    pollUSQuotes();
    this.usStockInterval = setInterval(pollUSQuotes, 1000);
  }

  private comexInterval: ReturnType<typeof setInterval> | null = null;

  private connectCOMEX() {
    if (typeof window === 'undefined') return;
    if (this.comexInterval) return;

    const pollCOMEX = async () => {
      const defaultComex = ['XAUUSD', 'GOLD', 'GC=F', 'SILVER', 'XAGUSD', 'SI=F', 'CRUDE', 'XTIUSD', 'CL=F', 'COPPER', 'XCUUSD', 'HG=F', 'NATGAS', 'XNGUSD', 'NG=F'];
      const comexSymbols: string[] = [...defaultComex];

      for (const sym of Array.from(this.symbolRefCount.keys())) {
        const upper = sym.toUpperCase().replace(/^(COMEX:|MCX:|TVC:|FX:|OANDA:)/i, '').trim();
        comexSymbols.push(upper);
      }

      const unique = Array.from(new Set(comexSymbols));
      try {
        const res = await fetch(`/api/market/comex?symbols=${encodeURIComponent(unique.join(','))}`);
        if (!res.ok) return;
        const json = await res.json();
        const quotesMap = json?.quotes || {};

        for (const [sym, q] of Object.entries(quotesMap)) {
          const upper = sym.toUpperCase();
          if (this.binanceWs && this.binanceWs.readyState === WebSocket.OPEN && (upper === 'XAUUSD' || upper === 'GOLD' || upper === 'GC=F')) {
            continue;
          }
          const raw = q as any;
          const price = raw.lastPrice || raw.price || 0;
          if (price <= 0) continue;

          const quoteObj = {
            timestamp: new Date().toISOString(),
            last_price: price,
            volume: raw.volume || 5000,
            ohlc: {
              open: raw.open || price,
              high: raw.high || price,
              low: raw.low || price,
              close: raw.close || raw.open || price,
            },
            net_change: raw.change || (price - (raw.close || price)),
            bid: raw.bid || price,
            ask: raw.ask || price,
          };

          this.notifyListeners('update', { symbol: sym, quote: quoteObj });
          this.notifyListeners('update', { symbol: `COMEX:${sym}`, quote: quoteObj });
          this.notifyListeners('update', { symbol: upper, quote: quoteObj });
          this.notifyListeners('update', { symbol: `COMEX:${upper}`, quote: quoteObj });

          const aliases = COMEX_ALIAS_MAP[upper] || [];
          for (const alias of aliases) {
            this.notifyListeners('update', { symbol: alias, quote: quoteObj });
            this.notifyListeners('update', { symbol: `COMEX:${alias}`, quote: quoteObj });
          }
        }
      } catch (e) {
        // fail silently
      }
    };

    pollCOMEX();
    this.comexInterval = setInterval(pollCOMEX, 500);
  }

  private overviewInterval: ReturnType<typeof setInterval> | null = null;

  private connectMarketOverview() {
    if (typeof window === 'undefined') return;
    if (this.overviewInterval) return;

    const pollOverview = async () => {
      try {
        const res = await fetch('/api/market/overview', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.quotes) {
          for (const [sym, q] of Object.entries(data.quotes)) {
            this.notifyListeners('update', { symbol: sym, quote: q });
          }
        }
      } catch (e) {
        // fail silently
      }
    };

    pollOverview();
    this.overviewInterval = setInterval(pollOverview, 1000);
  }

  public connect() {
    this.connectBinance();
    this.connectUSStocks();
    this.connectCOMEX();
    this.connectMarketOverview();

    console.log('[MarketWSManager] connect() called, symbolRefCount:', this.symbolRefCount.size, 'ws state:', this.ws?.readyState);

    if (this.symbolRefCount.size === 0) {
      console.log('[MarketWSManager] No symbols to subscribe to, skipping backend WS connect');
      return;
    }

    // Prevent overlapping connection attempts
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('[MarketWSManager] Connection already in progress, skipping');
      return;
    }

    console.log('[MarketWSManager] Starting new WebSocket connection');
    this.disconnectCleanly();

    // Set connection start time for timeout tracking
    this.connectionStartTime = Date.now();

    this.connectionStatus = this.reconnectCount > 0 ? 'reconnecting' : 'connecting';
    this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });

    console.log(`[MarketWSManager] 🔌 Connecting to ${this.wsUrl} (attempt #${this.reconnectCount + 1})...`);

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        console.log('[MarketWSManager] WebSocket connection established successfully.');
        this.reconnectCount = 0;
        this.connectionStatus = 'connected';
        this.lastError = null;
        this.lastMessageReceivedTime = Date.now();
        this.notifyListeners('status', { status: this.connectionStatus, error: null, reconnectCount: 0 });

        // Send all active subscriptions
        const activeSymbols = Array.from(this.symbolRefCount.keys());

        // Also include any pending subscriptions that were queued before connection
        const allSymbols = [...activeSymbols, ...this.pendingSubscriptions];
        const uniqueSymbols = Array.from(new Set(allSymbols));

        if (uniqueSymbols.length > 0) {
          console.log('[MarketWSManager] Subscribing to instruments:', uniqueSymbols);
          this.ws?.send(JSON.stringify({ action: 'subscribe', symbols: uniqueSymbols }));
          this.pendingSubscriptions = []; // Clear pending subscriptions
        }
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        this.lastMessageReceivedTime = Date.now();
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'quotes') {
            this.notifyListeners('quotes', payload.data);
          } else if (payload.type === 'update') {
            this.notifyListeners('update', { symbol: payload.symbol, quote: payload.data });
          } else if (payload.type === 'pong') {
            // Heartbeat response handled
          }
        } catch (err) {
          console.error('[MarketWSManager] error parsing message:', err);
        }
      };

      this.ws.onclose = (event) => {
        console.warn('[MarketWSManager] WebSocket connection closed.', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          url: this.wsUrl
        });
        this.connectionStatus = 'disconnected';
        this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });
        this.stopHeartbeat();
        this.scheduleReconnect();
      };

      this.ws.onerror = (e) => {
        console.warn('[MarketWSManager] WebSocket connection warning:', e);
        this.lastError = 'WebSocket connection failed';
        this.connectionStatus = 'disconnected';
        this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });
      };
    } catch (err: any) {
      console.error('[MarketWSManager] Error during WebSocket instantiation:', err);
      this.lastError = err?.message || 'WebSocket creation failed';
      this.connectionStatus = 'disconnected';
      this.notifyListeners('status', { status: this.connectionStatus, error: this.lastError, reconnectCount: this.reconnectCount });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.symbolRefCount.size === 0) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

    this.reconnectCount++;
    // Exponential backoff with jitter, caps at 10s
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectCount) + Math.random() * 1000, 10000);
    console.log(`[MarketWSManager] Reconnecting in ${delay.toFixed(0)}ms...`);
    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastMessageReceivedTime = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // Send heartbeat ping frame to keep proxy/gate alive and test writeability
          this.ws.send(JSON.stringify({ action: 'ping' }));
        } catch (err) {
          console.warn('[MarketWSManager] ping send failed. Reconnecting.', err);
          this.connect();
          return;
        }

        // If no message has been received for 15 seconds, assume half-open/dormant socket
        if (Date.now() - this.lastMessageReceivedTime > 15000) {
          console.warn('[MarketWSManager] No tick or heartbeat received for 15s. Reconnecting.');
          this.connect();
        }
      }
    }, 5000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private notifyListeners(type: string, data: any) {
    for (const listener of this.listeners) {
      try {
        listener(type, data);
      } catch (err) {
        console.error('[MarketWSManager] error in listener invocation:', err);
      }
    }
  }

  public addListener(listener: (type: string, data: any) => void) {
    this.listeners.add(listener);
  }

  public removeListener(listener: (type: string, data: any) => void) {
    this.listeners.delete(listener);
  }

  public subscribe(symbols: string[]) {
    console.log('[MarketWSManager] subscribe() called with symbols:', symbols, 'current refCount:', this.symbolRefCount.size);

    const toSubscribe: string[] = [];
    for (const sym of symbols) {
      const count = this.symbolRefCount.get(sym) || 0;
      this.symbolRefCount.set(sym, count + 1);
      if (count === 0) toSubscribe.push(sym);
    }

    console.log('[MarketWSManager] After increment, refCount:', this.symbolRefCount.size, 'toSubscribe:', toSubscribe);

    this.connect();

    if (toSubscribe.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      console.log('[MarketWSManager] Sending subscribe message for:', toSubscribe);
      this.ws.send(JSON.stringify({ action: 'subscribe', symbols: toSubscribe }));
    } else {
      console.log('[MarketWSManager] Cannot send subscribe - WebSocket state:', this.ws?.readyState, 'OPEN =', WebSocket.OPEN);
      // If WebSocket isn't open yet, queue the subscription for when it connects
      if (toSubscribe.length > 0) {
        console.log('[MarketWSManager] Queueing subscription for when WebSocket opens');
        // Store pending subscriptions
        this.pendingSubscriptions = [...(this.pendingSubscriptions || []), ...toSubscribe];
      }
    }
  }

  public unsubscribe(symbols: string[]) {
    const toUnsubscribe: string[] = [];
    for (const sym of symbols) {
      const count = this.symbolRefCount.get(sym) || 0;
      if (count <= 1) {
        this.symbolRefCount.delete(sym);
        toUnsubscribe.push(sym);
      } else {
        this.symbolRefCount.set(sym, count - 1);
      }
    }
    if (toUnsubscribe.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', symbols: toUnsubscribe }));
    }
  }

  private static instance: MarketWSManager | null = null;

  public static getInstance(): MarketWSManager {
    if (!MarketWSManager.instance) {
      MarketWSManager.instance = new MarketWSManager();
    }
    return MarketWSManager.instance;
  }

  public get isConnectingOrOpen(): boolean {
    return this.ws !== null && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN);
  }
}

const wsManager = MarketWSManager.getInstance();

/**
 * Single authoritative quote normalizer.
 *
 * Problem: Kite WebSocket ticks carry `bid`/`ask` that are sourced from market
 * depth (best buy/sell price). For deep OTM options the bid side can be near
 * zero (e.g. ₹360) while the last traded price is ₹5,339 — producing a
 * catastrophically wrong displayed spread.
 *
 * Rule: if the raw bid or ask deviates from lastPrice by more than 50 %, it is
 * unreliable depth data. Fall back to a tight synthetic ±0.05 % spread.
 * This threshold is wide enough to cover legitimate wide spreads on illiquid
 * instruments while catching the pathological OTM-option case.
 */
export function normalizeQuote(q: any, symbolKey?: string): QuoteData {
  if (!q) {
    return { lastPrice: 0, change: 0, changePercent: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, bid: 0, ask: 0 };
  }

  const rawSym = (q.symbol || q.tradingsymbol || symbolKey || '').toUpperCase();
  const exchange = (q.exchange || (rawSym.includes(':') ? rawSym.split(':')[0] : '')).toUpperCase();
  const cleanSym = rawSym.replace(/^(CRYPTO|FOREX|MCX|COMEX|NCO|NFO|NSE|BSE):/, '');

  const isForexUsd = ['GBPUSD', 'EURUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'].includes(cleanSym);
  const usdInrRate = 1;

  let close = Number(q.ohlc?.close ?? q.close ?? 0);
  let rawLastPrice = Number(q.last_price ?? q.lastPrice ?? q.price ?? close ?? 0);
  let lastPrice = rawLastPrice > 0 ? rawLastPrice : close;

  let rawBid = Number(q.bid ?? q.bidPrice ?? 0);
  let rawAsk = Number(q.ask ?? q.askPrice ?? 0);
  let open = Number(q.ohlc?.open ?? q.open ?? 0);
  let high = Number(q.ohlc?.high ?? q.high ?? 0);
  let low = Number(q.ohlc?.low ?? q.low ?? 0);

  if (isForexUsd && lastPrice > 0 && lastPrice < 20) {
    lastPrice *= usdInrRate;
    if (close > 0 && close < 20) close *= usdInrRate;
    if (rawBid > 0 && rawBid < 20) rawBid *= usdInrRate;
    if (rawAsk > 0 && rawAsk < 20) rawAsk *= usdInrRate;
    if (open > 0 && open < 20) open *= usdInrRate;
    if (high > 0 && high < 20) high *= usdInrRate;
    if (low > 0 && low < 20) low *= usdInrRate;
  }

  const isCommodity = exchange === 'MCX' || rawSym.startsWith('MCX:') || rawSym.startsWith('MCX-') ||
    ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(c => cleanSym.includes(c));

  const isIndianMarket = exchange === 'NSE' || exchange === 'NFO' || exchange === 'MCX' || exchange === 'BSE' || exchange === 'BFO' || exchange === 'NCO' ||
    rawSym.startsWith('NSE:') || rawSym.startsWith('NFO:') || rawSym.startsWith('MCX:') || rawSym.startsWith('BSE:') || rawSym.startsWith('BFO:') || rawSym.startsWith('NCO:') || rawSym.startsWith('MCX-') ||
    ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL', 'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'].some(c => cleanSym.includes(c));

  // For all Indian market instruments (NSE, NFO, MCX, BSE, BFO), pass real API bid/ask through.
  // For Crypto and Forex, force synthetic buffer calculation (no reliable depth from exchange).
  const forceSynthetic = !isIndianMarket;

  const { bid: finalBid, ask: finalAsk } = normalizeOptionQuoteDepth(
    lastPrice,
    rawBid,
    rawAsk,
    { forceSynthetic, askBuffer: 0, bidBuffer: 0, useSyntheticFallback: true }
  );

  const change = lastPrice > 0 && close > 0 ? lastPrice - close : Number(q.net_change ?? q.change ?? 0);
  const changePercent = close > 0 ? ((lastPrice - close) / close) * 100 : Number(q.changePercent ?? 0);

  return {
    lastPrice: parseFloat(Number(lastPrice).toFixed(4)),
    change: parseFloat(Number(change).toFixed(4)),
    changePercent: parseFloat(Number(changePercent).toFixed(2)),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close,
    volume: Number(q.volume ?? 0),
    bid: parseFloat(Number(finalBid).toFixed(4)),
    ask: parseFloat(Number(finalAsk).toFixed(4)),
  };
}

// Global provider component
export const MarketDataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('marginApex_market_overview_quotes_persisted');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed === 'object') return parsed;
        }
      } catch (e) {}
    }
    return {};
  });
  const [statusInfo, setStatusInfo] = useState<{
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
    lastError: string | null;
    reconnectCount: number;
  }>({
    connectionStatus: 'disconnected',
    lastError: null,
    reconnectCount: 0
  });

  const wsManager = useMemo(() => MarketWSManager.getInstance(), []);
  const pendingUpdatesRef = useRef<Record<string, QuoteData>>({});
  const fetchInitialQuotesRef = useRef<() => void>(() => { });
  const isFetchingRef = useRef<boolean>(false);

  // Connect background WS and ticker streams on mount
  useEffect(() => {
    wsManager.connect();
  }, [wsManager]);

  // Immediately pre-fetch live market overview quotes from Redis (<5ms) on mount
  useEffect(() => {
    fetch('/api/market/overview', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => {
        if (data && data.quotes && Object.keys(data.quotes).length > 0) {
          const normalizedMap: Record<string, QuoteData> = {};
          for (const [sym, q] of Object.entries(data.quotes)) {
            normalizedMap[sym] = normalizeQuote(q, sym);
          }
          setQuotes(prev => {
            const next = { ...prev, ...normalizedMap };
            try { localStorage.setItem('marginApex_market_overview_quotes_persisted', JSON.stringify(next)); } catch {}
            return next;
          });
        }
      })
      .catch(() => {});
  }, []);

  // Flush pending updates every 250ms to reduce render count
  useEffect(() => {
    const flushQuotes = () => {
      const pending = pendingUpdatesRef.current;
      if (Object.keys(pending).length > 0) {
        setQuotes(prev => ({ ...prev, ...pending }));
        pendingUpdatesRef.current = {};
      }
    };
    const flushInterval = setInterval(flushQuotes, 250);
    return () => clearInterval(flushInterval);
  }, []);

  const lastWsTickTimeRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const onMessage = (type: string, data: any) => {
      if (type === 'status') {
        setStatusInfo({
          connectionStatus: data.status,
          lastError: data.error,
          reconnectCount: data.reconnectCount
        });
      } else if (type === 'quotes') {
        const mapped: Record<string, QuoteData> = {};
        const now = Date.now();
        for (const [key, quote] of Object.entries(data)) {
          // Do not allow HTTP fallback quotes to overwrite fresh WS ticks (within last 5s)
          const lastWsTime = lastWsTickTimeRef.current[key] || 0;
          if (now - lastWsTime > 5000) {
            const normalized = normalizeQuote(quote as any, key);
            mapped[key] = normalized;
            if (key.includes(':')) {
              const [prefix, clean] = key.split(':');
              mapped[clean] = normalized;
              const unspaced = clean.replace(/\s+/g, '');
              mapped[unspaced] = normalized;
              mapped[`${prefix}:${unspaced}`] = normalized;
            } else {
              const unspaced = key.replace(/\s+/g, '');
              if (unspaced !== key) mapped[unspaced] = normalized;
            }
          }
        }
        Object.assign(pendingUpdatesRef.current, mapped);
      } else if (type === 'update') {
        const { symbol, quote: q = data.data } = data;
        lastWsTickTimeRef.current[symbol] = Date.now();
        const normalized = normalizeQuote(q, symbol);
        pendingUpdatesRef.current[symbol] = normalized;
        if (symbol && symbol.includes(':')) {
          const [prefix, clean] = symbol.split(':');
          pendingUpdatesRef.current[clean] = normalized;
          const unspaced = clean.replace(/\s+/g, '');
          pendingUpdatesRef.current[unspaced] = normalized;
          pendingUpdatesRef.current[`${prefix}:${unspaced}`] = normalized;
        } else if (symbol) {
          const unspaced = symbol.replace(/\s+/g, '');
          if (unspaced !== symbol) pendingUpdatesRef.current[unspaced] = normalized;
        }
      }
    };

    wsManager.addListener(onMessage);

    const fetchInitialQuotes = async () => {
      // Prevent concurrent overlapping requests from saturating browser connection pool
      if (isFetchingRef.current) return;

      // More aggressive HTTP fallback for page refresh scenarios
      // Always try HTTP fallback if WebSocket isn't actively sending ticks
      const shouldUseHttpFallback =
        wsManager.connectionStatus !== 'connected' ||
        (Date.now() - wsManager.lastMessageReceivedTime > 3000);

      if (!shouldUseHttpFallback) return;

      const symbols = Array.from(wsManager.symbolRefCount.keys());
      if (symbols.length === 0) return;

      isFetchingRef.current = true;

      try {
        // Fallback 1: Local Next.js API route
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch('/api/kite/quotes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ instruments: symbols }),
          signal: controller.signal,
          cache: 'no-store'
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const json = await res.json();
          if (json.data && Object.keys(json.data).length > 0) {
            console.log('[MarketDataProvider] ✓ Quotes fetched via local API');
            onMessage('quotes', json.data);
            return;
          }
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          console.warn('[MarketDataProvider] Local API timeout - trying direct connection');
        } else {
          console.warn('[MarketDataProvider] Local HTTP fallback failed, trying direct ticker daemon:', err);
        }
      }

      // Fallback 2: Direct query to Railway ticker daemon
      try {
        const baseUrl = process.env.NEXT_PUBLIC_TICKER_URL || 'https://marginapexx-production.up.railway.app';

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);

        const res = await fetch(`${baseUrl}/quotes?symbols=${symbols.map(s => encodeURIComponent(String(s))).join(',')}`, {
          signal: controller.signal,
          cache: 'no-store',
          headers: {
            'Accept': 'application/json'
          }
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const json = await res.json();
          if (json.success && json.data && Object.keys(json.data).length > 0) {
            console.log('[MarketDataProvider] ✓ Quotes fetched via direct ticker daemon');
            onMessage('quotes', json.data);
          }
        }
      } catch (err: any) {
        // Failover silent
      } finally {
        isFetchingRef.current = false;
      }
    };

    const pollInterval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        fetchInitialQuotes();
      }
    }, 4000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchInitialQuotes();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibility);
      wsManager.removeListener(onMessage);
    };
  }, []);

  const subscribe = useCallback((symbols: string[]) => {
    const validSymbols = symbols.filter(Boolean);
    if (validSymbols.length > 0) {
      console.log('[MarketDataProvider] Subscribing to symbols:', validSymbols.length, 'symbols');
      wsManager.subscribe(validSymbols);
      if (wsManager.connectionStatus !== 'connected') {
        console.log('[MarketDataProvider] WebSocket not connected, triggering HTTP fallback');
        fetchInitialQuotesRef.current?.();
      }
    }
  }, []);

  const unsubscribe = useCallback((symbols: string[]) => {
    const validSymbols = symbols.filter(Boolean);
    if (validSymbols.length > 0) wsManager.unsubscribe(validSymbols);
  }, []);

  return (
    <MarketDataContext.Provider value={{
      quotes,
      subscribe,
      unsubscribe,
      connectionStatus: statusInfo.connectionStatus,
      lastError: statusInfo.lastError,
      reconnectCount: statusInfo.reconnectCount
    }}>
      {children}
    </MarketDataContext.Provider>
  );
};

export const useGlobalMarketQuotes = () => useContext(MarketDataContext);

