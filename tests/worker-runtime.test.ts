import assert from "node:assert/strict";
import test from "node:test";
import { processQueueBatch } from "../apps/worker/src/worker.ts";

test("worker executes configured handlers and acknowledges jobs", async () => {
  const completed: string[] = [];
  const queue = {
    async claim() { return [{ id: "1", type: "news.discover" as const, tenantId: "t", attempt: 1, idempotencyKey: "abcdefgh" }]; },
    async complete(id: string) { completed.push(id); },
    async retry() {},
    async deadLetter() {}
  };
  const result = await processQueueBatch({
    queue,
    handlers: { "news.discover": async () => {} },
    batchSize: 10,
    maxAttempts: 5,
    now: () => new Date(0)
  });
  assert.equal(result.completed, 1);
  assert.deepEqual(completed, ["1"]);
});
