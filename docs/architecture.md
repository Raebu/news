# Architecture

## Scope

The Raeburn Publishing Engine is shared first-party infrastructure for multiple brands, sites and executive-authority surfaces. It covers story signals, research, source verification, article generation, claim checks, media, editorial QA, controlled publication and distribution.

## Runtime boundaries

- `apps/api`: authenticated service boundary, health/readiness and published-only reads.
- `apps/worker`: durable newsroom-job and outbox processing primitives with retry/dead-letter behavior.
- `apps/admin`: reserved operations/editorial surface; business actions must use the same authenticated service boundaries.
- `packages/newsroom`: evidence-gated research/draft/fact-check/media/editorial orchestration.
- `packages/distribution`: content-package fan-out with per-channel idempotency.
- `packages/providers`: outbound provider adapters; provider failures cannot bypass editorial gates.
- `packages/domain`: lifecycle and publication invariants.
- `packages/security`: tenant/service authorization.
- `packages/workflow`: idempotency, outbox leases and delivery recovery.
- `packages/publisher`: sole public-state transition boundary.
- `db/migrations`: canonical relational schema.

## Pipeline

Signals → Research → Draft → Claim verification → Media → Image QA → Editorial QA → READY → Publisher → Content package → Distribution.

No generation or distribution provider is permitted to mutate an article directly to a public state. Autonomous publication remains an explicit tenant policy and separate permission.

## Data ownership

PostgreSQL holds canonical editorial/workflow truth. External systems store media or receive distributions, while their external identifiers are recorded against tenant-scoped records. Provider secrets are injected by the deployment platform and represented in tenant configuration by secret references only.

## Failure semantics

All retriable work is idempotent. Queue and outbox records use bounded retries, leases and dead-letter states. Unsupported/missing gated providers fail closed. Missing optional distribution adapters produce an observable skipped delivery instead of blocking canonical publication.

## Production evidence

A source merge does not prove production readiness. Production requires executed migrations, configured credentials/adapters, protected release controls, deployed workloads and verified end-to-end smoke tests.
