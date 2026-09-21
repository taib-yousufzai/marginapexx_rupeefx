import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';
import { RiskValidation } from '@/lib/trading/RiskValidation';
import { resolveEffectivePrices } from '@/lib/trading/marketPriceResolver';
import { mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';


/**
 * Fetch bid/ask quotes for a mixed batch of instruments (Kite + Binance crypto).
 * Each entry in the map is keyed by the instrument's lookup key.
 * Returns { bid, ask, ltp } per symbol.
 */
async function fetchQuoteBatch(
  kiteInstruments: string[],
  cryptoSymbols: string[]
): Promise<Record<string, { bid: number; ask: number; ltp?: number }>> {
  const quotesMap: Record<string, { bid: number; ask: number; ltp?: number }> = {};
  const allSymbols = [...kiteInstruments, ...cryptoSymbols];
  if (allSymbols.length === 0) return quotesMap;

  const missing = new Set(allSymbols);

  // 1. Redis cache
  try {
    const { getRedisClient } = await import('@/lib/redis');
    const redis = getRedisClient();
    await Promise.all(Array.from(missing).map(async (sym) => {
      const cleanSym = sym.replace(/^(CRYPTO:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
      const baseClean = cleanSym.replace('USDT', '');
      const keysToTry = [sym, cleanSym, baseClean, `CRYPTO:${cleanSym}`, `CRYPTO:${baseClean}`, `BINANCE:${cleanSym}`];
      for (const k of keysToTry) {
        const cached = await redis.hget('market:quotes', k);
        if (cached) {
          const q = JSON.parse(cached);
          const ltp = Number(q.last_price ?? q.ltp ?? q.price ?? 0);
          const bid = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? 0);
          const ask = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? 0);
          if (bid > 0 || ask > 0 || ltp > 0) {
            quotesMap[sym] = { bid, ask, ltp: ltp > 0 ? ltp : undefined };
            missing.delete(sym);
            break;
          }
        }
      }
    }));
  } catch { /* fall through */ }

  if (missing.size === 0) return quotesMap;

  // 2. Ticker Daemon
  try {
    const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
    const params = new URLSearchParams({ symbols: Array.from(missing).join(',') });
    const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (resTicker.ok) {
      const json = await resTicker.json();
      if (json.success && json.data) {
        for (const sym of Array.from(missing)) {
          if (json.data[sym]) {
            const q = json.data[sym];
            const ltp = Number(q.last_price ?? q.ltp ?? q.price ?? 0);
            const bid = Number(q.bid ?? q.buy_price ?? q.depth?.buy?.[0]?.price ?? 0);
            const ask = Number(q.ask ?? q.sell_price ?? q.depth?.sell?.[0]?.price ?? 0);
            if (bid > 0 || ask > 0 || ltp > 0) {
              quotesMap[sym] = { bid, ask, ltp: ltp > 0 ? ltp : undefined };
              missing.delete(sym);
            }
          }
        }
      }
    }
  } catch (tickerErr) {
    console.warn('[fetchQuoteBatch] Ticker Daemon failed, falling back to REST:', tickerErr);
  }

  if (missing.size === 0) return quotesMap;

  // 3a. Kite REST for remaining non-crypto instruments
  const missingKite = Array.from(missing).filter(s => kiteInstruments.includes(s));
  if (missingKite.length > 0) {
    try {
      const apiKey = process.env.KITE_API_KEY;
      const session = apiKey ? await getSharedKiteSession() : null;
      if (apiKey && session) {
        const params = new URLSearchParams();
        missingKite.forEach(i => params.append('i', i));
        const res = await fetch(`https://api.kite.trade/quote?${params}`, {
          headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${session.accessToken}` },
          cache: 'no-store', signal: AbortSignal.timeout(1500),
        });
        if (res && res.ok) {
          const data = await res.json() as { data?: Record<string, any> };
          for (const inst of missingKite) {
            const quote = data.data?.[inst];
            if (quote) {
              const ltp = Number(quote.last_price ?? 0);
              const bid = Number(quote.depth?.buy?.[0]?.price ?? 0);
              const ask = Number(quote.depth?.sell?.[0]?.price ?? 0);
              if (bid > 0 || ask > 0 || ltp > 0) {
                quotesMap[inst] = { bid, ask, ltp: ltp > 0 ? ltp : undefined };
                missing.delete(inst);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[fetchQuoteBatch] Kite REST error:', err);
    }
  }

  // 3b. Binance bookTicker for remaining crypto symbols (returns bidPrice / askPrice)
  const missingCrypto = Array.from(missing).filter(s => cryptoSymbols.includes(s));
  if (missingCrypto.length > 0) {
    await Promise.all(missingCrypto.map(async (sym) => {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${sym}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const data = await res.json();
          const bid = parseFloat(data.bidPrice);
          const ask = parseFloat(data.askPrice);
          const ltp = (bid + ask) / 2;
          if (bid > 0 || ask > 0 || ltp > 0) {
            quotesMap[sym] = { bid, ask, ltp: ltp > 0 ? ltp : undefined };
            missing.delete(sym);
          }
        } else {
          // Fallback to /ticker/price if bookTicker fails
          const resPrice = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
          if (resPrice.ok) {
            const pData = await resPrice.json();
            const ltp = parseFloat(pData.price);
            if (ltp > 0) {
              quotesMap[sym] = { bid: 0, ask: 0, ltp };
              missing.delete(sym);
            }
          }
        }
      } catch (err) {
        console.error(`[fetchQuoteBatch] Binance bookTicker error for ${sym}:`, err);
      }
    }));
  }

  // 3c. MT5 quotes for remaining COMEX symbols
  const missingComex = Array.from(missing).filter(s =>
    ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => s.toUpperCase().includes(c)) ||
    s.startsWith('COMEX:')
  );
  if (missingComex.length > 0) {
    try {
      const { fetchMT5StockQuote } = await import('@/lib/datafeed/MT5StockService');
      await Promise.all(missingComex.map(async (sym) => {
        try {
          const cleanSym = sym.replace('COMEX:', '');
          const mt5Q = await fetchMT5StockQuote(cleanSym);
          const lastP = (mt5Q as any)?.price ?? (mt5Q as any)?.lastPrice ?? 0;
          if (mt5Q && lastP > 0) {
            const bid = mt5Q.bid || lastP;
            const ask = mt5Q.ask || lastP;
            quotesMap[sym] = { bid, ask, ltp: lastP };
            quotesMap[cleanSym] = { bid, ask, ltp: lastP };
            missing.delete(sym);
          }
        } catch {}
      }));
    } catch {}
  }

  return quotesMap;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { positionIds } = await request.json() as { positionIds?: string[] };
    if (!positionIds || !Array.isArray(positionIds) || positionIds.length === 0) {
      return NextResponse.json({ error: 'Missing or empty positionIds array' }, { status: 400 });
    }

    const admin = getAdminClient();

    // 1. Parallel fetch positions, profile, and trading hours
    const [posResult, profileResult, tradingHoursResult] = await Promise.all([
      admin.from('positions')
        .select('*')
        .in('id', positionIds)
        .eq('user_id', user.id)
        .or('status.eq.open,status.eq.active,status.eq.OPEN,status.eq.ACTIVE'),
      admin.from('profiles')
        .select('parent_id, trading_mode')
        .eq('id', user.id)
        .single(),
      admin.from('trading_hours')
        .select('id, name, start_time, end_time, is_active')
    ]);

    const { data: positions, error: posErr } = posResult;
    if (posErr || !positions || positions.length === 0) {
      // Check if these positions were already closed (e.g. concurrent exit or fast-pipe WS)
      const { data: alreadyClosed } = await admin
        .from('positions')
        .select('id, status, pnl, exit_price')
        .in('id', positionIds)
        .eq('user_id', user.id)
        .in('status', ['closed', 'CLOSED']);

      if (alreadyClosed && alreadyClosed.length > 0) {
        return NextResponse.json({
          success: true,
          message: 'Positions already closed',
          already_closed: true,
          results: alreadyClosed.map(p => ({
            positionId: p.id,
            success: true,
            already_closed: true,
            pnl: p.pnl ?? 0,
            exit_price: p.exit_price ?? 0
          }))
        }, { status: 200 });
      }

      return NextResponse.json({ error: 'No open positions found matching the specified IDs' }, { status: 404 });
    }

    // Map trading hours for easy access
    const tradingHoursMap = new Map<string, any>();
    if (tradingHoursResult.data) {
      tradingHoursResult.data.forEach(th => {
        tradingHoursMap.set(th.id, th);
      });
    }

    // 2. Fetch segment settings for all required settings
    const isScalper = profileResult.data?.trading_mode === 'scalper';
    const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
    const lookupId = profileResult.data?.parent_id ?? user.id;

    const { data: segSettings } = await admin.from(targetTable)
      .select('segment, side, exit_buffer, profit_hold_sec, loss_hold_sec, entry_buffer, commission_type, commission_value, carry_commission_type, carry_commission_value, bid_buffer')
      .eq('user_id', lookupId);

    const segSettingsMap = new Map<string, any>();
    if (segSettings) {
      segSettings.forEach(s => {
        segSettingsMap.set(`${(s.segment || '').toUpperCase()}|${(s.side || '').toUpperCase()}`, s);
      });
    }

    // 3. Resolve all full symbols and prepare to batch fetch LTPs
    // Crypto positions use Binance key (BTCUSDT), others use Kite exchange-prefixed key
    const kiteSymbolsToFetch = new Set<string>();
    const cryptoSymbolsToFetch = new Set<string>();
    const comexSymbolsToFetch = new Set<string>();

    const posSymbols = positions.map(pos => {
      const isComex = (pos.settlement || '').toUpperCase().includes('COMEX') ||
        ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => (pos.symbol || '').toUpperCase().includes(c));
      const isCrypto = !isComex && ((pos.settlement || '').toUpperCase().includes('CRYPTO') ||
        ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'AVAX', 'LINK', 'LTC', 'MATIC', 'NEAR', 'SHIB', 'UNI', 'PEPE', 'USDT'].some(s => (pos.symbol || '').toUpperCase().includes(s)));
      let lookupKey: string;

      if (isComex) {
        lookupKey = pos.symbol;
        comexSymbolsToFetch.add(lookupKey);
      } else if (isCrypto) {
        let cleanSym = (pos.symbol || '').replace(/^(CRYPTO:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
        if (!cleanSym.endsWith('USDT')) cleanSym = cleanSym + 'USDT';
        lookupKey = cleanSym;
        cryptoSymbolsToFetch.add(lookupKey);
      } else {
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
        lookupKey = fullSymbol;
        kiteSymbolsToFetch.add(lookupKey);
      }

      return { pos, lookupKey };
    });

    const quotesMap = await fetchQuoteBatch(
      [...Array.from(kiteSymbolsToFetch), ...Array.from(comexSymbolsToFetch)],
      Array.from(cryptoSymbolsToFetch)
    );

    // 4. Process closings sequentially to avoid database deadlocks.
    const results: any[] = [];

    for (const { pos, lookupKey } of posSymbols) {
      try {
        // Note: Position exits (closing open positions) are allowed off-hours so users/system are never trapped in open positions.


        // Get settings and price parameters
        const dbSeg = mapSegmentWithSymbol(pos.settlement || '', pos.symbol || '');
        const upperSide = (pos.side ?? '').toUpperCase();
        const segSetting = segSettingsMap.get(`${dbSeg}|${upperSide}`) || segSettingsMap.get(`CRYPTO|${upperSide}`) || segSettingsMap.get(`NSE|${upperSide}`);
        const rawExitBuffer = segSetting?.exit_buffer;
        const exitBuffer = (rawExitBuffer !== undefined && rawExitBuffer !== null && !isNaN(Number(rawExitBuffer)))
          ? (Number(rawExitBuffer) > 0.005 ? Number(rawExitBuffer) / 100 : Number(rawExitBuffer))
          : 0;
        const profitHoldSec = segSetting?.profit_hold_sec ?? 0;
        const lossHoldSec = segSetting?.loss_hold_sec ?? 0;

        // Resolve price components from quote batch with fallback to position LTP / entry_price
        const quote = quotesMap[lookupKey];
        const rawBid = quote?.bid && quote.bid > 0 ? quote.bid : null;
        const rawAsk = quote?.ask && quote.ask > 0 ? quote.ask : null;
        const baseLtp = quote?.ltp ?? (rawBid && rawAsk ? (rawBid + rawAsk) / 2 : null) ?? Number(pos.ltp ?? pos.entry_price ?? 0);

        if (!baseLtp || baseLtp <= 0) {
          results.push({ positionId: pos.id, success: false, error: 'Market quote unavailable for this instrument' });
          continue;
        }

        const isCommodity = (pos.settlement || '').toUpperCase().includes('MCX') ||
          ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(c => (pos.symbol || '').toUpperCase().includes(c));

        const hasRealBidAsk = isCommodity ? false : Boolean(rawBid && rawAsk && rawBid > 0 && rawAsk > 0 && rawBid < rawAsk);

        const effective = resolveEffectivePrices({
          ltp: baseLtp,
          rawBid,
          rawAsk,
          hasRealBidAsk,
          askBuffer: Number(segSetting?.bid_buffer ?? 0),
          bidBuffer: Number(segSetting?.bid_buffer ?? 0),
        });

        let exitPrice: number;
        if (pos.side === 'BUY') {
          // Closing a long → sell at effective bid with exitBuffer applied
          exitPrice = effective.effectiveBid * (1 - exitBuffer);
        } else {
          // Closing a short → buy at effective ask with exitBuffer applied
          exitPrice = effective.effectiveAsk * (1 + exitBuffer);
        }
        exitPrice = Math.round(exitPrice * 100) / 100;

        const pnlValue = pos.side === 'BUY'
          ? (exitPrice - Number(pos.entry_price)) * Number(pos.qty_open)
          : (Number(pos.entry_price) - exitPrice) * Number(pos.qty_open);

        const durationSec = Math.floor((Date.now() - new Date(pos.entry_time).getTime()) / 1000);
        const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

        if (durationSec < requiredHold) {
          results.push({
            positionId: pos.id,
            success: false,
            error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required. Elapsed: ${durationSec}s.`
          });
          continue;
        }

        // --- CARRY BROKERAGE (deferred from entry to exit) ---
        let carryBrokerage = 0;
        if (!pos.carry_brokerage_paid) {
          carryBrokerage = calculateCarryBrokerage({
            productType: pos.product_type,
            qty: Number(pos.qty_open),
            entryPrice: Number(pos.entry_price),
            lots: Number(pos.lots || 0) || undefined,
            carryCommissionType: segSetting?.carry_commission_type,
            carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
            commissionType: segSetting?.commission_type,
            commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
          });
        }

        // Call RPC — sequential execution eliminates deadlocks
        let pnl: any;
        let rpcErr: any;
        
        for (let attempt = 1; attempt <= 2; attempt++) {
          const closeQty = Number(pos.qty_open !== undefined && pos.qty_open !== null && Number(pos.qty_open) > 0 ? pos.qty_open : (pos.qty_total || 1));
          const result = await admin.rpc('close_position_v2', {
            p_position_id:        pos.id,
            p_close_qty:          closeQty,
            p_close_price:        exitPrice,
            p_closed_by:          'USER',
            p_expected_brokerage: carryBrokerage,
          });
          
          pnl = result.data;
          rpcErr = result.error;
          
          if (rpcErr && rpcErr.message && rpcErr.message.toLowerCase().includes('deadlock')) {
            console.warn(`[POST /api/positions/close] Deadlock on attempt ${attempt} for position ${pos.id}. Retrying...`);
            if (attempt < 2) {
              await new Promise(resolve => setTimeout(resolve, 300));
              continue;
            }
          }
          break;
        }

        if (rpcErr) {
          const isAlreadyClosed = rpcErr.message && (
            rpcErr.message.toLowerCase().includes('already closed') ||
            rpcErr.message.toLowerCase().includes('not found')
          );
          if (isAlreadyClosed) {
            results.push({ positionId: pos.id, success: true, already_closed: true });
            continue;
          }
          console.error(`[POST /api/positions/close] RPC error for position ${pos.id}:`, rpcErr);
          results.push({ positionId: pos.id, success: false, error: rpcErr.message || 'RPC Error' });
          continue;
        }

        results.push({ positionId: pos.id, success: true, pnl: Number(pnl), exit_price: exitPrice });
      } catch (innerErr: any) {
        results.push({ positionId: pos.id, success: false, error: innerErr.message || 'Unknown error' });
      }
    }

    // Cancel open pending orders for all successfully closed positions/symbols
    const successfulPosIds = results.filter(r => r.success).map(r => r.positionId);
    if (successfulPosIds.length > 0) {
      try {
        const { invalidateUserHistoryCache } = await import('@/lib/redisHistoryCache');
        const { invalidateUserPositionsCache, invalidateUserOrdersCache } = await import('@/lib/redisSettingsCache');
        await Promise.all([
          invalidateUserHistoryCache(user.id),
          invalidateUserPositionsCache(user.id),
          invalidateUserOrdersCache(user.id),
        ]);
      } catch (cacheErr) {
        console.warn('[POST /api/positions/close] Cache invalidation warning:', cacheErr);
      }

      (async () => {
        try {
          const { PositionService } = await import('@/lib/trading/PositionService');
          const closedPositions = positions.filter(p => successfulPosIds.includes(p.id));
          for (const pos of closedPositions) {
            await PositionService.cancelPendingOrdersForClosedPosition(admin, user.id, pos.id, pos.symbol);
          }
        } catch (cancelErr) {
          console.warn('[POST /api/positions/close] Non-fatal error cleaning up pending orders:', cancelErr);
        }
      })();
    }

    return NextResponse.json({ success: true, results }, { status: 200 });
  } catch (err: any) {
    console.error('[POST /api/positions/close] Request error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}



