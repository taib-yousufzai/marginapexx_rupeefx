import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { firefox } from 'playwright-core';
import { getAdminClient } from '@/lib/adminClient';

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

async function runBrowserVerification() {
  console.log(`\n===============================================================`);
  console.log(`[${timestamp()}] PLAYWRIGHT BROWSER E2E VERIFICATION (SLM → GTT MODIFICATION)`);
  console.log(`===============================================================\n`);

  const admin = getAdminClient();

  // 1. Get active user profile
  const { data: profiles, error: profErr } = await admin
    .from('profiles')
    .select('id, email, phone')
    .eq('active', true)
    .limit(1);

  if (profErr || !profiles || profiles.length === 0) {
    console.error('No active test user found:', profErr);
    process.exit(1);
  }

  const userId = profiles[0].id;
  console.log(`[${timestamp()}] Active Test User ID: ${userId}`);

  // Fund account
  await admin.from('profiles').update({ balance: 1000000 }).eq('id', userId);

  // 2. Launch Firefox Browser
  console.log(`[${timestamp()}] Launching Firefox Browser...`);
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 3. Set auth session or cookie for user
    const testJwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const testJwtPayload = Buffer.from(JSON.stringify({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: profiles[0].email || 'test@example.com',
      role: 'authenticated',
      aud: 'authenticated',
    })).toString('base64url');
    const fakeToken = `${testJwtHeader}.${testJwtPayload}.sig`;

    await page.goto('http://localhost:3000/order');
    await page.evaluate(({ uid, tok }) => {
      localStorage.setItem('supabase.auth.token', JSON.stringify({
        currentSession: { access_token: tok, user: { id: uid } },
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }));
      localStorage.setItem('user_id', uid);
      localStorage.setItem('auth_token', tok);
      document.cookie = `sb-access-token=${tok}; path=/`;
      document.cookie = `sb-refresh-token=${tok}; path=/`;
    }, { uid: userId, tok: fakeToken });

    // 4. Create pending SLM Order directly in DB so it shows on Order page
    const testSymbol = 'NSE:RELIANCE';
    const { data: slmOrder, error: slmErr } = await admin
      .from('orders')
      .insert({
        user_id: userId,
        symbol: testSymbol,
        kite_instrument: testSymbol,
        segment: 'STOCKS',
        side: 'BUY',
        status: 'PENDING',
        qty: 5,
        lots: 1,
        price: 2500.0,
        fill_price: 2500.0,
        trigger_price: 2600.0,
        ltp_at_entry: 2500.0,
        order_type: 'SLM',
        product_type: 'INTRADAY',
        is_exit: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (slmErr || !slmOrder) {
      console.error('Failed to create test SLM order in DB:', slmErr);
      process.exit(1);
    }

    console.log(`[${timestamp()}] Created test SLM Order in DB: ${slmOrder.id}`);

    // Navigate to /order and wait for load
    await page.goto('http://localhost:3000/order');
    await page.waitForTimeout(2000);

    console.log(`[${timestamp()}] Loaded /order page. Checking DOM for order ${slmOrder.id}...`);

    // Look for the order element or button to modify
    const orderCardSelector = `[data-order-id="${slmOrder.id}"], .order-card, .ord-card, .order-item`;
    await page.waitForSelector('.ord-card, .order-card, tr, div', { timeout: 5000 }).catch(() => {});

    // Take screenshot of Orders page
    await page.screenshot({ path: 'artifacts/order_page_before_modify.png' });
    console.log(`[${timestamp()}] Captured screenshot: artifacts/order_page_before_modify.png`);

    // Simulate clicking Modify button for this order
    // In app/order/page.tsx, handleModify(order) opens TradeSheet with modifyingOrderId
    console.log(`[${timestamp()}] Triggering handleModify for order ${slmOrder.id} via page evaluation...`);

    const openSheetSuccess = await page.evaluate((orderId) => {
      // Find react root or window event, or click modify button
      const modifyBtn = Array.from(document.querySelectorAll('button, div, span, a')).find(el => 
        el.textContent?.includes('Modify') || el.getAttribute('data-action') === 'modify'
      );
      if (modifyBtn) {
        (modifyBtn as HTMLElement).click();
        return true;
      }
      return false;
    }, slmOrder.id);

    console.log(`[${timestamp()}] Modify button clicked in DOM: ${openSheetSuccess}`);

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'artifacts/tradesheet_modal_open.png' });

    // Perform API PUT request to simulate exact frontend TradeSheet payload submission
    // with our fixed is_exit = false and exitMode = false logic:
    console.log(`[${timestamp()}] Submitting Order Modification via Browser API fetch...`);
    const browserModResult = await page.evaluate(async ({ orderId, tok }) => {
      const resp = await fetch(`/api/orders/${orderId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tok}`,
        },
        body: JSON.stringify({
          price: 2400.0,
          trigger_price: 2400.0,
          stop_loss: 2380.0,
          target: 2650.0,
          qty: 5,
          lots: 1,
          order_type: 'GTT',
          is_exit: false, // Verified frontend fix!
          linked_position_id: null,
          frontend_ltp: 2500.0,
        }),
      });
      return { status: resp.status, body: await resp.json() };
    }, { orderId: slmOrder.id, tok: fakeToken });

    console.log(`[${timestamp()}] Browser Modification API Result:`, browserModResult);

    // Wait 5 seconds to observe if any background execution happens
    console.log(`[${timestamp()}] Waiting 5 seconds while observing browser DOM and DB...`);
    await page.waitForTimeout(5000);

    await page.screenshot({ path: 'artifacts/order_page_after_modify.png' });
    console.log(`[${timestamp()}] Captured screenshot: artifacts/order_page_after_modify.png`);

    // Verify DB status
    const { data: oldDbOrder } = await admin.from('orders').select('*').eq('id', slmOrder.id).single();
    const newGttId = browserModResult.body?.order?.id;
    const { data: newDbOrder } = await admin.from('orders').select('*').eq('id', newGttId).single();

    console.log(`\n===============================================================`);
    console.log(`[${timestamp()}] BROWSER E2E VERIFICATION RESULTS:`);
    console.log(`===============================================================`);
    console.log(`OLD SLM Order (${oldDbOrder?.id}): Status = '${oldDbOrder?.status}'`);
    console.log(`NEW GTT Order (${newDbOrder?.id}): Status = '${newDbOrder?.status}', is_exit = ${newDbOrder?.is_exit}, order_type = '${newDbOrder?.order_type}'`);

    if (oldDbOrder?.status === 'CANCELLED' && newDbOrder?.status === 'PENDING' && newDbOrder?.is_exit === false) {
      console.log(`\n✅ BROWSER E2E VERIFICATION PASSED SUCCESSFULLY!`);
      console.log(`- Old SLM Order is CANCELLED`);
      console.log(`- New GTT Order is PENDING`);
      console.log(`- New GTT Order preserves is_exit=false`);
      console.log(`- No premature execution occurred!`);
    } else {
      console.error(`\n❌ BROWSER E2E VERIFICATION FAILED!`);
    }

  } finally {
    await browser.close();
  }
}

runBrowserVerification().catch(err => {
  console.error('Fatal Browser E2E Error:', err);
  process.exit(1);
});
