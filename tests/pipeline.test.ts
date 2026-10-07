import assert from "node:assert/strict";
import test from "node:test";
import { runNewsroomPipeline } from "../packages/newsroom/src/pipeline.ts";

const candidate = {
  tenantId: "tenant-1",
  signalId: "signal-1",
  title: "Material development",
  sourceRefs: ["https://example.com/a", "https://example.com/b"],
  importance: 80
};

const policy = {
  minimumSources: 2,
  minimumSupportedClaimRatio: 1,
  minimumEditorialScore: 0.9,
  allowAutonomousPublish: false,
  requireImage: false
};

test("pipeline passes only after research, factual and editorial gates", async () => {
  const artifact = await runNewsroomPipeline(candidate, policy, {
    research: { async research() { return [
      { url: "https://example.com/a", title: "A", retrievedAt: new Date(0).toISOString() },
      { url: "https://example.com/b", title: "B", retrievedAt: new Date(0).toISOString() }
    ]; } },
    drafting: { async draft() { return {
      headline: "Headline", standfirst: "Standfirst", body: "Body", category: "Business",
      seoTitle: "SEO", seoDescription: "Description"
    }; } },
    factCheck: { async check() { return [
      { claim: "Claim", status: "supported" as const, sourceUrls: ["https://example.com/a"] }
    ]; } },
    editorial: { async assess() { return { passed: true, score: 0.95, reasons: [] }; } }
  });
  assert.equal(artifact.editorial.passed, true);
  assert.equal(artifact.sources.length, 2);
});

test("pipeline fails closed when evidence is insufficient", async () => {
  await assert.rejects(() => runNewsroomPipeline(candidate, policy, {
    research: { async research() { return [
      { url: "https://example.com/a", title: "A", retrievedAt: new Date(0).toISOString() }
    ]; } },
    drafting: { async draft() { throw new Error("should not run"); } },
    factCheck: { async check() { return []; } },
    editorial: { async assess() { return { passed: true, score: 1, reasons: [] }; } }
  }), /research gate failed/);
});
