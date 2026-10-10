import { getAdminClient } from '../../lib/adminClient.ts';
import pino from 'pino';

const logger = pino({ name: 'candle-aggregator' });

export interface Candle {
  symbol: string;
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  periodStart: number;
  startVolume?: number; // Tracks starting cumulative volume for the period
}

const INTERVAL_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

export class CandleAggregator {
  // Map of symbol -> interval -> Candle
  private activeCandles: Map<string, Map<string, Candle>> = new Map();
  private pendingCandles: Candle[] = [];
  private flushInterval: NodeJS.Timeout;

  constructor() {
    // Flush completed candles every 5 seconds to batch DB writes and prevent log spam
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  /**
   * Processes a tick to update or complete candles across intervals.
   */
  public async addTick(symbol: string, price: number, volume: number | null, timestamp: Date) {
    const timeMs = timestamp.getTime();

    if (!this.activeCandles.has(symbol)) {
      this.activeCandles.set(symbol, new Map());
    }

    const symbolCandles = this.activeCandles.get(symbol)!;
    const completedCandles: Candle[] = [];

    for (const [interval, ms] of Object.entries(INTERVAL_MS)) {
      const periodStart = Math.floor(timeMs / ms) * ms;
      const currentCandle = symbolCandles.get(interval);

      if (!currentCandle) {
        // First candle for this symbol and interval
        symbolCandles.set(interval, {
          symbol,
          interval,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          periodStart,
          startVolume: volume !== null ? volume : undefined,
        });
      } else if (periodStart > currentCandle.periodStart) {
        // Candle interval is complete!
        completedCandles.push({ ...currentCandle });

        // Start new candle
        symbolCandles.set(interval, {
          symbol,
          interval,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          periodStart,
          startVolume: volume !== null ? volume : undefined,
        });
      } else {
        // Update current candle
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low = Math.min(currentCandle.low, price);
        currentCandle.close = price;

        if (volume !== null && currentCandle.startVolume !== undefined) {
          // Compute incremental volume from cumulative volume
          currentCandle.volume = Math.max(0, volume - currentCandle.startVolume);
        } else if (volume !== null) {
          // If no startVolume, treat as incremental
          currentCandle.volume += volume;
        }
      }
    }

    if (completedCandles.length > 0) {
      this.pendingCandles.push(...completedCandles);
    }
  }

  /**
   * Flushes any pending completed candles to Supabase in a single batch.
   */
  private async flush() {
    if (this.pendingCandles.length === 0) return;
    
    const candlesToSave = [...this.pendingCandles];
    this.pendingCandles = []; // Clear queue immediately
    
    await this.saveCandles(candlesToSave);
  }

  /**
   * Stops the periodic flusher and persists any remaining candles.
   */
  public stop() {
    clearInterval(this.flushInterval);
    this.flush();
  }

  /**
   * Persists completed candles to Railway Postgres (first) or Supabase (fallback).
   */
  private async saveCandles(candles: Candle[]) {
    const rows = candles.map(c => ({
      symbol: c.symbol,
      timestamp: new Date(c.periodStart).toISOString(),
      interval: c.interval,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    // 1. Try persisting to Railway Postgres first
    try {
      const { isRailwayDbConfigured, persistCandlesToRailway } = await import('../../lib/railway-db');
      if (isRailwayDbConfigured()) {
        const ok = await persistCandlesToRailway(rows);
        if (ok) {
          logger.info({ count: rows.length }, 'Persisted completed candles to Railway Postgres');
          return;
        }
      }
    } catch (railwayErr: any) {
      logger.warn({ err: railwayErr?.message }, 'Railway candle persistence failed, falling back to Supabase');
    }

    // 2. Fallback to Supabase
    const admin = getAdminClient();
    try {
      logger.info({ count: rows.length }, 'Persisting completed candles to Supabase');
      const { error } = await admin
        .from('historical_candles')
        .upsert(rows, { onConflict: 'symbol,timestamp,interval' });

      if (error) {
        logger.error({ error }, 'Failed to persist candles to historical_candles');
      }
    } catch (err) {
      logger.error({ err }, 'Error writing candles to Supabase');
    }
  }
}
