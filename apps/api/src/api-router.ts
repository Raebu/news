import { DomainInvariantError } from "../../../packages/domain/src/article-state.ts";
import {
  AuthenticationError,
  AuthorizationError,
  requirePermission,
  resolveTrustedTenantContext,
  type ServiceCredentialVerifier
} from "../../../packages/security/src/tenant-context.ts";
import {
  IdempotencyConflictError,
  OperationInProgressError
} from "../../../packages/workflow/src/idempotency.ts";
import type { PublicArticleService } from "../../../packages/articles/src/public-articles.ts";
import type { PublisherService } from "../../../packages/publisher/src/publisher.ts";
import type { SignalService, SignalInput } from "../../../packages/signals/src/signals.ts";

export interface ReadinessProbe {
  check(): Promise<{ readonly ready: boolean; readonly reason?: string }>;
}

export interface ApiRouteRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

export interface ApiRouteResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ApiDependencies {
  readonly readiness: ReadinessProbe;
  readonly version: string;
  readonly verifier?: ServiceCredentialVerifier;
  readonly publisher?: Pick<PublisherService, "publish">;
  readonly publicArticles?: Pick<PublicArticleService, "list" | "getBySlug">;
  readonly signals?: Pick<SignalService, "submit">;
}

const requestIdPattern = /^[A-Za-z0-9._-]{8,128}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const articleIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;

function requestId(headers: Readonly<Record<string, string | undefined>>): string {
  const supplied = headers["x-request-id"]?.trim();
  return supplied && requestIdPattern.test(supplied) ? supplied : crypto.randomUUID();
}

function baseHeaders(id: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": id
  };
}

function ok(
  id: string,
  status: number,
  body: Readonly<Record<string, unknown>>,
  cacheControl = "no-store"
): ApiRouteResponse {
  return { status, body, headers: { ...baseHeaders(id), "cache-control": cacheControl } };
}

function fail(id: string, status: number, code: string, message: string): ApiRouteResponse {
  return ok(id, status, { error: { code, message, requestId: id } });
}

function serviceUnavailable(id: string, component: string): ApiRouteResponse {
  return fail(id, 503, "service_unavailable", `${component} is not configured.`);
}

function parseJsonObject(body: string | undefined): Readonly<Record<string, unknown>> {
  if (body === undefined || body.length === 0) throw new DomainInvariantError("request body is required.");
  if (body.length > 65_536) throw new DomainInvariantError("request body exceeds 64 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DomainInvariantError("request body must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainInvariantError("request body must be a JSON object.");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireContentType(headers: Readonly<Record<string, string | undefined>>): void {
  const value = headers["content-type"]?.toLowerCase() ?? "";
  if (!value.startsWith("application/json")) {
    throw new DomainInvariantError("content-type must be application/json.");
  }
}

function requireIdempotencyKey(headers: Readonly<Record<string, string | undefined>>): string {
  const key = headers["idempotency-key"]?.trim();
  if (!key || !idempotencyKeyPattern.test(key)) throw new DomainInvariantError("idempotency-key is missing or invalid.");
  return key;
}

function assertOnlyKeys(body: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (!allowedSet.has(key)) throw new DomainInvariantError(`unexpected request field: ${key}`);
  }
}

function parsePublishBody(body: Readonly<Record<string, unknown>>): {
  readonly articleId: string;
  readonly expectedVersion: number;
  readonly initiatedBy: "human" | "autonomous";
} {
  assertOnlyKeys(body, ["articleId", "expectedVersion", "initiatedBy"]);
  const articleId = body["articleId"];
  const expectedVersion = body["expectedVersion"];
  const initiatedBy = body["initiatedBy"];
  if (typeof articleId !== "string" || !articleIdPattern.test(articleId)) {
    throw new DomainInvariantError("articleId is invalid.");
  }
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new DomainInvariantError("expectedVersion must be a positive integer.");
  }
  if (initiatedBy !== "human" && initiatedBy !== "autonomous") {
    throw new DomainInvariantError("initiatedBy must be human or autonomous.");
  }
  return { articleId, expectedVersion, initiatedBy };
}

function parseSignalBody(body: Readonly<Record<string, unknown>>): SignalInput {
  assertOnlyKeys(body, ["signalType", "title", "sourceRefs", "importance", "eventAt", "provenance", "schemaVersion"]);
  const signalType = body["signalType"];
  const title = body["title"];
  const sourceRefs = body["sourceRefs"];
  const importance = body["importance"];
  const eventAt = body["eventAt"];
  const provenance = body["provenance"];
  const schemaVersion = body["schemaVersion"];
  if (typeof signalType !== "string" || typeof title !== "string" || !Array.isArray(sourceRefs) ||
      sourceRefs.some((value) => typeof value !== "string") || typeof importance !== "number" ||
      typeof eventAt !== "string" || provenance === null || typeof provenance !== "object" ||
      Array.isArray(provenance) || schemaVersion !== "1") {
    throw new DomainInvariantError("signal payload schema is invalid.");
  }
  return {
    signalType,
    title,
    sourceRefs: sourceRefs as string[],
    importance,
    eventAt,
    provenance: provenance as Readonly<Record<string, unknown>>,
    schemaVersion: "1"
  };
}

function parseListLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 20;
  if (!/^\d{1,2}$/.test(raw)) throw new DomainInvariantError("limit must be an integer from 1 to 50.");
  const value = Number(raw);
  if (value < 1 || value > 50) throw new DomainInvariantError("limit must be an integer from 1 to 50.");
  return value;
}

class PublishConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PublishConflictError";
  }
}

function mapKnownError(id: string, error: unknown): ApiRouteResponse {
  if (error instanceof AuthenticationError) return fail(id, 401, "unauthenticated", "service authentication failed.");
  if (error instanceof AuthorizationError) return fail(id, 403, "forbidden", "service is not permitted to perform this action.");
  if (error instanceof PublishConflictError) return fail(id, 409, "publish_conflict", error.message);
  if (error instanceof DomainInvariantError) return fail(id, 400, "invalid_request", error.message);
  if (error instanceof IdempotencyConflictError) return fail(id, 409, "idempotency_conflict", error.message);
  if (error instanceof OperationInProgressError) return fail(id, 409, "operation_in_progress", error.message);
  return fail(id, 500, "internal_error", "request failed.");
}

async function trustedContext(
  id: string,
  request: ApiRouteRequest,
  dependencies: ApiDependencies,
  permission: string
) {
  if (!dependencies.verifier) throw new Error(`missing-verifier:${id}`);
  const context = await resolveTrustedTenantContext(request.headers, dependencies.verifier);
  requirePermission(context, permission);
  return context;
}

export async function routeApiRequest(
  request: ApiRouteRequest,
  dependencies: ApiDependencies
): Promise<ApiRouteResponse> {
  const id = requestId(request.headers);
  const method = request.method.toUpperCase();

  try {
    let url: URL;
    try {
      url = new URL(request.path, "https://internal.invalid");
    } catch {
      throw new DomainInvariantError("request target is invalid.");
    }

    if (method === "GET" && url.pathname === "/healthz") return ok(id, 200, { ok: true });
    if (method === "GET" && url.pathname === "/version") return ok(id, 200, { version: dependencies.version });
    if (method === "GET" && url.pathname === "/readyz") {
      const state = await dependencies.readiness.check();
      return state.ready
        ? ok(id, 200, { ready: true })
        : ok(id, 503, { ready: false, reason: "dependency unavailable" });
    }
    if (method === "GET" && url.pathname === "/articles") {
      if (!dependencies.verifier) return serviceUnavailable(id, "service authentication");
      if (!dependencies.publicArticles) return serviceUnavailable(id, "public article repository");
      const context = await trustedContext(id, request, dependencies, "article:read");
      const result = await dependencies.publicArticles.list({
        tenantId: context.tenantId,
        limit: parseListLimit(url),
        cursor: url.searchParams.get("cursor")
      });
      return ok(id, 200, {
        articles: result.articles,
        nextCursor: result.nextCursor
      }, "public, max-age=60, stale-while-revalidate=300");
    }

    if (method === "GET" && url.pathname.startsWith("/articles/")) {
      if (!dependencies.verifier) return serviceUnavailable(id, "service authentication");
      if (!dependencies.publicArticles) return serviceUnavailable(id, "public article repository");
      const context = await trustedContext(id, request, dependencies, "article:read");
      let slug: string;
      try {
        slug = decodeURIComponent(url.pathname.slice("/articles/".length));
      } catch {
        throw new DomainInvariantError("article slug is invalid.");
      }
      if (!slugPattern.test(slug)) throw new DomainInvariantError("article slug is invalid.");
      const article = await dependencies.publicArticles.getBySlug(context.tenantId, slug);
      if (!article) return fail(id, 404, "not_found", "article was not found.");
      return ok(id, 200, { article }, "public, max-age=60, stale-while-revalidate=300");
    }

    if (method === "POST" && url.pathname === "/publish") {
      if (!dependencies.verifier) return serviceUnavailable(id, "service authentication");
      if (!dependencies.publisher) return serviceUnavailable(id, "publisher");
      requireContentType(request.headers);
      const context = await trustedContext(id, request, dependencies, "article:publish");
      const parsed = parsePublishBody(parseJsonObject(request.body));
      if (parsed.initiatedBy === "autonomous") requirePermission(context, "article:publish:autonomous");
      let result;
      try {
        result = await dependencies.publisher.publish({
          articleId: parsed.articleId,
          tenantId: context.tenantId,
          expectedVersion: parsed.expectedVersion,
          idempotencyKey: requireIdempotencyKey(request.headers),
          actorId: context.service,
          initiatedBy: parsed.initiatedBy
        });
      } catch (error) {
        if (error instanceof DomainInvariantError) throw new PublishConflictError(error.message);
        throw error;
      }
      return ok(id, result.replayed ? 200 : 201, { publication: result });
    }

    if (method === "POST" && url.pathname === "/api/newsroom/signals") {
      if (!dependencies.verifier) return serviceUnavailable(id, "service authentication");
      if (!dependencies.signals) return serviceUnavailable(id, "signal service");
      requireContentType(request.headers);
      const context = await trustedContext(id, request, dependencies, "signal:submit");
      const signal = parseSignalBody(parseJsonObject(request.body));
      const result = await dependencies.signals.submit({
        tenantId: context.tenantId,
        idempotencyKey: requireIdempotencyKey(request.headers),
        signal
      });
      return ok(id, result.replayed ? 200 : 202, { signal: result });
    }

    return fail(id, 404, "not_found", "route was not found.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("missing-verifier:")) {
      return serviceUnavailable(id, "service authentication");
    }
    return mapKnownError(id, error);
  }
}
