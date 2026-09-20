# Data model baseline

```mermaid
erDiagram
  TENANTS ||--o{ ARTICLES : owns
  ARTICLES ||--o{ ARTICLE_VERSIONS : versions
  ARTICLES ||--o{ ARTICLE_SOURCES : cites
  ARTICLES ||--o{ ARTICLE_CLAIMS : maps
  CLAIMS ||--o{ ARTICLE_CLAIMS : supports
  CLAIMS ||--o{ CLAIM_SOURCES : evidence
  ARTICLE_SOURCES ||--o{ CLAIM_SOURCES : evidence
  TENANTS ||--o{ STORY_SIGNALS : receives
  TENANTS ||--o{ SERVICE_CREDENTIAL_TENANTS : scopes
  SERVICE_CREDENTIALS ||--o{ SERVICE_CREDENTIAL_TENANTS : grants
  TENANTS ||--o{ IDEMPOTENCY_RECORDS : isolates
  TENANTS ||--o{ OUTBOX_EVENTS : emits
```

`article_versions` and `audit_events` are append-only/immutable at the database layer. `idempotency_records` owns durable command replay state. `outbox_events` separates committed state from external cache/distribution side effects.

Retention periods are intentionally not invented here: source snapshots, contact data, audit history and generated media require policy/legal decisions before hard-coded deletion windows are introduced.
