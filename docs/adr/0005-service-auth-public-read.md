# ADR 0005 — Service authentication and public-read isolation

## Decision
Internal and consumer services authenticate as scoped service identities. Credentials are represented by one-way SHA-256 fingerprints, may be independently revoked/expired, and carry explicit allowed tenants and permissions.

Consumer websites use `article:read`; they do not inherit generation, signal-submission or publish rights. Tenant context is accepted only after credential verification. Public article services defensively re-check tenant, public lifecycle state and `published_at` even if a repository adapter returns unsafe candidates.

## Consequences
Production still requires an issued credential store/adapter and rotation process. Source-level controls do not constitute production credential issuance.
