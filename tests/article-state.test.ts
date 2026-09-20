import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, canTransition, isPublicArticleStatus } from "../packages/domain/src/article-state.ts";

test("state machine allows expected happy-path transitions", () => {
  const path = ["DISCOVERED","RESEARCHING","CANDIDATE","DRAFTING","FACT_CHECK","IMAGE_GENERATION","EDITORIAL_QA","READY","PUBLISHED"] as const;
  for (let index = 0; index < path.length - 1; index += 1) {
    assert.equal(canTransition(path[index]!, path[index + 1]!), true);
  }
});

test("state machine blocks publication before READY", () => {
  assert.equal(canTransition("FACT_CHECK", "PUBLISHED"), false);
  assert.throws(() => assertTransition("EDITORIAL_QA", "PUBLISHED"), /Illegal article transition/);
});

test("only current public states are public", () => {
  assert.equal(isPublicArticleStatus("PUBLISHED"), true);
  assert.equal(isPublicArticleStatus("UPDATED"), true);
  assert.equal(isPublicArticleStatus("READY"), false);
  assert.equal(isPublicArticleStatus("RETRACTED"), false);
});
