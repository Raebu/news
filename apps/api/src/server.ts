import { createServer, type IncomingMessage } from "node:http";
import { readRuntimeConfig } from "../../../packages/config/src/env.ts";
import { routeApiRequest, type ReadinessProbe } from "./api-router.ts";

export interface ApiResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export async function routeRequest(
  method: string,
  path: string,
  readiness: ReadinessProbe,
  version: string
): Promise<ApiResponse> {
  const result = await routeApiRequest({ method, path, headers: {} }, { readiness, version });
  return { status: result.status, body: result.body };
}

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return result;
}

async function readRequestBody(request: IncomingMessage, maximumBytes = 65_536): Promise<string | undefined> {
  if (request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH") return undefined;
  return await new Promise<string>((resolve, reject) => {
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      if (typeof chunk === "string") {
        bytes += new TextEncoder().encode(chunk).byteLength;
        body += chunk;
      } else {
        bytes += chunk.byteLength;
        body += decoder.decode(chunk, { stream: true });
      }
      if (bytes > maximumBytes) {
        settled = true;
        reject(new Error("request body exceeds 64 KiB."));
      }
    });
    request.on("end", () => {
      if (settled) return;
      body += decoder.decode();
      settled = true;
      resolve(body);
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export function startServer(): void {
  const config = readRuntimeConfig(process.env);
  const readiness: ReadinessProbe = {
    async check() {
      return { ready: false, reason: "database readiness probe not configured" };
    }
  };
  const version = "0.2.0";
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      const result = await routeApiRequest({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: normalizeHeaders(request.headers),
        ...(body === undefined ? {} : { body })
      }, { readiness, version });

      response.statusCode = result.status;
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
      response.end(JSON.stringify(result.body));
    } catch {
      response.statusCode = 413;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.end(JSON.stringify({ error: { code: "payload_too_large", message: "request body exceeds limit." } }));
    }
  });
  server.listen(8787, "0.0.0.0", () => {
    process.stdout.write(`publishing api listening on :8787 (${config.nodeEnv})\n`);
  });
}

if (process.env["RAEBURN_START_SERVER"] === "true") startServer();
