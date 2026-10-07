export type OutboxState = "pending" | "processing" | "dispatched" | "dead_letter";

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly dedupeKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attemptCount: number;
}

export interface ClaimedOutboxEvent extends OutboxEvent {
  readonly leaseToken: string;
}

export interface OutboxStore {
  claim(limit: number): Promise<readonly ClaimedOutboxEvent[]>;
  markDispatched(eventId: string, leaseToken: string): Promise<void>;
  retry(eventId: string, leaseToken: string, availableAt: string, errorCode: string): Promise<void>;
  deadLetter(eventId: string, leaseToken: string, errorCode: string): Promise<void>;
}

export interface OutboxDispatcher {
  dispatch(event: OutboxEvent): Promise<void>;
}

export interface OutboxPumpOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly now: () => Date;
}

export async function pumpOutbox(
  store: OutboxStore,
  dispatcher: OutboxDispatcher,
  options: OutboxPumpOptions
): Promise<{ readonly processed: number; readonly dispatched: number; readonly failed: number }> {
  const claimed = await store.claim(options.batchSize);
  let dispatched = 0;
  let failed = 0;

  for (const event of claimed) {
    try {
      await dispatcher.dispatch(event);
      await store.markDispatched(event.id, event.leaseToken);
      dispatched += 1;
    } catch {
      failed += 1;
      const nextAttempt = event.attemptCount + 1;
      if (nextAttempt >= options.maxAttempts) {
        await store.deadLetter(event.id, event.leaseToken, "dispatch_failed");
        continue;
      }
      const backoffSeconds = Math.min(3600, 2 ** Math.min(nextAttempt, 10) * 5);
      const availableAt = new Date(options.now().getTime() + backoffSeconds * 1000).toISOString();
      await store.retry(event.id, event.leaseToken, availableAt, "dispatch_failed");
    }
  }

  return { processed: claimed.length, dispatched, failed };
}
