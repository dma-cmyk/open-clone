// F7 受入: 専ブラ互換（/compat/:slug/bbs.cgi）の Turnstile 制御とエラー HTML エスケープ。

import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ErrorCode, decodeShiftJis, encodeShiftJis } from "shared";
import * as pipeline from "../src/lib/pipeline";
import { network } from "./network";
import { TestClient, authedClient, createBoard, createThread, resetWorld } from "./wp1/helpers";

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const REJECT_TEXT = "この板は専ブラからの書き込みに対応していません。ブラウザから書き込んでください。";

function sjisBody(response: Response): Promise<string> {
  return response.arrayBuffer().then((buffer) => decodeShiftJis(new Uint8Array(buffer)));
}

async function postBbsCgi(
  client: TestClient,
  slug: string,
  fields: Record<string, string>,
  options: { sjis?: boolean } = {},
): Promise<{ response: Response; text: string }> {
  const params = new URLSearchParams(fields).toString();
  const response = await client.fetch(`/compat/${slug}/bbs.cgi`, {
    method: "POST",
    headers: {
      "content-type": options.sjis
        ? "application/x-www-form-urlencoded; charset=Shift_JIS"
        : "application/x-www-form-urlencoded",
    },
    body: options.sjis ? encodeShiftJis(params) : params,
  });
  return { response, text: await sjisBody(response) };
}

async function countBoardRows(boardId: number): Promise<{ threads: number; posts: number }> {
  const threads = await env.DB.prepare("SELECT COUNT(*) AS n FROM threads WHERE board_id = ?")
    .bind(boardId)
    .first<{ n: number }>();
  const posts = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE board_id = ?")
    .bind(boardId)
    .first<{ n: number }>();
  return { threads: threads?.n ?? 0, posts: posts?.n ?? 0 };
}

beforeEach(async () => {
  network.use(http.post(TURNSTILE_URL, () => HttpResponse.json({ success: true })));
  await resetWorld();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("F7: compat bbs.cgi の Turnstile 制御", () => {
  it("turnstile=anonymous（未ログイン）は書き込みが断られ、レスもスレも増えない", async () => {
    const owner = await authedClient({ name: "compat-anon-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "anonymous", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, {
      title: "compat anonymous テスト",
      body: "親スレ",
    });
    const before = await countBoardRows(board.board.id);

    const anon = new TestClient();
    const replyRes = await postBbsCgi(anon, board.board.slug, {
      key: String(thread.threadId),
      FROM: "専ブラ",
      mail: "",
      MESSAGE: "未ログインレス",
    });
    expect(replyRes.response.status).toBe(200);
    expect(replyRes.response.headers.get("content-type")).toContain("text/html");
    expect(replyRes.response.headers.get("content-type")).toContain("Shift_JIS");
    expect(replyRes.text).toContain(REJECT_TEXT);

    const threadRes = await postBbsCgi(anon, board.board.slug, {
      subject: "未ログイン新スレ",
      FROM: "専ブラ",
      mail: "",
      MESSAGE: "未ログイン本文",
    });
    expect(threadRes.response.status).toBe(200);
    expect(threadRes.response.headers.get("content-type")).toContain("Shift_JIS");
    expect(threadRes.text).toContain(REJECT_TEXT);

    expect(await countBoardRows(board.board.id)).toEqual(before);
  });

  it("turnstile=always は未ログイン・ログイン済みともに断られ、レスもスレも増えない", async () => {
    const owner = await authedClient({ name: "compat-always-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "always", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, {
      title: "compat always テスト",
      body: "親スレ",
      turnstileToken: "dummy-token",
    });
    const before = await countBoardRows(board.board.id);

    for (const client of [new TestClient(), owner.client]) {
      const replyRes = await postBbsCgi(client, board.board.slug, {
        key: String(thread.threadId),
        FROM: "専ブラ",
        mail: "",
        MESSAGE: "always レス",
      });
      expect(replyRes.response.status).toBe(200);
      expect(replyRes.response.headers.get("content-type")).toContain("Shift_JIS");
      expect(replyRes.text).toContain(REJECT_TEXT);

      const threadRes = await postBbsCgi(client, board.board.slug, {
        subject: "always スレ",
        FROM: "専ブラ",
        mail: "",
        MESSAGE: "always 本文",
      });
      expect(threadRes.response.status).toBe(200);
      expect(threadRes.response.headers.get("content-type")).toContain("Shift_JIS");
      expect(threadRes.text).toContain(REJECT_TEXT);
    }

    expect(await countBoardRows(board.board.id)).toEqual(before);
  });

  it("turnstile=off の板では今と同じようにレスもスレも書ける", async () => {
    const owner = await authedClient({ name: "compat-off-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, {
      title: "compat off テスト",
      body: "親スレ",
    });

    const anon = new TestClient();
    const replyRes = await postBbsCgi(
      anon,
      board.board.slug,
      {
        key: String(thread.threadId),
        FROM: "専ブラ太郎",
        mail: "sage",
        MESSAGE: "off のレス本文",
      },
      { sjis: true },
    );
    expect(replyRes.response.status).toBe(200);
    expect(replyRes.text).toContain("書き込みました。");

    const threadRes = await postBbsCgi(anon, board.board.slug, {
      subject: "off の新スレ",
      FROM: "専ブラ次郎",
      mail: "",
      MESSAGE: "off のスレ本文",
    });
    expect(threadRes.response.status).toBe(200);
    expect(threadRes.text).toContain("スレッドを作成しました。");

    expect(await countBoardRows(board.board.id)).toEqual({ threads: 2, posts: 3 });
  });

  it("turnstile=anonymous（ログイン済み）は needsTurnstile=false のため書ける", async () => {
    const owner = await authedClient({ name: "compat-auth-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "anonymous", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, {
      title: "compat auth テスト",
      body: "親スレ",
    });

    const replyRes = await postBbsCgi(owner.client, board.board.slug, {
      key: String(thread.threadId),
      FROM: "ログイン済",
      mail: "",
      MESSAGE: "ログイン済みレス",
    });
    expect(replyRes.response.status).toBe(200);
    expect(replyRes.text).toContain("書き込みました。");
    expect(await countBoardRows(board.board.id)).toEqual({ threads: 1, posts: 2 });
  });
});

describe("F7: compat bbs.cgi のエラー HTML エスケープ", () => {
  it("エラー文に <script> などが含まれても HTML エスケープして返す", async () => {
    const owner = await authedClient({ name: "compat-escape-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, {
      title: "compat escape テスト",
      body: "親スレ",
    });

    vi.spyOn(pipeline, "createPostInternal").mockRejectedValueOnce(
      new ApiError(400, ErrorCode.VALIDATION, `<script>alert("xss")</script> & 'err'`),
    );

    const anon = new TestClient();
    const res = await postBbsCgi(anon, board.board.slug, {
      key: String(thread.threadId),
      FROM: "専ブラ",
      mail: "",
      MESSAGE: "本文",
    });
    expect(res.response.status).toBe(200);
    expect(res.response.headers.get("content-type")).toContain("text/html");
    expect(res.text).not.toContain("<script>");
    expect(res.text).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;err&#39;");
  });
});
