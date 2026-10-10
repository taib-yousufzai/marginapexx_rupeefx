/**
 * 12:00 AM Midnight EOD Bulk Sync: Railway Postgres → Supabase
 *
 * GET  /api/cron/eod-sync-supabase?secret=...
 * POST /api/cron/eod-sync-supabase
 *
 * Runs once a day at 12:00 AM midnight (off-peak).
 * Dumps all completed orders, positions, transactions, and profile balances
 * from Railway PostgreSQL into Supabase in bulk batches.
 *
 * Result:
 * - Supabase is fully updated with the day's completed activity.
 * - Zero daytime I/O load on Supabase during active trading hours.
 */

import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/adminClient';
import {
  isRailwayDbConfigured,
  getRailwayPool,
  getRailwayActivitySince,
} from '@/lib/railway-db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes

export async function runEodSyncToSupabase(sinceHours = 26): Promise<{
  success: boolean;
  synced: {
    orders: number;
    positions: number;
    transactions: number;
    profiles: number;
  };
  durationMs: number;
  error?: string;
}> {
  const startTime = Date.now();

  if (!isRailwayDbConfigured()) {
    return {
      success: true,
      synced: { orders: 0, positions: 0, transactions: 0, profiles: 0 },
      durationMs: 0,
      error: 'Railway DB not configured; skipping sync',
    };
  }

  const admin = getAdminClient();
  const sinceTimestamp = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  console.log(`[EOD-Sync] Starting midnight bulk sync from Railway to Supabase for changes since ${sinceTimestamp}...`);

  // 1. Fetch changed activity from Railway Postgres
  const activity = await getRailwayActivitySince(sinceTimestamp);
  if (!activity) {
    throw new Error('Failed to query Railway database activity');
  }

  const { orders, positions, transactions } = activity;
  let syncedOrders = 0;
  let syncedPositions = 0;
  let syncedTransactions = 0;
  let syncedProfiles = 0;

  // 2. Batch upsert orders in chunks of 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const chunk = orders.slice(i, i + BATCH_SIZE);
    const { error } = await admin
      .from('orders')
      .upsert(chunk, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.warn('[EOD-Sync] Orders chunk upsert error:', error.message);
    } else {
      syncedOrders += chunk.length;
    }
  }

  // 3. Batch upsert positions in chunks of 100
  for (let i = 0; i < positions.length; i += BATCH_SIZE) {
    const chunk = positions.slice(i, i + BATCH_SIZE);
    const { error } = await admin
      .from('positions')
      .upsert(chunk, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.warn('[EOD-Sync] Positions chunk upsert error:', error.message);
    } else {
      syncedPositions += chunk.length;
    }
  }

  // 4. Batch upsert transactions in chunks of 100
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const chunk = transactions.slice(i, i + BATCH_SIZE);
    const { error } = await admin
      .from('transactions')
      .upsert(chunk, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.warn('[EOD-Sync] Transactions chunk upsert error:', error.message);
    } else {
      syncedTransactions += chunk.length;
    }
  }

  // 5. Sync profile balances from Railway Postgres
  const pool = getRailwayPool();
  if (pool) {
    try {
      const pRes = await pool.query(
        `SELECT id, balance FROM public.profiles WHERE updated_at >= $1::timestamptz;`,
        [sinceTimestamp]
      );

      if (pRes.rows && pRes.rows.length > 0) {
        for (const row of pRes.rows) {
          const { error } = await admin
            .from('profiles')
            .update({ balance: Number(row.balance), updated_at: new Date().toISOString() })
            .eq('id', row.id);
          if (!error) syncedProfiles++;
        }
      }
    } catch (pErr: any) {
      console.warn('[EOD-Sync] Profiles balance sync error:', pErr.message);
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(`[EOD-Sync] Finished in ${durationMs}ms:`, {
    syncedOrders,
    syncedPositions,
    syncedTransactions,
    syncedProfiles,
  });

  return {
    success: true,
    synced: {
      orders: syncedOrders,
      positions: syncedPositions,
      transactions: syncedTransactions,
      profiles: syncedProfiles,
    },
    durationMs,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  const authHeader = request.headers.get('authorization');
  const validSecret = process.env.AUTOLOGIN_SECRET || process.env.CRON_SECRET || 'qwertyuiopasdfghjklzxcvbnm';

  if (secret !== validSecret && authHeader !== `Bearer ${validSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const hours = parseInt(searchParams.get('hours') || '26', 10);
    const res = await runEodSyncToSupabase(hours);
    return NextResponse.json(res);
  } catch (err: any) {
    console.error('[EOD-Sync] Handler Error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
