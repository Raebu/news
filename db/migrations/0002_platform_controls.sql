BEGIN;

ALTER TABLE tenants
  ADD COLUMN primary_domain text,
  ADD COLUMN brand_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN publishing_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_primary_domain_format
  CHECK (primary_domain IS NULL OR primary_domain ~ '^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?$');

CREATE UNIQUE INDEX tenants_primary_domain_unique
  ON tenants (lower(primary_domain))
  WHERE primary_domain IS NOT NULL;

ALTER TABLE story_signals
  ADD COLUMN schema_version text NOT NULL DEFAULT '1',
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX story_signals_idempotency_unique
  ON story_signals (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE service_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service text NOT NULL CHECK (service ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  credential_hash text NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  permissions text[] NOT NULL CHECK (cardinality(permissions) > 0),
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (service, credential_hash),
  CHECK (NOT active OR revoked_at IS NULL)
);

CREATE TABLE service_credential_tenants (
  credential_id uuid NOT NULL REFERENCES service_credentials(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (credential_id, tenant_id)
);

CREATE INDEX service_credentials_active_lookup
  ON service_credentials (service, active, expires_at);

CREATE TABLE idempotency_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16,128}$'),
  state text NOT NULL CHECK (state IN ('processing','completed','failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, idempotency_key),
  CHECK (state <> 'completed' OR result IS NOT NULL)
);

CREATE INDEX idempotency_records_processing_idx
  ON idempotency_records (updated_at)
  WHERE state = 'processing';

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  dedupe_key text NOT NULL,
  trace_id text,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','dispatched','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  dispatched_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_type, dedupe_key)
);

CREATE INDEX outbox_pending_dispatch_idx
  ON outbox_events (available_at, created_at)
  WHERE state = 'pending';

COMMIT;
