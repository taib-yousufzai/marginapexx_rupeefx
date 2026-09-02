import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function generateTestJwt(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'test@example.com',
    role: 'authenticated',
    aud: 'authenticated',
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

async function runE2EPlaywrightTest() {
  console.log('=== STARTING PLAYWRIGHT END-TO-END VERIFICATION OF SLM -> GTT MODIFICATION ===');

  // 1. Get test user
  const { data: users, error: userErr } = await supabase.auth.admin.listUsers();
  if (userErr || !users.users || users.users.length === 0) {
    throw new Error('No test users found in Supabase Auth');
  }
  const testUser = users.users[0];
  console.log(`Test User ID: ${testUser.id}`);

  // 2. Launch Chromium via Playwright
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'Authorization': `Bearer ${generateTestJwt(testUser.id)}`,
    },
  });
  const page = await context.newPage();

  // 3. Navigate to app homepage
  console.log('Navigating to http://localhost:3000 ...');
  await page.goto('http://localhost:3000');
  const title = await page.title();
  console.log(`Page Title: ${title}`);

  // 4. Create initial pending SLM order
  console.log('\n--- STEP 1: Creating initial pending SLM order ---');
  const { data: initialOrder, error: insertErr } = await supabase
    .from('orders')
    .insert({
      user_id: testUser.id,
      symbol: 'NSE:RELIANCE',
      kite_instrument: 'NSE:RELIANCE',
      segment: 'STOCKS',
      side: 'BUY',
      status: 'PENDING',
      qty: 10,
      lots: 1,
      price: 2500,
      fill_price: 2500,
      trigger_price: 2450,
      ltp_at_entry: 2500,
      order_type: 'SLM',
      product_type: 'INTRADAY',
      is_exit: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (insertErr || !initialOrder) {
    console.error('Failed to insert initial SLM order:', insertErr);
    throw new Error('Initial SLM order insertion failed');
  }

  const oldOrderId = initialOrder.id;
  console.log(`Initial SLM Order Created | ID: ${oldOrderId} | Status: ${initialOrder.status} | Trigger: ${initialOrder.trigger_price}`);

  // 5. Submit modification SLM -> GTT
  console.log('\n--- STEP 2: Modifying SLM order to GTT ---');
  const modifyPayload = {
    order_type: 'GTT',
    trigger_price: 2400,
    stop_loss: 2380,
    target: 2650,
    price: 2500,
    qty: 10,
    is_exit: false,
  };

  const modifyRes = await context.request.put(`http://localhost:3000/api/orders/${oldOrderId}`, {
    data: modifyPayload,
  });

  const modifyJson = await modifyRes.json();
  if (!modifyJson.success || !modifyJson.order) {
    console.error('Failed to modify order:', modifyJson);
    throw new Error('SLM -> GTT modification failed');
  }

  const newOrderId = modifyJson.order.id;
  console.log(`Modification Succeeded | New GTT Order ID: ${newOrderId} | Status: ${modifyJson.order.status}`);

  // 6. Simulate price sync ticks for 5 seconds to test background matching engine stability
  console.log('\n--- STEP 3: Simulating market price ticks & trigger evaluations ---');
  const syncRes = await context.request.get('http://localhost:3000/api/cron/sync-prices');
  console.log(`Price Sync Tick Invoked | Status: ${syncRes.status()}`);

  console.log('Waiting 5 seconds to monitor order statuses in DB...');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 7. Verify DB statuses
  console.log('\n--- STEP 4: Verifying Final Database Order States ---');
  const { data: oldDbOrder } = await supabase.from('orders').select('*').eq('id', oldOrderId).single();
  const { data: newDbOrder } = await supabase.from('orders').select('*').eq('id', newOrderId).single();

  console.log(`OLD SLM Order (${oldOrderId}) DB Status: ${oldDbOrder?.status} (Expected: CANCELLED)`);
  console.log(`NEW GTT Order (${newOrderId}) DB Status: ${newDbOrder?.status} (Expected: PENDING)`);

  let pass = true;

  if (oldDbOrder?.status !== 'CANCELLED') {
    console.error(`FAIL: Old SLM order status is '${oldDbOrder?.status}', expected 'CANCELLED'!`);
    pass = false;
  }

  if (newDbOrder?.status !== 'PENDING') {
    console.error(`FAIL: New GTT order status is '${newDbOrder?.status}', expected 'PENDING'!`);
    pass = false;
  }

  if (pass) {
    console.log('\n===============================================================');
    console.log('✅ ALL VERIFICATION CHECKS PASSED PERFECTLY!');
    console.log('The SLM -> GTT modification bug is completely fixed and verified.');
    console.log('===============================================================\n');
  } else {
    console.error('\n❌ VERIFICATION FAILED!');
  }

  await browser.close();
  if (!pass) process.exit(1);
}

runE2EPlaywrightTest().catch((err) => {
  console.error('Playwright Test Error:', err);
  process.exit(1);
});
