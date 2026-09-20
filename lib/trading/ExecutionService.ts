import { randomUUID } from 'crypto';
import { getAdminClient } from '@/lib/adminClient';
import { callEngineRpc } from './EngineClient';

export interface ExecutionParams {
  userId: string;
  symbol: string;
  kiteInst: string;
  dbSegment: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  productType: string;
  qty: number;
  lots: number;
  baseLtp: number;
  fillPrice: number;
  bufferFee: number;
  triggerPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  isExit: boolean;
  linkedPositionId?: string;
  isImmediate: boolean;
  requiredMargin: number;
  brokerage: number;
}

export class ExecutionService {
  /**
   * Places an order through the Position Engine v2.
   * Acquires a per-user Redis lock to prevent concurrent order races,
   * then delegates entirely to place_order_v2 via EngineClient.
   */
  static async executeOrder(params: ExecutionParams): Promise<string> {
    const admin = getAdminClient();
    const { getRedisClient } = await import('@/lib/redis');
    const redis = getRedisClient();

    const lockKey = `order_lock:${params.userId}`;

    // Acquire per-user Redis lock (5 second TTL)
    const acquired = await redis.set(lockKey, '1', 'PX', 5000, 'NX');
    if (!acquired) {
      throw new Error('Order processing in progress. Please wait a second before placing another order.');
    }

    // Redis Fast-Reject: Check cached balance before calling DB transaction
    try {
      const cachedBalance = await redis.get(`balance:${params.userId}`);
      if (cachedBalance !== null) {
        const balance = parseFloat(cachedBalance);
        const totalRequired = params.requiredMargin + params.brokerage + params.bufferFee;
        if (balance < totalRequired && !params.isExit) {
          throw new Error(`Insufficient balance. Available: ₹${balance.toFixed(2)}, Required: ₹${totalRequired.toFixed(2)}`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Insufficient balance')) {
        throw err;
      }
    }

    let orderId: string;

    try {
      const rpcOrderType = params.orderType;
      const resolvedTriggerPrice = params.triggerPrice;
      const resolvedStopLoss = params.stopLoss;

      const idempotencyKey = randomUUID();

      // Check shadow mode config once before execution using in-memory cache
      const { ConfigurationService } = await import('./ConfigurationService');
      const isShadowMode = await ConfigurationService.isShadowModeEnabled();

      // Execute via EngineClient — telemetry and correlation ID attached automatically
      orderId = await callEngineRpc<string>(
        'place_order_v2',
        {
          p_user_id:            params.userId,
          p_symbol:             params.symbol,
          p_kite_inst:          params.kiteInst,
          p_segment:            params.dbSegment,
          p_side:               params.side,
          p_order_type:         rpcOrderType,
          p_product_type:       params.productType,
          p_qty:                params.qty,
          p_lots:               params.lots,
          p_ltp:                params.baseLtp,
          p_fill_price:         params.fillPrice,
          p_info:               params.linkedPositionId || null,
          p_trigger_price:      resolvedTriggerPrice,
          p_stop_loss:          resolvedStopLoss,
          p_target:             params.target,
          p_is_exit:            params.isExit,
          p_buffer_fee:         params.bufferFee,
          p_status:             params.isImmediate ? 'EXECUTED' : 'PENDING',
          p_expected_margin:    params.requiredMargin,
          p_expected_brokerage: params.brokerage,
          p_idempotency_key:    idempotencyKey,
          p_linked_position_id: params.linkedPositionId || null,
        },
        {
          userId: params.userId,
          journalEvent: {
            event_type: params.isExit ? 'ORDER_PLACED_EXIT' : 'ORDER_PLACED',
            payload: {
              symbol:       params.symbol,
              side:         params.side,
              qty:          params.qty,
              fill_price:   params.fillPrice,
              product_type: params.productType,
              order_type:   params.orderType,
              is_immediate: params.isImmediate,
            },
          },
        },
      );

      // Append margin/brokerage breakdown to act_log (fire-and-forget, non-critical)
      setTimeout(async () => {
        try {
          const { data: actLog, error: actLogError } = await admin
            .from('act_logs')
            .select('id, reason')
            .eq('user_id', params.userId)
            .eq('symbol', params.symbol)
            .in('type', ['ORDER_EXECUTION', 'ORDER_PLACED'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (actLog && !actLogError) {
            const suffix = ` | Margin Req: ₹${params.requiredMargin.toFixed(2)} | Bkg: ₹${params.brokerage.toFixed(2)} | Buf: ₹${params.bufferFee.toFixed(2)}`;
            await admin
              .from('act_logs')
              .update({ reason: actLog.reason + suffix })
              .eq('id', actLog.id);
          }
        } catch { /* non-critical */ }
      }, 0);

      // Trigger async shadow comparison if shadow mode is active
      if (isShadowMode) {
        import('./ShadowModeService').then(({ ShadowModeService }) => {
          ShadowModeService.runShadowCompare(params, orderId).catch((e) => {
            console.error('[ShadowMode] Asynchronous comparison error:', e);
          });
        });
      }

    } finally {
      // Always release the lock and invalidate position, balance, and history cache
      await redis.del(lockKey);
      try {
        await redis.del(
          `pos:${params.userId}:default`,
          `pos:${params.userId}:open`,
          `pos:${params.userId}:active`,
          `balance:${params.userId}`,
        );
        const { invalidateUserHistoryCache } = await import('@/lib/redisHistoryCache');
        await invalidateUserHistoryCache(params.userId);
      } catch { /* non-critical */ }
    }



    return orderId;
  }
}
