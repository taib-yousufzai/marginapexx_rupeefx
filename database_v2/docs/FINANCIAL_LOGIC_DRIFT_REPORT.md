# Financial Logic Drift Report & Migration Backlog

This report audits the TypeScript codebase to identify all locations where financial calculations (margins, brokerage, P&L, FIFO netting) are performed, derived, or validated outside of the **Position Engine (v1.0.0)**. 

---

## 1. TS Financial Logic Inventory

| File Path | Code Symbol / Line | Financial Formula / Calculation | Recommendation |
| :--- | :--- | :--- | :--- |
| [TradeEngine.ts](file:///c:/Users/Taib/Desktop/Personal/Sidd/marginapexx/lib/trading/TradeEngine.ts) | `validateOrderAndGetMargin` (Line 255) | Calculates leverage margin, brokerage options, and checks available `freeMargin` before execution. | **Remove Logic.** Delete TS-level margin/brokerage formulas. Delegate validation directly to the transaction-bound `place_order_v2` RPC. |
| [orderMatching.ts](file:///c:/Users/Taib/Desktop/Personal/Sidd/marginapexx/lib/orderMatching.ts) | `processLimitOrders` (Line 440) | Manual computation of limit order required margin: `(qty * fill_price) / leverage + brokerage`. | **Remove Logic.** Delegate the execution fill event directly to the database via `place_order_v2` and handle failures natively. |
| [marginSquareOff.ts](file:///c:/Users/Taib/Desktop/Personal/Sidd/marginapexx/lib/marginSquareOff.ts) | `checkUserMarginStatus` (Line 78) | Computes `freeMargin = balance - totalLockedMargin + totalFloatingPnl` to trigger auto square-offs. | **Move to Database.** Delegate square-off checks to a versioned database RPC (e.g., `check_user_square_off()`) to keep the worker logic-free. |
| [liquidationEngine.ts](file:///c:/Users/Taib/Desktop/Personal/Sidd/marginapexx/lib/liquidationEngine.ts) | `processLiquidation` (Line 247) | Manually calculates liquidation P&L and carry brokerages. | **Move to Database.** Shift all liquidation threshold logic and execution path mutations to the database. |
| [floatingPnl.ts](file:///c:/Users/Taib/Desktop/Personal/Sidd/marginapexx/lib/floatingPnl.ts) | `calculateFreeMargin` (Line 65) | Re-implements `freeMargin` calculations in TypeScript for UI display and validation. | **Restrict to Display.** Use strictly for rendering UI dashboard details. Never use for validation of state mutations. |

---

## 2. Refined Boundary Rule (System Rules Amendment)

### System Boundary Definition
We enforce a strict distinction between **Financial Rules** and **Application Rules**:

```text
    ┌───────────────────────────────────┐
    │          TypeScript Layer         │
    │  - "Market Hours are Closed"       │
    │  - "User lacks JWT Admin rights"  │
    │  - "Webhook signature invalid"     │
    └─────────────────┬─────────────────┘
                      │ Validation Success
                      ▼
    ┌───────────────────────────────────┐
    │          Position Engine          │
    │  - "Insufficient Margin balance"  │
    │  - "FIFO Netting Lot Split"       │
    │  - "P&L Ledger Book Posting"      │
    └───────────────────────────────────┘
```

1. **Position Engine (Financial Rules):** Owns all equations and validations for FIFO netting, lot splits, margin locking, brokerage calculation, realized P&L, ledger accounts, and transaction rollbacks.
2. **TypeScript / API Layer (Application Rules):** Owns non-financial workflows, authorization checks, payload structure formats (types, required fields), authentication, rate limiting, and market-hours constraints.
