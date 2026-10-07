import { readRuntimeConfig } from "../packages/config/src/env.ts";
import { createDatabase, PostgresQueueAdapter } from "../packages/postgres/src/runtime.ts";
import {
  ProductionNewsroomRuntime,
  readProductionNewsroomEnvironment
} from "../packages/postgres/src/newsroom-runtime.ts";
import { processQueueBatch } from "../apps/worker/src/worker.ts";

const config = readRuntimeConfig(process.env);
const sql = createDatabase(config.databaseUrl);
const newsroom = new ProductionNewsroomRuntime(
  sql,
  readProductionNewsroomEnvironment(process.env, {
    publicBaseUrl: config.publicBaseUrl,
    aiPublishingEnabled: config.aiPublishingEnabled
  })
);
const queue = new PostgresQueueAdapter(sql);
const handlers = newsroom.handlers();

interface TriggerBody {
  readonly invocation_id?: unknown;
  readonly trigger?: {
    readonly type?: unknown;
    readonly name?: unknown;
  };
}

async function authenticateTrigger(request: Request): Promise<boolean> {
  const invocationId = request.headers.get("x-neon-trigger-invocation-id");
  if (!invocationId) return false;
  let payload: TriggerBody;
  try {
    payload = await request.clone().json() as TriggerBody;
  } catch {
    return false;
  }
  return payload.invocation_id === invocationId &&
    payload.trigger?.type === "schedule" &&
    payload.trigger?.name === "newsroom-pump";
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (!(await authenticateTrigger(request))) {
      return Response.json({ error: "unauthorized_trigger" }, { status: 401 });
    }

    const result = await processQueueBatch({
      queue,
      handlers,
      batchSize: 5,
      maxAttempts: 5,
      now: () => new Date()
    });
    return Response.json({ ok: true, ...result });
  }
};
