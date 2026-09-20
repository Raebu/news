import type { ServiceCredentialVerifier, ServiceIdentity } from "./tenant-context.ts";

export interface ServiceCredentialDefinition {
  readonly service: string;
  readonly credentialSha256: string;
  readonly allowedTenantIds: readonly string[];
  readonly permissions: readonly string[];
  readonly active: boolean;
  readonly expiresAt: string | null;
}

const safeId = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const sha256HexPattern = /^[0-9a-f]{64}$/;

function assertDefinition(definition: ServiceCredentialDefinition): void {
  if (!safeId.test(definition.service)) throw new Error("service credential definition has invalid service id.");
  if (!sha256HexPattern.test(definition.credentialSha256)) {
    throw new Error("service credential definition must contain a lowercase SHA-256 digest.");
  }
  if (definition.allowedTenantIds.length === 0 || definition.allowedTenantIds.some((tenant) => !safeId.test(tenant))) {
    throw new Error("service credential definition must have valid tenant scopes.");
  }
  if (definition.permissions.length === 0 || definition.permissions.some((permission) => permission.length > 128)) {
    throw new Error("service credential definition must have non-empty permissions.");
  }
  if (definition.expiresAt !== null && !Number.isFinite(Date.parse(definition.expiresAt))) {
    throw new Error("service credential definition has an invalid expiry.");
  }
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class StaticServiceCredentialVerifier implements ServiceCredentialVerifier {
  readonly #definitions: readonly ServiceCredentialDefinition[];
  readonly #now: () => Date;

  public constructor(definitions: readonly ServiceCredentialDefinition[], now: () => Date = () => new Date()) {
    if (definitions.length === 0) throw new Error("at least one service credential definition is required.");
    for (const definition of definitions) assertDefinition(definition);
    const unique = new Set(definitions.map((definition) => `${definition.service}:${definition.credentialSha256}`));
    if (unique.size !== definitions.length) throw new Error("duplicate service credential digest is not allowed.");
    this.#definitions = definitions;
    this.#now = now;
  }

  public async verify(service: string, credential: string): Promise<ServiceIdentity | null> {
    if (!safeId.test(service) || credential.length < 24 || credential.length > 512) return null;
    const digest = await sha256Hex(credential);
    const nowMs = this.#now().getTime();

    for (const definition of this.#definitions) {
      if (definition.service !== service || !constantTimeHexEqual(definition.credentialSha256, digest)) continue;
      if (!definition.active) return null;
      if (definition.expiresAt !== null && Date.parse(definition.expiresAt) <= nowMs) return null;
      return {
        service: definition.service,
        allowedTenantIds: [...definition.allowedTenantIds],
        permissions: [...definition.permissions]
      };
    }
    return null;
  }
}
