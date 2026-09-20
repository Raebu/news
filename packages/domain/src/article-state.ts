export const ARTICLE_STATUSES = [
  "DISCOVERED",
  "RESEARCHING",
  "CANDIDATE",
  "DRAFTING",
  "FACT_CHECK",
  "IMAGE_GENERATION",
  "EDITORIAL_QA",
  "READY",
  "PUBLISHED",
  "UPDATED",
  "ARCHIVED",
  "REJECTED",
  "DUPLICATE",
  "INSUFFICIENT_EVIDENCE",
  "QA_FAILED",
  "GENERATION_FAILED",
  "RETRACTED"
] as const;

export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export class DomainInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}

const transitions: Readonly<Record<ArticleStatus, readonly ArticleStatus[]>> = {
  DISCOVERED: ["RESEARCHING", "DUPLICATE", "REJECTED"],
  RESEARCHING: ["CANDIDATE", "INSUFFICIENT_EVIDENCE", "DUPLICATE", "REJECTED"],
  CANDIDATE: ["DRAFTING", "REJECTED", "DUPLICATE"],
  DRAFTING: ["FACT_CHECK", "GENERATION_FAILED", "REJECTED"],
  FACT_CHECK: ["IMAGE_GENERATION", "DRAFTING", "QA_FAILED", "INSUFFICIENT_EVIDENCE", "REJECTED"],
  IMAGE_GENERATION: ["EDITORIAL_QA", "GENERATION_FAILED", "QA_FAILED", "REJECTED"],
  EDITORIAL_QA: ["READY", "DRAFTING", "QA_FAILED", "REJECTED"],
  READY: ["PUBLISHED", "DRAFTING", "REJECTED"],
  PUBLISHED: ["UPDATED", "ARCHIVED", "RETRACTED"],
  UPDATED: ["UPDATED", "ARCHIVED", "RETRACTED"],
  ARCHIVED: [],
  REJECTED: [],
  DUPLICATE: [],
  INSUFFICIENT_EVIDENCE: ["RESEARCHING", "REJECTED"],
  QA_FAILED: ["DRAFTING", "IMAGE_GENERATION", "EDITORIAL_QA", "REJECTED"],
  GENERATION_FAILED: ["DRAFTING", "IMAGE_GENERATION", "REJECTED"],
  RETRACTED: []
};

export function isArticleStatus(value: string): value is ArticleStatus {
  return (ARTICLE_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ArticleStatus, to: ArticleStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: ArticleStatus, to: ArticleStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainInvariantError(`Illegal article transition: ${from} -> ${to}`);
  }
}

export function isPublicArticleStatus(status: ArticleStatus): boolean {
  return status === "PUBLISHED" || status === "UPDATED";
}
