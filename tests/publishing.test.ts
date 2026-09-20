import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePublishEligibility, type PublishCandidate } from "../packages/domain/src/publishing.ts";

const ready: PublishCandidate = {
  articleId: "article-1", tenantId: "raeburn-group", status: "READY", version: 1,
  factCheck: "passed", editorialQa: "passed", imageQa: "passed", mediaRequired: true,
  mediaAssetId: "asset-1", unresolvedMaterialClaims: 0, sensitive: false, humanApproval: false
};

test("eligible READY article passes all publication gates", () => {
  assert.deepEqual(evaluatePublishEligibility(ready, {
    tenantId: "raeburn-group", autonomyLevel: "autonomous", aiPublishingEnabled: true, initiatedBy: "autonomous"
  }), []);
});

test("kill switch blocks autonomous publish but not human-controlled publication", () => {
  const autonomous = evaluatePublishEligibility(ready, {
    tenantId: "raeburn-group", autonomyLevel: "autonomous", aiPublishingEnabled: false, initiatedBy: "autonomous"
  });
  assert.equal(autonomous.some((item) => item.code === "AUTONOMY_DISABLED"), true);
  const human = evaluatePublishEligibility(ready, {
    tenantId: "raeburn-group", autonomyLevel: "human", aiPublishingEnabled: false, initiatedBy: "human"
  });
  assert.deepEqual(human, []);
});

test("material claims, failed gates, missing media, tenant mismatch and sensitive stories all fail closed", () => {
  const { mediaAssetId: _mediaAssetId, ...withoutMedia } = ready;
  const rejected = evaluatePublishEligibility({
    ...withoutMedia, tenantId: "tenant-a", factCheck: "failed", editorialQa: "pending", imageQa: "failed",
    unresolvedMaterialClaims: 2, sensitive: true, humanApproval: false
  }, { tenantId: "tenant-b", autonomyLevel: "autonomous", aiPublishingEnabled: true, initiatedBy: "autonomous" });
  const codes = rejected.map((item) => item.code);
  for (const code of ["TENANT_MISMATCH","FACT_CHECK_INCOMPLETE","EDITORIAL_QA_INCOMPLETE","IMAGE_QA_INCOMPLETE","MEDIA_MISSING","UNRESOLVED_MATERIAL_CLAIMS","SENSITIVE_REQUIRES_HUMAN"]) {
    assert.equal(codes.includes(code as typeof codes[number]), true);
  }
});
