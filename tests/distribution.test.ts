import assert from "node:assert/strict";
import test from "node:test";
import { distributeContent } from "../packages/distribution/src/distribution.ts";

test("distribution is channel-scoped and skips missing adapters", async () => {
  const content = {
    id: "pkg-1", tenantId: "tenant-1", articleId: "article-1", articleVersion: 1,
    canonicalUrl: "https://example.com/news/a", headline: "Headline", standfirst: "Standfirst",
    body: "Body", channels: ["website", "newsletter"] as const, createdAt: new Date(0).toISOString()
  };
  const results = await distributeContent(content, [{
    channel: "website" as const,
    async deliver() { return { channel: "website" as const, status: "delivered" as const, externalId: "1" }; }
  }], "dist");
  assert.deepEqual(results.map((result) => result.status), ["delivered", "skipped"]);
});
