import { getAdminClient } from '@/lib/adminClient';
import { getPlatformSetting } from '@/lib/getPlatformSetting';
import { fetchBinanceQuote, fetchKiteQuotes, fetchSpeedQuotes } from '../datafeed/MarketDataService';
import { calculateBufferedPrice } from './BufferCalculator';
import { resolveEffectivePrices } from './marketPriceResolver';
import { calculateSingleLegCharge, calculateOrderBrokerage } from './BrokerageCalculator';
import { RiskValidation } from './RiskValidation';
import { OrderService } from './OrderService';
import { ExecutionService, ExecutionParams } from './ExecutionService';
import { ConfigurationService } from './ConfigurationService';
import { mapSegmentToDbSegment, mapSymbolToSegment } from './SymbolMapping';
import { SymbolNormalizer } from './SymbolNormalizer';
import { getLotSizeFallback } from '@/lib/lotSize';
import { parseOptionSymbol } from '../positionStore';
import { validateOptionStrike } from './OptionStrikeValidator';

export interface PlaceOrderRequest {
  symbol: string;
  kite_instrument: string;
  segment: string;
  side: 'BUY' | 'SELL';
  order_type: 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT';
  product_type: 'INTRADAY' | 'CARRY';
  qty: number;
  lots: number;
  client_price?: number;
  trigger_price?: number;
  stop_loss?: number;
  target?: number;
  is_exit?: boolean;
  linked_position_id?: string;
}

export class TradeEngine {
  
  static async placeOrder(user: any, request: PlaceOrderRequest, ipAddress: string) {
    const admin = getAdminClient();
    let { symbol, kite_instrument: kiteInst, segment, side, order_type, product_type, qty, lots, client_price, trigger_price, stop_loss, target, is_exit, linked_position_id } = request;
    
    is_exit = is_exit === true || (is_exit as any) === 'true';
    kiteInst = kiteInst || symbol || '';
    if (side) side = side.toUpperCase() as 'BUY' | 'SELL';

    let dbSegment = mapSegmentToDbSegment(segment);
    const symUp = symbol.toUpperCase();

    // 1. Initial Profile Fetch handled entirely within get_trade_context later!
    // But we need to early exit if no user... Wait, user is already verified by API layer.
    // Let's just resolve segment first.
    if (dbSegment === 'CRYPTO' || ['BTC', 'ETH', 'DOGE', 'DODGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'].some(c => symUp === c || symUp.startsWith(c + 'USDT'))) {
       dbSegment = 'CRYPTO';
       const kiUpper = kiteInst.toUpperCase();
       let cleanKi = kiUpper.replace(/^(CRYPTO:|BINANCE:)/i, '');
       if (cleanKi === 'DODGE' || cleanKi === 'DODGEUSDT') cleanKi = 'DOGE';
       kiteInst = cleanKi.endsWith('USDT') ? cleanKi : cleanKi + 'USDT';
       // Keep `symbol` in the same format as stored in DB (e.g. BTCUSDT or BTC)
    } else if (dbSegment !== 'COMEX' && (symUp.includes('GOLD') || symUp.includes('SILVER') || symUp.includes('CRUDE') || symUp.includes('NATGAS') || symUp.includes('NATURALGAS'))) {
       dbSegment = (symUp.endsWith('CE') || symUp.endsWith('PE')) ? 'MCX-OPT' : 'MCX-FUT';
     } else {
       const VALID_DB_SEGMENTS = new Set([
         'INDEX-FUT', 'INDEX-OPT', 'STOCK-FUT', 'STOCK-OPT',
         'MCX-FUT', 'MCX-OPT', 'NSE-EQ', 'BSE-EQ', 'CRYPTO', 'FOREX', 'COMEX'
       ]);
       if (!VALID_DB_SEGMENTS.has(dbSegment)) {
         dbSegment = mapSymbolToSegment(symbol);
       }
     }

    // Determine segments for market hours
    const segUpper = dbSegment.toUpperCase();
    const segmentId = RiskValidation.resolveTradingHoursSegmentId(symbol, dbSegment);


    // ── Resolve kiteInst to a fully-qualified Kite key (EXCHANGE:TRADINGSYMBOL) ──
    // When exiting from the positions page, the positions table has no
    // kite_instrument column, so kiteInst falls back to the raw `symbol`
    // (e.g. "CRUDEOIL_FUT"). We must resolve it to a valid Kite key before
    // the quote fetch, otherwise the price lookup will fail.
    if (kiteInst && !kiteInst.includes(':')) {
      const kiUpper = kiteInst.toUpperCase();
      if (segUpper.includes('MCX') || segUpper.includes('CDS') || segUpper.includes('FOREX')) {
        // COMEX/FOREX synthetic symbols like CRUDEOIL_FUT or JPYINR_FUT → strip _FUT and resolve
        // to the nearest active futures contract
        const prefix = segUpper.includes('MCX') ? 'MCX' : 'CDS';
        let baseName = kiUpper;
        if (baseName.endsWith('_FUT')) baseName = baseName.slice(0, -4);
        
        const cacheKey = `nearest_fut_${prefix}_${baseName}`;
        const { getRedisClient } = require('@/lib/redis');
        const redis = getRedisClient();
        
        let resolvedSymbol = await redis.get(cacheKey);
        
        if (!resolvedSymbol) {
          const { data: nearestFut } = await admin
            .from('instruments')
            .select('tradingsymbol, expiry')
            .eq('name', baseName)
            .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT', 'FUTOPT'])
            .gte('expiry', new Date().toISOString().split('T')[0])
            .order('expiry', { ascending: true })
            .limit(1)
            .maybeSingle();
            
          if (nearestFut?.tradingsymbol) {
            resolvedSymbol = nearestFut.tradingsymbol;
            // TTL: min(1 hour, seconds until end of expiry day in IST) so stale contracts never survive rollover
            let ttl = 3600;
            if (nearestFut.expiry) {
              const expiryEndIST = new Date(nearestFut.expiry);
              expiryEndIST.setUTCHours(18, 30, 0, 0); // midnight IST = 18:30 UTC
              const secsUntilExpiry = Math.floor((expiryEndIST.getTime() - Date.now()) / 1000);
              if (secsUntilExpiry > 0) ttl = Math.min(ttl, secsUntilExpiry);
            }
            await redis.setex(cacheKey, ttl, resolvedSymbol);
          }
        }
        
        if (resolvedSymbol) {
          kiteInst = `${prefix}:${resolvedSymbol}`;
        } else {
          kiteInst = `${prefix}:${kiteInst}`;
        }
      } else if (segUpper.includes('BSE') || segUpper.includes('BFO')) {
        kiteInst = `BFO:${kiteInst}`;
        if (!kiteInst.match(/\d/)) kiteInst = `BSE:${kiUpper}`; // bare index
      } else if (segUpper.includes('OPT') || segUpper.includes('FUT') || segUpper.includes('NFO')) {
        kiteInst = `NFO:${kiteInst}`;
        if (!kiteInst.match(/\d/)) kiteInst = `NSE:${kiUpper}`; // bare index
      }
    }

    const isOption = dbSegment.includes('OPT');
    let underlyingId = 'NSE:NIFTY 50';
    
    if (isOption) {
      const parsed = parseOptionSymbol(symbol);
      const u = parsed?.underlying || 'NIFTY';
      
      if (dbSegment === 'MCX-OPT') {
        // Resolve the future contract matching this option's specific expiry cycle
        const cleanSym = symbol.includes(':') ? symbol.split(':')[1] : symbol;
        const mcxMatch = cleanSym.toUpperCase().match(/^([A-Z]+)(\d{2}[A-Z]{3})\d+(?:CE|PE)$/);
        let resolvedFut: string | null = null;
        if (mcxMatch) {
          resolvedFut = `${mcxMatch[1]}${mcxMatch[2]}FUT`;
        }

        if (resolvedFut) {
          underlyingId = `MCX:${resolvedFut}`;
        } else {
          // Try Redis cache for the nearest futures contract
          let cachedFut: string | null = null;
          try {
            const { getRedisClient } = require('@/lib/redis');
            const redisCl = getRedisClient();
            cachedFut = await redisCl.get(`nearest_fut_MCX_${u}`);
          } catch {}

          if (cachedFut) {
            underlyingId = `MCX:${cachedFut}`;
          } else {
            // Fallback: Query the database for the active nearest futures contract
            const { data: nearestFut } = await admin
              .from('instruments')
              .select('tradingsymbol')
              .eq('name', u)
              .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT', 'FUTOPT'])
              .gte('expiry', new Date().toISOString().split('T')[0])
              .order('expiry', { ascending: true })
              .limit(1)
              .maybeSingle();

            if (nearestFut?.tradingsymbol) {
              underlyingId = `MCX:${nearestFut.tradingsymbol}`;
              try {
                const { getRedisClient } = require('@/lib/redis');
                const redisCl = getRedisClient();
                await redisCl.setex(`nearest_fut_MCX_${u}`, 3600, nearestFut.tradingsymbol);
              } catch {}
            } else {
              underlyingId = `MCX:${u}`;
            }
          }
        }
      } else if (u === 'BANKNIFTY') underlyingId = 'NSE:NIFTY BANK';
      else if (u === 'FINNIFTY') underlyingId = 'NSE:NIFTY FIN SERVICE';
      else if (u === 'SENSEX') underlyingId = 'BSE:SENSEX';
      else if (u === 'BANKEX') underlyingId = 'BSE:BANKEX';
      else if (u === 'MIDCPNIFTY') underlyingId = 'NSE:NIFTY MID SELECT';
      else if (u !== 'NIFTY') underlyingId = `NSE:${u}`;
    }

    const symbolsToFetch = [
      dbSegment === 'CRYPTO' ? SymbolNormalizer.normalizeCryptoSymbol(symbol) : symbol,
      kiteInst,
      underlyingId
    ];

    // Single DB Round-Trip for all user context, positions, and instrument settings
    const [
      tradeContextResult,
      marketHoursResult,
      segmentSettingsResult,
      quotesMap
    ] = await Promise.all([
      admin.rpc('get_trade_context_v1', { p_user_id: user.id, p_symbols: symbolsToFetch }),
      ConfigurationService.getMarketHours(segmentId),
      ConfigurationService.getSegmentSettings(dbSegment),
      (async () => {
        if (dbSegment === 'CRYPTO') {
          const q = await fetchBinanceQuote(symbol);
          if (!q) return {};
          // Store under both `symbol` (e.g. BTC) and `kiteInst` (e.g. BTCUSDT)
          // so the price lookup at quotesMap[kiteInst] succeeds
          const map: Record<string, any> = {
            [symbol]: q.bid, [`${symbol}_bid`]: q.bid, [`${symbol}_ask`]: q.ask,
          };
          if (kiteInst && kiteInst !== symbol) {
            map[kiteInst] = q.bid;
            map[`${kiteInst}_bid`] = q.bid;
            map[`${kiteInst}_ask`] = q.ask;
          }
          return map;
        }
        const instrumentsToFetch = [kiteInst];
        if (isOption && underlyingId !== kiteInst) instrumentsToFetch.push(underlyingId);
        return fetchSpeedQuotes(instrumentsToFetch);
      })()
    ]);

    if (tradeContextResult.error) {
      throw new Error(`Failed to fetch trade context: ${tradeContextResult.error.message}`);
    }

    const ctx = tradeContextResult.data;
    const profile = ctx.profile;
    
    if (!profile) throw new Error('User profile not found.');
    if (!profile.active) throw new Error('Account is inactive');

    // Cache the profile balance in Redis asynchronously with a 5-minute TTL for fast-reject
    try {
      const { getRedisClient } = require('@/lib/redis');
      const redis = getRedisClient();
      redis.set(`balance:${user.id}`, profile.balance.toString(), 'EX', 300).catch(() => {});
    } catch {}

    // Database segments use format like 'NSE-EQ', 'MCX-FUT', 'CRYPTO'.
    // TradeEngine segmentId uses short codes: 'nse', 'mcx', 'crypto', etc.
    // Map each segmentId to the DB segment values that grant access to it.
    const SEGMENT_MAP: Record<string, string[]> = {
      nse:    ['NSE-EQ', 'NSE-FUT', 'INDEX-FUT', 'INDEX-OPT', 'STOCK-FUT', 'STOCK-OPT'],
      mcx:    ['MCX-FUT', 'MCX-OPT'],
      bse:    ['BSE-EQ', 'BSE-FUT', 'BFO-FUT', 'BFO-OPT'],
      forex:  ['FOREX', 'CDS-FUT', 'CDS-OPT'],
      crypto: ['CRYPTO'],
      comex:  ['COMEX'],
    };
    const allowedDbSegments = SEGMENT_MAP[segmentId] ?? [segmentId.toUpperCase()];
    const userSegments: string[] = profile.segments ?? [];
    if (!allowedDbSegments.some((s: string) => userSegments.includes(s))) {
      throw new Error('Segment is not enabled for this account');
    }

    const openPositions = ctx.open_positions || [];
    const pendingOrders = ctx.pending_orders || [];
    const instrumentDetail = ctx.instruments?.find((i: any) => i.tradingsymbol === kiteInst || i.tradingsymbol === symbol);
    
    // Fallbacks from script settings if instrument table is missing data
    // For MCX/options, instruments table often has lot_size=1 (Zerodha placeholder) — treat ≤1 as unreliable
    const rawInstrumentLotSize = Number(instrumentDetail?.lot_size || 0);
    const scriptSetting = ctx.script_settings?.find((s: any) => s.symbol === symbol || s.symbol === kiteInst || s.symbol === underlyingId);
    let symbolLotSize = (rawInstrumentLotSize > 1)
      ? rawInstrumentLotSize
      : Number(scriptSetting?.lot_size || getLotSizeFallback(symbol, ctx.script_settings));

    const isBlocked = ctx.is_blocked?.some((b: any) => {
      const blockedUpper = b.symbol.toUpperCase();
      const symbolUpper = symbol.toUpperCase();
      const kiteInstUpper = kiteInst.toUpperCase();
      const instNameUpper = instrumentDetail?.name?.toUpperCase() || '';
      
      const parsed = parseOptionSymbol(symbol);
      const optionUnderlying = parsed?.underlying?.toUpperCase() || '';
      
      const isPrefixMatch = symbolUpper.startsWith(blockedUpper) || 
                            kiteInstUpper.includes(blockedUpper);
                            
      return symbolUpper === blockedUpper || 
             kiteInstUpper === blockedUpper || 
             instNameUpper === blockedUpper ||
             optionUnderlying === blockedUpper ||
             isPrefixMatch;
    });
    
    if (isBlocked) {
      throw new Error('Trading Not Allowed In This Script. Please Contact Admin.');
    }
    const isCarry = product_type === 'CARRY';

    // Fetch per-user segment settings to get actual commission_type/commission_value.
    // The global ConfigurationService.getSegmentSettings() returns a different table
    // (segment-level admin config) and has commission_value = 0.
    // The real per-user settings are in segment_settings / scalper_segment_settings
    // filtered by user_id and segment.
    // Sub-accounts inherit from their parent — use parent_id when present.
    const tradingMode = profile.trading_mode || 'normal';
    const settingsTable = tradingMode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';
    const settingsLookupId = profile.parent_id ?? user.id;
    const { data: userSegRows, error: segRowsError } = await admin
      .from(settingsTable)
      .select('side, trade_allowed, max_lot, max_order_lot, intraday_leverage, holding_leverage, intraday_type, holding_type, commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value, profit_hold_sec, loss_hold_sec, strike_range, entry_buffer, exit_buffer, top_limit, min_limit, exit_price_mode, use_custom_calc')
      .eq('user_id', settingsLookupId)
      .eq('segment', dbSegment);

    if (segRowsError) {
      console.error('[TradeEngine] Failed to fetch segment settings:', segRowsError.message);
    }

    const userBuySetting  = userSegRows?.find((s: any) => s.side === 'BUY')  ?? null;
    const userSellSetting = userSegRows?.find((s: any) => s.side === 'SELL') ?? null;

    // Merge: user-specific settings take priority over global fallback defaults
    let buySetting = { side: 'BUY', trade_allowed: true, max_lot: 50, max_order_lot: 50, intraday_leverage: 10, holding_leverage: 10, intraday_type: 'Multiplier', holding_type: 'Multiplier', commission_type: 'Per Crore', commission_value: 0, ...segmentSettingsResult, ...(userBuySetting ?? {}) };
    let sellSetting = { side: 'SELL', trade_allowed: true, max_lot: 50, max_order_lot: 50, intraday_leverage: 10, holding_leverage: 10, intraday_type: 'Multiplier', holding_type: 'Multiplier', commission_type: 'Per Crore', commission_value: 0, ...segmentSettingsResult, ...(userSellSetting ?? {}) };
    
    const segSetting = side === 'BUY' ? buySetting : sellSetting;

    // 1b. Check Instrument Blocked Status again just in case the name logic caught it
    if (instrumentDetail?.name && isBlocked) {
      throw new Error('Trading Not Allowed In This Script. Please Contact Admin.');
    }

    if (segmentId !== 'crypto' && !RiskValidation.validateTradingHours(marketHoursResult)) {
      throw new Error('market is closed');
    }

    if (!segSetting || !segSetting.trade_allowed) {
      throw new Error('Trading Not Allowed In This Script. Please Contact Admin.');
    }

    // Expiry Check
    if (!is_exit && !dbSegment.includes('CRYPTO') && instrumentDetail?.expiry) {
      const expiryDay = new Date(instrumentDetail.expiry);
      expiryDay.setHours(0,0,0,0);
      const todayDay = new Date();
      todayDay.setHours(0,0,0,0);
      if (expiryDay.getTime() < todayDay.getTime()) {
        throw new Error('This contract has expired. You cannot open new positions.');
      }
    }

    // Lot Size & Quantity Validation
    if (!symbolLotSize || symbolLotSize <= 0) {
      throw new Error('Invalid lot size for symbol');
    }

    if (!RiskValidation.validateLotSize(qty, symbolLotSize)) {
      throw new Error(`Quantity must be a multiple of lot size (${symbolLotSize})`);
    }

    const maxQty = Number(segSetting.max_order_lot || 50) * symbolLotSize;
    if (!is_exit && !RiskValidation.validateFreezeQuantity(qty, maxQty)) {
      throw new Error(`The maximum allowed per order is ${segSetting.max_order_lot} lots or ${maxQty} qty. Please place your trade in multiple orders.`);
    }

    const activePosition = openPositions.find((p: any) => p.symbol === symbol && p.product_type === (product_type || 'INTRADAY'));
    // DB RPC place_order_v2 natively handles opposite-side netting and splitting.
    if (activePosition && activePosition.side !== side) {
      is_exit = true;
    }

    // Cumulative Position limit check (Per Segment across open positions and pending orders)
    let openPositionsLots = 0;
    let pendingOrdersLots = 0;
    const ctxScriptSettings = ctx.script_settings || [];

    const resolveLotSizeForSymbol = (sym: string): number => {
      if (sym === symbol || sym === kiteInst) return symbolLotSize;
      const inst = ctx.instruments?.find((i: any) => i.tradingsymbol === sym || i.name === sym);
      const instLot = Number(inst?.lot_size || 0);
      if (instLot > 1) return instLot;
      const scriptLot = Number(ctxScriptSettings.find((s: any) => s.symbol === sym)?.lot_size || 0);
      if (scriptLot > 0) return scriptLot;
      return getLotSizeFallback(sym, ctxScriptSettings);
    };

    let openPositionsSegmentLots = 0;
    let openPositionsInstrumentLots = 0;
    let pendingOrdersSegmentLots = 0;
    let pendingOrdersInstrumentLots = 0;

    for (const pos of openPositions) {
      const posSegment = mapSymbolToSegment(pos.symbol);
      const pLot = resolveLotSizeForSymbol(pos.symbol);
      const pLots = (pLot > 0)
        ? ((Number(pos.lots) > 0 && Number(pos.qty_open) === Number(pos.qty_total))
            ? Number(pos.lots)
            : (Number(pos.qty_open) / pLot))
        : 0;

      if (posSegment === dbSegment) {
        openPositionsSegmentLots += pLots;
      }
      if (pos.symbol === symbol || pos.symbol === kiteInst) {
        openPositionsInstrumentLots += pLots;
      }
    }

    for (const po of pendingOrders) {
      if (!po.is_exit) {
        const poSegment = mapSymbolToSegment(po.symbol);
        const poLot = resolveLotSizeForSymbol(po.symbol);
        const poLots = (poLot > 0)
          ? ((Number(po.lots) > 0 && Number(po.qty) > 0)
              ? Number(po.lots)
              : (Number(po.qty) / poLot))
          : 0;

        if (poSegment === dbSegment) {
          pendingOrdersSegmentLots += poLots;
        }
        if (po.symbol === symbol || po.symbol === kiteInst) {
          pendingOrdersInstrumentLots += poLots;
        }
      }
    }

    const totalOpenSegmentLots = openPositionsSegmentLots + pendingOrdersSegmentLots;
    const totalOpenInstrumentLots = openPositionsInstrumentLots + pendingOrdersInstrumentLots;
    const newOrderLots = qty / symbolLotSize;

    if (!is_exit) {
      const maxLotLimit = Number(segSetting.max_lot || 50);
      if (totalOpenInstrumentLots + newOrderLots > maxLotLimit) {
        const remainingLots = Math.max(0, maxLotLimit - totalOpenInstrumentLots);
        throw new Error(`Order exceeds maximum cap of ${maxLotLimit} lots for this instrument. Current open positions: ${totalOpenInstrumentLots.toFixed(2)} lots. Remaining capacity: ${remainingLots.toFixed(2)} lots.`);
      }
      if (!RiskValidation.validateMaxLotLimit(totalOpenSegmentLots + newOrderLots, maxLotLimit)) {
        const breakdownMsg = pendingOrdersSegmentLots > 0
          ? `(${openPositionsSegmentLots.toFixed(2)} open positions + ${pendingOrdersSegmentLots.toFixed(2)} pending orders)`
          : `(${totalOpenSegmentLots.toFixed(2)} in open positions)`;
        throw new Error(`Order exceeds maximum segment limit of ${segSetting.max_lot} lots. Current segment exposure: ${totalOpenSegmentLots.toFixed(2)} lots ${breakdownMsg}.`);
      }
    }

    let kiteLtp = quotesMap[kiteInst] ?? null;
    let kiteBid = quotesMap[`${kiteInst}_bid`] || kiteLtp;
    let kiteAsk = quotesMap[`${kiteInst}_ask`] || kiteLtp;
    const depthBuy: any[] = quotesMap[`${kiteInst}_depth_buy`] || [];
    const depthSell: any[] = quotesMap[`${kiteInst}_depth_sell`] || [];

    // Speed cache missed (common for MCX options not streamed by Ticker Daemon).
    // Fall back: 1) client_price observed by the UI, 2) Kite REST quote.
    if (!kiteLtp || kiteLtp <= 0) {
      if (client_price && client_price > 0) {
        kiteLtp = client_price;
        kiteBid = client_price;
        kiteAsk = client_price;
      } else {
        // Last resort: one direct Kite REST call
        try {
          const restQuotes = await fetchKiteQuotes([kiteInst]);
          const ltp = restQuotes?.[kiteInst];
          if (ltp && ltp > 0) {
            kiteLtp = ltp;
            kiteBid = restQuotes[`${kiteInst}_bid`] || ltp;
            kiteAsk = restQuotes[`${kiteInst}_ask`] || ltp;
          }
        } catch {}
      }
    }

    if (!kiteLtp || kiteLtp <= 0) {
      throw new Error('Market data unavailable. Execution rejected.');
    }

    if (isOption) {
      let underlyingPrice = quotesMap[underlyingId] ?? null;
      if (!underlyingPrice || underlyingPrice <= 0) {
        try {
          const restQuotes = await fetchKiteQuotes([underlyingId]);
          const ltp = restQuotes?.[underlyingId];
          if (ltp && ltp > 0) {
            underlyingPrice = ltp;
          }
        } catch {}
      }

      if (!underlyingPrice || underlyingPrice <= 0) {
        throw new Error('Underlying market data unavailable. Option execution rejected.');
      }
      
      quotesMap[underlyingId] = underlyingPrice;
    }

    const clientPriceNum = client_price || 0;
    const limitErr = OrderService.validateLimitPrice(order_type, side, clientPriceNum, kiteLtp, is_exit);
    if (limitErr) throw new Error(limitErr);

    const slErr = OrderService.validateStopLoss(order_type, side, trigger_price || null, kiteLtp, is_exit);
    if (slErr) throw new Error(slErr);

    const targetErr = OrderService.validateTargetAndStopLoss(is_exit, (is_exit && activePosition) ? activePosition.side === 'BUY' : side === 'BUY', target || null, stop_loss || null, kiteLtp, clientPriceNum, ['LIMIT', 'SL', 'GTT'].includes(order_type));
    if (targetErr) throw new Error(targetErr);

    const limitsErr = OrderService.validateSegmentPriceLimits(order_type, clientPriceNum, kiteLtp, Number(segSetting.top_limit ?? 0), Number(segSetting.min_limit ?? 0));
    if (limitsErr) throw new Error(limitsErr);

    if (isOption && !is_exit) {
      const valRes = await validateOptionStrike({
        symbol,
        isExit: false,
        knownQuotesMap: quotesMap,
      });
      if (!valRes.allowed) {
        throw new Error(valRes.reason || `Strike price ${valRes.orderStrike} is outside the active option chain window (${valRes.minAllowed} to ${valRes.maxAllowed}).`);
      }
    }

    const holdErr = OrderService.validateHoldDuration(is_exit, order_type, activePosition, kiteLtp, Number(segSetting.profit_hold_sec ?? 120), Number(segSetting.loss_hold_sec ?? 0), Number(segSetting.exit_buffer ?? 0.0017));
    if (holdErr) throw new Error(holdErr);

    const isGTT = order_type === 'GTT';
    // Use client_price for LIMIT/GTT margin calculation (same as old order execution)
    const marginPrice = (order_type === 'LIMIT' || isGTT) ? (clientPriceNum > 0 ? clientPriceNum : kiteLtp) : kiteLtp;
    const exposure = qty * marginPrice;

    let marginPortion = 0;
    let brokerage = 0;

    const isCustomCalc = side === 'BUY' ? buySetting?.use_custom_calc : sellSetting?.use_custom_calc;

    if (!is_exit) {
      const leverage = isCarry
        ? Number(segSetting.holding_leverage ?? 1)
        : Number(segSetting.intraday_leverage ?? 1);
      marginPortion = exposure / leverage;

      // Brokerage: calculate using aggregated model (intraday + carry + gtt)
      const brokerageRes = calculateOrderBrokerage({
        exposure,
        lots: newOrderLots,
        productType: product_type ?? 'INTRADAY',
        orderType: order_type,
        isExit: false,
        segSetting,
        dbSegment,
      });
      brokerage = brokerageRes.totalBrokerage;
    } else {
      // Exit order: brokerage already collected at entry — charge nothing
      brokerage = 0;
    }

    // Inline balance check (mirrors old route's explicit check before hitting the DB)
    const balance = Number(profile.balance ?? 0);
    const requiredMargin = marginPortion + brokerage;
    if (!is_exit && balance < requiredMargin) {
      throw new Error(`Insufficient margin. Available: ₹${balance.toFixed(2)}, Required: ₹${requiredMargin.toFixed(2)}`);
    }


    // 4. Execution Price Calculation (BufferCalculator)
    const isLimitType = ['LIMIT', 'SL', 'GTT'].includes(order_type);
    
    let executionBasePrice: number;

    if (isLimitType) {
      executionBasePrice = clientPriceNum > 0 ? clientPriceNum : kiteLtp;
    } else {
      const hasRealBidAsk = Boolean(quotesMap[`${kiteInst}_bid`] && quotesMap[`${kiteInst}_ask`]);

      const symbolExchange = (symbol.includes(':') ? symbol.split(':')[0] : '').toUpperCase();
      const isCommodity = symbolExchange === 'MCX' || symbolExchange === 'NCO' ||
        symbol.startsWith('MCX:') || symbol.startsWith('MCX-') ||
        dbSegment.includes('MCX') ||
        ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(c => symbol.toUpperCase().includes(c));

      const isIndianNonCommodity = (['NSE', 'NFO', 'BSE', 'BFO'].includes(symbolExchange) ||
        symbol.startsWith('NSE:') || symbol.startsWith('NFO:') || symbol.startsWith('BSE:') || symbol.startsWith('BFO:')) && !isCommodity;

      const askBuf = isIndianNonCommodity ? 0 : ((buySetting as any)?.entry_buffer ?? (buySetting as any)?.bid_buffer ?? 0.003);
      const bidBuf = isIndianNonCommodity ? 0 : ((sellSetting as any)?.entry_buffer ?? (sellSetting as any)?.bid_buffer ?? 0.003);

      const effectivePrices = resolveEffectivePrices({
        ltp: kiteLtp,
        rawBid: kiteBid,
        rawAsk: kiteAsk,
        hasRealBidAsk: isCommodity ? false : hasRealBidAsk,
        askBuffer: askBuf,
        bidBuffer: bidBuf,
      });

      const isExecutingBuy = side === 'BUY';
      const depth = isExecutingBuy ? depthSell : depthBuy;
      
      let remainingQty = qty;
      let totalCost = 0;
      let matchedQty = 0;

      if (depth && Array.isArray(depth) && depth.length > 0) {
        // Sort levels (best price first). Ask (Sell) side: lowest price first. Bid (Buy) side: highest price first.
        const sortedDepth = [...depth].sort((a, b) => isExecutingBuy ? a.price - b.price : b.price - a.price);

        for (const level of sortedDepth) {
          if (remainingQty <= 0) break;
          const levelQty = Number(level.quantity || 0);
          if (levelQty <= 0) continue;

          const matchAmount = Math.min(remainingQty, levelQty);
          totalCost += matchAmount * level.price;
          matchedQty += matchAmount;
          remainingQty -= matchAmount;
        }
      }

      if (matchedQty > 0) {
        // If partial fill from depth, fallback remaining to Effective Ask/Bid
        if (remainingQty > 0) {
          const fallbackPrice = isExecutingBuy ? effectivePrices.effectiveAsk : effectivePrices.effectiveBid;
          totalCost += remainingQty * fallbackPrice;
          matchedQty += remainingQty;
        }
        executionBasePrice = totalCost / matchedQty;
      } else {
        // Fallback directly to Effective Ask for BUY, Effective Bid for SELL
        executionBasePrice = isExecutingBuy ? effectivePrices.effectiveAsk : effectivePrices.effectiveBid;
      }
    }

    const exitPriceMode = (await getPlatformSetting('EXIT_PRICE_MODE', 'BID_ASK')) as 'BID_ASK' | 'LTP';
    let fillPrice = calculateBufferedPrice({
      side,
      isExit: is_exit,
      basePrice: executionBasePrice,
      buySetting,
      sellSetting,
      brokeragePerUnit: 0,
      exitPriceMode,
      isBasePriceRealBidAsk: true,
    });

    fillPrice = Math.max(0.01, Math.round(fillPrice * 100) / 100);

    const isImmediate = order_type === 'MARKET';

    // 5. Execute Order (ExecutionService)
    const executionParams: ExecutionParams = {
      userId: user.id,
      symbol,
      kiteInst,
      dbSegment,
      side,
      orderType: order_type,
      productType: product_type || 'INTRADAY',
      qty,
      lots: newOrderLots,
      baseLtp: kiteLtp,
      fillPrice,
      bufferFee: 0,
      triggerPrice: trigger_price || null,
      stopLoss: stop_loss || null,
      target: target || null,
      isExit: is_exit,
      linkedPositionId: linked_position_id,
      isImmediate,
      requiredMargin,
      brokerage
    };

    const orderId = await ExecutionService.executeOrder(executionParams);

    // 6. Return response to API route
    return {
      order_id: orderId,
      status: isImmediate ? 'EXECUTED' : 'PENDING',
      fill_price: fillPrice,
      message: `${side} order placed at ₹${fillPrice.toFixed(2)}`,
    };
  }
}
