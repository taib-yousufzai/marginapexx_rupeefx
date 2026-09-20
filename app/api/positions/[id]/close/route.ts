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
import { cleanSym } from '@/contexts/PositionsContext';
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

import { getRedisClient } from '@/lib/redis';
import { getCachedUserProfile, getCachedUserSegmentSettings, invalidateUserPositionsCache, invalidateUserOrdersCache } from '@/lib/redisSettingsCache';
import { mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';

async function fetchBinanceQuote(symbol: string): Promise<number | null> {
  try {
    let clean = cleanSym(symbol);
    if (!clean.endsWith('USDT')) {
      clean = clean + 'USDT';
    }
    const baseClean = clean.replace('USDT', '');

    // 1. Check Redis in-memory cache first (0.5ms) across all possible symbol keys
    try {
      const redis = getRedisClient();
      const keysToTry = [clean, baseClean, `CRYPTO:${clean}`, `CRYPTO:${baseClean}`, `BINANCE:${clean}`];
      for (const k of keysToTry) {
        const cached = await redis.hget('market:quotes', k);
        if (cached) {
          const tick = JSON.parse(cached);
          const ltp = Number(tick.last_price || tick.lastPrice || 0);
          if (ltp > 0) return ltp;
        }
      }
    } catch (_) {}

    // 2. Fallback to REST API with 1.5s timeout
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${clean}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.price) return parseFloat(data.price);
    }
  } catch (err) {
    console.error('[fetchBinanceQuote] Error:', err);
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any = null;
  try {
    body = await request.json();
  } catch (_) {}

  const { id: positionId } = await params;
  if (!positionId && !body?.symbol) {
    return NextResponse.json({ error: 'Missing position id' }, { status: 400 });
  }

  const admin = getAdminClient();

  // 1. Parallel fetch position and cached profile
  const [posResult, cachedProfile] = await Promise.all([
    admin.from('positions')
      .select('*')
      .eq('id', positionId)
      .eq('user_id', user.id)
      .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
      .maybeSingle(),
    getCachedUserProfile(user.id, () => admin),
  ]);

  let pos = posResult?.data;
  let resolvedPositionId = positionId;

  // Fallback: If position was not found by exact ID (e.g. optimistic placeholder or lot grouping), look up by symbol
  if (!pos) {
    const { data: userOpenPositions } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', user.id)
      .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
      .order('created_at', { ascending: false });

    if (userOpenPositions && userOpenPositions.length > 0) {
      if (body?.symbol) {
        const targetClean = cleanSym(body.symbol);
        pos = userOpenPositions.find((p: any) => 
          cleanSym(p.symbol || p.kite_instrument) === targetClean && 
          (!body.side || p.side === body.side)
        ) ?? userOpenPositions.find((p: any) => cleanSym(p.symbol || p.kite_instrument) === targetClean) ?? null;
      }
      if (!pos && positionId) {
        pos = userOpenPositions.find((p: any) => p.id === positionId) ?? null;
      }
      if (pos) {
        resolvedPositionId = pos.id;
      }
    }
  }

  if (!pos) {
    // Check if the position exists for this user and was already closed (e.g. fast-pipe WS already closed it, or concurrent exit)
    const { data: closedPos } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', user.id)
      .eq('id', positionId)
      .maybeSingle();

    if (closedPos && (closedPos.status === 'closed' || closedPos.status === 'CLOSED')) {
      return NextResponse.json({
        success: true,
        message: 'Position already closed',
        position_id: closedPos.id,
        pnl: closedPos.pnl ?? 0,
        exit_price: closedPos.exit_price ?? closedPos.ltp ?? 0,
        already_closed: true,
      });
    }

    return NextResponse.json({ error: 'Position not found or already closed' }, { status: 404 });
  }

  const dbSegment = mapSegmentWithSymbol(pos.settlement || '', pos.symbol || '');

  // 2. Parallel fetch segment settings and LTP
  const isScalper = cachedProfile?.trading_mode === 'scalper';
  const lookupId = cachedProfile?.parent_id ?? user.id;
  const [segSettingsList, kiteLtp] = await Promise.all([
    getCachedUserSegmentSettings(lookupId, dbSegment, isScalper, () => admin),
    (() => {
      const fetchPromise = (async () => {
        if (!pos.symbol) return null;
        const sym = (pos.symbol || '').toUpperCase();
        const isCrypto = dbSegment === 'CRYPTO' ||
          (pos.settlement || '').toUpperCase().includes('CRYPTO') ||
          sym.endsWith('USDT') ||
          ['BTC', 'ETH', 'DOGE', 'DODGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC', 'LINK', 'UNI', 'BCH', 'SHIB', 'PEPE', 'TRX', 'NEAR', 'SUI', 'APT', 'FET', 'RNDR', 'INJ', 'TIA', 'OP', 'ARB'].some(c => sym === c || sym.startsWith(c) || sym.includes(c));
        if (isCrypto) {
          return fetchBinanceQuote(pos.symbol);
        }
        const isComex = (pos.settlement || '').toUpperCase().includes('COMEX') ||
          ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => (pos.symbol || '').toUpperCase().includes(c));
        if (isComex) {
          try {
            const { fetchMT5StockQuote } = await import('@/lib/datafeed/MT5StockService');
            const mt5Q = await fetchMT5StockQuote(pos.symbol);
            const lastP = (mt5Q as any)?.price ?? (mt5Q as any)?.lastPrice ?? 0;
            if (mt5Q && lastP > 0) {
              return {
                ltp: lastP,
                bid: mt5Q.bid || lastP,
                ask: mt5Q.ask || lastP,
              } as any;
            }
          } catch {}
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

  let segSetting = Array.isArray(segSettingsList) ? segSettingsList.find((s: any) => s.side === pos.side) : null;
  if (!segSetting && lookupId !== user.id) {
    const userSegSettings = await getCachedUserSegmentSettings(user.id, dbSegment, isScalper, () => admin);
    segSetting = Array.isArray(userSegSettings) ? userSegSettings.find((s: any) => s.side === pos.side) : null;
  }
  const rawExitBuffer = segSetting?.exit_buffer;
  const exitBuffer = (rawExitBuffer !== undefined && rawExitBuffer !== null && !isNaN(Number(rawExitBuffer)))
    ? (Number(rawExitBuffer) > 0.005 ? Number(rawExitBuffer) / 100 : Number(rawExitBuffer))
    : 0;
  const profitHoldSec = segSetting?.profit_hold_sec ?? 0;
  const lossHoldSec = segSetting?.loss_hold_sec ?? 0;

  const quoteDetails = typeof kiteLtp === 'object' && kiteLtp !== null ? kiteLtp : (typeof kiteLtp === 'number' ? { ltp: kiteLtp, bid: null, ask: null } : null);
  const clientPriceNum = body?.client_price ? Number(body.client_price) : 0;
  const baseLtp = quoteDetails?.ltp ?? (clientPriceNum > 0 ? clientPriceNum : Number(pos.ltp ?? pos.entry_price ?? 0));
  const rawBid = quoteDetails?.bid ?? null;
  const rawAsk = quoteDetails?.ask ?? null;
  const isCommodity = (pos.settlement || '').toUpperCase().includes('MCX') ||
    ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(c => (pos.symbol || '').toUpperCase().includes(c));

  const platformExitMode = await getPlatformSetting('EXIT_PRICE_MODE', 'BID_ASK');
  const execMode = platformExitMode || segSetting?.exit_price_mode || 'BID_ASK';

  // Layer 1: displayed Bid/Ask using bid_buffer
  const bidBufRaw = Number(segSetting?.bid_buffer ?? 0);
  const bidBufDecimal = Math.abs(bidBufRaw) > 0.005 ? bidBufRaw / 100 : bidBufRaw;
  const bidBufAmount = baseLtp * bidBufDecimal;

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
  if (displayedAsk <= 0) displayedAsk = baseLtp > 0 ? baseLtp : 1;
  if (displayedBid <= 0) displayedBid = baseLtp > 0 ? baseLtp : 1;

  // Layer 2: apply exit_buffer
  let exitPrice: number;
  if (pos.side === 'BUY') {
    exitPrice = displayedBid - baseLtp * exitBuffer;
  } else {
    exitPrice = displayedAsk + baseLtp * exitBuffer;
  }
  exitPrice = Math.round(exitPrice * 100) / 100;
  if (exitPrice <= 0) exitPrice = baseLtp > 0 ? baseLtp : Number(pos.entry_price || 1);

  // ─── Anti-Scalping Check ───
  const pnlValue = pos.side === 'BUY'
    ? (exitPrice - Number(pos.entry_price)) * Number(pos.qty_open)
    : (Number(pos.entry_price) - exitPrice) * Number(pos.qty_open);

  const entryDate = pos.entry_time || pos.created_at || pos.updated_at;
  const entryTimestamp = entryDate ? new Date(entryDate).getTime() : Date.now();
  const durationSec = isNaN(entryTimestamp) ? 999999 : Math.floor((Date.now() - entryTimestamp) / 1000);
  const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

  if (durationSec < requiredHold) {
    return NextResponse.json({
      error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`,
    }, { status: 403 });
  }

  // Call the atomic RPC (v2 with v1 fallback)
  let pnl: any;
  let rpcErr: any;

  const closeQty = Number(pos.qty_open !== undefined && pos.qty_open !== null && Number(pos.qty_open) > 0 ? pos.qty_open : (pos.qty_total || 1));

  const resV2 = await admin.rpc('close_position_v2', {
    p_position_id:        resolvedPositionId,
    p_close_qty:          closeQty,
    p_close_price:        exitPrice,
    p_closed_by:          'USER',
    p_expected_brokerage: 0,
  });

  if (resV2.error) {
    console.warn('[POST /api/positions/[id]/close] v2 RPC error, falling back to v1:', resV2.error);
    const resV1 = await admin.rpc('close_position', {
      p_position_id: resolvedPositionId,
      p_user_id:     user.id,
      p_ltp:         baseLtp,
      p_exit_price:  exitPrice,
      p_closed_by:   'USER',
    });
    pnl = resV1.data;
    rpcErr = resV1.error;
  } else {
    pnl = resV2.data;
    rpcErr = resV2.error;
  }

  if (rpcErr) {
    console.error('[POST /api/positions/[id]/close] RPC error:', rpcErr);
    return NextResponse.json({ error: rpcErr.message || 'Failed to close position. Please try again.' }, { status: 400 });
  }

  // Invalidate caches synchronously so subsequent client polls receive clean updated state
  try {
    const { invalidateUserHistoryCache } = await import('@/lib/redisHistoryCache');
    await Promise.all([
      invalidateUserHistoryCache(user.id),
      invalidateUserPositionsCache(user.id),
      invalidateUserOrdersCache(user.id),
    ]);
  } catch (cacheErr) {
    console.warn('[POST /api/positions/[id]/close] Cache invalidation warning:', cacheErr);
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
