import assert from "node:assert/strict";
import test from "node:test";
import { PublisherService, type ArticleRepository } from "../packages/publisher/src/publisher.ts";
import { InMemoryIdempotencyStore } from "../packages/workflow/src/idempotency.ts";
import type { PublishCandidate } from "../packages/domain/src/publishing.ts";

function candidate(): PublishCandidate {
  return {
    articleId: "article-1", tenantId: "raeburn-group", status: "READY", version: 3,
    factCheck: "passed", editorialQa: "passed", imageQa: "passed", mediaRequired: true,
    mediaAssetId: "asset-1", unresolvedMaterialClaims: 0, sensitive: false, humanApproval: false
  };
}

class FakeRepository implements ArticleRepository {
  public current = candidate();
  public writes = 0;
  async getPublishCandidate(tenantId: string, articleId: string) {
    return this.current.tenantId === tenantId && this.current.articleId === articleId ? this.current : null;
  }
  async publishAtomically(input: { tenantId: string; articleId: string; expectedVersion: number; actorId: string; idempotencyKey: string }) {
    if (this.current.status !== "READY" || this.current.version !== input.expectedVersion) return null;
    this.writes += 1;
    this.current = { ...this.current, status: "PUBLISHED" };
    return { version: input.expectedVersion, publishedAt: "2026-09-20T00:00:00.000Z" };
  }
}

const policies = { async getPolicy() { return { autonomyLevel: "autonomous" as const, aiPublishingEnabled: true }; } };

test("publisher performs one atomic write and replays duplicate command", async () => {
  const repository = new FakeRepository();
  const service = new PublisherService(repository, policies, new InMemoryIdempotencyStore());
  const command = { articleId: "article-1", tenantId: "raeburn-group", expectedVersion: 3, idempotencyKey: "publish-key", actorId: "publisher-agent", initiatedBy: "autonomous" as const };
  const first = await service.publish(command);
  const second = await service.publish(command);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(repository.writes, 1);
});

test("stale expected version is rejected before atomic write", async () => {
  const repository = new FakeRepository();
  const service = new PublisherService(repository, policies, new InMemoryIdempotencyStore());
  await assert.rejects(() => service.publish({ articleId: "article-1", tenantId: "raeburn-group", expectedVersion: 2, idempotencyKey: "stale-key", actorId: "editor", initiatedBy: "human" }), /version changed/);
  assert.equal(repository.writes, 0);
});
