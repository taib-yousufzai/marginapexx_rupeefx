import { Pool, PoolConfig } from 'pg';
import fs from 'fs';
import path from 'path';

let pool: Pool | null = null;
let initializedSchema = false;
let initializedTradingEngineSchema = false;

/**
 * Returns the configured Railway Postgres database connection URL.
 */
export function getRailwayDbUrl(): string | null {
  return (
    process.env.RAILWAY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    null
  );
}

/**
 * Returns true if a Railway Postgres database URL is available.
 */
export function isRailwayDbConfigured(): boolean {
  return Boolean(getRailwayDbUrl());
}

/**
 * Returns or initializes the pg connection pool for Railway Postgres.
 */
export function getRailwayPool(): Pool | null {
  const connectionString = getRailwayDbUrl();
  if (!connectionString) return null;

  if (!pool) {
    const isInternal = connectionString.includes('railway.internal');
    const poolConfig: PoolConfig = {
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    // For external/proxied connections, enable SSL without strict certificate validation
    if (!isInternal && !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1')) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    pool = new Pool(poolConfig);

    pool.on('error', (err) => {
      console.warn('[Railway-Postgres] Idle client error:', err.message);
    });
  }

  return pool;
}

/**
 * Ensures required table schemas exist in Railway Postgres.
 */
export async function ensureRailwaySchema(): Promise<void> {
  if (initializedSchema) return;
  const db = getRailwayPool();
  if (!db) return;

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        created_at timestamptz DEFAULT now() NOT NULL,
        user_id uuid,
        username text,
        role text,
        session_id text,
        ip_address text,
        user_agent text,
        device text,
        browser text,
        platform text,
        action_type text NOT NULL,
        module text NOT NULL,
        api_endpoint text,
        http_method text,
        request_payload jsonb,
        response_status integer,
        is_success boolean DEFAULT true NOT NULL,
        error_message text,
        stack_trace text,
        trade_id uuid,
        order_id uuid,
        position_id uuid,
        wallet_before numeric(20, 2),
        wallet_after numeric(20, 2),
        margin_before numeric(20, 2),
        margin_after numeric(20, 2),
        metadata jsonb
      );

      CREATE INDEX IF NOT EXISTS action_logs_created_at_idx ON action_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS action_logs_user_id_idx ON action_logs (user_id);
      CREATE INDEX IF NOT EXISTS action_logs_action_type_idx ON action_logs (action_type);
      CREATE INDEX IF NOT EXISTS action_logs_module_idx ON action_logs (module);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        created_at timestamptz DEFAULT now() NOT NULL,
        actor_id uuid,
        target_id uuid,
        action text NOT NULL,
        metadata jsonb
      );

      CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_logs_actor_id_idx ON audit_logs (actor_id);

      CREATE TABLE IF NOT EXISTS historical_candles (
        symbol text NOT NULL,
        timestamp timestamptz NOT NULL,
        interval text NOT NULL,
        open numeric NOT NULL,
        high numeric NOT NULL,
        low numeric NOT NULL,
        close numeric NOT NULL,
        volume bigint NOT NULL,
        PRIMARY KEY (symbol, timestamp, interval)
      );

      CREATE INDEX IF NOT EXISTS historical_candles_sym_int_time_idx ON historical_candles (symbol, interval, timestamp DESC);

      CREATE TABLE IF NOT EXISTS instruments (
        id text PRIMARY KEY,
        instrument_token bigint NOT NULL,
        tradingsymbol text NOT NULL,
        name text,
        exchange text,
        instrument_type text,
        segment text,
        expiry text,
        strike_price numeric,
        option_type text,
        underlying_symbol text,
        updated_at timestamptz DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_instruments_tradingsymbol ON instruments (tradingsymbol);
      CREATE INDEX IF NOT EXISTS idx_instruments_name ON instruments (name);
      CREATE INDEX IF NOT EXISTS idx_instruments_exchange_segment ON instruments (exchange, segment);

      CREATE TABLE IF NOT EXISTS notifications (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id uuid NOT NULL,
        type text NOT NULL,
        title text NOT NULL,
        message text NOT NULL,
        read boolean DEFAULT false NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_user_id_read ON notifications (user_id, read);
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

      CREATE TABLE IF NOT EXISTS dashboard_cache (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id uuid NOT NULL,
        date_from date,
        date_to date,
        metrics jsonb NOT NULL,
        computed_at timestamptz DEFAULT now() NOT NULL,
        CONSTRAINT dashboard_cache_user_date_unique UNIQUE (user_id, date_from, date_to)
      );

      CREATE INDEX IF NOT EXISTS idx_dashboard_cache_lookup ON dashboard_cache (user_id, date_from, date_to, computed_at DESC);
    `);
    initializedSchema = true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] Schema init warning:', err.message);
  }
}

/**
 * Backward compatibility alias for action logs init.
 */
export async function ensureActionLogsSchema(): Promise<void> {
  return ensureRailwaySchema();
}

/**
 * Executes a parameterized SQL query against Railway Postgres with automatic schema init.
 */
export async function queryRailwayDb<T = any>(text: string, params: any[] = []): Promise<T[] | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureRailwaySchema();
    const res = await db.query(text, params);
    return res.rows as T[];
  } catch (err: any) {
    console.warn('[Railway-Postgres] Query error:', err.message);
    return null;
  }
}

/**
 * Logs an administrative action to Railway Postgres audit_logs.
 */
export async function logAuditToRailway(
  actorId: string,
  targetId: string | null,
  action: string,
  metadata: Record<string, any> = {}
): Promise<boolean> {
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureRailwaySchema();
    await db.query(
      `INSERT INTO audit_logs (actor_id, target_id, action, metadata) VALUES ($1, $2, $3, $4)`,
      [actorId, targetId, action, JSON.stringify(metadata)]
    );
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] logAudit error:', err.message);
    return false;
  }
}

export interface CandleRow {
  symbol: string;
  timestamp: string;
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Bulk persists completed candlesticks to Railway Postgres historical_candles.
 */
export async function persistCandlesToRailway(candles: CandleRow[]): Promise<boolean> {
  if (!candles || candles.length === 0) return true;
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureRailwaySchema();

    const CHUNK_SIZE = 100;
    for (let i = 0; i < candles.length; i += CHUNK_SIZE) {
      const chunk = candles.slice(i, i + CHUNK_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      chunk.forEach((c, idx) => {
        const offset = idx * 8;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
        );
        values.push(
          c.symbol,
          c.timestamp,
          c.interval,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume
        );
      });

      const queryText = `
        INSERT INTO historical_candles (symbol, timestamp, interval, open, high, low, close, volume)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (symbol, timestamp, interval) DO UPDATE
        SET open = EXCLUDED.open,
            high = EXCLUDED.high,
            low = EXCLUDED.low,
            close = EXCLUDED.close,
            volume = EXCLUDED.volume;
      `;

      await db.query(queryText, values);
    }
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] persistCandles error:', err.message);
    return false;
  }
}

/**
 * Queries OHLCV candles from Railway Postgres historical_candles.
 */
export async function getCandlesFromRailway(
  symbolOrSymbols: string | string[],
  interval: string,
  from: string,
  to: string,
  limit: number = 200
): Promise<any[] | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureRailwaySchema();
    const symbols = Array.isArray(symbolOrSymbols) ? symbolOrSymbols : [symbolOrSymbols];

    const queryText = `
      SELECT symbol, timestamp, interval, open, high, low, close, volume
      FROM historical_candles
      WHERE symbol = ANY($1::text[])
        AND interval = $2
        AND timestamp >= $3::timestamptz
        AND timestamp <= $4::timestamptz
      ORDER BY timestamp ASC
      LIMIT $5;
    `;

    const res = await db.query(queryText, [symbols, interval, from, to, limit]);
    if (!res.rows) return null;

    return res.rows.map(r => ({
      symbol: r.symbol,
      timestamp: typeof r.timestamp === 'string' ? r.timestamp : r.timestamp.toISOString(),
      interval: r.interval,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  } catch (err: any) {
    console.warn('[Railway-Postgres] getCandles error:', err.message);
    return null;
  }
}

/**
 * Upserts instrument metadata to Railway Postgres for fast lookups.
 */
export async function upsertInstrumentsToRailway(instruments: any[]): Promise<boolean> {
  if (!instruments || instruments.length === 0) return true;
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureRailwaySchema();
    const CHUNK_SIZE = 100;
    for (let i = 0; i < instruments.length; i += CHUNK_SIZE) {
      const chunk = instruments.slice(i, i + CHUNK_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      chunk.forEach((ins, idx) => {
        const offset = idx * 11;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`
        );
        values.push(
          ins.id,
          ins.instrument_token || 0,
          ins.tradingsymbol || '',
          ins.name || null,
          ins.exchange || null,
          ins.instrument_type || null,
          ins.segment || null,
          ins.expiry || null,
          ins.strike_price || null,
          ins.option_type || null,
          ins.underlying_symbol || null
        );
      });

      const text = `
        INSERT INTO instruments (id, instrument_token, tradingsymbol, name, exchange, instrument_type, segment, expiry, strike_price, option_type, underlying_symbol)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (id) DO UPDATE SET
          instrument_token = EXCLUDED.instrument_token,
          tradingsymbol = EXCLUDED.tradingsymbol,
          name = COALESCE(EXCLUDED.name, instruments.name),
          exchange = COALESCE(EXCLUDED.exchange, instruments.exchange),
          instrument_type = COALESCE(EXCLUDED.instrument_type, instruments.instrument_type),
          segment = COALESCE(EXCLUDED.segment, instruments.segment),
          expiry = COALESCE(EXCLUDED.expiry, instruments.expiry),
          strike_price = COALESCE(EXCLUDED.strike_price, instruments.strike_price),
          option_type = COALESCE(EXCLUDED.option_type, instruments.option_type),
          underlying_symbol = COALESCE(EXCLUDED.underlying_symbol, instruments.underlying_symbol),
          updated_at = now();
      `;
      await db.query(text, values);
    }
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] upsertInstruments error:', err.message);
    return false;
  }
}

export interface NotificationRow {
  user_id: string;
  type: string;
  title: string;
  message: string;
  read?: boolean;
  created_at?: string;
}

/**
 * Inserts one or more notifications into Railway Postgres.
 */
export async function insertNotificationsToRailway(
  notifications: NotificationRow | NotificationRow[]
): Promise<boolean> {
  const list = Array.isArray(notifications) ? notifications : [notifications];
  if (list.length === 0) return true;
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureRailwaySchema();
    const CHUNK_SIZE = 100;
    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
      const chunk = list.slice(i, i + CHUNK_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      chunk.forEach((n, idx) => {
        const offset = idx * 6;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`);
        values.push(
          n.user_id,
          n.type || 'GENERAL',
          n.title,
          n.message,
          Boolean(n.read),
          n.created_at || new Date().toISOString()
        );
      });

      const text = `
        INSERT INTO notifications (user_id, type, title, message, read, created_at)
        VALUES ${placeholders.join(', ')};
      `;
      await db.query(text, values);
    }
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] insertNotifications error:', err.message);
    return false;
  }
}

/**
 * Fetches notifications for a user from Railway Postgres.
 */
export async function getUserNotificationsFromRailway(
  userId: string,
  limit: number = 50,
  unreadOnly: boolean = false
): Promise<any[] | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureRailwaySchema();
    let text = `
      SELECT id, type, title, message, read, created_at
      FROM notifications
      WHERE user_id = $1::uuid
    `;
    const params: any[] = [userId];

    if (unreadOnly) {
      text += ` AND read = false`;
    }

    text += ` ORDER BY created_at DESC LIMIT $${params.length + 1};`;
    params.push(limit);

    const res = await db.query(text, params);
    return res.rows ?? [];
  } catch (err: any) {
    console.warn('[Railway-Postgres] getUserNotifications error:', err.message);
    return null;
  }
}

/**
 * Marks notifications as read in Railway Postgres.
 */
export async function markNotificationsReadInRailway(
  userId: string,
  id: string
): Promise<boolean> {
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureRailwaySchema();
    if (id === 'all') {
      await db.query(
        `UPDATE notifications SET read = true WHERE user_id = $1::uuid AND read = false;`,
        [userId]
      );
    } else {
      await db.query(
        `UPDATE notifications SET read = true WHERE user_id = $1::uuid AND id = $2::uuid;`,
        [userId, id]
      );
    }
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] markNotificationsRead error:', err.message);
    return false;
  }
}

/**
 * Reads fresh cached metrics (< 5 minutes old) from Railway Postgres dashboard_cache.
 */
export async function getDashboardCacheFromRailway(
  userId: string,
  dateFrom: string | null,
  dateTo: string | null
): Promise<any | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureRailwaySchema();
    const text = `
      SELECT metrics
      FROM dashboard_cache
      WHERE user_id = $1::uuid
        AND (date_from IS NOT DISTINCT FROM $2::date)
        AND (date_to IS NOT DISTINCT FROM $3::date)
        AND computed_at > (now() - interval '5 minutes')
      ORDER BY computed_at DESC
      LIMIT 1;
    `;
    const res = await db.query(text, [userId, dateFrom, dateTo]);
    if (res.rows && res.rows.length > 0) {
      return res.rows[0].metrics;
    }
    return null;
  } catch (err: any) {
    console.warn('[Railway-Postgres] getDashboardCache error:', err.message);
    return null;
  }
}

/**
 * Upserts computed metrics into Railway Postgres dashboard_cache.
 */
export async function upsertDashboardCacheToRailway(
  userId: string,
  dateFrom: string | null,
  dateTo: string | null,
  metrics: any
): Promise<boolean> {
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureRailwaySchema();
    const text = `
      INSERT INTO dashboard_cache (user_id, date_from, date_to, metrics, computed_at)
      VALUES ($1::uuid, $2::date, $3::date, $4::jsonb, now())
      ON CONFLICT (user_id, date_from, date_to) DO UPDATE
      SET metrics = EXCLUDED.metrics,
          computed_at = now();
    `;
    await db.query(text, [userId, dateFrom, dateTo, JSON.stringify(metrics)]);
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] upsertDashboardCache error:', err.message);
    return false;
  }
}

// ==============================================================================
// RAILWAY TRADING ENGINE CORE (Sub-15ms In-Cluster Execution)
// ==============================================================================

let tradingEngineSqlCache: string | null = null;

function getTradingEngineSql(): string | null {
  if (tradingEngineSqlCache) return tradingEngineSqlCache;
  const targetPath = path.join(process.cwd(), 'scripts', 'railway_trading_engine_setup.sql');
  try {
    if (fs.existsSync(targetPath)) {
      tradingEngineSqlCache = fs.readFileSync(targetPath, 'utf8');
      return tradingEngineSqlCache;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Ensures that high-performance trading engine tables and PL/pgSQL functions
 * exist in Railway Postgres (profiles, orders, positions, transactions, place_order_v2, etc.).
 */
export async function ensureTradingEngineSchema(): Promise<void> {
  if (initializedTradingEngineSchema) return;
  const db = getRailwayPool();
  if (!db) return;

  try {
    await ensureRailwaySchema();

    // Check if place_order_v2 exists
    const checkRes = await db.query(`
      SELECT 1 FROM pg_proc WHERE proname = 'place_order_v2' LIMIT 1;
    `);

    if (checkRes.rows && checkRes.rows.length > 0) {
      initializedTradingEngineSchema = true;
      return;
    }

    const sql = getTradingEngineSql();
    if (sql) {
      await db.query(sql);
      initializedTradingEngineSchema = true;
      console.log('[Railway-Postgres] Trading engine schema & functions initialized successfully');
    }
  } catch (err: any) {
    console.warn('[Railway-Postgres] Trading engine schema init warning:', err.message);
  }
}

/**
 * Synchronizes or mirrors a user balance to Railway Postgres profiles.
 */
export async function syncProfileBalanceToRailway(
  userId: string,
  balance: number
): Promise<boolean> {
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureTradingEngineSchema();
    await db.query(`
      INSERT INTO public.profiles (id, balance, active, updated_at)
      VALUES ($1::uuid, $2::numeric, true, now())
      ON CONFLICT (id) DO UPDATE
      SET balance = EXCLUDED.balance,
          updated_at = now();
    `, [userId, balance]);
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] syncProfileBalance error:', err.message);
    return false;
  }
}

/**
 * Reads user balance directly from Railway Postgres (< 1ms).
 */
export async function getRailwayUserBalance(userId: string): Promise<number | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const res = await db.query(
      `SELECT balance FROM public.profiles WHERE id = $1::uuid LIMIT 1;`,
      [userId]
    );
    if (res.rows && res.rows.length > 0) {
      return Number(res.rows[0].balance);
    }
    return null;
  } catch (err: any) {
    console.warn('[Railway-Postgres] getRailwayUserBalance error:', err.message);
    return null;
  }
}

/**
 * Reads active open positions directly from Railway Postgres (< 1ms).
 */
export async function getRailwayOpenPositions(userId: string): Promise<any[] | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const res = await db.query(`
      SELECT 
        id, user_id, symbol, side, status, pnl, qty_open, qty_total, avg_price,
        entry_price, ltp, exit_price, duration_seconds, brokerage, entry_brokerage,
        sl, tp, stop_loss, target, locked_margin, margin_required, lots,
        product_type, settlement, closed_by, is_closed, entry_time, exit_time,
        created_at, updated_at
      FROM public.positions
      WHERE user_id = $1::uuid
        AND LOWER(status) IN ('open', 'active', 'partially_closed', 'partial_closed')
      ORDER BY entry_time DESC;
    `, [userId]);
    return res.rows ?? [];
  } catch (err: any) {
    console.warn('[Railway-Postgres] getRailwayOpenPositions error:', err.message);
    return null;
  }
}

/**
 * Reads pending orders directly from Railway Postgres (< 1ms).
 */
export async function getRailwayPendingOrders(userId: string): Promise<any[] | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const res = await db.query(`
      SELECT 
        id, user_id, symbol, kite_instrument, segment, side, status, qty, lots,
        price, fill_price, ltp_at_entry, order_type, product_type, info, is_exit,
        trigger_price, stop_loss, target, buffer_fee, brokerage, idempotency_key,
        linked_position_id, created_at, updated_at
      FROM public.orders
      WHERE user_id = $1::uuid
        AND UPPER(status) IN ('PENDING', 'TRIGGER_PENDING')
      ORDER BY created_at DESC;
    `, [userId]);
    return res.rows ?? [];
  } catch (err: any) {
    console.warn('[Railway-Postgres] getRailwayPendingOrders error:', err.message);
    return null;
  }
}

/**
 * Fetches existing pending exit orders for duplicate exit guard (< 1ms).
 */
export async function getRailwayExistingExitOrders(
  userId: string,
  symbol: string,
  side: string
): Promise<any[] | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const res = await db.query(`
      SELECT id, symbol, side, status, is_exit, info, linked_position_id
      FROM public.orders
      WHERE user_id = $1::uuid
        AND (symbol = $2 OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2($2))
        AND side = $3
        AND is_exit = true
        AND UPPER(status) IN ('PENDING', 'TRIGGER_PENDING')
      LIMIT 5;
    `, [userId, symbol, side]);
    return res.rows ?? [];
  } catch (err: any) {
    console.warn('[Railway-Postgres] getRailwayExistingExitOrders error:', err.message);
    return null;
  }
}

/**
 * Cancels orders directly in Railway Postgres (< 1ms).
 */
export async function cancelRailwayOrders(
  userId: string,
  orderIds: string[],
  reason: string = 'Replaced by new exit order'
): Promise<boolean> {
  if (!orderIds || orderIds.length === 0) return true;
  const db = getRailwayPool();
  if (!db) return false;

  try {
    await ensureTradingEngineSchema();
    await db.query(`
      UPDATE public.orders
      SET status = 'CANCELLED',
          updated_at = now(),
          info = $3
      WHERE user_id = $1::uuid
        AND id = ANY($2::uuid[]);
    `, [userId, orderIds, reason]);
    return true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] cancelRailwayOrders error:', err.message);
    return false;
  }
}

export interface RailwayPlaceOrderParams {
  userId: string;
  symbol: string;
  kiteInst?: string | null;
  segment?: string | null;
  side: string;
  orderType: string;
  productType?: string | null;
  qty: number;
  lots?: number;
  ltp: number;
  fillPrice: number;
  isExit: boolean;
  bufferFee?: number;
  status: string;
  triggerPrice?: number | null;
  stopLoss?: number | null;
  target?: number | null;
  info?: string | null;
  expectedMargin?: number;
  expectedBrokerage?: number;
  idempotencyKey?: string | null;
  linkedPositionId?: string | null;
}

/**
 * Executes public.place_order_v2 natively inside Railway Postgres (< 5ms).
 */
export async function executePlaceOrderInRailway(
  params: RailwayPlaceOrderParams
): Promise<{ orderId: string } | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const res = await db.query(`
      SELECT public.place_order_v2(
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::text,
        $8::numeric,
        $9::numeric,
        $10::numeric,
        $11::numeric,
        $12::boolean,
        $13::numeric,
        $14::text,
        $15::numeric,
        $16::numeric,
        $17::numeric,
        $18::text,
        $19::numeric,
        $20::numeric,
        $21::text,
        $22::uuid
      ) as order_id;
    `, [
      params.userId,
      params.symbol,
      params.kiteInst || null,
      params.segment || null,
      params.side,
      params.orderType,
      params.productType || 'INTRADAY',
      params.qty,
      params.lots || 0,
      params.ltp,
      params.fillPrice,
      params.isExit,
      params.bufferFee || 0,
      params.status,
      params.triggerPrice || null,
      params.stopLoss || null,
      params.target || null,
      params.info || null,
      params.expectedMargin || 0,
      params.expectedBrokerage || 0,
      params.idempotencyKey || null,
      params.linkedPositionId || null,
    ]);

    if (res.rows && res.rows[0]?.order_id) {
      return { orderId: res.rows[0].order_id };
    }
    return null;
  } catch (err: any) {
    console.error('[Railway-Postgres] executePlaceOrder error:', err.message);
    throw err;
  }
}

export interface RailwayClosePositionParams {
  positionId: string;
  closeQty: number;
  closePrice: number;
  closedBy?: string;
  expectedBrokerage?: number;
  idempotencyKey?: string | null;
  skipCancelOrders?: boolean;
}

/**
 * Executes public.close_position_v2 natively inside Railway Postgres (< 5ms).
 */
export async function executeClosePositionInRailway(
  params: RailwayClosePositionParams
): Promise<{ pnl: number } | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const res = await db.query(`
      SELECT public.close_position_v2(
        $1::uuid,
        $2::numeric,
        $3::numeric,
        $4::text,
        $5::numeric,
        $6::text,
        $7::boolean
      ) as pnl;
    `, [
      params.positionId,
      params.closeQty,
      params.closePrice,
      params.closedBy || 'USER',
      params.expectedBrokerage || 0,
      params.idempotencyKey || null,
      Boolean(params.skipCancelOrders),
    ]);

    if (res.rows && res.rows[0]) {
      return { pnl: Number(res.rows[0].pnl) };
    }
    return null;
  } catch (err: any) {
    console.error('[Railway-Postgres] executeClosePosition error:', err.message);
    throw err;
  }
}

/**
 * Immediately retrieves server-confirmed order and resulting position
 * directly from Railway Postgres for instant UI mounting without optimistic guesses (< 1ms).
 */
export async function getRailwayOrderAndPosition(
  orderId: string,
  userId: string
): Promise<{ order: any; position: any | null } | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const orderRes = await db.query(
      `SELECT * FROM public.orders WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1;`,
      [orderId, userId]
    );

    if (!orderRes.rows || orderRes.rows.length === 0) return null;
    const order = orderRes.rows[0];

    // Find position if linked or matching
    let position = null;
    if (order.info && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order.info)) {
      const posRes = await db.query(
        `SELECT * FROM public.positions WHERE id = $1::uuid LIMIT 1;`,
        [order.info]
      );
      if (posRes.rows && posRes.rows.length > 0) {
        position = posRes.rows[0];
      }
    }

    if (!position && !order.is_exit) {
      // Find latest open position for this user & symbol
      const posRes = await db.query(`
        SELECT * FROM public.positions
        WHERE user_id = $1::uuid AND symbol = $2
          AND LOWER(status) IN ('open', 'active')
        ORDER BY created_at DESC LIMIT 1;
      `, [userId, order.symbol]);
      if (posRes.rows && posRes.rows.length > 0) {
        position = posRes.rows[0];
      }
    }

    return { order, position };
  } catch (err: any) {
    console.warn('[Railway-Postgres] getRailwayOrderAndPosition error:', err.message);
    return null;
  }
}

/**
 * Fetches all orders, positions, and transactions created/updated on or after sinceTimestamp
 * for the 12:00 AM Midnight EOD sync to Supabase.
 */
export async function getRailwayActivitySince(sinceTimestamp: string): Promise<{
  orders: any[];
  positions: any[];
  transactions: any[];
} | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureTradingEngineSchema();
    const [ordersRes, positionsRes, transactionsRes] = await Promise.all([
      db.query(`SELECT * FROM public.orders WHERE updated_at >= $1::timestamptz ORDER BY updated_at ASC;`, [sinceTimestamp]),
      db.query(`SELECT * FROM public.positions WHERE updated_at >= $1::timestamptz ORDER BY updated_at ASC;`, [sinceTimestamp]),
      db.query(`SELECT * FROM public.transactions WHERE updated_at >= $1::timestamptz ORDER BY updated_at ASC;`, [sinceTimestamp]),
    ]);

    return {
      orders: ordersRes.rows ?? [],
      positions: positionsRes.rows ?? [],
      transactions: transactionsRes.rows ?? [],
    };
  } catch (err: any) {
    console.warn('[Railway-Postgres] getRailwayActivitySince error:', err.message);
    return null;
  }
}

