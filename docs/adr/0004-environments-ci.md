# ADR 0004 — Environments and CI

**Status:** Accepted

Development, staging and production must use separate databases, credentials, media namespaces and provider configuration. CI runs least-privilege source checks, type checks, tests, migration invariants, secret-pattern checks and dependency audit. Production provider/deployment evidence is not inferred from green source CI.
