// 専ブラ互換（subject.txt / dat / bbsmenu / RSS / bbs.cgi）。出力は Shift_JIS。

import { Hono } from "hono";
import {
  ApiError,
  decodeShiftJis,
  encodeShiftJis,
  formatDatLine,
  formatSubjectLine,
  renderBbsmenu,
  renderRss,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { assertReadRateLimit } from "../lib/do";
import { createPostInternal, createThreadInternal } from "../lib/pipeline";
import { getThreadRow, resolveBoardRow, type PostRow } from "../services/board/store";

const app = new Hono<AppEnv>();

// 専ブラは subject.txt 等を数秒おきに取得する。通常運用（10 板 × 5 秒間隔 ≒ 120 req/min）を
// 妨げない 180 req/min（3 req/s）を IP 単位の上限とする（H-3）。書き込みは pipeline 側で制限。
app.use("*", async (c, next) => {
  if (c.req.method === "GET") {
    const reqCtx = getReqCtx(c);
    await assertReadRateLimit(c.env, "readCompat", reqCtx.device.ipHash);
  }
  await next();
});

const SUBJECT_LIMIT = 150;

function sjisResponse(
  body: string,
  contentType = "text/plain",
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(encodeShiftJis(body), {
    status: 200,
    headers: {
      "content-type": `${contentType}; charset=Shift_JIS`,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}



function utf8Response(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": `${contentType}; charset=UTF-8`, "cache-control": "no-store" },
  });
}

/** subject.txt（更新順 150 件・Shift_JIS）。ETag / Last-Modified で 304 を返す。 */
app.get("/:slug/subject.txt", async (c) => {
  const db = c.env.DB;
  const board = await resolveBoardRow(db, c.req.param("slug"));
  if (!board) throw ApiError.notFound("板が見つかりません");
  const result = await db
    .prepare(
      "SELECT id, title, post_count, bump_at FROM threads WHERE board_id = ? AND status = 'active' ORDER BY bump_at DESC LIMIT ?",
    )
    .bind(board.id, SUBJECT_LIMIT)
    .all<{ id: number; title: string; post_count: number; bump_at: number }>();

  // 専ブラの If-Modified-Since / If-None-Match を尊重し、変化がなければ本文を返さない（H-3 の補助）。
  const lastModified = result.results.reduce(
    (max, row) => Math.max(max, row.bump_at),
    board.last_post_at ?? board.created_at,
  );
  const etag = `W/"${board.id}-${result.results.length}-${lastModified}"`;
  const lastModifiedHeader = new Date(Math.max(0, lastModified) * 1000).toUTCString();
  const cacheHeaders = {
    etag,
    "last-modified": lastModifiedHeader,
    "cache-control": "public, max-age=5",
  };
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").map((value) => value.trim()).includes(etag)) {
    return new Response(null, {
      status: 304,
      headers: { "access-control-allow-origin": "*", ...cacheHeaders },
    });
  }
  const ifModifiedSince = c.req.header("if-modified-since");
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    if (Number.isFinite(since) && Math.floor(since / 1000) >= lastModified) {
      return new Response(null, {
        status: 304,
        headers: { "access-control-allow-origin": "*", ...cacheHeaders },
      });
    }
  }

  const lines = result.results.map((row) => formatSubjectLine(row.id, row.title, row.post_count));
  return sjisResponse(`${lines.join("\n")}\n`, "text/plain", cacheHeaders);
});

/** dat（1 レス 1 行・5 フィールド・Shift_JIS）。 */
app.get("/:slug/dat/:file", async (c) => {
  const db = c.env.DB;
  const board = await resolveBoardRow(db, c.req.param("slug"));
  if (!board) throw ApiError.notFound("板が見つかりません");
  const file = c.req.param("file");
  const threadId = Number(file.replace(/\.dat$/i, ""));
  if (!Number.isInteger(threadId) || threadId <= 0) throw ApiError.notFound("dat が見つかりません");
  const thread = await getThreadRow(db, threadId);
  if (!thread || thread.board_id !== board.id) throw ApiError.notFound("dat が見つかりません");

  const result = await db
    .prepare(
      `SELECT id, thread_id, board_id, num, title, name, mail, trip, cap, body, sage, post_id_hash,
              device_hash, ip_hash, ninja_lv, kind, parent_post_id, attachments, hashtags, ai_agent_id,
              hidden, deleted, created_at
       FROM posts WHERE thread_id = ? AND kind = 'post' AND hidden = 0 AND deleted = 0 ORDER BY num ASC LIMIT 1000`,
    )
    .bind(thread.id)
    .all<PostRow>();

  const lines = result.results.map((row) =>
    formatDatLine({
      name: row.name,
      trip: row.trip,
      mail: row.mail,
      createdAt: row.created_at,
      idHash: row.post_id_hash,
      body: row.body,
      title: row.num === 1 ? thread.title : null,
      num: row.num,
      boardSlug: board.slug,
      threadId: thread.id,
    }),
  );
  return sjisResponse(`${lines.join("\n")}\n`);
});

/** bbsmenu.html（専ブラ用板一覧）。 */
app.get("/bbsmenu.html", async (c) => {
  const db = c.env.DB;
  const result = await db
    .prepare("SELECT slug, name, category FROM boards WHERE status = 'active' ORDER BY category ASC, name ASC")
    .all<{ slug: string; name: string; category: string }>();
  const groups = new Map<string, Array<{ slug: string; name: string }>>();
  for (const row of result.results) {
    const list = groups.get(row.category) ?? [];
    list.push({ slug: row.slug, name: row.name });
    groups.set(row.category, list);
  }
  const html = renderBbsmenu(
    Array.from(groups, ([category, boards]) => ({ category, boards })),
    new URL(c.req.url).origin,
  );
  return sjisResponse(html, "text/html");
});

/** SETTING.TXT（専ブラが参照する設定ファイル）。 */
app.get("/:slug/SETTING.TXT", async (c) => {
  const board = await resolveBoardRow(c.env.DB, c.req.param("slug"));
  if (!board) throw ApiError.notFound("板が見つかりません");
  const lines = [
    "BBS_TITLE=おーぷんクローン",
    `BBS_NONAME_NAME=名無しさん`,
    `BBS_NAME=${board.name}`,
    "BBS_SUBJECT_COUNT=150",
    "BBS_THREAD_STOP=1000",
    "BBS_DELETE_NAME=削除依頼",
    "BBS_POSTING_NAME=投稿する",
    "BBS_FORCE_ID=0",
    "BBS_MOBILE=1",
  ];
  return sjisResponse(`${lines.join("\n")}\n`);
});

/** index.rdf（RSS 2.0・UTF-8）。 */
app.get("/:slug/index.rdf", async (c) => {
  const db = c.env.DB;
  const board = await resolveBoardRow(db, c.req.param("slug"));
  if (!board) throw ApiError.notFound("板が見つかりません");
  const origin = new URL(c.req.url).origin;
  const result = await db
    .prepare("SELECT id, title, post_count, last_post_at FROM threads WHERE board_id = ? AND status = 'active' ORDER BY bump_at DESC LIMIT 50")
    .bind(board.id)
    .all<{ id: number; title: string; post_count: number; last_post_at: number }>();
  const rss = renderRss(
    board.name,
    `${origin}/b/${board.slug}`,
    result.results.map((row) => ({
      threadId: row.id,
      title: row.title,
      url: `${origin}/b/${board.slug}/t/${row.id}`,
      description: `${row.post_count} レス`,
      pubDate: row.last_post_at,
    })),
  );
  return utf8Response(rss, "application/rss+xml");
});

/** 2ch 互換の書き込み（bbs.cgi）。専ブラからの投稿・スレ立て。 */
app.post("/:slug/bbs.cgi", async (c) => {
  const db = c.env.DB;
  const board = await resolveBoardRow(db, c.req.param("slug"));
  if (!board) throw ApiError.notFound("板が見つかりません");
  const reqCtx = getReqCtx(c);
  const contentType = c.req.header("content-type") ?? "";

  let fields: Record<string, string>;
  if (/charset=shift_jis/i.test(contentType)) {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    fields = Object.fromEntries(new URLSearchParams(decodeShiftJis(bytes)));
  } else {
    const parsed = await c.req.parseBody();
    fields = Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
    );
  }

  const message = (fields["MESSAGE"] ?? "").trim();
  if (message.length === 0) {
    return sjisResponse("<html><body>本文が空です。<br><a href=\"javascript:history.back()\">戻る</a></body></html>", "text/html");
  }
  const name = fields["FROM"] ?? "";
  const mail = fields["mail"] ?? "";
  const identity = {
    deviceHash: reqCtx.device.deviceHash,
    ipHash: reqCtx.device.ipHash,
    accountId: reqCtx.session?.account.id ?? null,
  };

  try {
    const key = fields["key"] ?? "";
    const threadId = Number(key);
    if (Number.isInteger(threadId) && threadId > 0) {
      const thread = await getThreadRow(db, threadId);
      if (!thread || thread.board_id !== board.id) {
        return sjisResponse("<html><body>スレッドが見つかりません。</body></html>", "text/html");
      }
      await createPostInternal(
        {
          boardId: board.id,
          threadId: thread.id,
          name,
          mail,
          body: message,
          ...identity,
          skipTurnstile: true,
        },
        { env: c.env, ctx: c.executionCtx },
      );
      return sjisResponse(
        `<html><body>書き込みました。<br><a href="/test/read.cgi/${board.slug}/${thread.id}/l50">スレッドを開く</a></body></html>`,
        "text/html",
      );
    }

    const subject = (fields["subject"] ?? "").trim();
    if (subject.length === 0) {
      return sjisResponse("<html><body>スレタイが空です。</body></html>", "text/html");
    }
    const created = await createThreadInternal(
      {
        boardId: board.id,
        title: subject,
        body: message,
        name,
        mail,
        ...identity,
        skipTurnstile: true,
      },
      { env: c.env, ctx: c.executionCtx },
    );
    return sjisResponse(
      `<html><body>スレッドを作成しました。<br><a href="/test/read.cgi/${board.slug}/${created.thread.id}/l50">スレッドを開く</a></body></html>`,
      "text/html",
    );
  } catch (error) {
    const messageText = error instanceof ApiError ? error.message : "書き込みに失敗しました";
    return sjisResponse(`<html><body>${messageText}<br><a href="javascript:history.back()">戻る</a></body></html>`, "text/html");
  }
});

export default app;