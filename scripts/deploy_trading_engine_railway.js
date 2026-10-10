#!/usr/bin/env node

/**
 * Deploys the Railway PostgreSQL Trading Engine schema and stored functions.
 * Usage: node scripts/deploy_trading_engine_railway.js
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Attempt to load .env.local if present
const envLocalPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  const content = fs.readFileSync(envLocalPath, 'utf8');
  content.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      let val = match[2] || '';
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (!process.env[match[1]]) process.env[match[1]] = val;
    }
  });
}

const connectionString =
  process.env.RAILWAY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  null;

if (!connectionString) {
  console.log('ℹ️ No Railway DATABASE_URL found in current environment. Schema will auto-apply when deployed to Railway.');
  process.exit(0);
}

async function run() {
  console.log('🚀 Connecting to Railway Postgres for Trading Engine setup...');
  const isInternal = connectionString.includes('railway.internal');
  const client = new Client({
    connectionString,
    ssl: (!isInternal && !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1'))
      ? { rejectUnauthorized: false }
      : false,
  });

  try {
    await client.connect();
    console.log('✅ Connected successfully to Railway Postgres!');

    const sqlPath = path.join(__dirname, 'railway_trading_engine_setup.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`SQL file not found at ${sqlPath}`);
    }

    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('📄 Executing railway_trading_engine_setup.sql...');
    await client.query(sql);
    console.log('✅ Core trading tables & PL/pgSQL stored procedures created.');

    // Verify
    const res = await client.query(`
      SELECT proname FROM pg_proc 
      WHERE proname IN ('place_order_v2', 'close_position_v2', 'reduce_position_internal', 'clean_symbol_v2')
      ORDER BY proname;
    `);

    console.log('🔍 Verified installed functions:', res.rows.map(r => r.proname).join(', '));
    console.log('🎉 Railway Trading Engine setup completed with 0 errors!\n');
  } catch (err) {
    console.error('❌ Failed to setup Railway Trading Engine:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

run();
