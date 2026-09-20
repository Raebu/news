# Architecture baseline

## Scope

V1 focuses on the first-party Raeburn Group publishing engine: tenant-safe editorial data, evidence-backed generation, media workflow, controlled publication, consumer read APIs and distribution primitives. Semantic/vector search, self-service SaaS billing and rich-media expansion are deferred until core production evidence exists.

## Runtime boundaries

- `apps/api`: public/internal HTTP boundary; public reads must be published-only.
- `apps/worker`: durable job consumer once queue adapter is configured.
- `apps/admin`: authenticated operations/editorial control centre (scaffold only today).
- `packages/domain`: lifecycle and publication invariants.
- `packages/security`: tenant/service authorization boundary.
- `packages/workflow`: replay/idempotency primitives.
- `packages/publisher`: controlled public-state transition service.
- `db/migrations`: canonical relational schema changes.

## Delivery-state truth

Source implementation is not treated as deployed or production-ready. Provider resources, hosted data stores, real credentials, branch protection, production deployment and legal/compliance approvals remain external or future evidence.
