import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const interval = searchParams.get('interval') || '5m';
    const limit = searchParams.get('limit') || '500';

    const startTime = searchParams.get('startTime');
    const endTime = searchParams.get('endTime');

    if (!symbol) {
      return NextResponse.json({ error: 'Missing required parameter: symbol' }, { status: 400 });
    }

    let binanceSymbol = symbol.replace('/', '');
    if (!binanceSymbol.endsWith('USDT')) {
      binanceSymbol += 'USDT';
    }

    const endpoints = [
      'https://data-api.binance.vision',
      'https://api.binance.com',
      'https://api1.binance.com',
      'https://api2.binance.com',
      'https://api3.binance.com',
    ];

    let lastError: any = null;
    for (const base of endpoints) {
      try {
        let url = `${base}/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
        if (startTime) url += `&startTime=${startTime}`;
        if (endTime) url += `&endTime=${endTime}`;

        const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
        if (!response.ok) continue;

        const json = await response.json();
        if (Array.isArray(json) && json.length > 0) {
          return NextResponse.json(json);
        }
      } catch (e: any) {
        lastError = e;
      }
    }

    return NextResponse.json({ error: lastError?.message || 'Failed to fetch from Binance' }, { status: 502 });

  } catch (error: any) {
    console.error('Crypto Historical API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error', message: error.message }, { status: 500 });
  }
}
