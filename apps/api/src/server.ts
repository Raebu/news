import { createServer } from "node:http";
import { readRuntimeConfig } from "../../../packages/config/src/env.ts";

export interface ReadinessProbe {
  check(): Promise<{ readonly ready: boolean; readonly reason?: string }>;
}

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
  if (method === "GET" && path === "/healthz") return { status: 200, body: { ok: true } };
  if (method === "GET" && path === "/version") return { status: 200, body: { version } };
  if (method === "GET" && path === "/readyz") {
    const state = await readiness.check();
    return state.ready
      ? { status: 200, body: { ready: true } }
      : { status: 503, body: { ready: false, reason: state.reason ?? "dependency unavailable" } };
  }
  return { status: 404, body: { error: "not_found" } };
}

export function startServer(): void {
  const config = readRuntimeConfig(process.env);
  const readiness: ReadinessProbe = {
    async check() {
      // DB/provider checks are injected in deployment-specific composition. Until then readiness fails closed.
      return { ready: false, reason: "database readiness probe not configured" };
    }
  };
  const version = "0.1.0";
  const server = createServer(async (request, response) => {
    const path = request.url?.split("?", 1)[0] ?? "/";
    const result = await routeRequest(request.method ?? "GET", path, readiness, version);
    response.statusCode = result.status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(result.body));
  });
  server.listen(8787, "0.0.0.0", () => {
    process.stdout.write(`publishing api listening on :8787 (${config.nodeEnv})\n`);
  });
}

if (process.env["RAEBURN_START_SERVER"] === "true") startServer();
