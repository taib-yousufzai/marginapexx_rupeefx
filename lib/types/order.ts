/**
 * Shared order types used across API routes, hooks, and UI.
 */

export type OrderSide        = 'BUY' | 'SELL';
export type OrderType        = 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT';
export type ProductType      = 'INTRADAY' | 'CARRY';
export type OrderStatus      = 'SUBMITTING' | 'PENDING' | 'EXECUTED' | 'CANCELLED' | 'REJECTED' | 'TRIGGERED';

// ─── Request (client → POST /api/orders) ─────────────────────────────────────
export interface PlaceOrderRequest {
  /** Short display symbol e.g. "NIFTY FUT" */
  symbol: string;
  /** Kite quote instrument key e.g. "NFO:NIFTY25MAYFUT"  */
  kite_instrument: string;
  /** Platform segment label e.g. "INDEX - FUTURE" */
  segment: string;
  side: OrderSide;
  order_type: OrderType;
  product_type: ProductType;
  /** Actual units (lots already converted) */
  qty: number;
  /** Number of lots for display */
  lots: number;
  /**
   * Client-side last known price — used only as fallback if Kite LTP fetch
   * fails. Server always prefers its own Kite quote fetch.
   */
  client_price: number;
  /** Optional trigger price for SL, SLM, GTT orders */
  trigger_price?: number;
  /** Optional stop loss price for GTT and limit orders */
  stop_loss?: number;
  /** Optional target price for GTT and limit orders */
  target?: number;
  /** Optional flag indicating if this is an exit order */
  is_exit?: boolean;
  /** Optional position ID to directly exit a specific position */
  linked_position_id?: string;
  /** Optional diagnostic fields for UI quote auditing */
  frontend_bid?: number;
  frontend_ask?: number;
  frontend_ltp?: number;
  frontend_quote_time?: number;
  client_click_time?: number;
  orderAttemptId?: string;
}

// ─── Response (POST /api/orders) ─────────────────────────────────────────────
export interface PlaceOrderResponse {
  order_id: string;
  status: OrderStatus;
  fill_price: number;
  message: string;
}

// ─── Platform order row (GET /api/orders) ────────────────────────────────────
export interface MyOrder {
  id: string;
  symbol: string;
  kite_instrument?: string;
  linked_position_id?: string;
  segment: string;
  side: OrderSide;
  status: OrderStatus;
  qty: number;
  lots: number;
  fill_price: number;
  ltp_at_entry: number;
  order_type: OrderType;
  product_type: ProductType;
  info: string | null;
  client_price?: number;
  trigger_price?: number;
  stop_loss?: number;
  target?: number;
  brokerage: number;
  created_at: string;
  is_exit?: boolean;
}

// ─── Platform position row ───────────────────────────────────────────────────
export interface MyPosition {
  id: string;
  symbol: string;
  kite_instrument?: string;
  side: OrderSide;
  status: 'open' | 'active' | 'closed';
  qty_open: number;
  lots?: number;
  qty_total: number;
  avg_price: number;
  entry_price: number;
  exit_price: number | null;
  ltp: number | null;
  pnl: number;
  duration_seconds: number;
  entry_time: string;
  exit_time: string | null;
  settlement: string;
  product_type?: ProductType;
  stop_loss?: number;
  target?: number;
  brokerage: number;
  entry_brokerage?: number;
  exit_brokerage?: number;
  margin_required?: number;
  locked_margin?: number;
  created_at: string;
}

// ─── Close position response (POST /api/positions/[id]/close) ────────────────
export interface ClosePositionResponse {
  pnl: number;
  exit_price: number;
  message: string;
}
