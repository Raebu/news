# ADR 0003 — Durable workflow and idempotency

**Status:** Accepted

Long-running newsroom work is decomposed into durable jobs with explicit job types. Every side-effecting command/job carries an idempotency key. Same-key/different-input reuse is rejected. Retrying a failed side effect requires an explicit new retry key until the durable store adapter supports audited compare-and-set retry transitions.
