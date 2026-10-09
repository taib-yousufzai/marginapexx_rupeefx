# Incident Playbook (Position Engine)

This playbook outlines diagnosis and remediation protocols for critical incidents in the MarginApex Position Engine.

---

## 1. Incident Playbook Directory

### Incident 1: Duplicate Execution / Idempotency Collision
- **Symptoms**:
  - Distinct transactions created with identical ref_ids or overlapping execution timestamps.
  - Profile balances decremented multiple times for a single order intent.
- **Diagnosis Query**:
  ```sql
  SELECT idempotency_key, count(*)
  FROM public.orders
  GROUP BY idempotency_key
  HAVING count(*) > 1;
  ```
- **Immediate Action**:
  - Identify calling client / webhook source.
  - Temporarily block the offending client key or API route.
- **Recovery**:
  - Reconcile ledger using `public.v_telemetry_financial_recon` view.
  - Issue offset transaction (`CREDIT` or `DEPOSIT` adjustments) to correct balance.

---

### Incident 2: Balance & Ledger Mismatch
- **Symptoms**:
  - `ledger_discrepancy` column in `public.v_telemetry_financial_recon` is non-zero.
- **Diagnosis Query**:
  ```sql
  SELECT * FROM public.v_telemetry_financial_recon
  WHERE ledger_discrepancy != 0;
  ```
- **Immediate Action**:
  - Set profile `active = false` for affected users to prevent further execution.
- **Recovery**:
  - Perform historical ledger sum validation.
  - Correct `profiles.balance` to match the transaction ledger sum inside a single synchronous transaction.

---

### Incident 3: Deadlock Spike
- **Symptoms**:
  - RPC calls fail with error code `40P01` (deadlock_detected).
  - P95 latency spikes > 500ms.
- **Diagnosis Query**:
  ```sql
  SELECT * FROM public.v_telemetry_locking;
  ```
- **Immediate Action**:
  - Kill blocking transaction processes using `pg_terminate_backend(blocking_pid)`.
- **Recovery**:
  - Verify all concurrent processes strictly acquire locks in the hierarchy: Profiles → Positions → Orders → Transactions.

---

### Incident 4: Shadow Mode Mismatch
- **Symptoms**:
  - Discrepancy counts logged to `shadow_mismatch_logs`.
  - Auto-shutoff triggered (mismatch rate > 1%).
- **Diagnosis Query**:
  ```sql
  SELECT * FROM public.v_telemetry_shadow_logs LIMIT 10;
  ```
- **Immediate Action**:
  - Review diff outputs to isolate the diverging field (e.g. margin calculation rounding).
- **Recovery**:
  - Refine v2 logic or parameters to align perfectly with legacy state outcomes, and reset the shadow comparator.
