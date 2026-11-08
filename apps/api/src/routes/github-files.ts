// GitHub ファイル操作プロキシ（/v1/github/files/*）と webhook 受信（/v1/github/hooks/*）。
// 全て「本人のリソースのみ・レート残確認付き・監査ログ付き」。未連携は 403 + 連携誘導 details。

import { Hono } from "hono";
import { ApiError, ErrorCode, hmacSha256Hex, ok, timingSafeEqual, type AppRequestContext } from "shared";
import {
  createGistSchema,
  githubOwnerSchema,
  githubRepoSchema,
  repoFileDeleteSchema,
  repoFileReadQuerySchema,
  repoFileWriteSchema,
  repoListQuerySchema,
  updateGistSchema,
} from "shared/schemas/github";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireAuth } from "../lib/middleware/auth";
import { readEnvSecret } from "../services/env-secrets";
import {
  createGist,
  deleteGist,
  deleteRepoFile,
  getFile,
  getGist,
  getRateInfo,
  githubClient,
  listGists,
  listUserRepos,
  logGithubOp,
  pushToRepo,
  updateGist,
  type GithubClient,
} from "../services/github/service";

const app = new Hono<AppEnv>();

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

function assertJsonBodySize(c: { req: { header(name: string): string | undefined } }): void {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "リクエストが大きすぎます");
  }
}

async function clientFor(c: { env: AppEnv["Bindings"]; get(key: "reqCtx"): AppRequestContext }): Promise<GithubClient> {
  const session = getReqCtx(c).session;
  if (!session) throw ApiError.unauthorized();
  return githubClient(c.env, session.account.id);
}

function repoParams(c: { req: { param(name: string): string } }): { owner: string; repo: string } {
  const owner = githubOwnerSchema.parse(c.req.param("owner"));
  const repo = githubRepoSchema.parse(c.req.param("repo"));
  return { owner, repo };
}

// ───────────────────────── リポジトリ一覧・レート ─────────────────────────

app.get("/repos", requireAuth, async (c) => {
  const client = await clientFor(c);
  const query = repoListQuerySchema.parse({
    page: c.req.query("page"),
    perPage: c.req.query("perPage"),
    sort: c.req.query("sort"),
  });
  return c.json(ok({ items: await listUserRepos(client, query) }));
});

app.get("/rate", requireAuth, async (c) => {
  const client = await clientFor(c);
  return c.json(ok(await getRateInfo(client)));
});

// ───────────────────────── Gist ─────────────────────────

app.get("/gists", requireAuth, async (c) => {
  const client = await clientFor(c);
  const page = Number(c.req.query("page") ?? "1");
  const perPage = Number(c.req.query("perPage") ?? "30");
  return c.json(
    ok({
      items: await listGists(
        client,
        Number.isInteger(page) && page > 0 ? page : 1,
        Number.isInteger(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
      ),
    }),
  );
});

app.post("/gists", requireAuth, async (c) => {
  assertJsonBodySize(c);
  const client = await clientFor(c);
  const body = createGistSchema.parse(await c.req.json());
  const result = await createGist(client, {
    description: body.description,
    public: body.public,
    files: body.files,
  });
  return c.json(ok(result), 201);
});

app.get("/gists/:id", requireAuth, async (c) => {
  const client = await clientFor(c);
  return c.json(ok(await getGist(client, c.req.param("id"))));
});

app.patch("/gists/:id", requireAuth, async (c) => {
  assertJsonBodySize(c);
  const client = await clientFor(c);
  const body = updateGistSchema.parse(await c.req.json());
  const result = await updateGist(client, c.req.param("id"), {
    description: body.description,
    files: body.files,
  });
  return c.json(ok(result));
});

app.delete("/gists/:id", requireAuth, async (c) => {
  const client = await clientFor(c);
  await deleteGist(client, c.req.param("id"));
  return c.json(ok({ id: c.req.param("id"), deleted: true }));
});

// ───────────────────────── リポジトリ内ファイル ─────────────────────────

app.get("/repo/:owner/:repo/content", requireAuth, async (c) => {
  const client = await clientFor(c);
  const { owner, repo } = repoParams(c);
  const query = repoFileReadQuerySchema.parse({
    path: c.req.query("path"),
    ref: c.req.query("ref"),
  });
  return c.json(ok(await getFile(client, { owner, repo, path: query.path, ref: query.ref })));
});

app.put("/repo/:owner/:repo/content", requireAuth, async (c) => {
  assertJsonBodySize(c);
  const client = await clientFor(c);
  const { owner, repo } = repoParams(c);
  const body = repoFileWriteSchema.parse(await c.req.json());
  const result = await pushToRepo(client, {
    owner,
    repo,
    path: body.path,
    content: body.content,
    message: body.message,
    sha: body.sha,
    branch: body.branch,
  });
  return c.json(ok(result));
});

app.delete("/repo/:owner/:repo/content", requireAuth, async (c) => {
  assertJsonBodySize(c);
  const client = await clientFor(c);
  const { owner, repo } = repoParams(c);
  const body = repoFileDeleteSchema.parse(await c.req.json());
  await deleteRepoFile(client, {
    owner,
    repo,
    path: body.path,
    sha: body.sha,
    message: body.message,
    branch: body.branch,
  });
  return c.json(ok({ path: body.path, deleted: true }));
});

// ───────────────────────── webhook（運営側 GitHub App 用・任意） ─────────────────────────

app.post("/github", async (c) => {
  const secret = readEnvSecret(c.env, "GITHUB_WEBHOOK_SECRET");
  if (!secret) {
    throw new ApiError(500, ErrorCode.MISCONFIGURED, "GITHUB_WEBHOOK_SECRET が設定されていません");
  }
  const raw = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  if (!signature) throw ApiError.unauthorized("X-Hub-Signature-256 が必要です");

  const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;
  if (!timingSafeEqual(expected, signature)) {
    throw ApiError.unauthorized("webhook 署名が一致しません");
  }

  const deliveryId = c.req.header("x-github-delivery");
  const event = c.req.header("x-github-event") ?? "unknown";
  if (!deliveryId) throw ApiError.validation("X-GitHub-Delivery が必要です");

  let action: string | null = null;
  try {
    const payload = JSON.parse(raw) as { action?: unknown };
    if (typeof payload.action === "string") action = payload.action;
  } catch {
    // 署名済みでも JSON でない場合は action なしで記録する
  }

  const digest = await hmacSha256Hex(secret, raw);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO github_webhook_events (delivery_id, event, action, payload_digest, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(deliveryId, event, action, digest, Math.floor(Date.now() / 1000))
    .run();

  await logGithubOp(c.env.DB, {
    accountId: null,
    op: `webhook.${event}`,
    ref: deliveryId,
    status: "ok",
    detail: { action },
  });

  if (event === "ping") return c.json(ok({ pong: true, deliveryId }));
  return c.json(ok({ received: true, deliveryId, event, action }));
});

export default app;