import { getAdminClient } from '@/lib/adminClient';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

function timestamp() {
  return new Date().toISOString();
}

function generateTestJwt(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'test@example.com',
    role: 'authenticated',
    aud: 'authenticated',
  })).toString('base64url');
  const secret = process.env.SUPABASE_JWT_SECRET || 'super-secret-jwt-key-for-development-only-change-in-prod';
  const crypto = require('crypto');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function runForensics() {
  console.log(`\n===============================================================`);
  console.log(`[${timestamp()}] STARTING ROOT CAUSE FORENSICS ON SLM → GTT MODIFICATION`);
  console.log(`===============================================================\n`);

  const admin = getAdminClient();

  // 1. Get active user
  const { data: profiles, error: profErr } = await admin
    .from('profiles')
    .select('id, balance')
    .eq('active', true)
    .limit(1);

  if (profErr || !profiles || profiles.length === 0) {
    console.error('No active test user found:', profErr);
    process.exit(1);
  }

  const userId = profiles[0].id;
  await admin.from('profiles').update({ balance: 1000000 }).eq('id', userId);
  const authHeader = `Bearer ${generateTestJwt(userId)}`;
  console.log(`[${timestamp()}] User ID: ${userId}`);

  const testSymbol = 'NSE:RELIANCE';
  const testKiteInst = 'NSE:RELIANCE';
  const testSegment = 'STOCKS';
  const currentLtp = 2500.0;

  // Step A: Create a pending SLM order (Order A)
  console.log(`\n--- STEP 1: Creating initial pending SLM order (Order A) ---`);
  const slmPayload = {
    user_id: userId,
    symbol: testSymbol,
    kite_instrument: testKiteInst,
    segment: testSegment,
    side: 'BUY',
    status: 'PENDING',
    qty: 10,
    lots: 1,
    price: currentLtp,
    fill_price: currentLtp,
    ltp_at_entry: currentLtp,
    order_type: 'SLM',
    product_type: 'INTRADAY',
    trigger_price: 2450.0, // trigger_price below LTP for BUY SLM so it's pending
    is_exit: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: orderA, error: createErr } = await admin
    .from('orders')
    .insert(slmPayload)
    .select()
    .single();

  if (createErr || !orderA) {
    console.error('Failed to create test SLM order:', createErr);
    process.exit(1);
  }

  console.log(`[${timestamp()}] Order A Created | ID: ${orderA.id} | Type: ${orderA.order_type} | Status: ${orderA.status} | Trigger: ${orderA.trigger_price}`);

  // Step B: Setup DB Snapshot Monitoring
  console.log(`\n--- STEP 2: Starting High-Frequency DB Order Poller (100ms interval for 10s) ---`);
  const monitoredOrderIds = new Set<string>([orderA.id]);
  const orderHistoryMap = new Map<string, { status: string; order_type: string; trigger_price: any; fill_price: any }>();

  orderHistoryMap.set(orderA.id, {
    status: orderA.status,
    order_type: orderA.order_type,
    trigger_price: orderA.trigger_price,
    fill_price: orderA.fill_price,
  });

  const stateChanges: string[] = [];

  let isPolling = true;
  const pollInterval = setInterval(async () => {
    if (!isPolling) return;
    try {
      const ids = Array.from(monitoredOrderIds);
      const { data: fetchedOrders } = await admin
        .from('orders')
        .select('id, status, order_type, trigger_price, fill_price, updated_at, info, is_exit')
        .in('id', ids);

      if (fetchedOrders) {
        for (const ord of fetchedOrders) {
          const prev = orderHistoryMap.get(ord.id);
          if (!prev) {
            orderHistoryMap.set(ord.id, {
              status: ord.status,
              order_type: ord.order_type,
              trigger_price: ord.trigger_price,
              fill_price: ord.fill_price,
            });
            stateChanges.push(`[${timestamp()}] NEW_DISCOVERED | ${ord.id} | ${ord.order_type} | INITIAL: ${ord.status} | Trigger: ${ord.trigger_price}`);
          } else if (prev.status !== ord.status || prev.order_type !== ord.order_type) {
            stateChanges.push(`[${timestamp()}] STATE_CHANGE | ${ord.id} | ${ord.order_type} | ${prev.status} → ${ord.status} | Trigger: ${ord.trigger_price} | Fill: ${ord.fill_price}`);
            orderHistoryMap.set(ord.id, {
              status: ord.status,
              order_type: ord.order_type,
              trigger_price: ord.trigger_price,
              fill_price: ord.fill_price,
            });
          }
        }
      }
    } catch (e) {
      // ignore transient poll errors
    }
  }, 100);

  // Step C: Trigger Order Modification via API (simulating TradeSheet UI request)
  console.log(`\n--- STEP 3: Submitting SLM → GTT Modification Request ---`);
  const modifyPayload = {
    order_type: 'GTT',
    trigger_price: 2400.0,
    stop_loss: 2380.0,
    target: 2650.0,
    qty: 10,
    lots: 1,
  };

  const reqStart = Date.now();
  console.log(`[${timestamp()}] Sending PUT /api/orders/${orderA.id}`);
  const res = await fetch(`http://localhost:3000/api/orders/${orderA.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify(modifyPayload),
  });

  const resBody = await res.json();
  const reqEnd = Date.now();
  console.log(`[${timestamp()}] HTTP Response (${res.status} ${res.statusText}) in ${reqEnd - reqStart}ms:`, JSON.stringify(resBody));

  if (resBody.order && resBody.order.id) {
    monitoredOrderIds.add(resBody.order.id);
    console.log(`[${timestamp()}] Replacement Order B ID Registered: ${resBody.order.id}`);
  }

  // Also query user's orders to discover any duplicate or secondary orders created
  const { data: userOrders } = await admin
    .from('orders')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (userOrders) {
    userOrders.forEach(u => monitoredOrderIds.add(u.id));
  }

  // Step D: Simulate real application background price tick (processPendingOrdersAndPositions)
  console.log(`\n--- STEP 4: Invoking processPendingOrdersAndPositions tick with LTP = 2500.0 ---`);
  const { processPendingOrdersAndPositions } = await import('../lib/orderMatching');
  await processPendingOrdersAndPositions([{ id: 'NSE:RELIANCE', last_price: 2500.0 }]);

  // Monitor for remaining 5 seconds
  await new Promise(r => setTimeout(r, 5000));
  isPolling = false;
  clearInterval(pollInterval);

  // Final database audit
  console.log(`\n--- STEP 5: Final Database Record Snapshot ---`);
  const finalIds = Array.from(monitoredOrderIds);
  const { data: finalRecords } = await admin
    .from('orders')
    .select('*')
    .in('id', finalIds);

  console.log(`\nMonitored Orders Final Status:`);
  finalRecords?.forEach(r => {
    console.log(`Order ID: ${r.id} | Type: ${r.order_type} | Status: ${r.status} | Trigger: ${r.trigger_price} | SL: ${r.stop_loss} | Target: ${r.target} | Info: ${r.info}`);
  });

  console.log(`\nTimeline of Observed State Changes:`);
  if (stateChanges.length === 0) {
    console.log(`(No state changes observed during 10s window beyond initial API response)`);
  } else {
    stateChanges.forEach(sc => console.log(sc));
  }

  console.log(`\n===============================================================`);
  console.log(`[${timestamp()}] FORENSICS RUN COMPLETED`);
  console.log(`===============================================================\n`);
}

runForensics().catch(err => {
  console.error('Forensics script failed:', err);
  process.exit(1);
});
