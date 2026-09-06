# NiveshX Trading: Position Engine Production Runbook (v1.0.0)

This document provides operational recovery steps and diagnostic procedures for the **Position Engine (v1.0.0)** production lifecycle.

---

## 1. Incident: Order Duplication / Multiple Executions

### Symptom
A client reports duplicate orders executed in close succession, or the transactions ledger shows multiple debits for a single intent.

### Step 1: Diagnose
Run the diagnostic queries below to isolate the source of the duplication:

```sql
-- 1. Check Idempotency Key presence and duplicates
SELECT user_id, idempotency_key, count(*)
FROM public.orders
WHERE idempotency_key IS NOT NULL
GROUP BY user_id, idempotency_key
HAVING count(*) > 1;

-- 2. Inspect ledger entries matching the transaction
SELECT id, user_id, type, amount, status, ref_id, created_at
FROM public.transactions
WHERE ref_id LIKE '%idemp%';

-- 3. Verify positions corresponding to the duplicates
SELECT id, user_id, symbol, qty_open, status, entry_time
FROM public.positions
WHERE user_id = :user_id AND symbol = :symbol;
```

### Step 2: Corrective Action & Recovery
1. **Identify the duplicate transaction IDs** and matching position chunks.
2. If duplicate positions were opened:
   - Call the internal adjustment procedure to offset the duplicate quantity.
   - Manually insert a balancing ledger entry with type `WITHDRAWAL` or `PNL_CREDIT` / `PNL_DEBIT` depending on the P&L discrepancy.
3. Update the duplicate order statuses to `FAILED` in the database.

---

## 2. Incident: High Database Latency / Lock Waits

### Symptom
Application logs show connection timeouts, HTTP 504 errors on `/api/orders`, or RPC latencies exceed SLA thresholds.

### Step 1: Inspect Lock Waits & Blocked Queries
Identify active transaction locks and blockages:

```sql
-- View blocked and blocking queries
SELECT
    blocked_locks.pid     AS blocked_pid,
    blocked_activity.usename  AS blocked_user,
    blocking_locks.pid    AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocked_activity.query    AS blocked_statement,
    blocking_activity.query   AS blocking_statement
FROM  pg_catalog.pg_locks         blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks         blocking_locks 
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

### Step 2: Remediate Lock Blockage
1. If a blocking process is orphaned or hanging, terminate it:
   ```sql
   SELECT pg_terminate_backend(blocking_pid);
   ```
2. Check if a high-concurrency event (e.g., liquidation storm) is occurring. Ensure client connections are rate-limited.

---

## 3. Incident: Shadow Mode Mismatch

### Symptom
Automated comparisons between Legacy Engine execution and Position Engine v2 show mismatches in quantities, P&L, or margins.

### Step 1: Do NOT Cut Over Traffic
*   **CAUTION:** Immediate freeze on the migration pipeline. Do not promote or route automated traffic to the v2 engine.

### Step 2: Collect Telemetry & Discrepancies
Extract all debugging snapshots for the mismatch event:
1. **Correlation ID / Order ID**: Locate the order that generated the diff.
2. **Retrieve Engine Outputs**:
   ```sql
   SELECT * FROM public.orders WHERE id = :order_id;
   ```
3. **Compare Ledger States**:
   Verify legacy transactions vs v2 transactions matching the order timestamp.

---

## 4. Rollback and Recovery Workflow

If a production cutover shows critical regressions, execute the following steps:

1. **Revert API Layer routing**:
   Set `app.is_v2` setting or code configuration back to `false` to redirect write actions to the legacy code path.
2. **Restore Migration State**:
   Apply the database rollback script to restore legacy trigger logic:
   ```bash
   psql -h db.cpcvklekwwawgtgbyrmp.supabase.co -U postgres -f supabase/migrations/20260731_isolate_legacy_triggers.sql
   ```
3. **Confirm Verification**:
   Run sanity check smoke tests on the legacy paths to assert system stability.
