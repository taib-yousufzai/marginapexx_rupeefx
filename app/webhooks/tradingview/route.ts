import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/adminClient';

// Direct mapping from exchange / segment to internal segment names
function resolveDbSegment(exchange: string, instrumentType: string, segment: string): string {
  const ex = exchange.toUpperCase();
  const type = (instrumentType || '').toUpperCase();
  const seg = (segment || '').toUpperCase();

  if (ex === 'CRYPTO' || seg === 'CRYPTO') return 'CRYPTO';
  if (ex === 'CDS' || seg === 'CDS' || seg === 'FOREX') return 'FOREX';
  if (ex === 'MCX' || seg === 'MCX') {
    if (type.includes('OPT')) return 'MCX-OPT';
    return 'MCX-FUT';
  }
  if (ex === 'COMEX' || seg === 'COMEX') return 'COMEX';

  // Indian Equities/Futures/Options
  if (type === 'EQ') return 'STOCKS';
  if (type.includes('FUT')) {
    if (type.includes('IDX')) return 'INDEX-FUT';
    return 'STOCK-FUT';
  }
  if (type.includes('OPT')) {
    if (type.includes('IDX')) return 'INDEX-OPT';
    return 'STOCK-OPT';
  }

  return 'STOCKS'; // fallback default
}

export async function POST(request: NextRequest) {
  const admin = getAdminClient();
  let token = request.nextUrl.searchParams.get('token');

  // If not in query parameters, check Authorization header
  if (!token) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) {
    return NextResponse.json({ error: 'Missing webhook token.' }, { status: 401 });
  }

  // 1. Resolve profile by webhook token
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, active, read_only')
    .eq('webhook_token', token)
    .maybeSingle();

  if (profileErr || !profile) {
    return NextResponse.json({ error: 'Unauthorized: Invalid webhook token.' }, { status: 401 });
  }

  if (!profile.active) {
    return NextResponse.json({ error: 'Account is inactive.' }, { status: 403 });
  }

  if (profile.read_only) {
    return NextResponse.json({ error: 'Account is read-only.' }, { status: 403 });
  }

  // 2. Parse body
  let payload: any;
  try {
    payload = await request.json();
  } catch (err) {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const {
    symbol,
    action,
    qty,
    order_type = 'MARKET',
    price,
    trigger_price,
    stop_loss,
    target,
    strategy_name = 'TradingView Alert'
  } = payload;

  if (!symbol || !action) {
    return NextResponse.json({ error: 'Missing required parameters: symbol, action.' }, { status: 400 });
  }

  // 3. Resolve symbol and segment from DB instruments
  let cleanSymbol = symbol.trim().toUpperCase();
  let dbQuery = admin.from('instruments').select('*');

  if (cleanSymbol.includes(':')) {
    dbQuery = dbQuery.eq('id', cleanSymbol);
  } else {
    dbQuery = dbQuery.eq('tradingsymbol', cleanSymbol);
  }

  const { data: instruments, error: instError } = await dbQuery.limit(1);

  if (instError || !instruments || instruments.length === 0) {
    return NextResponse.json({ error: `Instrument not found for symbol: ${symbol}` }, { status: 404 });
  }

  const instrument = instruments[0];
  const dbSegment = resolveDbSegment(instrument.exchange, instrument.instrument_type, instrument.segment);
  const kiteInstrument = instrument.id;

  // 4. Map action string to Order side and exit state
  // Supported actions: BUY, LONG, SELL, SHORT, BUY_EXIT, CLOSE_SHORT, SELL_EXIT, CLOSE_LONG, EXIT, CLOSE
  let orderSide: 'BUY' | 'SELL' = 'BUY';
  let isExit = false;
  const actUpper = action.trim().toUpperCase();

  if (actUpper === 'BUY' || actUpper === 'LONG') {
    orderSide = 'BUY';
    isExit = false;
  } else if (actUpper === 'SELL' || actUpper === 'SHORT') {
    orderSide = 'SELL';
    isExit = false;
  } else if (actUpper === 'BUY_EXIT' || actUpper === 'CLOSE_SHORT') {
    orderSide = 'BUY';
    isExit = true;
  } else if (actUpper === 'SELL_EXIT' || actUpper === 'CLOSE_LONG') {
    orderSide = 'SELL';
    isExit = true;
  } else if (actUpper === 'EXIT' || actUpper === 'CLOSE') {
    // Determine exit direction by looking up open positions for the user
    const { data: openPos } = await admin
      .from('positions')
      .select('id, side, qty_open')
      .eq('user_id', profile.id)
      .eq('symbol', instrument.tradingsymbol)
      .eq('status', 'open')
      .limit(1);

    if (openPos && openPos.length > 0) {
      isExit = true;
      // Exit order must be opposite of open position side
      orderSide = openPos[0].side === 'BUY' ? 'SELL' : 'BUY';
    } else {
      return NextResponse.json({ error: `Cannot process EXIT action: No active open position found for ${instrument.tradingsymbol}` }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 });
  }

  // 5. Construct place order request payload
  const resolvedQty = qty ? Number(qty) : undefined;
  if (!resolvedQty || resolvedQty <= 0) {
    return NextResponse.json({ error: 'Quantity must be a positive number.' }, { status: 400 });
  }

  const orderPayload = {
    symbol: instrument.tradingsymbol,
    kite_instrument: kiteInstrument,
    segment: dbSegment,
    side: orderSide,
    order_type: order_type.toUpperCase(),
    product_type: 'INTRADAY', // Default to INTRADAY for automated strategy signals
    qty: resolvedQty,
    lots: 0, // Server-side maps dynamic lot sizes automatically if lots is 0
    client_price: price ? Number(price) : 0,
    trigger_price: trigger_price ? Number(trigger_price) : undefined,
    stop_loss: stop_loss ? Number(stop_loss) : undefined,
    target: target ? Number(target) : undefined,
    is_exit: isExit
  };

  // 6. Execute order placement via internal /api/orders route
  let orderId: string | null = null;
  let success = false;
  let responseMessage = '';

  try {
    const host = request.headers.get('host') || 'localhost:3000';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
    const orderApiUrl = `${protocol}://${host}/api/orders`;

    const res = await fetch(orderApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Webhook ${token}`
      },
      body: JSON.stringify(orderPayload)
    });

    const result = await res.json();

    if (res.ok && result.order_id) {
      success = true;
      orderId = result.order_id;
      responseMessage = result.message || 'Order placed successfully';
    } else {
      responseMessage = result.error || 'Failed to place order via API';
    }
  } catch (err: any) {
    responseMessage = err.message || 'Internal connection error during execution';
  }

  // 7. Write to public.strategy_executions logs
  const { error: logErr } = await admin
    .from('strategy_executions')
    .insert({
      user_id: profile.id,
      strategy_name,
      signal_type: actUpper,
      symbol: instrument.tradingsymbol,
      payload: payload,
      status: success ? 'SUCCESS' : 'FAILED',
      error_message: success ? null : responseMessage,
      order_id: orderId
    });

  if (logErr) {
    console.error('[Webhook Ingestion] Log insertion error:', logErr);
  }

  if (success) {
    return NextResponse.json({
      success: true,
      order_id: orderId,
      message: responseMessage
    }, { status: 201 });
  } else {
    return NextResponse.json({
      success: false,
      error: responseMessage
    }, { status: 400 });
  }
}
