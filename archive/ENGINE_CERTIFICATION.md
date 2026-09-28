# RupeeFX Trading Position Engine — Production Certification

<!--
  Instructions:
  Complete this document at the end of Phase 3 (Operational Qualification).
  Commit it to the repo root. It becomes the permanent record that this
  engine version is considered production-certified.

  This document is append-only once issued. If a subsequent version is
  certified, create ENGINE_CERTIFICATION_v2.md rather than editing this file.
-->

---

## Identity

| Field | Value |
|-------|-------|
| Engine version | <!-- e.g. 1.0.0 --> |
| Contract version | <!-- e.g. 1.0.0 --> |
| Schema version | <!-- e.g. 1.0.0 --> |
| Release date | <!-- YYYY-MM-DD --> |
| Certification date | <!-- YYYY-MM-DD, after Phase 3 exit criteria met --> |
| Certified by | <!-- name(s) --> |
| Evidence package | <!-- e.g. releases/evidence/2026-08-02_v1.0.0/ --> |
| Package hash | <!-- from COMPLETE sentinel --> |
| Git commit | <!-- full SHA --> |

---

## Phase Sign-Off

| Phase | Status | Sign-Off Date | Signed By |
|-------|--------|---------------|-----------|
| Phase 1 — Code Freeze | <!-- PASS --> | <!-- YYYY-MM-DD --> | <!-- name --> |
| Phase 2 — Release Qualification | <!-- PASS --> | <!-- YYYY-MM-DD --> | <!-- name --> |
| Phase 3 — Operational Qualification | <!-- PASS --> | <!-- YYYY-MM-DD --> | <!-- name --> |

---

## Phase 3 Exit Criteria — Evidence

Complete this section with observed values at the time Phase 3 closed.

| Criterion | Required | Observed | Met? |
|-----------|----------|----------|------|
| Shadow mismatches (unexplained) | 0 for 30 days | | |
| Reconciliation discrepancies | 0 for 30 days | | |
| Sev-1 financial incidents (engine design) | 0 | | |
| P95 `place_order_v2` latency | < 250ms | | |
| P99 `place_order_v2` latency | < 500ms | | |
| Lock wait P95 | < 50ms | | |
| Deadlock count | 0 | | |
| Legacy engine retired | Yes | | |

---

## Notes

<!-- Optional: brief notes on anything unusual observed during Phase 3,
     or decisions made that future maintainers should know about. -->

---

## What This Certifies

This document certifies that Position Engine v<!-- version --> has:

1. Passed all engineering gates (Phase 1)
2. Passed deployment verification, contract tests, regression suite, load tests, and rollback rehearsal (Phase 2)
3. Operated under sustained production traffic with shadow mode parity, clean reconciliation, and SLOs met (Phase 3)

**This is the version considered production-hardened.** Any new version requires repeating the qualification process from Phase 2.

The 90-day post-launch review is scheduled for: <!-- YYYY-MM-DD -->
Review template: `database_v2/docs/POST_LAUNCH_REVIEW_TEMPLATE.md`
