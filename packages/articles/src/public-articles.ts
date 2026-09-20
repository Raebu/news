import { DomainInvariantError, isPublicArticleStatus, type ArticleStatus } from "../../domain/src/article-state.ts";

export interface PublicArticleRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly status: ArticleStatus;
  readonly version: number;
  readonly headline: string;
  readonly standfirst: string | null;
  readonly body: unknown;
  readonly category: string | null;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
  readonly featured: boolean;
}

export interface PublicArticle {
  readonly id: string;
  readonly slug: string;
  readonly version: number;
  readonly headline: string;
  readonly standfirst: string | null;
  readonly body: unknown;
  readonly category: string | null;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly featured: boolean;
}

export interface PublicArticleRepository {
  listCandidates(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<{ readonly records: readonly PublicArticleRecord[]; readonly nextCursor: string | null }>;
  findCandidateBySlug(tenantId: string, slug: string): Promise<PublicArticleRecord | null>;
}

function visibleToTenant(record: PublicArticleRecord, tenantId: string, nowMs: number): record is PublicArticleRecord & { publishedAt: string } {
  if (record.tenantId !== tenantId || !isPublicArticleStatus(record.status) || record.publishedAt === null) return false;
  const publishedMs = Date.parse(record.publishedAt);
  return Number.isFinite(publishedMs) && publishedMs <= nowMs;
}

function toPublicArticle(record: PublicArticleRecord & { publishedAt: string }): PublicArticle {
  return {
    id: record.id,
    slug: record.slug,
    version: record.version,
    headline: record.headline,
    standfirst: record.standfirst,
    body: record.body,
    category: record.category,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
    featured: record.featured
  };
}

export class PublicArticleService {
  readonly #repository: PublicArticleRepository;
  readonly #now: () => Date;

  public constructor(repository: PublicArticleRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  public async list(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<{ readonly articles: readonly PublicArticle[]; readonly nextCursor: string | null }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new DomainInvariantError("article list limit must be an integer from 1 to 50.");
    }
    if (input.cursor !== null && (input.cursor.length < 1 || input.cursor.length > 256)) {
      throw new DomainInvariantError("article list cursor is invalid.");
    }
    const result = await this.#repository.listCandidates(input);
    const nowMs = this.#now().getTime();
    const articles = result.records
      .filter((record) => visibleToTenant(record, input.tenantId, nowMs))
      .slice(0, input.limit)
      .map(toPublicArticle);

    return { articles, nextCursor: result.nextCursor };
  }

  public async getBySlug(tenantId: string, slug: string): Promise<PublicArticle | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(slug)) {
      throw new DomainInvariantError("article slug is invalid.");
    }
    const record = await this.#repository.findCandidateBySlug(tenantId, slug);
    if (!record || !visibleToTenant(record, tenantId, this.#now().getTime())) return null;
    return toPublicArticle(record);
  }
}
