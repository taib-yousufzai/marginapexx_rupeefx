import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const SQL_FILES = [
  // ── Schema & infrastructure ────────────────────────────────────────────────
  'supabase/migrations/20260731_isolate_legacy_triggers.sql',
  'supabase/migrations/20260801_idempotency_key.sql',
  'supabase/migrations/20260801_shadow_mode_logs.sql',
  'supabase/migrations/20260801_rpc_metrics.sql',
  'supabase/migrations/20260802_rpc_metrics_correlation.sql',
  'supabase/migrations/20260802_engine_metadata.sql',
  'supabase/migrations/20260802_financial_events_journal.sql',
  'supabase/migrations/20260802_engine_releases.sql',
  'supabase/migrations/20260802_schema_snapshots.sql',
  'supabase/migrations/20260802_add_fee_transaction_type.sql',
  'supabase/migrations/20260829_fix_process_executed_position_info.sql',
  'supabase/migrations/20260829_fix_settlement_rebaseline_positive_debt.sql',
  'supabase/migrations/20260830_enable_realtime_and_polling_sync.sql',
  // ── Position Engine functions (internal helpers first) ────────────────────
  'database_v2/functions/create_position_internal.sql',
  'database_v2/functions/increase_position_internal.sql',
  'database_v2/functions/reduce_position_internal.sql',
  // ── Position Engine public RPCs ───────────────────────────────────────────
  'database_v2/rpc/close_position_v2.sql',
  'database_v2/rpc/place_order_v2.sql',
  'database_v2/rpc/get_trade_context_v2.sql',
  'database_v2/rpc/run_shadow_order_v2.sql',
  'database_v2/rpc/run_shadow_close_v2.sql',
  'database_v2/rpc/apply_carry_charges_v1.sql',
  'database_v2/rpc/convert_position_v1.sql',
  'database_v2/rpc/telemetry_views.sql',
  // ── Test suites (run last — they clean up after themselves) ───────────────
  'database_v2/tests/contract_tests.sql',
  'database_v2/tests/position_engine_validation.sql',
  'database_v2/tests/exit_validation_regression.sql',
];

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const getPassword = (): Promise<string> => {
    if (process.env.SUPABASE_DB_PASSWORD) {
      return Promise.resolve(process.env.SUPABASE_DB_PASSWORD);
    }
    return new Promise((resolve) => {
      rl.question('Enter Supabase Database Password: ', (answer) => {
        resolve(answer);
      });
    });
  };

  const password = await getPassword();
  rl.close();

  const client = new Client({
    host: 'db.cpcvklekwwawgtgbyrmp.supabase.co',
    port: 5432,
    user: 'postgres',
    password: password,
    database: 'postgres',
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('Connecting to Supabase production database...');
    await client.connect();
    console.log('Connected successfully!');

    client.on('notice', (msg) => {
      console.log(`[DB NOTICE] ${msg.message}`);
    });

    for (const fileRelativePath of SQL_FILES) {
      const filePath = path.resolve(process.cwd(), fileRelativePath);
      console.log(`Reading SQL file: ${fileRelativePath}...`);
      const sqlContent = fs.readFileSync(filePath, 'utf8');

      console.log(`Executing SQL file: ${fileRelativePath}...`);
      await client.query(sqlContent);
      console.log(`Successfully executed: ${fileRelativePath}`);
    }

    console.log('================================================================');
    console.log('SUCCESS: All Position Engine database objects deployed!');
    console.log('================================================================');
    console.log('');
    console.log('Next step: run deployment verification to confirm database state.');
    console.log('  npx ts-node scripts/verify_deployment.ts');
    console.log('');
  } catch (err: any) {
    console.error('Migration failed:', err.message || err);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
