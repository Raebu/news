import assert from "node:assert/strict";
import test from "node:test";
import { SignalService, type SignalRepository } from "../packages/signals/src/signals.ts";
import { InMemoryIdempotencyStore } from "../packages/workflow/src/idempotency.ts";

class FakeSignals implements SignalRepository {
  public writes = 0;
  async createSignal() {
    this.writes += 1;
    return { signalId:"signal-1", createdAt:"2026-09-20T06:00:00.000Z" };
  }
}

const base = {
  tenantId:"raeburn-group",
  idempotencyKey:"signal-key-001",
  signal:{
    signalType:"company.news",
    title:"A material company update",
    sourceRefs:["https://example.invalid/source"],
    importance:75,
    eventAt:"2026-09-20T05:59:00.000Z",
    provenance:{ collector:"manual", nested:{ b:2, a:1 } },
    schemaVersion:"1" as const
  }
};

test("signal submission is schema checked and idempotent", async () => {
  const repository = new FakeSignals();
  const service = new SignalService(repository, new InMemoryIdempotencyStore(), () => new Date("2026-09-20T06:00:00.000Z"));
  const first = await service.submit(base);
  const second = await service.submit({
    ...base,
    signal:{ ...base.signal, provenance:{ nested:{ a:1, b:2 }, collector:"manual" } }
  });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(repository.writes, 1);
});

test("signals reject unsafe source protocols and far-future events", async () => {
  const service = new SignalService(new FakeSignals(), new InMemoryIdempotencyStore(), () => new Date("2026-09-20T06:00:00.000Z"));
  await assert.rejects(() => service.submit({
    ...base, idempotencyKey:"signal-key-002",
    signal:{ ...base.signal, sourceRefs:["file:///etc/passwd"] }
  }), /protocol is not allowed/);
  await assert.rejects(() => service.submit({
    ...base, idempotencyKey:"signal-key-003",
    signal:{ ...base.signal, eventAt:"2026-09-20T07:00:00.000Z" }
  }), /too far in the future/);
});

test("signal provenance rejects prototype-pollution keys and cycles", async () => {
  const service = new SignalService(new FakeSignals(), new InMemoryIdempotencyStore(), () => new Date("2026-09-20T06:00:00.000Z"));
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  await assert.rejects(() => service.submit({
    ...base, idempotencyKey:"signal-key-004",
    signal:{ ...base.signal, provenance: polluted }
  }), /forbidden key/);

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  await assert.rejects(() => service.submit({
    ...base, idempotencyKey:"signal-key-005",
    signal:{ ...base.signal, provenance: cyclic }
  }), /acyclic/);
});
