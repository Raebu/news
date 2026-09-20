# Raeburn Publishing Engine

Production-oriented, multi-tenant publishing engine and AI newsroom for the Raeburn Group. The repository is intentionally separate from consumer websites: websites read published content through a constrained API; AI/research/media workers produce candidates; only the Publisher boundary can make content public.

## Current implementation

This foundation pass establishes:

- npm workspaces for `apps/api`, `apps/admin`, `apps/worker` and shared packages;
- strict TypeScript configuration and pinned Node/npm baseline;
- explicit editorial lifecycle/state-machine invariants;
- fail-closed runtime configuration;
- tenant-scoped service identity boundary;
- idempotency primitives and publisher atomic-write contract;
- health/readiness/version API behavior;
- durable-job type contracts that refuse to run without a queue adapter;
- first PostgreSQL core editorial migration with immutable versions/audit events;
- regression/security/invariant tests and CI/security automation.

## Trust boundaries

1. **GitHub** owns code, schemas, migrations, standards and CI.
2. **Neon PostgreSQL** is the canonical editorial/workflow truth once provisioned.
3. **Cloudinary** is the authoritative media DAM once integrated.
4. **AI services** may propose research, drafts and media; they do not publish.
5. **Publisher** is the only component permitted to transition eligible content to public state.
6. Consumer sites receive published-only credentials/data.

## Local verification

Requires Node `22.16.x`, npm `10.9.x`, and TypeScript `5.8.3` available as `tsc`.

```bash
npm ci
npm run check
```

GitHub CI downloads the exact TypeScript `5.8.3` compiler for the type-check step. No application runtime dependency is currently required.

## Safety

`.env.example` contains names/placeholders only. Never commit real credentials, contact datasets, private source snapshots or production configuration. See `SECURITY.md` and `docs/architecture.md`.
