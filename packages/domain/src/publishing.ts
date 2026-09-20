import type { ArticleStatus } from "./article-state.ts";

export type AutonomyLevel = "human" | "supervised" | "autonomous";
export type GateState = "passed" | "failed" | "pending";

export interface PublishCandidate {
  readonly articleId: string;
  readonly tenantId: string;
  readonly status: ArticleStatus;
  readonly version: number;
  readonly factCheck: GateState;
  readonly editorialQa: GateState;
  readonly imageQa: GateState;
  readonly mediaRequired: boolean;
  readonly mediaAssetId?: string;
  readonly unresolvedMaterialClaims: number;
  readonly sensitive: boolean;
  readonly humanApproval: boolean;
}

export interface PublishPolicy {
  readonly tenantId: string;
  readonly autonomyLevel: AutonomyLevel;
  readonly aiPublishingEnabled: boolean;
  readonly initiatedBy: "human" | "autonomous";
}

export interface PublishRejection {
  readonly code:
    | "TENANT_MISMATCH"
    | "NOT_READY"
    | "FACT_CHECK_INCOMPLETE"
    | "EDITORIAL_QA_INCOMPLETE"
    | "IMAGE_QA_INCOMPLETE"
    | "MEDIA_MISSING"
    | "UNRESOLVED_MATERIAL_CLAIMS"
    | "AUTONOMY_DISABLED"
    | "SENSITIVE_REQUIRES_HUMAN";
  readonly message: string;
}

export function evaluatePublishEligibility(
  candidate: PublishCandidate,
  policy: PublishPolicy
): readonly PublishRejection[] {
  const rejections: PublishRejection[] = [];

  if (candidate.tenantId !== policy.tenantId) {
    rejections.push({ code: "TENANT_MISMATCH", message: "Article tenant does not match publish context." });
  }
  if (candidate.status !== "READY") {
    rejections.push({ code: "NOT_READY", message: "Only READY articles can be published." });
  }
  if (candidate.factCheck !== "passed") {
    rejections.push({ code: "FACT_CHECK_INCOMPLETE", message: "Fact-check gate must pass before publication." });
  }
  if (candidate.editorialQa !== "passed") {
    rejections.push({ code: "EDITORIAL_QA_INCOMPLETE", message: "Editorial QA gate must pass before publication." });
  }
  if (candidate.mediaRequired && candidate.imageQa !== "passed") {
    rejections.push({ code: "IMAGE_QA_INCOMPLETE", message: "Required media must pass image QA before publication." });
  }
  if (candidate.mediaRequired && !candidate.mediaAssetId) {
    rejections.push({ code: "MEDIA_MISSING", message: "Required media asset is missing." });
  }
  if (candidate.unresolvedMaterialClaims > 0) {
    rejections.push({
      code: "UNRESOLVED_MATERIAL_CLAIMS",
      message: "Material claims must be resolved before publication."
    });
  }
  if (policy.initiatedBy === "autonomous" && !policy.aiPublishingEnabled) {
    rejections.push({ code: "AUTONOMY_DISABLED", message: "Autonomous publication is disabled by kill switch." });
  }
  if (candidate.sensitive && policy.initiatedBy === "autonomous" && !candidate.humanApproval) {
    rejections.push({
      code: "SENSITIVE_REQUIRES_HUMAN",
      message: "Sensitive stories require explicit human approval before autonomous publication."
    });
  }

  return rejections;
}
