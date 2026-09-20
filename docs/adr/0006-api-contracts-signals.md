# ADR 0006 — API contracts and signal ingestion

## Decision
The HTTP boundary uses explicit JSON contracts and stable error envelopes. `POST /publish` delegates to the Publisher service and requires idempotency. `POST /api/newsroom/signals` is schema-validated and idempotent but has no path to publication. Public reads are separate authenticated endpoints.

The OpenAPI 3.1 document under `docs/openapi.json` is validated in CI against required protected routes.

## Consequences
Database/provider adapters remain separately deployable dependencies. Missing auth or service adapters fail closed with 503/401/403 rather than bypassing controls.
