import { getAdminClient } from '../lib/adminClient';

async function backfill() {
  const admin = getAdminClient();

  console.log('Fetching unlinked pending entry orders...');
  
  const { data: unlinkedOrders, error: fetchErr } = await admin
    .from('orders')
    .select('*')
    .in('status', ['PENDING', 'OPEN', 'TRIGGER_PENDING', 'VALIDATION_PENDING'])
    .eq('is_exit', false);

  if (fetchErr) {
    console.error('Fetch error:', fetchErr);
    process.exit(1);
  }

  console.log(`Found ${unlinkedOrders?.length ?? 0} pending entry orders.`);

  let backfilledCount = 0;

  for (const o of unlinkedOrders ?? []) {
    // Check if position already exists for o.info
    let hasPosition = false;
    if (o.info) {
      const { data: existingPos } = await admin
        .from('positions')
        .select('id')
        .eq('id', o.info)
        .maybeSingle();
      if (existingPos) {
        hasPosition = true;
      }
    }

    if (hasPosition) {
      console.log(`Order ${o.id} (${o.symbol}) already has position ${o.info}`);
      continue;
    }

    console.log(`Backfilling order ${o.id} (${o.symbol} ${o.side} ${o.order_type})...`);

    // Create position internal via Supabase RPC or direct insert
    const fillPrice = Number(o.fill_price || o.price || o.trigger_price || 0);

    const { data: posData, error: posErr } = await admin
      .from('positions')
      .insert({
        user_id: o.user_id,
        symbol: o.symbol,
        side: o.side,
        status: 'open',
        qty_open: o.qty,
        qty_total: o.qty,
        avg_price: fillPrice,
        entry_price: fillPrice,
        ltp: fillPrice,
        product_type: o.product_type || 'INTRADAY',
        settlement: o.segment || 'STOCKS',
        stop_loss: o.stop_loss || null,
        target: o.target || null,
        locked_margin: 0,
        margin_required: 0,
        entry_brokerage: o.brokerage || 0,
        brokerage: o.brokerage || 0,
        entry_time: o.created_at || new Date().toISOString(),
        created_at: o.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (posErr || !posData) {
      console.error(`Failed to create position for order ${o.id}:`, posErr);
      continue;
    }

    const posId = posData.id;

    // Link order to position
    const { error: updateErr } = await admin
      .from('orders')
      .update({ info: posId })
      .eq('id', o.id);

    if (updateErr) {
      console.error(`Failed to update order info for ${o.id}:`, updateErr);
    } else {
      console.log(`✅ Backfilled order ${o.id} -> Linked to new position ${posId}`);
      backfilledCount++;
    }
  }

  console.log(`\n🎉 Backfill complete! Total orders backfilled: ${backfilledCount}`);
}

backfill().catch(console.error);
