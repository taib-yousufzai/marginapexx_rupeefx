/**
 * POST /api/positions/[id]/close
 *
 * Closes an open position for the authenticated user.
 * - Fetches Kite LTP for exit price computation (server-side)
 * - Applies exit_buffer from segment_settings
 * - Calls close_position() Postgres RPC atomically:
 *     → updates position to 'closed'
 *     → records exit order
 *     → writes PNL_CREDIT / PNL_DEBIT transaction
 *     → logs to act_logs
 *
 * Also used by broker force-close (broker panel calls with user's position id).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getPlatformSetting } from '@/lib/getPlatformSetting';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { resolveEffectivePrices } from '@/lib/trading/marketPriceResolver';
import { RiskValidation } from '@/lib/trading/RiskValidation';
import type { ClosePositionResponse } from '@/lib/types/order';


/**
 * Fetch the Kite LTP for a single instrument key server-side.
 * Resolves from local market_quotes DB cache if available, falling back on-demand.
 */
async function fetchKiteLtp(instrument: string): Promise<number | null> {
  try {
    const admin = getAdminClient();
    
    // 1. Check Ticker Daemon in-memory quotes API
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || 'http://localhost:8080';
      const params = new URLSearchParams({ symbols: instrument });
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(1000) });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data && json.data[instrument]) {
          const q = json.data[instrument];
          const ltp = Number(q.last_price || 0);
          const bid = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? 0);
          const ask = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? 0);
          return { ltp, bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null } as any;
        }
      }
    } catch (tickerErr) {
      console.warn('[fetchKiteLtp] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
    }

    // 2. On-demand fallback to Kite REST API
    const apiKey = process.env.KITE_API_KEY;
    if (!apiKey) return null;
    const session = await getSharedKiteSession();
    if (!session) return null;

    const params = new URLSearchParams({ i: instrument });
    const res = await fetch(`https://api.kite.trade/quote?${params}`, {
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${apiKey}:${session.accessToken}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });

    if (!res.ok) return null;

    const data = await res.json() as { data?: Record<string, { last_price: number; buy_price?: number; sell_price?: number; depth?: any; instrument_token?: number; ohlc?: { close?: number } }> };
    const quote = data.data?.[instrument];
    if (!quote) return null;

    const ltp = Number(quote.last_price || 0);
    const bid = Number(quote.depth?.buy?.[0]?.price ?? quote.buy_price ?? 0);
    const ask = Number(quote.depth?.sell?.[0]?.price ?? quote.sell_price ?? 0);

    // Cache the instrument asynchronously in background (excluding raw ticks)
    (async () => {
      try {
        const parts = instrument.split(':');
        const exchange = parts[0] || 'NSE';
        const tradingsymbol = parts[1] || '';

        await admin.from('instruments').upsert({
          id: instrument,
          instrument_token: quote.instrument_token || 0,
          tradingsymbol: tradingsymbol,
          exchange: exchange,
          instrument_type: exchange === 'NFO' || exchange === 'MCX' || exchange === 'CDS' ? 'FUTOPT' : 'EQ',
          segment: exchange,
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
      } catch (err) {
        console.error('[fetchKiteLtp] Background cache error:', err);
      }
    })();

    return { ltp, bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null } as any;
  } catch (err) {
    console.error('[fetchKiteLtp] Unexpected error:', err);
    return null;
  }
}

async function fetchBinanceQuote(symbol: string): Promise<number | null> {
  try {
    let cleanSym = symbol.replace('/', '').toUpperCase();
    if (!cleanSym.endsWith('USDT')) {
      cleanSym = cleanSym + 'USDT';
    }
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${cleanSym}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch (err) {
    console.error('[fetchBinanceQuote] Error:', err);
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: positionId } = await params;
  if (!positionId) {
    return NextResponse.json({ error: 'Missing position id' }, { status: 400 });
  }

  const admin = getAdminClient();

  // 1. Parallel fetch position and profile
  const [posResult, profileResult] = await Promise.all([
    admin.from('positions')
      .select('*')
      .eq('id', positionId)
      .eq('user_id', user.id)
      .eq('status', 'open')
      .single(),
    admin.from('profiles')
      .select('parent_id, trading_mode')
      .eq('id', user.id)
      .single(),
  ]);

  const { data: pos, error: posErr } = posResult;
  if (posErr || !pos) {
    return NextResponse.json({ error: 'Position not found or already closed' }, { status: 404 });
  }

  // Note: Position exits (closing an open position) are allowed off-hours so users/system are never trapped in open positions.


  // 2. Parallel fetch segment settings and LTP
  const isScalper = profileResult.data?.trading_mode === 'scalper';
  const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
  const lookupId = profileResult.data?.parent_id ?? user.id;
  const [segSettingResult, kiteLtp] = await Promise.all([
    admin.from(targetTable)
      .select('exit_buffer, profit_hold_sec, loss_hold_sec, bid_buffer, exit_price_mode')
      .eq('user_id', lookupId)
      .eq('segment', pos.settlement ?? '')
      .eq('side', pos.side)
      .maybeSingle(),
    (() => {
      const fetchPromise = (async () => {
        if (!pos.symbol) return null;
        const isCrypto = (pos.settlement || '').toUpperCase().includes('CRYPTO');
        if (isCrypto) {
          return fetchBinanceQuote(pos.symbol);
        }
        let fullSymbol = pos.symbol;
        if (!pos.symbol.includes(':')) {
          let exchange = 'NSE';
          if (pos.settlement) {
            const s = pos.settlement.toUpperCase();
            if (s.includes('MCX')) exchange = 'MCX';
            else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
            else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
            else if (s.includes('BSE')) exchange = 'BSE';
          }
          fullSymbol = `${exchange}:${pos.symbol}`;
        }
        return fetchKiteLtp(fullSymbol);
      })();
      return Promise.race([
        fetchPromise,
        new Promise<any>((resolve) => setTimeout(() => resolve(null), 1500))
      ]);
    })(),
  ]);

  const { data: segSetting } = segSettingResult;
  const rawExitBuffer = segSetting?.exit_buffer;
  const exitBuffer = (rawExitBuffer !== undefined && rawExitBuffer !== null && !isNaN(Number(rawExitBuffer)))
    ? (Number(rawExitBuffer) > 0.005 ? Number(rawExitBuffer) / 100 : Number(rawExitBuffer))
    : 0;
  const profitHoldSec = segSetting?.profit_hold_sec ?? 120;
  const lossHoldSec = segSetting?.loss_hold_sec ?? 0;

  const quoteDetails = typeof kiteLtp === 'object' && kiteLtp !== null ? kiteLtp : (typeof kiteLtp === 'number' ? { ltp: kiteLtp, bid: null, ask: null } : null);
  const baseLtp = quoteDetails?.ltp ?? Number(pos.ltp ?? pos.entry_price);
  const rawBid = quoteDetails?.bid ?? null;
  const rawAsk = quoteDetails?.ask ?? null;
  const isCommodity = (pos.settlement || '').toUpperCase().includes('MCX') ||
    ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(c => (pos.symbol || '').toUpperCase().includes(c));
  const hasRealBidAsk = isCommodity ? false : Boolean(rawBid && rawAsk && rawBid > 0 && rawAsk > 0 && rawBid < rawAsk);

  const platformExitMode = await getPlatformSetting('EXIT_PRICE_MODE', 'BID_ASK');
  const execMode = platformExitMode || segSetting?.exit_price_mode || 'BID_ASK';

  // Layer 1: displayed Bid/Ask using bid_buffer (same formula as TradeSheet/DetailSheet)
  const bidBufRaw = Number(segSetting?.bid_buffer ?? 0);
  const bidBufDecimal = Math.abs(bidBufRaw) > 0.005 ? bidBufRaw / 100 : bidBufRaw;
  const bidBufAmount = baseLtp * bidBufDecimal; // always LTP-based

  const hasRealBidAskClose = Boolean(rawBid && rawAsk && rawBid > 0 && rawAsk > 0 && rawBid < rawAsk);
  const useLtpModeClose = execMode === 'LTP' || isCommodity || !hasRealBidAskClose;

  let displayedAsk: number;
  let displayedBid: number;
  if (useLtpModeClose) {
    displayedAsk = baseLtp + bidBufAmount;
    displayedBid = baseLtp - bidBufAmount;
  } else {
    displayedAsk = (rawAsk ?? baseLtp) + bidBufAmount;
    displayedBid = (rawBid ?? baseLtp) - bidBufAmount;
  }
  if (displayedAsk <= 0) displayedAsk = baseLtp;
  if (displayedBid <= 0) displayedBid = baseLtp;

  // Layer 2: apply exit_buffer on top using LTP as the base amount (hidden from user)
  //   Closing BUY  = SELLING  → Displayed Bid  - LTP * exit_buffer%
  //   Closing SELL = BUYING   → Displayed Ask  + LTP * exit_buffer%
  let exitPrice: number;
  if (pos.side === 'BUY') {
    exitPrice = displayedBid - baseLtp * exitBuffer;
  } else {
    exitPrice = displayedAsk + baseLtp * exitBuffer;
  }
  exitPrice = Math.round(exitPrice * 100) / 100;

  // ─── Anti-Scalping Check ───
  const pnlValue = pos.side === 'BUY'
    ? (exitPrice - Number(pos.entry_price)) * Number(pos.qty_open)
    : (Number(pos.entry_price) - exitPrice) * Number(pos.qty_open);

  const durationSec = Math.floor((Date.now() - new Date(pos.entry_time).getTime()) / 1000);
  const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

  if (durationSec < requiredHold) {
    return NextResponse.json({
      error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`,
    }, { status: 403 });
  }

  // Call the atomic RPC
  const { data: pnl, error: rpcErr } = await admin.rpc('close_position', {
    p_position_id: positionId,
    p_user_id:     user.id,
    p_ltp:         baseLtp,
    p_exit_price:  exitPrice,
    p_closed_by:   'USER',
  });

  if (rpcErr) {
    console.error('[POST /api/positions/[id]/close] RPC error:', rpcErr);
    return NextResponse.json({ error: rpcErr.message || 'Failed to close position. Please try again.' }, { status: 400 });
  }

  // Cancel any open/pending exit or linked orders for this position/symbol asynchronously
  (async () => {
    try {
      const { PositionService } = await import('@/lib/trading/PositionService');
      await PositionService.cancelPendingOrdersForClosedPosition(admin, user.id, positionId, pos.symbol);
    } catch (cancelErr) {
      console.warn('[POST /api/positions/[id]/close] Non-fatal error cleaning up pending orders:', cancelErr);
    }
  })();

  const response: ClosePositionResponse = {
    pnl:        Number(pnl),
    exit_price: exitPrice,
    message:    `Position closed at ₹${exitPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}. P&L: ₹${Number(pnl).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
  };

  return NextResponse.json(response, { status: 200 });
}
