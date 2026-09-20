export const JOB_TYPES = [
  "news.discover",
  "news.research",
  "news.draft",
  "news.factcheck",
  "news.image",
  "news.image_qa",
  "news.editorial_qa",
  "news.publish",
  "news.distribute"
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export interface NewsroomJob {
  readonly id: string;
  readonly type: JobType;
  readonly tenantId: string;
  readonly articleId?: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

export class UnknownJobError extends Error {
  public constructor(type: string) {
    super(`Unknown or unsupported job type: ${type}`);
    this.name = "UnknownJobError";
  }
}

export function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

export function validateJob(job: NewsroomJob): void {
  if (!job.id || !job.tenantId || !job.idempotencyKey || job.attempt < 1) {
    throw new UnknownJobError("invalid-payload");
  }
  if (!isJobType(job.type)) throw new UnknownJobError(job.type);
  if (job.type !== "news.discover" && !job.articleId) {
    throw new UnknownJobError(`${job.type}:missing-article-id`);
  }
}

if (process.env["RAEBURN_START_WORKER"] === "true") {
  process.stdout.write("worker composition requires a durable queue adapter; refusing to poll without one.\n");
}
