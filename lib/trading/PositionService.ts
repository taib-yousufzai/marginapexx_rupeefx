import { getAdminClient } from '@/lib/adminClient';
import { callEngineRpc } from './EngineClient';

export interface ClosePositionParams {
  userId: string;
  positionId: string;
  closeQty: number;
  closePrice: number;
  closedBy?: 'USER' | 'ADMIN' | 'SYSTEM' | 'LIQUIDATION';
  /** TS-calculated brokerage. DB will record it but TS is responsible for the calculation. */
  expectedBrokerage?: number;
  idempotencyKey?: string;
}

export class PositionService {
  /**
   * Opens a new position or averages an existing one.
   * Relies entirely on the Supabase Postgres RPC 'place_order_v2' to ensure atomic
   * execution of the order creation, position opening/updating, and ledger deduction.
   */
  static async openPosition(
    userId: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    qty: number,
    lots: number,
    baseLtp: number,
    fillPrice: number,
    orderType: string,
    productType: string,
    dbSegment: string,
    kiteInst: string,
    isImmediate: boolean,
    expectedMargin: number = 0,
    expectedBrokerage: number = 0,
    idempotencyKey?: string
  ): Promise<string> {
    const orderId = await callEngineRpc<string>(
      'place_order_v2',
      {
        p_user_id:            userId,
        p_symbol:             symbol,
        p_kite_inst:          kiteInst,
        p_segment:            dbSegment,
        p_side:               side,
        p_order_type:         orderType,
        p_product_type:       productType,
        p_qty:                qty,
        p_lots:               lots,
        p_ltp:                baseLtp,
        p_fill_price:         fillPrice,
        p_is_exit:            false,
        p_buffer_fee:         0,
        p_status:             isImmediate ? 'EXECUTED' : 'PENDING',
        p_expected_margin:    expectedMargin,
        p_expected_brokerage: expectedBrokerage,
        p_idempotency_key:    idempotencyKey ?? null,
      },
      {
        userId,
        journalEvent: {
          event_type: 'POSITION_OPENED',
          payload: { symbol, side, qty, fill_price: fillPrice, product_type: productType },
        },
      },
    );

    if (!orderId) {
      throw new Error('Failed to open position in the database.');
    }

    return orderId;
  }

  /**
   * Closes or partially closes a position.
   * Ensures that margin release and PnL realization happen atomically in the DB.
   * TS calculates brokerage and passes it for the DB to record in a single transaction.
   */
  static async closePosition(params: ClosePositionParams): Promise<void> {
    await callEngineRpc<number>(
      'close_position_v2',
      {
        p_position_id:        params.positionId,
        p_close_qty:          params.closeQty,
        p_close_price:        params.closePrice,
        p_closed_by:          params.closedBy ?? 'USER',
        p_expected_brokerage: params.expectedBrokerage ?? 0,
        p_idempotency_key:    params.idempotencyKey ?? null,
      },
      {
        userId: params.userId,
        journalEvent: {
          event_type: 'POSITION_CLOSED',
          payload: {
            position_id:  params.positionId,
            close_qty:    params.closeQty,
            close_price:  params.closePrice,
            closed_by:    params.closedBy ?? 'USER',
          },
        },
      },
    );

    // Cancel any pending exit/SL/Target/Limit orders associated with this closed position or symbol
    try {
      const admin = getAdminClient();
      // Fetch symbol from position if not provided
      const { data: pos } = await admin
        .from('positions')
        .select('symbol, status')
        .eq('id', params.positionId)
        .maybeSingle();

      if (!pos || pos.status === 'closed') {
        await PositionService.cancelPendingOrdersForClosedPosition(admin, params.userId, params.positionId, pos?.symbol);
      }
    } catch (err) {
      console.warn('[PositionService] Failed to cleanup pending orders after position close:', err);
    }
  }

  /**
   * Automatically cancels any orphan pending exit/SL/Target/Limit orders associated with a closed position or symbol.
   */
  static async cancelPendingOrdersForClosedPosition(admin: any, userId: string, positionId?: string, symbol?: string): Promise<void> {
    try {
      const now = new Date().toISOString();

      // 1. Cancel by position ID (if linked via linked_position_id or info)
      if (positionId) {
        await admin
          .from('orders')
          .update({ status: 'CANCELLED', updated_at: now })
          .eq('user_id', userId)
          .in('status', ['PENDING', 'OPEN', 'TRIGGER_PENDING', 'VALIDATION_PENDING'])
          .eq('info', positionId);
      }

      // 2. Cancel by symbol (if no open positions remain for that symbol)
      if (symbol) {
        const cleanSym = symbol.includes(':') ? symbol.split(':')[1] : symbol;
        
        // Check if user has any remaining open positions for this symbol
        const { data: remainingOpenPos } = await admin
          .from('positions')
          .select('id')
          .eq('user_id', userId)
          .eq('status', 'open')
          .or(`symbol.eq.${symbol},symbol.eq.${cleanSym}`);

        if (!remainingOpenPos || remainingOpenPos.length === 0) {
          // No open positions remain for this symbol -> cancel all pending exit/SL/Target/Limit orders for this symbol
          const symbolVariants = Array.from(new Set([
            symbol,
            cleanSym,
            cleanSym.replace('/', ''),
            cleanSym.replace('/USDT', 'USDT'),
            `NSE:${cleanSym}`,
            `NFO:${cleanSym}`,
            `MCX:${cleanSym}`,
          ])).filter(Boolean);

          await admin
            .from('orders')
            .update({ status: 'CANCELLED', updated_at: now })
            .eq('user_id', userId)
            .in('status', ['PENDING', 'OPEN', 'TRIGGER_PENDING', 'VALIDATION_PENDING'])
            .in('symbol', symbolVariants);
        }
      }
    } catch (err) {
      console.warn('[PositionService] Error cancelling pending orders for closed position:', err);
    }
  }

  /**
   * Replaces the old in-memory cache lookup.
   * Always fetches the authoritative position state directly from the database.
   */
  static async getOpenPosition(userId: string, symbol: string): Promise<any | null> {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', symbol)
      .eq('status', 'open')
      .maybeSingle();

    if (error) {
      throw new Error(`Database error fetching position: ${error.message}`);
    }

    return data;
  }

  /**
   * Retrieves all open positions for a user directly from the authoritative database.
   */
  static async getAllOpenPositions(userId: string): Promise<any[]> {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'open');

    if (error) {
      throw new Error(`Database error fetching all positions: ${error.message}`);
    }

    return data || [];
  }
}
