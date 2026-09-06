# Contributing to NiveshX Trading

## Architecture Freeze Policy

**Effective after Phase 1 (Code Freeze) completion.**

No architectural changes, new infrastructure components, or modifications to the financial engine are permitted unless justified by one of the following:

- a production incident
- measured SLO degradation (with data)
- an audit or compliance requirement
- a documented business requirement

**"This would be nice to have" is not a qualifying reason. Production data drives architectural evolution, not curiosity or speculation.**

### What counts as an architectural change

- New public RPCs or changes to existing RPC signatures
- New database tables that the engine reads or writes
- New TypeScript services that touch financial state
- Changes to the ledger, margin, or FIFO logic
- New governance or deployment infrastructure
- Changes to the contract version, engine version, or schema version

Bug fixes, performance optimizations within existing RPCs, and business logic additions that follow the established patterns do not require an ADR — but they still require the governance audit to pass and the regression suite to run.

### Required process for any approved architectural change

1. Open an ADR in `database_v2/docs/ARCHITECTURE_DECISIONS.md` describing the problem, the options considered, and the decision made. ADRs are append-only — never edit a filed ADR, only supersede it.
2. Update `DATABASE_CONTRACT.md` if the RPC interface changes.
3. Write or update contract tests covering the new behaviour.
4. Run the full regression suite. It must pass.
5. Follow the deployment runbook (`database_v2/docs/DEPLOYMENT_RUNBOOK.md`) for the new version.
6. Produce a release evidence package before beginning operational qualification.

### Why this policy exists

The Position Engine reached architectural maturity after an extended design and validation period. At that point, the risk profile of adding new abstractions inverts: the probability of introducing a regression or an operational blind spot exceeds the probability of gaining meaningful benefit.

The 90-day post-launch review (`database_v2/docs/POST_LAUNCH_REVIEW_TEMPLATE.md`) is the correct venue for deciding whether production evidence justifies a change. If the review concludes the freeze should hold, it holds. If production reveals a genuine bottleneck or recurring friction, the review produces an ADR and the process above applies.

---

## Migration Policy — Migrations Are Immutable

**Never edit an applied migration file.**

Once a migration has been applied to any environment (staging or production), it is frozen. Treat it like a published API: you can add to it by creating a new migration, but you cannot change what already exists.

### Why

The `migration_hash` in `engine_metadata` is a SHA-256 fingerprint of every migration file's name, size, and contents, computed at deploy time. If an applied migration is modified, the next `verify_deployment.ts` run will produce a different hash and flag the discrepancy. That's the detection mechanism — but avoiding the edit in the first place is far better than detecting it after the fact.

More importantly, edited migrations create an inconsistency between environments. If staging ran migration `20260801_rpc_metrics.sql` with content A and production ran it with content B, the two environments are no longer equivalent even though they have the same migration list. That kind of drift is very hard to diagnose later.

### What to do instead

If a migration contains a mistake:

1. Create a new migration file with the next available timestamp prefix.
2. The new migration corrects the mistake (e.g. `ALTER TABLE`, `DROP COLUMN`, `CREATE INDEX IF NOT EXISTS`).
3. Apply it to all environments in sequence.

The original migration stays on disk exactly as applied. The new migration is the correction. The history remains accurate.

### What "applied" means

A migration is considered applied once it has been executed against **any** of:
- local development database
- staging
- production

Before that point — if the migration has only been written locally and not yet run anywhere — editing it is acceptable.

---

## SQL Contract Policy — Public RPCs Are Versioned

Every public-facing database function in `database_v2/rpc/` is a versioned contract. The contract version is tracked in `engine_metadata` and enforced by `ts_audit_checker.ts`.

**Never rename a parameter, change a return type, or change an error message on an existing versioned RPC.**

If behaviour must change:

- **Bug fix with no API surface change:** patch version bump (1.0.0 → 1.0.1), same RPC name
- **Additive change** (new optional parameter, new optional return field): minor version bump (1.0 → 1.1), same RPC name, new entry in `contract_tests_v1_1.sql`
- **Breaking change** (renamed parameter, changed return type, removed parameter): major version bump (1.0 → 2.0), new RPC name (e.g. `place_order_v3`), old RPC kept until all callers migrate

The compatibility rule is: Engine 1.x supports Contract 1.x. Engine 2.x supports Contract 2.x only.

---

## Governance Audit

Before every commit that touches financial logic, run:

```
npx ts-node scripts/ts_audit_checker.ts
```

CI status must be `✅ PASS` (0 CRITICAL, 0 HIGH) before merging. The four LOW violations (profile metadata updates) are permanent and expected.

---

## Deployment

The complete deployment sequence — pre-flight checklist, Phase 2 evidence collection, Phase 3 operational qualification, emergency rollback, and certification — is documented in `database_v2/docs/DEPLOYMENT_RUNBOOK.md`. Follow it in order.

Quick reference for a standard deploy:

After applying migrations:

```
npx ts-node scripts/deploy_position_engine.ts
npx ts-node scripts/verify_deployment.ts
```

Verification must exit 0 before a rollout proceeds. A release manifest is written automatically to `releases/` on every verification run — passed or failed. Manifests are immutable: each run produces a new file; existing files are never edited.

After suites have been run, collect the Phase 2 evidence package:

```
npx ts-node scripts/collect_release_evidence.ts
```

This assembles the release manifest, governance audit, database metadata, and any manually placed test results into `releases/evidence/YYYY-MM-DD_v{version}/`. The package must be complete before Phase 3 (operational qualification) begins.

Set these environment variables to get full identity information in the manifest and evidence package:

```
DEPLOY_ENV=production        # production | staging | local (default: local)
DEPLOY_ID=<pipeline-run-id>  # unique ID from your CI system
CI_WORKFLOW=<workflow-name>  # CI workflow name
CI_ACTOR=<username>          # operator username from CI
```
