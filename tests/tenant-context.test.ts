import assert from "node:assert/strict";
import test from "node:test";
import { requirePermission, resolveTrustedTenantContext, type ServiceCredentialVerifier } from "../packages/security/src/tenant-context.ts";

const verifier: ServiceCredentialVerifier = {
  async verify(service, credential) {
    if (service !== "publisher" || credential !== "abcdefghijklmnopqrstuvwxyz123456") return null;
    return { service, allowedTenantIds: ["raeburn-group"], permissions: ["article:publish"] };
  }
};

test("trusted tenant context is derived from verified service scope", async () => {
  const context = await resolveTrustedTenantContext({
    "x-raeburn-tenant-id": "raeburn-group",
    "x-raeburn-service": "publisher",
    "x-raeburn-service-key": "abcdefghijklmnopqrstuvwxyz123456"
  }, verifier);
  assert.equal(context.tenantId, "raeburn-group");
  requirePermission(context, "article:publish");
});

test("tenant spoofing fails closed even with a valid service credential", async () => {
  await assert.rejects(() => resolveTrustedTenantContext({
    "x-raeburn-tenant-id": "other-tenant",
    "x-raeburn-service": "publisher",
    "x-raeburn-service-key": "abcdefghijklmnopqrstuvwxyz123456"
  }, verifier), /not authorized/);
});

test("missing credentials fail closed", async () => {
  await assert.rejects(() => resolveTrustedTenantContext({
    "x-raeburn-tenant-id": "raeburn-group",
    "x-raeburn-service": "publisher"
  }, verifier), /credential is missing/);
});
