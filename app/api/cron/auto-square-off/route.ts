import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';
import { RiskValidation } from '@/lib/trading/RiskValidation';


export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function getAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Helper for fetching live bid/ask quote
async function fetchQuote(symbol: string, settlement: string): Promise<{ bid: number; ask: number } | null> {
  const cleanSym = symbol.replace(/^(CRYPTO:|BINANCE:|FOREX:|COMEX:|NSE:|BSE:|MCX:|NFO:|US:|US-EQ:)/i, '').replace(/[\/\s\_]/g, '').toUpperCase();
  const isCrypto = (settlement || '').toUpperCase().includes('CRYPTO') || cleanSym.endsWith('USDT');

  if (isCrypto) {
    try {
      const sym = cleanSym.endsWith('USDT') ? cleanSym : `${cleanSym}USDT`;
      // Try Binance bookTicker first (authoritative bid/ask)
      const res = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${sym}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        const bid = parseFloat(data.bidPrice);
        const ask = parseFloat(data.askPrice);
        if (bid > 0 && ask > 0) return { bid, ask };
      }
    } catch { return null; }
  }

  const isComex = (settlement || '').toUpperCase().includes('COMEX') ||
    ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => cleanSym.includes(c));

  if (isComex) {
    try {
      const { fetchMT5StockQuote } = await import('@/lib/datafeed/MT5StockService');
      const mt5Q = await fetchMT5StockQuote(cleanSym);
      if (mt5Q) {
        const price = (mt5Q as any).price ?? (mt5Q as any).lastPrice ?? 0;
        const bid = mt5Q.bid || price;
        const ask = mt5Q.ask || price;
        if (bid > 0 && ask > 0) return { bid, ask };
      }
    } catch { return null; }
  }

  const isUS = (settlement || '').toUpperCase().includes('US') ||
    ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'SPY', 'QQQ'].some(c => cleanSym.includes(c));

  if (isUS) {
    try {
      const { fetchUSStockQuote } = await import('@/lib/datafeed/USStockService');
      const usQ = await fetchUSStockQuote(cleanSym);
      if (usQ) {
        const price = (usQ as any).price ?? (usQ as any).lastPrice ?? 0;
        const bid = usQ.bid || price;
        const ask = usQ.ask || price;
        if (bid > 0 && ask > 0) return { bid, ask };
      }
    } catch { return null; }
  }

  try {
    let fullSymbol = symbol;
    if (!symbol.includes(':')) {
      let exchange = 'NSE';
      const s = (settlement || '').toUpperCase();
      if (s.includes('MCX')) exchange = 'MCX';
      else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
      else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
      else if (s.includes('BSE')) exchange = 'BSE';
      fullSymbol = `${exchange}:${symbol}`;
    }
    const apiKey = process.env.KITE_API_KEY;
    if (!apiKey) return null;
    const session = await getSharedKiteSession();
    if (!session) return null;

    const params = new URLSearchParams({ i: fullSymbol });
    const res = await fetch(`https://api.kite.trade/quote?${params}`, {
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${apiKey}:${session.accessToken}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const quote = data.data?.[fullSymbol];
      if (quote) {
        const bid = Number(quote.depth?.buy?.[0]?.price ?? 0);
        const ask = Number(quote.depth?.sell?.[0]?.price ?? 0);
        if (bid > 0 && ask > 0) return { bid, ask };
      }
    }
  } catch { return null; }

  return null;
}

export async function GET(request: Request) {
  const admin = getAdmin();
  try {
    const authHeader = (request as any).headers?.get?.('authorization') ?? '';
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[Auto Sq-Off] Starting...');

    // 1. Fetch Trading Hours
    const { data: tradingHours, error: thError } = await admin.from('trading_hours').select('*');
    if (thError) throw thError;

    // 2. Get current time in IST (HH:mm)
    const nowStr = new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
    const nowIst = new Date(nowStr);
    const currentHh = nowIst.getHours();
    const currentMm = nowIst.getMinutes();
    const currentTotalMinutes = currentHh * 60 + currentMm;

    // Map segments that are closed
    const closedSegments = new Set<string>();
    
    for (const th of (tradingHours || [])) {
      if (!th.end_time || !th.is_active) continue;
      // parse end_time "HH:mm"
      const [h, m] = th.end_time.split(':').map(Number);
      let endTotalMinutes = (h * 60) + m;
      // 00:00 midnight represents end of trading day (24:00 = 1440 mins)
      if (endTotalMinutes === 0) {
        endTotalMinutes = 1440;
      }
      
      // Auto-square-off happens 5 minutes before market close for Indian markets.
      const isIndianMarket = ['nse', 'bse', 'nfo', 'cds', 'mcx'].includes(th.id.toLowerCase());
      const squareOffOffset = isIndianMarket ? 5 : 0;
      const squareOffMinutes = endTotalMinutes - squareOffOffset;
      
      // If current time >= square-off time, trigger intraday square off.
      if (currentTotalMinutes >= squareOffMinutes) {
        closedSegments.add(th.id.toLowerCase());
      }
    }

    if (closedSegments.size === 0) {
       return NextResponse.json({ success: true, message: 'No markets are currently closed.' });
    }

    // 3. Fetch open INTRADAY positions
    const { data: openPositions, error: posError } = await admin
      .from('positions')
      .select('*')
      .eq('status', 'open')
      .eq('product_type', 'INTRADAY')
      .gt('qty_open', 0);

    if (posError) throw posError;
    if (!openPositions || openPositions.length === 0) {
      return NextResponse.json({ success: true, message: 'No open INTRADAY positions to process' });
    }

    const results = {
      intradayClosed: 0,
      intradayErrors: 0,
      errors: [] as string[]
    };

    const { data: profiles } = await admin.from('profiles').select('id, parent_id, trading_mode, balance, intraday_sq_off');
    const { data: segmentSettings } = await admin.from('segment_settings').select('*');
    const { data: scalperSettings } = await admin.from('scalper_segment_settings').select('*');

    for (const pos of openPositions) {
      try {
        const userProfile = profiles?.find(p => p.id === pos.user_id);
        if (!userProfile) continue;
        
        // Ensure user hasn't explicitly disabled auto-sq-off
        if (!userProfile.intraday_sq_off) continue;

        // Ensure this position's market is actually closed
        // Resolve market hours segment ID canonical value
        const settlementId = RiskValidation.resolveTradingHoursSegmentId(pos.symbol || '', pos.settlement || '');


        // Check if market is closed
        if (!closedSegments.has(settlementId)) {
            continue; // Market is still open
        }

        const isScalper = userProfile.trading_mode === 'scalper';
        const settingsToUse = isScalper ? (scalperSettings || []) : (segmentSettings || []);
        const lookupId = userProfile.parent_id ?? userProfile.id;

        const segSetting = settingsToUse.find(
          s => s.user_id === lookupId && s.segment === pos.settlement && s.side === pos.side
        );

        // --- AUTO SQUARE OFF INTRADAY POSITIONS ---
        const liveQuote = await fetchQuote(pos.symbol, pos.settlement);
        const basePrice = liveQuote
          ? (pos.side === 'BUY' ? liveQuote.bid : liveQuote.ask)
          : Number(pos.ltp || pos.entry_price || 0);

        if (!basePrice || basePrice <= 0) {
          console.error(`[Auto Sq-Off] No valid price for ${pos.symbol} (pos ${pos.id}). Skipping.`);
          results.intradayErrors = (results.intradayErrors || 0) + 1;
          continue;
        }

        let exitPrice = basePrice;
        if (segSetting) {
            const exitBuffer = Number(segSetting?.exit_buffer ?? 0.0017);
            const bidBuffer = Number(segSetting?.bid_buffer ?? 0);
            if (pos.side === 'BUY') {
            // Selling to close: apply bid_buffer to BID
            exitPrice = basePrice * (1 - bidBuffer);
            } else {
            // Buying to close: apply exit_buffer to ASK
            exitPrice = basePrice * (1 + exitBuffer);
            }
        }
        
        // Intraday brokerage is handled inside close_position based on entry/exit logic, 
        // carryBrokerage should theoretically be 0 for INTRADAY product_type anyway, 
        // but we compute it if needed by existing logic
        let carryBrokerage = 0;
        if (!pos.carry_brokerage_paid) {
          carryBrokerage = calculateCarryBrokerage({
            productType: pos.product_type,
            qty: Number(pos.qty_open),
            entryPrice: Number(pos.entry_price),
            carryCommissionType: segSetting?.carry_commission_type,
            carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
            commissionType: segSetting?.commission_type,
            commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
          });
        }
        
        const closeQty = Number(pos.qty_open !== undefined && pos.qty_open !== null && Number(pos.qty_open) > 0 ? pos.qty_open : (pos.qty_total || 1));
        const { error: rpcErr } = await admin.rpc('close_position_v2', {
          p_position_id:        pos.id,
          p_close_qty:          closeQty,
          p_close_price:        exitPrice,
          p_closed_by:          'SYSTEM',
          p_expected_brokerage: carryBrokerage,
        });

        if (!rpcErr) {
          await admin.from('notifications').insert({
            user_id: userProfile.id,
            type: 'GENERAL',
            title: `[Auto Square Off] ${pos.symbol}`,
            message: `Your Intraday position for ${pos.symbol} was automatically squared off at Market Close.`,
            read: false,
            created_at: new Date().toISOString()
          });
          results.intradayClosed++;
        } else {
          results.errors.push(`Failed to auto sq-off pos ${pos.id}`);
        }
        
      } catch (e: any) {
        results.errors.push(`Error processing pos ${pos.id}: ${e.message}`);
      }
    }

    console.log('[Auto Sq-Off] Completed:', results);

    return NextResponse.json({
      success: true,
      closedMarkets: Array.from(closedSegments),
      results,
    });
  } catch (error: any) {
    console.error('[Auto Sq-Off] Fatal Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

