# Raeburn Publishing Engine

Production-oriented, multi-tenant publishing engine and AI newsroom for the Raeburn Group. The repository is intentionally separate from consumer websites: websites read published content through a constrained API; AI/research/media workers produce candidates; only the Publisher boundary can make content public.

## Current implementation

The engineering baseline now includes:

- npm workspaces for `apps/api`, `apps/admin`, `apps/worker` and shared packages;
- strict TypeScript configuration and pinned Node/npm baseline;
- explicit editorial lifecycle/state-machine invariants;
- fail-closed runtime configuration and tenant-scoped service identity boundaries;
- hashed/revocable service-credential definitions with per-tenant permissions;
- authenticated `POST /publish` routing into the Publisher boundary;
- authenticated, defensively filtered `GET /articles` and `GET /articles/:slug` public-read services;
- schema-validated, idempotent `POST /api/newsroom/signals` ingestion that cannot publish;
- idempotency primitives, durable idempotency/outbox schema and publisher atomic-write contract;
- health/readiness/version API behavior;
- PostgreSQL editorial/platform-control migrations with immutable versions/audit events;
- OpenAPI 3.1 contract validation, threat model and data-model documentation;
- regression/security/invariant tests plus CI, dependency audit and CodeQL automation.

## Trust boundaries

1. **GitHub** owns code, schemas, migrations, standards and CI.
2. **Neon PostgreSQL** is the canonical editorial/workflow truth once provisioned.
3. **Cloudinary** is the authoritative media DAM once integrated.
4. **AI services** may propose research, drafts and media; they do not publish.
5. **Publisher** is the only component permitted to transition eligible content to public state.
6. Consumer sites use tenant-scoped credentials with `article:read` only.
7. Missing provider adapters or credentials fail closed rather than falling back to permissive behavior.

## Local verification

Requires Node `22.16.x`, npm `10.9.x`, and TypeScript `5.8.3` available as `tsc`.

```bash
npm ci
npm run check
```

GitHub CI downloads the exact TypeScript `5.8.3` compiler for the type-check step.

## Delivery-state truth

HTTP contracts, service-auth controls and migrations in source are not the same as deployed production infrastructure. Real Neon execution, durable provider adapters, issued production credentials, Cloudinary/Resend integration and production deployment are tracked separately and are not claimed complete until externally verified.

## Safety

`.env.example` contains names/placeholders only. Never commit real credentials, contact datasets, private source snapshots or production configuration. See `SECURITY.md`, `docs/threat-model.md` and `docs/architecture.md`.
