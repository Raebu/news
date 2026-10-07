import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudinaryMediaProvider,
  ResendNewsletterAdapter,
  type FetchLike
} from "../packages/providers/src/http-providers.ts";

test("Resend newsletter adapter creates then sends a segment broadcast", async () => {
  const requests: Array<{ url: string; body: string | undefined; headers: Readonly<Record<string, string>> }> = [];
  const fetcher: FetchLike = async (url, init) => {
    requests.push({ url, body: init.body, headers: init.headers });
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: "broadcast-1" };
      },
      async text() { return ""; }
    };
  };

  const adapter = new ResendNewsletterAdapter({
    fetcher,
    apiKey: "test-key",
    from: "News <news@example.com>",
    replyTo: "reply@example.com",
    segmentId: "segment-1"
  });

  const result = await adapter.deliver({
    id: "package-1",
    tenantId: "tenant-1",
    articleId: "article-1",
    articleVersion: 1,
    canonicalUrl: "https://example.com/news/a",
    headline: "Headline",
    standfirst: "Standfirst",
    body: "Body",
    channels: ["newsletter"],
    createdAt: new Date(0).toISOString()
  }, "delivery-1");

  assert.equal(result.status, "delivered");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://api.resend.com/broadcasts");
  assert.equal(requests[1]?.url, "https://api.resend.com/broadcasts/broadcast-1/send");
  const createPayload = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(createPayload["segment_id"], "segment-1");
  assert.equal(createPayload["reply_to"], "reply@example.com");
  assert.equal(requests[0]?.headers["idempotency-key"], "delivery-1:create");
  assert.equal(requests[1]?.headers["idempotency-key"], "delivery-1:send");
});

test("Cloudinary media provider uploads generated images into the configured asset folder", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const fetcher: FetchLike = async (url, init) => {
    capturedUrl = url;
    capturedBody = init.body ?? "";
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          asset_id: "asset-1",
          secure_url: "https://res.cloudinary.com/demo/image/upload/article.png",
          width: 1600,
          height: 900
        };
      },
      async text() { return ""; }
    };
  };

  const provider = new CloudinaryMediaProvider({
    fetcher,
    generator: {
      async generate() {
        return { sourceUrl: "https://example.com/generated.png", altText: "Editorial illustration" };
      }
    },
    cloudName: "u7dpgaxh",
    apiKey: "api-key",
    apiSecret: "api-secret",
    assetFolder: "Cloudinary/The_Raeburn_Holding_Group_Ltd/news",
    now: () => new Date("2026-10-07T00:00:00.000Z")
  });

  const asset = await provider.create({
    headline: "Headline",
    standfirst: "Standfirst",
    body: "Body",
    category: "Business",
    seoTitle: "SEO",
    seoDescription: "Description"
  });

  assert.equal(capturedUrl, "https://api.cloudinary.com/v1_1/u7dpgaxh/image/upload");
  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get("file"), "https://example.com/generated.png");
  assert.equal(params.get("api_key"), "api-key");
  assert.equal(params.get("asset_folder"), "Cloudinary/The_Raeburn_Holding_Group_Ltd/news");
  assert.ok((params.get("signature") ?? "").length > 0);
  assert.equal(asset.assetId, "asset-1");
  assert.equal(asset.width, 1600);

  const qa = await provider.assess(asset);
  assert.equal(qa.passed, true);
});
