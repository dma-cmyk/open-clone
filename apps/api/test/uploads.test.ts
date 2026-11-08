// WP4: アップローダの統合テスト（Catbox/Cloudinary 等の外部 API は MSW でモック）。
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { ulid } from "shared";
import { network } from "./network";
import {
  PNG_BYTES,
  anonymousCookie,
  apiFetch,
  createTestAccount,
  deleteSiteConfig,
  prepareUpload,
  proxyUpload,
  readJson,
  resetWp4State,
  setSiteConfig,
  type ApiEnvelope,
} from "./wp4-helpers";
import { attachToPost } from "../src/services/uploads/attach";
import { listAttachmentsForPosts } from "../src/services/uploads/store";
import { runAttachmentLinkCheck } from "../src/services/uploads/cron";
import { composeLimitedStream } from "../src/services/uploads/proxy";
import { decryptSecret, encryptSecret } from "../src/services/github/crypto";
import { makeBoard, makeThread } from "./ai-helpers";

interface PrepareData {
  ticketId: string;
  adapter: string;
  mode: string;
  plan: {
    mode: string;
    proxyPath?: string;
    url?: string;
    method?: string;
    formFields?: Record<string, string>;
    resultType?: string;
  };
  uploadToken?: string;
  maxBytes: number;
  contentType: string;
  expiresAt: number;
}

interface AttachmentData {
  id: string;
  url: string;
  kind: string;
  adapter: string;
  postId: number | null;
  size: number;
}

beforeEach(async () => {
  await resetWp4State();
  // アップロードの Turnstile は既定 ON。通常のテストでは無効化し、必要なテストだけ有効化する。
  await setSiteConfig("uploader.require_turnstile", false);
});

describe("GET /v1/uploads/adapters", () => {
  it("組み込みアダプタ一覧と既定（catbox）を返す", async () => {
    const response = await apiFetch("/v1/uploads/adapters", { method: "GET" });
    expect(response.status).toBe(200);
    const body = await readJson<
      ApiEnvelope<{ items: Array<{ id: string; mode: string; available: boolean; requiresGithub: boolean }>; defaultAdapter: string }>
    >(response);
    expect(body.ok).toBe(true);
    expect(body.data!.defaultAdapter).toBe("catbox");
    const ids = body.data!.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["catbox", "cloudinary", "gist", "github", "litterbox", "mock"]));
    const catbox = body.data!.items.find((item) => item.id === "catbox")!;
    expect(catbox.mode).toBe("proxy-stream");
    expect(catbox.available).toBe(true);
    const gist = body.data!.items.find((item) => item.id === "gist")!;
    expect(gist.requiresGithub).toBe(true);
    expect(gist.available).toBe(false);
  });
});

describe("アップロードの基本フロー（mock アダプタ）", () => {
  it("prepare → proxy → commit → history → 表示メタ → 削除 が通る", async () => {
    await setSiteConfig("uploader.default", "mock");
    const cookie = anonymousCookie();

    const prep = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "pixel.png",
    });
    expect(prep.response.status).toBe(201);
    const prepared = prep.data.data as unknown as PrepareData;
    expect(prepared.adapter).toBe("mock");
    expect(prepared.plan.mode).toBe("proxy-stream");
    expect(prepared.plan.proxyPath).toContain("/v1/uploads/proxy?ticket=");
    expect(prepared.uploadToken).toBeTruthy();
    expect(prepared.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const proxyResponse = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    expect(proxyResponse.status).toBe(200);
    const proxyBody = await readJson<ApiEnvelope<{ ticketId: string; externalUrl: string; kind: string }>>(
      proxyResponse,
    );
    expect(proxyBody.data!.externalUrl).toMatch(/^https:\/\/mock\.uploads\.local\//);
    expect(proxyBody.data!.kind).toBe("image");

    const commitResponse = await apiFetch("/v1/uploads/commit", {
      cookie,
      body: { ticketId: prepared.ticketId },
    });
    expect(commitResponse.status).toBe(201);
    const attachment = (await readJson<ApiEnvelope<AttachmentData>>(commitResponse)).data!;
    expect(attachment.kind).toBe("image");
    expect(attachment.url).toBe(proxyBody.data!.externalUrl);
    expect(attachment.postId).toBeNull();

    // commit は冪等（同じ ticket を再送しても同じ添付を返す）
    const secondCommit = await apiFetch("/v1/uploads/commit", {
      cookie,
      body: { ticketId: prepared.ticketId },
    });
    expect(secondCommit.status).toBe(200);
    expect((await readJson<ApiEnvelope<AttachmentData>>(secondCommit)).data!.id).toBe(attachment.id);

    // 履歴（open2ch の画像履歴相当）
    const historyResponse = await apiFetch("/v1/uploads/history", { method: "GET", cookie });
    const history = await readJson<ApiEnvelope<{ items: AttachmentData[]; limitReached: boolean }>>(historyResponse);
    expect(history.data!.items.map((item) => item.id)).toContain(attachment.id);

    // 単体取得
    const detailResponse = await apiFetch(`/v1/uploads/${attachment.id}`, { method: "GET", cookie });
    const detail = await readJson<ApiEnvelope<AttachmentData & { canDelete: boolean }>>(detailResponse);
    expect(detail.data!.canDelete).toBe(true);

    // 削除（未投稿の自分の添付）
    const deleteResponse = await apiFetch(`/v1/uploads/${attachment.id}`, { method: "DELETE", cookie });
    expect(deleteResponse.status).toBe(200);
    const afterDelete = await apiFetch("/v1/uploads/history", { method: "GET", cookie });
    expect((await readJson<ApiEnvelope<{ items: AttachmentData[] }>>(afterDelete)).data!.items).toHaveLength(0);

    // 添付テーブルは URL とメタだけ（本体・BLOB 列が存在しない）
    const columns = await env.DB.prepare("PRAGMA table_info(attachments)").all<{ name: string; type: string }>();
    const names = columns.results.map((column) => column.name);
    expect(names).not.toContain("content");
    expect(names).not.toContain("body");
    expect(names).not.toContain("data");
    expect(columns.results.every((column) => column.type !== "BLOB")).toBe(true);
  });

  it("別端末からは他人の添付を削除できない", async () => {
    await setSiteConfig("uploader.default", "mock");
    const owner = anonymousCookie();
    const other = anonymousCookie();
    const prep = await prepareUpload(owner, { contentType: "image/png", size: PNG_BYTES.length, filename: "a.png" });
    const prepared = prep.data.data as unknown as PrepareData;
    await proxyUpload(owner, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    const commit = await apiFetch("/v1/uploads/commit", { cookie: owner, body: { ticketId: prepared.ticketId } });
    const attachment = (await readJson<ApiEnvelope<AttachmentData>>(commit)).data!;

    // 他人の履歴には出ない
    const history = await apiFetch("/v1/uploads/history", { method: "GET", cookie: other });
    expect((await readJson<ApiEnvelope<{ items: AttachmentData[] }>>(history)).data!.items).toHaveLength(0);
    const deleteResponse = await apiFetch(`/v1/uploads/${attachment.id}`, { method: "DELETE", cookie: other });
    expect(deleteResponse.status).toBe(403);
  });

  it("proxy はトークンなし・不正トークンでは実行できない", async () => {
    await setSiteConfig("uploader.default", "mock");
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, { contentType: "image/png", size: PNG_BYTES.length, filename: "a.png" });
    const prepared = prep.data.data as unknown as PrepareData;

    const noToken = await proxyUpload(cookie, prepared.plan.proxyPath!, "wrong-token", PNG_BYTES);
    expect(noToken.status).toBe(403);
  });
});

describe("Catbox アダプタ（Worker ストリーム中継）", () => {
  it("multipart をストリーム連結して送信し、返された URL を保存する", async () => {
    await setSiteConfig("uploader.default", "catbox");
    let captured: { contentType: string; text: string } | null = null;
    network.use(
      http.post("https://catbox.moe/user/api.php", async ({ request }) => {
        const text = await request.text();
        captured = { contentType: request.headers.get("content-type") ?? "", text };
        return HttpResponse.text("https://files.catbox.moe/abc123.png");
      }),
    );

    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "pixel.png",
    });
    expect(prep.response.status).toBe(201);
    const prepared = prep.data.data as unknown as PrepareData;
    expect(prepared.adapter).toBe("catbox");
    // Worker の受信上限（Free 100MB）より安全側の 95MiB まで中継できる
    expect(prepared.maxBytes).toBe(95 * 1024 * 1024);

    const proxyResponse = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    expect(proxyResponse.status).toBe(200);
    const proxyBody = await readJson<ApiEnvelope<{ externalUrl: string }>>(proxyResponse);
    expect(proxyBody.data!.externalUrl).toBe("https://files.catbox.moe/abc123.png");

    // 上流へは multipart/form-data で、reqtype/fileToUpload が付いている
    expect(captured).not.toBeNull();
    const request = captured as unknown as { contentType: string; text: string };
    expect(request.contentType).toContain("multipart/form-data; boundary=");
    expect(request.text).toContain('name="reqtype"');
    expect(request.text).toContain("fileupload");
    expect(request.text).toContain('name="fileToUpload"');
    expect(request.text).toContain('filename="pixel.png"');

    const commit = await apiFetch("/v1/uploads/commit", { cookie, body: { ticketId: prepared.ticketId } });
    expect(commit.status).toBe(201);
    const attachment = (await readJson<ApiEnvelope<AttachmentData>>(commit)).data!;
    expect(attachment.adapter).toBe("catbox");

    // D1 には URL のみ（ファイル本体は Cloudflare に残らない）
    const row = await env.DB.prepare("SELECT external_url, size FROM attachments WHERE id = ?")
      .bind(attachment.id)
      .first<{ external_url: string; size: number }>();
    expect(row!.external_url).toBe("https://files.catbox.moe/abc123.png");
    expect(row!.size).toBe(PNG_BYTES.length);
  });

  it("上流の失敗は BAD_GATEWAY に変換し、添付を作らない", async () => {
    await setSiteConfig("uploader.default", "catbox");
    network.use(
      http.post("https://catbox.moe/user/api.php", () => new HttpResponse("upstream down", { status: 500 })),
    );
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, { contentType: "image/png", size: PNG_BYTES.length, filename: "a.png" });
    const prepared = prep.data.data as unknown as PrepareData;
    const proxyResponse = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    expect(proxyResponse.status).toBe(502);
    const commit = await apiFetch("/v1/uploads/commit", { cookie, body: { ticketId: prepared.ticketId } });
    // proxy が失敗した ticket は prepared のままなので、proxy モードの commit は拒否される
    expect(commit.status).toBe(400);
  });
});

describe("サイズ制限", () => {
  it("宣言サイズを超える Content-Length は 413", async () => {
    await setSiteConfig("uploader.default", "mock");
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, { contentType: "image/png", size: 4, filename: "a.png" });
    const prepared = prep.data.data as unknown as PrepareData;
    const proxyResponse = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    expect(proxyResponse.status).toBe(413);
  });

  it("Content-Length なしでもストリーム通過バイト数で 413", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG_BYTES);
        controller.close();
      },
    });
    const limited = composeLimitedStream({
      prefix: new Uint8Array(0),
      suffix: new Uint8Array(0),
      body,
      maxBytes: 4,
    });
    await expect(async () => {
      const reader = limited.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }).rejects.toMatchObject({ status: 413 });
  });

  it("中継ストリームは下流の要求分だけ読む（全量をメモリへ溜めない）", async () => {
    // 95MB を一気に生成せず、pull された分だけチャンクを作る source を使う。
    // composeLimitedStream が start で全量を読み切る実装だと produced が数千になる。
    const chunk = new Uint8Array(64 * 1024);
    let produced = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 2048) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(chunk);
      },
    });
    const limited = composeLimitedStream({
      prefix: new Uint8Array(0),
      suffix: new Uint8Array(0),
      body: source,
      maxBytes: 95 * 1024 * 1024,
    });
    const reader = limited.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(produced).toBeLessThanOrEqual(2);
    await reader.cancel();
  });

  it("宣言 MIME とマジックバイトの不一致は 400", async () => {
    await setSiteConfig("uploader.default", "mock");
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, { contentType: "image/png", size: 100, filename: "fake.png" });
    const prepared = prep.data.data as unknown as PrepareData;
    // 実際は JPEG のバイト列なのに image/png と宣言
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const response = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, jpeg);
    expect(response.status).toBe(400);
  });
});

describe("direct アダプタ（Cloudinary / Litterbox）", () => {
  it("Cloudinary は署名付き direct 計画を返し、commit で URL と削除トークンを保存する", async () => {
    await env.DB.prepare(
      "INSERT INTO uploader_adapters (id, kind, enabled, config, created_at) VALUES ('cloudinary', 'cloudinary', 1, ?, ?)",
    )
      .bind(JSON.stringify({ cloudName: "test-cloud", folder: "oc" }), Math.floor(Date.now() / 1000))
      .run();

    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, {
      adapter: "cloudinary",
      contentType: "image/png",
      size: 1000,
      filename: "a.png",
    });
    expect(prep.response.status).toBe(201);
    const prepared = prep.data.data as unknown as PrepareData;
    expect(prepared.plan.mode).toBe("direct");
    expect(prepared.plan.url).toBe("https://api.cloudinary.com/v1_1/test-cloud/auto/upload");
    expect(prepared.plan.resultType).toBe("json");
    expect(prepared.plan.formFields!.api_key).toBe("test-api-key");
    expect(prepared.plan.formFields!.folder).toBe("oc");
    expect(prepared.plan.formFields!.signature).toMatch(/^[0-9a-f]{40}$/);

    const commit = await apiFetch("/v1/uploads/commit", {
      cookie,
      body: {
        ticketId: prepared.ticketId,
        response: {
          secure_url: "https://res.cloudinary.com/test-cloud/image/upload/v1/abc.png",
          public_id: "abc",
          bytes: 1000,
          delete_token: "delete-me",
        },
      },
    });
    expect(commit.status).toBe(201);
    const attachment = (await readJson<ApiEnvelope<AttachmentData>>(commit)).data!;
    expect(attachment.url).toBe("https://res.cloudinary.com/test-cloud/image/upload/v1/abc.png");
    const row = await env.DB.prepare("SELECT delete_url, meta FROM attachments WHERE id = ?")
      .bind(attachment.id)
      .first<{ delete_url: string | null; meta: string }>();
    expect(row!.delete_url).toBe("cloudinary:delete_by_token");
    expect(JSON.parse(row!.meta).deleteToken).toBe("delete-me");
  });

  it("許可ホスト以外の URL は commit できない", async () => {
    await env.DB.prepare(
      "INSERT INTO uploader_adapters (id, kind, enabled, config, created_at) VALUES ('cloudinary', 'cloudinary', 1, ?, ?)",
    )
      .bind(JSON.stringify({ cloudName: "test-cloud" }), Math.floor(Date.now() / 1000))
      .run();
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, {
      adapter: "cloudinary",
      contentType: "image/png",
      size: 100,
      filename: "a.png",
    });
    const prepared = prep.data.data as unknown as PrepareData;
    const commit = await apiFetch("/v1/uploads/commit", {
      cookie,
      body: {
        ticketId: prepared.ticketId,
        response: { secure_url: "https://evil.example/steal.png", bytes: 100 },
      },
    });
    expect(commit.status).toBe(400);
  });

  it("Litterbox は externalUrl だけでも commit できる（text 応答）", async () => {
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, {
      adapter: "litterbox",
      contentType: "image/png",
      size: 100,
      filename: "a.png",
    });
    const prepared = prep.data.data as unknown as PrepareData;
    expect(prepared.plan.mode).toBe("direct");
    expect(prepared.plan.resultType).toBe("text");
    expect(prepared.plan.formFields!.time).toBe("72h");

    const commit = await apiFetch("/v1/uploads/commit", {
      cookie,
      body: {
        ticketId: prepared.ticketId,
        externalUrl: "https://litterbox.catbox.moe/resources/internals/abc.png",
      },
    });
    expect(commit.status).toBe(201);
    const attachment = (await readJson<ApiEnvelope<AttachmentData>>(commit)).data!;
    expect(attachment.adapter).toBe("litterbox");
    expect(attachment.url).toBe("https://litterbox.catbox.moe/resources/internals/abc.png");
  });
});

describe("板ごとのアダプタ切替", () => {
  it("板設定（site_config の board キー）だけで保存先が変わる", async () => {
    await setSiteConfig("uploader.default", "catbox");
    await setSiteConfig("uploader.board.42.default", "mock");
    const cookie = anonymousCookie();

    const boardPrep = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "a.png",
      boardId: 42,
    });
    expect((boardPrep.data.data as unknown as PrepareData).adapter).toBe("mock");

    const sitePrep = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "a.png",
    });
    expect((sitePrep.data.data as unknown as PrepareData).adapter).toBe("catbox");
  });
});

describe("C-1: アップロードの Turnstile は投稿と同じ板設定に従う", () => {
  it("板が turnstile=off ならサイト既定が ON でも匿名がトークンなしで画像付き投稿できる", async () => {
    // サイト既定（uploader.require_turnstile=true）は板 ID なしの場合だけ使われる。
    await deleteSiteConfig("uploader.require_turnstile");
    const boardId = await makeBoard({ settings: { turnstile: "off" } });
    const threadId = await makeThread({ boardId });
    const cookie = anonymousCookie();

    // prepare は boardId 付きなので板設定 off が優先される（以前は 400 TURNSTILE_FAILED）。
    const prep = await prepareUpload(cookie, {
      adapter: "mock",
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "anon.png",
      boardId,
    });
    expect(prep.response.status).toBe(201);
    const prepared = prep.data.data as unknown as PrepareData;

    const proxied = await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    expect(proxied.status).toBe(200);
    const commit = await apiFetch("/v1/uploads/commit", {
      cookie,
      body: { ticketId: prepared.ticketId },
    });
    expect(commit.status).toBe(201);
    const attachment = (await readJson<ApiEnvelope<AttachmentData>>(commit)).data!;

    // 匿名のまま画像付きレスを投稿できる。
    const posted = await apiFetch(`/v1/threads/${threadId}/posts`, {
      cookie,
      body: { body: "匿名で画像を添付します", attachments: [attachment.id] },
    });
    expect(posted.status).toBe(201);
    const result = (await readJson<ApiEnvelope<{ post: { attachments: AttachmentData[] } }>>(posted)).data!;
    expect(result.post.attachments.map((item) => item.id)).toContain(attachment.id);
  });

  it("板が turnstile=anonymous なら匿名はトークン必須・ログイン済みは不要", async () => {
    const boardId = await makeBoard({ settings: { turnstile: "anonymous" } });
    const anonymous = anonymousCookie();

    const rejected = await prepareUpload(anonymous, {
      adapter: "mock",
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "a.png",
      boardId,
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.data.code).toBe("TURNSTILE_FAILED");

    // ログイン済みは anonymous 方針では不要（投稿側の判定と同じ）。
    const account = await createTestAccount();
    const accepted = await prepareUpload(account.cookie, {
      adapter: "mock",
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "a.png",
      boardId,
    });
    expect(accepted.response.status).toBe(201);

    // 匿名でもトークンがあれば通る（ウィジェット表示時の経路）。
    network.use(
      http.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", () =>
        HttpResponse.json({ success: true }),
      ),
    );
    const withToken = await apiFetch("/v1/uploads/prepare", {
      cookie: anonymous,
      headers: { "x-turnstile-token": "dummy-token" },
      body: { adapter: "mock", contentType: "image/png", size: PNG_BYTES.length, filename: "a.png", boardId },
    });
    expect(withToken.status).toBe(201);
  });
});

describe("Turnstile とレート制限", () => {
  it("Turnstile 必須時はトークンなしで 400、成功トークンで通る", async () => {
    await deleteSiteConfig("uploader.require_turnstile");
    await setSiteConfig("uploader.default", "mock");
    const cookie = anonymousCookie();

    const rejected = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "a.png",
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.data.code).toBe("TURNSTILE_FAILED");

    network.use(
      http.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", () =>
        HttpResponse.json({ success: true }),
      ),
    );
    const accepted = await apiFetch("/v1/uploads/prepare", {
      cookie,
      headers: { "x-turnstile-token": "dummy-token" },
      body: { contentType: "image/png", size: PNG_BYTES.length, filename: "a.png" },
    });
    expect(accepted.status).toBe(201);
  });

  it("日次上限（50/日）を超えると 429（RateLimiter DO）", async () => {
    await setSiteConfig("uploader.default", "mock");
    // ユニークな端末で固定窓カウンタを最初から使う（他のテストの DO 状態と衝突しない）
    const cookie = anonymousCookie("d".repeat(32));

    for (let i = 0; i < 50; i += 1) {
      const prepared = await prepareUpload(cookie, {
        contentType: "image/png",
        size: PNG_BYTES.length,
        filename: "a.png",
      });
      expect(prepared.response.status).toBe(201);
    }

    const limited = await prepareUpload(cookie, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "a.png",
    });
    expect(limited.response.status).toBe(429);
    expect(limited.data.code).toBe("RATE_LIMITED");
  });
});

describe("attachToPost（WP1 契約）", () => {
  it("未投稿の添付を投稿に紐付け、二重紐付けしない", async () => {
    await setSiteConfig("uploader.default", "mock");
    const cookie = anonymousCookie();
    const prep = await prepareUpload(cookie, { contentType: "image/png", size: PNG_BYTES.length, filename: "a.png" });
    const prepared = prep.data.data as unknown as PrepareData;
    await proxyUpload(cookie, prepared.plan.proxyPath!, prepared.uploadToken!, PNG_BYTES);
    const commit = await apiFetch("/v1/uploads/commit", { cookie, body: { ticketId: prepared.ticketId } });
    const attachment = (await readJson<ApiEnvelope<AttachmentData>>(commit)).data!;

    await attachToPost(1001, [attachment.id, "missing-id"], env.DB);
    const grouped = await listAttachmentsForPosts(env.DB, [1001]);
    expect(grouped[1001]!.map((item) => item.id)).toEqual([attachment.id]);

    // 既に紐付いた添付は別投稿へ移動しない
    await attachToPost(1002, [attachment.id], env.DB);
    const row = await env.DB.prepare("SELECT post_id FROM attachments WHERE id = ?")
      .bind(attachment.id)
      .first<{ post_id: number }>();
    expect(row!.post_id).toBe(1001);

    // 1002 には添付なし
    expect(await listAttachmentsForPosts(env.DB, [1002])).toEqual({});
  });
});

describe("verify リンク死活（cron）", () => {
  it("404 の添付を dead にし、生存は last_verified_at を更新する", async () => {
    network.use(
      http.head("https://files.catbox.moe/dead.png", () => new HttpResponse(null, { status: 404 })),
      http.head("https://files.catbox.moe/alive.png", () => new HttpResponse(null, { status: 200 })),
    );
    const now = Math.floor(Date.now() / 1000);
    const device = "b".repeat(64);
    for (const url of ["https://files.catbox.moe/dead.png", "https://files.catbox.moe/alive.png"]) {
      await env.DB.prepare(
        "INSERT INTO attachments (id, post_id, uploader_account_id, device_hash, board_id, adapter, external_url, content_type, size, filename, kind, status, created_at) VALUES (?, NULL, NULL, ?, NULL, 'catbox', ?, 'image/png', 10, 'a.png', 'image', 'active', ?)",
      )
        .bind(ulid(), device, url, now)
        .run();
    }
    // 期限切れ ticket も掃除される
    await env.DB.prepare(
      "INSERT INTO upload_tickets (id, token_hash, adapter_id, mode, device_hash, account_id, filename, content_type, size, status, expires_at, created_at) VALUES (?, ?, 'catbox', 'proxy-stream', ?, NULL, 'a.png', 'image/png', 10, 'prepared', ?, ?)",
    )
      .bind(ulid(), `exp-${ulid()}`, device, now - 10, now - 100)
      .run();

    const result = await runAttachmentLinkCheck(env);
    expect(result.checked).toBe(2);
    expect(result.dead).toBe(1);
    expect(result.alive).toBe(1);
    expect(result.expiredTickets).toBe(1);

    const dead = await env.DB.prepare("SELECT status FROM attachments WHERE external_url = ?")
      .bind("https://files.catbox.moe/dead.png")
      .first<{ status: string }>();
    expect(dead!.status).toBe("dead");
    const alive = await env.DB.prepare("SELECT status, last_verified_at FROM attachments WHERE external_url = ?")
      .bind("https://files.catbox.moe/alive.png")
      .first<{ status: string; last_verified_at: number | null }>();
    expect(alive!.status).toBe("active");
    expect(alive!.last_verified_at).not.toBeNull();
  });
});

describe("トークン暗号化（AES-GCM）", () => {
  it("平文と異なる形式で保存され、復号すると元に戻る", async () => {
    const plaintext = "ghp_exampletoken1234567890";
    const encrypted = await encryptSecret(plaintext, env.ENC_KEY);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    expect(await decryptSecret(encrypted, env.ENC_KEY)).toBe(plaintext);
  });
});