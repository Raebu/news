# Raeburn Publishing Engine

Multi-tenant AI newsroom and controlled publishing infrastructure for the Raeburn Group. Consumer websites read only published content through the constrained API. Research, generation, media and distribution operate behind tenant boundaries, and only the Publisher boundary can make an article public.

## Implemented source architecture

- strict TypeScript monorepo with API, worker and shared packages;
- tenant-scoped service authentication and least-privilege permissions;
- editorial lifecycle and controlled Publisher boundary;
- authenticated published-only article reads and idempotent signal ingestion;
- evidence-gated newsroom pipeline: research → draft → fact check → media QA → editorial QA;
- durable newsroom-job, idempotency and outbox data models with retry/dead-letter semantics;
- immutable article versions and append-only audit events;
- content packages and channel-specific distribution delivery tracking;
- provider boundary plus Resend newsletter and generic webhook distribution adapters;
- Docker/Compose production packaging, health checks and operational runbook;
- migration, contract, security, state-machine, pipeline, outbox, worker and distribution tests;
- CI, dependency audit and CodeQL automation.

## Trust boundaries

1. **GitHub** owns source, schemas, migrations, contracts, standards and CI.
2. **Neon PostgreSQL** is the canonical editorial/workflow truth once production provisioning is applied.
3. **Cloudinary** is the intended authoritative media DAM.
4. **AI/research services** can propose material; they cannot directly publish.
5. **Publisher** alone transitions eligible material to public state.
6. Consumer sites use tenant-scoped credentials with `article:read` only.
7. Missing credentials/providers fail closed for gated editorial stages.
8. Non-essential distribution channels may be skipped when their adapter is not configured; that never weakens the publish gate.

## Local verification

Requires Node `22.16.x`, npm `10.9.x`, and TypeScript `5.8.3`.

```bash
npm ci
npm run check
```

Run the API:

```bash
RAEBURN_START_SERVER=true npm run api
```

Or build the container:

```bash
docker compose up --build
```

## Production handoff

Source completeness is separate from live infrastructure evidence. Before a production claim, apply migrations 0001-0003 to the canonical PostgreSQL database, issue real least-privilege service credentials, bind provider secret references, compose the database/job adapters in the deployment environment, deploy, and verify readiness plus end-to-end publication. See `docs/operations.md`.

## Safety

Never commit live credentials, private contact datasets, source snapshots or production configuration. See `SECURITY.md`, `docs/threat-model.md`, `docs/architecture.md` and `docs/operations.md`.
