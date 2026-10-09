# Engine Evolution & Timeline Spec

This timeline captures the transition milestones of the MarginApex Position Engine architecture.

---

## 1. Engine Evolution Path

```mermaid
timeline
    title Position Engine Version Milestones
    v0 : Legacy Engine : Trigger-based calculations : Direct table mutations : Race condition prone
    v1.0 : Centralization : SQL transactional RPCs : FIFO lot split netting : Multi-user isolation
    v1.1 : Verification & Telemetry : Concurrency load testing : Historical metric views : Contention mapping
    v1.2 : Shadow Mode : Parallel rolled-back execution : Diff logs with Correlation IDs : Automatic disable bounds
    v2.0 : Production Cutover : 1% to 100% phased cutover : Legacy cleanup and trigger retirement
```

---

## 2. Release & Version Scope

- **v1.0.0 (Hard Freeze)**:
  - Centralized financial validation inside Postgres transaction blocks.
  - Eliminated TS-side margin/brokerage checking math duplicate logic.
  - Enforced `place_order_v2` and `close_position_v2` as authoritative API boundaries.
- **v1.1.0 (Telemetry & Load)**:
  - Historical `rpc_metrics` logging table.
  - Concurrency load tests (Vitest Scenarios 1-5).
  - Telemetry views for locks, recon, and index efficiency.
- **v1.2.0 (Shadow Mode)**:
  - Sub-transaction rollback runner (`run_shadow_order_v2`).
  - Correlation ID comparison framework and mismatch logging.
