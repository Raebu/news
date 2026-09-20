# Local development

The development baseline is deliberately incapable of silently targeting production. `.env.example` uses placeholders; staging/production configuration enforces TLS; API readiness returns `503` until a real database readiness adapter is injected; the worker refuses to poll when no durable queue adapter is configured.

Run `npm run check` before proposing changes. Test fixtures use synthetic tenant/article identifiers only.
