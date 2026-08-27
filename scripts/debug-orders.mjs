import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';

// Load env
try { dotenv.config({ path: '.env' }); } catch {}
try { dotenv.config({ path: '.env.local' }); } catch {}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceKey);

const { data: pendingOrders } = await admin
  .from('orders')
  .select('id, symbol, kite_instrument, side, order_type, status, client_price, fill_price, price, ltp_at_entry')
  .eq('status', 'PENDING');

console.log('\n=== PENDING ORDERS ===');
for (const o of (pendingOrders || [])) {
  console.log({
    id: o.id,
    symbol: o.symbol,
    kite_instrument: o.kite_instrument,
    side: o.side,
    order_type: o.order_type,
    client_price: o.client_price,
    fill_price: o.fill_price,
    price: o.price,
    ltp_at_entry: o.ltp_at_entry,
  });
}

console.log('\n=== TICKER PRICE KEYS (from Redis market:quotes) ===');
// Check what keys exist matching BTC
const { createClient: createRedisClient } = await import('redis').catch(() => null) || {};
console.log('(Cannot check Redis directly here — see ticker terminal for "No price found" debug line)');
console.log('\nThe ticker terminal should now show which symbol variants it tried for each order.');
console.log('Look for lines like: [Order Matching] No price found for order <ID> symbol "<X>" (tried ...)');
