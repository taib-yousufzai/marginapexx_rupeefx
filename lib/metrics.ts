import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { getRedisClient, isRedisMock, getRedisHealthStatus } from './redis.ts';

const logger = pino({ name: 'telemetry-registry' });

export interface SystemAlert {
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  timestamp: string;
}

class TelemetryRegistry {
  // Market Data
  public ticks_received_total = 0;
  public ticks_processed_total = 0;
  public tick_processing_latency_ms: number[] = [];
  
  // Quote cache hit rate tracking
  public quote_lookups_total = 0;
  public quote_redis_hits = 0;
  public quote_daemon_hits = 0;
  public quote_misses = 0;
  public quote_lookup_durations_ms: number[] = [];

  // Matching Engine
  public orders_evaluated_total = 0;
  public positions_evaluated_total = 0;
  public matching_latency_ms: number[] = [];
  public trigger_execution_latency_ms: number[] = [];

  // WebSockets
  public active_connections = 0;
  public active_subscriptions = 0;
  public messages_sent_total = 0;
  public messages_received_total = 0;

  // APIs
  public api_requests_total = 0;
  public api_errors_total = 0;
  public api_latencies: Record<string, number[]> = {};

  // Database
  public db_reads_total = 0;
  public db_writes_total = 0;
  public db_query_durations_ms: number[] = [];

  // Kite Session
  public kite_session_valid = false;
  public kite_session_expires_at: Date | null = null;
  public kite_minutes_until_expiry: number | null = null;
  public kite_last_successful_login: Date | null = null;
  public kite_last_login_attempt: Date | null = null;
  public kite_last_login_failure: Date | null = null;
  public kite_consecutive_failures = 0;

  // Alerts
  public alerts: SystemAlert[] = [];

  private maxWindowSize = 100; // Limit sliding arrays to prevent memory leaks

  private addLatency(target: number[], val: number) {
    target.push(val);
    if (target.length > this.maxWindowSize) {
      target.shift();
    }
  }

  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sum = arr.reduce((a, b) => a + b, 0);
    return parseFloat((sum / arr.length).toFixed(2));
  }

  public recordTickReceived(count = 1) {
    this.ticks_received_total += count;
  }

  public recordQuoteLookup(redisHits: number, daemonHits: number, misses: number, latencyMs = 0) {
    this.quote_lookups_total += (redisHits + daemonHits + misses);
    this.quote_redis_hits += redisHits;
    this.quote_daemon_hits += daemonHits;
    this.quote_misses += misses;
    this.addLatency(this.quote_lookup_durations_ms, latencyMs);
  }

  public recordTickProcessed(count = 1, latencyMs = 0) {
    this.ticks_processed_total += count;
    this.addLatency(this.tick_processing_latency_ms, latencyMs);

    // Warning alert for slow tick processing
    if (latencyMs > 500) {
      this.triggerAlert('WARNING', `Slow tick processing batch: ${latencyMs.toFixed(1)}ms`);
    }
  }

  public recordMatchingEngine(ordersChecked: number, positionsChecked: number, latencyMs = 0) {
    this.orders_evaluated_total += ordersChecked;
    this.positions_evaluated_total += positionsChecked;
    this.addLatency(this.matching_latency_ms, latencyMs);

    // Critical Alert for high matching latency
    if (latencyMs > 300) {
      this.triggerAlert('WARNING', `High matching engine evaluation latency: ${latencyMs.toFixed(1)}ms`);
    }
  }

  public recordTriggerExecution(latencyMs = 0) {
    this.addLatency(this.trigger_execution_latency_ms, latencyMs);
    if (latencyMs > 1000) {
      this.triggerAlert('CRITICAL', `Slow order/position execution update: ${latencyMs.toFixed(1)}ms`);
    }
  }

  public recordWsConnectionChange(active: number) {
    this.active_connections = active;
  }

  public recordWsSubscription(count: number) {
    this.active_subscriptions = count;
  }

  public recordWsMessageSent() {
    this.messages_sent_total++;
  }

  public recordWsMessageReceived() {
    this.messages_received_total++;
  }

  public recordDbCall(type: 'read' | 'write', durationMs = 0) {
    if (type === 'read') {
      this.db_reads_total++;
    } else {
      this.db_writes_total++;
    }
    this.addLatency(this.db_query_durations_ms, durationMs);

    if (durationMs > 200) {
      this.triggerAlert('WARNING', `Slow DB query (${type}): ${durationMs.toFixed(1)}ms`);
    }
  }

  public recordApiCall(path: string, durationMs = 0, success = true) {
    this.api_requests_total++;
    if (!success) {
      this.api_errors_total++;
      this.triggerAlert('WARNING', `API Error encountered on path ${path}`);
    }

    if (!this.api_latencies[path]) {
      this.api_latencies[path] = [];
    }
    this.addLatency(this.api_latencies[path], durationMs);

    if (durationMs > 1500) {
      this.triggerAlert('WARNING', `Slow API response on ${path}: ${durationMs.toFixed(1)}ms`);
    }
  }

  /**
   * Called by KiteSessionMonitor to update session health status and
   * generate operational alerts for the /health endpoint and diagnostics page.
   */
  public recordKiteSessionStatus(
    valid: boolean,
    expiresAt: Date | null,
    minutesLeft: number | null,
    lastSuccess: Date | null,
    lastAttempt: Date | null,
    lastFailure: Date | null,
    consecutiveFailures: number,
  ) {
    this.kite_session_valid = valid;
    this.kite_session_expires_at = expiresAt;
    this.kite_minutes_until_expiry = minutesLeft;
    this.kite_last_successful_login = lastSuccess;
    this.kite_last_login_attempt = lastAttempt;
    this.kite_last_login_failure = lastFailure;
    this.kite_consecutive_failures = consecutiveFailures;

    // Deduplicate alerts — only fire once per unique state transition, not on every
    // 30-second telemetry tick. Compare against the last alert message we stored.
    const lastAlert = this.alerts[0];
    const isDuplicate = (msg: string) => lastAlert?.message === msg;

    if (minutesLeft !== null && minutesLeft <= 0) {
      const msg = 'Kite session has EXPIRED. Indian equity feed is offline.';
      if (!isDuplicate(msg)) this.triggerAlert('CRITICAL', msg);
    } else if (minutesLeft !== null && minutesLeft <= 60) {
      const msg = `Kite session expires in ${minutesLeft} minutes. Auto-login pending.`;
      if (!isDuplicate(msg)) this.triggerAlert('WARNING', msg);
    }

    if (consecutiveFailures >= 3) {
      const msg = `Kite auto-login has failed ${consecutiveFailures} times consecutively. Manual intervention may be required.`;
      if (!isDuplicate(msg)) this.triggerAlert('CRITICAL', msg);
    } else if (lastFailure && consecutiveFailures > 0) {
      const msg = `Kite auto-login failed (attempt ${consecutiveFailures}). Retrying in 3 minutes.`;
      if (!isDuplicate(msg)) this.triggerAlert('WARNING', msg);
    }
  }

  public triggerAlert(level: 'INFO' | 'WARNING' | 'CRITICAL', message: string) {
    const alert: SystemAlert = {
      level,
      message,
      timestamp: new Date().toISOString()
    };
    
    // Log structured alert log
    logger.warn({ alert }, `[SYSTEM_ALERT] [${level}] ${message}`);

    this.alerts.unshift(alert);
    if (this.alerts.length > 50) {
      this.alerts.pop();
    }
  }

  public getSummary() {
    const apiSummary: Record<string, number> = {};
    for (const [path, latencies] of Object.entries(this.api_latencies)) {
      apiSummary[path] = this.average(latencies);
    }

    return {
      marketData: {
        ticksReceived: this.ticks_received_total,
        ticksProcessed: this.ticks_processed_total,
        avgProcessingLatencyMs: this.average(this.tick_processing_latency_ms),
        quoteLookupsTotal: this.quote_lookups_total,
        quoteRedisHits: this.quote_redis_hits,
        quoteDaemonHits: this.quote_daemon_hits,
        quoteMisses: this.quote_misses,
        avgQuoteLookupLatencyMs: this.average(this.quote_lookup_durations_ms),
      },
      matchingEngine: {
        ordersEvaluated: this.orders_evaluated_total,
        positionsEvaluated: this.positions_evaluated_total,
        avgMatchingLatencyMs: this.average(this.matching_latency_ms),
        avgTriggerExecutionLatencyMs: this.average(this.trigger_execution_latency_ms)
      },
      webSockets: {
        activeConnections: this.active_connections,
        activeSubscriptions: this.active_subscriptions,
        messagesSent: this.messages_sent_total,
        messagesReceived: this.messages_received_total,
      },
      apis: {
        requestsTotal: this.api_requests_total,
        errorsTotal: this.api_errors_total,
        errorRatePercent: this.api_requests_total > 0 
          ? parseFloat(((this.api_errors_total / this.api_requests_total) * 100).toFixed(2))
          : 0,
        endpointsAvgLatencyMs: apiSummary
      },
      database: {
        readsTotal: this.db_reads_total,
        writesTotal: this.db_writes_total,
        avgQueryLatencyMs: this.average(this.db_query_durations_ms)
      },
      kiteSession: {
        valid: this.kite_session_valid,
        expiresAt: this.kite_session_expires_at?.toISOString() ?? null,
        minutesUntilExpiry: this.kite_minutes_until_expiry,
        lastSuccessfulLogin: this.kite_last_successful_login?.toISOString() ?? null,
        lastLoginAttempt: this.kite_last_login_attempt?.toISOString() ?? null,
        lastLoginFailure: this.kite_last_login_failure?.toISOString() ?? null,
        consecutiveFailures: this.kite_consecutive_failures,
      },
      valkey: getRedisHealthStatus(),
      alerts: this.alerts
    };
  }

  public async persistSummary() {
    const summary = this.getSummary();
    const summaryStr = JSON.stringify(summary);

    try {
      const redis = getRedisClient();
      await redis.set('metrics:summary', summaryStr);
    } catch (err) {
      logger.error({ err }, 'Failed to persist summary to Redis');
    }

    if (isRedisMock()) {
      try {
        const filepath = path.join(process.cwd(), '.next-metrics-summary.json');
        fs.writeFileSync(filepath, summaryStr, 'utf8');
      } catch (err) {
        logger.error({ err }, 'Failed to write fallback metrics file');
      }
    }
  }

  public async getPersistedSummary() {
    try {
      const redis = getRedisClient();
      const summaryStr = await redis.get('metrics:summary');
      if (summaryStr) {
        return JSON.parse(summaryStr);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to retrieve metrics from Redis');
    }

    if (isRedisMock()) {
      try {
        const filepath = path.join(process.cwd(), '.next-metrics-summary.json');
        if (fs.existsSync(filepath)) {
          const content = fs.readFileSync(filepath, 'utf8');
          return JSON.parse(content);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to read fallback metrics file');
      }
    }

    return this.getSummary();
  }
}

// Global Registry Singleton
// Use global object to survive hot reloading in Next.js development
const globalKey = Symbol.for('marginapexx.telemetry');
const globalObject = global as any;

if (!globalObject[globalKey] || typeof globalObject[globalKey].getPersistedSummary !== 'function') {
  globalObject[globalKey] = new TelemetryRegistry();
}

export const telemetry = globalObject[globalKey] as TelemetryRegistry;
