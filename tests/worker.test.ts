import assert from "node:assert/strict";
import test from "node:test";
import { validateJob } from "../apps/worker/src/worker.ts";

test("known job with required scope validates", () => {
  validateJob({ id: "job-1", type: "news.publish", tenantId: "raeburn-group", articleId: "article-1", attempt: 1, idempotencyKey: "job-key" });
});

test("article jobs fail closed without article id", () => {
  assert.throws(() => validateJob({ id: "job-2", type: "news.factcheck", tenantId: "raeburn-group", attempt: 1, idempotencyKey: "job-key" }), /missing-article-id/);
});
