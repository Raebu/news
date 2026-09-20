BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  slug text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'DISCOVERED','RESEARCHING','CANDIDATE','DRAFTING','FACT_CHECK','IMAGE_GENERATION','EDITORIAL_QA',
    'READY','PUBLISHED','UPDATED','ARCHIVED','REJECTED','DUPLICATE','INSUFFICIENT_EVIDENCE',
    'QA_FAILED','GENERATION_FAILED','RETRACTED'
  )),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  lock_version integer NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  featured boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  archived_at timestamptz,
  retracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  CHECK ((status IN ('PUBLISHED','UPDATED')) = (published_at IS NOT NULL) OR status IN ('ARCHIVED','RETRACTED'))
);

CREATE UNIQUE INDEX one_current_featured_article_per_tenant
  ON articles (tenant_id)
  WHERE featured = true AND status IN ('PUBLISHED','UPDATED');
CREATE INDEX articles_public_feed_idx ON articles (tenant_id, published_at DESC)
  WHERE status IN ('PUBLISHED','UPDATED');
CREATE INDEX articles_workflow_idx ON articles (tenant_id, status, updated_at);

CREATE TABLE article_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  headline text NOT NULL,
  standfirst text,
  body jsonb NOT NULL,
  category text,
  seo_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  social_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  model text,
  prompt_version text,
  schema_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(article_id, version)
);

CREATE TABLE article_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  source_type text NOT NULL,
  organisation text,
  trust_class text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  claim_text text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('pending','supported','conflicted','unsupported')),
  confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claim_sources (
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES article_sources(id) ON DELETE CASCADE,
  support_type text NOT NULL CHECK (support_type IN ('supports','contradicts','context')),
  PRIMARY KEY (claim_id, source_id)
);

CREATE TABLE article_claims (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  version integer NOT NULL,
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  material boolean NOT NULL DEFAULT true,
  PRIMARY KEY (article_id, version, claim_id),
  FOREIGN KEY (article_id, version) REFERENCES article_versions(article_id, version) ON DELETE CASCADE
);

CREATE TABLE story_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  signal_type text NOT NULL,
  title text NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  importance integer NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 100),
  event_at timestamptz NOT NULL,
  dedupe_key text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE TABLE generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  article_id uuid REFERENCES articles(id) ON DELETE SET NULL,
  run_type text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  input_ref text,
  output_ref text,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor >= 0),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE editorial_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_version integer NOT NULL,
  gate text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('passed','failed','pending','overridden')),
  score numeric(5,4) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewer text NOT NULL,
  exception_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (article_id, article_version) REFERENCES article_versions(article_id, version) ON DELETE CASCADE
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  article_id uuid REFERENCES articles(id) ON DELETE SET NULL,
  cloudinary_asset_id text NOT NULL,
  cloudinary_public_id text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  alt_text text,
  qa_status text NOT NULL DEFAULT 'pending' CHECK (qa_status IN ('pending','passed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cloudinary_asset_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  article_id uuid REFERENCES articles(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human','service','agent','system')),
  actor_id text NOT NULL,
  idempotency_key text,
  trace_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX audit_event_idempotency_unique
  ON audit_events (tenant_id, idempotency_key, event_type)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX audit_events_article_idx ON audit_events (tenant_id, article_id, created_at DESC);

CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable record cannot be updated or deleted';
END;
$$;
CREATE TRIGGER article_versions_are_immutable
  BEFORE UPDATE OR DELETE ON article_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER audit_events_are_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

COMMIT;
