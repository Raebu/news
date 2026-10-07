import { pumpOutbox, type OutboxDispatcher, type OutboxStore } from "../../../packages/workflow/src/outbox.ts";

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
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface QueueAdapter {
  claim(limit: number): Promise<readonly NewsroomJob[]>;
  complete(jobId: string): Promise<void>;
  retry(jobId: string, availableAt: string, errorCode: string): Promise<void>;
  deadLetter(jobId: string, errorCode: string): Promise<void>;
}

export type JobHandler = (job: NewsroomJob) => Promise<void>;

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

export async function processQueueBatch(input: {
  readonly queue: QueueAdapter;
  readonly handlers: Readonly<Partial<Record<JobType, JobHandler>>>;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly now: () => Date;
}): Promise<{ readonly processed: number; readonly completed: number; readonly failed: number }> {
  const jobs = await input.queue.claim(input.batchSize);
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      validateJob(job);
      const handler = input.handlers[job.type];
      if (!handler) throw new UnknownJobError(job.type);
      await handler(job);
      await input.queue.complete(job.id);
      completed += 1;
    } catch (error) {
      failed += 1;
      const code = error instanceof UnknownJobError ? "unsupported_job" : "job_failed";
      if (job.attempt >= input.maxAttempts) {
        await input.queue.deadLetter(job.id, code);
      } else {
        const delaySeconds = Math.min(3600, 2 ** Math.min(job.attempt, 10) * 5);
        await input.queue.retry(job.id, new Date(input.now().getTime() + delaySeconds * 1000).toISOString(), code);
      }
    }
  }

  return { processed: jobs.length, completed, failed };
}

export async function processOutboxBatch(input: {
  readonly store: OutboxStore;
  readonly dispatcher: OutboxDispatcher;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly now: () => Date;
}) {
  return await pumpOutbox(input.store, input.dispatcher, input);
}

if (process.env["RAEBURN_START_WORKER"] === "true") {
  process.stdout.write("worker runtime loaded; compose QueueAdapter and OutboxStore in the deployment entrypoint.\n");
}
