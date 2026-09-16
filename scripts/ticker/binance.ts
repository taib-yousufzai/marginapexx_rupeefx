import WebSocket from 'ws';
import pino from 'pino';
import { DbBatchWriter } from './dbWriter.ts';
import type { TickData } from './dbWriter.ts';
import { getAdminClient } from '../../lib/adminClient.ts';

// Default symbols — will be expanded with dynamic subscriptions from frontend requests
const DEFAULT_BINANCE_SYMBOLS = [
  'btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'xrpusdt', 'dogeusdt', 'adausdt', 'maticusdt',
  'paxgusdt', 'eurusdt', 'gbpusdt'
];

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds — detect stale connections
const STABLE_CONNECTION_MS  = 60_000; // Reset attempt counter after 60s stable

const logger = pino({ name: 'binance-ticker' });

/**
 * Parses a raw Binance combined-stream message string.
 * Returns `{ symbol, tickData }` for valid `24hrTicker` events, or `null` otherwise.
 * Exported as a pure function so it can be property-tested independently.
 */
export function parseBinanceTicker(raw: string): { symbol: string; tickData: TickData } | null {
  const payload = JSON.parse(raw);

  // Only handle 24hrTicker events from the combined stream
  if (payload.data?.e !== '24hrTicker') {
    return null;
  }

  const data = payload.data;
  const symbol: string = data.s;

  const tickData: TickData = {
    last_price: parseFloat(data.c),
    ohlc: {
      open:  parseFloat(data.o),
      high:  parseFloat(data.h),
      low:   parseFloat(data.l),
      close: parseFloat(data.x),
    },
    volume:    Math.round(parseFloat(data.v)),
    timestamp: new Date(),
    bid: parseFloat(data.b || data.c || '0'),
    ask: parseFloat(data.a || data.c || '0'),
  };

  return { symbol, tickData };
}

export class BinanceTicker {
  private dbWriter: DbBatchWriter;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopping = false;
  private isConnected = false;
  private activeSymbols: Set<string> = new Set(DEFAULT_BINANCE_SYMBOLS);

  constructor(dbWriter: DbBatchWriter) {
    this.dbWriter = dbWriter;
  }

  public start(): void {
    if (!this.ws) {
      this.ensureInstrumentsExist()
        .catch((err) => {
          logger.warn({ err }, 'ensureInstrumentsExist failed — proceeding to connect anyway');
        })
        .finally(() => {
          this.connect();
        });
    }
  }

  /** Exposed for health endpoint reporting */
  public get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Add symbols to the active subscription list and reconnect if needed
   */
  public subscribe(symbols: string[]): void {
    const newSymbols = symbols.filter(s => !this.activeSymbols.has(s.toLowerCase()));
    if (newSymbols.length > 0) {
      newSymbols.forEach(s => this.activeSymbols.add(s.toLowerCase()));
      logger.info({ newSymbols }, 'Added crypto symbols to subscription list');
      // Reconnect to update the stream
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.reconnectSubscriptions();
      }
    }
  }

  private async ensureInstrumentsExist(): Promise<void> {
    const admin = getAdminClient();
    // Comprehensive list of common crypto symbols
    const symbols = Array.from(this.activeSymbols).map(s => s.toUpperCase().replace('USDT', ''));
    if (!symbols.includes('DODGE')) symbols.push('DODGE');
    if (!symbols.includes('DODGEUSDT')) symbols.push('DODGEUSDT');
    const rows = symbols.map(sym => ({
      id: sym,
      instrument_token: 0,
      tradingsymbol: sym,
      exchange: 'CRYPTO',
      instrument_type: 'CRYPTO',
      segment: 'CRYPTO',
      updated_at: new Date().toISOString()
    }));

    try {
      const { error } = await admin
        .from('instruments')
        .upsert(rows, { onConflict: 'id' });
      if (error) {
        logger.error({ error }, 'Failed to upsert crypto instruments');
      } else {
        logger.info({ count: rows.length }, 'Ensured crypto instruments exist');
      }
    } catch (err) {
      logger.error({ err }, 'Error checking/upserting crypto instruments');
    }
  }

  public stop(): void {
    this.stopping = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer);  this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.stableTimer)    { clearTimeout(this.stableTimer);     this.stableTimer    = null; }
  }

  private buildStreamUrl(): string {
    const streams = Array.from(this.activeSymbols)
      .map(s => `${s.toLowerCase()}@ticker`)
      .join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
  }

  private reconnectSubscriptions(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      this.ws = null;
      this.clearTimers();
      // Reconnect with new subscription list
      setTimeout(() => this.connect(), 500);
    }
  }

  private connect(): void {
    const url = this.buildStreamUrl();
    logger.info({ url: url.substring(0, 100) + '...' }, 'Connecting to Binance WebSocket');
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.isConnected = true;
      logger.info({ symbolCount: this.activeSymbols.size }, 'Connected to Binance WebSocket');

      // Reset attempt counter after a stable 60-second connection.
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
        logger.debug('Binance connection stable — reset reconnect attempt counter');
      }, STABLE_CONNECTION_MS);

      // Heartbeat: send a ping every 30s
      let pongReceived = true;
      this.heartbeatTimer = setInterval(() => {
        if (!pongReceived) {
          logger.warn('Binance WebSocket missed pong — terminating stale connection');
          this.ws?.terminate();
          return;
        }
        pongReceived = false;
        this.ws?.ping();
      }, HEARTBEAT_INTERVAL_MS);

      this.ws!.on('pong', () => {
        pongReceived = true;
      });
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('error', (err) => {
      logger.error({ err }, 'Binance WebSocket error');
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      this.clearTimers();
      if (!this.stopping) {
        logger.warn('Disconnected from Binance — scheduling reconnect');
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.attempt++;
    const delay = Math.min(this.attempt * 1000, 30_000); // cap at 30s
    logger.info({ delay, attempt: this.attempt }, 'Scheduling Binance WebSocket reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private handleMessage(raw: string): void {
    try {
      const result = parseBinanceTicker(raw);
      if (result === null) return;

      // Upsert standard symbol (e.g. ETHUSDT)
      this.dbWriter.addTick(result.symbol, result.tickData);

      // Upsert short symbol (e.g. ETH) so orders using abbreviated symbols match
      const shortSymbol = result.symbol.replace('USDT', '');
      this.dbWriter.addTick(shortSymbol, result.tickData);
      if (shortSymbol === 'DOGE') {
        this.dbWriter.addTick('DODGE', result.tickData);
        this.dbWriter.addTick('DODGEUSDT', result.tickData);
      }
    } catch (err) {
      logger.warn({ err, raw }, 'Failed to parse Binance stream message');
    }
  }
}
