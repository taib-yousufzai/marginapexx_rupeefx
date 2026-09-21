import { getRedisClient } from '../../lib/redis.ts';
import { getAdminClient } from '../../lib/adminClient.ts';
import pino from 'pino';
import crypto from 'crypto';
import type { TickData } from './dbWriter.ts';

const logger = pino({ name: 'order-engine' });

export interface FastOrderRequest {
  id?: string;
  user_id: string;
  symbol: string;
  kite_instrument?: string;
  segment: string;
  side: 'BUY' | 'SELL';
  order_type?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M' | 'GTT';
  product_type?: 'NRML' | 'MIS' | 'CNC' | 'INTRADAY';
  qty: number;
  lots?: number;
  client_price?: number;
  trigger_price?: number;
  stop_loss?: number;
  target?: number;
  is_exit?: boolean;
  linked_position_id?: string;
  orderAttemptId?: string;
  client_click_time?: number;
}

export interface FastOrderResult {
  success: boolean;
  orderId?: string;
  status: 'EXECUTED' | 'PENDING' | 'REJECTED';
  fill_price?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  execution_latency_ms: number;
  error?: string;
}

export class OrderEngine {
  private redis: any;
  private quoteCache: Map<string, TickData>;

  constructor(quoteCache: Map<string, TickData>) {
    this.redis = getRedisClient();
    this.quoteCache = quoteCache;
  }

  /**
   * Fast In-Memory Quote Resolution (< 0.1ms)
   */
  public getLatestQuote(symbol: string, kiteInstrument?: string): number | null {
    const inst = kiteInstrument || symbol;
    const tick = this.quoteCache.get(inst) || this.quoteCache.get(symbol);
    if (tick && tick.last_price > 0) {
      return tick.last_price;
    }
    return null;
  }

  /**
   * Sub-Second Fast Order Execution (< 20ms)
   */
  public async executeOrder(order: FastOrderRequest): Promise<FastOrderResult> {
    const startTime = performance.now();
    const orderId = order.id || crypto.randomUUID();

    try {
      const { user_id, symbol, side, qty, segment } = order;

      if (!user_id || !symbol || !side || !qty || qty <= 0) {
        return {
          success: false,
          status: 'REJECTED',
          symbol,
          side,
          qty,
          execution_latency_ms: Math.round(performance.now() - startTime),
          error: 'Missing required order fields or invalid quantity',
        };
      }

      // 1. In-Memory Quote Lookup (< 0.5ms)
      let fillPrice = order.client_price || 0;
      const cachedLtp = this.getLatestQuote(symbol, order.kite_instrument);
      if (cachedLtp && cachedLtp > 0) {
        fillPrice = cachedLtp;
      }

      // 2. If quote not found in memory, try fast Redis Hash lookup
      if (fillPrice <= 0) {
        try {
          const rawHash = await this.redis.hget('market:quotes', symbol) || 
                          await this.redis.hget('market:quotes', order.kite_instrument || symbol);
          if (rawHash) {
            const parsed = JSON.parse(rawHash);
            if (parsed.last_price > 0) fillPrice = parsed.last_price;
          }
        } catch {}
      }

      // Fallback to client price if market is matching
      if (fillPrice <= 0 && order.client_price && order.client_price > 0) {
        fillPrice = order.client_price;
      }

      if (fillPrice <= 0) {
        return {
          success: false,
          status: 'REJECTED',
          symbol,
          side,
          qty,
          execution_latency_ms: Math.round(performance.now() - startTime),
          error: `Unable to obtain live quote for ${symbol}`,
        };
      }

      const orderType = order.order_type || 'MARKET';
      const isImmediate = orderType === 'MARKET' || orderType === 'SL-M';
      const status = isImmediate ? 'EXECUTED' : 'PENDING';

      const executionLatency = Math.round(performance.now() - startTime);

      // 3. Emit instant execution event via Redis Pub/Sub so all browser tabs update immediately
      const executionEvent = {
        orderId,
        user_id,
        symbol,
        kite_instrument: order.kite_instrument || symbol,
        segment: order.segment,
        side,
        order_type: orderType,
        product_type: order.product_type || 'INTRADAY',
        qty,
        lots: order.lots || 0,
        fill_price: fillPrice,
        status,
        is_exit: order.is_exit || false,
        linked_position_id: order.linked_position_id || null,
        created_at: new Date().toISOString(),
        execution_latency_ms: executionLatency,
      };

      // Publish in parallel (zero-blocking)
      this.redis.publish('order_events', JSON.stringify(executionEvent)).catch((err: any) => {
        logger.warn({ err }, 'Failed to publish order execution event to Redis');
      });

      // 4. Enqueue to Async Write-Behind Persistence Queue
      this.enqueuePersistence({
        ...order,
        id: orderId,
        fill_price: fillPrice,
        status,
        executed_at: new Date().toISOString(),
      });

      return {
        success: true,
        orderId,
        status,
        fill_price: fillPrice,
        symbol,
        side,
        qty,
        execution_latency_ms: executionLatency,
      };
    } catch (err: any) {
      logger.error({ err, orderId }, 'Order execution error in OrderEngine');
      return {
        success: false,
        status: 'REJECTED',
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        execution_latency_ms: Math.round(performance.now() - startTime),
        error: err?.message || 'Internal order engine error',
      };
    }
  }

  /**
   * Pushes the executed order to the asynchronous persistence queue.
   */
  private async enqueuePersistence(payload: any) {
    try {
      const queueKey = 'orders:write_queue';
      await this.redis.lpush(queueKey, JSON.stringify(payload));
    } catch (err) {
      logger.error({ err }, 'Failed to push order to persistence queue, attempting direct write fallback');
      this.directWriteFallback(payload);
    }
  }

  /**
   * Emergency fallback if Redis queue is unavailable
   */
  private async directWriteFallback(payload: any) {
    try {
      const admin = getAdminClient();
      await admin.rpc('place_order_v2', {
        p_user_id: payload.user_id,
        p_symbol: payload.symbol,
        p_kite_inst: payload.kite_instrument || payload.symbol,
        p_segment: payload.segment,
        p_side: payload.side,
        p_order_type: payload.order_type || 'MARKET',
        p_product_type: payload.product_type || 'INTRADAY',
        p_qty: payload.qty,
        p_lots: payload.lots || 0,
        p_ltp: payload.fill_price,
        p_fill_price: payload.fill_price,
        p_is_exit: payload.is_exit || false,
        p_buffer_fee: 0,
        p_status: payload.status,
        p_trigger_price: payload.trigger_price || null,
        p_stop_loss: payload.stop_loss || null,
        p_target: payload.target || null,
        p_info: payload.linked_position_id || null,
        p_expected_margin: payload.expected_margin || payload.margin_required || 0,
        p_expected_brokerage: payload.expected_brokerage || payload.brokerage || 0,
        p_idempotency_key: payload.id,
        p_linked_position_id: payload.linked_position_id || null,
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'Direct write fallback failed for order');
    }
  }

  /**
   * Fast In-Memory / PostgreSQL Position Exit (< 20ms)
   */
  public async closePosition(userId: string, positionId: string, customExitPrice?: number): Promise<{ success: boolean; pnl?: number; exit_price?: number; error?: string }> {
    try {
      const admin = getAdminClient();
      
      const { data: pos, error: fetchErr } = await admin
        .from('positions')
        .select('*')
        .eq('id', positionId)
        .eq('user_id', userId)
        .single();

      if (fetchErr || !pos) {
        return { success: false, error: 'Position not found or already closed' };
      }

      if (pos.status === 'closed' || pos.status === 'CLOSED') {
        return {
          success: true,
          pnl: Number(pos.pnl || 0),
          exit_price: Number(pos.exit_price || pos.ltp || 0),
        };
      }

      let exitPrice = customExitPrice || 0;
      if (exitPrice <= 0) {
        const cachedLtp = this.getLatestQuote(pos.symbol, pos.kite_instrument);
        if (cachedLtp && cachedLtp > 0) {
          exitPrice = cachedLtp;
        } else {
          exitPrice = Number(pos.ltp || pos.entry_price || 0);
        }
      }

      const closeQty = Number(pos.qty_open !== undefined && pos.qty_open !== null && Number(pos.qty_open) > 0 ? pos.qty_open : (pos.qty_total || 1));

      let carryBrokerage = 0;
      if (pos.product_type === 'CARRY' && !pos.carry_brokerage_paid) {
        try {
          const { calculateCarryBrokerage } = await import('../../lib/trading/BrokerageCalculator.ts');
          carryBrokerage = calculateCarryBrokerage({
            productType: 'CARRY',
            qty: closeQty,
            entryPrice: Number(pos.entry_price || pos.avg_price || 0),
            lots: Number(pos.lots || 0) || undefined,
          });
        } catch {}
      }

      const { data: rpcRes, error: rpcErr } = await admin.rpc('close_position_v2', {
        p_position_id: positionId,
        p_close_qty: closeQty,
        p_close_price: exitPrice,
        p_closed_by: 'USER',
        p_expected_brokerage: carryBrokerage,
      });

      if (rpcErr) {
        return { success: false, error: rpcErr.message || 'Failed to close position' };
      }

      // Synchronously invalidate Redis caches
      try {
        const { invalidateUserPositionsCache, invalidateUserOrdersCache } = await import('../../lib/redisSettingsCache.ts');
        const { invalidateUserHistoryCache } = await import('../../lib/redisHistoryCache.ts');
        await Promise.all([
          invalidateUserPositionsCache(userId),
          invalidateUserOrdersCache(userId),
          invalidateUserHistoryCache(userId),
        ]);
      } catch (cacheErr) {
        logger.warn({ cacheErr }, 'Cache invalidation warning on fast exit');
      }

      return {
        success: true,
        pnl: rpcRes?.pnl ?? 0,
        exit_price: exitPrice,
      };
    } catch (err: any) {
      logger.error({ err }, 'Error closing position in OrderEngine');
      return { success: false, error: err?.message || 'Failed to close position' };
    }
  }

  /**
   * Fast In-Memory / PostgreSQL Bulk Position Exit (< 35ms)
   */
  public async closeAllPositions(userId: string, segment?: string): Promise<{ success: boolean; closedCount: number; error?: string }> {
    try {
      const admin = getAdminClient();
      let query = admin
        .from('positions')
        .select('id, symbol, kite_instrument, ltp, entry_price, qty_open, qty_total')
        .eq('user_id', userId)
        .in('status', ['open', 'active', 'OPEN', 'ACTIVE']);

      if (segment && segment !== 'ALL') {
        query = query.eq('segment', segment);
      }

      const { data: openPositions, error: fetchErr } = await query;
      if (fetchErr || !openPositions || openPositions.length === 0) {
        return { success: true, closedCount: 0 };
      }

      let closedCount = 0;
      for (const pos of openPositions) {
        const cachedLtp = this.getLatestQuote(pos.symbol, pos.kite_instrument) || Number(pos.ltp || pos.entry_price || 0);
        const closeQty = Number(pos.qty_open !== undefined && pos.qty_open !== null && Number(pos.qty_open) > 0 ? pos.qty_open : (pos.qty_total || 1));
        const { error: rpcErr } = await admin.rpc('close_position_v2', {
          p_position_id: pos.id,
          p_close_qty: closeQty,
          p_close_price: cachedLtp,
          p_closed_by: 'USER',
          p_expected_brokerage: 0,
        });
        if (!rpcErr) closedCount++;
      }

      // Invalidate caches
      try {
        const { invalidateUserPositionsCache, invalidateUserOrdersCache } = await import('../../lib/redisSettingsCache.ts');
        const { invalidateUserHistoryCache } = await import('../../lib/redisHistoryCache.ts');
        await Promise.all([
          invalidateUserPositionsCache(userId),
          invalidateUserOrdersCache(userId),
          invalidateUserHistoryCache(userId),
        ]);
      } catch (cacheErr) {}

      return { success: true, closedCount };
    } catch (err: any) {
      return { success: false, closedCount: 0, error: err?.message || 'Failed to close all positions' };
    }
  }
}
