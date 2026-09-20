import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeConfig } from "../packages/config/src/env.ts";

const valid = {
  NODE_ENV: "production",
  SERVICE_NAME: "publishing-api",
  DATABASE_URL: "postgresql://user:pass@example.invalid/db?sslmode=require",
  SERVICE_SHARED_SECRET: "12345678901234567890123456789012",
  PUBLIC_BASE_URL: "https://news.example.invalid",
  AI_PUBLISHING_ENABLED: "false"
};

test("runtime configuration parses fail-closed production settings", () => {
  const config = readRuntimeConfig(valid);
  assert.equal(config.aiPublishingEnabled, false);
  assert.equal(config.nodeEnv, "production");
});

test("runtime configuration rejects missing required values", () => {
  const { DATABASE_URL: _databaseUrl, ...env } = valid;
  assert.throws(() => readRuntimeConfig(env), /Missing required environment variable: DATABASE_URL/);
});

test("production rejects insecure database and public URLs", () => {
  assert.throws(() => readRuntimeConfig({ ...valid, DATABASE_URL: "postgresql://u:p@host/db" }), /require TLS/);
  assert.throws(() => readRuntimeConfig({ ...valid, PUBLIC_BASE_URL: "http://news.example.invalid" }), /must use HTTPS/);
});

test("autonomous publishing flag rejects ambiguous values", () => {
  assert.throws(() => readRuntimeConfig({ ...valid, AI_PUBLISHING_ENABLED: "1" }), /exactly true or false/);
});
