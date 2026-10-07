import { readRuntimeConfig } from "../packages/config/src/env.ts";
import {
  createDatabase,
  PostgresPublicArticleRepository,
  PostgresPublisher,
  PostgresReadinessProbe,
  PostgresServiceCredentialVerifier,
  PostgresSignals
} from "../packages/postgres/src/runtime.ts";
import { PublicArticleService } from "../packages/articles/src/public-articles.ts";
import { routeApiRequest } from "../apps/api/src/api-router.ts";

const config = readRuntimeConfig(process.env);
const sql = createDatabase(config.databaseUrl);

const dependencies = {
  readiness: new PostgresReadinessProbe(sql),
  version: "0.4.0",
  verifier: new PostgresServiceCredentialVerifier(sql),
  publicArticles: new PublicArticleService(new PostgresPublicArticleRepository(sql)),
  publisher: new PostgresPublisher(sql, config.aiPublishingEnabled),
  signals: new PostgresSignals(sql)
};

function requestHeaders(headers: Headers): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function responseHeaders(headers: Readonly<Record<string, string>>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) result.set(key, value);
  return result;
}

async function bodyFor(request: Request): Promise<string | undefined> {
  if (request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH") return undefined;
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > 65_536) throw new Error("payload_too_large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 65_536) throw new Error("payload_too_large");
  return body;
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const body = await bodyFor(request);
      const result = await routeApiRequest({
        method: request.method,
        path: request.url,
        headers: requestHeaders(request.headers),
        ...(body === undefined ? {} : { body })
      }, dependencies);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: responseHeaders(result.headers)
      });
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "payload_too_large";
      return Response.json({
        error: {
          code: tooLarge ? "payload_too_large" : "internal_error",
          message: tooLarge ? "request body exceeds limit." : "request failed."
        }
      }, {
        status: tooLarge ? 413 : 500,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      });
    }
  }
};
