# Operations and production handoff

## Runtime contract

The repository now contains the full source-side boundaries for discovery, research, drafting, fact checking, media QA, editorial QA, controlled publishing, content packaging and distribution. Provider credentials are never stored in Git and tenant provider bindings hold secret references only.

Production composition must supply:

- PostgreSQL implementing migrations 0001-0003;
- repository adapters for articles, signals, credentials, idempotency, newsroom jobs and outbox leases;
- one or more research/drafting/fact-check/media providers;
- distribution adapters for only the channels enabled by each tenant;
- deployment secrets through the hosting platform.

## Required production gates

1. Run every SQL migration against the canonical PostgreSQL database.
2. Create tenant rows and service credentials with least-privilege permissions.
3. Configure secret references for external providers.
4. Keep autonomous publishing disabled until editorial evidence demonstrates it is safe.
5. Run `npm run check` before release.
6. Verify `/healthz`, `/readyz`, authenticated article reads, signal submission and controlled publication.
7. Enable branch protection on `main` requiring CI and CodeQL.
8. Monitor dead-letter newsroom jobs, outbox events and distribution deliveries.

## Failure model

Provider failures do not bypass gates. Missing adapters skip only non-essential distribution channels; publishing itself remains controlled by the Publisher boundary. Queue/outbox work uses leases, bounded retry and dead-letter states so failures are observable and replayable.
