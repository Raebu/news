# ADR 0002 — Tenant scope and article state

**Status:** Accepted

All data/configuration is tenant-scoped. Tenant identity must be derived from verified service identity or trusted domain/session context, never blindly trusted from an arbitrary client parameter. Article state follows the version-controlled lifecycle in `packages/domain/src/article-state.ts`; publication requires `READY` plus all configured evidence/QA gates.
