import { getRedisClient } from '../../lib/redis.ts';
import { getAdminClient } from '../../lib/adminClient.ts';
import pino from 'pino';

const logger = pino({ name: 'async-db-writer' });

export class AsyncDbWriter {
  private redis: any;
  private isRunning: boolean = false;
  private pollIntervalMs: number = 100; // Fast 100ms micro-batching

  constructor() {
    this.redis = getRedisClient();
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Async DB Writer started (write-behind persistence worker)');
    this.processLoop();
  }

  public stop() {
    this.isRunning = false;
    logger.info('Async DB Writer stopped');
  }

  private async processLoop() {
    while (this.isRunning) {
      try {
        await this.flushQueue();
      } catch (err) {
        logger.error({ err }, 'Error in async DB write worker cycle');
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private async flushQueue() {
    const queueKey = 'orders:write_queue';
    
    // Pop up to 50 items per cycle
    for (let i = 0; i < 50; i++) {
      let item: string | null = null;
      try {
        item = await this.redis.rpop(queueKey);
      } catch {
        break;
      }

      if (!item) break;

      try {
        const order = JSON.parse(item);
        await this.persistOrder(order);
      } catch (err) {
        logger.error({ err, item }, 'Failed to persist order to database');
        // Push back to DLQ or retry queue if necessary
        try {
          await this.redis.lpush('orders:dlq', item);
        } catch {}
      }
    }
  }

  private async persistOrder(order: any) {
    const admin = getAdminClient();
    
    const { data: orderId, error } = await admin.rpc('place_order_v2', {
      p_user_id: order.user_id,
      p_symbol: order.symbol,
      p_kite_inst: order.kite_instrument || order.symbol,
      p_segment: order.segment,
      p_side: order.side,
      p_order_type: order.order_type || 'MARKET',
      p_product_type: order.product_type || 'INTRADAY',
      p_qty: order.qty,
      p_lots: order.lots || 0,
      p_ltp: order.fill_price,
      p_fill_price: order.fill_price,
      p_is_exit: order.is_exit || false,
      p_buffer_fee: 0,
      p_status: order.status,
      p_trigger_price: order.trigger_price || null,
      p_stop_loss: order.stop_loss || null,
      p_target: order.target || null,
      p_info: order.linked_position_id || null,
      p_expected_margin: order.expected_margin || order.margin_required || 0,
      p_expected_brokerage: order.expected_brokerage || order.brokerage || 0,
      p_idempotency_key: order.id || null,
      p_linked_position_id: (typeof order.linked_position_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order.linked_position_id)) ? order.linked_position_id : null,
    });

    if (error) {
      throw new Error(error.message || 'Supabase RPC place_order_v2 failed');
    }

    // Invalidate API positions Redis cache for this user so subsequent polls immediately reflect the new state
    try {
      if (order.user_id) {
        const keys = await this.redis.keys(`api:positions:${order.user_id}:*`);
        if (keys && keys.length > 0) {
          await this.redis.del(...keys);
        }
      }
    } catch {}

    logger.info({ orderId, symbol: order.symbol, side: order.side }, 'Async order successfully written to Supabase Postgres');
  }
}
