import assert from "node:assert/strict";
import test from "node:test";
import { PublicArticleService, type PublicArticleRecord, type PublicArticleRepository } from "../packages/articles/src/public-articles.ts";

const records: readonly PublicArticleRecord[] = [
  { id:"a1", tenantId:"raeburn-group", slug:"published", status:"PUBLISHED", version:1, headline:"Published", standfirst:null, body:{ok:true}, category:null, publishedAt:"2026-09-19T12:00:00.000Z", updatedAt:"2026-09-19T12:00:00.000Z", featured:true },
  { id:"a2", tenantId:"raeburn-group", slug:"updated", status:"UPDATED", version:2, headline:"Updated", standfirst:null, body:{ok:true}, category:"group", publishedAt:"2026-09-19T13:00:00.000Z", updatedAt:"2026-09-19T14:00:00.000Z", featured:false },
  { id:"a3", tenantId:"raeburn-group", slug:"draft", status:"DRAFTING", version:1, headline:"Secret draft", standfirst:null, body:{secret:true}, category:null, publishedAt:null, updatedAt:"2026-09-19T15:00:00.000Z", featured:false },
  { id:"a4", tenantId:"raeburn-group", slug:"future", status:"PUBLISHED", version:1, headline:"Future", standfirst:null, body:{future:true}, category:null, publishedAt:"2026-09-21T00:00:00.000Z", updatedAt:"2026-09-19T15:00:00.000Z", featured:false },
  { id:"a5", tenantId:"other-tenant", slug:"other", status:"PUBLISHED", version:1, headline:"Other tenant", standfirst:null, body:{secret:true}, category:null, publishedAt:"2026-09-19T10:00:00.000Z", updatedAt:"2026-09-19T10:00:00.000Z", featured:false }
];

const repository: PublicArticleRepository = {
  async listCandidates() { return { records, nextCursor: null }; },
  async findCandidateBySlug(_tenantId, slug) { return records.find((record) => record.slug === slug) ?? null; }
};

test("public article list defensively removes drafts, future publications and cross-tenant records", async () => {
  const service = new PublicArticleService(repository, () => new Date("2026-09-20T06:00:00.000Z"));
  const result = await service.list({ tenantId:"raeburn-group", limit:20, cursor:null });
  assert.deepEqual(result.articles.map((article) => article.slug), ["published","updated"]);
  assert.equal(result.articles.some((article) => "tenantId" in article), false);
});

test("slug lookup returns not-found semantics for draft and cross-tenant candidates", async () => {
  const service = new PublicArticleService(repository, () => new Date("2026-09-20T06:00:00.000Z"));
  assert.equal((await service.getBySlug("raeburn-group", "published"))?.headline, "Published");
  assert.equal(await service.getBySlug("raeburn-group", "draft"), null);
  assert.equal(await service.getBySlug("raeburn-group", "other"), null);
});
