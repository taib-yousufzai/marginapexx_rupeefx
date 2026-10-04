import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Papa from 'papaparse';
import { revalidatePath } from 'next/cache';

// Ensure this route is always dynamically executed
export const dynamic = 'force-dynamic';
// Allow up to 60 seconds (requires Vercel Pro, but Hobby will stop at 10s-15s)
export const maxDuration = 60;

// Initialize admin client to bypass RLS (lazy to avoid build-time env errors)
function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function GET(request: Request) {
  const supabase = getSupabase();
  try {
    // 1. Verify cron secret to protect the endpoint
    const { searchParams } = new URL(request.url);
    const secret = searchParams.get('secret');
    if (secret !== process.env.AUTOLOGIN_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Fetch ALL instruments CSV from Zerodha
    console.log('[Sync Instruments] Fetching from Zerodha...');
    const res = await fetch('https://api.kite.trade/instruments');
    if (!res.ok) {
      throw new Error(`Failed to fetch instruments: ${res.statusText}`);
    }

    const csvData = await res.text();

    // 3. Parse CSV
    console.log('[Sync Instruments] Parsing CSV...');
    const parsed = Papa.parse(csvData, {
      header: true,
      skipEmptyLines: true,
    });

    if (parsed.errors.length > 0) {
      console.warn('[Sync Instruments] CSV Parsing errors:', parsed.errors[0]);
    }

    // 4. Map instruments and find front-month futures
    const finalInstruments: any[] = [];
    
    // a. Add standard NSE Equities and Indices
    const nseEquities = parsed.data.filter((row: any) => 
      (row.instrument_type === 'EQ' && row.segment === 'NSE') || 
      (row.segment === 'INDICES')
    );
    for (const row of nseEquities as any[]) {
      finalInstruments.push({
        id: `${row.exchange}:${row.tradingsymbol}`,
        instrument_token: parseInt(row.instrument_token, 10),
        tradingsymbol: row.tradingsymbol,
        name: row.name,
        exchange: row.exchange,
        instrument_type: row.instrument_type,
        segment: row.segment,
        lot_size: parseInt(row.lot_size || '0', 10) || 0,
      });
    }

    // b. Group futures by exchange+name to find the earliest expiry (front-month)
    const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const futures = parsed.data.filter((row: any) => 
      (row.segment === 'MCX-FUT' || row.segment === 'CDS-FUT' || row.segment === 'NFO-FUT' || row.segment === 'BFO-FUT') && 
      (row.instrument_type === 'FUT' || row.instrument_type === 'FUTCOM' || row.instrument_type === 'FUTCUR') &&
      MONTHS.some(m => row.tradingsymbol.includes(m))
    );
    
    const groups: Record<string, any[]> = {};
    for (const row of futures as any[]) {
      const key = `${row.exchange}:${row.name}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    }

    for (const [groupKey, contracts] of Object.entries(groups)) {
      contracts.sort((a, b) => new Date(a.expiry).getTime() - new Date(b.expiry).getTime());
      
      // 1. Maintain the mapped front-month future for legacy/spot references
      const frontMonth = contracts[0];
      finalInstruments.push({
        id: groupKey, 
        instrument_token: parseInt(frontMonth.instrument_token, 10),
        tradingsymbol: frontMonth.tradingsymbol,
        name: frontMonth.name,
        exchange: frontMonth.exchange,
        instrument_type: 'MAPPED_FUT',
        segment: frontMonth.segment,
        expiry: frontMonth.expiry,
        lot_size: parseInt(frontMonth.lot_size || '0', 10) || 0,
      });

      // 2. Add all individual future contracts (current and far months)
      for (const contract of contracts) {
        finalInstruments.push({
          id: `${contract.exchange}:${contract.tradingsymbol}`,
          instrument_token: parseInt(contract.instrument_token, 10),
          tradingsymbol: contract.tradingsymbol,
          name: contract.name,
          exchange: contract.exchange,
          instrument_type: contract.instrument_type,
          segment: contract.segment,
          expiry: contract.expiry,
          lot_size: parseInt(contract.lot_size || '0', 10) || 0,
        });
      }
    }

    // c. Add Active Options (NFO, BFO, MCX-OPT, CDS-OPT)
    const today = new Date().toISOString().split('T')[0];
    const options = parsed.data.filter((row: any) => {
      if (row.instrument_type !== 'CE' && row.instrument_type !== 'PE') return false;
      if (row.expiry && row.expiry < today) return false;
      return true;
    });

    for (const row of options as any[]) {
      const symbol = (row.tradingsymbol || row.trading_symbol || '').toUpperCase();
      const underlying = row.name || symbol.replace(/(CE|PE)$/, '').replace(/\d+.*$/, '');

      finalInstruments.push({
        id: `${row.exchange}:${symbol}`,
        instrument_token: parseInt(row.instrument_token, 10),
        tradingsymbol: symbol,
        name: row.name || underlying,
        exchange: row.exchange,
        instrument_type: row.instrument_type,
        segment: row.segment,
        expiry: row.expiry,
        strike_price: parseFloat(row.strike || row.strike_price || '0'),
        option_type: row.instrument_type,
        underlying_symbol: underlying,
        lot_size: parseInt(row.lot_size || '0', 10) || 0,
      });
    }

    // d. Explicitly ensure major Spot Indices are present with Correct IDs
    const spotIndices = [
        { id: 'NSE:NIFTY BANK', symbol: 'NIFTY BANK', name: 'BANKNIFTY', token: 260105, exchange: 'NSE' },
        { id: 'NSE:NIFTY 50', symbol: 'NIFTY 50', name: 'NIFTY', token: 256265, exchange: 'NSE' },
        { id: 'NSE:NIFTY FIN SERVICE', symbol: 'NIFTY FIN SERVICE', name: 'FINNIFTY', token: 257801, exchange: 'NSE' },
        { id: 'NSE:NIFTY MID SELECT', symbol: 'NIFTY MID SELECT', name: 'MIDCPNIFTY', token: 288009, exchange: 'NSE' },
        { id: 'BSE:SENSEX', symbol: 'SENSEX', name: 'SENSEX', token: 265, exchange: 'BSE' },
        { id: 'BSE:BANKEX', symbol: 'BANKEX', name: 'BANKEX', token: 271, exchange: 'BSE' },
    ];

    for (const s of spotIndices) {
        finalInstruments.push({
            id: s.id,
            instrument_token: s.token,
            tradingsymbol: s.symbol,
            name: s.name,
            exchange: s.exchange,
            instrument_type: 'INDEX',
            segment: 'INDICES',
            underlying_symbol: s.name,
            lot_size: 0
        });
    }

    // e. Sync Top 20 Binance Crypto Pairs
    let binanceCount = 0;
    try {
      console.log('[Sync Instruments] Fetching from Binance...');
      const binanceRes = await fetch('https://api.binance.com/api/v3/exchangeInfo');
      if (binanceRes.ok) {
        const binanceData = await binanceRes.json();
        const topCryptos = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'MATIC', 'DOT', 'LINK', 'SHIB', 'AVAX', 'TRX', 'UNI', 'ATOM', 'LTC', 'NEAR', 'APT', 'FIL', 'ARB'];
        const usdtPairs = binanceData.symbols.filter((s: any) => s.quoteAsset === 'USDT' && s.status === 'TRADING' && topCryptos.includes(s.baseAsset));
        
        for (const pair of usdtPairs) {
          finalInstruments.push({
            id: pair.symbol,
            instrument_token: 0,
            tradingsymbol: pair.symbol,
            name: pair.baseAsset,
            exchange: 'CRYPTO',
            instrument_type: 'CRYPTO',
            segment: 'CRYPTO',
            underlying_symbol: pair.baseAsset,
            lot_size: 0
          });
          finalInstruments.push({
            id: pair.baseAsset,
            instrument_token: 0,
            tradingsymbol: pair.baseAsset,
            name: pair.baseAsset,
            exchange: 'CRYPTO',
            instrument_type: 'CRYPTO',
            segment: 'CRYPTO',
            underlying_symbol: pair.baseAsset,
            lot_size: 0
          });
          binanceCount++;
        }
      }
    } catch (err) {
      console.error('[Sync Instruments] Binance Fetch Error:', err);
    }

    console.log(`[Sync Instruments] Found ${nseEquities.length} EQ/Indices, ${Object.keys(groups).length} Futures, ${options.length} Options, and ${binanceCount} Crypto pairs.`);

    // 5. Bulk Upsert to Supabase in parallel chunks of 300
    if (finalInstruments.length > 0) {
      const chunkSize = 300;
      const chunks: any[][] = [];
      for (let i = 0; i < finalInstruments.length; i += chunkSize) {
        chunks.push(finalInstruments.slice(i, i + chunkSize));
      }
      const queue = [...chunks];
      async function worker() {
        while (queue.length > 0) {
          const chunk = queue.shift();
          if (!chunk) break;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const { error } = await supabase.from('instruments').upsert(chunk, { onConflict: 'id' });
              if (error) throw error;
              break;
            } catch (err) {
              if (attempt === 2) console.error('[Sync Instruments] Chunk error:', err);
              else await new Promise(r => setTimeout(r, 400));
            }
          }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      console.log('[Sync Instruments] Successfully upserted all instruments.');
    }

    // Revalidate the library endpoint so cache is updated instantly
    revalidatePath('/api/market/instruments/library');

    try {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      await redis.del('market:library:segments');
    } catch (e) {
      console.error('[Sync Instruments] Redis delete cache error:', e);
    }

    return NextResponse.json({
      success: true,
      count: finalInstruments.length,
      counts: {
        equities: nseEquities.length,
        futures: Object.keys(groups).length,
        options: options.length
      },
      message: 'Instruments synced successfully',
    });
  } catch (error: any) {
    console.error('[Sync Instruments] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
