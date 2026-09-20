import assert from "node:assert/strict";
import test from "node:test";
import { routeApiRequest } from "../apps/api/src/api-router.ts";
import { PublicArticleService, type PublicArticleRepository } from "../packages/articles/src/public-articles.ts";
import type { ServiceCredentialVerifier } from "../packages/security/src/tenant-context.ts";

const verifier: ServiceCredentialVerifier = {
  async verify(service, credential) {
    if (credential === "public-site-key-abcdefghijklmnopqrstuvwxyz" && service === "public-site") {
      return { service, allowedTenantIds:["raeburn-group"], permissions:["article:read"] };
    }
    if (credential === "publisher-key-abcdefghijklmnopqrstuvwxyz" && service === "publisher") {
      return { service, allowedTenantIds:["raeburn-group"], permissions:["article:publish","article:publish:autonomous"] };
    }
    if (credential === "signal-key-abcdefghijklmnopqrstuvwxyz" && service === "research") {
      return { service, allowedTenantIds:["raeburn-group"], permissions:["signal:submit"] };
    }
    return null;
  }
};

const repository: PublicArticleRepository = {
  async listCandidates() {
    return {
      records:[
        { id:"a1", tenantId:"raeburn-group", slug:"public-story", status:"PUBLISHED", version:1, headline:"Public", standfirst:null, body:{safe:true}, category:null, publishedAt:"2026-09-19T12:00:00.000Z", updatedAt:"2026-09-19T12:00:00.000Z", featured:false },
        { id:"a2", tenantId:"other-tenant", slug:"leak", status:"PUBLISHED", version:1, headline:"Leak", standfirst:null, body:{secret:true}, category:null, publishedAt:"2026-09-19T12:00:00.000Z", updatedAt:"2026-09-19T12:00:00.000Z", featured:false }
      ],
      nextCursor:null
    };
  },
  async findCandidateBySlug(_tenantId, slug) {
    if (slug === "public-story") return { id:"a1", tenantId:"raeburn-group", slug, status:"PUBLISHED", version:1, headline:"Public", standfirst:null, body:{safe:true}, category:null, publishedAt:"2026-09-19T12:00:00.000Z", updatedAt:"2026-09-19T12:00:00.000Z", featured:false };
    if (slug === "leak") return { id:"a2", tenantId:"other-tenant", slug, status:"PUBLISHED", version:1, headline:"Leak", standfirst:null, body:{secret:true}, category:null, publishedAt:"2026-09-19T12:00:00.000Z", updatedAt:"2026-09-19T12:00:00.000Z", featured:false };
    return null;
  }
};

const articles = new PublicArticleService(repository, () => new Date("2026-09-20T06:00:00.000Z"));
const readiness = { async check() { return { ready:true }; } };

function headers(service: string, credential: string, tenant="raeburn-group") {
  return {
    "x-request-id":"request-12345678",
    "x-raeburn-service":service,
    "x-raeburn-service-key":credential,
    "x-raeburn-tenant-id":tenant
  };
}

test("public read route is authenticated, tenant scoped and published-only", async () => {
  const response = await routeApiRequest({
    method:"GET", path:"/articles?limit=10",
    headers:headers("public-site","public-site-key-abcdefghijklmnopqrstuvwxyz")
  }, { readiness, version:"0.2.0", verifier, publicArticles:articles });
  assert.equal(response.status, 200);
  const returned = response.body["articles"] as readonly {slug:string}[];
  assert.deepEqual(returned.map((article) => article.slug), ["public-story"]);
  assert.equal(response.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
});

test("cross-tenant spoofing and draft-like not-found behavior fail closed", async () => {
  const spoof = await routeApiRequest({
    method:"GET", path:"/articles",
    headers:headers("public-site","public-site-key-abcdefghijklmnopqrstuvwxyz","other-tenant")
  }, { readiness, version:"0.2.0", verifier, publicArticles:articles });
  assert.equal(spoof.status, 401);

  const hidden = await routeApiRequest({
    method:"GET", path:"/articles/leak",
    headers:headers("public-site","public-site-key-abcdefghijklmnopqrstuvwxyz")
  }, { readiness, version:"0.2.0", verifier, publicArticles:articles });
  assert.equal(hidden.status, 404);
});

test("publish route derives tenant/actor from verified identity and requires autonomous permission", async () => {
  let captured: unknown = null;
  const publisher = {
    async publish(command: {
      articleId:string; tenantId:string; expectedVersion:number; idempotencyKey:string;
      actorId:string; initiatedBy:"human"|"autonomous";
    }) {
      captured = command;
      return { articleId:command.articleId, tenantId:command.tenantId, version:command.expectedVersion, status:"PUBLISHED" as const, publishedAt:"2026-09-20T06:00:00.000Z", replayed:false };
    }
  };
  const response = await routeApiRequest({
    method:"POST", path:"/publish",
    headers:{
      ...headers("publisher","publisher-key-abcdefghijklmnopqrstuvwxyz"),
      "content-type":"application/json",
      "idempotency-key":"publish-key-001"
    },
    body:JSON.stringify({ articleId:"article-1", expectedVersion:3, initiatedBy:"autonomous" })
  }, { readiness, version:"0.2.0", verifier, publisher });
  assert.equal(response.status, 201);
  assert.deepEqual(captured, {
    articleId:"article-1", tenantId:"raeburn-group", expectedVersion:3,
    idempotencyKey:"publish-key-001", actorId:"publisher", initiatedBy:"autonomous"
  });

  const forbidden = await routeApiRequest({
    method:"POST", path:"/publish",
    headers:{
      ...headers("public-site","public-site-key-abcdefghijklmnopqrstuvwxyz"),
      "content-type":"application/json", "idempotency-key":"publish-key-002"
    },
    body:JSON.stringify({ articleId:"article-1", expectedVersion:3, initiatedBy:"human" })
  }, { readiness, version:"0.2.0", verifier, publisher });
  assert.equal(forbidden.status, 403);
});

test("signal route validates schema and cannot invoke the publisher", async () => {
  let signalCalls = 0;
  let publishCalls = 0;
  const signals = {
    async submit(command: { tenantId:string; idempotencyKey:string }) {
      signalCalls += 1;
      assert.equal(command.tenantId, "raeburn-group");
      assert.equal(command.idempotencyKey, "signal-key-001");
      return { signalId:"s1", createdAt:"2026-09-20T06:00:00.000Z", replayed:false };
    }
  };
  const publisher = {
    async publish() {
      publishCalls += 1;
      return { articleId:"never", tenantId:"never", version:1, status:"PUBLISHED" as const, publishedAt:"", replayed:false };
    }
  };
  const response = await routeApiRequest({
    method:"POST", path:"/api/newsroom/signals",
    headers:{
      ...headers("research","signal-key-abcdefghijklmnopqrstuvwxyz"),
      "content-type":"application/json",
      "idempotency-key":"signal-key-001"
    },
    body:JSON.stringify({
      signalType:"company.news", title:"Material event",
      sourceRefs:["https://example.invalid/source"], importance:50,
      eventAt:"2026-09-20T05:59:00.000Z", provenance:{collector:"test"}, schemaVersion:"1"
    })
  }, { readiness, version:"0.2.0", verifier, signals, publisher });
  assert.equal(response.status, 202);
  assert.equal(signalCalls, 1);
  assert.equal(publishCalls, 0);
});

test("malformed or over-broad write payloads are rejected without exception leakage", async () => {
  const publisher = {
    async publish() { throw new Error("database password should never leak"); }
  };
  const bad = await routeApiRequest({
    method:"POST", path:"/publish",
    headers:{
      ...headers("publisher","publisher-key-abcdefghijklmnopqrstuvwxyz"),
      "content-type":"application/json", "idempotency-key":"publish-key-003"
    },
    body:JSON.stringify({ articleId:"article-1", expectedVersion:3, initiatedBy:"human", tenantId:"other-tenant" })
  }, { readiness, version:"0.2.0", verifier, publisher });
  assert.equal(bad.status, 400);

  const internal = await routeApiRequest({
    method:"POST", path:"/publish",
    headers:{
      ...headers("publisher","publisher-key-abcdefghijklmnopqrstuvwxyz"),
      "content-type":"application/json", "idempotency-key":"publish-key-004"
    },
    body:JSON.stringify({ articleId:"article-1", expectedVersion:3, initiatedBy:"human" })
  }, { readiness, version:"0.2.0", verifier, publisher });
  assert.equal(internal.status, 500);
  assert.equal(JSON.stringify(internal.body).includes("database password"), false);
});

test("malformed encoded slugs return a bounded client error", async () => {
  const response = await routeApiRequest({
    method:"GET", path:"/articles/%E0%A4%A",
    headers:headers("public-site","public-site-key-abcdefghijklmnopqrstuvwxyz")
  }, { readiness, version:"0.2.0", verifier, publicArticles:articles });
  assert.equal(response.status, 400);
});

test("publisher domain rejections are surfaced as conflicts, not malformed-input errors", async () => {
  const publisher = {
    async publish() {
      const { DomainInvariantError } = await import("../packages/domain/src/article-state.ts");
      throw new DomainInvariantError("Article version changed before publication.");
    }
  };
  const response = await routeApiRequest({
    method:"POST", path:"/publish",
    headers:{
      ...headers("publisher","publisher-key-abcdefghijklmnopqrstuvwxyz"),
      "content-type":"application/json", "idempotency-key":"publish-key-005"
    },
    body:JSON.stringify({ articleId:"article-1", expectedVersion:3, initiatedBy:"human" })
  }, { readiness, version:"0.2.0", verifier, publisher });
  assert.equal(response.status, 409);
  assert.equal((response.body["error"] as {code:string}).code, "publish_conflict");
});
