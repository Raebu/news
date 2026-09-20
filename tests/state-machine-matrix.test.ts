import assert from "node:assert/strict";
import test from "node:test";
import { ARTICLE_STATUSES, canTransition, type ArticleStatus } from "../packages/domain/src/article-state.ts";

const expected: Readonly<Record<ArticleStatus, readonly ArticleStatus[]>> = {
  DISCOVERED:["RESEARCHING","DUPLICATE","REJECTED"],
  RESEARCHING:["CANDIDATE","INSUFFICIENT_EVIDENCE","DUPLICATE","REJECTED"],
  CANDIDATE:["DRAFTING","REJECTED","DUPLICATE"],
  DRAFTING:["FACT_CHECK","GENERATION_FAILED","REJECTED"],
  FACT_CHECK:["IMAGE_GENERATION","DRAFTING","QA_FAILED","INSUFFICIENT_EVIDENCE","REJECTED"],
  IMAGE_GENERATION:["EDITORIAL_QA","GENERATION_FAILED","QA_FAILED","REJECTED"],
  EDITORIAL_QA:["READY","DRAFTING","QA_FAILED","REJECTED"],
  READY:["PUBLISHED","DRAFTING","REJECTED"],
  PUBLISHED:["UPDATED","ARCHIVED","RETRACTED"],
  UPDATED:["UPDATED","ARCHIVED","RETRACTED"],
  ARCHIVED:[], REJECTED:[], DUPLICATE:[],
  INSUFFICIENT_EVIDENCE:["RESEARCHING","REJECTED"],
  QA_FAILED:["DRAFTING","IMAGE_GENERATION","EDITORIAL_QA","REJECTED"],
  GENERATION_FAILED:["DRAFTING","IMAGE_GENERATION","REJECTED"],
  RETRACTED:[]
};

test("every allowed and forbidden lifecycle transition matches the canonical matrix", () => {
  for (const from of ARTICLE_STATUSES) {
    for (const to of ARTICLE_STATUSES) {
      assert.equal(canTransition(from, to), expected[from].includes(to), `${from} -> ${to}`);
    }
  }
});
