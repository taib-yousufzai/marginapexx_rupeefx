import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;
let initializedSchema = false;

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

    // Process in batches of 100 to stay well under query parameter limits
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
