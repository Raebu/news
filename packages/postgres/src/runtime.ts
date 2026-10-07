import postgres from "postgres";
import { DomainInvariantError, type ArticleStatus } from "../../domain/src/article-state.ts";
import type { PublishCandidate, AutonomyLevel } from "../../domain/src/publishing.ts";
import type { PublicArticleRecord, PublicArticleRepository } from "../../articles/src/public-articles.ts";
import type { ArticleRepository, PublishCommand, PublishResult, PublishingPolicyProvider } from "../../publisher/src/publisher.ts";
import { PublisherService } from "../../publisher/src/publisher.ts";
import type { ServiceCredentialVerifier, ServiceIdentity } from "../../security/src/tenant-context.ts";
import { sha256Hex } from "../../security/src/service-credentials.ts";
import type { SignalCommand, SignalRepository, SignalResult } from "../../signals/src/signals.ts";
import { SignalService } from "../../signals/src/signals.ts";
import type { IdempotencyRecord, IdempotencyStore } from "../../workflow/src/idempotency.ts";
import { IdempotencyConflictError } from "../../workflow/src/idempotency.ts";
import type { ClaimedOutboxEvent, OutboxStore } from "../../workflow/src/outbox.ts";
import type { NewsroomJob, QueueAdapter } from "../../../apps/worker/src/worker.ts";

export type Database = ReturnType<typeof postgres>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  throw new Error("database returned an invalid timestamp");
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function createDatabase(databaseUrl: string): Database {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => {}
  });
}

export class PostgresReadinessProbe {
  public constructor(private readonly sql: Database) {}
  public async check(): Promise<{ readonly ready: boolean; readonly reason?: string }> {
    try {
      await this.sql`select 1 as ok`;
      return { ready: true };
    } catch {
      return { ready: false, reason: "database unavailable" };
    }
  }
}

export class PostgresServiceCredentialVerifier implements ServiceCredentialVerifier {
  public constructor(private readonly sql: Database) {}

  public async verify(service: string, credential: string): Promise<ServiceIdentity | null> {
    const digest = await sha256Hex(credential);
    const rows = await this.sql`
      select
        sc.service,
        sc.permissions,
        array_agg(t.slug order by t.slug) as allowed_tenant_ids
      from service_credentials sc
      join service_credential_tenants sct on sct.credential_id = sc.id
      join tenants t on t.id = sct.tenant_id and t.active = true
      where sc.service = ${service}
        and sc.credential_hash = ${digest}
        and sc.active = true
        and sc.revoked_at is null
        and (sc.expires_at is null or sc.expires_at > now())
      group by sc.id, sc.service, sc.permissions
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      service: String(row["service"]),
      permissions: asStringArray(row["permissions"]),
      allowedTenantIds: asStringArray(row["allowed_tenant_ids"])
    };
  }
}

export class PostgresScopedIdempotencyStore implements IdempotencyStore {
  public constructor(
    private readonly sql: Database,
    private readonly tenantSlug: string,
    private readonly scope: string
  ) {}

  public async get<T>(key: string): Promise<IdempotencyRecord<T> | null> {
    const rows = await this.sql`
      select ir.idempotency_key, ir.fingerprint, ir.state, ir.result
      from idempotency_records ir
      join tenants t on t.id = ir.tenant_id
      where t.slug = ${this.tenantSlug}
        and ir.scope = ${this.scope}
        and ir.idempotency_key = ${key}
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const state = String(row["state"]) as IdempotencyRecord<T>["state"];
    const base = { key: String(row["idempotency_key"]), fingerprint: String(row["fingerprint"]), state };
    return state === "completed"
      ? { ...base, result: row["result"] as T }
      : base;
  }

  public async createProcessing(key: string, fingerprint: string): Promise<boolean> {
    const rows = await this.sql`
      insert into idempotency_records (tenant_id, scope, idempotency_key, fingerprint, state)
      select t.id, ${this.scope}, ${key}, ${fingerprint}, 'processing'
      from tenants t
      where t.slug = ${this.tenantSlug} and t.active = true
      on conflict (tenant_id, scope, idempotency_key) do nothing
      returning idempotency_key
    `;
    return rows.length === 1;
  }

  public async complete<T>(key: string, fingerprint: string, result: T): Promise<void> {
    const rows = await this.sql`
      update idempotency_records ir
      set state = 'completed', result = ${this.sql.json(result as never)}, updated_at = now()
      from tenants t
      where ir.tenant_id = t.id
        and t.slug = ${this.tenantSlug}
        and ir.scope = ${this.scope}
        and ir.idempotency_key = ${key}
        and ir.fingerprint = ${fingerprint}
        and ir.state = 'processing'
      returning ir.idempotency_key
    `;
    if (rows.length !== 1) {
      throw new IdempotencyConflictError("Cannot complete an idempotency record that is not owned by this operation.");
    }
  }

  public async fail(key: string, fingerprint: string): Promise<void> {
    await this.sql`
      update idempotency_records ir
      set state = 'failed', updated_at = now()
      from tenants t
      where ir.tenant_id = t.id
        and t.slug = ${this.tenantSlug}
        and ir.scope = ${this.scope}
        and ir.idempotency_key = ${key}
        and ir.fingerprint = ${fingerprint}
        and ir.state = 'processing'
    `;
  }
}

export class PostgresSignalRepository implements SignalRepository {
  public constructor(private readonly sql: Database) {}

  public async createSignal(input: SignalCommand): Promise<{ readonly signalId: string; readonly createdAt: string }> {
    return await this.sql.begin(async (tx) => {
      const inserted = await tx`
        insert into story_signals (
          tenant_id, signal_type, title, source_refs, importance, event_at,
          dedupe_key, provenance, schema_version, idempotency_key
        )
        select
          t.id, ${input.signal.signalType}, ${input.signal.title.trim()},
          ${tx.json([...input.signal.sourceRefs] as never)}, ${input.signal.importance},
          ${input.signal.eventAt}::timestamptz, ${input.idempotencyKey},
          ${tx.json(input.signal.provenance as never)}, ${input.signal.schemaVersion},
          ${input.idempotencyKey}
        from tenants t
        where t.slug = ${input.tenantId} and t.active = true
        returning id::text as id, created_at
      `;
      const signal = inserted[0];
      if (!signal) throw new DomainInvariantError("signal tenant was not found or is inactive.");

      await tx`
        insert into newsroom_runs (
          tenant_id, signal_id, stage, state, attempt_count, available_at,
          trace_id, idempotency_key, payload
        )
        select
          t.id, ${String(signal["id"])}::uuid, 'discover', 'queued', 0, now(),
          ${crypto.randomUUID()}, ${"discover:" + input.idempotencyKey},
          ${tx.json({ signalId: String(signal["id"]) } as never)}
        from tenants t
        where t.slug = ${input.tenantId}
        on conflict (tenant_id, stage, idempotency_key) do nothing
      `;

      return { signalId: String(signal["id"]), createdAt: iso(signal["created_at"]) };
    });
  }
}

function rowToPublicArticle(row: Record<string, unknown>): PublicArticleRecord {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_slug"]),
    slug: String(row["slug"]),
    status: String(row["status"]) as ArticleStatus,
    version: Number(row["current_version"]),
    headline: String(row["headline"]),
    standfirst: row["standfirst"] === null ? null : String(row["standfirst"]),
    body: row["body"],
    category: row["category"] === null ? null : String(row["category"]),
    publishedAt: row["published_at"] === null ? null : iso(row["published_at"]),
    updatedAt: iso(row["updated_at"]),
    featured: Boolean(row["featured"])
  };
}

export class PostgresPublicArticleRepository implements PublicArticleRepository {
  public constructor(private readonly sql: Database) {}

  public async listCandidates(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<{ readonly records: readonly PublicArticleRecord[]; readonly nextCursor: string | null }> {
    if (input.cursor !== null && !Number.isFinite(Date.parse(input.cursor))) {
      throw new DomainInvariantError("article list cursor is invalid.");
    }
    const take = input.limit + 1;
    const rows = input.cursor === null
      ? await this.sql`
          select a.id::text, t.slug as tenant_slug, a.slug, a.status, a.current_version,
                 av.headline, av.standfirst, av.body, av.category,
                 a.published_at, a.updated_at, a.featured
          from articles a
          join tenants t on t.id = a.tenant_id
          join article_versions av on av.article_id = a.id and av.version = a.current_version
          where t.slug = ${input.tenantId}
            and a.status in ('PUBLISHED','UPDATED')
            and a.published_at <= now()
          order by a.published_at desc, a.id desc
          limit ${take}
        `
      : await this.sql`
          select a.id::text, t.slug as tenant_slug, a.slug, a.status, a.current_version,
                 av.headline, av.standfirst, av.body, av.category,
                 a.published_at, a.updated_at, a.featured
          from articles a
          join tenants t on t.id = a.tenant_id
          join article_versions av on av.article_id = a.id and av.version = a.current_version
          where t.slug = ${input.tenantId}
            and a.status in ('PUBLISHED','UPDATED')
            and a.published_at <= now()
            and a.published_at < ${input.cursor}::timestamptz
          order by a.published_at desc, a.id desc
          limit ${take}
        `;
    const mapped = rows.map((row) => rowToPublicArticle(row as Record<string, unknown>));
    const hasMore = mapped.length > input.limit;
    const records = hasMore ? mapped.slice(0, input.limit) : mapped;
    return {
      records,
      nextCursor: hasMore ? records.at(-1)?.publishedAt ?? null : null
    };
  }

  public async findCandidateBySlug(tenantId: string, slug: string): Promise<PublicArticleRecord | null> {
    const rows = await this.sql`
      select a.id::text, t.slug as tenant_slug, a.slug, a.status, a.current_version,
             av.headline, av.standfirst, av.body, av.category,
             a.published_at, a.updated_at, a.featured
      from articles a
      join tenants t on t.id = a.tenant_id
      join article_versions av on av.article_id = a.id and av.version = a.current_version
      where t.slug = ${tenantId} and a.slug = ${slug}
      limit 1
    `;
    const row = rows[0];
    return row ? rowToPublicArticle(row as Record<string, unknown>) : null;
  }
}

export class PostgresArticleRepository implements ArticleRepository {
  public constructor(private readonly sql: Database) {}

  public async getPublishCandidate(tenantId: string, articleId: string): Promise<PublishCandidate | null> {
    const rows = await this.sql`
      select
        a.id::text as article_id,
        t.slug as tenant_slug,
        a.status,
        a.current_version,
        coalesce((
          select er.outcome from editorial_reviews er
          where er.article_id = a.id and er.article_version = a.current_version
            and er.gate in ('factcheck','fact_check')
          order by er.created_at desc limit 1
        ), 'pending') as fact_check,
        coalesce((
          select er.outcome from editorial_reviews er
          where er.article_id = a.id and er.article_version = a.current_version
            and er.gate = 'editorial_qa'
          order by er.created_at desc limit 1
        ), 'pending') as editorial_qa,
        coalesce((
          select er.outcome from editorial_reviews er
          where er.article_id = a.id and er.article_version = a.current_version
            and er.gate = 'image_qa'
          order by er.created_at desc limit 1
        ), 'pending') as image_qa,
        case
          when lower(coalesce(t.publishing_policy->>'requireImage', 'true')) = 'false' then false
          else true
        end as media_required,
        (
          select ma.cloudinary_asset_id
          from media_assets ma
          where ma.article_id = a.id and ma.qa_status = 'passed'
          order by ma.created_at desc limit 1
        ) as media_asset_id,
        (
          select count(*)::int
          from article_claims ac
          join claims c on c.id = ac.claim_id
          where ac.article_id = a.id
            and ac.version = a.current_version
            and ac.material = true
            and c.verification_status <> 'supported'
        ) as unresolved_material_claims,
        case
          when lower(coalesce(av.seo_metadata->>'sensitive', 'false')) = 'true' then true
          else false
        end as sensitive,
        exists (
          select 1 from editorial_reviews er
          where er.article_id = a.id and er.article_version = a.current_version
            and er.gate = 'human_approval' and er.outcome in ('passed','overridden')
        ) as human_approval
      from articles a
      join tenants t on t.id = a.tenant_id
      join article_versions av on av.article_id = a.id and av.version = a.current_version
      where t.slug = ${tenantId} and a.id::text = ${articleId}
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const mediaAssetId = row["media_asset_id"];
    return {
      articleId: String(row["article_id"]),
      tenantId: String(row["tenant_slug"]),
      status: String(row["status"]) as ArticleStatus,
      version: Number(row["current_version"]),
      factCheck: String(row["fact_check"]) === "passed" ? "passed" : String(row["fact_check"]) === "failed" ? "failed" : "pending",
      editorialQa: String(row["editorial_qa"]) === "passed" ? "passed" : String(row["editorial_qa"]) === "failed" ? "failed" : "pending",
      imageQa: String(row["image_qa"]) === "passed" ? "passed" : String(row["image_qa"]) === "failed" ? "failed" : "pending",
      mediaRequired: Boolean(row["media_required"]),
      ...(mediaAssetId === null || mediaAssetId === undefined ? {} : { mediaAssetId: String(mediaAssetId) }),
      unresolvedMaterialClaims: Number(row["unresolved_material_claims"]),
      sensitive: Boolean(row["sensitive"]),
      humanApproval: Boolean(row["human_approval"])
    };
  }

  public async publishAtomically(input: {
    readonly tenantId: string;
    readonly articleId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly version: number; readonly publishedAt: string } | null> {
    return await this.sql.begin(async (tx) => {
      const updated = await tx`
        update articles a
        set status = 'PUBLISHED', published_at = now(), updated_at = now(), lock_version = lock_version + 1
        from tenants t
        where a.tenant_id = t.id
          and t.slug = ${input.tenantId}
          and a.id::text = ${input.articleId}
          and a.status = 'READY'
          and a.current_version = ${input.expectedVersion}
        returning a.id::text as id, a.tenant_id::text as tenant_id, a.current_version, a.published_at
      `;
      const article = updated[0];
      if (!article) return null;
      const publishedAt = iso(article["published_at"]);

      await tx`
        insert into audit_events (
          tenant_id, article_id, event_type, actor_type, actor_id, idempotency_key, payload
        )
        values (
          ${String(article["tenant_id"])}::uuid, ${input.articleId}::uuid,
          'article.published', 'service', ${input.actorId}, ${input.idempotencyKey},
          ${tx.json({ version: input.expectedVersion, publishedAt } as never)}
        )
      `;

      await tx`
        insert into outbox_events (
          tenant_id, aggregate_type, aggregate_id, event_type, dedupe_key, payload
        )
        values (
          ${String(article["tenant_id"])}::uuid, 'article', ${input.articleId},
          'article.published', ${input.idempotencyKey},
          ${tx.json({ articleId: input.articleId, version: input.expectedVersion, publishedAt } as never)}
        )
        on conflict (tenant_id, event_type, dedupe_key) do nothing
      `;

      return { version: Number(article["current_version"]), publishedAt };
    });
  }
}

export class PostgresPublishingPolicyProvider implements PublishingPolicyProvider {
  public constructor(
    private readonly sql: Database,
    private readonly globalAiPublishingEnabled: boolean
  ) {}

  public async getPolicy(tenantId: string): Promise<{ readonly autonomyLevel: AutonomyLevel; readonly aiPublishingEnabled: boolean }> {
    const rows = await this.sql`
      select publishing_policy
      from tenants
      where slug = ${tenantId} and active = true
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new DomainInvariantError("publishing tenant was not found or is inactive.");
    const policy = asObject(row["publishing_policy"]);
    const configuredLevel = policy["autonomyLevel"];
    const autonomyLevel: AutonomyLevel =
      configuredLevel === "autonomous" || configuredLevel === "supervised" || configuredLevel === "human"
        ? configuredLevel
        : "human";
    const tenantEnabled = policy["aiPublishingEnabled"] === true || policy["allowAutonomousPublish"] === true;
    return { autonomyLevel, aiPublishingEnabled: this.globalAiPublishingEnabled && tenantEnabled };
  }
}

export class PostgresPublisher {
  public constructor(
    private readonly sql: Database,
    private readonly globalAiPublishingEnabled: boolean
  ) {}

  public async publish(command: PublishCommand): Promise<PublishResult> {
    const service = new PublisherService(
      new PostgresArticleRepository(this.sql),
      new PostgresPublishingPolicyProvider(this.sql, this.globalAiPublishingEnabled),
      new PostgresScopedIdempotencyStore(this.sql, command.tenantId, "publish")
    );
    return await service.publish(command);
  }
}

export class PostgresSignals {
  public constructor(private readonly sql: Database) {}

  public async submit(command: SignalCommand): Promise<SignalResult> {
    const service = new SignalService(
      new PostgresSignalRepository(this.sql),
      new PostgresScopedIdempotencyStore(this.sql, command.tenantId, "signal")
    );
    return await service.submit(command);
  }
}

function stageToJobType(stage: string): NewsroomJob["type"] {
  const type = `news.${stage}`;
  const allowed = new Set([
    "news.discover","news.research","news.draft","news.factcheck","news.image",
    "news.image_qa","news.editorial_qa","news.publish","news.distribute"
  ]);
  if (!allowed.has(type)) throw new Error(`unsupported newsroom stage: ${stage}`);
  return type as NewsroomJob["type"];
}

export class PostgresQueueAdapter implements QueueAdapter {
  public constructor(private readonly sql: Database) {}

  public async claim(limit: number): Promise<readonly NewsroomJob[]> {
    return await this.sql.begin(async (tx) => {
      const rows = await tx`
        with candidates as (
          select nr.id
          from newsroom_runs nr
          where nr.state = 'queued' and nr.available_at <= now()
          order by nr.available_at, nr.created_at
          for update skip locked
          limit ${limit}
        )
        update newsroom_runs nr
        set state = 'processing',
            attempt_count = nr.attempt_count + 1,
            locked_at = now(),
            lock_token = gen_random_uuid(),
            updated_at = now()
        from candidates c
        where nr.id = c.id
        returning nr.id::text, nr.stage, nr.tenant_id::text, nr.article_id::text,
                  nr.attempt_count, nr.idempotency_key, nr.payload
      `;
      const jobs: NewsroomJob[] = [];
      for (const row of rows) {
        const tenantRows = await tx`select slug from tenants where id = ${String(row["tenant_id"])}::uuid limit 1`;
        const tenant = tenantRows[0];
        if (!tenant) continue;
        const articleId = row["article_id"];
        jobs.push({
          id: String(row["id"]),
          type: stageToJobType(String(row["stage"])),
          tenantId: String(tenant["slug"]),
          ...(articleId === null || articleId === undefined ? {} : { articleId: String(articleId) }),
          attempt: Number(row["attempt_count"]),
          idempotencyKey: String(row["idempotency_key"]),
          payload: asObject(row["payload"])
        });
      }
      return jobs;
    });
  }

  public async complete(jobId: string): Promise<void> {
    await this.sql`
      update newsroom_runs
      set state = 'completed', locked_at = null, lock_token = null, updated_at = now()
      where id::text = ${jobId} and state = 'processing'
    `;
  }

  public async retry(jobId: string, availableAt: string, errorCode: string): Promise<void> {
    await this.sql`
      update newsroom_runs
      set state = 'queued', available_at = ${availableAt}::timestamptz,
          locked_at = null, lock_token = null, last_error_code = ${errorCode}, updated_at = now()
      where id::text = ${jobId} and state = 'processing'
    `;
  }

  public async deadLetter(jobId: string, errorCode: string): Promise<void> {
    await this.sql`
      update newsroom_runs
      set state = 'dead_letter', locked_at = null, lock_token = null,
          last_error_code = ${errorCode}, updated_at = now()
      where id::text = ${jobId} and state = 'processing'
    `;
  }
}

export class PostgresOutboxStore implements OutboxStore {
  public constructor(private readonly sql: Database) {}

  public async claim(limit: number): Promise<readonly ClaimedOutboxEvent[]> {
    return await this.sql.begin(async (tx) => {
      const rows = await tx`
        with candidates as (
          select oe.id
          from outbox_events oe
          where (
            oe.state = 'pending'
            or (oe.state = 'processing' and oe.locked_at < now() - interval '10 minutes')
          )
          and oe.available_at <= now()
          order by oe.available_at, oe.created_at
          for update skip locked
          limit ${limit}
        )
        update outbox_events oe
        set state = 'processing',
            attempt_count = oe.attempt_count + 1,
            locked_at = now(),
            lock_token = gen_random_uuid()
        from candidates c
        where oe.id = c.id
        returning oe.id::text, oe.tenant_id::text, oe.aggregate_type, oe.aggregate_id,
                  oe.event_type, oe.dedupe_key, oe.payload, oe.attempt_count, oe.lock_token::text
      `;
      const events: ClaimedOutboxEvent[] = [];
      for (const row of rows) {
        const tenantRows = await tx`select slug from tenants where id = ${String(row["tenant_id"])}::uuid limit 1`;
        const tenant = tenantRows[0];
        if (!tenant) continue;
        events.push({
          id: String(row["id"]),
          tenantId: String(tenant["slug"]),
          aggregateType: String(row["aggregate_type"]),
          aggregateId: String(row["aggregate_id"]),
          eventType: String(row["event_type"]),
          dedupeKey: String(row["dedupe_key"]),
          payload: asObject(row["payload"]),
          attemptCount: Number(row["attempt_count"]),
          leaseToken: String(row["lock_token"])
        });
      }
      return events;
    });
  }

  public async markDispatched(eventId: string, leaseToken: string): Promise<void> {
    await this.sql`
      update outbox_events
      set state = 'dispatched', dispatched_at = now(), locked_at = null, lock_token = null
      where id::text = ${eventId} and lock_token::text = ${leaseToken} and state = 'processing'
    `;
  }

  public async retry(eventId: string, leaseToken: string, availableAt: string, errorCode: string): Promise<void> {
    await this.sql`
      update outbox_events
      set state = 'pending', available_at = ${availableAt}::timestamptz,
          locked_at = null, lock_token = null, last_error_code = ${errorCode}
      where id::text = ${eventId} and lock_token::text = ${leaseToken} and state = 'processing'
    `;
  }

  public async deadLetter(eventId: string, leaseToken: string, errorCode: string): Promise<void> {
    await this.sql`
      update outbox_events
      set state = 'dead_letter', locked_at = null, lock_token = null, last_error_code = ${errorCode}
      where id::text = ${eventId} and lock_token::text = ${leaseToken} and state = 'processing'
    `;
  }
}
