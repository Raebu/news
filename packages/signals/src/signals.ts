import { DomainInvariantError } from "../../domain/src/article-state.ts";
import { runIdempotent, stableFingerprint, type IdempotencyStore } from "../../workflow/src/idempotency.ts";

export interface SignalInput {
  readonly signalType: string;
  readonly title: string;
  readonly sourceRefs: readonly string[];
  readonly importance: number;
  readonly eventAt: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly schemaVersion: "1";
}

export interface SignalCommand {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly signal: SignalInput;
}

export interface SignalResult {
  readonly signalId: string;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface SignalRepository {
  createSignal(input: SignalCommand): Promise<{ readonly signalId: string; readonly createdAt: string }>;
}

function canonicalize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) throw new DomainInvariantError("signal provenance nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DomainInvariantError("signal provenance contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new DomainInvariantError("signal provenance array is too large.");
    if (seen.has(value)) throw new DomainInvariantError("signal provenance must be acyclic.");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DomainInvariantError("signal provenance must contain JSON-compatible objects only.");
    }
    if (seen.has(object)) throw new DomainInvariantError("signal provenance must be acyclic.");
    seen.add(object);
    const keys = Object.keys(object).sort();
    if (keys.length > 100) throw new DomainInvariantError("signal provenance object has too many keys.");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new DomainInvariantError("signal provenance contains a forbidden key.");
      }
      result[key] = canonicalize(object[key], depth + 1, seen);
    }
    seen.delete(object);
    return result;
  }
  throw new DomainInvariantError("signal provenance must be JSON-compatible.");
}

function validateSignal(signal: SignalInput, nowMs: number): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(signal.signalType)) {
    throw new DomainInvariantError("signal type is invalid.");
  }
  const title = signal.title.trim();
  if (title.length < 3 || title.length > 300) throw new DomainInvariantError("signal title length is invalid.");
  if (!Number.isInteger(signal.importance) || signal.importance < 0 || signal.importance > 100) {
    throw new DomainInvariantError("signal importance must be an integer from 0 to 100.");
  }
  if (signal.sourceRefs.length < 1 || signal.sourceRefs.length > 20) {
    throw new DomainInvariantError("signal must contain between 1 and 20 source references.");
  }
  const unique = new Set<string>();
  for (const source of signal.sourceRefs) {
    let url: URL;
    try { url = new URL(source); } catch { throw new DomainInvariantError("signal source reference must be a valid URL."); }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new DomainInvariantError("signal source reference protocol is not allowed.");
    }
    if (unique.has(url.toString())) throw new DomainInvariantError("signal source references must be unique.");
    unique.add(url.toString());
  }
  const eventMs = Date.parse(signal.eventAt);
  if (!Number.isFinite(eventMs)) throw new DomainInvariantError("signal event time is invalid.");
  if (eventMs > nowMs + 5 * 60 * 1000) throw new DomainInvariantError("signal event time is too far in the future.");
  const provenanceJson = JSON.stringify(canonicalize(signal.provenance));
  if (provenanceJson.length > 10_000) throw new DomainInvariantError("signal provenance is too large.");
}

export class SignalService {
  readonly #repository: SignalRepository;
  readonly #idempotency: IdempotencyStore;
  readonly #now: () => Date;

  public constructor(repository: SignalRepository, idempotency: IdempotencyStore, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#idempotency = idempotency;
    this.#now = now;
  }

  public async submit(command: SignalCommand): Promise<SignalResult> {
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(command.tenantId)) {
      throw new DomainInvariantError("signal tenant is invalid.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(command.idempotencyKey)) {
      throw new DomainInvariantError("signal idempotency key is invalid.");
    }
    validateSignal(command.signal, this.#now().getTime());
    const fingerprint = stableFingerprint([
      command.tenantId,
      command.signal.signalType,
      command.signal.title.trim(),
      command.signal.importance,
      command.signal.eventAt,
      command.signal.sourceRefs.join("\u001e"),
      JSON.stringify(canonicalize(command.signal.provenance)),
      command.signal.schemaVersion
    ]);
    const execution = await runIdempotent(this.#idempotency, command.idempotencyKey, fingerprint, () =>
      this.#repository.createSignal(command)
    );
    return { ...execution.result, replayed: execution.replayed };
  }
}
