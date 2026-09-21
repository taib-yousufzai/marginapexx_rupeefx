/**
 * Internal Order API — MarginApex platform orders
 *
 * GET  /api/orders          → user's own order history (from Supabase)
 * POST /api/orders          → place a new order through MarginApex
 *
 * All order placement runs through this endpoint. Zerodha is NEVER called
 * to place orders — it is used read-only to fetch the LTP for fill price
 * computation only.
 *
 * Fill price = Kite LTP ± segment_settings.entry_buffer / exit_buffer
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient } from '@/lib/redis';
import { getCachedScriptSettings, getCachedUserProfile, getCachedUserSegmentSettings, invalidateUserPositionsCache, invalidateUserOrdersCache } from '@/lib/redisSettingsCache';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

function getLotSize(symbol: string, dbSettings?: { symbol: string; lot_size: number }[] | Record<string, number>): number {
  let n = symbol.toUpperCase();
  if (n === 'DODGE' || n === 'DODGEUSDT') n = 'DOGE';
  if (dbSettings) {
    if (Array.isArray(dbSettings)) {
      const match = dbSettings.find(s => {
        const sym = s.symbol.toUpperCase();
        return n.includes(sym) || sym.includes(n) || (n === 'DOGE' && sym.includes('DODGE'));
      });
      if (match) return Number(match.lot_size);
    } else {
      for (const [sym, size] of Object.entries(dbSettings)) {
        const upper = sym.toUpperCase();
        if (n.includes(upper) || upper.includes(n) || (n === 'DOGE' && upper.includes('DODGE'))) return Number(size);
      }
    }
  }
  if (n.includes('BANKNIFTY') || n.includes('BANKEX')) return 15;
  if (n.includes('FINNIFTY')) return 40;
  if (n.includes('MIDCP') || n.includes('MIDCAP')) return 75;
  if (n.includes('SENSEX')) return 10;
  if (n.includes('NIFTY')) return 25;
  return 1;
}

function cleanSymHelper(s?: string | null): string {
  if (!s) return '';
  let str = s.replace(/^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)/i, '')
             .replace(/[\/\s\_\-]/g, '')
             .replace(/(PERP|\.P|FUT)$/i, '')
             .toUpperCase();
  if (['XAUUSD', 'COMEX:XAUUSD', 'GC=F', 'GC', 'GOLD'].includes(str)) return 'XAUUSD';
  if (['XAGUSD', 'COMEX:XAGUSD', 'SI=F', 'SI', 'SILVER'].includes(str)) return 'XAGUSD';
  if (['XTIUSD', 'COMEX:XTIUSD', 'CL=F', 'CL', 'WTI', 'CRUDE', 'CRUDEOIL'].includes(str)) return 'XTIUSD';
  if (['XCUUSD', 'COMEX:XCUUSD', 'HG=F', 'HG', 'COPPER'].includes(str)) return 'XCUUSD';
  if (['XNGUSD', 'COMEX:XNGUSD', 'NG=F', 'NG', 'NATGAS', 'NATURALGAS'].includes(str)) return 'XNGUSD';
  if (str === 'DODGE' || str === 'DODGEUSDT' || str === 'DOGE' || str === 'DOGEUSDT') return 'DOGEUSDT';
  const nonCrypto = ['GBPUSD', 'EURUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USDCHF', 'XAUUSD', 'XAGUSD', 'XTIUSD', 'XNGUSD', 'XCUUSD', 'GOLD', 'SILVER', 'COPPER', 'CRUDE', 'NATGAS'];
  const knownBaseCrypto = ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC', 'LINK', 'UNI', 'BCH', 'SHIB', 'PEPE', 'TRX', 'NEAR', 'SUI', 'APT', 'FET', 'RNDR', 'INJ', 'TIA', 'OP', 'ARB'];
  if (knownBaseCrypto.includes(str)) {
    str += 'USDT';
  } else if (str.endsWith('USD') && !str.endsWith('USDT') && !nonCrypto.includes(str)) {
    str = str.slice(0, -3) + 'USDT';
  }
  return str;
}
import { getPlatformSetting } from '@/lib/getPlatformSetting';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import type {
  PlaceOrderRequest,
  PlaceOrderResponse,
  MyOrder,
} from '@/lib/types/order';
import { calculateSingleLegCharge, calculateOrderBrokerage } from '@/lib/trading/BrokerageCalculator';
import { resolveEffectivePrices } from '@/lib/trading/marketPriceResolver';
import { RiskValidation } from '@/lib/trading/RiskValidation';

import { mapSymbolToSegment, mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';
import { calculateBufferedPrice } from '@/lib/trading/BufferCalculator';
import { resolveUnderlyingKiteId, validateOptionStrike } from '@/lib/trading/OptionStrikeValidator';
import { sanitizeOrderInfo } from '@/lib/trading/orderSanitizer';
import { OrderService } from '@/lib/trading/OrderService';

// In-memory cache for segment trading hours (avoids ~767ms serial Supabase round-trip on every order)
const tradingHoursCache = new Map<string, { data: any; expiresAt: number }>();
const TRADING_HOURS_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch the Binance quote (LTP, bid, ask, depth) for a crypto symbol.
 */
async function fetchBinanceQuote(symbol: string): Promise<ServerQuote | null> {
  try {
    let cleanSym = symbol.replace(/^(CRYPTO:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
    if (cleanSym === 'DODGE' || cleanSym === 'DODGEUSDT') cleanSym = 'DOGEUSDT';
    if (!cleanSym.endsWith('USDT')) {
      cleanSym = cleanSym + 'USDT';
    }
    const baseClean = cleanSym.replace('USDT', '');

    // 1. Try Redis cache first (0.5ms) across all possible crypto symbol keys
    try {
      const redis = getRedisClient();
      const keysToTry = [cleanSym, baseClean, `CRYPTO:${cleanSym}`, `CRYPTO:${baseClean}`, `BINANCE:${cleanSym}`];
      for (const k of keysToTry) {
        const cached = await redis.hget('market:quotes', k);
        if (cached) {
          const tick = JSON.parse(cached);
          const ltp = Number(tick.last_price || tick.lastPrice || 0);
          if (ltp > 0) {
            const bp = tick.bid ? Number(tick.bid) : ltp;
            const ap = tick.ask ? Number(tick.ask) : ltp;
            return {
              last_price: ltp,
              bid: bp,
              ask: ap,
              depth: tick.depth || null,
            };
          }
        }
      }
    } catch (e) { }

    // 2. Fetch Binance ticker bookTicker (best bid & ask) + ticker price in parallel with a fast timeout
    const [bookRes, priceRes] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${cleanSym}`, { cache: 'no-store', signal: AbortSignal.timeout(2500) }).catch(() => null),
      fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${cleanSym}`, { cache: 'no-store', signal: AbortSignal.timeout(2500) }).catch(() => null),
    ]);

    const usdInrRate = 1;

    if (bookRes?.ok && priceRes?.ok) {
      const bookData = await bookRes.json();
      const priceData = await priceRes.json();
      const rawLtp = parseFloat(priceData.price || '0');
      const rawBid = parseFloat(bookData.bidPrice || '0');
      const rawAsk = parseFloat(bookData.askPrice || '0');
      const ltp = rawLtp * usdInrRate;
      const bid = (rawBid > 0 ? rawBid : rawLtp) * usdInrRate;
      const ask = (rawAsk > 0 ? rawAsk : rawLtp) * usdInrRate;
      const bidQty = parseFloat(bookData.bidQty || '0');
      const askQty = parseFloat(bookData.askQty || '0');
      return {
        last_price: ltp,
        bid: bid,
        ask: ask,
        depth: {
          buy: [{ price: bid, quantity: bidQty }],
          sell: [{ price: ask, quantity: askQty }],
        }
      };
    } else if (priceRes?.ok) {
      const priceData = await priceRes.json();
      const rawLtp = parseFloat(priceData.price || '0');
      if (rawLtp > 0) {
        return {
          last_price: rawLtp,
          bid: rawLtp,
          ask: rawLtp,
          depth: null,
        };
      }
    }
  } catch (err) {
    console.error('[fetchBinanceQuote] Error:', err);
  }
  return null;
}

export interface ServerQuote {
  last_price: number;
  bid?: number | null;
  ask?: number | null;
  depth?: any;
}

/**
 * Fetch the Kite quote for one or more instruments server-side.
 * Resolves from local market_quotes / ticker daemon first, falling back on-demand.
 * Returns a map of instrument -> ServerQuote.
 */
async function fetchKiteQuotes(instruments: string[]): Promise<Record<string, ServerQuote>> {
  if (instruments.length === 0) return {};
  const result: Record<string, ServerQuote> = {};
  const foundKiteIds = new Set<string>();

  try {
    const admin = getAdminClient();

    // 1. Fetch available quotes from Ticker Daemon in-memory quotes API
    try {
      const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || 'http://localhost:8080';
      const params = new URLSearchParams({ symbols: instruments.join(',') });
      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (resTicker.ok) {
        const json = await resTicker.json();
        if (json.success && json.data) {
          for (const [key, val] of Object.entries(json.data)) {
            const v = val as any;
            const bidPrice = v.bid ?? v.depth?.buy?.[0]?.price ?? null;
            const askPrice = v.ask ?? v.depth?.sell?.[0]?.price ?? null;
            result[key] = {
              last_price: Number(v.last_price || 0),
              bid: bidPrice ? Number(bidPrice) : null,
              ask: askPrice ? Number(askPrice) : null,
              depth: v.depth || null,
            };
            foundKiteIds.add(key);
          }
        }
      }
    } catch (tickerErr) {
      console.warn('[fetchKiteQuotes] Failed to query Ticker Daemon, falling back to REST:', tickerErr);
    }

    // 2. Identify missing instruments
    const missingKiteIds = instruments.filter(id => !foundKiteIds.has(id));

    // 3. Fallback on-demand fetch from Kite REST API for missing instruments only
    if (missingKiteIds.length > 0) {
      const apiKey = process.env.KITE_API_KEY;
      if (!apiKey) return result;
      const session = await getSharedKiteSession();
      if (!session) return result;

      const params = new URLSearchParams();
      missingKiteIds.forEach(i => params.append('i', i));

      const res = await fetch(`https://api.kite.trade/quote?${params}`, {
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${session.accessToken}`,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(2500),
      });

      if (!res.ok) return result;

      const data = await res.json() as { data?: Record<string, any> };
      const instrumentUpserts: any[] = [];

      for (const inst of missingKiteIds) {
        const quote = data.data?.[inst];
        if (quote) {
          const bidPrice = quote.depth?.buy?.[0]?.price ?? quote.buy_price ?? null;
          const askPrice = quote.depth?.sell?.[0]?.price ?? quote.sell_price ?? null;

          result[inst] = {
            last_price: Number(quote.last_price || 0),
            bid: bidPrice ? Number(bidPrice) : null,
            ask: askPrice ? Number(askPrice) : null,
            depth: quote.depth || null,
          };

          const parts = inst.split(':');
          const exchange = parts[0] || 'NSE';
          const tradingsymbol = parts[1] || '';

          instrumentUpserts.push({
            id: inst,
            instrument_token: quote.instrument_token || 0,
            tradingsymbol,
            exchange,
            instrument_type: exchange === 'NFO' || exchange === 'MCX' || exchange === 'CDS' ? 'FUTOPT' : 'EQ',
            segment: exchange,
            updated_at: new Date().toISOString()
          });
        }
      }

      // Cache missing instruments in background (excluding raw ticks)
      if (instrumentUpserts.length > 0) {
        (async () => {
          try {
            await admin.from('instruments').upsert(instrumentUpserts, { onConflict: 'id' });
          } catch (err) {
            console.error('[fetchKiteQuotes] Background cache error:', err);
          }
        })();
      }
    }

    return result;
  } catch (err) {
    console.error('[fetchKiteQuotes] Error:', err);
    return result;
  }
}

/**
 * Map UI display segment to database segment key.
 */
function mapSegmentToDbSegment(s: string): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed === 'NSE - Futures' || trimmed === 'BSE - Futures') return 'INDEX-FUT';
  if (trimmed === 'NSE - Options' || trimmed === 'BSE - Options') return 'INDEX-OPT';
  if (trimmed === 'NSE - Stock Futures' || trimmed === 'BSE - Stock Futures') return 'STOCK-FUT';
  if (trimmed === 'NSE - Stock Options' || trimmed === 'BSE - Stock Options') return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures') return 'MCX-FUT';
  if (trimmed === 'MCX - Options') return 'MCX-OPT';
  if (trimmed === 'NSE - Equity' || trimmed === 'BSE - Equity') return 'STOCKS';
  if (trimmed === 'Crypto' || trimmed === 'CRYPTO') return 'CRYPTO';
  if (trimmed === 'Forex' || trimmed === 'FOREX' || trimmed === 'CDS - Futures' || trimmed === 'CDS - Options') return 'FOREX';
  if (trimmed === 'COMEX - Futures' || trimmed === 'COMEX - Options' || trimmed === 'COMEX' || trimmed === 'COI') return 'COMEX';
  return trimmed;
}



// ─── GET /api/orders ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = request.nextUrl;
    const { getCachedUserOrders, setCachedUserOrders } = await import('@/lib/redisHistoryCache');
    const page = parseInt(searchParams.get('page') ?? '1', 10);
    const limit = parseInt(searchParams.get('limit') ?? '50', 10);
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const isFresh = searchParams.get('fresh') === 'true';
    const statusParam = searchParams.get('status');
    const requestedStatuses = statusParam ? statusParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null;
    const isHistoryQuery = requestedStatuses ? requestedStatuses.every(s => ['executed', 'rejected', 'cancelled'].includes(s)) : false;
    const admin = getAdminClient();

    // Fast Redis cache check
    if (!isFresh && searchParams.get('page') === null) {
      const cachedOrders = await getCachedUserOrders(user.id, isHistoryQuery);
      if (cachedOrders !== null && Array.isArray(cachedOrders) && cachedOrders.length > 0) {
        let result = cachedOrders;
        if (requestedStatuses && requestedStatuses.length > 0) {
          const statusSet = new Set(requestedStatuses);
          result = result.filter((o: any) => o.status && statusSet.has(String(o.status).toLowerCase()));
        }
        if (result.length > 0) {
          return NextResponse.json({ orders: result.slice(0, limit), page: 1, limit });
        }
      }
    }

    const includeVirtualOrders = !isHistoryQuery && (!requestedStatuses || requestedStatuses.some(s => ['open', 'pending', 'active', 'trigger_pending'].includes(s)));

    let ordersQuery = admin
      .from('orders')
      .select('id, user_id, symbol, segment, side, status, qty, lots, fill_price, ltp_at_entry, price, order_type, product_type, info, linked_position_id, brokerage, client_price, trigger_price, stop_loss, target, is_exit, created_at, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (requestedStatuses && requestedStatuses.length > 0) {
      const allStatusVariants = Array.from(new Set([
        ...requestedStatuses,
        ...requestedStatuses.map(s => s.toUpperCase())
      ]));
      ordersQuery = ordersQuery.in('status', allStatusVariants);
    }
    ordersQuery = ordersQuery.range(from, to);

    // Fetch cached user profile, orders, and open positions in parallel (0 DB queries for profile)
    const queryPromise = Promise.all([
      getCachedUserProfile(user.id, () => admin),
      ordersQuery,
      includeVirtualOrders
        ? admin
            .from('positions')
            .select('id, symbol, side, qty_open, lots, avg_price, entry_price, product_type, settlement, stop_loss, sl, target, tp, created_at')
            .eq('user_id', user.id)
            .in('status', ['open', 'OPEN', 'active', 'ACTIVE'])
        : Promise.resolve({ data: [] })
    ]);

    const timeoutPromise = new Promise<any>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 6000)
    );

    const raceRes = await Promise.race([queryPromise, timeoutPromise]).catch(err => {
      console.warn('[GET /api/orders] Supabase query failed:', err);
      return { timeout: true };
    });

    if (raceRes?.timeout) {
      console.warn('[GET /api/orders] Supabase Cloud query timed out (6s), returning fallback');
      const cachedOrders = await getCachedUserOrders(user.id, isHistoryQuery);
      if (cachedOrders && Array.isArray(cachedOrders)) {
        return NextResponse.json({ orders: cachedOrders.slice(0, limit), page, limit });
      }
      return NextResponse.json({ orders: [], page, limit });
    }

    let userProfile: any = null;
    let ordersRes: any = { data: [] };
    let posRes: any = { data: [] };

    if (raceRes && Array.isArray(raceRes)) {
      [userProfile, ordersRes, posRes] = raceRes;
    }

    const historyResetAt = userProfile?.history_reset_at ? new Date(userProfile.history_reset_at).getTime() : null;

    let dbOrders = ordersRes.data ?? [];
    if (historyResetAt) {
      const pendingStatuses = new Set(['PENDING', 'pending', 'TRIGGER_PENDING', 'trigger_pending', 'OPEN', 'open', 'ACTIVE', 'active']);
      dbOrders = dbOrders.filter((r: any) => {
        if (r.status && pendingStatuses.has(r.status)) return true;
        const updatedAt = r.updated_at ? new Date(r.updated_at).getTime() : 0;
        const createdAt = r.created_at ? new Date(r.created_at).getTime() : 0;
        return updatedAt > historyResetAt || createdAt > historyResetAt;
      });
    }

    const openPositions = posRes.data ?? [];

    const orders: MyOrder[] = dbOrders.map((r: Record<string, unknown>) => {
      // linked_position_id is the raw unsanitized UUID linking this order to a position.
      // We need it separately because sanitizeOrderInfo() strips UUIDs from `info`.
      const rawLinkedPosId = (r.linked_position_id as string | null) || null;
      // Fallback: if linked_position_id column missing, try to recover UUID from raw info
      const rawInfoStr = r.info as string | null ?? null;
      const uuidMatch = rawInfoStr ? rawInfoStr.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) : null;
      const linkedPositionId = rawLinkedPosId || (uuidMatch ? uuidMatch[0] : null);

      return {
        id: r.id as string,
        symbol: r.symbol as string,
        segment: (r.segment as string) ?? '',
        side: r.side as 'BUY' | 'SELL',
        status: r.status as MyOrder['status'],
        qty: Number(r.qty),
        lots: Number(r.lots ?? 0),
        fill_price: Number(r.fill_price ?? r.price),
        ltp_at_entry: Number(r.ltp_at_entry ?? 0),
        order_type: (r.order_type as MyOrder['order_type']) ?? 'MARKET',
        product_type: (r.product_type as MyOrder['product_type']) ?? 'INTRADAY',
        info: sanitizeOrderInfo(r.info as string ?? null),
        linked_position_id: linkedPositionId,
        brokerage: Number(r.brokerage ?? 0),
        client_price: r.client_price !== null ? Number(r.client_price) : undefined,
        trigger_price: r.trigger_price !== null ? Number(r.trigger_price) : undefined,
        stop_loss: r.stop_loss !== null ? Number(r.stop_loss) : undefined,
        target: r.target !== null ? Number(r.target) : undefined,
        is_exit: r.is_exit !== undefined ? Boolean(r.is_exit) : false,
        created_at: r.created_at as string,
      };
    });

    // Dynamically synthesize virtual pending orders for positions with SL/Target
    // BUT only when a real DB order doesn't already cover that exit (to avoid duplicates
    // e.g. SLM entry inserts a real SL order — we must not also add a virtual one).
    const virtualOrders: MyOrder[] = [];

    if (includeVirtualOrders && openPositions.length > 0) {
      // Build a set of real pending exit orders keyed by symbol+side to detect duplicates
      const realPendingExitKeys = new Set<string>();
      for (const o of orders) {
        const isPending = ['PENDING', 'pending', 'TRIGGER_PENDING', 'trigger_pending'].includes(o.status as string);
        if (isPending && o.is_exit) {
          realPendingExitKeys.add(`${o.symbol}|${o.side}`);
        }
      }

      for (const pos of openPositions) {
        const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
        const exitKey = `${pos.symbol}|${exitSide}`;

        const stopLoss = pos.stop_loss ? Number(pos.stop_loss) : (pos.sl ? Number(pos.sl) : null);
        const target = pos.target ? Number(pos.target) : (pos.tp ? Number(pos.tp) : null);

        // Check if both SL and Target exist -> Synthesize a single GTT order
        if (stopLoss !== null && stopLoss > 0 && target !== null && target > 0 && !realPendingExitKeys.has(exitKey)) {
          virtualOrders.push({
            id: `pos-gtt-${pos.id}`,
            symbol: pos.symbol,
            segment: pos.settlement || '',
            side: pos.side === 'BUY' ? 'SELL' : 'BUY',
            is_exit: true,
            status: 'PENDING',
            qty: Number(pos.qty_open),
            lots: Number(pos.lots ?? 0) || (pos.qty_open > 0 ? 1 : 0),
            fill_price: stopLoss,
            ltp_at_entry: Number(pos.avg_price ?? pos.entry_price),
            order_type: 'GTT',
            product_type: (pos.product_type as any) ?? 'INTRADAY',
            info: 'GTT (Exit)',
            brokerage: 0,
            trigger_price: stopLoss,
            stop_loss: stopLoss,
            target: target,
            created_at: pos.created_at || new Date().toISOString(),
          });
        } 
        else if (stopLoss !== null && stopLoss > 0 && !realPendingExitKeys.has(exitKey)) {
          virtualOrders.push({
            id: `pos-sl-${pos.id}`,
            symbol: pos.symbol,
            segment: pos.settlement || '',
            side: pos.side === 'BUY' ? 'SELL' : 'BUY',
            is_exit: true,
            status: 'PENDING',
            qty: Number(pos.qty_open),
            lots: Number(pos.lots ?? 0) || (pos.qty_open > 0 ? 1 : 0),
            fill_price: stopLoss,
            ltp_at_entry: Number(pos.avg_price ?? pos.entry_price),
            order_type: 'SL',
            product_type: (pos.product_type as any) ?? 'INTRADAY',
            info: 'Stop Loss (Exit)',
            brokerage: 0,
            trigger_price: stopLoss,
            stop_loss: stopLoss,
            created_at: pos.created_at || new Date().toISOString(),
          });
        }
        else if (target !== null && target > 0 && !realPendingExitKeys.has(exitKey)) {
          virtualOrders.push({
            id: `pos-target-${pos.id}`,
            symbol: pos.symbol,
            segment: pos.settlement || '',
            side: pos.side === 'BUY' ? 'SELL' : 'BUY',
            is_exit: true,
            status: 'PENDING',
            qty: Number(pos.qty_open),
            lots: Number(pos.lots ?? 0) || (pos.qty_open > 0 ? 1 : 0),
            fill_price: target,
            ltp_at_entry: Number(pos.avg_price ?? pos.entry_price),
            order_type: 'LIMIT',
            product_type: (pos.product_type as any) ?? 'INTRADAY',
            info: 'Target (Exit)',
            brokerage: 0,
            client_price: target,
            target: target,
            created_at: pos.created_at || new Date().toISOString(),
          });
        }
      }
    }

    // Combine and sort by created_at descending (so latest is at top)
    const combinedOrders = [...virtualOrders, ...orders];
    combinedOrders.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setCachedUserOrders(user.id, combinedOrders, isHistoryQuery).catch(() => {});

    return NextResponse.json({ orders: combinedOrders, page, limit });
  } catch (err) {
    console.error('[GET /api/orders]', err);
    return NextResponse.json({ orders: [], page: 1, limit: 50 }, { status: 200 });
  }
}

// ─── POST /api/orders ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const t3_apiArrival = Date.now();
  try {
    // 1. Authenticate
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse body
    let body: PlaceOrderRequest;
    try {
      body = await request.json() as PlaceOrderRequest;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { symbol, kite_instrument, segment, side, order_type, product_type, qty, lots, client_price, trigger_price, stop_loss, target, linked_position_id, orderAttemptId } = body;
    const is_exit = Boolean(body.is_exit === true || body.is_exit === 'true' || body.is_exit === 1 || body.is_exit === '1');

    // 2b. Idempotency pre-check using Redis (with 300ms fast safety guard)
    let attemptRedisKey: string | null = null;
    if (orderAttemptId) {
      attemptRedisKey = `order_attempt:${user.id}:${orderAttemptId}`;
      try {
        const redis = getRedisClient();
        const cached = await Promise.race([
          redis.get(attemptRedisKey),
          new Promise(r => setTimeout(() => r(null), 300))
        ]);
        if (cached) {
          if (cached === 'IN_PROGRESS') {
            return NextResponse.json({ error: 'Order submission in progress. Please wait.' }, { status: 409 });
          }
          return NextResponse.json(JSON.parse(cached));
        }
        await Promise.race([
          redis.setex(attemptRedisKey, 60, 'IN_PROGRESS'),
          new Promise(r => setTimeout(() => r('OK'), 300))
        ]);
      } catch { /* proceed if redis fails */ }
    }

    // 3. Basic field validation
    if (!symbol || !side || !qty || !segment) {
      return NextResponse.json({ error: 'Missing required fields: symbol, side, qty, segment' }, { status: 400 });
    }
    if (!['BUY', 'SELL'].includes(side)) {
      return NextResponse.json({ error: 'Invalid side' }, { status: 400 });
    }
    if (qty <= 0) {
      return NextResponse.json({ error: 'Quantity must be positive' }, { status: 400 });
    }

    const dbSegment = mapSegmentWithSymbol(segment, symbol);
    const admin = getAdminClient();

    // Check market hours
    try {
      const exchangeName = symbol.includes(':') ? symbol.split(':')[0] : 'NSE';
      const ex = exchangeName.toUpperCase();
      const segUpper = dbSegment.toUpperCase();

      if (!segUpper.includes('CRYPTO') && !is_exit) {
        const segmentId = RiskValidation.resolveTradingHoursSegmentId(symbol, dbSegment);
        const nowMs = Date.now();
        const cachedHour = tradingHoursCache.get(segmentId);
        let segmentHour: any = null;
        let hrError: any = null;

        if (cachedHour && cachedHour.expiresAt > nowMs) {
          segmentHour = cachedHour.data;
        } else {
          const res: any = await (admin
            .from('trading_hours') as any)
            .select('name, start_time, end_time, is_active')
            .ilike('id', segmentId)
            .maybeSingle();
          segmentHour = res?.data;
          hrError = res?.error;
          if (!hrError && segmentHour) {
            tradingHoursCache.set(segmentId, { data: segmentHour, expiresAt: nowMs + TRADING_HOURS_TTL_MS });
          }
        }

        const effectiveHours = (!hrError && segmentHour) ? segmentHour : null;
        if (!RiskValidation.isMarketOpenForSegment(segmentId, effectiveHours)) {
          return NextResponse.json({ error: 'market is closed' }, { status: 400 });
        }
      }
    } catch (err) {
      console.error('[POST /api/orders] Market hours check error:', err);
      // Fail closed for safety
      return NextResponse.json({ error: 'market is closed' }, { status: 400 });
    }

    const kiteInst = kite_instrument || symbol;

    // Identify all instruments needed for this order to batch the Kite API call
    const instrumentsToFetch = [kiteInst];
    const isOption = dbSegment.includes('OPT');
    const parsedOption = isOption ? parseOptionSymbol(symbol) : null;
    let underlyingId = 'NSE:NIFTY 50';
    if (parsedOption) {
      underlyingId = await resolveUnderlyingKiteId(symbol, parsedOption.underlying);
    }

    if (isOption && underlyingId !== kiteInst) {
      instrumentsToFetch.push(underlyingId);
    }

    // 4-6 + 8-9: Run cached profile / settings lookups AND independent DB queries in parallel.
    // This reduces multi-table Postgres round-trips to an instant hot memory/Redis lookup.
    const [cachedProfile, balanceResult, positionsResult, pendingOrdersResult, quotesMap, scriptSettingsResult] = await Promise.all([
      // Profile (Cached in L1/Redis for instant permissions & trading mode)
      getCachedUserProfile(user.id, () => admin),

      // Fresh balance from profiles
      admin.from('profiles')
        .select('balance')
        .eq('id', user.id)
        .single(),

      // Fetch active positions to verify total open lot limits (max_lot)
      admin.from('positions')
        .select('id, symbol, settlement, qty_open, lots, status, entry_price, side, product_type, entry_time')
        .eq('user_id', user.id)
        .in('status', ['open', 'OPEN', 'active', 'ACTIVE']),

      // Fetch pending orders to verify total open lot limits
      admin.from('orders')
        .select('symbol, qty, lots, is_exit, status')
        .eq('user_id', user.id)
        .in('status', ['PENDING', 'pending', 'TRIGGER_PENDING', 'trigger_pending']),

      // Fetch quotes — either Kite or Binance depending on segment (with 2.0s fast timeout guard)
      (async () => {
        const fetchPromise = (async () => {
          if (dbSegment === 'CRYPTO' || symbol.includes('GBPUSD') || symbol.includes('EURUSD') || symbol.includes('USDJPY')) {
            const quote = await fetchBinanceQuote(symbol);
            if (!quote) return {};
            const clean = symbol.replace(/^(CRYPTO:|BINANCE:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
            const isDoge = clean === 'DOGE' || clean === 'DODGE' || clean === 'DOGEUSDT' || clean === 'DODGEUSDT';
            return {
              [kiteInst]: quote,
              [symbol]: quote,
              [clean]: quote,
              [`CRYPTO:${clean}`]: quote,
              [`${clean}USDT`]: quote,
              ...(isDoge ? {
                'DOGE': quote,
                'DODGE': quote,
                'DOGEUSDT': quote,
                'DODGEUSDT': quote,
                'CRYPTO:DOGE': quote,
                'CRYPTO:DODGE': quote,
              } : {}),
            };
          } else if (dbSegment === 'COMEX' || ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => symbol.toUpperCase().includes(c))) {
            try {
              const { fetchMT5StockQuote } = await import('@/lib/datafeed/MT5StockService');
              const mt5Q = await fetchMT5StockQuote(symbol);
              const lastP = (mt5Q as any)?.price ?? (mt5Q as any)?.lastPrice ?? 0;
              if (mt5Q && lastP > 0) {
                const qObj: ServerQuote = {
                  last_price: lastP,
                  bid: mt5Q.bid || lastP,
                  ask: mt5Q.ask || lastP,
                };
                return { [kiteInst]: qObj, [symbol]: qObj, [`COMEX:${symbol}`]: qObj };
              }
            } catch {}
            return {};
          } else if (
            dbSegment === 'US-EQ' || dbSegment === 'US' ||
            ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'INTC', 'SPY', 'QQQ', 'DIA', 'ES=F', 'NQ=F', 'YM=F'].some(c => symbol.toUpperCase().includes(c)) ||
            symbol.toUpperCase().includes('APPLE') || symbol.toUpperCase().includes('TESLA')
          ) {
            try {
              const { fetchUSStockQuote, normalizeUSStockSymbol } = await import('@/lib/datafeed/USStockService');
              const usQ = await fetchUSStockQuote(symbol);
              const lastP = (usQ as any)?.price ?? (usQ as any)?.lastPrice ?? 0;
              if (usQ && lastP > 0) {
                const qObj: ServerQuote = {
                  last_price: lastP,
                  bid: usQ.bid || lastP,
                  ask: usQ.ask || lastP,
                };
                const clean = normalizeUSStockSymbol(symbol);
                return {
                  [kiteInst]: qObj,
                  [symbol]: qObj,
                  [clean]: qObj,
                  [`US:${clean}`]: qObj,
                  [`US-EQ:${clean}`]: qObj,
                };
              }
            } catch {}
            return {};
          } else {
            return fetchKiteQuotes(instrumentsToFetch);
          }
        })();

        const timeoutPromise = new Promise<Record<string, ServerQuote>>((resolve) =>
          setTimeout(() => resolve({}), 2000)
        );

        return Promise.race([fetchPromise, timeoutPromise]);
      })(),

      // Fetch script settings for dynamic lot size (cached in Redis / memory)
      getCachedScriptSettings(() => admin),
    ]);

    const t4_backendQuoteRead = Date.now();
    const profile = cachedProfile ? {
      ...cachedProfile,
      balance: Number(balanceResult.data?.balance ?? 0),
    } : null;
    const profileErr = !profile ? 'Profile not found' : null;
    const cleanSymKey = cleanSymHelper(symbol);
    const rawQuote = quotesMap[kiteInst] ?? quotesMap[symbol] ?? quotesMap[cleanSymKey] ?? quotesMap[`CRYPTO:${cleanSymKey}`] ?? quotesMap[`US:${cleanSymKey}`] ?? null;
    const kiteLtp = typeof rawQuote === 'number' ? rawQuote : (rawQuote?.last_price ?? null);
    const dbScriptSettings = (scriptSettingsResult?.data as any[]) ?? [];

    // 4. Profile checks
    if (profileErr || !profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }
    if (!profile.active) {
      return NextResponse.json({ error: 'Account is inactive' }, { status: 403 });
    }
    if (profile.read_only) {
      return NextResponse.json({ error: 'Account is in read-only mode' }, { status: 403 });
    }

    // 5. Segment permission check
    const allowedSegments: string[] = profile.segments ?? [];
    if (allowedSegments.length > 0 && !allowedSegments.includes(dbSegment) && !is_exit) {
      return NextResponse.json({ error: `Trading not allowed in segment: ${segment}` }, { status: 403 });
    }

    // 6. Segment settings — cached resolution with parent inheritance
    const isScalper = profile.trading_mode === 'scalper';
    const lookupId = profile.parent_id ?? user.id;
    let settingsList = await getCachedUserSegmentSettings(lookupId, dbSegment, isScalper, () => admin);
    if ((!settingsList || settingsList.length === 0) && lookupId !== user.id) {
      settingsList = await getCachedUserSegmentSettings(user.id, dbSegment, isScalper, () => admin);
    }

    let buySetting = (settingsList || []).find((s: any) => s.side === 'BUY');
    let sellSetting = (settingsList || []).find((s: any) => s.side === 'SELL');

    // If there are still no settings in database, construct safety fallback defaults based on segment
    const segUpper = dbSegment.toUpperCase();
    let intraday_leverage = 50;
    let holding_leverage = 5;
    if (segUpper.includes('FOREX') || segUpper.includes('CDS')) {
      intraday_leverage = 100;
      holding_leverage = 10;
    } else if (segUpper.includes('CRYPTO')) {
      intraday_leverage = 10;
      holding_leverage = 1;
    }

    if (!buySetting) {
      buySetting = {
        id: '',
        user_id: user.id,
        segment: dbSegment,
        side: 'BUY',
        trade_allowed: true,
        max_lot: 50,
        max_order_lot: 50,
        intraday_leverage,
        holding_leverage,
        intraday_type: 'Multiplier',
        holding_type: 'Multiplier',
        entry_buffer: 0,
        exit_buffer: 0,
        strike_range: 0,
        commission_type: 'Per Crore',
        commission_value: isScalper ? 8500 : (segUpper.includes('FOREX') || segUpper.includes('CDS') ? 2000 : (segUpper.includes('CRYPTO') ? 1000 : 4500)),
        top_limit: 0,
        min_limit: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    if (!sellSetting) {
      sellSetting = {
        id: '',
        user_id: user.id,
        segment: dbSegment,
        side: 'SELL',
        trade_allowed: true,
        max_lot: 50,
        max_order_lot: 50,
        intraday_leverage,
        holding_leverage,
        intraday_type: 'Multiplier',
        holding_type: 'Multiplier',
        entry_buffer: 0,
        exit_buffer: 0,
        strike_range: 0,
        commission_type: 'Per Crore',
        commission_value: isScalper ? 8500 : (segUpper.includes('FOREX') || segUpper.includes('CDS') ? 2000 : (segUpper.includes('CRYPTO') ? 1000 : 4500)),
        top_limit: 0,
        min_limit: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }

    const segSetting = side === 'BUY' ? buySetting : sellSetting;

    // 7. Validate lot / qty limits & Strike Range
    if (!segSetting.trade_allowed && !is_exit) {
      return NextResponse.json({ error: `${side} orders not allowed in ${segment}` }, { status: 403 });
    }

    const symbolLotSize = lots > 0 ? (qty / lots) : getLotSize(symbol, dbScriptSettings);
    const newOrderLots = lots > 0 ? lots : (symbolLotSize > 0 ? qty / symbolLotSize : qty);
    const maxOrderLot = Number(segSetting.max_order_lot || segSetting.max_lot || 0);
    if (!is_exit && maxOrderLot > 0) {
      const maxQty = maxOrderLot * symbolLotSize;
      if (qty > maxQty) {
        return NextResponse.json({
          error: `The maximum allowed per order is ${maxOrderLot} lots or ${maxQty} qty. Please place your trade in multiple orders.`,
        }, { status: 400 });
      }
    }

    // Verify cumulative limits (max_lot) across open positions and pending orders
    const maxLotCap = Number(segSetting.max_lot || 0);
    if (!is_exit && maxLotCap > 0) {
      let totalOpenInstrumentLots = 0;
      const targetSymbolClean = cleanSymHelper(symbol);

      const openPositions = positionsResult?.data ?? [];
      if (openPositions.length > 0) {
        for (const pos of openPositions) {
          const pSize = getLotSize(pos.symbol, dbScriptSettings);
          const pLots = Number(pos.lots) > 0 ? Number(pos.lots) : (pSize > 0 ? (Number(pos.qty_open) / pSize) : 0);

          if (cleanSymHelper(pos.symbol) === targetSymbolClean) {
            totalOpenInstrumentLots += pLots;
          }
        }
      }

      const pendingOrders = pendingOrdersResult?.data ?? [];
      if (pendingOrders.length > 0) {
        for (const po of pendingOrders) {
          if (!po.is_exit) {
            const poSize = getLotSize(po.symbol, dbScriptSettings);
            const poLots = Number(po.lots) > 0 ? Number(po.lots) : (poSize > 0 ? (Number(po.qty) / poSize) : 0);

            if (cleanSymHelper(po.symbol) === targetSymbolClean) {
              totalOpenInstrumentLots += poLots;
            }
          }
        }
      }

      if (totalOpenInstrumentLots + newOrderLots > maxLotCap) {
        const remainingInstLots = Math.max(0, maxLotCap - totalOpenInstrumentLots);
        const remainingInstQty = remainingInstLots * symbolLotSize;
        return NextResponse.json({
          error: `Order exceeds maximum cap of ${maxLotCap} lots (${maxLotCap * symbolLotSize} qty) for this instrument. Current open positions: ${totalOpenInstrumentLots.toFixed(2)} lots. Remaining capacity: ${remainingInstLots.toFixed(2)} lots (${remainingInstQty} qty).`,
        }, { status: 400 });
      }
    }

    // Strike Range check — STRICTLY enforced for fresh entry/add-more (!is_exit). Exits (is_exit === true) bypass.
    if (isOption && !is_exit) {
      const valRes = await validateOptionStrike({
        symbol,
        isExit: false,
        knownQuotesMap: quotesMap,
      });
      if (!valRes.allowed) {
        return NextResponse.json({
          error: valRes.reason || `Strike price ${valRes.orderStrike} is outside the active option chain window (${valRes.minAllowed} to ${valRes.maxAllowed}).`,
        }, { status: 403 });
      }
    }

    // 8. Balance check — use the balance from the profile query
    const balance = Number(profile.balance ?? 0);
    const targetProductType = product_type ?? 'INTRADAY';
    const leverage = targetProductType === 'CARRY'
      ? (segSetting.holding_leverage ?? 1)
      : (segSetting.intraday_leverage ?? 1);
    const exposure = qty * client_price;
    const requiredMargin = exposure / leverage;

    let expectedBrokerage = 0;
    if (!is_exit) {
      const brokerageRes = calculateOrderBrokerage({
        exposure,
        lots: newOrderLots,
        productType: targetProductType,
        orderType: order_type ?? 'MARKET',
        isExit: false,
        segSetting,
        dbSegment,
      });
      expectedBrokerage = brokerageRes.totalBrokerage;
    }

    if (balance < (requiredMargin + expectedBrokerage) && !is_exit) {
      return NextResponse.json({
        error: `Insufficient margin. Available: ₹${balance.toFixed(2)}, Required: ₹${(requiredMargin + expectedBrokerage).toFixed(2)}`,
      }, { status: 400 });
    }

    // 9. Fill price — use the already-fetched kiteLtp (no second Kite call)
    const baseLtp = kiteLtp ?? client_price;
    if (!baseLtp || baseLtp <= 0) {
      return NextResponse.json({ error: 'Could not determine market price. Try again.' }, { status: 503 });
    }

    // Validate Limit price constraints relative to LTP
    if (order_type === 'LIMIT') {
      if (side === 'BUY' && client_price >= baseLtp) {
        return NextResponse.json({ error: 'Limit price must be lower than the current market price (LTP).' }, { status: 400 });
      }
      if (side === 'SELL' && client_price <= baseLtp) {
        return NextResponse.json({ error: 'Limit price must be higher than the current market price (LTP).' }, { status: 400 });
      }
    } else if (order_type === 'GTT' && !is_exit) {
      if (!client_price || isNaN(Number(client_price)) || Number(client_price) <= 0) {
        const errorMsg = side === 'BUY'
          ? 'Limit price is required for a GTT Buy order.'
          : 'Limit price is required for a GTT Sell order.';
        return NextResponse.json({ error: errorMsg }, { status: 400 });
      }
      if (side === 'BUY' && client_price > baseLtp) {
        return NextResponse.json({ error: 'Limit price must be lower than or equal to the current market price (LTP).' }, { status: 400 });
      }
      if (side === 'SELL' && client_price < baseLtp) {
        return NextResponse.json({ error: 'Limit price must be higher than or equal to the current market price (LTP).' }, { status: 400 });
      }
    }

    // Validate SL and SLM trigger price constraints relative to LTP using OrderService
    const slErr = OrderService.validateStopLoss(
      order_type ?? 'MARKET',
      side as 'BUY' | 'SELL',
      trigger_price ? parseFloat(trigger_price.toString()) : null,
      baseLtp,
      is_exit ?? false
    );
    if (slErr) {
      return NextResponse.json({ error: slErr }, { status: 400 });
    }

    // Validate Target and Stop Loss rules
    const orderTarget = target ? parseFloat(target.toString()) : null;
    const orderSL = stop_loss ? parseFloat(stop_loss.toString()) : null;
    const refPrice = ['LIMIT', 'SL', 'GTT'].includes(order_type ?? 'MARKET') ? client_price : baseLtp;

    // Resolve reference entry price and position side (Long vs Short)
    const activePosition = openPositions.find((p: any) =>
      (linked_position_id && p.id === linked_position_id) ||
      (cleanSymHelper(p.symbol) === cleanSymHelper(symbol) && (p.product_type || 'INTRADAY').toUpperCase() === (targetProductType || 'INTRADAY').toUpperCase()) ||
      (cleanSymHelper(p.symbol) === cleanSymHelper(symbol))
    );

    const refEntry = (is_exit && activePosition) ? Number(activePosition.entry_price) : refPrice;
    const isLong = (is_exit && activePosition) ? (activePosition.side === 'BUY') : (side === 'BUY');

    // Enforce Anti-Scalping hold duration for manual market exits
    if (is_exit && activePosition && (order_type === 'MARKET' || order_type === 'SLM')) {
      const exitBuffer = segSetting?.exit_buffer ?? 0;
      const profitHoldSec = segSetting?.profit_hold_sec ?? 0;
      const lossHoldSec = segSetting?.loss_hold_sec ?? 0;

      let estExitPrice: number;
      if (activePosition.side === 'BUY') {
        estExitPrice = baseLtp * (1 - exitBuffer);
      } else {
        estExitPrice = baseLtp * (1 + exitBuffer);
      }
      estExitPrice = Math.round(estExitPrice * 100) / 100;

      const pnlValue = activePosition.side === 'BUY'
        ? (estExitPrice - Number(activePosition.entry_price)) * Number(qty)
        : (Number(activePosition.entry_price) - estExitPrice) * Number(qty);

      const durationSec = Math.floor((Date.now() - new Date(activePosition.entry_time).getTime()) / 1000);
      const requiredHold = pnlValue >= 0 ? profitHoldSec : lossHoldSec;

      if (durationSec < requiredHold) {
        return NextResponse.json({
          error: `Anti-Scalping: Minimum hold time of ${requiredHold}s required for this trade. Elapsed: ${durationSec}s.`,
        }, { status: 403 });
      }
    }

    if (is_exit) {
      if (isLong) {
        if (orderTarget !== null && orderTarget <= baseLtp) {
          return NextResponse.json({ error: 'Target price must be above the current market price (LTP).' }, { status: 400 });
        }
        if (orderSL !== null && orderSL >= baseLtp) {
          return NextResponse.json({ error: 'Stop loss price must be below the current market price (LTP).' }, { status: 400 });
        }
      } else {
        if (orderTarget !== null && orderTarget >= baseLtp) {
          return NextResponse.json({ error: 'Target price must be below the current market price (LTP).' }, { status: 400 });
        }
        if (orderSL !== null && orderSL <= baseLtp) {
          return NextResponse.json({ error: 'Stop loss price must be above the current market price (LTP).' }, { status: 400 });
        }
      }
    } else {
      // First-time purchase validations
      const hasLimitPrice = ['LIMIT', 'SL', 'GTT'].includes(order_type ?? 'MARKET') && client_price !== undefined && !isNaN(Number(client_price)) && Number(client_price) > 0;
      const clientPriceNum = Number(client_price);
      if (isLong) {
        if (orderSL !== null) {
          if (orderSL >= baseLtp) {
            return NextResponse.json({ error: 'Stop loss price must be below the current market price (LTP).' }, { status: 400 });
          }
          if (hasLimitPrice && orderSL >= clientPriceNum) {
            return NextResponse.json({ error: 'Stop loss price must be below the limit price.' }, { status: 400 });
          }
        }
        if (orderTarget !== null) {
          const targetRef = hasLimitPrice ? clientPriceNum : baseLtp;
          if (orderTarget <= targetRef) {
            return NextResponse.json({ error: `Target price must be above the ${hasLimitPrice ? 'limit' : 'current market'} price.` }, { status: 400 });
          }
        }
      } else {
        if (orderSL !== null) {
          if (orderSL <= baseLtp) {
            return NextResponse.json({ error: 'Stop loss price must be above the current market price (LTP).' }, { status: 400 });
          }
          if (hasLimitPrice && orderSL <= clientPriceNum) {
            return NextResponse.json({ error: 'Stop loss price must be above the limit price.' }, { status: 400 });
          }
        }
        if (orderTarget !== null) {
          const targetRef = hasLimitPrice ? clientPriceNum : baseLtp;
          if (orderTarget >= targetRef) {
            return NextResponse.json({ error: `Target price must be below the ${hasLimitPrice ? 'limit' : 'current market'} price.` }, { status: 400 });
          }
        }
      }
    }

    // Segment Price Limits validation (top_limit and min_limit)
    const topLimit = Number(segSetting.top_limit ?? 0);
    const minLimit = Number(segSetting.min_limit ?? 0);
    if (['LIMIT', 'SL', 'GTT'].includes(order_type ?? 'MARKET')) {
      if (side === 'BUY') {
        if (topLimit > 0) {
          const maxAllowed = baseLtp * (1 + topLimit / 100);
          if (client_price > maxAllowed) {
            return NextResponse.json({
              error: `Maximum price allowed is ₹${maxAllowed.toFixed(2)}`
            }, { status: 400 });
          }
        }

        if (minLimit > 0) {
          const minAllowed = baseLtp * (1 - minLimit / 100);
          if (client_price < minAllowed) {
            return NextResponse.json({
              error: `Minimum price allowed is ₹${minAllowed.toFixed(2)}`
            }, { status: 400 });
          }
        }
      } else { // SELL side
        if (topLimit > 0) {
          const maxAllowed = baseLtp * (1 + topLimit / 100);
          if (client_price > maxAllowed) {
            return NextResponse.json({
              error: `Maximum price allowed is ₹${maxAllowed.toFixed(2)}`
            }, { status: 400 });
          }
        }

        if (minLimit > 0) {
          const minAllowed = baseLtp * (1 - minLimit / 100);
          if (client_price < minAllowed) {
            return NextResponse.json({
              error: `Minimum price allowed is ₹${minAllowed.toFixed(2)}`
            }, { status: 400 });
          }
        }
      }
    }

    // 10. Compute fill price (LTP ± buffer from segment_settings)
    let fillPrice: number;
    // SLM (Stop Loss Market) = immediate market entry + linked SL exit order
    const isImmediate = ['MARKET', 'SLM'].includes(order_type ?? 'MARKET');

    let rawBid = typeof rawQuote === 'object' ? (rawQuote?.bid ?? null) : null;
    let rawAsk = typeof rawQuote === 'object' ? (rawQuote?.ask ?? null) : null;

    // Prefer client click-time frontend_ask / frontend_bid for market orders to eliminate sub-second network latency slippage
    if (isImmediate && side === 'BUY' && body.frontend_ask && Number(body.frontend_ask) > 0) {
      const fAsk = Number(body.frontend_ask);
      if (!baseLtp || Math.abs(fAsk - baseLtp) / baseLtp < 0.05) {
        rawAsk = fAsk;
      }
    }
    if (isImmediate && side === 'SELL' && body.frontend_bid && Number(body.frontend_bid) > 0) {
      const fBid = Number(body.frontend_bid);
      if (!baseLtp || Math.abs(fBid - baseLtp) / baseLtp < 0.05) {
        rawBid = fBid;
      }
    }

    const hasRealBidAsk = Boolean(rawBid && rawAsk && rawBid > 0 && rawAsk > 0);

    const symbolExchange = (symbol.includes(':') ? symbol.split(':')[0] : '').toUpperCase();

    const isIndianMarket = ['NSE', 'NFO', 'MCX', 'BSE', 'BFO', 'NCO'].includes(symbolExchange) ||
      symbol.startsWith('NSE:') || symbol.startsWith('NFO:') || symbol.startsWith('MCX:') || symbol.startsWith('MCX-');

    const askBuf = isIndianMarket ? 0 : (buySetting?.entry_buffer ?? buySetting?.bid_buffer ?? 0);
    const bidBuf = isIndianMarket ? 0 : (sellSetting?.entry_buffer ?? sellSetting?.bid_buffer ?? 0);

    const effective = resolveEffectivePrices({
      ltp: baseLtp,
      rawBid,
      rawAsk,
      hasRealBidAsk,
      askBuffer: askBuf,
      bidBuffer: bidBuf,
    });

    if (order_type === 'LIMIT' || order_type === 'SL' || order_type === 'GTT') {
      fillPrice = client_price || trigger_price || baseLtp;
    } else {
      const platformExitMode = await getPlatformSetting('EXIT_PRICE_MODE', 'BID_ASK');
      const exitPriceMode = (platformExitMode || buySetting?.exit_price_mode || sellSetting?.exit_price_mode || 'BID_ASK') as 'BID_ASK' | 'LTP';

      let basePrice: number;
      if (exitPriceMode === 'LTP') {
        basePrice = baseLtp;
      } else {
        const isExecutingBuy = side === 'BUY';
        basePrice = isExecutingBuy ? effective.effectiveAsk : effective.effectiveBid;
      }

      fillPrice = calculateBufferedPrice({
        side: side as 'BUY' | 'SELL',
        isExit: is_exit ?? false,
        basePrice,
        buySetting,
        sellSetting,
        exitPriceModeOverride: exitPriceMode,
      });
    }

    fillPrice = Math.round(fillPrice * 100) / 100; // 2 dp

    // Timestamps T5 and T6 for diagnostic log
    const t5_executionTime = Date.now();
    let t6_dbFillTime = t5_executionTime;

    // Emit structured diagnostic log for Market / SLM orders
    if (isImmediate) {
      console.log('[MARKET_ORDER_DIAGNOSTIC]', JSON.stringify({
        symbol,
        side,
        quantity: qty,

        frontendAsk: body.frontend_ask ?? null,
        frontendBid: body.frontend_bid ?? null,
        frontendLtp: body.frontend_ltp ?? client_price ?? null,

        backendLtp: baseLtp,
        backendBid: rawBid,
        backendAsk: rawAsk,

        executionBid: effective.effectiveBid,
        executionAsk: effective.effectiveAsk,

        depthBestAsk: typeof rawQuote === 'object' ? (rawQuote?.depth?.sell?.[0]?.price ?? rawAsk) : rawAsk,
        depthBestAskQuantity: typeof rawQuote === 'object' ? (rawQuote?.depth?.sell?.[0]?.quantity ?? null) : null,

        askBuffer: buySetting?.entry_buffer ?? buySetting?.bid_buffer ?? 0,
        bidBuffer: sellSetting?.entry_buffer ?? sellSetting?.bid_buffer ?? 0,
        normalBuffer: segSetting?.entry_buffer ?? 0,

        effectiveBid: effective.effectiveBid,
        effectiveAsk: effective.effectiveAsk,

        finalFillPrice: fillPrice,

        quoteTimestamp: typeof rawQuote === 'object' ? (rawQuote?.timestamp ?? t4_backendQuoteRead) : t4_backendQuoteRead,
        executionTimestamp: t5_executionTime,

        timestamps: {
          T1_frontendQuoteTime: body.frontend_quote_time ?? null,
          T2_clientClickTime: body.client_click_time ?? null,
          T3_apiArrival: t3_apiArrival,
          T4_backendQuoteRead: t4_backendQuoteRead,
          T5_executionTime: t5_executionTime,
        }
      }, null, 2));
    }

    // 11. Atomic write via Postgres RPC
    const targetOrderType = order_type ?? 'MARKET';
    const rpcOrderType = targetOrderType;

    let resolvedTriggerPrice = trigger_price ? parseFloat(trigger_price.toString()) : null;
    let resolvedStopLoss = stop_loss ? parseFloat(stop_loss.toString()) : null;

    // ── Fix 3.1a: Enforce is_exit + linked_position_id for SL/SLM orders ──────
    // If the caller placed an SL or SLM order without explicitly marking it as an
    // exit, check whether an open opposite-side position already exists for this
    // symbol.  If one does, this order MUST be an exit — force the flag so that
    // process_executed_position closes the position instead of creating a phantom
    // entry.
    let resolvedIsExit: boolean = is_exit ?? false;
    let resolvedLinkedPositionId: string | null = linked_position_id ?? null;

    if (!resolvedLinkedPositionId) {
      const targetClean = cleanSymHelper(symbol);
      const matchingPositions = openPositions.filter((p: any) =>
        cleanSymHelper(p.symbol || p.kite_instrument) === targetClean &&
        p.side !== side                                 // opposite side
      );
      if (matchingPositions.length > 0) {
        resolvedIsExit = true;
        // Only anchor to a single position ID if there is exactly 1 matching lot and exit qty <= that position's qty.
        // For cumulative exits spanning multiple lots, keep resolvedLinkedPositionId = null so FIFO executes across all lots.
        if (matchingPositions.length === 1 && Number(matchingPositions[0].qty_open) >= Number(qty)) {
          resolvedLinkedPositionId = matchingPositions[0].id;
        } else {
          resolvedLinkedPositionId = null;
        }
        console.log(
          `[POST /api/orders] Auto-resolved is_exit=true & linkedPositionId=${resolvedLinkedPositionId} for ${targetOrderType} order ` +
          `(symbol=${symbol}, side=${side}, matchingLots=${matchingPositions.length})`
        );
      }
    }

    // ── Fix 3.1b: GTT pre-entry — do NOT insert SL/Target sub-order rows ──────
    // When a GTT order is placed in pre-entry state (is_exit = false), the
    // stop_loss and target values are metadata for after entry fires.  Sub-order
    // rows (separate PENDING rows for SL and Target) must NOT be created here —
    // process_executed_position will create them when the GTT entry executes.
    // This route does not insert sub-order rows (confirmed: no secondary
    // place_order_v2 call below), so this is enforced by design.  The stop_loss
    // and target values are stored on the GTT order row only.

    // ── Fix 3.1c: Duplicate exit order guard ─────────────────────────────────
    // If this is a non-immediate (PENDING) exit order (SL, GTT, LIMIT exit),
    // check whether a real PENDING exit order already exists for this position.
    // This prevents double SL orders when SLM auto-inserts one and the user
    // manually adds another via the position panel exit flow.
    if (resolvedIsExit && !isImmediate) {
      const linkedPosIdForCheck = resolvedLinkedPositionId;
      const exitSideForCheck = side; // exit order's own side (opposite of position)

      const { data: existingExitOrders } = await admin
        .from('orders')
        .select('id, order_type, linked_position_id, info')
        .eq('user_id', user.id)
        .eq('symbol', symbol)
        .eq('side', exitSideForCheck)
        .eq('is_exit', true)
        .in('status', ['PENDING', 'TRIGGER_PENDING'])
        .limit(5);

      if (existingExitOrders && existingExitOrders.length > 0) {
        // Filter the fetched orders to only cancel those that actually conflict
        const isPositionUuid = (s: string | null | undefined) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ''));

        const conflictingOrders = existingExitOrders.filter((o: any) => {
          // Reconstruct the linked ID since DB info column might contain it
          const rawLinkedId = o.linked_position_id || null;
          const rawInfoStr = o.info || null;
          const uuidMatch = rawInfoStr ? rawInfoStr.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) : null;
          const oLinkedId = rawLinkedId || (uuidMatch ? uuidMatch[0] : null);

          if (!linkedPosIdForCheck) {
            // We are placing a cumulative order. All existing orders conflict.
            return true;
          } else {
            // We are placing a detailed order for `linkedPosIdForCheck`.
            // Conflict if existing is cumulative (no ID), or detailed for the SAME ID.
            if (!oLinkedId) return true; // Cumulative order conflicts
            if (oLinkedId === linkedPosIdForCheck) return true; // Same position conflicts
            return false; // Different position -> NO CONFLICT, do not cancel
          }
        });

        if (conflictingOrders.length > 0) {
          const idsToCancel = conflictingOrders.map((o: any) => o.id);
          await admin
            .from('orders')
            .update({ status: 'CANCELLED', updated_at: new Date().toISOString(), info: 'Replaced by new exit order' })
            .eq('user_id', user.id)
            .in('id', idsToCancel);
          console.log(`[POST /api/orders] Duplicate exit guard: cancelled ${idsToCancel.length} conflicting PENDING exit order(s) for ${symbol} before placing new exit.`);
        }
      }
    }

    const executeDbCall = async () => {
      const exitPos = resolvedLinkedPositionId
        ? openPositions.find((p: any) => p.id === resolvedLinkedPositionId)
        : (resolvedIsExit ? (openPositions.find((p: any) => cleanSymHelper(p.symbol || p.kite_instrument) === cleanSymHelper(symbol) && p.side !== side) || openPositions.find((p: any) => cleanSymHelper(p.symbol || p.kite_instrument) === cleanSymHelper(symbol))) : null);
      const finalSymbol = (resolvedIsExit && exitPos?.symbol) ? exitPos.symbol : symbol;
      const finalProductType = (resolvedIsExit && exitPos?.product_type) ? exitPos.product_type : (product_type ?? 'INTRADAY');
      const finalSide = (resolvedIsExit && exitPos?.side)
        ? (exitPos.side === 'BUY' ? 'SELL' : 'BUY')
        : side;

      let oId: any = null;
      let rpcErr: any = null;

      const resV2 = await admin.rpc('place_order_v2', {
        p_user_id: user.id,
        p_symbol: finalSymbol,
        p_kite_inst: kiteInst,
        p_segment: dbSegment,
        p_side: finalSide,
        p_order_type: rpcOrderType,
        p_product_type: finalProductType,
        p_qty: qty,
        p_lots: lots ?? 0,
        p_ltp: baseLtp,
        p_fill_price: fillPrice,
        p_is_exit: resolvedIsExit,
        p_buffer_fee: 0,
        p_status: isImmediate ? 'EXECUTED' : 'PENDING',
        p_trigger_price: resolvedTriggerPrice,
        p_stop_loss: resolvedStopLoss,
        p_target: target ? parseFloat(target.toString()) : null,
        p_info: resolvedLinkedPositionId,
        p_expected_margin: requiredMargin,
        p_expected_brokerage: expectedBrokerage,
        p_idempotency_key: null,
        p_linked_position_id: resolvedLinkedPositionId
      });

      if (resV2.error) {
        console.warn('[POST /api/orders] place_order_v2 error, falling back to v1:', resV2.error);
        const resV1 = await admin.rpc('place_order', {
          p_user_id: user.id,
          p_symbol: finalSymbol,
          p_kite_inst: kiteInst,
          p_segment: dbSegment,
          p_side: finalSide,
          p_order_type: rpcOrderType,
          p_product_type: finalProductType,
          p_qty: qty,
          p_lots: lots ?? 0,
          p_ltp: baseLtp,
          p_fill_price: fillPrice,
          p_info: resolvedLinkedPositionId,
          p_trigger_price: resolvedTriggerPrice,
          p_stop_loss: resolvedStopLoss,
          p_target: target ? parseFloat(target.toString()) : null,
          p_is_exit: resolvedIsExit,
        });
        oId = resV1.data;
        rpcErr = resV1.error;
      } else {
        oId = resV2.data;
        rpcErr = resV2.error;
      }

      if (rpcErr) {
        throw new Error(rpcErr.message || 'Order execution failed. Please try again.');
      }
      return oId as string;
    };

    let orderId: string;
    try {
      orderId = await executeDbCall();
      t6_dbFillTime = Date.now();
      if (isImmediate) {
        console.log(`[MARKET_ORDER_DIAGNOSTIC] T6 DB Fill Timestamp: ${t6_dbFillTime}`);
      }
    } catch (err: any) {
      console.error('[POST /api/orders] Order execution error:', err);
      return NextResponse.json({ error: err.message || 'Order execution failed. Please try again.' }, { status: 400 });
    }

    // ── SLM entry: insert a linked pending SL exit order ─────────────────────
    // SLM = market entry now + protective SL exit order that auto-fires when
    // stop_loss price is hit, closing the position at market.
    if (order_type === 'SLM' && !resolvedIsExit && resolvedStopLoss && resolvedStopLoss > 0) {
      try {
        // Fetch the newly created position for this order so we can link the SL
        const { data: newPos } = await admin
          .from('positions')
          .select('id')
          .eq('user_id', user.id)
          .eq('symbol', symbol)
          .in('status', ['open', 'OPEN', 'active'])
          .order('created_at', { ascending: false })
          .maybeSingle();

        const linkedPosId = newPos?.id ?? resolvedLinkedPositionId ?? null;
        const slSide = side === 'BUY' ? 'SELL' : 'BUY';

        await admin.rpc('place_order_v2', {
          p_user_id: user.id,
          p_symbol: symbol,
          p_kite_inst: kiteInst,
          p_segment: dbSegment,
          p_side: slSide,
          p_order_type: 'SL',
          p_product_type: product_type ?? 'INTRADAY',
          p_qty: qty,
          p_lots: lots ?? 0,
          p_ltp: baseLtp,
          p_fill_price: resolvedStopLoss,
          p_is_exit: true,
          p_buffer_fee: 0,
          p_status: 'PENDING',
          p_trigger_price: resolvedStopLoss,
          p_stop_loss: resolvedStopLoss,
          p_target: null,
          p_info: linkedPosId,
          p_expected_margin: 0,
          p_expected_brokerage: 0,
          p_idempotency_key: null,
          p_linked_position_id: linkedPosId,
        });
        console.log(`[POST /api/orders] SLM: linked SL exit order inserted at ${resolvedStopLoss} for position ${linkedPosId}`);

        // Also stamp stop_loss on the position row so that:
        // (a) the virtual pos-sl-* dedup key fires correctly in GET /api/orders,
        // (b) if the real SL order is later cancelled the position still carries the price.
        if (linkedPosId) {
          await admin
            .from('positions')
            .update({ stop_loss: resolvedStopLoss, updated_at: new Date().toISOString() })
            .eq('id', linkedPosId)
            .eq('user_id', user.id)
            .in('status', ['open', 'OPEN', 'active']);
        }
      } catch (slErr) {
        // Non-fatal: SLM entry already executed; log but don't block response
        console.warn('[POST /api/orders] Non-fatal: failed to insert linked SL exit order for SLM entry:', slErr);
      }
    }

    // ── Fix 3.1c: Market exit — fully await orphan order cleanup ─────────────
    // When a MARKET exit executes, process_executed_position closes the position
    // via the RPC.  Any remaining pending SL/Target/GTT exit orders attached to
    // that position become orphaned.  Cancel them here, fully awaited (not
    // fire-and-forget) so the response is only sent after cleanup completes.
    if (isImmediate && resolvedIsExit) {
      // Run cleanup asynchronously without blocking the response
      (async () => {
        try {
          const { PositionService } = await import('@/lib/trading/PositionService');
          await PositionService.cancelPendingOrdersForClosedPosition(
            admin,
            user.id,
            resolvedLinkedPositionId ?? undefined,
            symbol
          );
        } catch (cancelErr) {
          console.warn('[POST /api/orders] Non-fatal: failed to cancel orphaned exit orders after market exit:', cancelErr);
        }
      })();
    }

    const response: PlaceOrderResponse = {
      order_id: orderId as string,
      status: isImmediate ? 'EXECUTED' : 'PENDING',
      fill_price: fillPrice,
      message: isImmediate
        ? `${side} order executed at ₹${fillPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
        : `${side} ${order_type} order placed (Pending) at ₹${fillPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
    };

    // Decoupled asynchronous post-processing (zero blocking latency on HTTP response)
    queueMicrotask(async () => {
      if (attemptRedisKey) {
        try {
          const redis = getRedisClient();
          await redis.setex(attemptRedisKey, 60, JSON.stringify(response));
        } catch { /* ignore */ }
      }

      try {
        const redis = getRedisClient();
        await redis.publish('order_events', JSON.stringify({
          user_id: user.id,
          order_id: response.order_id,
          status: response.status,
          fill_price: response.fill_price,
          symbol: symbol,
          side: side,
          timestamp: new Date().toISOString(),
        }));
      } catch { /* ignore */ }

      try {
        const { invalidateUserHistoryCache } = await import('@/lib/redisHistoryCache');
        await Promise.all([
          invalidateUserHistoryCache(user.id),
          invalidateUserPositionsCache(user.id),
          invalidateUserOrdersCache(user.id),
        ]);
      } catch { /* ignore */ }
    });

    try {
      const { invalidateUserHistoryCache } = await import('@/lib/redisHistoryCache');
      await Promise.all([
        invalidateUserHistoryCache(user.id),
        invalidateUserPositionsCache(user.id),
        invalidateUserOrdersCache(user.id),
      ]);
    } catch { /* ignore */ }

    return NextResponse.json(response, { status: 201 });
  } catch (topErr: any) {
    console.error('[POST /api/orders] Top-level 500 Handler Error:', topErr);
    return NextResponse.json({ error: topErr?.message || String(topErr) || 'Internal server error' }, { status: 500 });
  }
}
