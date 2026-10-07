import postgres from "postgres";
import { sha256Hex } from "../packages/security/src/service-credentials.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (value) => value.toString(16).padStart(2, "0")).join("");
}

const databaseUrl = required("DATABASE_URL_UNPOOLED");
const sql = postgres(databaseUrl, { max: 1, prepare: true });

const tenantSlug = "raeburn-group";
const tenantName = "The Raeburn Group";
const primaryDomain = "theraeburngroup.com";
const smokeTenantSlug = "raeburn-smoke";
const smokeTenantName = "Raeburn Publishing Smoke Test";
const service = "publishing-admin";
const permissions = [
  "article:read",
  "article:publish",
  "article:publish:autonomous",
  "signal:submit"
];

const policy = {
  autonomyLevel: "autonomous",
  aiPublishingEnabled: true,
  allowAutonomousPublish: true,
  requireImage: true,
  minimumSources: 2,
  minimumSupportedClaimRatio: 1,
  minimumEditorialScore: 0.9,
  distributionChannels: ["website"]
};

const smokePolicy = {
  ...policy,
  distributionChannels: ["website", "newsletter"]
};

try {
  const result = await sql.begin(async (tx) => {
    const tenants = await tx`
      insert into tenants (slug, name, primary_domain, publishing_policy)
      values (
        ${tenantSlug}, ${tenantName}, ${primaryDomain},
        ${tx.json(policy as never)}
      )
      on conflict (slug) do update set
        name = excluded.name,
        primary_domain = excluded.primary_domain,
        publishing_policy = excluded.publishing_policy,
        active = true,
        updated_at = now()
      returning id::text as id
    `;
    const tenant = tenants[0];
    if (!tenant) throw new Error("tenant bootstrap failed");
    const tenantId = String(tenant["id"]);

    const smokeTenants = await tx`
      insert into tenants (slug, name, publishing_policy)
      values (
        ${smokeTenantSlug}, ${smokeTenantName},
        ${tx.json(smokePolicy as never)}
      )
      on conflict (slug) do update set
        name = excluded.name,
        publishing_policy = excluded.publishing_policy,
        active = true,
        updated_at = now()
      returning id::text as id
    `;
    const smokeTenant = smokeTenants[0];
    if (!smokeTenant) throw new Error("smoke tenant bootstrap failed");
    const smokeTenantId = String(smokeTenant["id"]);

    for (const currentTenantId of [tenantId, smokeTenantId]) {
      await tx`
        insert into tenant_provider_bindings (tenant_id, provider, purpose, secret_ref, config)
        values
        (${currentTenantId}::uuid, 'openai', 'newsroom', 'env:OPENAI_API_KEY', '{}'::jsonb),
        (${currentTenantId}::uuid, 'cloudinary', 'media', 'env:CLOUDINARY_API_KEY', ${tx.json({
          cloudName: "u7dpgaxh",
          assetFolder: "Cloudinary/The_Raeburn_Holding_Group_Ltd/news"
        } as never)}),
        (${currentTenantId}::uuid, 'resend', 'newsletter', 'env:RESEND_API_KEY', ${tx.json({
          segmentId: "c2367d47-6eb0-4b2b-96e4-398e0cf3a340",
          from: "The Raeburn Group <news@theraeburngroup.com>",
          replyTo: "contact@theraeburngroup.com"
        } as never)})
        on conflict (tenant_id, provider, purpose) do update set
          secret_ref = excluded.secret_ref,
          config = excluded.config,
          active = true,
          updated_at = now()
      `;
    }

    const existing = await tx`
      select sc.id::text as id
      from service_credentials sc
      where sc.service = ${service}
        and sc.active = true
        and sc.revoked_at is null
      order by sc.created_at desc
      limit 1
    `;

    if (existing.length > 0) {
      const credentialId = String(existing[0]?.["id"]);
      await tx`
        insert into service_credential_tenants (credential_id, tenant_id)
        values
          (${credentialId}::uuid, ${tenantId}::uuid),
          (${credentialId}::uuid, ${smokeTenantId}::uuid)
        on conflict do nothing
      `;
      return { tenantId, smokeTenantId, credential: null };
    }

    const credential = `rpub_${randomHex(32)}`;
    const digest = await sha256Hex(credential);
    const credentials = await tx`
      insert into service_credentials (service, credential_hash, permissions)
      values (${service}, ${digest}, ${permissions})
      returning id::text as id
    `;
    const created = credentials[0];
    if (!created) throw new Error("service credential bootstrap failed");

    await tx`
      insert into service_credential_tenants (credential_id, tenant_id)
      values
        (${String(created["id"])}::uuid, ${tenantId}::uuid),
        (${String(created["id"])}::uuid, ${smokeTenantId}::uuid)
      on conflict do nothing
    `;

    return { tenantId, smokeTenantId, credential };
  });

  process.stdout.write(`Tenant: ${tenantSlug} (${result.tenantId})\n`);
  process.stdout.write(`Smoke tenant: ${smokeTenantSlug} (${result.smokeTenantId})\n`);
  process.stdout.write("Policy: autonomous newsroom enabled; distribution channels = website only\n");
  if (result.credential) {
    process.stdout.write("\nSAVE THIS SERVICE CREDENTIAL NOW. It is shown only by this bootstrap run.\n");
    process.stdout.write(`Service: ${service}\nCredential: ${result.credential}\n`);
  } else {
    process.stdout.write("\nAn active publishing-admin credential already exists; no new credential was created.\n");
  }
} finally {
  await sql.end({ timeout: 5 });
}
