import { getAdminClient } from '../lib/adminClient.ts';
import { PositionService } from '../lib/trading/PositionService.ts';

function timestamp(): string {
  const now = new Date();
  return now.toISOString().substring(11, 23);
}

function printOrder(label: string, order: any) {
  console.log(`  [${label}] ID: ${order?.id}`);
  console.log(`    Status: ${order?.status} | Type: ${order?.order_type} | Side: ${order?.side}`);
  console.log(`    Trigger: ${order?.trigger_price} | SL: ${order?.stop_loss} | Target: ${order?.target}`);
  console.log(`    is_exit: ${order?.is_exit} | info (linked_pos): ${order?.info}`);
}

async function main() {
  console.log(`================================================================`);
  console.log(`STARTING E2E VERIFICATION OF SLM -> GTT MODIFICATION BUG`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`================================================================\n`);

  const admin = getAdminClient();

  // 1. Get test user
  const { data: profiles, error: profErr } = await admin
    .from('profiles')
    .select('id')
    .eq('active', true)
    .limit(1);

  if (profErr || !profiles || profiles.length === 0) {
    console.error('No active test user found:', profErr);
    process.exit(1);
  }
  const userId = profiles[0].id;
  console.log(`Using active user_id: ${userId}`);

  // Construct valid JWT for getUserFromRequest
  const jwtPayload = {
    sub: userId,
    email: 'test@example.com',
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };
  const token = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(jwtPayload)).toString('base64url')}.sig`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const symbol = 'NSE:INFY';
  const segment = 'STOCKS';

  // Fetch live market quote for symbol to ensure trigger prices are valid relative to current LTP
  let liveLtp = 1146.0;
  try {
    const { getSharedKiteSession } = await import('../lib/kiteSession.ts');
    const session = await getSharedKiteSession();
    if (session?.accessToken && process.env.KITE_API_KEY) {
      const qRes = await fetch(`https://api.kite.trade/quote?i=${symbol}`, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${process.env.KITE_API_KEY}:${session.accessToken}`,
        },
      });
      if (qRes.ok) {
        const qJson = await qRes.json();
        if (qJson.data?.[symbol]?.last_price) {
          liveLtp = Number(qJson.data[symbol].last_price);
        }
      }
    }
  } catch (qErr) {
    console.warn('Could not fetch live quote, using fallback:', qErr);
  }

  const ltp = liveLtp;
  console.log(`Live market price (LTP) for ${symbol}: ${ltp}`);

  // Track results
  const results = {
    slm_to_gtt_entry_buy: false,
    slm_to_gtt_entry_sell: false,
    slm_to_gtt_long_exit: false,
    slm_to_gtt_short_exit: false,
    rapid_race_condition: false,
  };

  const logs: string[] = [];
  const log = (msg: string) => {
    const entry = `${timestamp()} — ${msg}`;
    console.log(entry);
    logs.push(entry);
  };

  const triggerBuy = ltp + 50.0;
  const triggerSell = ltp - 50.0;
  const targetBuy = ltp + 100.0;
  const slBuy = ltp - 50.0;
  const targetSell = ltp - 100.0;
  const slSell = ltp + 50.0;

  // --------------------------------------------------------------------------
  // TEST C1: BUY SLM ENTRY -> MODIFY TO GTT
  // --------------------------------------------------------------------------
  log('--- TEST C1: BUY SLM ENTRY -> MODIFY TO GTT ---');
  // Create pending BUY SLM entry order (trigger_price > ltp for BUY SLM)
  const { data: buySlmOrder, error: err1 } = await admin.from('orders').insert({
    user_id: userId,
    symbol: symbol,
    kite_instrument: symbol,
    segment: segment,
    side: 'BUY',
    status: 'PENDING',
    qty: 10,
    lots: 1,
    price: ltp,
    fill_price: ltp,
    trigger_price: triggerBuy,
    ltp_at_entry: ltp,
    order_type: 'SLM',
    product_type: 'INTRADAY',
    is_exit: false,
  }).select().single();

  if (err1 || !buySlmOrder) {
    console.error('Failed to create BUY SLM order:', err1);
    process.exit(1);
  }

  log(`Created BUY SLM Order A ID: ${buySlmOrder.id}`);
  printOrder('OLD ORDER BEFORE MOD', buySlmOrder);

  // Send PUT modification request to local API endpoint
  log(`Sending PUT http://localhost:3000/api/orders/${buySlmOrder.id} (SLM -> GTT)...`);
  const resp1 = await fetch(`http://localhost:3000/api/orders/${buySlmOrder.id}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      order_type: 'GTT',
      target: targetBuy,
      stop_loss: slBuy,
      qty: 10,
    }),
  });

  const body1 = await resp1.json();
  log(`Modify Response Status: ${resp1.status}`);
  log(`Modify Response Body: ${JSON.stringify(body1)}`);

  const newBuyGttId = body1.order?.id;

  // Immediately query DB
  const { data: oldBuyOrderAfter } = await admin.from('orders').select('*').eq('id', buySlmOrder.id).single();
  const { data: newBuyOrderAfter } = await admin.from('orders').select('*').eq('id', newBuyGttId).single();

  log(`[Immediate DB Query]`);
  printOrder('OLD ORDER A AFTER MOD', oldBuyOrderAfter);
  printOrder('NEW ORDER B AFTER MOD', newBuyOrderAfter);

  log(`Waiting 5 seconds...`);
  await new Promise((r) => setTimeout(r, 5000));

  // Re-check after 5 seconds
  const { data: oldBuyOrderFinal } = await admin.from('orders').select('*').eq('id', buySlmOrder.id).single();
  const { data: newBuyOrderFinal } = await admin.from('orders').select('*').eq('id', newBuyGttId).single();

  log(`[Final DB Query after 5s]`);
  printOrder('OLD ORDER A FINAL', oldBuyOrderFinal);
  printOrder('NEW ORDER B FINAL', newBuyOrderFinal);

  if (
    oldBuyOrderFinal.status === 'CANCELLED' &&
    newBuyOrderFinal.status === 'PENDING' &&
    newBuyOrderFinal.order_type === 'GTT' &&
    newBuyOrderFinal.is_exit === false &&
    newBuyOrderFinal.trigger_price === null
  ) {
    results.slm_to_gtt_entry_buy = true;
    log(`✅ TEST C1 PASSED!`);
  } else {
    log(`❌ TEST C1 FAILED!`);
  }

  // --------------------------------------------------------------------------
  // TEST C2: SELL SLM ENTRY -> MODIFY TO GTT
  // --------------------------------------------------------------------------
  log('\n--- TEST C2: SELL SLM ENTRY -> MODIFY TO GTT ---');
  const { data: sellSlmOrder } = await admin.from('orders').insert({
    user_id: userId,
    symbol: symbol,
    kite_instrument: symbol,
    segment: segment,
    side: 'SELL',
    status: 'PENDING',
    qty: 10,
    lots: 1,
    price: ltp,
    fill_price: ltp,
    trigger_price: triggerSell,
    ltp_at_entry: ltp,
    order_type: 'SLM',
    product_type: 'INTRADAY',
    is_exit: false,
  }).select().single();

  log(`Created SELL SLM Order A ID: ${sellSlmOrder.id}`);
  printOrder('OLD ORDER BEFORE MOD', sellSlmOrder);

  log(`Sending PUT http://localhost:3000/api/orders/${sellSlmOrder.id} (SLM -> GTT)...`);
  const resp2 = await fetch(`http://localhost:3000/api/orders/${sellSlmOrder.id}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      order_type: 'GTT',
      target: targetSell,
      stop_loss: slSell,
      qty: 10,
    }),
  });

  const body2 = await resp2.json();
  log(`Modify Response Status: ${resp2.status}`);
  log(`Modify Response Body: ${JSON.stringify(body2)}`);

  const newSellGttId = body2.order?.id;

  log(`Waiting 5 seconds...`);
  await new Promise((r) => setTimeout(r, 5000));

  const { data: oldSellOrderFinal } = await admin.from('orders').select('*').eq('id', sellSlmOrder.id).single();
  const { data: newSellOrderFinal } = await admin.from('orders').select('*').eq('id', newSellGttId).single();

  log(`[Final DB Query after 5s]`);
  printOrder('OLD ORDER A FINAL', oldSellOrderFinal);
  printOrder('NEW ORDER B FINAL', newSellOrderFinal);

  if (
    oldSellOrderFinal.status === 'CANCELLED' &&
    newSellOrderFinal.status === 'PENDING' &&
    newSellOrderFinal.order_type === 'GTT' &&
    newSellOrderFinal.is_exit === false &&
    newSellOrderFinal.trigger_price === null
  ) {
    results.slm_to_gtt_entry_sell = true;
    log(`✅ TEST C2 PASSED!`);
  } else {
    log(`❌ TEST C2 FAILED!`);
  }

  // --------------------------------------------------------------------------
  // TEST B1: LONG POSITION -> PROTECTIVE SLM EXIT -> MODIFY TO GTT EXIT
  // --------------------------------------------------------------------------
  log('\n--- TEST B1: LONG POSITION -> SLM EXIT -> GTT EXIT ---');
  // Open Long Position
  const longPosId = await PositionService.openPosition(
    userId,
    symbol,
    'BUY',
    5,
    1,
    ltp,
    ltp,
    'MARKET',
    'INTRADAY',
    segment,
    symbol,
    true,
    0,
    0
  );
  log(`Opened Long Position ID: ${longPosId}`);

  // Create protective SLM exit order linked to long position (trigger < ltp for Long Exit SL)
  const { data: longExitSlm } = await admin.from('orders').insert({
    user_id: userId,
    symbol: symbol,
    kite_instrument: symbol,
    segment: segment,
    side: 'SELL',
    status: 'PENDING',
    qty: 5,
    lots: 1,
    price: triggerSell,
    fill_price: triggerSell,
    trigger_price: triggerSell,
    ltp_at_entry: ltp,
    order_type: 'SLM',
    product_type: 'INTRADAY',
    is_exit: true,
    info: longPosId,
  }).select().single();

  log(`Created Long Exit SLM Order A ID: ${longExitSlm.id}`);
  printOrder('OLD EXIT ORDER BEFORE MOD', longExitSlm);

  log(`Sending PUT http://localhost:3000/api/orders/${longExitSlm.id} (SLM -> GTT EXIT)...`);
  const respB1 = await fetch(`http://localhost:3000/api/orders/${longExitSlm.id}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      order_type: 'GTT',
      target: targetBuy,
      stop_loss: slBuy,
      is_exit: true,
      linked_position_id: longPosId,
    }),
  });

  const bodyB1 = await respB1.json();
  log(`Modify Response Status: ${respB1.status}`);
  log(`Modify Response Body: ${JSON.stringify(bodyB1)}`);

  const newLongExitGttId = bodyB1.order?.id;

  log(`Waiting 5 seconds...`);
  await new Promise((r) => setTimeout(r, 5000));

  const { data: oldLongExitFinal } = await admin.from('orders').select('*').eq('id', longExitSlm.id).single();
  const { data: newLongExitFinal } = await admin.from('orders').select('*').eq('id', newLongExitGttId).single();

  log(`[Final DB Query after 5s]`);
  printOrder('OLD EXIT ORDER A FINAL', oldLongExitFinal);
  printOrder('NEW EXIT ORDER B FINAL', newLongExitFinal);

  if (
    oldLongExitFinal.status === 'CANCELLED' &&
    newLongExitFinal.status === 'PENDING' &&
    newLongExitFinal.order_type === 'GTT' &&
    newLongExitFinal.is_exit === true &&
    newLongExitFinal.info === longPosId
  ) {
    results.slm_to_gtt_long_exit = true;
    log(`✅ TEST B1 PASSED!`);
  } else {
    log(`❌ TEST B1 FAILED!`);
  }

  // Clean up long position
  await PositionService.closePosition({
    userId,
    positionId: longPosId,
    closeQty: 5,
    closePrice: ltp,
    closedBy: 'TEST_CLEANUP',
    expectedBrokerage: 0,
  });

  // --------------------------------------------------------------------------
  // TEST B2: SHORT POSITION -> PROTECTIVE SLM EXIT -> MODIFY TO GTT EXIT
  // --------------------------------------------------------------------------
  log('\n--- TEST B2: SHORT POSITION -> SLM EXIT -> GTT EXIT ---');
  // Open Short Position
  const shortPosId = await PositionService.openPosition(
    userId,
    symbol,
    'SELL',
    5,
    1,
    ltp,
    ltp,
    'MARKET',
    'INTRADAY',
    segment,
    symbol,
    true,
    0,
    0
  );
  log(`Opened Short Position ID: ${shortPosId}`);

  // Create protective SLM exit order linked to short position (trigger > ltp for Short Exit SL)
  const { data: shortExitSlm } = await admin.from('orders').insert({
    user_id: userId,
    symbol: symbol,
    kite_instrument: symbol,
    segment: segment,
    side: 'BUY',
    status: 'PENDING',
    qty: 5,
    lots: 1,
    price: triggerBuy,
    fill_price: triggerBuy,
    trigger_price: triggerBuy,
    ltp_at_entry: ltp,
    order_type: 'SLM',
    product_type: 'INTRADAY',
    is_exit: true,
    info: shortPosId,
  }).select().single();

  log(`Created Short Exit SLM Order A ID: ${shortExitSlm.id}`);
  printOrder('OLD EXIT ORDER BEFORE MOD', shortExitSlm);

  log(`Sending PUT http://localhost:3000/api/orders/${shortExitSlm.id} (SLM -> GTT EXIT)...`);
  const respB2 = await fetch(`http://localhost:3000/api/orders/${shortExitSlm.id}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      order_type: 'GTT',
      target: targetSell,
      stop_loss: slSell,
      is_exit: true,
      linked_position_id: shortPosId,
    }),
  });

  const bodyB2 = await respB2.json();
  log(`Modify Response Status: ${respB2.status}`);
  log(`Modify Response Body: ${JSON.stringify(bodyB2)}`);

  const newShortExitGttId = bodyB2.order?.id;

  log(`Waiting 5 seconds...`);
  await new Promise((r) => setTimeout(r, 5000));

  const { data: oldShortExitFinal } = await admin.from('orders').select('*').eq('id', shortExitSlm.id).single();
  const { data: newShortExitFinal } = await admin.from('orders').select('*').eq('id', newShortExitGttId).single();

  log(`[Final DB Query after 5s]`);
  printOrder('OLD EXIT ORDER A FINAL', oldShortExitFinal);
  printOrder('NEW EXIT ORDER B FINAL', newShortExitFinal);

  if (
    oldShortExitFinal.status === 'CANCELLED' &&
    newShortExitFinal.status === 'PENDING' &&
    newShortExitFinal.order_type === 'GTT' &&
    newShortExitFinal.is_exit === true &&
    newShortExitFinal.info === shortPosId
  ) {
    results.slm_to_gtt_short_exit = true;
    log(`✅ TEST B2 PASSED!`);
  } else {
    log(`❌ TEST B2 FAILED!`);
  }

  // Clean up short position
  await PositionService.closePosition({
    userId,
    positionId: shortPosId,
    closeQty: 5,
    closePrice: ltp,
    closedBy: 'TEST_CLEANUP',
    expectedBrokerage: 0,
  });

  // --------------------------------------------------------------------------
  // TEST D: RAPID / RACE-CONDITION TIMING TEST (POLLING EVERY 150MS)
  // --------------------------------------------------------------------------
  log('\n--- TEST D: RAPID / RACE-CONDITION TIMING TEST ---');
  const { data: raceSlmOrder } = await admin.from('orders').insert({
    user_id: userId,
    symbol: symbol,
    kite_instrument: symbol,
    segment: segment,
    side: 'BUY',
    status: 'PENDING',
    qty: 10,
    lots: 1,
    price: ltp,
    fill_price: ltp,
    trigger_price: triggerBuy,
    ltp_at_entry: ltp,
    order_type: 'SLM',
    product_type: 'INTRADAY',
    is_exit: false,
  }).select().single();

  log(`Created Race SLM Order A ID: ${raceSlmOrder.id} (trigger_price: ${triggerBuy})`);

  log(`Triggering PUT http://localhost:3000/api/orders/${raceSlmOrder.id}...`);
  const respRacePromise = fetch(`http://localhost:3000/api/orders/${raceSlmOrder.id}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      order_type: 'GTT',
      target: targetBuy,
      stop_loss: slBuy,
    }),
  });

  // Poll DB status every 150ms for 5 seconds
  const statusHistory: { t: string; oldStatus: string; newStatus?: string }[] = [];
  let raceNewOrderId: string | null = null;
  let everExecuted = false;

  const pollInterval = setInterval(async () => {
    const { data: oA } = await admin.from('orders').select('status').eq('id', raceSlmOrder.id).single();
    let oBStatus: string | undefined = undefined;

    if (!raceNewOrderId) {
      const { data: oBSearch } = await admin
        .from('orders')
        .select('id, status')
        .eq('user_id', userId)
        .eq('order_type', 'GTT')
        .order('created_at', { ascending: false })
        .limit(1);
      if (oBSearch && oBSearch.length > 0) {
        raceNewOrderId = oBSearch[0].id;
        oBStatus = oBSearch[0].status;
      }
    } else {
      const { data: oB } = await admin.from('orders').select('status').eq('id', raceNewOrderId).single();
      oBStatus = oB?.status;
    }

    const snap = { t: timestamp(), oldStatus: oA?.status, newStatus: oBStatus };
    statusHistory.push(snap);

    if (oA?.status === 'EXECUTED') {
      everExecuted = true;
    }
  }, 150);

  const raceResp = await respRacePromise;
  const raceBody = await raceResp.json();
  log(`Race Modify Response Status: ${raceResp.status}`);
  log(`Race Modify Response Body: ${JSON.stringify(raceBody)}`);
  raceNewOrderId = raceBody.order?.id;

  await new Promise((r) => setTimeout(r, 5200));
  clearInterval(pollInterval);

  log(`[Race Condition Polling Timeline (sampled every 150ms)]`);
  for (const s of statusHistory.slice(0, 15)) {
    log(`  ${s.t}: Old Order A status: '${s.oldStatus}' | New Order B status: '${s.newStatus ?? 'N/A'}'`);
  }

  const { data: finalOldRace } = await admin.from('orders').select('*').eq('id', raceSlmOrder.id).single();
  const { data: finalNewRace } = await admin.from('orders').select('*').eq('id', raceNewOrderId).single();

  log(`[Race Test Final Check]`);
  printOrder('RACE OLD ORDER A', finalOldRace);
  printOrder('RACE NEW ORDER B', finalNewRace);
  log(`Old Order A ever reached EXECUTED: ${everExecuted}`);

  if (!everExecuted && finalOldRace.status === 'CANCELLED' && finalNewRace.status === 'PENDING') {
    results.rapid_race_condition = true;
    log(`✅ TEST D PASSED! No race condition observed!`);
  } else {
    log(`❌ TEST D FAILED! Race condition detected!`);
  }

  // Clean up remaining pending GTT orders
  await admin.from('orders').update({ status: 'CANCELLED' }).eq('user_id', userId).eq('status', 'PENDING');

  console.log(`\n================================================================`);
  console.log(`FINAL E2E VERIFICATION RESULTS SUMMARY:`);
  console.log(`================================================================`);
  console.log(`1. SLM -> GTT BUY ENTRY:  ${results.slm_to_gtt_entry_buy ? 'PASS' : 'FAIL'}`);
  console.log(`2. SLM -> GTT SELL ENTRY: ${results.slm_to_gtt_entry_sell ? 'PASS' : 'FAIL'}`);
  console.log(`3. SLM -> GTT LONG EXIT:  ${results.slm_to_gtt_long_exit ? 'PASS' : 'FAIL'}`);
  console.log(`4. SLM -> GTT SHORT EXIT: ${results.slm_to_gtt_short_exit ? 'PASS' : 'FAIL'}`);
  console.log(`5. RAPID / RACE-CONDITION:${results.rapid_race_condition ? 'PASS' : 'FAIL'}`);
  console.log(`================================================================\n`);
}

main().catch((err) => {
  console.error('Verification script error:', err);
  process.exit(1);
});
