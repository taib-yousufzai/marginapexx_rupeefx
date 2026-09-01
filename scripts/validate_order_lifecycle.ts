import { getAdminClient } from '@/lib/adminClient';
import { PositionService } from '@/lib/trading/PositionService';

async function main() {
  console.log('=== STARTING ORDER & POSITION LIFECYCLE VALIDATION ===\n');

  const admin = getAdminClient();

  // 1. Get active user profile
  const { data: profiles, error: profErr } = await admin
    .from('profiles')
    .select('id, active, balance')
    .eq('active', true)
    .limit(1);

  if (profErr || !profiles || profiles.length === 0) {
    console.error('No active test user found:', profErr);
    process.exit(1);
  }

  const userId = profiles[0].id;
  console.log(`Step 1: Using Active User ID: ${userId} (Balance: ₹${profiles[0].balance})`);

  const testSymbol = 'NSE:SBIN';
  const testSegment = 'STOCKS';
  const testKiteInst = 'NSE:SBIN';

  // --------------------------------------------------------------------------
  // TEST CASE 1: Place a Pending Limit Order and Verify "Open Orders"
  // --------------------------------------------------------------------------
  console.log('\n--- TEST CASE 1: Submitting Pending LIMIT Order ---');
  const limitOrderId = await PositionService.openPosition(
    userId,
    testSymbol,
    'BUY',
    10, // qty
    1,  // lots
    800.0, // baseLtp
    750.0, // fillPrice (client price below LTP for BUY LIMIT)
    'LIMIT',
    'INTRADAY',
    testSegment,
    testKiteInst,
    false, // isImmediate = false -> PENDING
    0, // expectedMargin
    0    // expectedBrokerage
  );

  console.log(`Placed LIMIT order ID: ${limitOrderId}`);

  // Query database to check status
  const { data: limitOrderDb } = await admin
    .from('orders')
    .select('*')
    .eq('id', limitOrderId)
    .single();

  console.log(`[DB Check] Order status in DB: '${limitOrderDb.status}'`);
  if (limitOrderDb.status === 'PENDING') {
    console.log('✅ SUCCESS: Limit order correctly initialized with PENDING status (visible in Open Orders).');
  } else {
    console.error(`❌ FAILURE: Expected PENDING, got ${limitOrderDb.status}`);
  }

  // --------------------------------------------------------------------------
  // TEST CASE 2: Place Market Entry Order with SL & Target -> Verify Position Creation
  // --------------------------------------------------------------------------
  console.log('\n--- TEST CASE 2: Submitting MARKET Entry Order (Creates Position) ---');
  const marketOrderId = await PositionService.openPosition(
    userId,
    testSymbol,
    'BUY',
    10,
    1,
    800.0,
    800.0,
    'MARKET',
    'INTRADAY',
    testSegment,
    testKiteInst,
    true, // isImmediate = true -> EXECUTED -> Opens Position
    0,
    0
  );

  console.log(`Placed MARKET order ID: ${marketOrderId}`);

  // Query open positions
  const { data: openPositions } = await admin
    .from('positions')
    .select('*')
    .eq('user_id', userId)
    .eq('symbol', testSymbol)
    .eq('status', 'open');

  console.log(`[DB Check] Open positions for ${testSymbol}: ${openPositions?.length ?? 0}`);
  if (openPositions && openPositions.length > 0) {
    const pos = openPositions[0];
    console.log(`✅ SUCCESS: Position created in DB. ID: ${pos.id}, Side: ${pos.side}, Qty: ${pos.qty_open}, Status: ${pos.status}`);

    // Update position with Stop Loss (780) and Target (850)
    await admin.from('positions').update({ stop_loss: 780, target: 850 }).eq('id', pos.id);
    console.log('Set SL (780) and Target (850) on Position ID:', pos.id);

    // Also attach a pending exit order linked to this position
    const { data: pendingExitOrder, error: exitOrderErr } = await admin.from('orders').insert({
      user_id: userId,
      symbol: testSymbol,
      kite_instrument: testKiteInst,
      segment: testSegment,
      side: 'SELL',
      status: 'PENDING',
      qty: 10,
      lots: 1,
      price: 780,
      fill_price: 780,
      order_type: 'SL',
      product_type: 'INTRADAY',
      is_exit: true,
      info: pos.id
    }).select('id').single();

    if (exitOrderErr) {
      console.error('Exit Order Insert Error:', exitOrderErr);
    }
    console.log(`Created explicit pending SL exit order ID: ${pendingExitOrder?.id}`);

    // --------------------------------------------------------------------------
    // TEST CASE 3: Close Position & Verify Order Cancellation
    // --------------------------------------------------------------------------
    console.log('\n--- TEST CASE 3: Closing Position & Verifying Cancellation of Orders ---');
    
    // Close position via PositionService
    await PositionService.closePosition({
      userId,
      positionId: pos.id,
      closeQty: 10,
      closePrice: 810.0,
      closedBy: 'USER',
      expectedBrokerage: 20
    });

    console.log(`Closed Position ID: ${pos.id}`);

    // Check position status in DB
    const { data: closedPosDb } = await admin
      .from('positions')
      .select('status')
      .eq('id', pos.id)
      .single();

    console.log(`[DB Check] Position status after close: '${closedPosDb.status}'`);

    // Check status of associated pending exit order
    const { data: cancelledOrderDb } = await admin
      .from('orders')
      .select('id, status, is_exit')
      .eq('id', pendingExitOrder?.id)
      .single();

    console.log(`[DB Check] Pending SL exit order status after position close: '${cancelledOrderDb?.status}'`);

    if (closedPosDb.status === 'closed' && cancelledOrderDb?.status === 'CANCELLED') {
      console.log('✅ SUCCESS: Position successfully closed AND associated pending SL/Exit order automatically CANCELLED!');
    } else {
      console.error(`❌ FAILURE: Position status: ${closedPosDb.status}, Order status: ${cancelledOrderDb?.status}`);
    }
  } else {
    console.error('❌ FAILURE: Position was not created upon market order execution.');
  }

  // Cleanup test pending limit order
  if (limitOrderId) {
    await admin.from('orders').update({ status: 'CANCELLED' }).eq('id', limitOrderId);
    console.log('\nCleaned up test LIMIT order.');
  }

  console.log('\n=== LIFECYCLE VALIDATION COMPLETE ===');
}

main().catch((err) => {
  console.error('Validation Script Error:', err);
  process.exit(1);
});
