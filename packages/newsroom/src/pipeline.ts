export const PIPELINE_STAGES = [
  "discover",
  "research",
  "draft",
  "factcheck",
  "image",
  "image_qa",
  "editorial_qa",
  "ready",
  "publish",
  "distribute"
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface StoryCandidate {
  readonly tenantId: string;
  readonly signalId: string;
  readonly title: string;
  readonly sourceRefs: readonly string[];
  readonly importance: number;
}

export interface ResearchSource {
  readonly url: string;
  readonly title: string;
  readonly publisher?: string;
  readonly retrievedAt: string;
  readonly excerpt?: string;
}

export interface ClaimAssessment {
  readonly claim: string;
  readonly status: "supported" | "conflicted" | "unsupported";
  readonly sourceUrls: readonly string[];
}

export interface DraftArticle {
  readonly headline: string;
  readonly standfirst: string;
  readonly body: string;
  readonly category: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
}

export interface MediaCandidate {
  readonly assetId: string;
  readonly publicId?: string;
  readonly url: string;
  readonly altText: string;
  readonly width?: number;
  readonly height?: number;
}

export interface EditorialAssessment {
  readonly passed: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface NewsroomArtifact {
  readonly candidate: StoryCandidate;
  readonly sources: readonly ResearchSource[];
  readonly draft: DraftArticle;
  readonly claims: readonly ClaimAssessment[];
  readonly media?: MediaCandidate;
  readonly editorial: EditorialAssessment;
}

export interface TenantEditorialPolicy {
  readonly minimumSources: number;
  readonly minimumSupportedClaimRatio: number;
  readonly minimumEditorialScore: number;
  readonly allowAutonomousPublish: boolean;
  readonly requireImage: boolean;
}

export interface ResearchProvider {
  research(candidate: StoryCandidate): Promise<readonly ResearchSource[]>;
}

export interface DraftProvider {
  draft(candidate: StoryCandidate, sources: readonly ResearchSource[]): Promise<DraftArticle>;
}

export interface FactCheckProvider {
  check(draft: DraftArticle, sources: readonly ResearchSource[]): Promise<readonly ClaimAssessment[]>;
}

export interface MediaProvider {
  create(draft: DraftArticle): Promise<MediaCandidate>;
  assess(asset: MediaCandidate): Promise<EditorialAssessment>;
}

export interface EditorialProvider {
  assess(input: {
    readonly candidate: StoryCandidate;
    readonly draft: DraftArticle;
    readonly sources: readonly ResearchSource[];
    readonly claims: readonly ClaimAssessment[];
    readonly media?: MediaCandidate;
  }): Promise<EditorialAssessment>;
}

export interface PipelineDependencies {
  readonly research: ResearchProvider;
  readonly drafting: DraftProvider;
  readonly factCheck: FactCheckProvider;
  readonly media?: MediaProvider;
  readonly editorial: EditorialProvider;
}

export class PipelinePolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PipelinePolicyError";
  }
}

function ratioSupported(claims: readonly ClaimAssessment[]): number {
  if (claims.length === 0) return 0;
  return claims.filter((claim) => claim.status === "supported").length / claims.length;
}

function validateSources(sources: readonly ResearchSource[], policy: TenantEditorialPolicy): void {
  const unique = new Set(sources.map((source) => source.url));
  if (unique.size < policy.minimumSources) {
    throw new PipelinePolicyError(`research gate failed: requires at least ${policy.minimumSources} unique sources`);
  }
}

function validateClaims(claims: readonly ClaimAssessment[], policy: TenantEditorialPolicy): void {
  const conflicted = claims.filter((claim) => claim.status === "conflicted").length;
  if (conflicted > 0) throw new PipelinePolicyError("fact-check gate failed: conflicted material claims remain");
  const supportedRatio = ratioSupported(claims);
  if (supportedRatio < policy.minimumSupportedClaimRatio) {
    throw new PipelinePolicyError("fact-check gate failed: supported claim ratio is below policy");
  }
}

export async function runNewsroomPipeline(
  candidate: StoryCandidate,
  policy: TenantEditorialPolicy,
  dependencies: PipelineDependencies
): Promise<NewsroomArtifact> {
  if (candidate.importance < 0 || candidate.importance > 100) {
    throw new PipelinePolicyError("candidate importance must be from 0 to 100");
  }

  const sources = await dependencies.research.research(candidate);
  validateSources(sources, policy);

  const draft = await dependencies.drafting.draft(candidate, sources);
  if (!draft.headline.trim() || !draft.body.trim()) {
    throw new PipelinePolicyError("draft gate failed: headline and body are required");
  }

  const claims = await dependencies.factCheck.check(draft, sources);
  validateClaims(claims, policy);

  let media: MediaCandidate | undefined;
  if (dependencies.media) {
    media = await dependencies.media.create(draft);
    const imageAssessment = await dependencies.media.assess(media);
    if (!imageAssessment.passed) {
      throw new PipelinePolicyError(`image QA failed: ${imageAssessment.reasons.join("; ")}`);
    }
  } else if (policy.requireImage) {
    throw new PipelinePolicyError("image gate failed: tenant policy requires an image");
  }

  const editorialInput = media === undefined
    ? { candidate, draft, sources, claims }
    : { candidate, draft, sources, claims, media };
  const editorial = await dependencies.editorial.assess(editorialInput);
  if (!editorial.passed || editorial.score < policy.minimumEditorialScore) {
    throw new PipelinePolicyError("editorial QA gate failed");
  }

  return media === undefined
    ? { candidate, sources, draft, claims, editorial }
    : { candidate, sources, draft, claims, media, editorial };
}
