import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex, StaticServiceCredentialVerifier } from "../packages/security/src/service-credentials.ts";

const currentKey = "current-service-key-abcdefghijklmnopqrstuvwxyz";
const nextKey = "next-service-key-abcdefghijklmnopqrstuvwxyz";

test("hashed service credentials resolve least-privilege tenant scopes", async () => {
  const verifier = new StaticServiceCredentialVerifier([{
    service: "public-site",
    credentialSha256: await sha256Hex(currentKey),
    allowedTenantIds: ["raeburn-group"],
    permissions: ["article:read"],
    active: true,
    expiresAt: "2027-01-01T00:00:00.000Z"
  }], () => new Date("2026-09-20T06:00:00.000Z"));

  const identity = await verifier.verify("public-site", currentKey);
  assert.equal(identity?.service, "public-site");
  assert.deepEqual(identity?.allowedTenantIds, ["raeburn-group"]);
  assert.deepEqual(identity?.permissions, ["article:read"]);
  assert.equal(await verifier.verify("public-site", "wrong-key-wrong-key-wrong-key"), null);
});

test("revoked and expired credentials fail closed", async () => {
  const hash = await sha256Hex(currentKey);
  const expired = new StaticServiceCredentialVerifier([{
    service: "publisher", credentialSha256: hash, allowedTenantIds: ["raeburn-group"],
    permissions: ["article:publish"], active: true, expiresAt: "2026-01-01T00:00:00.000Z"
  }], () => new Date("2026-09-20T06:00:00.000Z"));
  assert.equal(await expired.verify("publisher", currentKey), null);

  const revoked = new StaticServiceCredentialVerifier([{
    service: "publisher", credentialSha256: hash, allowedTenantIds: ["raeburn-group"],
    permissions: ["article:publish"], active: false, expiresAt: null
  }]);
  assert.equal(await revoked.verify("publisher", currentKey), null);
});

test("credential rotation allows a new digest without accepting inactive predecessor", async () => {
  const verifier = new StaticServiceCredentialVerifier([
    {
      service: "publisher", credentialSha256: await sha256Hex(currentKey), allowedTenantIds: ["raeburn-group"],
      permissions: ["article:publish"], active: false, expiresAt: null
    },
    {
      service: "publisher", credentialSha256: await sha256Hex(nextKey), allowedTenantIds: ["raeburn-group"],
      permissions: ["article:publish"], active: true, expiresAt: null
    }
  ]);
  assert.equal(await verifier.verify("publisher", currentKey), null);
  assert.equal((await verifier.verify("publisher", nextKey))?.service, "publisher");
});
