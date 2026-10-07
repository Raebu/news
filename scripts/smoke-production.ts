import postgres from "postgres";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const apiUrl = required("PUBLISHING_API_URL").replace(/\/$/, "");
const credential = required("PUBLISHING_SERVICE_CREDENTIAL");
const databaseUrl = required("DATABASE_URL_UNPOOLED");
const tenant = "raeburn-smoke";
const service = "publishing-admin";
const idempotencyKey = `smoke-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const sql = postgres(databaseUrl, { max: 1, prepare: true });

const headers = {
  "content-type": "application/json",
  "idempotency-key": idempotencyKey,
  "x-raeburn-tenant-id": tenant,
  "x-raeburn-service": service,
  "x-raeburn-service-key": credential
};

try {
  const health = await fetch(`${apiUrl}/readyz`);
  if (!health.ok) throw new Error(`readiness failed with HTTP ${health.status}`);

  const submitted = await fetch(`${apiUrl}/api/newsroom/signals`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      signalType: "production-smoke",
      title: `Raeburn Publishing Engine production smoke test ${new Date().toISOString()}`,
      sourceRefs: [
        "https://github.com/Raebu/news",
        "https://neon.com/docs/compute/functions/overview"
      ],
      importance: 50,
      eventAt: new Date().toISOString(),
      provenance: {
        type: "controlled-smoke-test",
        note: "Synthetic operational verification; not intended as a real news claim."
      },
      schemaVersion: "1"
    })
  });
  const submission = await submitted.json() as {
    readonly signal?: { readonly signalId?: unknown };
    readonly error?: unknown;
  };
  if (!submitted.ok || typeof submission.signal?.signalId !== "string") {
    throw new Error(`signal submission failed: ${JSON.stringify(submission.error ?? submission)}`);
  }
  const signalId = submission.signal.signalId;
  process.stdout.write(`Signal accepted: ${signalId}\n`);

  const deadline = Date.now() + 20 * 60 * 1000;
  let articleId = "";
  let slug = "";
  let status = "";

  while (Date.now() < deadline) {
    const rows = await sql`
      select a.id::text as article_id, a.slug, a.status
      from newsroom_runs nr
      join articles a on a.id = nr.article_id
      where nr.signal_id::text = ${signalId}
      order by nr.created_at desc
      limit 1
    `;
    const row = rows[0];
    if (row) {
      articleId = String(row["article_id"]);
      slug = String(row["slug"]);
      const nextStatus = String(row["status"]);
      if (nextStatus !== status) {
        status = nextStatus;
        process.stdout.write(`Article state: ${status}\n`);
      }
      if (status === "PUBLISHED") break;
      if (["REJECTED","DUPLICATE","INSUFFICIENT_EVIDENCE","QA_FAILED","GENERATION_FAILED","RETRACTED"].includes(status)) {
        throw new Error(`smoke article reached terminal non-public state: ${status}`);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
  }

  if (status !== "PUBLISHED" || !articleId || !slug) {
    throw new Error(`smoke test timed out; last article state was ${status || "not-created"}`);
  }

  const evidence = await sql`
    select
      (select count(*)::int from generation_runs where article_id::text = ${articleId}) as generation_runs,
      (select count(*)::int from article_sources where article_id::text = ${articleId}) as sources,
      (select count(*)::int from editorial_reviews where article_id::text = ${articleId} and outcome = 'passed') as passed_reviews,
      (select count(*)::int from media_assets where article_id::text = ${articleId} and qa_status = 'passed') as passed_media
  `;
  const proof = evidence[0];
  if (!proof ||
      Number(proof["generation_runs"]) < 3 ||
      Number(proof["sources"]) < 2 ||
      Number(proof["passed_reviews"]) < 2 ||
      Number(proof["passed_media"]) < 1) {
    throw new Error(`publication evidence is incomplete: ${JSON.stringify(proof ?? {})}`);
  }

  const publicRead = await fetch(`${apiUrl}/articles/${encodeURIComponent(slug)}`, {
    headers: {
      "x-raeburn-tenant-id": tenant,
      "x-raeburn-service": service,
      "x-raeburn-service-key": credential
    }
  });
  const publicBody = await publicRead.json();
  if (!publicRead.ok) throw new Error(`published article read failed: ${JSON.stringify(publicBody)}`);

  process.stdout.write("\nPRODUCTION SMOKE TEST PASSED\n");
  process.stdout.write(`Article: ${articleId}\nSlug: ${slug}\n`);
  process.stdout.write(`Generation runs: ${String(proof["generation_runs"])}\n`);
  process.stdout.write(`Sources: ${String(proof["sources"])}\n`);
  process.stdout.write(`Passed reviews: ${String(proof["passed_reviews"])}\n`);
  process.stdout.write(`Passed media: ${String(proof["passed_media"])}\n`);
} finally {
  await sql.end({ timeout: 5 });
}
