# Threat model

## Protected assets
Editorial truth, unpublished content, tenant configuration, service credentials, publisher authority, private media/contact data, audit history and public-channel integrity.

## Trust boundaries
- Public/client traffic -> API.
- Service identities -> tenant context and permission checks.
- Research/source material -> untrusted-data boundary before any AI/tool invocation.
- AI output -> editorial/factual/media gates.
- Publisher -> the only public-state authority.
- Database/outbox -> durable state and side-effect boundary.
- Provider credentials -> environment/provider secret stores only.

## Principal threats and implemented controls
| Threat | Control now | Remaining dependency |
| --- | --- | --- |
| Cross-tenant spoofing | service credential verification + allowed tenant scopes + defensive public-read filtering | production credential store and DB RLS |
| Unauthorized publish | explicit `article:publish`; autonomous publish requires extra permission; PublisherService rechecks READY/gates/version | deployed credential issuer and Neon transaction adapter |
| Replay/double publish | required idempotency key + fingerprint conflict detection + durable schema | Postgres/Upstash idempotency adapter |
| Draft leakage | public article service filters tenant, public state and future `published_at` even if repository returns unsafe candidates | real repository integration tests |
| Credential disclosure | only SHA-256 credential fingerprints are modeled for persistence; secret scan and documented revoke/rotate flow | provider-native secret scanning/rotation |
| Signal injection | strict JSON schema, URL protocol restriction, bounded provenance, signal submission cannot publish | source-fetch SSRF and prompt-injection controls |
| Stale concurrent publish | expected article version checked before atomic repository method | SQL transaction implementation/Neon concurrency test |
| Side-effect loss/duplication | durable outbox schema with tenant/event dedupe | dispatcher/lease implementation |
| Error leakage | stable error envelopes hide unexpected exception details | production log redaction validation |

## Fail-closed rules
Missing auth, missing repository adapters, malformed bodies, missing permissions, stale article versions, failed editorial gates and absent required dependencies refuse the operation rather than degrading to permissive behavior.
