import { DomainInvariantError } from "../../domain/src/article-state.ts";
import { evaluatePublishEligibility, type PublishCandidate, type PublishPolicy } from "../../domain/src/publishing.ts";
import { runIdempotent, stableFingerprint, type IdempotencyStore } from "../../workflow/src/idempotency.ts";

export interface PublishCommand {
  readonly articleId: string;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly initiatedBy: "human" | "autonomous";
}

export interface PublishResult {
  readonly articleId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly status: "PUBLISHED";
  readonly publishedAt: string;
  readonly replayed: boolean;
}

export interface ArticleRepository {
  getPublishCandidate(tenantId: string, articleId: string): Promise<PublishCandidate | null>;
  publishAtomically(input: {
    readonly tenantId: string;
    readonly articleId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly version: number; readonly publishedAt: string } | null>;
}

export interface PublishingPolicyProvider {
  getPolicy(tenantId: string): Promise<Omit<PublishPolicy, "tenantId" | "initiatedBy">>;
}

export class PublisherService {
  private readonly repository: ArticleRepository;
  private readonly policies: PublishingPolicyProvider;
  private readonly idempotency: IdempotencyStore;

  public constructor(
    repository: ArticleRepository,
    policies: PublishingPolicyProvider,
    idempotency: IdempotencyStore
  ) {
    this.repository = repository;
    this.policies = policies;
    this.idempotency = idempotency;
  }

  public async publish(command: PublishCommand): Promise<PublishResult> {
    if (!command.articleId || !command.tenantId || command.expectedVersion < 1 || !command.actorId) {
      throw new DomainInvariantError("Publish command is incomplete or invalid.");
    }

    const fingerprint = stableFingerprint([
      command.tenantId,
      command.articleId,
      command.expectedVersion,
      command.actorId,
      command.initiatedBy
    ]);

    const execution = await runIdempotent(this.idempotency, command.idempotencyKey, fingerprint, async () => {
      const candidate = await this.repository.getPublishCandidate(command.tenantId, command.articleId);
      if (!candidate) throw new DomainInvariantError("Article was not found in the requested tenant.");
      if (candidate.version !== command.expectedVersion) {
        throw new DomainInvariantError("Article version changed before publication; refresh and retry with a new key.");
      }

      const configured = await this.policies.getPolicy(command.tenantId);
      const policy: PublishPolicy = {
        tenantId: command.tenantId,
        initiatedBy: command.initiatedBy,
        autonomyLevel: configured.autonomyLevel,
        aiPublishingEnabled: configured.aiPublishingEnabled
      };
      const rejections = evaluatePublishEligibility(candidate, policy);
      if (rejections.length > 0) {
        throw new DomainInvariantError(`Publish rejected: ${rejections.map((item) => item.code).join(", ")}`);
      }

      const published = await this.repository.publishAtomically({
        tenantId: command.tenantId,
        articleId: command.articleId,
        expectedVersion: command.expectedVersion,
        actorId: command.actorId,
        idempotencyKey: command.idempotencyKey
      });
      if (!published) {
        throw new DomainInvariantError("Atomic publication failed because article state or version changed.");
      }
      return {
        articleId: command.articleId,
        tenantId: command.tenantId,
        version: published.version,
        status: "PUBLISHED" as const,
        publishedAt: published.publishedAt
      };
    });

    return { ...execution.result, replayed: execution.replayed };
  }
}
