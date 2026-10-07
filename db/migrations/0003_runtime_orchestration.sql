BEGIN;

CREATE TABLE newsroom_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  article_id uuid REFERENCES articles(id) ON DELETE SET NULL,
  signal_id uuid REFERENCES story_signals(id) ON DELETE SET NULL,
  stage text NOT NULL CHECK (stage IN (
    'discover','research','draft','factcheck','image','image_qa','editorial_qa','ready','publish','distribute'
  )),
  state text NOT NULL CHECK (state IN ('queued','processing','completed','failed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  last_error_code text,
  trace_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, stage, idempotency_key)
);

CREATE INDEX newsroom_runs_claim_idx
  ON newsroom_runs (available_at, created_at)
  WHERE state = 'queued';

CREATE TABLE content_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_version integer NOT NULL,
  canonical_url text NOT NULL,
  headline text NOT NULL,
  standfirst text NOT NULL,
  body text NOT NULL,
  image_url text,
  channels text[] NOT NULL DEFAULT ARRAY['website']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, article_id, article_version),
  FOREIGN KEY (article_id, article_version)
    REFERENCES article_versions(article_id, version) ON DELETE RESTRICT
);

CREATE TABLE distribution_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content_package_id uuid NOT NULL REFERENCES content_packages(id) ON DELETE CASCADE,
  channel text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','processing','delivered','failed','skipped','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  external_id text,
  error_code text,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, idempotency_key)
);

CREATE INDEX distribution_deliveries_claim_idx
  ON distribution_deliveries (available_at, created_at)
  WHERE state IN ('pending','failed');

CREATE TABLE tenant_provider_bindings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  purpose text NOT NULL,
  secret_ref text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, purpose),
  CHECK (secret_ref !~* '(api[_-]?key|token|password|secret)[=:]')
);

ALTER TABLE outbox_events
  ADD COLUMN lock_token uuid;

CREATE INDEX outbox_processing_lease_idx
  ON outbox_events (locked_at)
  WHERE state = 'processing';

COMMIT;
