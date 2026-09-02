import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { getAdminClient } from '@/lib/adminClient';
import { PositionService } from '@/lib/trading/PositionService';

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  return `${header}.${payload}.sig`;
}

async function runE2EVerification() {
  console.log(`\n===============================================================`);
  console.log(`[${timestamp()}] STARTING FULL E2E SLM → GTT MODIFICATION VERIFICATION`);
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
  console.log(`[${timestamp()}] Active Test User ID: ${userId} (Funded Balance: ₹1,000,000)`);

  const testSymbol = 'NSE:RELIANCE';
  const testKiteInst = 'NSE:RELIANCE';
  const testSegment = 'STOCKS';
  const currentLtp = 2500.0;

  const testResults = {
    testA_entry: false,
    testB_longExit: false,
    testB_shortExit: false,
    testC_buyEntryRegression: false,
    testC_sellEntryRegression: false,
    raceConditionTest: false,
  };

  // --------------------------------------------------------------------------
  // TEST A: Normal SLM → GTT ENTRY
  // --------------------------------------------------------------------------
  console.log(`\n---------------------------------------------------------------`);
  console.log(`[${timestamp()}] TEST A: Normal SLM → GTT ENTRY Modification`);
  console.log(`---------------------------------------------------------------`);

  // Place pending BUY SLM Entry order
  const { data: slmOrderA, error: errA } = await admin
    .from('orders')
    .insert({
      user_id: userId,
      symbol: testSymbol,
      kite_instrument: testKiteInst,
      segment: testSegment,
      side: 'BUY',
      status: 'PENDING',
      qty: 5,
      lots: 1,
      price: currentLtp,
      fill_price: currentLtp,
      trigger_price: 2600.0, // Trigger above LTP for BUY SLM
      ltp_at_entry: currentLtp,
      order_type: 'SLM',
      product_type: 'INTRADAY',
      is_exit: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (errA || !slmOrderA) {
    console.error(`❌ TEST A Setup Failed:`, errA);
    process.exit(1);
  }

  console.log(`[${timestamp()}] OLD SLM Order Created Snapshot:`);
  console.log({
    id: slmOrderA.id,
    status: slmOrderA.status,
    order_type: slmOrderA.order_type,
    side: slmOrderA.side,
    trigger_price: slmOrderA.trigger_price,
    stop_loss: slmOrderA.stop_loss,
    target: slmOrderA.target,
    is_exit: slmOrderA.is_exit,
    linked_position_id: slmOrderA.info,
  });

  // Call API or handleModifyOrder logic via direct API simulation
  console.log(`[${timestamp()}] Sending modify request (SLM → GTT)...`);

  const modRes = await fetch('http://localhost:3000/api/orders/' + slmOrderA.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({
      order_type: 'GTT',
      trigger_price: 2400.0,
      stop_loss: 2380.0,
      target: 2650.0,
      price: 2400.0,
      qty: 5,
      frontend_ltp: currentLtp,
    }),
  });

  const modData = await modRes.json();
  console.log(`[${timestamp()}] Modify Response Status: ${modRes.status}`, modData);

  // Immediate DB check
  const { data: oldAfterMod } = await admin.from('orders').select('*').eq('id', slmOrderA.id).single();
  const newOrderId = modData.order?.id;
  const { data: newAfterMod } = await admin.from('orders').select('*').eq('id', newOrderId).single();

  console.log(`[${timestamp()}] Immediate DB Check:`);
  console.log(`OLD Order (${oldAfterMod?.id}): status='${oldAfterMod?.status}', order_type='${oldAfterMod?.order_type}'`);
  console.log(`NEW Order (${newAfterMod?.id}): status='${newAfterMod?.status}', order_type='${newAfterMod?.order_type}', trigger=${newAfterMod?.trigger_price}, SL=${newAfterMod?.stop_loss}, Target=${newAfterMod?.target}, is_exit=${newAfterMod?.is_exit}`);

  // Wait 5 seconds to verify no delayed execution occurs
  console.log(`[${timestamp()}] Waiting 5 seconds to confirm stability...`);
  await sleep(5000);

  const { data: oldAfter5s } = await admin.from('orders').select('*').eq('id', slmOrderA.id).single();
  const { data: newAfter5s } = await admin.from('orders').select('*').eq('id', newOrderId).single();

  console.log(`[${timestamp()}] DB Check After 5s:`);
  console.log(`OLD Order (${oldAfter5s?.id}): status='${oldAfter5s?.status}'`);
  console.log(`NEW Order (${newAfter5s?.id}): status='${newAfter5s?.status}'`);

  if (oldAfter5s?.status === 'CANCELLED' && newAfter5s?.status === 'PENDING' && newAfter5s?.order_type === 'GTT') {
    console.log(`✅ TEST A PASSED: OLD SLM is CANCELLED, NEW GTT is PENDING and did not execute immediately.`);
    testResults.testA_entry = true;
  } else {
    console.error(`❌ TEST A FAILED! OLD: ${oldAfter5s?.status}, NEW: ${newAfter5s?.status}`);
  }

  // --------------------------------------------------------------------------
  // TEST B: EXIT ORDERS (LONG EXIT & SHORT EXIT)
  // --------------------------------------------------------------------------
  console.log(`\n---------------------------------------------------------------`);
  console.log(`[${timestamp()}] TEST B1: LONG EXIT (BUY Position -> SLM Exit -> GTT Exit)`);
  console.log(`---------------------------------------------------------------`);

  // Open BUY position
  await PositionService.openPosition(
    userId,
    testSymbol,
    'BUY',
    10,
    1,
    currentLtp,
    currentLtp,
    'MARKET',
    'INTRADAY',
    testSegment,
    testKiteInst,
    true,
    0,
    0
  );

  const openLongPos = await PositionService.getOpenPosition(userId, testSymbol);
  const longPosId = openLongPos?.id;
  console.log(`[${timestamp()}] Created LONG Position ID: ${longPosId}`);

  // Place protective SLM EXIT order
  const { data: slmLongExit } = await admin
    .from('orders')
    .insert({
      user_id: userId,
      symbol: testSymbol,
      kite_instrument: testKiteInst,
      segment: testSegment,
      side: 'SELL',
      status: 'PENDING',
      qty: 10,
      lots: 1,
      price: 2450.0,
      fill_price: 2450.0,
      trigger_price: 2450.0, // Below LTP for LONG SL Exit
      ltp_at_entry: currentLtp,
      order_type: 'SLM',
      product_type: 'INTRADAY',
      is_exit: true,
      info: longPosId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  console.log(`[${timestamp()}] Created SLM LONG Exit Order ID: ${slmLongExit?.id}, is_exit: ${slmLongExit?.is_exit}, linked_position: ${slmLongExit?.info}`);

  // Modify SLM Exit → GTT Exit
  const modLongRes = await fetch('http://localhost:3000/api/orders/' + slmLongExit?.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({
      order_type: 'GTT',
      stop_loss: 2400.0,
      target: 2700.0,
      qty: 10,
      is_exit: true,
      linked_position_id: longPosId,
      frontend_ltp: currentLtp,
    }),
  });

  const modLongData = await modLongRes.json();
  console.log(`[${timestamp()}] LONG EXIT Modify Response Status: ${modLongRes.status}`, modLongData);
  const newLongGttId = modLongData.order?.id;

  await sleep(5000);

  const { data: oldLongExit5s } = await admin.from('orders').select('*').eq('id', slmLongExit?.id).single();
  const { data: newLongGtt5s } = await admin.from('orders').select('*').eq('id', newLongGttId).single();

  console.log(`[${timestamp()}] LONG EXIT Check After 5s:`);
  console.log(`OLD SLM Exit (${oldLongExit5s?.id}): status='${oldLongExit5s?.status}'`);
  console.log(`NEW GTT Exit (${newLongGtt5s?.id}): status='${newLongGtt5s?.status}', is_exit=${newLongGtt5s?.is_exit}, info=${newLongGtt5s?.info}`);

  if (
    oldLongExit5s?.status === 'CANCELLED' &&
    newLongGtt5s?.status === 'PENDING' &&
    newLongGtt5s?.is_exit === true &&
    newLongGtt5s?.info === longPosId
  ) {
    console.log(`✅ TEST B1 PASSED: LONG SLM EXIT → GTT EXIT preserved exit flags and position linkage cleanly.`);
    testResults.testB_longExit = true;
  } else {
    console.error(`❌ TEST B1 FAILED!`);
  }

  // Clean up long position
  if (longPosId) {
    try {
      await PositionService.closePosition({
        userId,
        positionId: longPosId,
        closeQty: 10,
        closePrice: currentLtp,
        closedBy: 'USER',
        expectedBrokerage: 0,
      });
    } catch (e: any) {
      console.log(`[${timestamp()}] Long position cleanup note: ${e.message}`);
    }
  }

  console.log(`\n---------------------------------------------------------------`);
  console.log(`[${timestamp()}] TEST B2: SHORT EXIT (SELL Position -> SLM Exit -> GTT Exit)`);
  console.log(`---------------------------------------------------------------`);

  // Open SELL position
  await PositionService.openPosition(
    userId,
    testSymbol,
    'SELL',
    10,
    1,
    currentLtp,
    currentLtp,
    'MARKET',
    'INTRADAY',
    testSegment,
    testKiteInst,
    true,
    0,
    0
  );

  const openShortPos = await PositionService.getOpenPosition(userId, testSymbol);
  const shortPosId = openShortPos?.id;
  console.log(`[${timestamp()}] Created SHORT Position ID: ${shortPosId}`);

  // Place protective SLM BUY Exit order
  const { data: slmShortExit } = await admin
    .from('orders')
    .insert({
      user_id: userId,
      symbol: testSymbol,
      kite_instrument: testKiteInst,
      segment: testSegment,
      side: 'BUY',
      status: 'PENDING',
      qty: 10,
      lots: 1,
      price: 2550.0,
      fill_price: 2550.0,
      trigger_price: 2550.0, // Above LTP for SHORT SL Exit
      ltp_at_entry: currentLtp,
      order_type: 'SLM',
      product_type: 'INTRADAY',
      is_exit: true,
      info: shortPosId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  console.log(`[${timestamp()}] Created SLM SHORT Exit Order ID: ${slmShortExit?.id}, is_exit: ${slmShortExit?.is_exit}, linked_position: ${slmShortExit?.info}`);

  // Modify SLM Exit → GTT Exit
  const modShortRes = await fetch('http://localhost:3000/api/orders/' + slmShortExit?.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({
      order_type: 'GTT',
      stop_loss: 2600.0,
      target: 2300.0,
      qty: 10,
      is_exit: true,
      linked_position_id: shortPosId,
      frontend_ltp: currentLtp,
    }),
  });

  const modShortData = await modShortRes.json();
  console.log(`[${timestamp()}] SHORT EXIT Modify Response Status: ${modShortRes.status}`, modShortData);
  const newShortGttId = modShortData.order?.id;

  await sleep(5000);

  const { data: oldShortExit5s } = await admin.from('orders').select('*').eq('id', slmShortExit?.id).single();
  const { data: newShortGtt5s } = await admin.from('orders').select('*').eq('id', newShortGttId).single();

  console.log(`[${timestamp()}] SHORT EXIT Check After 5s:`);
  console.log(`OLD SLM Exit (${oldShortExit5s?.id}): status='${oldShortExit5s?.status}'`);
  console.log(`NEW GTT Exit (${newShortGtt5s?.id}): status='${newShortGtt5s?.status}', is_exit=${newShortGtt5s?.is_exit}, info=${newShortGtt5s?.info}`);

  if (
    oldShortExit5s?.status === 'CANCELLED' &&
    newShortGtt5s?.status === 'PENDING' &&
    newShortGtt5s?.is_exit === true &&
    newShortGtt5s?.info === shortPosId
  ) {
    console.log(`✅ TEST B2 PASSED: SHORT SLM EXIT → GTT EXIT preserved exit flags and position linkage cleanly.`);
    testResults.testB_shortExit = true;
  } else {
    console.error(`❌ TEST B2 FAILED!`);
  }

  // Clean up short position
  if (shortPosId) {
    try {
      await PositionService.closePosition({
        userId,
        positionId: shortPosId,
        closeQty: 10,
        closePrice: currentLtp,
        closedBy: 'USER',
        expectedBrokerage: 0,
      });
    } catch (e: any) {
      console.log(`[${timestamp()}] Short position cleanup note: ${e.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // TEST C: ENTRY ORDER REGRESSION (BUY SLM ENTRY & SELL SLM ENTRY -> GTT)
  // --------------------------------------------------------------------------
  console.log(`\n---------------------------------------------------------------`);
  console.log(`[${timestamp()}] TEST C: ENTRY ORDER REGRESSION (BUY & SELL SLM ENTRY -> GTT)`);
  console.log(`---------------------------------------------------------------`);

  // BUY ENTRY
  const { data: buyEntrySlm } = await admin
    .from('orders')
    .insert({
      user_id: userId,
      symbol: testSymbol,
      kite_instrument: testKiteInst,
      segment: testSegment,
      side: 'BUY',
      status: 'PENDING',
      qty: 2,
      lots: 1,
      price: currentLtp,
      fill_price: currentLtp,
      trigger_price: 2600.0,
      ltp_at_entry: currentLtp,
      order_type: 'SLM',
      product_type: 'INTRADAY',
      is_exit: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  const buyEntryRes = await fetch('http://localhost:3000/api/orders/' + buyEntrySlm?.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({
      order_type: 'GTT',
      trigger_price: 2400.0,
      price: 2400.0,
      qty: 2,
      is_exit: false,
      frontend_ltp: currentLtp,
    }),
  });

  const buyEntryData = await buyEntryRes.json();
  const newBuyEntryGttId = buyEntryData.order?.id;

  await sleep(2000);

  const { data: newBuyEntryGtt } = await admin.from('orders').select('*').eq('id', newBuyEntryGttId).single();
  if (newBuyEntryGtt?.is_exit === false && newBuyEntryGtt?.status === 'PENDING') {
    console.log(`✅ TEST C1 (BUY ENTRY REGRESSION) PASSED: preserved is_exit=false and remains PENDING.`);
    testResults.testC_buyEntryRegression = true;
  } else {
    console.error(`❌ TEST C1 FAILED!`);
  }

  // SELL ENTRY
  const { data: sellEntrySlm } = await admin
    .from('orders')
    .insert({
      user_id: userId,
      symbol: testSymbol,
      kite_instrument: testKiteInst,
      segment: testSegment,
      side: 'SELL',
      status: 'PENDING',
      qty: 2,
      lots: 1,
      price: currentLtp,
      fill_price: currentLtp,
      trigger_price: 2400.0,
      ltp_at_entry: currentLtp,
      order_type: 'SLM',
      product_type: 'INTRADAY',
      is_exit: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  const sellEntryRes = await fetch('http://localhost:3000/api/orders/' + sellEntrySlm?.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({
      order_type: 'GTT',
      trigger_price: 2600.0,
      price: 2600.0,
      qty: 2,
      is_exit: false,
      frontend_ltp: currentLtp,
    }),
  });

  const sellEntryData = await sellEntryRes.json();
  const newSellEntryGttId = sellEntryData.order?.id;

  await sleep(2000);

  const { data: newSellEntryGtt } = await admin.from('orders').select('*').eq('id', newSellEntryGttId).single();
  if (newSellEntryGtt?.is_exit === false && newSellEntryGtt?.status === 'PENDING') {
    console.log(`✅ TEST C2 (SELL ENTRY REGRESSION) PASSED: preserved is_exit=false and remains PENDING.`);
    testResults.testC_sellEntryRegression = true;
  } else {
    console.error(`❌ TEST C2 FAILED!`);
  }

  // --------------------------------------------------------------------------
  // HIGH-FREQUENCY RACE CONDITION TEST (Polling every 100ms for 5 seconds)
  // --------------------------------------------------------------------------
  console.log(`\n---------------------------------------------------------------`);
  console.log(`[${timestamp()}] HIGH-FREQUENCY RACE CONDITION MONITORING TEST`);
  console.log(`---------------------------------------------------------------`);

  // Create SLM order with trigger price VERY close to current LTP
  const { data: raceSlmOrder } = await admin
    .from('orders')
    .insert({
      user_id: userId,
      symbol: testSymbol,
      kite_instrument: testKiteInst,
      segment: testSegment,
      side: 'BUY',
      status: 'PENDING',
      qty: 5,
      lots: 1,
      price: currentLtp,
      fill_price: currentLtp,
      trigger_price: currentLtp + 0.5, // Extremely close to LTP (2500.5)
      ltp_at_entry: currentLtp,
      order_type: 'SLM',
      product_type: 'INTRADAY',
      is_exit: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  console.log(`[${timestamp()}] [RACE TEST] Created near-LTP SLM Order ID: ${raceSlmOrder?.id} (Trigger: 2500.5, LTP: 2500.0)`);

  const raceTimeline: { time: string; oldStatus: string; newStatus?: string; executedOrder?: string }[] = [];

  // Start modification asynchronously while polling DB every 100ms
  const modPromise = fetch('http://localhost:3000/api/orders/' + raceSlmOrder?.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({
      order_type: 'GTT',
      trigger_price: 2400.0,
      stop_loss: 2380.0,
      target: 2700.0,
      price: 2400.0,
      qty: 5,
      frontend_ltp: currentLtp,
    }),
  });

  const startTime = Date.now();
  let raceNewOrderId: string | null = null;
  let oldExecutedInRaceWindow = false;

  // Poll for 5000ms at ~100ms intervals
  while (Date.now() - startTime < 5000) {
    const nowTs = timestamp();
    const { data: oldSnap } = await admin.from('orders').select('status').eq('id', raceSlmOrder?.id).single();
    let newSnapStatus: string | undefined = undefined;

    if (raceNewOrderId) {
      const { data: nSnap } = await admin.from('orders').select('status').eq('id', raceNewOrderId).single();
      newSnapStatus = nSnap?.status;
    }

    if (oldSnap?.status === 'EXECUTED') {
      oldExecutedInRaceWindow = true;
      raceTimeline.push({ time: nowTs, oldStatus: oldSnap.status, newStatus: newSnapStatus, executedOrder: raceSlmOrder?.id });
    } else {
      raceTimeline.push({ time: nowTs, oldStatus: oldSnap?.status || 'UNKNOWN', newStatus: newSnapStatus });
    }

    // Try resolving new order ID if not resolved yet
    if (!raceNewOrderId) {
      const res = await modPromise.catch(() => null);
      if (res) {
        const json = await res.json().catch(() => null);
        if (json?.order?.id) raceNewOrderId = json.order.id;
      }
    }

    await sleep(100);
  }

  console.log(`[${timestamp()}] High-Frequency Polling Completed (Captured ${raceTimeline.length} samples):`);
  console.log(`First 5 samples:`, raceTimeline.slice(0, 5));
  console.log(`Last 5 samples:`, raceTimeline.slice(-5));

  if (!oldExecutedInRaceWindow) {
    console.log(`✅ HIGH-FREQUENCY RACE CONDITION TEST PASSED: Old SLM order NEVER reached EXECUTED status!`);
    testResults.raceConditionTest = true;
  } else {
    console.error(`❌ HIGH-FREQUENCY RACE CONDITION TEST FAILED! Old order reached EXECUTED status.`);
  }

  // Cleanup test orders
  await admin.from('orders').update({ status: 'CANCELLED' }).in('symbol', [testSymbol]).eq('status', 'PENDING');

  console.log(`\n===============================================================`);
  console.log(`[${timestamp()}] E2E VERIFICATION COMPLETE SUMMARY:`);
  console.log(`===============================================================`);
  console.log(testResults);
}

runE2EVerification().catch(err => {
  console.error('Fatal E2E Verification Error:', err);
  process.exit(1);
});
