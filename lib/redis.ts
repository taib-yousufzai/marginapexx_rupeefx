import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'redis-client' });

// Simple In-Memory Mock Redis for graceful fallback
class MockRedis {
  private store: Map<string, any> = new Map();
  private listeners: Map<string, Set<(channel: string, message: string) => void>> = new Map();

  public async get(key: string): Promise<string | null> {
    const val = this.store.get(key);
    return typeof val === 'string' ? val : null;
  }

  public async set(key: string, value: string, ...args: any[]): Promise<'OK'> {
    this.store.set(key, value);
    
    // Simple EX support for mock
    if (args.length >= 2 && args[0] === 'EX') {
      setTimeout(() => {
        if (this.store.get(key) === value) this.store.delete(key);
      }, args[1] * 1000);
    }
    return 'OK';
  }

  public async setex(key: string, seconds: number, value: string): Promise<'OK'> {
    this.store.set(key, value);
    setTimeout(() => {
      if (this.store.get(key) === value) this.store.delete(key);
    }, seconds * 1000);
    return 'OK';
  }

  public async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.store.has(key)) {
      this.store.set(key, new Map());
    }
    const hash = this.store.get(key) as Map<string, string>;
    const isNew = !hash.has(field);
    hash.set(field, value);
    return isNew ? 1 : 0;
  }

  public async hget(key: string, field: string): Promise<string | null> {
    const hash = this.store.get(key);
    if (hash instanceof Map) {
      return hash.get(field) || null;
    }
    return null;
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.store.get(key);
    const result: Record<string, string> = {};
    if (hash instanceof Map) {
      for (const [k, v] of hash.entries()) {
        result[k] = v;
      }
    }
    return result;
  }

  public async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    const hash = this.store.get(key);
    if (hash instanceof Map) {
      return fields.map(f => hash.get(f) || null);
    }
    return fields.map(() => null);
  }

  private onMessageCallback: ((channel: string, message: string) => void) | null = null;

  public async publish(channel: string, message: string): Promise<number> {
    if (this.listeners.has(channel) && this.onMessageCallback) {
      this.onMessageCallback(channel, message);
      return 1;
    }
    return 0;
  }

  public async subscribe(channel: string): Promise<'OK'> {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    return 'OK';
  }

  public on(event: string, callback: (...args: any[]) => void) {
    if (event === 'message') {
      this.onMessageCallback = callback;
    }
  }

  public async incr(key: string): Promise<number> {
    const val = this.store.get(key);
    const current = parseInt(typeof val === 'string' ? val : '0', 10);
    const next = isNaN(current) ? 1 : current + 1;
    this.store.set(key, String(next));
    return next;
  }

  public async incrby(key: string, increment: number): Promise<number> {
    const val = this.store.get(key);
    const current = parseInt(typeof val === 'string' ? val : '0', 10);
    const next = (isNaN(current) ? 0 : current) + increment;
    this.store.set(key, String(next));
    return next;
  }

  public async decr(key: string): Promise<number> {
    const val = this.store.get(key);
    const current = parseInt(typeof val === 'string' ? val : '0', 10);
    const next = (isNaN(current) ? 0 : current) - 1;
    this.store.set(key, String(next));
    return next;
  }

  public async expire(key: string, seconds: number): Promise<number> {
    if (!this.store.has(key)) return 0;
    setTimeout(() => {
      this.store.delete(key);
    }, seconds * 1000);
    return 1;
  }

  public async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const matched: string[] = [];
    for (const k of this.store.keys()) {
      if (regex.test(k)) matched.push(k);
    }
    return matched;
  }

  public async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const k of keys) {
      if (this.store.delete(k)) deleted++;
    }
    return deleted;
  }

  public async ttl(key: string): Promise<number> {
    return this.store.has(key) ? 600 : -2;
  }

  public async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  public quit() {
    this.store.clear();
    this.listeners.clear();
  }

  // To support duplicate() for creating separate subscription connections
  public duplicate() {
    return this;
  }
}

const redisUrl = process.env.REDIS_URL;
const globalForRedis = globalThis as unknown as {
  realClient: Redis | undefined;
};

let realClient: any = null;
const mockClient = new MockRedis();
let isMock = !redisUrl;

let lastLatencyMs = 0;
let lastReconnectAt: Date | null = null;
let reconnectCount = 0;
let pubSubClient: any = null;
let pubSubReconnectCount = 0;

if (redisUrl) {
  try {
    if (!globalForRedis.realClient) {
      logger.info('Connecting to Valkey/Redis instance...');
      globalForRedis.realClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        connectTimeout: 2000,
        retryStrategy(times) {
          reconnectCount++;
          lastReconnectAt = new Date();
          logger.warn({ times }, 'Valkey command client reconnecting...');
          return Math.min(times * 100, 2000);
        }
      });

      globalForRedis.realClient.on('error', (err: any) => {
        logger.error({ err }, 'Valkey command client connection error');
      });

      globalForRedis.realClient.on('connect', () => {
        logger.info('Valkey command client connected successfully.');
      });
    }
    realClient = globalForRedis.realClient;
  } catch (err) {
    logger.error({ err }, 'Could not initialize Valkey client. Falling back to Mock.');
    isMock = true;
  }
} else {
  logger.info('No REDIS_URL configured. Using in-memory MockRedis.');
}

// Proxy client to transparently route commands with a 500ms safety timeout
const redisProxyClient = new Proxy({}, {
  get(target, propKey) {
    const isReady = realClient && realClient.status === 'ready';
    const activeClient = isReady ? realClient : mockClient;
    const prop = (activeClient as any)[propKey] || (mockClient as any)[propKey];
    if (typeof prop === 'function') {
      return function (...args: any[]) {
        try {
          const targetClient = (isReady && typeof (realClient as any)[propKey] === 'function') ? realClient : mockClient;
          const fn = (targetClient as any)[propKey] || (mockClient as any)[propKey];
          if (typeof fn !== 'function') return Promise.resolve(null);
          const res = fn.apply(targetClient, args);
          if (res && typeof res.then === 'function') {
            return Promise.race([
              res,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Redis command timeout (1500ms)')), 1500))
            ]).catch((err) => {
              if (process.env.NODE_ENV === 'development') {
                logger.warn({ err: err?.message || err, command: String(propKey) }, 'Redis command timed out/failed, falling back to mock');
              }
              const mockProp = (mockClient as any)[propKey];
              if (typeof mockProp === 'function') {
                return mockProp.apply(mockClient, args);
              }
              return null;
            });
          }
          return res;
        } catch {
          return null;
        }
      };
    }
    return function () {
      return Promise.resolve(null);
    };
  }
});

// Periodic latency monitoring
async function measureLatency() {
  if (isMock || !realClient || realClient.status !== 'ready') {
    lastLatencyMs = 0;
    return;
  }
  try {
    const start = performance.now();
    await realClient.ping();
    lastLatencyMs = Math.round(performance.now() - start);
  } catch (err) {
    logger.warn({ err }, 'Failed to measure latency to Valkey');
    lastLatencyMs = 0;
  }
}
setInterval(measureLatency, 10000);

export function getRedisClient(): any {
  return redisProxyClient;
}

export function createRedisPubSubClient() {
  if (isMock) {
    return mockClient;
  }
  const client = new Redis(redisUrl || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      pubSubReconnectCount++;
      lastReconnectAt = new Date();
      logger.warn({ times }, 'Valkey Pub/Sub client reconnecting...');
      return Math.min(times * 100, 2000);
    }
  });

  pubSubClient = client;

  client.on('error', (err: any) => {
    logger.error({ err }, 'Valkey Pub/Sub client connection error');
  });

  client.on('connect', () => {
    logger.info('Valkey Pub/Sub client connected successfully.');
  });

  return client;
}

export function isRedisMock() {
  return isMock || !realClient || realClient.status !== 'ready';
}

export function getRedisHealthStatus() {
  const isCmdReady = realClient && realClient.status === 'ready';
  const isPubSubReady = pubSubClient ? pubSubClient.status === 'ready' : isCmdReady;

  return {
    valkeyConnected: isMock ? false : !!isCmdReady,
    valkeyLatencyMs: lastLatencyMs,
    pubSubConnected: isMock ? false : !!isPubSubReady,
    lastReconnect: lastReconnectAt ? lastReconnectAt.toISOString() : null,
    reconnectCount: reconnectCount + pubSubReconnectCount
  };
}
