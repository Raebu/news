import { readFileSync, readdirSync } from "node:fs";

const directory = new URL("../db/migrations/", import.meta.url);
const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
if (files.length === 0) throw new Error("No database migrations found.");
const sql = files.map((name) => readFileSync(new URL(name, directory), "utf8")).join("\n");

const requiredTables = [
  "tenants","articles","article_versions","article_sources","claims","claim_sources","article_claims",
  "story_signals","generation_runs","editorial_reviews","media_assets","audit_events",
  "service_credentials","service_credential_tenants","idempotency_records","outbox_events"
];
for (const table of requiredTables) {
  if (!new RegExp(`CREATE TABLE\\s+${table}\\b`, "i").test(sql) &&
      !(table === "tenants" && /CREATE TABLE\s+tenants\b/i.test(sql))) {
    throw new Error(`Missing required table: ${table}`);
  }
}
const invariants = [
  ["featured uniqueness", /one_current_featured_article_per_tenant/i],
  ["article-version immutability", /BEFORE UPDATE OR DELETE ON article_versions/i],
  ["audit append-only", /BEFORE UPDATE OR DELETE ON audit_events/i],
  ["tenant-scoped slug uniqueness", /UNIQUE \(tenant_id, slug\)/i],
  ["signal idempotency", /story_signals_idempotency_unique/i],
  ["audit idempotency", /audit_event_idempotency_unique/i],
  ["credential hash only", /credential_hash text NOT NULL CHECK \(credential_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i],
  ["credential tenant scope", /CREATE TABLE service_credential_tenants/i],
  ["durable idempotency", /CREATE TABLE idempotency_records/i],
  ["outbox dedupe", /UNIQUE \(tenant_id, event_type, dedupe_key\)/i],
  ["outbox dispatch index", /outbox_pending_dispatch_idx/i],
  ["tenant brand policy", /ADD COLUMN brand_config jsonb NOT NULL DEFAULT '\{\}'::jsonb[\s\S]*ADD COLUMN publishing_policy jsonb NOT NULL DEFAULT '\{\}'::jsonb/i]
];
for (const [name, pattern] of invariants) {
  if (!pattern.test(sql)) throw new Error(`Missing migration invariant: ${name}`);
}
process.stdout.write(`Validated ${files.length} migration(s) and ${invariants.length} critical invariants.\n`);
