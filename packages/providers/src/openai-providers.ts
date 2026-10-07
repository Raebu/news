import type {
  ClaimAssessment,
  DraftArticle,
  DraftProvider,
  EditorialAssessment,
  EditorialProvider,
  FactCheckProvider,
  ResearchProvider,
  ResearchSource,
  StoryCandidate
} from "../../newsroom/src/pipeline.ts";
import type { GeneratedImage, ImageGenerator } from "./http-providers.ts";

interface ResponseOutputText {
  readonly type?: unknown;
  readonly text?: unknown;
}

interface ResponseOutputItem {
  readonly type?: unknown;
  readonly content?: readonly ResponseOutputText[];
  readonly action?: {
    readonly sources?: readonly { readonly type?: unknown; readonly url?: unknown }[];
  };
  readonly result?: unknown;
}

interface ResponsesResult {
  readonly id?: unknown;
  readonly output?: readonly ResponseOutputItem[];
  readonly usage?: unknown;
}

export interface OpenAIResponseMetadata {
  readonly responseId: string | null;
  readonly usage: Readonly<Record<string, unknown>>;
}

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly textModel?: string;
  readonly imageModel?: string;
  readonly fetcher?: typeof fetch;
}

export class OpenAIProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenAIProviderError";
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new OpenAIProviderError(`${name} is required`);
  return normalized;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function outputText(result: ResponsesResult): string {
  const chunks: string[] = [];
  for (const item of result.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") chunks.push(content.text);
    }
  }
  const joined = chunks.join("\n").trim();
  if (!joined) throw new OpenAIProviderError("OpenAI response contained no output text.");
  return joined;
}

function parseJson<T>(raw: string, label: string): T {
  const normalized = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(normalized) as T;
  } catch {
    throw new OpenAIProviderError(`OpenAI returned invalid JSON for ${label}.`);
  }
}

function webSourceUrls(result: ResponsesResult): Set<string> {
  const urls = new Set<string>();
  for (const item of result.output ?? []) {
    const sources = item.action?.sources ?? [];
    for (const source of sources) {
      if (source.type === "url" && typeof source.url === "string") urls.add(source.url);
    }
  }
  return urls;
}

function assertHttpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new OpenAIProviderError("source URL must be a string.");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new OpenAIProviderError("source URL must use HTTPS.");
  return url.toString();
}

export class OpenAIResponsesClient {
  readonly #apiKey: string;
  readonly #textModel: string;
  readonly #imageModel: string;
  readonly #fetcher: typeof fetch;
  #lastMetadata: OpenAIResponseMetadata = { responseId: null, usage: {} };

  public constructor(options: OpenAIProviderOptions) {
    this.#apiKey = required(options.apiKey, "OPENAI_API_KEY");
    this.#textModel = options.textModel?.trim() || "gpt-5.6-luna";
    this.#imageModel = options.imageModel?.trim() || "gpt-image-2";
    this.#fetcher = options.fetcher ?? fetch;
  }

  public get textModel(): string {
    return this.#textModel;
  }

  public get imageModel(): string {
    return this.#imageModel;
  }

  public get lastMetadata(): OpenAIResponseMetadata {
    return this.#lastMetadata;
  }

  public async response(input: {
    readonly instructions: string;
    readonly prompt: string;
    readonly webSearch?: boolean;
  }): Promise<ResponsesResult> {
    const body = {
      model: this.#textModel,
      instructions: input.instructions,
      input: input.prompt,
      ...(input.webSearch ? { tools: [{ type: "web_search" }] } : {}),
      store: false
    };
    const response = await this.#fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new OpenAIProviderError(`OpenAI Responses API failed with status ${response.status}.`);
    }
    const result = await response.json() as ResponsesResult;
    this.#lastMetadata = {
      responseId: typeof result.id === "string" ? result.id : null,
      usage: objectValue(result.usage)
    };
    return result;
  }

  public async generateImage(prompt: string): Promise<GeneratedImage> {
    const response = await this.#fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.#textModel,
        input: prompt,
        tools: [{
          type: "image_generation",
          model: this.#imageModel,
          size: "1536x1024",
          quality: "medium",
          output_format: "png"
        }],
        tool_choice: { type: "image_generation" },
        store: false
      })
    });
    if (!response.ok) {
      throw new OpenAIProviderError(`OpenAI image generation failed with status ${response.status}.`);
    }
    const result = await response.json() as ResponsesResult;
    this.#lastMetadata = {
      responseId: typeof result.id === "string" ? result.id : null,
      usage: objectValue(result.usage)
    };
    const imageItem = (result.output ?? []).find((item) =>
      item.type === "image_generation_call" && typeof item.result === "string"
    );
    if (!imageItem || typeof imageItem.result !== "string") {
      throw new OpenAIProviderError("OpenAI response contained no generated image.");
    }
    return {
      sourceUrl: `data:image/png;base64,${imageItem.result}`,
      altText: prompt.slice(0, 240)
    };
  }
}

export class OpenAIResearchProvider implements ResearchProvider {
  readonly #client: OpenAIResponsesClient;

  public constructor(client: OpenAIResponsesClient) {
    this.#client = client;
  }

  public async research(candidate: StoryCandidate): Promise<readonly ResearchSource[]> {
    const result = await this.#client.response({
      webSearch: true,
      instructions: [
        "You are a rigorous newsroom researcher.",
        "Use web search and return only sources you actually consulted.",
        "Prefer primary sources, official records, filings and direct statements.",
        "Do not invent URLs, titles, publishers, dates or excerpts.",
        "Return JSON only: {\"sources\":[{\"url\":string,\"title\":string,\"publisher\":string,\"excerpt\":string}]}"
      ].join(" "),
      prompt: `Research this proposed story for publication. Title: ${candidate.title}. Signal source references: ${JSON.stringify(candidate.sourceRefs)}. Importance: ${candidate.importance}/100.`
    });
    const usedUrls = webSourceUrls(result);
    const parsed = parseJson<{ readonly sources?: readonly Record<string, unknown>[] }>(outputText(result), "research");
    const now = new Date().toISOString();
    const sources: ResearchSource[] = [];
    for (const source of parsed.sources ?? []) {
      const url = assertHttpsUrl(source["url"]);
      if (usedUrls.size > 0 && !usedUrls.has(url) && !usedUrls.has(url.replace(/\/$/, ""))) continue;
      const title = typeof source["title"] === "string" ? source["title"].trim() : "";
      if (!title) continue;
      sources.push({
        url,
        title,
        ...(typeof source["publisher"] === "string" && source["publisher"].trim()
          ? { publisher: source["publisher"].trim() }
          : {}),
        ...(typeof source["excerpt"] === "string" && source["excerpt"].trim()
          ? { excerpt: source["excerpt"].trim().slice(0, 1200) }
          : {}),
        retrievedAt: now
      });
    }
    return [...new Map(sources.map((source) => [source.url, source])).values()];
  }
}

export class OpenAIDraftProvider implements DraftProvider {
  readonly #client: OpenAIResponsesClient;

  public constructor(client: OpenAIResponsesClient) {
    this.#client = client;
  }

  public async draft(candidate: StoryCandidate, sources: readonly ResearchSource[]): Promise<DraftArticle> {
    const result = await this.#client.response({
      instructions: [
        "You are a careful professional newsroom writer.",
        "Write only facts supported by the supplied research.",
        "Do not add invented quotes, numbers, people, dates or claims.",
        "Use neutral, precise UK English.",
        "Return JSON only with keys headline, standfirst, body, category, seoTitle, seoDescription.",
        "body must be publication-ready Markdown."
      ].join(" "),
      prompt: `Story: ${candidate.title}\nResearch:\n${JSON.stringify(sources)}`
    });
    const value = parseJson<Record<string, unknown>>(outputText(result), "draft");
    const get = (name: string) => typeof value[name] === "string" ? value[name].trim() : "";
    const draft: DraftArticle = {
      headline: get("headline"),
      standfirst: get("standfirst"),
      body: get("body"),
      category: get("category") || "News",
      seoTitle: get("seoTitle") || get("headline"),
      seoDescription: get("seoDescription") || get("standfirst")
    };
    if (!draft.headline || !draft.standfirst || !draft.body) {
      throw new OpenAIProviderError("OpenAI draft is missing required fields.");
    }
    return draft;
  }
}

export class OpenAIFactCheckProvider implements FactCheckProvider {
  readonly #client: OpenAIResponsesClient;

  public constructor(client: OpenAIResponsesClient) {
    this.#client = client;
  }

  public async check(draft: DraftArticle, sources: readonly ResearchSource[]): Promise<readonly ClaimAssessment[]> {
    const result = await this.#client.response({
      webSearch: true,
      instructions: [
        "You are an adversarial fact checker.",
        "Identify material factual claims in the draft and independently verify them using web search.",
        "Every material claim must be supported, conflicted or unsupported.",
        "Return JSON only: {\"claims\":[{\"claim\":string,\"status\":\"supported\"|\"conflicted\"|\"unsupported\",\"sourceUrls\":[string]}]}.",
        "Never mark a claim supported without at least one HTTPS source URL."
      ].join(" "),
      prompt: `Draft:\n${draft.body}\n\nInitial research:\n${JSON.stringify(sources)}`
    });
    const usedUrls = webSourceUrls(result);
    const parsed = parseJson<{ readonly claims?: readonly Record<string, unknown>[] }>(outputText(result), "fact check");
    const claims: ClaimAssessment[] = [];
    for (const row of parsed.claims ?? []) {
      const claim = typeof row["claim"] === "string" ? row["claim"].trim() : "";
      const status = row["status"];
      if (!claim || (status !== "supported" && status !== "conflicted" && status !== "unsupported")) continue;
      const rawUrls = Array.isArray(row["sourceUrls"]) ? row["sourceUrls"] : [];
      const urls: string[] = [];
      for (const raw of rawUrls) {
        try {
          const url = assertHttpsUrl(raw);
          if (usedUrls.size === 0 || usedUrls.has(url) || usedUrls.has(url.replace(/\/$/, ""))) urls.push(url);
        } catch {
          // Invalid model-supplied sources are ignored; the claim then fails the supported-source rule.
        }
      }
      const uniqueUrls = [...new Set(urls)];
      claims.push({
        claim,
        status: status === "supported" && uniqueUrls.length === 0 ? "unsupported" : status,
        sourceUrls: uniqueUrls
      });
    }
    if (claims.length === 0) throw new OpenAIProviderError("Fact checker returned no material claims.");
    return claims;
  }
}

export class OpenAIEditorialProvider implements EditorialProvider {
  readonly #client: OpenAIResponsesClient;

  public constructor(client: OpenAIResponsesClient) {
    this.#client = client;
  }

  public async assess(input: Parameters<EditorialProvider["assess"]>[0]): Promise<EditorialAssessment> {
    const result = await this.#client.response({
      instructions: [
        "You are the final publication QA editor.",
        "Fail copy for unsupported assertions, sensationalism, ambiguity, poor attribution, legal-risk wording, fabricated quotations, or material mismatch with the evidence.",
        "Return JSON only: {\"passed\":boolean,\"score\":number,\"reasons\":[string]}. score must be 0 through 1."
      ].join(" "),
      prompt: JSON.stringify(input)
    });
    const value = parseJson<Record<string, unknown>>(outputText(result), "editorial QA");
    const score = typeof value["score"] === "number" ? value["score"] : 0;
    const reasons = Array.isArray(value["reasons"])
      ? value["reasons"].filter((item): item is string => typeof item === "string").slice(0, 20)
      : [];
    return {
      passed: value["passed"] === true && score >= 0 && score <= 1,
      score: Math.max(0, Math.min(1, score)),
      reasons
    };
  }
}

export class OpenAIImageGenerator implements ImageGenerator {
  readonly #client: OpenAIResponsesClient;

  public constructor(client: OpenAIResponsesClient) {
    this.#client = client;
  }

  public async generate(draft: DraftArticle): Promise<GeneratedImage> {
    return await this.#client.generateImage([
      "Create a professional editorial news image for the following article.",
      "Photorealistic, credible, contemporary, no text, no logos, no watermarks, no fabricated documentary evidence.",
      `Headline: ${draft.headline}`,
      `Standfirst: ${draft.standfirst}`
    ].join("\n"));
  }
}
