# Database API Contract Specification (v1.0.0)

This document defines the immutable API contracts for the MarginApex transactional RPC interfaces. Any changes to these interfaces require a new version (e.g. `_v3`) to ensure backwards compatibility.

---

## 1. RPC Contracts

### 1.1 `place_order_v2`
- **Input Parameters:**
  - `p_user_id` (uuid)
  - `p_symbol` (text)
  - `p_kite_inst` (text)
  - `p_segment` (text)
  - `p_side` (text: `BUY` | `SELL`)
  - `p_order_type` (text: `MARKET` | `LIMIT` | `SL` | `SLM` | `GTT`)
  - `p_product_type` (text: `INTRADAY` | `CARRY`)
  - `p_qty` (numeric)
  - `p_lots` (numeric)
  - `p_ltp` (numeric)
  - `p_fill_price` (numeric)
  - `p_is_exit` (boolean)
  - `p_buffer_fee` (numeric)
  - `p_status` (text: `EXECUTED` | `PENDING` | `REJECTED`)
  - `p_trigger_price` (numeric DEFAULT NULL)
  - `p_stop_loss` (numeric DEFAULT NULL)
  - `p_target` (numeric DEFAULT NULL)
  - `p_info` (text DEFAULT NULL)
  - `p_expected_margin` (numeric DEFAULT 0)
  - `p_expected_brokerage` (numeric DEFAULT 0)
  - `p_idempotency_key` (text DEFAULT NULL)
- **Output:** `uuid` (Order ID)
- **Assertions:**
  - If a duplicate `p_idempotency_key` is submitted concurrently, the RPC intercepts the `unique_violation` constraint and returns the existing committed `Order ID` without duplicate transactions.

### 1.2 `close_position_v2`
- **Input Parameters:**
  - `p_position_id` (uuid)
  - `p_close_qty` (numeric)
  - `p_close_price` (numeric)
  - `p_closed_by` (text: `USER` | `ADMIN` | `SYSTEM` | `LIQUIDATION`)
  - `p_expected_brokerage` (numeric DEFAULT 0)
  - `p_idempotency_key` (text DEFAULT NULL)
- **Output:** `numeric` (Realized P&L)
- **Assertions:**
  - Re-validates the locked margin proportionally: releases `(locked_margin * close_qty) / qty_open` and debits/credits P&L transactionally.

---

## 2. Invariant Contracts

1. **Balance Integrity Constraint**:
   - `profiles.balance` must exactly equal `DEPOSIT` minus `WITHDRAWAL` sums plus/minus transaction-ledger credits and debits.
2. **Open Lot Boundaries**:
   - Open positions (`status = 'open'`) must have `qty_open > 0` and `locked_margin > 0`.
3. **Closed Lot Boundaries**:
   - Closed positions (`status = 'closed'`) must have `qty_open = 0` and `locked_margin = 0`.
