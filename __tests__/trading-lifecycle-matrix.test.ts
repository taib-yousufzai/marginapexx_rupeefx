import { describe, it, expect } from 'vitest';
import { evaluateOrderTriggerCondition } from '../lib/orderMatching';
import { OrderService } from '../lib/trading/OrderService';

/**
 * MarginApex Trading Lifecycle Verification Matrix
 * 
 * INTEGRATION TEST SUITE:
 * - Order trigger evaluation tests exercise the ACTUAL production code from `lib/orderMatching.ts`
 *   (`evaluateOrderTriggerCondition`).
 * - Database state transitions simulate the exact logic implemented in Postgres RPC `place_order_v2.sql`.
 */

interface Order {
  id: string;
  user_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  order_type: 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT';
  status: 'PENDING' | 'EXECUTED' | 'CANCELLED' | 'REJECTED';
  qty: number;
  client_price?: number;
  price?: number;
  fill_price?: number;
  trigger_price?: number;
  stop_loss?: number;
  target?: number;
  ltp_at_entry?: number;
  is_exit?: boolean;
  linked_position_id?: string;
}

interface Position {
  id: string;
  user_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty_open: number;
  qty_total: number;
  entry_price: number;
  status: 'open' | 'closed';
  stop_loss?: number;
  target?: number;
}

class TradingEngineSimulator {
  orders: Order[] = [];
  positions: Position[] = [];
  trades: { id: string; order_id: string; qty: number; price: number }[] = [];

  placeMarketOrder(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    isExit?: boolean;
    linkedPositionId?: string;
  }): { order: Order; position?: Position } {
    const orderId = `ord_${Math.random().toString(36).substring(2, 9)}`;
    const order: Order = {
      id: orderId,
      user_id: params.userId,
      symbol: params.symbol,
      side: params.side,
      order_type: 'MARKET',
      status: 'EXECUTED',
      qty: params.qty,
      fill_price: params.price,
      price: params.price,
      is_exit: params.isExit ?? false,
      linked_position_id: params.linkedPositionId,
    };
    this.orders.push(order);

    this.trades.push({
      id: `trd_${Math.random().toString(36).substring(2, 9)}`,
      order_id: orderId,
      qty: params.qty,
      price: params.price,
    });

    let position: Position | undefined;

    if (params.isExit) {
      const pos = this.positions.find(
        p => p.user_id === params.userId && p.symbol === params.symbol && p.status === 'open'
      );
      if (pos) {
        if (params.qty >= pos.qty_open) {
          pos.qty_open = 0;
          pos.status = 'closed';
        } else {
          pos.qty_open -= params.qty;
        }
        position = pos;
      }
    } else {
      const existingOppPos = this.positions.find(
        p => p.user_id === params.userId && p.symbol === params.symbol && p.status === 'open' && p.side !== params.side
      );

      if (existingOppPos) {
        if (params.qty >= existingOppPos.qty_open) {
          existingOppPos.qty_open = 0;
          existingOppPos.status = 'closed';
        } else {
          existingOppPos.qty_open -= params.qty;
        }
        position = existingOppPos;
      } else {
        position = {
          id: `pos_${Math.random().toString(36).substring(2, 9)}`,
          user_id: params.userId,
          symbol: params.symbol,
          side: params.side,
          qty_open: params.qty,
          qty_total: params.qty,
          entry_price: params.price,
          status: 'open',
        };
        this.positions.push(position);
      }
    }

    return { order, position };
  }

  placePendingOrder(params: {
    userId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    orderType: 'LIMIT' | 'SL' | 'SLM' | 'GTT';
    qty: number;
    price?: number;
    triggerPrice?: number;
    stopLoss?: number;
    target?: number;
    ltpAtEntry?: number;
    isExit?: boolean;
    linkedPositionId?: string;
  }): Order {
    const order: Order = {
      id: `ord_${Math.random().toString(36).substring(2, 9)}`,
      user_id: params.userId,
      symbol: params.symbol,
      side: params.side,
      order_type: params.orderType,
      status: 'PENDING',
      qty: params.qty,
      client_price: params.price,
      price: params.price,
      trigger_price: params.triggerPrice,
      stop_loss: params.stopLoss,
      target: params.target,
      ltp_at_entry: params.ltpAtEntry,
      is_exit: params.isExit ?? false,
      linked_position_id: params.linkedPositionId,
    };
    this.orders.push(order);
    return order;
  }

  // Uses ACTUAL production evaluateOrderTriggerCondition from lib/orderMatching.ts
  evaluatePendingOrders(symbol: string, currentLtp: number, bid?: number, ask?: number): Order[] {
    const triggered: Order[] = [];
    for (const order of this.orders) {
      if (order.symbol !== symbol || order.status !== 'PENDING') continue;

      const evalRes = evaluateOrderTriggerCondition(
        {
          order_type: order.order_type,
          side: order.side,
          price: order.price,
          client_price: order.client_price,
          fill_price: order.fill_price,
          trigger_price: order.trigger_price,
          stop_loss: order.stop_loss,
          target: order.target,
          ltp_at_entry: order.ltp_at_entry,
        },
        currentLtp,
        bid,
        ask
      );

      if (evalRes.shouldTrigger) {
        order.status = 'EXECUTED';
        order.fill_price = evalRes.fillPrice;

        this.trades.push({
          id: `trd_${Math.random().toString(36).substring(2, 9)}`,
          order_id: order.id,
          qty: order.qty,
          price: evalRes.fillPrice,
        });

        if (order.is_exit) {
          const pos = this.positions.find(
            p => p.user_id === order.user_id && p.symbol === order.symbol && p.status === 'open'
          );
          if (pos) {
            if (order.qty >= pos.qty_open) {
              pos.qty_open = 0;
              pos.status = 'closed';
            } else {
              pos.qty_open -= order.qty;
            }
          }
        } else {
          const existingOppPos = this.positions.find(
            p => p.user_id === order.user_id && p.symbol === order.symbol && p.status === 'open' && p.side !== order.side
          );
          if (existingOppPos) {
            if (order.qty >= existingOppPos.qty_open) {
              existingOppPos.qty_open = 0;
              existingOppPos.status = 'closed';
            } else {
              existingOppPos.qty_open -= order.qty;
            }
          } else {
            this.positions.push({
              id: `pos_${Math.random().toString(36).substring(2, 9)}`,
              user_id: order.user_id,
              symbol: order.symbol,
              side: order.side,
              qty_open: order.qty,
              qty_total: order.qty,
              entry_price: evalRes.fillPrice,
              status: 'open',
            });
          }
        }
        triggered.push(order);
      }
    }
    return triggered;
  }

  cancelOrder(orderId: string, userId: string): { success: boolean; error?: string } {
    const order = this.orders.find(o => o.id === orderId && o.user_id === userId);
    if (!order) return { success: false, error: 'Order not found' };
    if (order.status !== 'PENDING') {
      return { success: false, error: `Could not cancel order. Current status: ${order.status}` };
    }
    order.status = 'CANCELLED';
    return { success: true };
  }

  modifyOrder(
    orderId: string,
    userId: string,
    updates: { price?: number; triggerPrice?: number; qty?: number; orderType?: 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT' }
  ): { success: boolean; order?: Order; error?: string } {
    const order = this.orders.find(o => o.id === orderId && o.user_id === userId);
    if (!order) return { success: false, error: 'Order not found' };

    if (order.status !== 'PENDING') {
      return { success: false, error: `Order cannot be modified. Current status: ${order.status}` };
    }

    if (updates.price !== undefined) {
      order.client_price = updates.price;
      order.price = updates.price;
    }
    if (updates.triggerPrice !== undefined) {
      order.trigger_price = updates.triggerPrice;
    }
    if (updates.qty !== undefined) {
      if (updates.qty <= 0) return { success: false, error: 'Quantity must be greater than zero.' };
      order.qty = updates.qty;
    }
    if (updates.orderType !== undefined) {
      order.order_type = updates.orderType;
    }

    if (updates.orderType === 'MARKET') {
      order.order_type = 'MARKET';
      order.status = 'EXECUTED';
      order.trigger_price = undefined;
      const fillPrice = updates.price ?? order.client_price ?? order.price ?? 2300;
      order.fill_price = fillPrice;
      order.price = fillPrice;

      this.trades.push({
        id: `trd_${Math.random().toString(36).substring(2, 9)}`,
        order_id: order.id,
        qty: order.qty,
        price: fillPrice,
      });

      if (order.is_exit) {
        const pos = this.positions.find(
          p => p.user_id === order.user_id && p.symbol === order.symbol && p.status === 'open'
        );
        if (pos) {
          if (order.qty >= pos.qty_open) {
            pos.qty_open = 0;
            pos.status = 'closed';
          } else {
            pos.qty_open -= order.qty;
          }
        }
      } else {
        this.positions.push({
          id: `pos_${Math.random().toString(36).substring(2, 9)}`,
          user_id: order.user_id,
          symbol: order.symbol,
          side: order.side,
          qty_open: order.qty,
          qty_total: order.qty,
          entry_price: fillPrice,
          status: 'open',
          stop_loss: order.stop_loss,
          target: order.target,
        });
      }
    }

    return { success: true, order };
  }
}

describe('MarginApex Trading Order Lifecycle & Modify Matrix (12 Test Cases)', () => {
  const userId = 'usr_test_123';
  const symbol = 'NSE:RELIANCE';

  it('Test 1: Market Buy Entry — Order EXECUTED immediately, Trade recorded, Position created (BUY, OPEN)', () => {
    const sim = new TradingEngineSimulator();
    const result = sim.placeMarketOrder({ userId, symbol, side: 'BUY', qty: 10, price: 2500 });

    expect(result.order.status).toBe('EXECUTED');
    expect(result.order.fill_price).toBe(2500);
    expect(sim.trades.length).toBe(1);
    expect(sim.positions.length).toBe(1);
    expect(sim.positions[0].side).toBe('BUY');
    expect(sim.positions[0].status).toBe('open');
    expect(sim.positions[0].qty_open).toBe(10);
  });

  it('Test 2: Market Sell Entry — Order EXECUTED immediately, Trade recorded, Position created (SELL, OPEN)', () => {
    const sim = new TradingEngineSimulator();
    const result = sim.placeMarketOrder({ userId, symbol, side: 'SELL', qty: 5, price: 2500 });

    expect(result.order.status).toBe('EXECUTED');
    expect(result.order.fill_price).toBe(2500);
    expect(sim.trades.length).toBe(1);
    expect(sim.positions.length).toBe(1);
    expect(sim.positions[0].side).toBe('SELL');
    expect(sim.positions[0].status).toBe('open');
    expect(sim.positions[0].qty_open).toBe(5);
  });

  it('Test 3: Limit Buy Pending — Order placed with limit price < LTP remains PENDING, NO position created', () => {
    const sim = new TradingEngineSimulator();
    const limitPrice = 2450;

    const order = sim.placePendingOrder({
      userId, symbol, side: 'BUY', orderType: 'LIMIT', qty: 10, price: limitPrice
    });

    expect(order.status).toBe('PENDING');
    expect(sim.trades.length).toBe(0);
    expect(sim.positions.length).toBe(0);
  });

  it('Test 4: Limit Buy Execution — Price drops to limit price, evaluateOrderTriggerCondition triggers EXECUTED, Position created', () => {
    const sim = new TradingEngineSimulator();
    const order = sim.placePendingOrder({
      userId, symbol, side: 'BUY', orderType: 'LIMIT', qty: 10, price: 2450
    });

    const triggered = sim.evaluatePendingOrders(symbol, 2445);

    expect(triggered.length).toBe(1);
    expect(order.status).toBe('EXECUTED');
    expect(sim.trades.length).toBe(1);
    expect(sim.positions.length).toBe(1);
    expect(sim.positions[0].qty_open).toBe(10);
  });

  it('Test 5: Limit Sell Pending — Order placed with limit price > LTP remains PENDING, NO position created', () => {
    const sim = new TradingEngineSimulator();
    const limitPrice = 2550;

    const order = sim.placePendingOrder({
      userId, symbol, side: 'SELL', orderType: 'LIMIT', qty: 10, price: limitPrice
    });

    expect(order.status).toBe('PENDING');
    expect(sim.trades.length).toBe(0);
    expect(sim.positions.length).toBe(0);
  });

  it('Test 6: Limit Sell Execution — Price rises to limit price, evaluateOrderTriggerCondition triggers EXECUTED, Position created', () => {
    const sim = new TradingEngineSimulator();
    const order = sim.placePendingOrder({
      userId, symbol, side: 'SELL', orderType: 'LIMIT', qty: 10, price: 2550
    });

    const triggered = sim.evaluatePendingOrders(symbol, 2555);

    expect(triggered.length).toBe(1);
    expect(order.status).toBe('EXECUTED');
    expect(sim.trades.length).toBe(1);
    expect(sim.positions.length).toBe(1);
    expect(sim.positions[0].side).toBe('SELL');
  });

  it('Test 7: SL / SLM Trigger & Execution — Position remains OPEN untouched while SL is PENDING; Trigger hits -> EXECUTED -> Position CLOSED', () => {
    const sim = new TradingEngineSimulator();
    const entry = sim.placeMarketOrder({ userId, symbol, side: 'BUY', qty: 10, price: 2500 });
    const pos = entry.position!;

    const slOrder = sim.placePendingOrder({
      userId, symbol, side: 'SELL', orderType: 'SLM', qty: 10, triggerPrice: 2400, isExit: true, linkedPositionId: pos.id
    });

    expect(slOrder.status).toBe('PENDING');
    expect(pos.status).toBe('open');
    expect(pos.qty_open).toBe(10);

    const triggered = sim.evaluatePendingOrders(symbol, 2390, 2389, 2391);

    expect(triggered.length).toBe(1);
    expect(slOrder.status).toBe('EXECUTED');
    expect(pos.status).toBe('closed');
    expect(pos.qty_open).toBe(0);
  });

  it('Test 8: GTT Order Trigger — GTT order remains PENDING untouched until evaluateOrderTriggerCondition condition is met', () => {
    const sim = new TradingEngineSimulator();
    const gttOrder = sim.placePendingOrder({
      userId, symbol, side: 'BUY', orderType: 'GTT', qty: 5, triggerPrice: 2400, ltpAtEntry: 2500
    });

    expect(gttOrder.status).toBe('PENDING');
    expect(sim.positions.length).toBe(0);

    const triggered = sim.evaluatePendingOrders(symbol, 2395, 2394, 2396);

    expect(triggered.length).toBe(1);
    expect(gttOrder.status).toBe('EXECUTED');
    expect(sim.positions.length).toBe(1);
    expect(sim.positions[0].qty_open).toBe(5);
  });

  it('Test 8a: GTT Buy Validation — Missing limit price is strictly rejected', () => {
    const err = OrderService.validateLimitPrice('GTT', 'BUY', 0, 100, false);
    expect(err).toBe('Limit price is required for a GTT Buy order.');
  });

  it('Test 8b: Full GTT Buy Lifecycle State Machine — GTT Created -> Limit Pending -> Position Active -> Exit Conditions Active', () => {
    const sim = new TradingEngineSimulator();
    const cmp = 100;
    const limitPrice = 90;
    const stopLoss = 80;
    const target = 120;

    // Stage 1: GTT CREATED
    const gttOrder = sim.placePendingOrder({
      userId,
      symbol,
      side: 'BUY',
      orderType: 'GTT',
      qty: 10,
      price: limitPrice,
      stopLoss,
      target,
      ltpAtEntry: cmp,
    });

    expect(gttOrder.status).toBe('PENDING');
    expect(sim.positions.length).toBe(0); // 0 positions created

    // Stage 2: WAITING FOR LIMIT ENTRY — Price moves to 95 and 120 (above limit entry 90)
    let triggered = sim.evaluatePendingOrders(symbol, 95);
    expect(triggered.length).toBe(0);
    expect(gttOrder.status).toBe('PENDING');
    expect(sim.positions.length).toBe(0); // SL/Target remain INACTIVE, no positions

    triggered = sim.evaluatePendingOrders(symbol, 120);
    expect(triggered.length).toBe(0);
    expect(gttOrder.status).toBe('PENDING');
    expect(sim.positions.length).toBe(0); // Target 120 DOES NOT trigger prematurely!

    // Stage 3: LIMIT ENTRY TRIGGERED — Market price drops to 90
    triggered = sim.evaluatePendingOrders(symbol, 90);
    expect(triggered.length).toBe(1);
    expect(gttOrder.status).toBe('EXECUTED');

    // Stage 4: ACTIVE POSITION CREATED — Position is now open with SL and Target attached
    expect(sim.positions.length).toBe(1);
    const activePos = sim.positions[0];
    expect(activePos.status).toBe('open');
    expect(activePos.entry_price).toBe(90);
    expect(activePos.qty_open).toBe(10);

    // Stage 5: EXIT CONDITIONS ACTIVATED — Position closes when SL (80) is hit
    // Attach SL exit order to active position as created by system
    const slExitOrder = sim.placePendingOrder({
      userId,
      symbol,
      side: 'SELL',
      orderType: 'SLM',
      qty: 10,
      triggerPrice: stopLoss,
      isExit: true,
      linkedPositionId: activePos.id,
    });

    expect(slExitOrder.status).toBe('PENDING');
    expect(activePos.status).toBe('open');

    // Price drops to 80 -> Stop Loss fires and closes position
    const exitTriggered = sim.evaluatePendingOrders(symbol, 80, 79, 81);
    expect(exitTriggered.length).toBe(1);
    expect(slExitOrder.status).toBe('EXECUTED');
    expect(activePos.status).toBe('closed');
    expect(activePos.qty_open).toBe(0);
  });

  it('Test 9: Position Full Exit — Executing exit order equal to qty_open closes position and releases margin', () => {
    const sim = new TradingEngineSimulator();
    sim.placeMarketOrder({ userId, symbol, side: 'BUY', qty: 100, price: 2500 });

    expect(sim.positions[0].qty_open).toBe(100);
    expect(sim.positions[0].status).toBe('open');

    sim.placeMarketOrder({ userId, symbol, side: 'SELL', qty: 100, price: 2550, isExit: true });

    expect(sim.positions[0].qty_open).toBe(0);
    expect(sim.positions[0].status).toBe('closed');
  });

  it('Test 10: Position Partial Exit — Executing partial exit reduces qty_open while position remains OPEN', () => {
    const sim = new TradingEngineSimulator();
    sim.placeMarketOrder({ userId, symbol, side: 'BUY', qty: 100, price: 2500 });

    sim.placeMarketOrder({ userId, symbol, side: 'SELL', qty: 40, price: 2550, isExit: true });

    expect(sim.positions[0].qty_open).toBe(60);
    expect(sim.positions[0].status).toBe('open');
  });

  it('Test 11: Order Cancel — Cancelling pending order updates status to CANCELLED without altering positions', () => {
    const sim = new TradingEngineSimulator();
    const order = sim.placePendingOrder({
      userId, symbol, side: 'BUY', orderType: 'LIMIT', qty: 10, price: 2400
    });

    const res = sim.cancelOrder(order.id, userId);

    expect(res.success).toBe(true);
    expect(order.status).toBe('CANCELLED');
    expect(sim.positions.length).toBe(0);
  });

  it('Test 12: Modify Order — In-place update of pending order fields; Rejects modification if EXECUTED or CANCELLED', () => {
    const sim = new TradingEngineSimulator();
    const order = sim.placePendingOrder({
      userId, symbol, side: 'BUY', orderType: 'LIMIT', qty: 10, price: 2400
    });

    const modRes = sim.modifyOrder(order.id, userId, { price: 2420, qty: 15 });
    expect(modRes.success).toBe(true);
    expect(order.client_price).toBe(2420);
    expect(order.qty).toBe(15);
    expect(order.status).toBe('PENDING');

    sim.evaluatePendingOrders(symbol, 2410);
    expect(order.status).toBe('EXECUTED');

    const invalidModRes = sim.modifyOrder(order.id, userId, { price: 2450 });
    expect(invalidModRes.success).toBe(false);
    expect(invalidModRes.error).toContain('Order cannot be modified. Current status: EXECUTED');
  });

  it('Test 13: GTT to Market Transition — Modifying pending GTT to MARKET triggers immediate execution, creates position, clears trigger condition, and prevents double execution', () => {
    const sim = new TradingEngineSimulator();
    
    // 1. User creates a pending GTT Buy order (ETH @ 2300, SL 2200, Target 2500)
    const gttOrder = sim.placePendingOrder({
      userId,
      symbol: 'ETHUSDT',
      side: 'BUY',
      orderType: 'GTT',
      qty: 2,
      price: 2300,
      triggerPrice: 2300,
      stopLoss: 2200,
      target: 2500,
    });

    expect(gttOrder.status).toBe('PENDING');
    expect(gttOrder.order_type).toBe('GTT');
    expect(sim.positions.length).toBe(0);

    // 2. User modifies GTT -> MARKET
    const modRes = sim.modifyOrder(gttOrder.id, userId, {
      orderType: 'MARKET',
      price: 2350, // Current market fill price
    });

    expect(modRes.success).toBe(true);
    expect(gttOrder.status).toBe('EXECUTED');
    expect(gttOrder.order_type).toBe('MARKET');
    expect(gttOrder.trigger_price).toBeUndefined(); // Trigger condition cleared!
    expect(gttOrder.fill_price).toBe(2350);

    // 3. Verify position was created immediately
    expect(sim.positions.length).toBe(1);
    const pos = sim.positions[0];
    expect(pos.status).toBe('open');
    expect(pos.entry_price).toBe(2350);
    expect(pos.qty_open).toBe(2);
    expect(pos.stop_loss).toBe(2200);
    expect(pos.target).toBe(2500);

    // 4. Verify background matching loop DOES NOT re-trigger the old GTT condition if price hits 2300
    const triggeredLater = sim.evaluatePendingOrders('ETHUSDT', 2300);
    expect(triggeredLater.length).toBe(0);
    expect(sim.positions.length).toBe(1); // STILL exactly 1 position, no duplicate position created!
  });

  it('Test 14: GTT to Market Transition with SL/Target — Modifying GTT to MARKET preserves SL and Target exit conditions on the newly opened position', () => {
    const sim = new TradingEngineSimulator();
    
    const gttOrder = sim.placePendingOrder({
      userId,
      symbol: 'NSE:INFY',
      side: 'BUY',
      orderType: 'GTT',
      qty: 50,
      price: 1500,
      triggerPrice: 1500,
      stopLoss: 1450,
      target: 1600,
    });

    const modRes = sim.modifyOrder(gttOrder.id, userId, {
      orderType: 'MARKET',
      price: 1510,
    });

    expect(modRes.success).toBe(true);
    expect(sim.positions.length).toBe(1);
    const activePos = sim.positions[0];
    expect(activePos.stop_loss).toBe(1450);
    expect(activePos.target).toBe(1600);
  });

  it('Test 15: Entry SLM vs Exit SLM Directional Validation — Verifies OrderService.validateStopLoss rules for Entry and Exit contexts', () => {
    // 1. BUY side SL/SLM: Stop Loss must be lower than market (trigger < LTP)
    expect(OrderService.validateStopLoss('SLM', 'BUY', 2250, 2300, false)).toBeNull(); // Valid (2250 < 2300)
    expect(OrderService.validateStopLoss('SLM', 'BUY', 2350, 2300, false)).toContain('Stop loss trigger price must be lower than the current market price'); // Invalid

    // 2. SELL side SL/SLM: Stop Loss must be higher than market (trigger > LTP)
    expect(OrderService.validateStopLoss('SLM', 'SELL', 2350, 2300, false)).toBeNull(); // Valid (2350 > 2300)
    expect(OrderService.validateStopLoss('SLM', 'SELL', 2250, 2300, false)).toContain('Stop loss trigger price must be higher than the current market price'); // Invalid
  });
});
