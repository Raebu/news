export interface ServiceIdentity {
  readonly service: string;
  readonly allowedTenantIds: readonly string[];
  readonly permissions: readonly string[];
}

export interface ServiceCredentialVerifier {
  verify(service: string, credential: string): Promise<ServiceIdentity | null>;
}

export interface TenantContext {
  readonly tenantId: string;
  readonly service: string;
  readonly permissions: readonly string[];
}

export class AuthenticationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

const safeId = /^[a-z0-9][a-z0-9_-]{2,63}$/;

function requireSafeIdentifier(value: string | undefined, label: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !safeId.test(normalized)) {
    throw new AuthenticationError(`${label} is missing or invalid.`);
  }
  return normalized;
}

export async function resolveTrustedTenantContext(
  headers: Readonly<Record<string, string | undefined>>,
  verifier: ServiceCredentialVerifier
): Promise<TenantContext> {
  const tenantId = requireSafeIdentifier(headers["x-raeburn-tenant-id"], "tenant id");
  const service = requireSafeIdentifier(headers["x-raeburn-service"], "service id");
  const credential = headers["x-raeburn-service-key"]?.trim();
  if (!credential || credential.length < 24) {
    throw new AuthenticationError("service credential is missing or invalid.");
  }

  const identity = await verifier.verify(service, credential);
  if (!identity || identity.service !== service) {
    throw new AuthenticationError("service credential was not accepted.");
  }
  if (!identity.allowedTenantIds.includes(tenantId)) {
    throw new AuthenticationError("service is not authorized for the requested tenant.");
  }

  return { tenantId, service, permissions: identity.permissions };
}

export function requirePermission(context: TenantContext, permission: string): void {
  if (!context.permissions.includes(permission)) {
    throw new AuthenticationError(`missing required permission: ${permission}`);
  }
}
