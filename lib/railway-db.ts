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
 * Ensures the action_logs table schema exists in Railway Postgres.
 */
export async function ensureActionLogsSchema(): Promise<void> {
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
    `);
    initializedSchema = true;
  } catch (err: any) {
    console.warn('[Railway-Postgres] Schema init warning:', err.message);
  }
}

/**
 * Executes a parameterized SQL query against Railway Postgres with automatic schema init.
 */
export async function queryRailwayDb<T = any>(text: string, params: any[] = []): Promise<T[] | null> {
  const db = getRailwayPool();
  if (!db) return null;

  try {
    await ensureActionLogsSchema();
    const res = await db.query(text, params);
    return res.rows as T[];
  } catch (err: any) {
    console.warn('[Railway-Postgres] Query error:', err.message);
    return null;
  }
}
