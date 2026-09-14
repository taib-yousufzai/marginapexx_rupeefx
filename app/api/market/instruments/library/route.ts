import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRedisClient } from '@/lib/redis';
import {
  loadStrikeConfig,
  applyForexFilter,
  applyCryptoWhitelist,
  applyExpiryFilter,
  applyStrikeRangeFilter,
  applyMcxStrikeRangeFilter,
  type Instrument,
} from '@/lib/filterEngine';

export const dynamic = 'force-dynamic';

const INDEX_NAMES = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'NIFTYFPI',
  'SENSEX', 'BANKEX', 'SENSEX50',
]);

function isIndexUnderlying(name: string): boolean {
  if (!name) return false;
  const upper = name.trim().toUpperCase();
  if (INDEX_NAMES.has(upper)) return true;
  if (
    upper.startsWith('NIFTY') ||
    upper.startsWith('SENSEX') ||
    upper.startsWith('BANKEX') ||
    upper.startsWith('BANKNIFTY') ||
    upper.startsWith('FINNIFTY') ||
    upper.startsWith('MIDCP')
  ) {
    return true;
  }
  return false;
}

const COMMODITY_NAMES = new Set([
  'CRUDEOIL', 'CRUDEOILM', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC',
  'NATURALGAS', 'NATGASMINI', 'ALUMINIUM', 'ALUMINI', 'ZINC', 'ZINCMINI',
  'LEAD', 'LEADMINI', 'COPPER'
]);

function isMcxCommodity(name: string): boolean {
  if (!name) return false;
  return COMMODITY_NAMES.has(name.trim().toUpperCase());
}

function isValidStockSymbol(name: string): boolean {
  if (!name) return false;
  const clean = name.trim().toUpperCase();

  // 1. Filter out index underlyings, MCX commodities, and currency pairs
  if (isIndexUnderlying(clean) || isMcxCommodity(clean)) return false;
  const CURRENCY_PAIRS = new Set(['USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'EURUSD', 'GBPUSD', 'USDJPY']);
  if (CURRENCY_PAIRS.has(clean)) return false;

  // 2. Reject if starts with a digit or number (e.g. 0ABCL, 1003IIFL, 0HFL, 0IRFC, 0MOFSL)
  if (/^\d/.test(clean)) return false;

  // 3. Reject debt/bond/series hyphens/suffixes (e.g. -N0, -NC, -Z4, -BW, -NV, -ZQ, -NX, -NR, -SF, -RL, -MF, -GS, -GB, -SG, -SM, -NP, -YC, -BE, -BL, -ST, -W1, -Y1, -Z1)
  if (/-(SF|RL|MF|GS|GB|NC|NR|NX|ZQ|BW|NV|YW|EQ|SG|SM|NP|YC|BE|BL|ST|W\d|Y\d|Z\d|N\d)$/i.test(clean)) return false;
  if (/-\d+[A-Z0-9]*/.test(clean) || /\d+-[A-Z0-9]*/.test(clean)) return false;

  // 4. Reject NAV mutual funds, ETFs, indices, or junk patterns
  if (clean.endsWith('NAV') || clean.includes('(EQ)') || clean.includes(' ') || clean.includes('.')) return false;
  if (clean.includes('NIFTY') || clean.includes('SENSEX') || clean.includes('GOLD') || clean.includes('SILVER') || clean.includes('INV') || clean.includes('ETF') || clean.includes('LIQUID')) return false;

  // 5. Allow standard clean ticker formats (e.g. RELIANCE, TCS, INFY, TATAMOTORS, HDFCBANK, M&M, BAJAJ-AUTO)
  if (!/^[A-Z][A-Z0-9&\-]{1,14}$/.test(clean)) return false;

  return true;
}

function safeOptName(i: any) {
  const isRealValue = (v: any) => v !== null && v !== undefined && String(v).toLowerCase() !== 'null' && String(v).trim() !== '';
  if (isRealValue(i.strike_price) && isRealValue(i.option_type)) {
    const underlying = isRealValue(i.name) ? i.name : (isRealValue(i.underlying_symbol) ? i.underlying_symbol : '');
    return `${underlying} ${i.strike_price} ${i.option_type}`.trim();
  }
  return isRealValue(i.tradingsymbol) ? i.tradingsymbol : 'Unknown';
}

function generateSyntheticStockOptions(stkName: string, expiry: string): any[] {
  const now = new Date(expiry || Date.now());
  const yearStr = String(now.getFullYear()).slice(-2);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const monthStr = months[now.getMonth()] || 'AUG';
  const expTag = `${yearStr}${monthStr}`;

  let baseStrike = 500;
  let step = 10;

  const lowValueStocks = new Set(['NHPC', 'IDEA', 'SUZLON', 'SJVN', 'IREDA', 'RVNL', 'HUDCO', 'YESBANK', 'PNB', 'IDFCFIRSTB', 'BHEL', 'NLCINDIA', 'NMDC', 'GMRINFRA', 'SOUTHBANK']);
  const highValueStocks = new Set(['TCS', 'RELIANCE', 'BAJFINANCE', 'INFY', 'ULTRACEMCO', 'BAJAJ-AUTO', 'MARUTI', 'HEROMOTOCO', 'DIXON', 'LTIM', 'EICHERMOT', 'SHREECEM']);

  const upperStk = stkName.toUpperCase();
  if (lowValueStocks.has(upperStk)) {
    baseStrike = 80;
    step = 2.5;
  } else if (highValueStocks.has(upperStk)) {
    baseStrike = 2500;
    step = 50;
  }

  const strikes: number[] = [];
  for (let k = -5; k <= 5; k++) {
    strikes.push(baseStrike + k * step);
  }

  const contracts: any[] = [];
  strikes.forEach(sp => {
    ['CE', 'PE'].forEach(optType => {
      const tsym = `${stkName}${expTag}${sp}${optType}`;
      contracts.push({
        name: `${stkName} ${sp} ${optType}`,
        symbol: tsym,
        kiteSymbol: `NFO:${tsym}`,
        price: 0,
        change: '0%',
        segment: 'NSE - Stock Options',
        contractDate: expiry,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        lotSize: 500,
      });
    });
  });
  return contracts.slice(0, 22);
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// In-memory cache for library catalog (30-minute TTL with SWR)
let memoryLibraryCache: {
  data: any;
  expiresAt: number;
  dateStr: string;
} | null = null;
let revalidatingPromise: Promise<any> | null = null;

export async function GET(request: Request) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // 1. Instant 0ms memory cache hit
    if (memoryLibraryCache && memoryLibraryCache.dateStr === today && memoryLibraryCache.expiresAt > Date.now()) {
      return NextResponse.json(memoryLibraryCache.data);
    }

    // 2. SWR: If we have an existing cache for today, serve it immediately and revalidate in the background
    if (memoryLibraryCache && memoryLibraryCache.dateStr === today) {
      if (!revalidatingPromise) {
        revalidatingPromise = buildLibrary(request, today).finally(() => {
          revalidatingPromise = null;
        });
      }
      return NextResponse.json(memoryLibraryCache.data);
    }

    // 3. Fast Redis cache check (300ms timeout)
    const redis = getRedisClient();
    const cacheKey = 'market:library:segments:v9';
    try {
      const cached = await Promise.race([
        redis.get(cacheKey),
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 300))
      ]);
      if (cached) {
        const parsed = JSON.parse(cached as string);
        memoryLibraryCache = {
          data: parsed,
          expiresAt: Date.now() + 1800 * 1000,
          dateStr: today,
        };
        return NextResponse.json(parsed);
      }
    } catch (e) {
      console.error('[library] Redis get cache error:', e);
    }

    return await buildLibrary(request, today);
  } catch (error: any) {
    console.error('Library API Error:', error);
    if (memoryLibraryCache?.data) {
      return NextResponse.json(memoryLibraryCache.data);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function buildLibrary(request: Request, today: string) {
  try {
    const url = new URL(request.url);
    const qsAtm: Record<string, number> = {
      'NIFTY': Number(url.searchParams.get('nifty')) || 0,
      'BANKNIFTY': Number(url.searchParams.get('banknifty')) || 0,
    };
    const cacheKey = 'market:library:segments:v9';
    const redis = getRedisClient();

    const segments: any[] = [];
    let usedFallback = false;

    // Load strike config once for the entire request
    const strikeConfig = await loadStrikeConfig(getSupabase());

    // 1. Index-FUT
    const { data: indexFuts } = await getSupabase()
      .from('instruments')
      .select('tradingsymbol, name, exchange, instrument_type, segment, expiry')
      .in('name', ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'SENSEX50', 'NIFTYNXT50'])
      .in('instrument_type', ['FUTIDX', 'FUT', 'MAPPED_FUT'])
      .gte('expiry', today)
      .order('expiry', { ascending: true })
      .limit(50);

    const indexFutInstruments: any[] = [];
    const foundNames = new Set<string>();

    if (indexFuts && indexFuts.length > 0) {
      const earliestExpiries = new Map<string, any>();
      indexFuts.forEach(f => {
        if (!earliestExpiries.has(f.name) || f.expiry < earliestExpiries.get(f.name).expiry) {
          earliestExpiries.set(f.name, f);
        }
      });

      earliestExpiries.forEach((i, name) => {
        foundNames.add(name);
        indexFutInstruments.push({
          name: i.tradingsymbol,
          symbol: i.tradingsymbol,
          kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0,
          change: '0%',
          segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Futures`,
          contractDate: i.expiry,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          lotSize: i.lot_size || 0
        });
      });
    }

    const indexFutDefaults: Record<string, any> = {
      'SENSEX': { name: 'SENSEX FUT', symbol: 'SENSEX_FUT', kiteSymbol: 'BSE:SENSEX_FUT', segment: 'BSE - Futures', price: 0, change: '0%', contractDate: '', open: 0, high: 0, low: 0, close: 0, lotSize: 10 },
      'BANKEX': { name: 'BANKEX FUT', symbol: 'BANKEX_FUT', kiteSymbol: 'BSE:BANKEX_FUT', segment: 'BSE - Futures', price: 0, change: '0%', contractDate: '', open: 0, high: 0, low: 0, close: 0, lotSize: 15 },
      'SENSEX50': { name: 'SENSEX50 FUT', symbol: 'SENSEX50_FUT', kiteSymbol: 'BSE:SENSEX50_FUT', segment: 'BSE - Futures', price: 0, change: '0%', contractDate: '', open: 0, high: 0, low: 0, close: 0, lotSize: 10 },
    };

    ['SENSEX', 'BANKEX', 'SENSEX50'].forEach(name => {
      if (!foundNames.has(name) && indexFutDefaults[name]) {
        indexFutInstruments.push(indexFutDefaults[name]);
      }
    });

    if (indexFutInstruments.length > 0) {
      segments.push({
        name: 'INDEX-FUT',
        icon: 'fa-chart-line',
        instruments: indexFutInstruments,
      });
    }

    // 2. Index-OPT — apply applyExpiryFilter + applyStrikeRangeFilter
    const kiteIdMap: Record<string, string> = {
      'NIFTY': 'NSE:NIFTY 50',
      'BANKNIFTY': 'NSE:NIFTY BANK',
      'FINNIFTY': 'NSE:NIFTY FIN SERVICE',
      'MIDCPNIFTY': 'NSE:NIFTY MID SELECT',
      'SENSEX': 'BSE:SENSEX',
      'BANKEX': 'BSE:BANKEX',
      'SENSEX50': 'BSE:SENSEX50',
      'NIFTYNXT50': 'NSE:NIFTY NEXT 50',
    };

    const indexOptCats = (await Promise.all(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'SENSEX50'].map(async (idx) => {
      const { data: expData } = await getSupabase().rpc('get_option_expiries', { p_symbol: idx, p_min_date: today });
      if (!expData || expData.length === 0) return null;

      // Apply expiry filter — nearest active only
      const allExpiries: string[] = expData.map((e: any) => e.expiry);
      const activeExpiries = applyExpiryFilter(allExpiries, today);
      if (activeExpiries.length === 0) return null;
      const nearestExpiry = activeExpiries[0];

      const { data: opts } = await getSupabase()
        .from('instruments')
        .select('tradingsymbol, name, exchange, instrument_type, strike_price, option_type, expiry, underlying_symbol')
        .eq('name', idx)
        .eq('expiry', nearestExpiry)
        .in('option_type', ['CE', 'PE'])
        .order('strike_price', { ascending: true });

      if (!opts || opts.length === 0) return null;

      // Apply strike range filter using Redis ATM price, with multiple fallbacks
      let selectedOpts: Instrument[] = opts as Instrument[];
      try {
        const kiteId = kiteIdMap[idx];
        if (kiteId) {
          let atmPrice = 0;

          // 1. Try Redis cache
          try {
            const cached = await redis.hget('market:quotes', kiteId);
            if (cached) {
              const q = JSON.parse(cached);
              atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
            }
            if (!atmPrice) {
              const altKey = kiteId.split(':')[1] || idx;
              const altCached = await redis.hget('market:quotes', altKey);
              if (altCached) {
                const q = JSON.parse(altCached);
                atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
              }
            }
          } catch (_) { /* Redis unavailable */ }

          // 2. Use spot price passed from frontend via query string
          if (!atmPrice && qsAtm[idx]) {
            atmPrice = qsAtm[idx];
          }

          // 4. Last resort: use the average of min+max strike as the center
          if (!atmPrice && opts.length > 0) {
            console.warn(`[library] All ATM price sources unavailable for ${idx}, using strike midpoint`);
            usedFallback = true;
            const allStrikes = [...new Set((opts as Instrument[]).map(i => i.strike_price || 0))].sort((a, b) => a - b);
            atmPrice = allStrikes[Math.floor(allStrikes.length / 2)] || 0;
          }

          if (atmPrice) {
            selectedOpts = applyStrikeRangeFilter(opts as Instrument[], atmPrice, strikeConfig.indexOptionsRange);
          }
        }
      } catch (e) {
        console.error(`[library] Failed to apply strike range filter for ${idx}:`, e);
      }

      return {
        name: `${idx} Options`,
        instruments: selectedOpts.map((i: any) => ({
          name: safeOptName(i), symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0, change: '0%', segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Options`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
        })).slice(0, 22)
      };
    }))).filter(Boolean);
    if (indexOptCats.length > 0) segments.push({ name: 'INDEX-OPT', icon: 'fa-chart-pie', subCategories: indexOptCats });

    // 3. Mcx-FUT & Mcx-OPT — apply applyExpiryFilter + applyStrikeRangeFilter for OPT
    const commodities = ['CRUDEOIL', 'CRUDEOILM', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC', 'NATURALGAS', 'NATGASMINI', 'ALUMINIUM', 'ALUMINI', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI', 'COPPER'];
    const mcxFutInstruments: any[] = [];  // flat list — no subCategories
    const mcxOptCats: any[] = [];

    await Promise.all(commodities.map(async (cmd) => {
      // FUT — collect directly into flat instruments array
      const { data: futs } = await getSupabase().from('instruments').select('*').eq('name', cmd).in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT']).gte('expiry', today).order('expiry', { ascending: true }).limit(2);
      if (futs && futs.length > 0) {
        futs.forEach((i: any) => mcxFutInstruments.push({
          name: i.tradingsymbol, symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0, change: '0%', segment: `${i.exchange} - Futures`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
        }));
      }
      // OPT — apply expiry + strike range filter
      const { data: expData } = await getSupabase().from('instruments').select('expiry').eq('name', cmd).in('instrument_type', ['CE', 'PE', 'FUTOPT']).gte('expiry', today);
      if (expData && expData.length > 0) {
        const allExpiries: string[] = [...new Set(expData.map((e: any) => e.expiry))];
        const activeExpiries = applyExpiryFilter(allExpiries, today);
        if (activeExpiries.length === 0) return;
        const nearestExpiry = activeExpiries[0];

        const { data: opts } = await getSupabase().from('instruments').select('*').eq('name', cmd).eq('expiry', nearestExpiry).in('option_type', ['CE', 'PE']).order('strike_price', { ascending: true });
        if (opts && opts.length > 0) {
          let selectedOpts: Instrument[] = opts as Instrument[];
          try {
            // MCX ATM price — use nearest future's market quote instead of spot
            let atmPrice = 0;
            if (futs && futs.length > 0) {
              const nearestFut = futs[0];
              const kiteId = `${nearestFut.exchange}:${nearestFut.tradingsymbol}`;
              const cached = await redis.hget('market:quotes', kiteId);
              if (cached) {
                const q = JSON.parse(cached);
                atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
              }
              if (!atmPrice) {
                const altKey = nearestFut.tradingsymbol;
                const altCached = await redis.hget('market:quotes', altKey);
                if (altCached) {
                  const q = JSON.parse(altCached);
                  atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
                }
              }
            }
            if (!atmPrice && opts.length > 0) {
              console.warn(`[library] No ATM price for MCX ${cmd}, falling back to median strike`);
              usedFallback = true;
              const middleIndex = Math.floor(opts.length / 2);
              atmPrice = (opts as Instrument[])[middleIndex]?.strike_price || 0;
            }
            if (atmPrice) {
              selectedOpts = applyMcxStrikeRangeFilter(opts as Instrument[], atmPrice);
            }
          } catch (e) {
            console.error(`[library] Failed to apply strike range filter for MCX ${cmd}:`, e);
          }

          mcxOptCats.push({
            name: cmd,
            instruments: selectedOpts.map((i: any) => ({ name: safeOptName(i), symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`, price: 0, change: '0%', segment: `${i.exchange} - Options`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size })).slice(0, 22)
          });
        }
      }
    }));

    if (mcxFutInstruments.length > 0) segments.push({ name: 'MCX-FUT', icon: 'fa-oil-well', instruments: mcxFutInstruments });
    if (mcxOptCats.length > 0) segments.push({ name: 'MCX-OPT', icon: 'fa-oil-well', subCategories: mcxOptCats });

    // 4. Stock-FUT, Stock-OPT, Nse-EQ (Top 500 stocks prioritizing Nifty 50)
    // 4. Stock-FUT, Stock-OPT, Nse-EQ (Top 500 most traded / recognizable equities)
    const TOP_RECOGNIZABLE_STOCKS = [
      // Nifty 50
      "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "BHARTIARTL", "ITC", "SBIN",
      "LTIM", "LT", "AXISBANK", "KOTAKBANK", "HCLTECH", "BAJFINANCE", "SUNPHARMA", "M&M",
      "MARUTI", "ULTRACEMCO", "NTPC", "TITAN", "TATAMOTORS", "TATASTEEL", "ASIANPAINT",
      "POWERGRID", "ADANIENT", "JSWSTEEL", "COALINDIA", "BAJAJFINSV", "SIEMENS", "ADANIPORTS",
      "TRENT", "GRASIM", "TECHM", "NESTLEIND", "HINDUNILVR", "BEL", "HDFCLIFE", "BAJAJ-AUTO",
      "CIPLA", "SHRIRAMFIN", "TATACONSUM", "DRREDDY", "WIPRO", "IOC", "BPCL", "EICHERMOT",
      "HEROMOTOCO", "APOLLOHOSP", "INDUSINDBK", "DIVISLAB", "HINDALCO", "SBILIFE", "BRITANNIA",
      "HAL", "ZOMATO", "JIOFIN", "VBL", "DLF", "GAIL", "PFC", "RECLTD", "TATAELXSI", "PIDILITIND", "INDIGO",

      // Nifty Next 50 & Top Large/Mid-caps
      "ABB", "ADANIENSOL", "ADANIGREEN", "ADANIPOWER", "ATGL", "AMBUJACEM", "BANKBARODA", "BERGEPAINT",
      "BOSCHLTD", "CANBK", "CHOLAFIN", "COLPAL", "DMART", "GODREJCP", "HAVELLS",
      "ICICIGI", "ICICIPRULI", "IRCTC", "IRFC", "NAUKRI", "JINDALSTEL", "JSWENERGY",
      "LICI", "LODHA", "MAXHEALTH", "MOTHERSON", "MUTHOOTFIN", "NHPC", "OIL", "ONGC", "PAYTM", "POLYCAB",
      "PNB", "SBICARD", "SRF", "SHREECEM", "SOLARINDS", "TATACOMM", "TATAPOWER",
      "TORNTPHARM", "TVSMOTOR", "UNITDSPR", "VEDL",

      // High Volume Traded & Popular (PSU, Railways, Defense, Tech, Retail)
      "RVNL", "SJVN", "IREDA", "MAZDOCK", "COCHINSHIP", "GRSE", "BHEL", "BDL", "DATAPATTERNS", "IDEA",
      "SUZLON", "YESBANK", "IDFCFIRSTB", "FEDERALBNK", "IDBI", "UNIONBANK", "IOB", "UCOBANK", "CENTRALBK",
      "BANKINDIA", "PSB", "INDIANB", "MAHABANK", "RBLBANK", "BANDHANBNK", "AUBANK", "KARURVYSYA", "CUB",
      "NYKAA", "POLICYBZR", "DELHIVERY", "SWIGGY", "HYUNDAI", "OLAELEC", "CDSL", "BSE", "MCX", "ANGELONE",
      "IEX", "HUDCO", "NBCC", "IRCON", "RAILTEL", "RITES", "TITAGARH", "TEXRAIL", "NLCINDIA",
      "NMDC", "KIOCL", "HINDPETRO", "MRPL", "CHENNPETRO", "GSPL", "IGL", "MGL", "GUJGASLTD", "PETRONET",
      "MANAPPURAM", "POONAWALLA", "L&TFH", "CREDITACC", "M&MFIN", "CHOLAHLDNG", "ABCAPITAL", "MUTHOOTMF",
      "KAYNES", "DIXON", "AMBER", "SYRMA", "NETWEB", "CYIENT", "PERSISTENT", "COFORGE", "MPHASIS", "LTTS",
      "TATATECH", "KPITTECH", "OFSS", "SONACOMS", "UNOMINDS", "MOTILALOFS", "NUVAMA",
      "JUBLFOOD", "DEVYANI", "WESTLIFE", "VARUN", "CAMPUS", "BATAINDIA", "RELAXO",
      "METROBRAND", "KALYANKJIL", "SENCO", "PAGEIND", "RAYMOND", "ARVIND", "KPRMILL", "GOCOLORS",
      "MANKIND", "ASTRAZEN", "GLAXO", "SANOFI", "LUPIN", "ALKEM", "GLENMARK", "BIOCON",
      "GRANULES", "LAURUSLABS", "NATCOPHARM", "NEULANDLAB", "AJANTPHARM", "JBCHEPHARM", "IPCABAL",
      "EXIDEIND", "AMARARAJA", "SUPRAJIT", "ENDURANCE", "CRAFTSMAN", "BALKRISIND", "MRF", "APOLLOTYRE",
      "CEATLTD", "JKTYRE", "TVSSRICHAK", "CUMMINSIND", "CGPOWER", "VOLTAS",
      "BLUESTARCO", "WHIRLPOOL", "SYMPHONY", "CROMPTON", "KEI", "RRKABEL", "FINCABLES",
      "APARINDS", "KEC", "PGEL", "VGUARD", "KIRLOSENG", "ELGIEQUIP"
    ];

    // a. NSE-EQ: Top 500 equities prioritizing Nifty 50, F&O underlyings, and top recognizable stocks
    const { data: futUnderlyings } = await getSupabase()
      .from('instruments')
      .select('name')
      .in('instrument_type', ['FUTSTK', 'FUT'])
      .eq('exchange', 'NFO');

    const foStockSymbols = Array.from(new Set((futUnderlyings || []).map((f: any) => f.name))).filter(Boolean);
    const prioritySymbols = Array.from(new Set([...TOP_RECOGNIZABLE_STOCKS, ...foStockSymbols])).filter(isValidStockSymbol);

    // Fetch existing EQ instruments from Supabase DB
    const { data: prioEqData } = await getSupabase()
      .from('instruments')
      .select('tradingsymbol, name, exchange, instrument_type, lot_size')
      .eq('exchange', 'NSE')
      .eq('instrument_type', 'EQ');

    const dbEqMap = new Map<string, any>();
    (prioEqData || []).forEach((i: any) => {
      if (isValidStockSymbol(i.tradingsymbol)) {
        dbEqMap.set(i.tradingsymbol, i);
      }
    });

    const nseEqInstruments: any[] = [];
    const addedEqSymbols = new Set<string>();

    // Priority 1: Add curated Nifty 50 & top recognizable / F&O stock underlyings first
    prioritySymbols.forEach((sym) => {
      if (!addedEqSymbols.has(sym) && nseEqInstruments.length < 500) {
        addedEqSymbols.add(sym);
        const existing = dbEqMap.get(sym);
        nseEqInstruments.push({
          name: sym,
          symbol: sym,
          kiteSymbol: existing ? `${existing.exchange}:${existing.tradingsymbol}` : `NSE:${sym}`,
          price: 0,
          change: '0%',
          segment: `${existing ? existing.exchange : 'NSE'} - Equity`,
          contractDate: '',
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          lotSize: existing?.lot_size || 1,
        });
      }
    });

    // Priority 2: Fill remaining up to 500 from clean valid DB equities
    dbEqMap.forEach((inst: any, sym: string) => {
      if (!addedEqSymbols.has(sym) && nseEqInstruments.length < 500) {
        addedEqSymbols.add(sym);
        nseEqInstruments.push({
          name: sym,
          symbol: sym,
          kiteSymbol: `${inst.exchange}:${inst.tradingsymbol}`,
          price: 0,
          change: '0%',
          segment: `${inst.exchange} - Equity`,
          contractDate: '',
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          lotSize: inst.lot_size || 1,
        });
      }
    });


    // b. Stock-FUT: batch fetch up to 500 Stock Futures
    const { data: stockFutData } = await getSupabase()
      .from('instruments')
      .select('tradingsymbol, name, exchange, instrument_type, segment, expiry, lot_size')
      .in('instrument_type', ['FUTSTK', 'FUT', 'MAPPED_FUT'])
      .in('segment', ['NFO-FUT', 'BFO-FUT'])
      .gte('expiry', today)
      .order('expiry', { ascending: true })
      .limit(1000);

    const stockFutInstruments: any[] = [];
    const stockFutMap = new Map<string, number>();
    const seenFutSymbols = new Set<string>();
    (stockFutData || []).forEach((i: any) => {
      const baseName = i.name || i.tradingsymbol?.replace(/\d+[A-Z]{3}FUT$/i, '');
      if (!isValidStockSymbol(baseName)) return;
      if (seenFutSymbols.has(i.tradingsymbol)) return;
      const count = stockFutMap.get(i.name) || 0;
      if (count < 2) {
        seenFutSymbols.add(i.tradingsymbol);
        stockFutMap.set(i.name, count + 1);
        stockFutInstruments.push({
          name: i.tradingsymbol,
          symbol: i.tradingsymbol,
          kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0,
          change: '0%',
          segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Stock Futures`,
          contractDate: i.expiry,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          lotSize: i.lot_size || 0,
        });
      }
    });

    // c. Stock-OPT: batch fetch Stock Options for priority recognizable stock underlyings
    const stockBatches: string[][] = [];
    const targetStockNames = prioritySymbols.filter(s => isValidStockSymbol(s));
    for (let i = 0; i < targetStockNames.length; i += 40) {
      stockBatches.push(targetStockNames.slice(i, i + 40));
    }

    const stockOptResults = await Promise.all(
      stockBatches.map(batch =>
        getSupabase()
          .from('instruments')
          .select('tradingsymbol, name, exchange, instrument_type, strike_price, option_type, expiry, lot_size')
          .in('name', batch)
          .in('segment', ['NFO-OPT', 'BFO-OPT', 'NFO', 'BFO'])
          .in('option_type', ['CE', 'PE'])
          .gte('expiry', today)
          .limit(1000)
      )
    );

    const stockOptData = stockOptResults.flatMap(r => r.data || []);

    const stockOptGroup: Record<string, Record<string, Instrument[]>> = {};
    (stockOptData || []).forEach((i: any) => {
      if (!isValidStockSymbol(i.name)) return;
      const stk = i.name;
      if (!stk || !i.expiry) return;
      if (!stockOptGroup[stk]) stockOptGroup[stk] = {};
      if (!stockOptGroup[stk][i.expiry]) stockOptGroup[stk][i.expiry] = [];
      stockOptGroup[stk][i.expiry].push(i as Instrument);
    });

    const stockOptCats: any[] = [];
    const addedStockNames = new Set<string>();

    Object.keys(stockOptGroup).forEach((stk) => {
      if (stockOptCats.length >= 400) return;
      const expiries = Object.keys(stockOptGroup[stk]).sort();
      if (expiries.length === 0) return;
      const nearestExpiry = expiries[0];
      const opts = stockOptGroup[stk][nearestExpiry].sort((a, b) => (a.strike_price || 0) - (b.strike_price || 0));

      let selectedOpts: Instrument[] = opts;
      if (opts.length > 0) {
        const middleIndex = Math.floor(opts.length / 2);
        const atmPrice = opts[middleIndex]?.strike_price || 0;
        if (atmPrice) {
          selectedOpts = applyStrikeRangeFilter(opts, atmPrice, strikeConfig.indexOptionsRange);
        }
      }

      addedStockNames.add(stk);
      let mappedInstruments = selectedOpts.map((i: any) => ({
        name: safeOptName(i),
        symbol: i.tradingsymbol,
        kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
        price: 0,
        change: '0%',
        segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Stock Options`,
        contractDate: i.expiry,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        lotSize: i.lot_size,
      }));

      // If database query PostgREST cap truncated results leaving < 10 option contracts, fall back to synthetic strike generation
      if (mappedInstruments.length < 10) {
        mappedInstruments = generateSyntheticStockOptions(stk, today);
      }

      stockOptCats.push({
        name: stk,
        instruments: mappedInstruments.slice(0, 22),
      });
    });

    // Only derive candidate stock options from verified Stock Futures (derivative segment)
    const candidateStocks: string[] = [];
    (stockFutInstruments || []).forEach((inst: any) => {
      const name = inst.name?.replace(/\s*\d+[A-Z]{3}FUT$/i, '').trim() || inst.symbol?.replace(/\d+[A-Z]{3}FUT$/i, '').trim();
      if (name && isValidStockSymbol(name)) {
        if (!addedStockNames.has(name)) {
          addedStockNames.add(name);
          candidateStocks.push(name);
        }
      }
    });

    candidateStocks.forEach((stk) => {
      if (stockOptCats.length >= 400) return;
      stockOptCats.push({
        name: stk,
        instruments: generateSyntheticStockOptions(stk, today),
      });
    });

    if (stockFutInstruments.length > 0) segments.push({ name: 'STOCK-FUT', icon: 'fa-building', instruments: stockFutInstruments });
    if (stockOptCats.length > 0) segments.push({ name: 'STOCK-OPT', icon: 'fa-building', subCategories: stockOptCats });
    if (nseEqInstruments.length > 0) segments.push({ name: 'STOCKS', icon: 'fa-landmark', instruments: nseEqInstruments });

    // 5. Crypto — apply applyCryptoWhitelist
    const { data: cryptos } = await getSupabase().from('instruments').select('*').eq('segment', 'CRYPTO').order('name', { ascending: true });
    if (cryptos && cryptos.length > 0) {
      const whitelisted = applyCryptoWhitelist(cryptos as Instrument[]);
      const uniqueCryptos = new Map();
      whitelisted.forEach((c: any) => {
        if (!uniqueCryptos.has(c.tradingsymbol) || c.id === c.tradingsymbol) {
          uniqueCryptos.set(c.tradingsymbol, c);
        }
      });
      if (uniqueCryptos.size > 0) {
        segments.push({
          name: 'CRYPTO',
          icon: 'fa-bitcoin',
          instruments: Array.from(uniqueCryptos.values()).map((i: any) => ({
            name: i.tradingsymbol, symbol: i.tradingsymbol, kiteSymbol: i.id,
            price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
          }))
        });
      }
    }

    // 6. Comex
    const { data: comex } = await getSupabase().from('instruments').select('*').eq('segment', 'COMEX').order('name', { ascending: true });
    if (comex && comex.length > 0) {
      const { data: mcxFuts } = await getSupabase()
        .from('instruments')
        .select('tradingsymbol, name, exchange, expiry')
        .eq('exchange', 'MCX')
        .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
        .gte('expiry', today);

      const mcxMap = new Map();
      if (mcxFuts) {
        mcxFuts.forEach(f => {
          if (!mcxMap.has(f.name) || f.expiry < mcxMap.get(f.name).expiry) {
            mcxMap.set(f.name, f);
          }
        });
      }

      const tickerMap: Record<string, string> = {
        'XAUUSD': 'GOLD',
        'XAGUSD': 'SILVER',
        'XTIUSD': 'CRUDEOIL',
        'XCUUSD': 'COPPER',
        'XNGUSD': 'NATURALGAS',
        'GC=F': 'GOLD',
        'SI=F': 'SILVER',
        'CL=F': 'CRUDEOIL',
        'HG=F': 'COPPER',
      };

      const symbolMap: Record<string, string> = {
        'XAUUSD': 'GOLD_FUT',
        'XAGUSD': 'SILVER_FUT',
        'XTIUSD': 'CRUDEOIL_FUT',
        'XCUUSD': 'COPPER_FUT',
        'XNGUSD': 'NATURALGAS_FUT',
        'GC=F': 'GOLD_FUT',
        'SI=F': 'SILVER_FUT',
        'CL=F': 'CRUDEOIL_FUT',
        'HG=F': 'COPPER_FUT',
      };

      segments.push({
        name: 'COMEX',
        icon: 'fa-globe',
        instruments: comex.map((i: any) => {
          const mcxUnderlying = tickerMap[i.id];
          const matchedMcx = mcxUnderlying ? mcxMap.get(mcxUnderlying) : null;
          return {
            name: i.tradingsymbol,
            symbol: i.id,
            kiteSymbol: '',
            comexSymbol: i.id,
            price: 0,
            change: '0%',
            segment: 'COMEX - Futures',
            contractDate: matchedMcx ? matchedMcx.expiry : '',
            open: 0,
            high: 0,
            low: 0,
            close: 0,
            category: 'COI'
          };
        })
      });
    }

    // 7. Forex — deduplicated, including Global USD pairs and INR Currency Futures
    const currencies = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
    const forexInstruments: any[] = [];
    const seenForexSymbols = new Set<string>();

    // a. Global USD Forex pairs (EURUSD, GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD)
    const { data: globalForex } = await getSupabase()
      .from('instruments')
      .select('*')
      .or('segment.eq.FOREX,exchange.eq.FOREX,instrument_type.eq.FOREX');

    if (globalForex && globalForex.length > 0) {
      globalForex.forEach((i: any) => {
        const sym = i.tradingsymbol || i.id;
        if (sym && !seenForexSymbols.has(sym)) {
          seenForexSymbols.add(sym);
          forexInstruments.push({
            name: i.name || sym,
            symbol: sym,
            kiteSymbol: `${i.exchange || 'FOREX'}:${sym}`,
            price: 0,
            change: '0%',
            segment: 'FOREX',
            contractDate: '',
            open: 0,
            high: 0,
            low: 0,
            close: 0,
            lotSize: i.lot_size || 1,
          });
        }
      });
    }

    const standardUsdPairs = [
      { symbol: 'EURUSD', name: 'EUR/USD' },
      { symbol: 'GBPUSD', name: 'GBP/USD' },
      { symbol: 'USDJPY', name: 'USD/JPY' },
      { symbol: 'USDCHF', name: 'USD/CHF' },
      { symbol: 'USDCAD', name: 'USD/CAD' },
      { symbol: 'AUDUSD', name: 'AUD/USD' },
    ];
    standardUsdPairs.forEach((p) => {
      if (!seenForexSymbols.has(p.symbol)) {
        seenForexSymbols.add(p.symbol);
        forexInstruments.push({
          name: p.name,
          symbol: p.symbol,
          kiteSymbol: `FOREX:${p.symbol}`,
          price: 0,
          change: '0%',
          segment: 'FOREX',
          contractDate: '',
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          lotSize: 1,
        });
      }
    });

    // b. INR Currency Futures (USDINR, EURINR, GBPINR, JPYINR)
    await Promise.all(currencies.map(async (curr) => {
      const { data: futs } = await getSupabase()
        .from('instruments')
        .select('*')
        .eq('name', curr)
        .in('instrument_type', ['FUTCUR', 'FUT', 'MAPPED_FUT'])
        .gte('expiry', today)
        .order('expiry', { ascending: true })
        .limit(2);

      const filtered = applyForexFilter((futs ?? []) as Instrument[]);

      filtered.forEach((i: any) => {
        const sym = i.tradingsymbol;
        if (sym && !seenForexSymbols.has(sym)) {
          seenForexSymbols.add(sym);
          forexInstruments.push({
            name: i.tradingsymbol,
            symbol: i.tradingsymbol,
            kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
            price: 0,
            change: '0%',
            segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Futures`,
            contractDate: i.expiry,
            open: 0,
            high: 0,
            low: 0,
            close: 0,
            lotSize: i.lot_size || 0,
          });
        }
      });
    }));

    if (forexInstruments.length > 0) segments.push({ name: 'FOREX', icon: 'fa-coins', instruments: forexInstruments });

    // 8. US-EQ
    const usStockCatalog = [
      { name: 'Apple Inc.', symbol: 'US:AAPL', kiteSymbol: 'US:AAPL', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Tesla Inc.', symbol: 'US:TSLA', kiteSymbol: 'US:TSLA', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Nvidia Corp.', symbol: 'US:NVDA', kiteSymbol: 'US:NVDA', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Microsoft Corp.', symbol: 'US:MSFT', kiteSymbol: 'US:MSFT', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Amazon.com Inc.', symbol: 'US:AMZN', kiteSymbol: 'US:AMZN', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Alphabet Inc.', symbol: 'US:GOOGL', kiteSymbol: 'US:GOOGL', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Meta Platforms', symbol: 'US:META', kiteSymbol: 'US:META', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Netflix Inc.', symbol: 'US:NFLX', kiteSymbol: 'US:NFLX', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Advanced Micro Devices', symbol: 'US:AMD', kiteSymbol: 'US:AMD', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Intel Corp.', symbol: 'US:INTC', kiteSymbol: 'US:INTC', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'SPDR S&P 500 ETF (S&P 500)', symbol: 'US:SPY', kiteSymbol: 'US:SPY', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Invesco QQQ Trust (Nasdaq 100)', symbol: 'US:QQQ', kiteSymbol: 'US:QQQ', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'SPDR Dow Jones ETF (Dow Jones)', symbol: 'US:DIA', kiteSymbol: 'US:DIA', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'S&P 500 E-mini Futures', symbol: 'US:ES=F', kiteSymbol: 'US:ES=F', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Nasdaq 100 E-mini Futures', symbol: 'US:NQ=F', kiteSymbol: 'US:NQ=F', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
      { name: 'Dow Jones E-mini Futures', symbol: 'US:YM=F', kiteSymbol: 'US:YM=F', segment: 'US - Equity', price: 0, change: '0%', open: 0, high: 0, low: 0, close: 0, lotSize: 1 },
    ];
    segments.push({ name: 'US-EQ', icon: 'fa-flag-usa', instruments: usStockCatalog });

    const responsePayload = { success: true, segments };

    // Update in-memory cache for 30 minutes
    memoryLibraryCache = {
      data: responsePayload,
      expiresAt: Date.now() + 1800 * 1000,
      dateStr: today,
    };

    try {
      // Cache in Redis for 1800 seconds (30 mins)
      const ttl = 1800;
      await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', ttl);
    } catch (e) {
      console.error('[library] Redis set cache error:', e);
    }

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('Library API Error:', error);
    if (memoryLibraryCache?.data) {
      return NextResponse.json(memoryLibraryCache.data);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
