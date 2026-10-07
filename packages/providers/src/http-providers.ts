import type { ContentPackage, DistributionAdapter, DistributionResult } from "../../distribution/src/distribution.ts";
import type {
  DraftArticle,
  EditorialAssessment,
  MediaCandidate,
  MediaProvider
} from "../../newsroom/src/pipeline.ts";

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  }
) => Promise<HttpResponse>;

export class ProviderConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ProviderConfigurationError(`${name} is required`);
  return normalized;
}

async function postJson(
  fetcher: FetchLike,
  url: string,
  headers: Readonly<Record<string, string>>,
  payload: unknown
): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();
  if (!response.ok) {
    const detail = responseText.trim().replace(/\s+/g, " ").slice(0, 500);
    throw new Error(
      `provider request failed with status ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }
  return responseText ? JSON.parse(responseText) : {};
}

export class ResendNewsletterAdapter implements DistributionAdapter {
  public readonly channel = "newsletter" as const;
  readonly #fetcher: FetchLike;
  readonly #apiKey: string;
  readonly #from: string;
  readonly #segmentId: string;
  readonly #replyTo: string | undefined;

  public constructor(input: {
    readonly fetcher: FetchLike;
    readonly apiKey: string;
    readonly from: string;
    readonly segmentId: string;
    readonly replyTo?: string;
  }) {
    this.#fetcher = input.fetcher;
    this.#apiKey = required(input.apiKey, "RESEND_API_KEY");
    this.#from = required(input.from, "RESEND_FROM");
    this.#segmentId = required(input.segmentId, "RESEND_SEGMENT_ID");
    this.#replyTo = input.replyTo?.trim() || undefined;
  }

  public async deliver(content: ContentPackage, idempotencyKey: string): Promise<DistributionResult> {
    const authorization = { authorization: `Bearer ${this.#apiKey}` };
    const createResult = await postJson(
      this.#fetcher,
      "https://api.resend.com/broadcasts",
      { ...authorization, "idempotency-key": `${idempotencyKey}:create` },
      {
        segment_id: this.#segmentId,
        from: this.#from,
        subject: content.headline,
        name: `Publishing Engine: ${content.id}`,
        html: `<h1>${escapeHtml(content.headline)}</h1><p>${escapeHtml(content.standfirst)}</p><p><a href="${escapeHtml(content.canonicalUrl)}">Read the full article</a></p>`,
        text: `${content.headline}\n\n${content.standfirst}\n\nRead the full article: ${content.canonicalUrl}`,
        ...(this.#replyTo ? { reply_to: this.#replyTo } : {})
      }
    ) as { readonly id?: unknown };

    if (typeof createResult.id !== "string" || !createResult.id) {
      throw new Error("Resend did not return a broadcast id.");
    }

    await postJson(
      this.#fetcher,
      `https://api.resend.com/broadcasts/${encodeURIComponent(createResult.id)}/send`,
      { ...authorization, "idempotency-key": `${idempotencyKey}:send` },
      {}
    );

    return { channel: this.channel, status: "delivered", externalId: createResult.id };
  }
}

export interface GeneratedImage {
  readonly sourceUrl: string;
  readonly altText: string;
}

export interface ImageGenerator {
  generate(draft: DraftArticle): Promise<GeneratedImage>;
}

export class CloudinaryMediaProvider implements MediaProvider {
  readonly #fetcher: FetchLike;
  readonly #generator: ImageGenerator;
  readonly #cloudName: string;
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #assetFolder: string;
  readonly #now: () => Date;

  public constructor(input: {
    readonly fetcher: FetchLike;
    readonly generator: ImageGenerator;
    readonly cloudName: string;
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly assetFolder: string;
    readonly now?: () => Date;
  }) {
    this.#fetcher = input.fetcher;
    this.#generator = input.generator;
    this.#cloudName = required(input.cloudName, "CLOUDINARY_CLOUD_NAME");
    this.#apiKey = required(input.apiKey, "CLOUDINARY_API_KEY");
    this.#apiSecret = required(input.apiSecret, "CLOUDINARY_API_SECRET");
    this.#assetFolder = required(input.assetFolder, "CLOUDINARY_ASSET_FOLDER");
    this.#now = input.now ?? (() => new Date());
  }

  public async create(draft: DraftArticle): Promise<MediaCandidate> {
    const generated = await this.#generator.generate(draft);
    const sourceUrl = required(generated.sourceUrl, "generated image sourceUrl");
    const altText = required(generated.altText, "generated image altText");
    const timestamp = Math.floor(this.#now().getTime() / 1000);
    const toSign = `asset_folder=${this.#assetFolder}&timestamp=${timestamp}${this.#apiSecret}`;
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(toSign));
    const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const body = new URLSearchParams({
      file: sourceUrl,
      api_key: this.#apiKey,
      timestamp: String(timestamp),
      signature,
      asset_folder: this.#assetFolder
    }).toString();

    const response = await this.#fetcher(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.#cloudName)}/image/upload`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      }
    );
    if (!response.ok) throw new Error(`Cloudinary upload failed with status ${response.status}`);

    const result = await response.json() as {
      readonly asset_id?: unknown;
      readonly secure_url?: unknown;
      readonly public_id?: unknown;
      readonly width?: unknown;
      readonly height?: unknown;
    };
    if (typeof result.asset_id !== "string" || typeof result.secure_url !== "string") {
      throw new Error("Cloudinary response is missing asset_id or secure_url.");
    }

    return {
      assetId: result.asset_id,
      ...(typeof result.public_id === "string" ? { publicId: result.public_id } : {}),
      url: result.secure_url,
      altText,
      ...(typeof result.width === "number" ? { width: result.width } : {}),
      ...(typeof result.height === "number" ? { height: result.height } : {})
    };
  }

  public async assess(asset: MediaCandidate): Promise<EditorialAssessment> {
    const reasons: string[] = [];
    if (!asset.url.startsWith("https://")) reasons.push("media URL must use HTTPS");
    if (!asset.altText.trim()) reasons.push("media alt text is required");
    if (asset.width !== undefined && asset.width <= 0) reasons.push("media width must be positive");
    if (asset.height !== undefined && asset.height <= 0) reasons.push("media height must be positive");
    return { passed: reasons.length === 0, score: reasons.length === 0 ? 1 : 0, reasons };
  }
}

export class WebhookDistributionAdapter implements DistributionAdapter {
  public readonly channel = "webhook" as const;
  readonly #fetcher: FetchLike;
  readonly #url: string;
  readonly #token: string | undefined;

  public constructor(input: { readonly fetcher: FetchLike; readonly url: string; readonly token?: string }) {
    this.#fetcher = input.fetcher;
    this.#url = required(input.url, "WEBHOOK_URL");
    this.#token = input.token?.trim() || undefined;
  }

  public async deliver(content: ContentPackage, idempotencyKey: string): Promise<DistributionResult> {
    const headers: Record<string, string> = { "idempotency-key": idempotencyKey };
    if (this.#token) headers["authorization"] = `Bearer ${this.#token}`;
    await postJson(this.#fetcher, this.#url, headers, content);
    return { channel: this.channel, status: "delivered" };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
