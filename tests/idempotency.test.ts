import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryIdempotencyStore, runIdempotent, stableFingerprint } from "../packages/workflow/src/idempotency.ts";

test("completed idempotent operation is replayed without re-execution", async () => {
  const store = new InMemoryIdempotencyStore();
  let executions = 0;
  const fingerprint = stableFingerprint(["tenant", "article", 1]);
  const first = await runIdempotent(store, "key-1", fingerprint, async () => { executions += 1; return "ok"; });
  const second = await runIdempotent(store, "key-1", fingerprint, async () => { executions += 1; return "wrong"; });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.result, "ok");
  assert.equal(executions, 1);
});

test("same idempotency key with different inputs is rejected", async () => {
  const store = new InMemoryIdempotencyStore();
  await runIdempotent(store, "key-2", "a", async () => "ok");
  await assert.rejects(() => runIdempotent(store, "key-2", "b", async () => "bad"), /different inputs/);
});

test("failed operation cannot be silently replayed with the same key", async () => {
  const store = new InMemoryIdempotencyStore();
  await assert.rejects(() => runIdempotent(store, "key-3", "a", async () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(() => runIdempotent(store, "key-3", "a", async () => "retry"), /explicit retry idempotency key/);
});
