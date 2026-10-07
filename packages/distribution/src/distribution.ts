export type DistributionChannel =
  | "website"
  | "rss"
  | "newsletter"
  | "linkedin"
  | "x"
  | "devto"
  | "hashnode"
  | "youtube"
  | "webhook";

export interface ContentPackage {
  readonly id: string;
  readonly tenantId: string;
  readonly articleId: string;
  readonly articleVersion: number;
  readonly canonicalUrl: string;
  readonly headline: string;
  readonly standfirst: string;
  readonly body: string;
  readonly imageUrl?: string;
  readonly channels: readonly DistributionChannel[];
  readonly createdAt: string;
}

export interface DistributionResult {
  readonly channel: DistributionChannel;
  readonly status: "delivered" | "skipped" | "failed";
  readonly externalId?: string;
  readonly errorCode?: string;
}

export interface DistributionAdapter {
  readonly channel: DistributionChannel;
  deliver(content: ContentPackage, idempotencyKey: string): Promise<DistributionResult>;
}

export class DistributionPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DistributionPolicyError";
  }
}

export async function distributeContent(
  content: ContentPackage,
  adapters: readonly DistributionAdapter[],
  idempotencyPrefix: string
): Promise<readonly DistributionResult[]> {
  const byChannel = new Map(adapters.map((adapter) => [adapter.channel, adapter]));
  const results: DistributionResult[] = [];

  for (const channel of content.channels) {
    const adapter = byChannel.get(channel);
    if (!adapter) {
      results.push({ channel, status: "skipped", errorCode: "adapter_not_configured" });
      continue;
    }
    const key = `${idempotencyPrefix}:${content.id}:${channel}`;
    try {
      const result = await adapter.deliver(content, key);
      if (result.channel !== channel) {
        throw new DistributionPolicyError("distribution adapter returned the wrong channel");
      }
      results.push(result);
    } catch {
      results.push({ channel, status: "failed", errorCode: "delivery_failed" });
    }
  }

  return results;
}
