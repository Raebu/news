import assert from "node:assert/strict";
import test from "node:test";
import { pumpOutbox } from "../packages/workflow/src/outbox.ts";

test("outbox pump retries failed events with bounded backoff", async () => {
  const retried: string[] = [];
  const store = {
    async claim() { return [{
      id: "1", tenantId: "t", eventType: "x", aggregateType: "article", aggregateId: "a",
      dedupeKey: "d", payload: {}, attemptCount: 0, leaseToken: "lease"
    }]; },
    async markDispatched() { throw new Error("not expected"); },
    async retry(_id: string, _lease: string, availableAt: string) { retried.push(availableAt); },
    async deadLetter() { throw new Error("not expected"); }
  };
  const result = await pumpOutbox(store, { async dispatch() { throw new Error("down"); } }, {
    batchSize: 10, maxAttempts: 3, now: () => new Date("2026-01-01T00:00:00.000Z")
  });
  assert.equal(result.failed, 1);
  assert.equal(retried.length, 1);
});
