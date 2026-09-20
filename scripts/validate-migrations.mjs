import { readFileSync, readdirSync } from "node:fs";

const directory = new URL("../db/migrations/", import.meta.url);
const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
if (files.length === 0) throw new Error("No database migrations found.");
const sql = files.map((name) => readFileSync(new URL(name, directory), "utf8")).join("\n");

const requiredTables = [
  "tenants","articles","article_versions","article_sources","claims","claim_sources","article_claims",
  "story_signals","generation_runs","editorial_reviews","media_assets","audit_events"
];
for (const table of requiredTables) {
  if (!new RegExp(`CREATE TABLE\\s+${table}\\b`, "i").test(sql)) throw new Error(`Missing required table: ${table}`);
}
const invariants = [
  ["featured uniqueness", /one_current_featured_article_per_tenant/i],
  ["article-version immutability", /BEFORE UPDATE OR DELETE ON article_versions/i],
  ["audit append-only", /BEFORE UPDATE OR DELETE ON audit_events/i],
  ["tenant-scoped slug uniqueness", /UNIQUE \(tenant_id, slug\)/i],
  ["signal idempotency", /UNIQUE \(tenant_id, dedupe_key\)/i],
  ["audit idempotency", /audit_event_idempotency_unique/i]
];
for (const [name, pattern] of invariants) {
  if (!pattern.test(sql)) throw new Error(`Missing migration invariant: ${name}`);
}
process.stdout.write(`Validated ${files.length} migration(s) and ${invariants.length} critical invariants.\n`);
