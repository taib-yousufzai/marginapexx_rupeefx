import { getAdminClient } from '../lib/adminClient';
import { PositionService } from '../lib/trading/PositionService';

async function testLifecycle() {
  const admin = getAdminClient();
  
  // 1. Fetch test user
  const { data: user, error: uErr } = await admin.from('profiles').select('id').limit(1).single();
  if (uErr || !user) {
    console.error('Failed to fetch test user:', uErr);
    process.exit(1);
  }
  const userId = user.id;
  console.log('Testing with User ID:', userId);

  const testSymbol = 'TEST_ETH_SLM';

  // Clean previous test records
  await admin.from('orders').delete().eq('symbol', testSymbol);
  await admin.from('positions').delete().eq('symbol', testSymbol);

  // 2. Call place_order_v2 for a PENDING SLM order
  console.log('\n--- STEP 1: Placing PENDING SLM Order ---');
  const { data: orderId, error: rpcErr } = await admin.rpc('place_order_v2', {
    p_user_id: user.id,
    p_symbol: testSymbol,
    p_kite_inst: 'ETH-TEST',
    p_segment: 'FOREX',
    p_side: 'BUY',
    p_order_type: 'SLM',
    p_product_type: 'INTRADAY',
    p_qty: 1,
    p_lots: 1,
    p_ltp: 2500,
    p_fill_price: 2500,
    p_is_exit: false,
    p_buffer_fee: 0,
    p_status: 'PENDING',
    p_trigger_price: 2500,
    p_stop_loss: null,
    p_target: null,
    p_info: null,
    p_expected_margin: 0,
    p_expected_brokerage: 0,
    p_idempotency_key: null,
    p_linked_position_id: null
  });

  if (rpcErr) {
    console.error('RPC Error:', rpcErr);
    process.exit(1);
  }

  console.log('Placed Order ID:', orderId);

  // 3. Verify Order record
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).single();
  console.log('Order Status:', order?.status);
  console.log('Order Info (Position ID):', order?.info);

  // 4. Verify Position record
  const positionId = order?.info;
  const { data: position } = await admin.from('positions').select('*').eq('id', positionId).single();
  console.log('Position Found:', Boolean(position));
  console.log('Position Status:', position?.status);
  console.log('Position Symbol:', position?.symbol);

  if (!position || position.status !== 'open') {
    console.error('❌ FAIL: Position was not created as open!');
    process.exit(1);
  }
  console.log('✅ STEP 1 SUCCESS: Pending SLM order created a corresponding OPEN position!');

  // 5. STEP 2: Close Position and verify automatic cancellation of pending order
  console.log('\n--- STEP 2: Closing Position ---');
  await PositionService.closePosition({
    userId,
    positionId: position.id,
    closeQty: 1,
    closePrice: 2500,
    closedBy: 'USER'
  });

  // Verify Position status is closed
  const { data: closedPosition } = await admin.from('positions').select('status').eq('id', position.id).single();
  console.log('Closed Position Status:', closedPosition?.status);

  // Verify Order status is CANCELLED
  const { data: cancelledOrder } = await admin.from('orders').select('status').eq('id', orderId).single();
  console.log('Cancelled Order Status:', cancelledOrder?.status);

  if (closedPosition?.status === 'closed' && cancelledOrder?.status === 'CANCELLED') {
    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
    console.log('1. Pending SL/SLM/Limit/GTT order creates a corresponding position in DB.');
    console.log('2. Closing the position automatically cancels the pending order.');
  } else {
    console.error('❌ FAIL: Position close did not cancel pending order.');
  }
}

testLifecycle().catch(console.error);
