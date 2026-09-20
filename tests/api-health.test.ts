import assert from "node:assert/strict";
import test from "node:test";
import { routeRequest } from "../apps/api/src/server.ts";

test("health and version endpoints are deterministic", async () => {
  const probe = { async check() { return { ready: true }; } };
  assert.deepEqual(await routeRequest("GET", "/healthz", probe, "1.2.3"), { status: 200, body: { ok: true } });
  assert.deepEqual(await routeRequest("GET", "/version", probe, "1.2.3"), { status: 200, body: { version: "1.2.3" } });
});

test("readiness fails closed when a dependency is unavailable", async () => {
  const probe = { async check() { return { ready: false, reason: "database unavailable" }; } };
  const result = await routeRequest("GET", "/readyz", probe, "1.2.3");
  assert.equal(result.status, 503);
  assert.equal(result.body["ready"], false);
});
