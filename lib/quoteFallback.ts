/**
 * Shared Realistic Fallback Quote Generator
 * Generates symbol-specific, CE vs PE distinct, deterministic synthetic quotes
 * when real exchange data is unavailable.
 */

import { getUSStockBasePrice, US_BASE_PRICES, FOREX_BASE_PRICES } from './datafeed/USStockService';

export interface FallbackQuote {
  timestamp: string;
  last_price: number;
  volume: number;
  ohlc: { open: number; high: number; low: number; close: number };
  net_change: number;
  changePercent: number;
  bid: number;
  ask: number;
}

export function generateRealisticFallbackQuote(symbolKey: string): FallbackQuote {
  if (!symbolKey) {
    return {
      timestamp: new Date().toISOString(),
      last_price: 15.2,
      volume: 1250,
      ohlc: { open: 14.9, high: 15.8, low: 14.5, close: 15.0 },
      net_change: 0.2,
      changePercent: 1.33,
      bid: 15.1,
      ask: 15.3,
    };
  }

  const clean = symbolKey.toUpperCase().replace(/^(NFO|NSE|BSE|MCX|CRYPTO|FOREX|US|CDS):/, '').trim();
  const cleanUnslashed = clean.replace(/\//g, '');
  const cleanBase = cleanUnslashed.replace(/(=[FX]|\.X)$/i, '').replace(/(\d{2}[A-Z]{3}FUT)$/i, '');
  const isCall = clean.endsWith('CE');
  const isPut = clean.endsWith('PE');
  const isFut = clean.endsWith('FUT');

  // Simple string hash function for deterministic variance
  let hash = 0;
  for (let i = 0; i < symbolKey.length; i++) {
    hash = ((hash << 5) - hash) + symbolKey.charCodeAt(i);
    hash |= 0;
  }
  const posHash = Math.abs(hash);

  // Extract strike or numerical value
  let strike = 0;
  const match = clean.match(/(\d+)(CE|PE|FUT)?$/);
  if (match && match[1]) {
    strike = parseFloat(match[1]);
  }

  let basePrice = 15.2;

  const isUSStock = Boolean(US_BASE_PRICES[clean] || US_BASE_PRICES[cleanBase] || symbolKey.toUpperCase().startsWith('US:'));
  const isForex = Boolean(
    FOREX_BASE_PRICES[clean] ||
    FOREX_BASE_PRICES[cleanUnslashed] ||
    FOREX_BASE_PRICES[cleanBase] ||
    symbolKey.toUpperCase().startsWith('FOREX:') ||
    symbolKey.toUpperCase().startsWith('CDS:') ||
    ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD', 'USDINR', 'EURINR', 'GBPINR', 'JPYINR'].some(f => cleanBase.includes(f))
  );
  const isCrypto = Boolean(
    clean.endsWith('USDT') ||
    cleanBase.endsWith('USDT') ||
    symbolKey.toUpperCase().startsWith('CRYPTO:') ||
    symbolKey.toUpperCase().startsWith('BINANCE:') ||
    ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].some(c => cleanBase === c || cleanBase.startsWith(c + 'USDT'))
  );

  if (isUSStock) {
    basePrice = getUSStockBasePrice(clean);
  } else if (isForex) {
    basePrice = FOREX_BASE_PRICES[cleanBase] || FOREX_BASE_PRICES[cleanUnslashed] || FOREX_BASE_PRICES[clean] || getUSStockBasePrice(clean);
  } else if (isCrypto) {
    basePrice = getUSStockBasePrice(clean);
  } else if (strike > 0) {
    if (isCall) {
      // Call options: premium factor varies between 1.5% and 3.5% of strike
      const factor = 0.015 + ((posHash % 20) * 0.001);
      basePrice = Number((strike * factor).toFixed(2)) || 14.5;
    } else if (isPut) {
      // Put options: premium factor varies between 1.0% and 3.0% of strike
      const factor = 0.010 + (((posHash + 7) % 20) * 0.001);
      basePrice = Number((strike * factor).toFixed(2)) || 12.5;
    } else if (isFut) {
      basePrice = Number(strike.toFixed(2));
    } else {
      if (strike <= 100) basePrice = Number((strike * 0.12).toFixed(2)) || 4.5;
      else if (strike <= 500) basePrice = Number((strike * 0.05).toFixed(2)) || 12.5;
      else if (strike <= 2000) basePrice = Number((strike * 0.02).toFixed(2)) || 24.5;
      else basePrice = Number((strike * 0.01).toFixed(2)) || 35.0;
    }
  } else {
    // Non-numeric symbol (e.g. underlying stock/crypto)
    basePrice = 50 + (posHash % 450);
  }

  const decimals = basePrice < 10 ? 4 : 2;

  // Deterministic percentage change ranging from -4.5% to +4.5%
  // Call and Put on same strike get OPPOSITE signs so Call is up while Put is down (or vice versa)!
  let rawChangePct = 0;
  if (isUSStock) {
    rawChangePct = 0;
  } else if (isCall) {
    rawChangePct = ((posHash % 700) - 280) / 100; // e.g. +1.45% or -1.80%
  } else if (isPut) {
    rawChangePct = -(((posHash + 13) % 700) - 280) / 100; // Inverse movement relative to Call
  } else {
    rawChangePct = (((posHash * 7) % 600) - 280) / 100;
  }

  if (Math.abs(rawChangePct) < 0.1) rawChangePct = rawChangePct >= 0 ? 0.85 : -0.85;
  const changePercent = Number(rawChangePct.toFixed(2));

  // Calculate close price based on last_price and changePercent
  const close = Number((basePrice / (1 + changePercent / 100)).toFixed(decimals));
  const net_change = Number((basePrice - close).toFixed(decimals));
  const open = Number((close * (1 + ((posHash % 40) - 20) / 1000)).toFixed(decimals));
  const high = Number((Math.max(basePrice, close) * 1.005).toFixed(decimals));
  const low = Number((Math.min(basePrice, close) * 0.995).toFixed(decimals));
  const volume = 1000 + (posHash % 15000);

  const bid = Number((basePrice * 0.9995).toFixed(decimals));
  const ask = Number((basePrice * 1.0005).toFixed(decimals));

  return {
    timestamp: new Date().toISOString(),
    last_price: basePrice,
    volume,
    ohlc: { open, high, low, close },
    net_change,
    changePercent,
    bid,
    ask,
  };
}
