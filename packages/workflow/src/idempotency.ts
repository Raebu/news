export type IdempotencyState = "processing" | "completed" | "failed";

export interface IdempotencyRecord<T> {
  readonly key: string;
  readonly fingerprint: string;
  readonly state: IdempotencyState;
  readonly result?: T;
}

export interface IdempotencyStore {
  get<T>(key: string): Promise<IdempotencyRecord<T> | null>;
  createProcessing(key: string, fingerprint: string): Promise<boolean>;
  complete<T>(key: string, fingerprint: string, result: T): Promise<void>;
  fail(key: string, fingerprint: string): Promise<void>;
}

export class IdempotencyConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class OperationInProgressError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperationInProgressError";
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord<unknown>>();

  public async get<T>(key: string): Promise<IdempotencyRecord<T> | null> {
    return (this.#records.get(key) as IdempotencyRecord<T> | undefined) ?? null;
  }

  public async createProcessing(key: string, fingerprint: string): Promise<boolean> {
    if (this.#records.has(key)) return false;
    this.#records.set(key, { key, fingerprint, state: "processing" });
    return true;
  }

  public async complete<T>(key: string, fingerprint: string, result: T): Promise<void> {
    const current = this.#records.get(key);
    if (!current || current.fingerprint !== fingerprint || current.state !== "processing") {
      throw new IdempotencyConflictError("Cannot complete an idempotency record that is not owned by this operation.");
    }
    this.#records.set(key, { key, fingerprint, state: "completed", result });
  }

  public async fail(key: string, fingerprint: string): Promise<void> {
    const current = this.#records.get(key);
    if (!current || current.fingerprint !== fingerprint || current.state !== "processing") return;
    this.#records.set(key, { key, fingerprint, state: "failed" });
  }
}

export async function runIdempotent<T>(
  store: IdempotencyStore,
  key: string,
  fingerprint: string,
  operation: () => Promise<T>
): Promise<{ readonly replayed: boolean; readonly result: T }> {
  const existing = await store.get<T>(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new IdempotencyConflictError("Idempotency key was reused with different inputs.");
    }
    if (existing.state === "completed") {
      return { replayed: true, result: existing.result as T };
    }
    if (existing.state === "processing") {
      throw new OperationInProgressError("Operation with this idempotency key is already processing.");
    }
  }

  if (existing?.state === "failed") {
    // Durable adapters should atomically transition failed -> processing. The in-memory test adapter
    // deletes by replacement semantics using a distinct retry key; production adapters must enforce CAS.
    throw new IdempotencyConflictError("Failed operations require an explicit retry idempotency key.");
  }

  const acquired = await store.createProcessing(key, fingerprint);
  if (!acquired) throw new OperationInProgressError("Operation raced with another claimant.");

  try {
    const result = await operation();
    await store.complete(key, fingerprint, result);
    return { replayed: false, result };
  } catch (error) {
    await store.fail(key, fingerprint);
    throw error;
  }
}

export function stableFingerprint(parts: readonly (string | number | boolean)[]): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(parts.map(String).join("\u001f"))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}
