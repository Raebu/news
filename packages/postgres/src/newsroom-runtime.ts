import { assertTransition, type ArticleStatus } from "../../domain/src/article-state.ts";
import type {
  ClaimAssessment,
  DraftArticle,
  MediaCandidate,
  ResearchSource,
  StoryCandidate,
  TenantEditorialPolicy
} from "../../newsroom/src/pipeline.ts";
import {
  CloudinaryMediaProvider,
  ResendNewsletterAdapter,
  WebhookDistributionAdapter
} from "../../providers/src/http-providers.ts";
import {
  OpenAIDraftProvider,
  OpenAIEditorialProvider,
  OpenAIFactCheckProvider,
  OpenAIImageGenerator,
  OpenAIResearchProvider,
  OpenAIResponsesClient
} from "../../providers/src/openai-providers.ts";
import { distributeContent, type ContentPackage, type DistributionAdapter, type DistributionChannel } from "../../distribution/src/distribution.ts";
import type { JobHandler, JobType, NewsroomJob } from "../../../apps/worker/src/worker.ts";
import { PostgresPublisher, type Database } from "./runtime.ts";

interface RuntimeEnvironment {
  readonly publicBaseUrl: string;
  readonly aiPublishingEnabled: boolean;
  readonly openAiApiKey: string;
  readonly openAiTextModel?: string;
  readonly openAiImageModel?: string;
  readonly cloudinaryCloudName: string;
  readonly cloudinaryApiKey: string;
  readonly cloudinaryApiSecret: string;
  readonly cloudinaryAssetFolder: string;
  readonly resendApiKey?: string;
  readonly resendFrom?: string;
  readonly resendReplyTo?: string;
  readonly resendSegmentId?: string;
  readonly distributionWebhookUrl?: string;
  readonly distributionWebhookToken?: string;
}

interface TenantRuntimePolicy extends TenantEditorialPolicy {
  readonly distributionChannels: readonly DistributionChannel[];
}

interface ArticleContext {
  readonly articleId: string;
  readonly tenantId: string;
  readonly tenantUuid: string;
  readonly status: ArticleStatus;
  readonly version: number;
  readonly signalId: string;
  readonly candidate: StoryCandidate;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function slugify(value: string): string {
  const slug = value.toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "story";
}

function markdownBody(body: unknown): string {
  const value = objectValue(body);
  const content = value["content"];
  if (typeof content !== "string" || !content.trim()) throw new Error("article body is missing");
  return content;
}

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markdownToEmailHtml(markdown: string): string {
  const paragraphs = markdown.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return paragraphs.map((part) => `<p>${htmlEscape(part).replaceAll("\n", "<br>")}</p>`).join("\n");
}

export class ProductionNewsroomRuntime {
  readonly #sql: Database;
  readonly #env: RuntimeEnvironment;
  readonly #client: OpenAIResponsesClient;
  readonly #research: OpenAIResearchProvider;
  readonly #drafting: OpenAIDraftProvider;
  readonly #factCheck: OpenAIFactCheckProvider;
  readonly #editorial: OpenAIEditorialProvider;
  readonly #media: CloudinaryMediaProvider;
  readonly #publisher: PostgresPublisher;

  public constructor(sql: Database, env: RuntimeEnvironment) {
    this.#sql = sql;
    this.#env = env;
    this.#client = new OpenAIResponsesClient({
      apiKey: env.openAiApiKey,
      ...(env.openAiTextModel ? { textModel: env.openAiTextModel } : {}),
      ...(env.openAiImageModel ? { imageModel: env.openAiImageModel } : {})
    });
    this.#research = new OpenAIResearchProvider(this.#client);
    this.#drafting = new OpenAIDraftProvider(this.#client);
    this.#factCheck = new OpenAIFactCheckProvider(this.#client);
    this.#editorial = new OpenAIEditorialProvider(this.#client);
    this.#media = new CloudinaryMediaProvider({
      fetcher: fetch,
      generator: new OpenAIImageGenerator(this.#client),
      cloudName: env.cloudinaryCloudName,
      apiKey: env.cloudinaryApiKey,
      apiSecret: env.cloudinaryApiSecret,
      assetFolder: env.cloudinaryAssetFolder
    });
    this.#publisher = new PostgresPublisher(sql, env.aiPublishingEnabled);
  }

  public handlers(): Readonly<Record<JobType, JobHandler>> {
    return {
      "news.discover": async (job) => await this.#discover(job),
      "news.research": async (job) => await this.#researchStory(job),
      "news.draft": async (job) => await this.#draftStory(job),
      "news.factcheck": async (job) => await this.#factCheckStory(job),
      "news.image": async (job) => await this.#generateImage(job),
      "news.image_qa": async (job) => await this.#imageQa(job),
      "news.editorial_qa": async (job) => await this.#editorialQa(job),
      "news.publish": async (job) => await this.#publish(job),
      "news.distribute": async (job) => await this.#distribute(job)
    };
  }

  async #policy(tenantId: string): Promise<TenantRuntimePolicy> {
    const rows = await this.#sql`
      select publishing_policy from tenants
      where slug = ${tenantId} and active = true limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("tenant not found");
    const policy = objectValue(row["publishing_policy"]);
    const numberValue = (name: string, fallback: number) => {
      const value = policy[name];
      return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    };
    const rawChannels = stringArray(policy["distributionChannels"]);
    const allowedChannels = new Set<DistributionChannel>([
      "website","rss","newsletter","linkedin","x","devto","hashnode","youtube","webhook"
    ]);
    const channels = rawChannels.filter((channel): channel is DistributionChannel =>
      allowedChannels.has(channel as DistributionChannel)
    );
    return {
      minimumSources: Math.max(1, Math.floor(numberValue("minimumSources", 2))),
      minimumSupportedClaimRatio: Math.max(0, Math.min(1, numberValue("minimumSupportedClaimRatio", 1))),
      minimumEditorialScore: Math.max(0, Math.min(1, numberValue("minimumEditorialScore", 0.9))),
      allowAutonomousPublish: policy["allowAutonomousPublish"] === true,
      requireImage: policy["requireImage"] !== false,
      distributionChannels: channels.length > 0 ? channels : ["website"]
    };
  }

  async #context(job: NewsroomJob): Promise<ArticleContext> {
    if (!job.articleId) throw new Error("article id is required");
    const signalId = typeof job.payload?.["signalId"] === "string" ? job.payload["signalId"] : "";
    if (!signalId) throw new Error("signal id is required");
    const rows = await this.#sql`
      select
        a.id::text as article_id, a.status, a.current_version,
        t.id::text as tenant_uuid, t.slug as tenant_slug,
        s.id::text as signal_id, s.title, s.source_refs, s.importance
      from articles a
      join tenants t on t.id = a.tenant_id
      join story_signals s on s.id::text = ${signalId} and s.tenant_id = a.tenant_id
      where a.id::text = ${job.articleId} and t.slug = ${job.tenantId}
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("article context was not found");
    return {
      articleId: String(row["article_id"]),
      tenantId: String(row["tenant_slug"]),
      tenantUuid: String(row["tenant_uuid"]),
      status: String(row["status"]) as ArticleStatus,
      version: Number(row["current_version"]),
      signalId: String(row["signal_id"]),
      candidate: {
        tenantId: String(row["tenant_slug"]),
        signalId: String(row["signal_id"]),
        title: String(row["title"]),
        sourceRefs: stringArray(row["source_refs"]),
        importance: Number(row["importance"])
      }
    };
  }

  async #transition(articleId: string, from: ArticleStatus, to: ArticleStatus): Promise<void> {
    assertTransition(from, to);
    const rows = await this.#sql`
      update articles
      set status = ${to}, updated_at = now(), lock_version = lock_version + 1
      where id::text = ${articleId} and status = ${from}
      returning id
    `;
    if (rows.length !== 1) throw new Error(`article transition lost race: ${from} -> ${to}`);
  }

  async #enqueue(input: {
    readonly tenantUuid: string;
    readonly articleId: string;
    readonly signalId: string;
    readonly stage: string;
    readonly key: string;
  }): Promise<void> {
    await this.#sql`
      insert into newsroom_runs (
        tenant_id, article_id, signal_id, stage, state, attempt_count, available_at,
        trace_id, idempotency_key, payload
      )
      values (
        ${input.tenantUuid}::uuid, ${input.articleId}::uuid, ${input.signalId}::uuid,
        ${input.stage}, 'queued', 0, now(), ${crypto.randomUUID()}, ${input.key},
        ${this.#sql.json({ signalId: input.signalId } as never)}
      )
      on conflict (tenant_id, stage, idempotency_key) do nothing
    `;
  }

  async #recordGeneration(input: {
    readonly tenantUuid: string;
    readonly articleId: string | null;
    readonly runType: string;
    readonly model: string;
    readonly promptVersion: string;
  }): Promise<void> {
    const metadata = this.#client.lastMetadata;
    await this.#sql`
      insert into generation_runs (
        tenant_id, article_id, run_type, model, prompt_version, schema_version,
        output_ref, usage, trace_id
      )
      values (
        ${input.tenantUuid}::uuid,
        ${input.articleId}::uuid,
        ${input.runType}, ${input.model}, ${input.promptVersion}, '1',
        ${metadata.responseId}, ${this.#sql.json(metadata.usage as never)}, ${crypto.randomUUID()}
      )
    `;
  }

  async #discover(job: NewsroomJob): Promise<void> {
    const signalId = typeof job.payload?.["signalId"] === "string" ? job.payload["signalId"] : "";
    if (!signalId) throw new Error("discover job is missing signalId");
    const rows = await this.#sql`
      select s.id::text as signal_id, s.title, t.id::text as tenant_uuid, t.slug as tenant_slug
      from story_signals s
      join tenants t on t.id = s.tenant_id
      where s.id::text = ${signalId} and t.slug = ${job.tenantId} and t.active = true
      limit 1
    `;
    const signal = rows[0];
    if (!signal) throw new Error("signal was not found");
    const slug = `${slugify(String(signal["title"]))}-${signalId.slice(0, 8)}`;
    const inserted = await this.#sql`
      insert into articles (tenant_id, slug, status, current_version)
      values (${String(signal["tenant_uuid"])}::uuid, ${slug}, 'DISCOVERED', 1)
      on conflict (tenant_id, slug) do update set updated_at = articles.updated_at
      returning id::text as id, status
    `;
    const article = inserted[0];
    if (!article) throw new Error("article could not be created");
    const articleId = String(article["id"]);
    await this.#sql`
      update newsroom_runs set article_id = ${articleId}::uuid, updated_at = now()
      where id::text = ${job.id}
    `;
    const status = String(article["status"]) as ArticleStatus;
    if (status === "DISCOVERED") await this.#transition(articleId, "DISCOVERED", "RESEARCHING");
    await this.#enqueue({
      tenantUuid: String(signal["tenant_uuid"]),
      articleId,
      signalId,
      stage: "research",
      key: `research:${articleId}:v1`
    });
  }

  async #researchStory(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    const policy = await this.#policy(context.tenantId);
    const sources = await this.#research.research(context.candidate);
    await this.#recordGeneration({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      runType: "research",
      model: this.#client.textModel,
      promptVersion: "research-v1"
    });
    if (new Set(sources.map((source) => source.url)).size < policy.minimumSources) {
      if (context.status === "RESEARCHING") await this.#transition(context.articleId, "RESEARCHING", "INSUFFICIENT_EVIDENCE");
      return;
    }
    for (const source of sources) {
      await this.#sql`
        insert into article_sources (
          article_id, source_url, source_type, organisation, trust_class, retrieved_at, content_hash
        )
        values (
          ${context.articleId}::uuid, ${source.url}, 'web',
          ${source.publisher ?? null}, 'research', ${source.retrievedAt}::timestamptz, null
        )
      `;
    }
    if (context.status === "RESEARCHING") await this.#transition(context.articleId, "RESEARCHING", "CANDIDATE");
    await this.#transition(context.articleId, "CANDIDATE", "DRAFTING");
    await this.#enqueue({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      signalId: context.signalId,
      stage: "draft",
      key: `draft:${context.articleId}:v1`
    });
  }

  async #sources(articleId: string): Promise<ResearchSource[]> {
    const rows = await this.#sql`
      select source_url, organisation, trust_class, retrieved_at
      from article_sources
      where article_id::text = ${articleId}
      order by created_at
    `;
    return rows.map((row) => ({
      url: String(row["source_url"]),
      title: String(row["organisation"] ?? row["source_url"]),
      ...(row["organisation"] === null ? {} : { publisher: String(row["organisation"]) }),
      retrievedAt: new Date(String(row["retrieved_at"])).toISOString()
    }));
  }

  async #draftStory(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    if (context.status !== "DRAFTING") throw new Error("article is not in DRAFTING");
    const sources = await this.#sources(context.articleId);
    const draft = await this.#drafting.draft(context.candidate, sources);
    await this.#recordGeneration({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      runType: "draft",
      model: this.#client.textModel,
      promptVersion: "draft-v1"
    });
    await this.#sql`
      insert into article_versions (
        article_id, version, headline, standfirst, body, category,
        seo_metadata, social_metadata, created_by, model, prompt_version, schema_version
      )
      values (
        ${context.articleId}::uuid, 1, ${draft.headline}, ${draft.standfirst},
        ${this.#sql.json({ format: "markdown", content: draft.body } as never)}, ${draft.category},
        ${this.#sql.json({ title: draft.seoTitle, description: draft.seoDescription, sensitive: false } as never)},
        '{}'::jsonb, 'newsroom-worker', ${this.#client.textModel}, 'draft-v1', '1'
      )
      on conflict (article_id, version) do nothing
    `;
    await this.#transition(context.articleId, "DRAFTING", "FACT_CHECK");
    await this.#enqueue({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      signalId: context.signalId,
      stage: "factcheck",
      key: `factcheck:${context.articleId}:v1`
    });
  }

  async #draft(articleId: string): Promise<DraftArticle> {
    const rows = await this.#sql`
      select headline, standfirst, body, category, seo_metadata
      from article_versions
      where article_id::text = ${articleId}
      order by version desc limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("article version not found");
    const seo = objectValue(row["seo_metadata"]);
    return {
      headline: String(row["headline"]),
      standfirst: String(row["standfirst"] ?? ""),
      body: markdownBody(row["body"]),
      category: String(row["category"] ?? "News"),
      seoTitle: typeof seo["title"] === "string" ? seo["title"] : String(row["headline"]),
      seoDescription: typeof seo["description"] === "string" ? seo["description"] : String(row["standfirst"] ?? "")
    };
  }

  async #factCheckStory(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    if (context.status !== "FACT_CHECK") throw new Error("article is not in FACT_CHECK");
    const draft = await this.#draft(context.articleId);
    const sources = await this.#sources(context.articleId);
    const claims = await this.#factCheck.check(draft, sources);
    await this.#recordGeneration({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      runType: "factcheck",
      model: this.#client.textModel,
      promptVersion: "factcheck-v1"
    });

    const sourceRows = await this.#sql`
      select id::text as id, source_url from article_sources where article_id::text = ${context.articleId}
    `;
    const sourceIds = new Map(sourceRows.map((row) => [String(row["source_url"]), String(row["id"])]));

    for (const claim of claims) {
      for (const url of claim.sourceUrls) {
        if (!sourceIds.has(url)) {
          const inserted = await this.#sql`
            insert into article_sources (
              article_id, source_url, source_type, trust_class, retrieved_at
            )
            values (${context.articleId}::uuid, ${url}, 'web', 'factcheck', now())
            returning id::text as id
          `;
          const source = inserted[0];
          if (source) sourceIds.set(url, String(source["id"]));
        }
      }
      const insertedClaims = await this.#sql`
        insert into claims (tenant_id, claim_text, verification_status, confidence)
        values (
          ${context.tenantUuid}::uuid, ${claim.claim}, ${claim.status},
          ${claim.status === "supported" ? 1 : claim.status === "conflicted" ? 0.5 : 0}
        )
        returning id::text as id
      `;
      const claimRow = insertedClaims[0];
      if (!claimRow) throw new Error("claim persistence failed");
      const claimId = String(claimRow["id"]);
      await this.#sql`
        insert into article_claims (article_id, version, claim_id, material)
        values (${context.articleId}::uuid, ${context.version}, ${claimId}::uuid, true)
      `;
      for (const url of claim.sourceUrls) {
        const sourceId = sourceIds.get(url);
        if (!sourceId) continue;
        await this.#sql`
          insert into claim_sources (claim_id, source_id, support_type)
          values (
            ${claimId}::uuid, ${sourceId}::uuid,
            ${claim.status === "supported" ? "supports" : claim.status === "conflicted" ? "contradicts" : "context"}
          )
          on conflict do nothing
        `;
      }
    }

    const policy = await this.#policy(context.tenantId);
    const conflicts = claims.filter((claim) => claim.status === "conflicted").length;
    const supported = claims.filter((claim) => claim.status === "supported").length;
    const ratio = claims.length === 0 ? 0 : supported / claims.length;
    const passed = conflicts === 0 && ratio >= policy.minimumSupportedClaimRatio;
    await this.#sql`
      insert into editorial_reviews (
        tenant_id, article_id, article_version, gate, outcome, score, reasons, reviewer
      )
      values (
        ${context.tenantUuid}::uuid, ${context.articleId}::uuid, ${context.version},
        'factcheck', ${passed ? "passed" : "failed"}, ${ratio},
        ${this.#sql.json((passed ? [] : ["material claims did not meet factual support policy"]) as never)},
        ${this.#client.textModel}
      )
    `;
    if (!passed) {
      await this.#transition(context.articleId, "FACT_CHECK", conflicts > 0 ? "QA_FAILED" : "INSUFFICIENT_EVIDENCE");
      return;
    }
    await this.#transition(context.articleId, "FACT_CHECK", "IMAGE_GENERATION");
    await this.#enqueue({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      signalId: context.signalId,
      stage: "image",
      key: `image:${context.articleId}:v${context.version}`
    });
  }

  async #generateImage(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    if (context.status !== "IMAGE_GENERATION") throw new Error("article is not in IMAGE_GENERATION");
    const policy = await this.#policy(context.tenantId);
    if (!policy.requireImage) {
      await this.#transition(context.articleId, "IMAGE_GENERATION", "EDITORIAL_QA");
      await this.#enqueue({
        tenantUuid: context.tenantUuid,
        articleId: context.articleId,
        signalId: context.signalId,
        stage: "editorial_qa",
        key: `editorial:${context.articleId}:v${context.version}`
      });
      return;
    }
    const draft = await this.#draft(context.articleId);
    const media = await this.#media.create(draft);
    await this.#recordGeneration({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      runType: "image",
      model: this.#client.imageModel,
      promptVersion: "image-v1"
    });
    await this.#sql`
      insert into media_assets (
        tenant_id, article_id, cloudinary_asset_id, cloudinary_public_id,
        provenance, width, height, alt_text, qa_status
      )
      values (
        ${context.tenantUuid}::uuid, ${context.articleId}::uuid,
        ${media.assetId}, ${media.publicId ?? media.assetId},
        ${this.#sql.json({ secureUrl: media.url, provider: "openai+cloudinary" } as never)},
        ${media.width ?? null}, ${media.height ?? null}, ${media.altText}, 'pending'
      )
      on conflict (tenant_id, cloudinary_asset_id) do nothing
    `;
    await this.#enqueue({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      signalId: context.signalId,
      stage: "image_qa",
      key: `image-qa:${context.articleId}:v${context.version}`
    });
  }

  async #latestMedia(articleId: string): Promise<MediaCandidate | null> {
    const rows = await this.#sql`
      select cloudinary_asset_id, cloudinary_public_id, provenance, width, height, alt_text
      from media_assets
      where article_id::text = ${articleId}
      order by created_at desc limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const provenance = objectValue(row["provenance"]);
    const url = provenance["secureUrl"];
    if (typeof url !== "string") return null;
    return {
      assetId: String(row["cloudinary_asset_id"]),
      publicId: String(row["cloudinary_public_id"]),
      url,
      altText: String(row["alt_text"] ?? ""),
      ...(row["width"] === null ? {} : { width: Number(row["width"]) }),
      ...(row["height"] === null ? {} : { height: Number(row["height"]) })
    };
  }

  async #imageQa(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    if (context.status !== "IMAGE_GENERATION") throw new Error("article is not in IMAGE_GENERATION");
    const media = await this.#latestMedia(context.articleId);
    if (!media) throw new Error("media asset not found");
    const assessment = await this.#media.assess(media);
    await this.#sql`
      update media_assets set qa_status = ${assessment.passed ? "passed" : "failed"}
      where tenant_id::text = ${context.tenantUuid} and cloudinary_asset_id = ${media.assetId}
    `;
    await this.#sql`
      insert into editorial_reviews (
        tenant_id, article_id, article_version, gate, outcome, score, reasons, reviewer
      )
      values (
        ${context.tenantUuid}::uuid, ${context.articleId}::uuid, ${context.version},
        'image_qa', ${assessment.passed ? "passed" : "failed"}, ${assessment.score},
        ${this.#sql.json([...assessment.reasons] as never)}, 'media-policy'
      )
    `;
    if (!assessment.passed) {
      await this.#transition(context.articleId, "IMAGE_GENERATION", "QA_FAILED");
      return;
    }
    await this.#transition(context.articleId, "IMAGE_GENERATION", "EDITORIAL_QA");
    await this.#enqueue({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      signalId: context.signalId,
      stage: "editorial_qa",
      key: `editorial:${context.articleId}:v${context.version}`
    });
  }

  async #claims(articleId: string, version: number): Promise<ClaimAssessment[]> {
    const rows = await this.#sql`
      select c.id::text as id, c.claim_text, c.verification_status,
             coalesce(array_agg(ars.source_url) filter (where ars.source_url is not null), '{}') as source_urls
      from article_claims ac
      join claims c on c.id = ac.claim_id
      left join claim_sources cs on cs.claim_id = c.id
      left join article_sources ars on ars.id = cs.source_id
      where ac.article_id::text = ${articleId} and ac.version = ${version}
      group by c.id, c.claim_text, c.verification_status
      order by c.created_at
    `;
    return rows.map((row) => ({
      claim: String(row["claim_text"]),
      status: String(row["verification_status"]) as ClaimAssessment["status"],
      sourceUrls: stringArray(row["source_urls"])
    }));
  }

  async #editorialQa(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    if (context.status !== "EDITORIAL_QA") throw new Error("article is not in EDITORIAL_QA");
    const draft = await this.#draft(context.articleId);
    const sources = await this.#sources(context.articleId);
    const claims = await this.#claims(context.articleId, context.version);
    const media = await this.#latestMedia(context.articleId);
    const assessment = await this.#editorial.assess(media
      ? { candidate: context.candidate, draft, sources, claims, media }
      : { candidate: context.candidate, draft, sources, claims });
    await this.#recordGeneration({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      runType: "editorial_qa",
      model: this.#client.textModel,
      promptVersion: "editorial-v1"
    });
    const policy = await this.#policy(context.tenantId);
    const passed = assessment.passed && assessment.score >= policy.minimumEditorialScore;
    await this.#sql`
      insert into editorial_reviews (
        tenant_id, article_id, article_version, gate, outcome, score, reasons, reviewer
      )
      values (
        ${context.tenantUuid}::uuid, ${context.articleId}::uuid, ${context.version},
        'editorial_qa', ${passed ? "passed" : "failed"}, ${assessment.score},
        ${this.#sql.json([...assessment.reasons] as never)}, ${this.#client.textModel}
      )
    `;
    if (!passed) {
      await this.#transition(context.articleId, "EDITORIAL_QA", "QA_FAILED");
      return;
    }
    await this.#transition(context.articleId, "EDITORIAL_QA", "READY");
    if (policy.allowAutonomousPublish && this.#env.aiPublishingEnabled) {
      await this.#enqueue({
        tenantUuid: context.tenantUuid,
        articleId: context.articleId,
        signalId: context.signalId,
        stage: "publish",
        key: `publish:${context.articleId}:v${context.version}`
      });
    }
  }

  async #publish(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    if (context.status !== "READY" && context.status !== "PUBLISHED") throw new Error("article is not publishable");
    await this.#publisher.publish({
      articleId: context.articleId,
      tenantId: context.tenantId,
      expectedVersion: context.version,
      idempotencyKey: job.idempotencyKey,
      actorId: "newsroom-worker",
      initiatedBy: "autonomous"
    });
    const policy = await this.#policy(context.tenantId);
    const draft = await this.#draft(context.articleId);
    const media = await this.#latestMedia(context.articleId);
    const articleRows = await this.#sql`
      select slug from articles where id::text = ${context.articleId} limit 1
    `;
    const article = articleRows[0];
    if (!article) throw new Error("published article not found");
    const canonicalUrl = new URL(`/articles/${encodeURIComponent(String(article["slug"]))}`, this.#env.publicBaseUrl).toString();
    const packageRows = await this.#sql`
      insert into content_packages (
        tenant_id, article_id, article_version, canonical_url,
        headline, standfirst, body, image_url, channels
      )
      values (
        ${context.tenantUuid}::uuid, ${context.articleId}::uuid, ${context.version},
        ${canonicalUrl}, ${draft.headline}, ${draft.standfirst}, ${draft.body},
        ${media?.url ?? null}, ${this.#sql.array([...policy.distributionChannels])}
      )
      on conflict (tenant_id, article_id, article_version)
      do update set canonical_url = excluded.canonical_url
      returning id::text as id
    `;
    const contentPackage = packageRows[0];
    if (!contentPackage) throw new Error("content package was not created");
    await this.#enqueue({
      tenantUuid: context.tenantUuid,
      articleId: context.articleId,
      signalId: context.signalId,
      stage: "distribute",
      key: `distribute:${String(contentPackage["id"])}`
    });
  }

  #distributionAdapters(): DistributionAdapter[] {
    const adapters: DistributionAdapter[] = [{
      channel: "website",
      deliver: async (_content, _idempotencyKey) => ({ channel: "website", status: "delivered" })
    }];
    if (this.#env.resendApiKey && this.#env.resendFrom && this.#env.resendSegmentId) {
      adapters.push(new ResendNewsletterAdapter({
        fetcher: fetch,
        apiKey: this.#env.resendApiKey,
        from: this.#env.resendFrom,
        segmentId: this.#env.resendSegmentId,
        ...(this.#env.resendReplyTo ? { replyTo: this.#env.resendReplyTo } : {})
      }));
    }
    if (this.#env.distributionWebhookUrl) {
      adapters.push(new WebhookDistributionAdapter({
        fetcher: fetch,
        url: this.#env.distributionWebhookUrl,
        ...(this.#env.distributionWebhookToken ? { token: this.#env.distributionWebhookToken } : {})
      }));
    }
    return adapters;
  }

  async #distribute(job: NewsroomJob): Promise<void> {
    const context = await this.#context(job);
    const rows = await this.#sql`
      select id::text as id, canonical_url, headline, standfirst, body, image_url, channels, created_at
      from content_packages
      where tenant_id::text = ${context.tenantUuid}
        and article_id::text = ${context.articleId}
        and article_version = ${context.version}
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("content package not found");
    const channels = stringArray(row["channels"]).filter((channel): channel is DistributionChannel =>
      ["website","rss","newsletter","linkedin","x","devto","hashnode","youtube","webhook"].includes(channel)
    );
    const content: ContentPackage = {
      id: String(row["id"]),
      tenantId: context.tenantId,
      articleId: context.articleId,
      articleVersion: context.version,
      canonicalUrl: String(row["canonical_url"]),
      headline: String(row["headline"]),
      standfirst: String(row["standfirst"]),
      body: String(row["body"]),
      ...(row["image_url"] === null ? {} : { imageUrl: String(row["image_url"]) }),
      channels,
      createdAt: new Date(String(row["created_at"])).toISOString()
    };
    const adapters = this.#distributionAdapters();
    const results = await distributeContent(content, adapters, job.idempotencyKey);
    for (const result of results) {
      await this.#sql`
        insert into distribution_deliveries (
          tenant_id, content_package_id, channel, idempotency_key, state,
          attempt_count, external_id, error_code, delivered_at
        )
        values (
          ${context.tenantUuid}::uuid, ${content.id}::uuid, ${result.channel},
          ${`${job.idempotencyKey}:${content.id}:${result.channel}`},
          ${result.status}, 1, ${result.externalId ?? null}, ${result.errorCode ?? null},
          ${result.status === "delivered" ? new Date().toISOString() : null}::timestamptz
        )
        on conflict (tenant_id, channel, idempotency_key)
        do update set
          state = excluded.state,
          attempt_count = distribution_deliveries.attempt_count + 1,
          external_id = excluded.external_id,
          error_code = excluded.error_code,
          delivered_at = excluded.delivered_at,
          updated_at = now()
      `;
    }
    if (results.some((result) => result.status === "failed")) {
      throw new Error("one or more distribution channels failed");
    }
    await this.#sql`
      update outbox_events
      set state = 'dispatched', dispatched_at = now(), locked_at = null, lock_token = null
      where tenant_id::text = ${context.tenantUuid}
        and aggregate_type = 'article'
        and aggregate_id = ${context.articleId}
        and event_type = 'article.published'
        and state in ('pending','processing')
    `;
  }
}

export function readProductionNewsroomEnvironment(env: Record<string, string | undefined>, base: {
  readonly publicBaseUrl: string;
  readonly aiPublishingEnabled: boolean;
}): RuntimeEnvironment {
  const requireValue = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for the newsroom worker`);
    return value;
  };
  return {
    publicBaseUrl: base.publicBaseUrl,
    aiPublishingEnabled: base.aiPublishingEnabled,
    openAiApiKey: requireValue("OPENAI_API_KEY"),
    ...(env["OPENAI_TEXT_MODEL"]?.trim() ? { openAiTextModel: env["OPENAI_TEXT_MODEL"]!.trim() } : {}),
    ...(env["OPENAI_IMAGE_MODEL"]?.trim() ? { openAiImageModel: env["OPENAI_IMAGE_MODEL"]!.trim() } : {}),
    cloudinaryCloudName: requireValue("CLOUDINARY_CLOUD_NAME"),
    cloudinaryApiKey: requireValue("CLOUDINARY_API_KEY"),
    cloudinaryApiSecret: requireValue("CLOUDINARY_API_SECRET"),
    cloudinaryAssetFolder: requireValue("CLOUDINARY_ASSET_FOLDER"),
    ...(env["RESEND_API_KEY"]?.trim() ? { resendApiKey: env["RESEND_API_KEY"]!.trim() } : {}),
    ...(env["RESEND_FROM"]?.trim() ? { resendFrom: env["RESEND_FROM"]!.trim() } : {}),
    ...(env["RESEND_REPLY_TO"]?.trim() ? { resendReplyTo: env["RESEND_REPLY_TO"]!.trim() } : {}),
    ...(env["RESEND_SEGMENT_ID"]?.trim() ? { resendSegmentId: env["RESEND_SEGMENT_ID"]!.trim() } : {}),
    ...(env["DISTRIBUTION_WEBHOOK_URL"]?.trim() ? { distributionWebhookUrl: env["DISTRIBUTION_WEBHOOK_URL"]!.trim() } : {}),
    ...(env["DISTRIBUTION_WEBHOOK_TOKEN"]?.trim() ? { distributionWebhookToken: env["DISTRIBUTION_WEBHOOK_TOKEN"]!.trim() } : {})
  };
}
