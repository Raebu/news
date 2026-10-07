import type { ContentPackage, DistributionAdapter, DistributionResult } from "../../distribution/src/distribution.ts";

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
  if (!response.ok) throw new Error(`provider request failed with status ${response.status}`);
  return await response.json();
}

export class ResendNewsletterAdapter implements DistributionAdapter {
  public readonly channel = "newsletter" as const;
  readonly #fetcher: FetchLike;
  readonly #apiKey: string;
  readonly #from: string;
  readonly #audienceId: string;

  public constructor(input: {
    readonly fetcher: FetchLike;
    readonly apiKey: string;
    readonly from: string;
    readonly audienceId: string;
  }) {
    this.#fetcher = input.fetcher;
    this.#apiKey = required(input.apiKey, "RESEND_API_KEY");
    this.#from = required(input.from, "RESEND_FROM");
    this.#audienceId = required(input.audienceId, "RESEND_AUDIENCE_ID");
  }

  public async deliver(content: ContentPackage, idempotencyKey: string): Promise<DistributionResult> {
    const result = await postJson(
      this.#fetcher,
      "https://api.resend.com/broadcasts",
      { authorization: `Bearer ${this.#apiKey}`, "idempotency-key": idempotencyKey },
      {
        audience_id: this.#audienceId,
        from: this.#from,
        subject: content.headline,
        html: `<h1>${escapeHtml(content.headline)}</h1><p>${escapeHtml(content.standfirst)}</p><p><a href="${escapeHtml(content.canonicalUrl)}">Read the full article</a></p>`
      }
    ) as { readonly id?: unknown };
    return {
      channel: this.channel,
      status: "delivered",
      ...(typeof result.id === "string" ? { externalId: result.id } : {})
    };
  }
}

export class WebhookDistributionAdapter implements DistributionAdapter {
  public readonly channel = "webhook" as const;
  readonly #fetcher: FetchLike;
  readonly #url: string;
  readonly #token?: string;

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
