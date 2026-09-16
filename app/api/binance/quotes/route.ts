import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/binance/quotes?symbols=BTCUSDT,ETHUSDT
 * Returns latest Binance 24hr ticker data for crypto symbols
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawSymbols = searchParams.get('symbols')?.split(',') || [];

  const symbols = rawSymbols
    .map(s => {
      let sym = s.trim().toUpperCase();
      if (sym === 'DODGE' || sym === 'DODGEUSDT') return 'DOGEUSDT';
      return sym.endsWith('USDT') ? sym : `${sym}USDT`;
    })
    .filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
  }

  try {
    const quotes: Record<string, any> = {};
    const uniqueSymbols = Array.from(new Set(symbols));
    const symbolsParam = JSON.stringify(uniqueSymbols);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let fetchOk = false;
    let resData: any = null;

    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (res.ok) {
        resData = await res.json();
        fetchOk = true;
      }
    } catch {
      fetchOk = false;
    }

    if (fetchOk && Array.isArray(resData)) {
      resData.forEach((item: any) => {
        if (item && item.symbol) {
          const lp = parseFloat(item.lastPrice || '0');
          const quote = {
            symbol: item.symbol,
            lastPrice: lp,
            prevClosePrice: parseFloat(item.prevClosePrice || item.openPrice || '0'),
            openPrice: parseFloat(item.openPrice || '0'),
            highPrice: parseFloat(item.highPrice || '0'),
            lowPrice: parseFloat(item.lowPrice || '0'),
            volume: parseFloat(item.volume || '0'),
            time: item.closeTime || Date.now(),
            bid: lp,
            ask: lp,
          };
          quotes[item.symbol] = quote;
          const shortSymbol = item.symbol.replace('USDT', '');
          quotes[shortSymbol] = quote;
          if (item.symbol === 'DOGEUSDT') {
            quotes['DODGE'] = quote;
            quotes['DODGEUSDT'] = quote;
          }
        }
      });
    } else {
      // Fallback: fetch symbols individually so invalid symbols don't break valid ones
      await Promise.allSettled(
        uniqueSymbols.map(async (sym) => {
          try {
            const singleRes = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`, {
              cache: 'no-store',
            });
            if (singleRes.ok) {
              const item = await singleRes.json();
              if (item && item.symbol) {
                const lp = parseFloat(item.lastPrice || '0');
                const quote = {
                  symbol: item.symbol,
                  lastPrice: lp,
                  prevClosePrice: parseFloat(item.prevClosePrice || item.openPrice || '0'),
                  openPrice: parseFloat(item.openPrice || '0'),
                  highPrice: parseFloat(item.highPrice || '0'),
                  lowPrice: parseFloat(item.lowPrice || '0'),
                  volume: parseFloat(item.volume || '0'),
                  time: item.closeTime || Date.now(),
                  bid: lp,
                  ask: lp,
                };
                quotes[item.symbol] = quote;
                const shortSymbol = item.symbol.replace('USDT', '');
                quotes[shortSymbol] = quote;
                if (item.symbol === 'DOGEUSDT') {
                  quotes['DODGE'] = quote;
                  quotes['DODGEUSDT'] = quote;
                }
              }
            }
          } catch {
            // Ignore individual symbol fetch errors
          }
        })
      );
    }

    return NextResponse.json({ success: true, data: quotes });
  } catch (err) {
    console.error('[GET /api/binance/quotes] Error:', err);
    return NextResponse.json(
      { success: true, data: {} }
    );
  }
}

