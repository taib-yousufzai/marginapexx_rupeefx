import dotenv from 'dotenv';
import path from 'path';
import http from 'http';

// Load environment variables from .env first, then .env.local (which can override)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// @ts-ignore
import { KiteTicker } from 'kiteconnect';
import pino from 'pino';
import { getSharedKiteSession, invalidateSharedKiteSessionCache } from '../../lib/kiteSession.ts';
import { KiteSessionMonitor } from './kiteAutoLogin.ts';
import { SubscriptionManager } from './subscriptionManager.ts';
import { DbBatchWriter } from './dbWriter.ts';
import { TickProcessor } from './processor.ts';
import { BinanceTicker } from './binance.ts';
import { WebSocketGateway } from './gateway.ts';
import { CandleAggregator } from './candleAggregator.ts';

import { processPendingOrdersAndPositions } from '../../lib/orderMatching.ts';
import { telemetry } from '../../lib/metrics.ts';
import { getRedisHealthStatus } from '../../lib/redis.ts';

const logger = pino({ name: 'ticker-daemon', level: process.env.LOG_LEVEL || 'info' });

class TickerDaemon {
  private ticker: any = null;
  private subscriptionManager: SubscriptionManager;
  private dbWriter: DbBatchWriter;
  private processor: TickProcessor;
  private binanceTicker: BinanceTicker;
  private sessionMonitor: KiteSessionMonitor;

  private gateway!: WebSocketGateway;
  private candleAggregator!: CandleAggregator;

  private subscriptionTimer: NodeJS.Timeout | null = null;
  private matchingEngineSyncTimer: NodeJS.Timeout | null = null;
  private telemetryTimer: NodeJS.Timeout | null = null;
  private subscriptionDebounce: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;
  private isStopping = false;

  constructor() {
    this.subscriptionManager = new SubscriptionManager();
    // Flush to DB once per 50ms for faster SL/TP and liquidation response
    this.dbWriter = new DbBatchWriter(50);
    this.processor = new TickProcessor(this.subscriptionManager, this.dbWriter);
    this.binanceTicker = new BinanceTicker(this.dbWriter);
    this.sessionMonitor = new KiteSessionMonitor();
  }

  private async initKite() {
    if (this.ticker || this.isReconnecting) return;

    try {
      const session = await getSharedKiteSession();
      if (!session || !session.accessToken) {
        logger.warn('No active Kite session found in database. Triggering automatic login...');
        this.sessionMonitor.forceRefresh();
        return;
      }

      const apiKey = process.env.KITE_API_KEY || process.env.NEXT_PUBLIC_KITE_API_KEY;
      if (!apiKey) {
        logger.error('KITE_API_KEY / NEXT_PUBLIC_KITE_API_KEY not configured in env.');
        return;
      }

      logger.info({ user: session.kiteUserId }, 'Found active Kite session. Connecting Kite Ticker...');

      this.ticker = new KiteTicker({
        api_key: apiKey,
        access_token: session.accessToken,
      });

      this.setupTickerCallbacks();
      this.ticker.connect();
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Kite Ticker');
    }
  }

  public async start() {
    logger.info('Initializing Ticker Daemon...');
    
    // Create combined HTTP server for Health check, REST API, and WebSocket Gateway
    const port = Number(process.env.PORT || 8080);
    const server = http.createServer((req, res) => {
      try {
        const rawUrl = req.url || '/';
        const pathname = rawUrl.split('?')[0];

        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

        // GET /health — structured health check for Railway and monitoring
        if (pathname === '/health' || pathname === '/') {
          const sessionStatus = this.sessionMonitor.getStatus();
          const healthy = this.binanceTicker ? this.binanceTicker.connected : true;
          const redisHealth = getRedisHealthStatus();
          const payload = JSON.stringify({
            status: healthy ? 'ok' : 'degraded',
            uptime: process.uptime(),
            kiteConnected: !!this.ticker && !this.isReconnecting,
            kiteSessionValid: sessionStatus.sessionValid,
            kiteSessionExpiresAt: sessionStatus.expiresAt?.toISOString() ?? null,
            minutesUntilExpiry: sessionStatus.minutesUntilExpiry,
            lastSuccessfulLogin: sessionStatus.lastSuccessfulLogin?.toISOString() ?? null,
            lastLoginAttempt: sessionStatus.lastLoginAttempt?.toISOString() ?? null,
            lastLoginFailure: sessionStatus.lastLoginFailure?.toISOString() ?? null,
            binanceConnected: this.binanceTicker ? this.binanceTicker.connected : false,
            activeOrders: 0,
            activePositions: 0,
            timestamp: new Date().toISOString(),
            ...redisHealth
          });
          res.writeHead(200, jsonHeaders);
          res.end(payload);
          return;
        }

        // GET /metrics — live telemetry from this process
        if (pathname === '/metrics') {
          const summary = telemetry.getSummary();
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify(summary));
          return;
        }

        // GET /quotes — live price quotes by symbol
        if (pathname === '/quotes') {
          const urlObj = new URL(rawUrl, 'http://localhost');
          const symbolsParam = urlObj.searchParams.get('symbols');
          if (symbolsParam) {
            const symbols = symbolsParam.split(',').filter(Boolean);
            const quotes = this.gateway.getQuotes(symbols);
            res.writeHead(200, jsonHeaders);
            res.end(JSON.stringify({ success: true, data: quotes }));
          } else {
            res.writeHead(400, jsonHeaders);
            res.end(JSON.stringify({ success: false, error: 'Missing symbols query param' }));
          }
          return;
        }

        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err: any) {
        logger.error({ err }, 'HTTP Request Handler error');
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
        } catch (_) {}
      }
    });

    this.gateway = new WebSocketGateway(server);
    this.candleAggregator = new CandleAggregator();

    // Link gateway → subscription manager so dynamic client requests
    // (e.g. option chain strikes) are included in Kite subscriptions
    this.subscriptionManager.setGateway(this.gateway);

    // When any frontend client subscribes/unsubscribes symbols, debounce a
    // Kite subscription sync so the new instruments start streaming within ~500ms
    this.gateway.on('subscription-change', () => {
      if (this.subscriptionDebounce) clearTimeout(this.subscriptionDebounce);
      this.subscriptionDebounce = setTimeout(() => {
        logger.info('Frontend subscription change detected — syncing Kite subscriptions...');
        this.syncSubscriptions();
      }, 500);
    });

    // Link dbWriter to gateway and aggregator
    this.dbWriter.setGatewayAndAggregator(this.gateway, this.candleAggregator);

    server.listen(port, '0.0.0.0', () => {
      logger.info(`WebSocket Gateway and HTTP API listening on 0.0.0.0:${port}`);
    });

    logger.info('Stateless order matching mode active.');


    // 2. Start database batch writer
    this.dbWriter.start();

    // 3. Start Binance WebSocket Ticker
    this.binanceTicker.start();

    // 4. Try to initialize Kite Ticker with current session from DB
    const initialSession = await getSharedKiteSession().catch(() => null);
    this.sessionMonitor.setInitialSession(initialSession);
    await this.initKite();

    // 5. Start the self-healing session monitor
    // On 'session-refreshed': tear down old KiteTicker and reconnect with new token
    this.sessionMonitor.on('session-refreshed', async (newSession) => {
      logger.info({ kiteUserId: newSession.kiteUserId, expiresAt: newSession.expiresAt },
        'Session refreshed by auto-login — reconnecting KiteTicker with new token');
      // Cancel any pending reconnectFromScratch timer — we have a fresh token now
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // Cleanly disconnect the old ticker
      if (this.ticker) {
        try { this.ticker.disconnect(); } catch (_) {}
        this.ticker = null;
      }
      // Clear reconnecting flag — session-refreshed is authoritative, it overrides
      // any pending reconnectFromScratch timer so initKite() is allowed to proceed.
      this.isReconnecting = false;
      // Brief pause to let the old connection close
      await new Promise(r => setTimeout(r, 1000));
      await this.initKite();
    });

    this.sessionMonitor.on('session-warning', (minutesLeft: number) => {
      telemetry.triggerAlert('WARNING', `Kite session expires in ${minutesLeft} minutes`);
    });

    this.sessionMonitor.on('login-failed', (err: Error) => {
      telemetry.triggerAlert('WARNING', `Kite auto-login failed: ${err.message}`);
    });

    this.sessionMonitor.on('session-critical', () => {
      telemetry.triggerAlert('CRITICAL', 'Kite session critical — expired or repeated login failures');
    });

    this.sessionMonitor.start();

    // 6. Setup periodic subscription checker (every 60 seconds)
    this.subscriptionTimer = setInterval(async () => {
      if (!this.ticker && !this.isReconnecting) {
        await this.initKite();
      }
      await this.syncSubscriptions();
    }, 60000);

    // Setup periodic matching engine cache sync (every 60 seconds) to self-heal state if Supabase Realtime drops.
    // Run non-blocking — never await in the critical tick path.
    this.matchingEngineSyncTimer = setInterval(() => {
      processPendingOrdersAndPositions([]).catch((err: any) => {
        logger.error({ err }, 'Periodic matching engine cache sync failed');
      });
    }, 60000);

    // Setup realtime listener for instant subscription sync on DB change events
    this.subscriptionManager.setupRealtime(() => {
      this.syncSubscriptions();
    });

    // 7. Periodic system metrics logger + session telemetry sync (every 30 seconds)
    this.telemetryTimer = setInterval(() => {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const processorMetrics = this.processor.getMetrics();
      logger.info({
        cpu: { user: cpu.user, system: cpu.system },
        memory: {
          heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
          rssMb: Math.round(memory.rss / 1024 / 1024),
        },
        ticks: processorMetrics,
      }, 'System Metrics Observability');

      // Push session health into telemetry so /metrics and diagnostics page see it
      const s = this.sessionMonitor.getStatus();
      telemetry.recordKiteSessionStatus(
        s.sessionValid,
        s.expiresAt,
        s.minutesUntilExpiry,
        s.lastSuccessfulLogin,
        s.lastLoginAttempt,
        s.lastLoginFailure,
        s.consecutiveFailures,
      );
    }, 30_000);

    // 8. Register process shutdown handlers
    this.setupGracefulShutdown();
  }


  private setupTickerCallbacks() {
    // Configure auto-reconnect (tries up to 10 times, space 5 seconds apart)
    this.ticker.autoReconnect(true, 10, 5);

    this.ticker.on('connect', () => {
      logger.info('Connected to Kite WebSocket.');
      this.isReconnecting = false;
      this.syncSubscriptions(true); // Force full sync on connect
    });

    this.ticker.on('ticks', (ticks: any[]) => {
      this.processor.processTicks(ticks);
    });

    this.ticker.on('disconnect', (error: any) => {
      logger.warn({ err: error }, 'Kite WebSocket disconnected.');

      // A close code of 1006 paired with an HTTP 403 response means the
      // access_token was rejected by Kite's server. Retrying with the same
      // token (autoReconnect) is pointless — abort the retry loop immediately,
      // bust the session cache, and let reconnectFromScratch pick up a fresh
      // token from the database (or wait for session-refreshed from the monitor).
      const isAuthRejection =
        error?.code === 1006 &&
        (error?.target?._req?.res?.statusCode === 403 ||
          // kiteconnect sometimes serialises the response status on the error object
          error?.status === 403 ||
          error?.statusCode === 403);

      if (isAuthRejection) {
        logger.error(
          { statusCode: error?.target?._req?.res?.statusCode ?? 403 },
          'Kite WebSocket rejected with 403 — token is invalid. Aborting autoReconnect and refreshing session.',
        );
        // Stop autoReconnect so it doesn't keep firing with the dead token
        try { this.ticker.autoReconnect(false); } catch (_) {}
        // Tell the session monitor the token is invalid NOW — this triggers an
        // immediate re-login attempt rather than waiting for the scheduled expiry check.
        this.sessionMonitor.forceRefresh();
        this.reconnectFromScratch(true);
        return;
      }
    });

    this.ticker.on('reconnecting', (interval: number, attempt: number) => {
      logger.info({ attempt, interval }, 'Reconnecting to Kite...');
      this.isReconnecting = true;
    });

    this.ticker.on('noreconnect', () => {
      logger.error('Auto-reconnect failed. Retries exhausted.');
      this.reconnectFromScratch();
    });

    this.ticker.on('error', (error: any) => {
      logger.error({ err: error }, 'Kite Ticker encountered error.');
    });
  }

  /**
   * Syncs active trading instruments in database with active WebSocket subscriptions.
   * Compares the delta to minimize subscribe/unsubscribe messages to Zerodha.
   */
  private async syncSubscriptions(forceSubscribe = false) {
    if (this.isReconnecting || this.isStopping || !this.ticker) return;

    logger.debug('Syncing active instruments with ticker...');
    
    // Fetch latest instruments to track from positions/orders/watchlists
    const activeInstruments = await this.subscriptionManager.getActiveInstruments();
    const activeTokens = activeInstruments.map(item => item.token);

    if (activeTokens.length === 0) {
      logger.debug('No active instruments to subscribe to.');
      return;
    }

    const { toSubscribe, toUnsubscribe } = this.subscriptionManager.calculateSubscriptionDelta(activeTokens);

    try {
      // 1. Process Unsubscriptions
      if (toUnsubscribe.length > 0 && !forceSubscribe) {
        logger.info({ tokens: toUnsubscribe }, 'Unsubscribing from tokens');
        this.ticker.unsubscribe(toUnsubscribe);
      }

      // 2. Process New Subscriptions or Force All on initial connection
      const subscribeList = forceSubscribe ? activeTokens : toSubscribe;
      if (subscribeList.length > 0) {
        logger.info({ count: subscribeList.length }, 'Subscribing to instrument tokens');
        this.ticker.subscribe(subscribeList);
        // Set modeFull to get quotes, volume, open interest, and depth data
        this.ticker.setMode(this.ticker.modeFull, subscribeList);
      }
    } catch (err) {
      logger.error({ err }, 'Error applying subscriptions on ticker');
    }
  }

  private handleCriticalFailure() {
    // Exit process so that container/process manager (PM2/Docker) can restart it with clean state.
    logger.fatal('Critical failure detected. Exiting process...');
    process.exit(1);
  }

  private async reconnectFromScratch(tokenExpired = false) {
    if (this.isStopping) return;

    logger.warn('Attempting a full connection reset in 1 minute to keep process alive...');
    this.isReconnecting = true;

    // 1. Cleanly disconnect existing ticker instance if present
    if (this.ticker) {
      try {
        this.ticker.disconnect();
      } catch (e) {
        // Ignore errors during disconnect
      }
      this.ticker = null;
    }

    // 2. If the disconnect was caused by a rejected (403) token, bust the
    //    in-process session cache immediately so initKite() fetches a fresh
    //    token from Supabase rather than re-using the expired one.
    if (tokenExpired) {
      logger.info('Invalidating session cache due to token rejection before reconnect.');
      invalidateSharedKiteSessionCache();
    }

    // 3. Schedule reconnection after 1 minute (to avoid spamming during market-closed/offline periods)
    this.reconnectTimer = setTimeout(async () => {
      if (this.isStopping) return;
      this.reconnectTimer = null;
      logger.info('Re-initializing KiteTicker connection...');
      this.isReconnecting = false;
      // Always bust the cache right before reconnecting — ensures we pick up any
      // session that may have been renewed by the session monitor in the interim.
      invalidateSharedKiteSessionCache();
      await this.initKite();
    }, 60000);
  }

  private setupGracefulShutdown() {
    const shutdown = async (signal: string) => {
      if (this.isStopping) return;
      this.isStopping = true;

      logger.info({ signal }, 'Graceful shutdown initiated...');

      if (this.subscriptionTimer)       clearInterval(this.subscriptionTimer);
      if (this.matchingEngineSyncTimer) clearInterval(this.matchingEngineSyncTimer);
      if (this.telemetryTimer)          clearInterval(this.telemetryTimer);
      if (this.subscriptionDebounce)    clearTimeout(this.subscriptionDebounce);
      if (this.reconnectTimer)          clearTimeout(this.reconnectTimer);

      // Stop the session monitor so it doesn't attempt login during shutdown
      this.sessionMonitor.stop();

      try {
        if (this.ticker) {
          logger.info('Disconnecting ticker WebSocket...');
          this.ticker.disconnect();
        }

        logger.info('Stopping Binance WebSocket Ticker...');
        this.binanceTicker.stop();

        this.candleAggregator.stop();

        await this.dbWriter.stop();
        logger.info('Graceful cleanup completed. Exiting.');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during graceful cleanup. Forcing exit.');
        process.exit(1);
      }
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// Start the daemon
new TickerDaemon().start().catch((err) => {
  logger.error({ err }, 'Failed to start Ticker Daemon');
  process.exit(1);
});
