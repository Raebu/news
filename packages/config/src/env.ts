export type RuntimeEnvironment = "development" | "test" | "staging" | "production";

export interface RuntimeConfig {
  readonly nodeEnv: RuntimeEnvironment;
  readonly serviceName: string;
  readonly databaseUrl: string;
  readonly serviceSharedSecret: string;
  readonly publicBaseUrl: string;
  readonly aiPublishingEnabled: boolean;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required environment variable: ${name}`);
  return value;
}

function parseEnvironment(value: string): RuntimeEnvironment {
  if (value === "development" || value === "test" || value === "staging" || value === "production") return value;
  throw new ConfigurationError("NODE_ENV must be development, test, staging, or production.");
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`${name} must be exactly true or false.`);
}

function parseUrl(value: string, name: string, protocols: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid URL.`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new ConfigurationError(`${name} has an unsupported protocol.`);
  }
  return url.toString();
}

export function readRuntimeConfig(env: Readonly<Record<string, string | undefined>>): RuntimeConfig {
  const nodeEnv = parseEnvironment(required(env, "NODE_ENV"));
  const serviceSharedSecret = required(env, "SERVICE_SHARED_SECRET");
  if (serviceSharedSecret.length < 32) {
    throw new ConfigurationError("SERVICE_SHARED_SECRET must be at least 32 characters.");
  }

  const databaseUrl = parseUrl(required(env, "DATABASE_URL"), "DATABASE_URL", ["postgres:", "postgresql:"]);
  const publicBaseUrl = parseUrl(required(env, "PUBLIC_BASE_URL"), "PUBLIC_BASE_URL", ["https:", "http:"]);

  if ((nodeEnv === "staging" || nodeEnv === "production") && !databaseUrl.includes("sslmode=require")) {
    throw new ConfigurationError("DATABASE_URL must require TLS in staging and production.");
  }
  if (nodeEnv === "production" && !publicBaseUrl.startsWith("https://")) {
    throw new ConfigurationError("PUBLIC_BASE_URL must use HTTPS in production.");
  }

  return {
    nodeEnv,
    serviceName: required(env, "SERVICE_NAME"),
    databaseUrl,
    serviceSharedSecret,
    publicBaseUrl,
    aiPublishingEnabled: parseBoolean(required(env, "AI_PUBLISHING_ENABLED"), "AI_PUBLISHING_ENABLED")
  };
}
