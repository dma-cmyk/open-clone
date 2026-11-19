// ツールの単体試験（引数の検証・確認カード・untrusted・権限の扱い・API 失敗の変換）。
//
// API は fetch を差し替えて模す（本物のサーバー・本物の AI 事業者にはつながない）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { PET_LIMITS, PET_TOOL_NAME_RE } from "shared";
import type { PetTool, PetToolContext } from "../contract";
import { getPetTools } from "./index";
import { isInternalPath, openPageTool } from "./navigate";
import { listBoardsTool, readThreadTool, searchTool } from "./boards";
import { createPostTool, deleteMyPostTool, editMyPostTool } from "./posts";
import { getMeTool } from "./me";
import { handleReportTool, hidePostTool, settingsValueText, updateBoardSettingsTool } from "./staff";
import { addMyPluginVersionTool, createMyPluginTool } from "./plugins-write";
import { listInstalledPluginsTool } from "./plugins-read";

interface Reply {
  status?: number;
  body: unknown;
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

/** fetch を差し替える。`routes` は「METHOD /path の接頭辞」で引く。 */
function installFetch(routes: Record<string, Reply>): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.replace(/^.*\/api\/v1/, "").replace(/^.*\/v1/, "");
    calls.push({ method, url: path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const key = Object.keys(routes).find((candidate) => {
      const [routeMethod, routePath] = candidate.split(" ");
      return routeMethod === method && path.startsWith(routePath ?? "");
    });
    const reply = key ? routes[key] : { status: 404, body: { ok: false, code: "NOT_FOUND", message: "no route" } };
    if (!reply) throw new Error("route reply が無い");
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() {
        return reply.body;
      },
      async text() {
        return JSON.stringify(reply.body);
      },
    };
  });
  return calls;
}

function context(overrides: Partial<PetToolContext> = {}): PetToolContext & { navigated: string[] } {
  const navigated: string[] = [];
  return {
    signal: new AbortController().signal,
    page: { path: "/", title: "トップ", boardSlug: null, threadId: null, selectionText: "" },
    navigate: (path: string) => navigated.push(path),
    navigated,
    ...overrides,
  };
}

/** JSON Schema のキーを再帰的に集める（事業者が受けないキーの走査用）。 */
function collectKeys(value: unknown, out: Set<string>): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return;
  }
  for (const key of Object.keys(value)) {
    out.add(key);
    collectKeys(Reflect.get(value, key), out);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ツールの一覧", () => {
  const tools = getPetTools();

  it("名前は PET_TOOL_NAME_RE に合い、重複しない", () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(PET_TOOL_NAME_RE.test(name)).toBe(true);
  });

  it("説明は日本語で 1000 文字以内、parameters は type:object の JSON Schema", () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeLessThanOrEqual(PET_LIMITS.toolDescriptionMaxChars);
      expect(tool.description).toMatch(/[ぁ-んァ-ヶ一-龥]/);
      expect(tool.parameters["type"]).toBe("object");
    }
  });

  it("中継の上限（48 件）に収まる", () => {
    expect(tools.length).toBeLessThanOrEqual(PET_LIMITS.toolsMax);
  });

  it("parameters は zod スキーマから作り、事業者が受けないキーを含まない（Gemini の 400 を防ぐ）", () => {
    // Gemini の OpenAI 互換口は、これらが 1 つでも混ざると要求全体を 400 で拒む。
    const forbidden = ["anyOf", "oneOf", "allOf", "propertyNames", "$schema", "$ref", "$defs", "not", "additionalProperties"];
    for (const tool of tools) {
      const found = new Set<string>();
      collectKeys(tool.parameters, found);
      for (const key of forbidden) {
        expect(found.has(key), `${tool.name} の parameters に ${key} が残っている`).toBe(false);
      }
      expect(tool.parameters["type"]).toBe("object");
      expect(tool.parameters["properties"]).toBeTypeOf("object");
    }
  });

  it("parameters の説明と必須項目がスキーマの内容と一致する（二重管理しない）", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const createPost = byName.get("create_post")?.parameters;
    const json = JSON.stringify(createPost);
    // 項目名はスキーマのキー（zod）そのもの。description は .describe() から来る。
    for (const key of ["threadId", "body", "name", "sage"]) expect(json).toContain(`"${key}"`);
    expect(json).toContain("本文（4096 バイトまで");
    expect(json).not.toContain("description（任意）"); // 消した引数が残っていない
    expect(createPost?.["required"]).toEqual(["threadId", "body"]);
    expect(byName.get("open_page")?.parameters["required"]).toEqual(["path"]);
    expect(byName.get("read_help")?.parameters["required"]).toBeUndefined();
  });

  it("handle_report の reportId は文字列 1 本（anyOf を作らない）", () => {
    const parameters = new Map(tools.map((tool) => [tool.name, tool.parameters])).get("handle_report");
    const json = JSON.stringify(parameters);
    expect(json).toContain('"reportId":{"type":"string"');
    expect(json).not.toContain("anyOf");
  });

  it("管理ツールは write、読み取りは read/navigate に分かれている", () => {
    const kinds = new Map<string, PetTool>(tools.map((tool) => [tool.name, tool]));
    expect(kinds.get("update_board_settings")?.kind).toBe("write");
    expect(kinds.get("hide_post")?.kind).toBe("write");
    expect(kinds.get("open_page")?.kind).toBe("navigate");
    expect(kinds.get("read_help")?.kind).toBe("read");
    // 書き込みツールは prepare を持つ（確認カードを省けない）
    for (const tool of tools) {
      if (tool.kind === "write") expect(typeof tool.prepare).toBe("function");
    }
  });

  it("秘密を返すツール・アカウント安全のツールを置いていない", () => {
    const names = tools.map((tool) => tool.name);
    for (const forbidden of ["set_staff", "remove_staff", "delete_account", "change_password", "totp", "recovery_code"]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  });
});

describe("open_page", () => {
  it("外部 URL・プロトコル相対・空白入りを拒む", async () => {
    for (const bad of [
      "https://example.com/",
      "//example.com/",
      "javascript:alert(1)",
      "/a\\b",
      "/a b",
      " /b/news",
      "/%2f%2fexample.com",
      "",
    ]) {
      expect(isInternalPath(bad)).toBe(false);
      const result = await openPageTool.run({ path: bad }, context());
      expect(result.ok).toBe(false);
    }
  });

  it("同一サイトのパスだけ移動する", async () => {
    const ctx = context();
    const result = await openPageTool.run({ path: "/b/news/t/12?r=l30" }, ctx);
    expect(result).toEqual({ ok: true, data: { path: "/b/news/t/12?r=l30" } });
    expect(ctx.navigated).toEqual(["/b/news/t/12?r=l30"]);
  });

  it("引数の型が違えば INVALID_ARGS（移動しない）", async () => {
    const ctx = context();
    const result = await openPageTool.run({ path: 12 }, ctx);
    expect(result).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(ctx.navigated).toEqual([]);
  });
});

describe("引数の検証", () => {
  it("必須の欠落・型違い・範囲外を、項目名つきの INVALID_ARGS にする", async () => {
    const ctx = context();
    expect(await readThreadTool.run({}, ctx)).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(await readThreadTool.run({ threadId: "10" }, ctx)).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(await readThreadTool.run({ threadId: 10, limit: 0 }, ctx)).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
    });
    const message = await readThreadTool.run({ threadId: 10, limit: 500 }, ctx);
    expect(message.ok === false && message.error).toContain("limit");
  });

  it("知らない引数は黙って捨てずに断る", async () => {
    const ctx = context();
    const result = await getMeTool.run({ unexpected: 1 }, ctx);
    expect(result).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });
});

describe("read_thread", () => {
  it("他の利用者の文は untrusted で包み、長い本文は切る", async () => {
    installFetch({
      "GET /threads/10": {
        body: {
          ok: true,
          data: {
            thread: { id: 10, title: "テストスレ", boardSlug: "news", postCount: 2 },
            posts: [
              { id: 100, num: 1, name: "名無しさん", body: "あ".repeat(3000), createdAt: 1 },
              { id: 101, num: 2, name: "名無しさん", body: "こんにちは", createdAt: 2, mine: true },
            ],
            hasMore: false,
          },
        },
      },
    });
    const result = await readThreadTool.run({ threadId: 10, limit: 10 }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      thread: { untrusted?: boolean; title: string };
      posts: { untrusted?: boolean; body: string; num: number }[];
    };
    expect(data.thread.untrusted).toBe(true);
    expect(data.thread.title).toBe("テストスレ");
    expect(data.posts.every((post) => post.untrusted === true)).toBe(true);
    expect(data.posts[0]?.body.length).toBeLessThan(2100);
    expect(data.posts[0]?.body).toContain("省略");
  });

  it("API の失敗は {ok:false, code, error} に変える（例外を投げない）", async () => {
    installFetch({
      "GET /threads/10": {
        status: 403,
        body: { ok: false, code: "FORBIDDEN", message: "この板は閲覧できません" },
      },
    });
    const result = await readThreadTool.run({ threadId: 10 }, context());
    expect(result).toEqual({ ok: false, code: "FORBIDDEN", error: "この板は閲覧できません" });
  });
});

describe("list_boards", () => {
  it("板の名前・説明を untrusted で包む", async () => {
    installFetch({
      "GET /boards": {
        body: {
          ok: true,
          data: {
            items: [
              { id: 1, slug: "news", name: "ニュース", category: "話題", description: "説明文" },
              { id: 2, slug: "tech", name: "技術", category: "話題" },
            ],
          },
        },
      },
    });
    const result = await listBoardsTool.run({ q: "ニュース" }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { total: number; items: { slug: string; untrusted?: boolean }[] };
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({ slug: "news", untrusted: true });
  });
});

describe("create_post", () => {
  const boardData = {
    board: { id: 3, slug: "news", name: "ニュース", category: "話題", settings: { turnstile: "off" } },
    staff: [],
    canManage: false,
  };

  it("prepare はカードを作るだけで書き込まない", async () => {
    const calls = installFetch({
      "GET /threads/10": { body: { ok: true, data: { thread: { id: 10, title: "スレ題", boardSlug: "news" }, posts: [] } } },
      "GET /boards/news": { body: { ok: true, data: boardData } },
      "GET /auth/session": { body: { ok: true, data: { authenticated: false } } },
    });
    const prepared = await createPostTool.prepare(
      { threadId: 10, body: "テスト投稿です", name: "名無しさん" },
      context(),
    );
    expect("ok" in prepared).toBe(false);
    if ("ok" in prepared) return;
    expect(prepared.title).toBe("このスレに書き込みます");
    expect(prepared.danger).toBe(false);
    expect(prepared.turnstile).toBe(false);
    const labels = prepared.details.map((detail) => detail.label);
    expect(labels).toContain("板");
    expect(labels).toContain("スレ");
    expect(labels).toContain("本文");
    expect(prepared.details.find((detail) => detail.label === "本文")?.value).toBe("テスト投稿です");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("run は確認カードの後だけ API を呼び、Turnstile トークンを渡す", async () => {
    const calls = installFetch({
      "POST /threads/10/posts": {
        status: 201,
        body: { ok: true, data: { post: { id: 999, num: 5, body: "テスト投稿です", createdAt: 10 } } },
      },
    });
    const result = await createPostTool.run(
      { threadId: 10, body: "テスト投稿です" },
      context(),
      { turnstileToken: "tok-1" },
    );
    expect(result).toEqual({ ok: true, data: { threadId: 10, postId: 999, num: 5, createdAt: 10 } });
    const posted = calls.find((call) => call.method === "POST");
    expect(posted?.body).toMatchObject({ body: "テスト投稿です", turnstileToken: "tok-1" });
  });

  it("API が拒否したら code をそのまま返す", async () => {
    installFetch({
      "POST /threads/10/posts": {
        status: 403,
        body: { ok: false, code: "FORBIDDEN", message: "書き込みが禁止されています" },
      },
    });
    const result = await createPostTool.run({ threadId: 10, body: "x" }, context(), { turnstileToken: null });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN", error: "書き込みが禁止されています" });
  });

  it("Turnstile が要る板ではカードに turnstile を立てる", async () => {
    installFetch({
      "GET /threads/10": { body: { ok: true, data: { thread: { id: 10, title: "スレ題", boardSlug: "news" }, posts: [] } } },
      "GET /boards/news": {
        body: {
          ok: true,
          data: { board: { id: 3, slug: "news", name: "ニュース", category: "話題", settings: { turnstile: "always" } }, staff: [], canManage: false },
        },
      },
      "GET /auth/session": { body: { ok: true, data: { authenticated: true } } },
    });
    const prepared = await createPostTool.prepare({ threadId: 10, body: "テスト" }, context());
    if ("ok" in prepared) throw new Error("失敗");
    expect(prepared.turnstile).toBe(true);
  });
});

describe("get_me", () => {
  it("未ログインなら authenticated:false で、秘密は返さない", async () => {
    installFetch({
      "GET /auth/session": { body: { ok: true, data: { authenticated: false } } },
      "GET /accounts/me/boards": { status: 401, body: { ok: false, code: "UNAUTHENTICATED", message: "ログインが必要です" } },
    });
    const result = await getMeTool.run({}, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data["authenticated"]).toBe(false);
    expect(data["boards"]).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("email");
    expect(JSON.stringify(data)).not.toContain("token");
  });

  it("ログイン中なら板ごとの役割を日本語名つきで返す", async () => {
    installFetch({
      "GET /auth/session": {
        body: { ok: true, data: { account: { id: "a", name: "利用者", role: "user" } } },
      },
      "GET /accounts/me/boards": {
        body: { ok: true, data: { items: [{ slug: "news", name: "ニュース", level: "admin" }] } },
      },
    });
    const result = await getMeTool.run({}, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { authenticated: boolean; boards: { slug: string; levelLabel: string }[] };
    expect(data.authenticated).toBe(true);
    expect(data.boards[0]).toMatchObject({ slug: "news", levelLabel: "板の管理人" });
  });
});

describe("管理ツール", () => {
  it("権限が無い人には API の拒否（FORBIDDEN）をそのまま返す（ペット側で広げない）", async () => {
    const calls = installFetch({
      "POST /posts/77/hide": {
        status: 403,
        body: { ok: false, code: "FORBIDDEN", message: "板スタッフの権限がありません" },
      },
    });
    const result = await hidePostTool.run({ postId: 77 }, context(), { turnstileToken: null });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN", error: "板スタッフの権限がありません" });
    expect(calls).toHaveLength(1);
  });

  it("未ログインなら UNAUTHENTICATED をそのまま返す", async () => {
    installFetch({
      "POST /posts/77/hide": {
        status: 401,
        body: { ok: false, code: "UNAUTHENTICATED", message: "ログインが必要です" },
      },
    });
    const result = await hidePostTool.run({ postId: 77 }, context(), { turnstileToken: null });
    expect(result).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("板設定は変更前と変更後をカードに並べ、danger にする", async () => {
    installFetch({
      "GET /boards/news": {
        body: {
          ok: true,
          data: {
            board: {
              id: 3,
              slug: "news",
              name: "ニュース",
              category: "話題",
              settings: { turnstile: "anonymous", maxPosts: 1000 },
            },
            staff: [],
            canManage: true,
          },
        },
      },
    });
    const prepared = await updateBoardSettingsTool.prepare(
      { board: "news", settings: { turnstile: "off", maxPosts: 500 } },
      context(),
    );
    if ("ok" in prepared) throw new Error("カードにならなかった");
    expect(prepared.danger).toBe(true);
    const rows = prepared.details.map((detail) => detail.value).join("\n");
    expect(rows).toContain("未ログインのみ要求 → 要求しない");
    expect(rows).toContain("1000 → 500");
  });

  it("板設定の知らない項目・不正な値は INVALID_ARGS", async () => {
    installFetch({
      "GET /boards/news": {
        body: { ok: true, data: { board: { id: 3, slug: "news", name: "ニュース", category: "話題" }, staff: [], canManage: true } },
      },
    });
    const unknown = await updateBoardSettingsTool.prepare({ board: "news", settings: { nope: 1 } }, context());
    expect(unknown).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    const bad = await updateBoardSettingsTool.prepare({ board: "news", settings: { maxPosts: 1 } }, context());
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("変更前の値が無い設定は「（未設定）」と出す（undefined を出さない）", () => {
    expect(settingsValueText(undefined)).toBe("（未設定）");
    expect(settingsValueText(null)).toBe("（なし）");
    expect(settingsValueText(true)).toBe("する");
  });

  it("通報の id は文字列だけを受ける（数値は INVALID_ARGS）", async () => {
    const numeric = await handleReportTool.prepare({ reportId: 12, action: "resolve" }, context());
    expect(numeric).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("通報のカードは直近 100 件から探し、見つからなくても処理はできると分かる文にする", async () => {
    const calls = installFetch({
      "GET /reports": {
        body: {
          ok: true,
          data: {
            items: [
              {
                id: "r-1",
                boardSlug: "news",
                threadId: 10,
                threadTitle: "スレ題",
                nums: "3",
                reason: "spam",
                comment: "通報の本文",
                status: "pending",
              },
            ],
            nextCursor: null,
          },
        },
      },
    });
    const prepared = await handleReportTool.prepare({ reportId: "r-1", action: "hide" }, context());
    if ("ok" in prepared) throw new Error("カードにならなかった");
    expect(prepared.danger).toBe(true);
    const text = prepared.details.map((detail) => detail.value).join("\n");
    expect(text).toContain("通報の本文");
    expect(text).toContain("pending");
    expect(calls[0]?.url).toContain("limit=100");
    expect(calls[0]?.url).not.toContain("status=");
  });

  it("処理済みの通報にはカードを出さない（ALREADY_HANDLED）", async () => {
    installFetch({
      "GET /reports": {
        body: {
          ok: true,
          data: {
            items: [{ id: "r-2", boardSlug: "news", threadId: 10, threadTitle: "スレ題", nums: "3", status: "resolved" }],
            nextCursor: null,
          },
        },
      },
    });
    const result = await handleReportTool.prepare({ reportId: "r-2", action: "delete" }, context());
    expect(result).toMatchObject({
      ok: false,
      code: "ALREADY_HANDLED",
      error: expect.stringContaining("対応済み"),
    });
  });
});

describe("edit_my_post の Turnstile（M1）", () => {
  it("always 板ではカードに turnstile を立てる（ログイン済みでも必要）", async () => {
    installFetch({
      "GET /threads/10": {
        body: {
          ok: true,
          data: {
            thread: { id: 10, title: "スレ題", boardSlug: "news", postCount: 3 },
            posts: [{ id: 100, num: 2, name: "名無しさん", body: "自分のレス", createdAt: 1, mine: true }],
          },
        },
      },
      "GET /boards/news": {
        body: {
          ok: true,
          data: {
            board: { id: 3, slug: "news", name: "ニュース", category: "話題", settings: { turnstile: "always" } },
            staff: [],
            canManage: false,
          },
        },
      },
      "GET /auth/session": { body: { ok: true, data: { account: { id: "a", name: "利用者", role: "user" } } } },
    });
    const prepared = await editMyPostTool.prepare({ postId: 100, threadId: 10, body: "直した本文" }, context());
    if ("ok" in prepared) throw new Error("カードにならなかった");
    expect(prepared.turnstile).toBe(true);
    expect(prepared.details.map((detail) => detail.label)).toContain("変更前");
  });

  it("turnstile が off の板ではカードに turnstile を立てない", async () => {
    installFetch({
      "GET /threads/10": {
        body: {
          ok: true,
          data: {
            thread: { id: 10, title: "スレ題", boardSlug: "news", postCount: 3 },
            posts: [{ id: 100, num: 2, name: "名無しさん", body: "自分のレス", createdAt: 1, mine: true }],
          },
        },
      },
      "GET /boards/news": {
        body: {
          ok: true,
          data: {
            board: { id: 3, slug: "news", name: "ニュース", category: "話題", settings: { turnstile: "off" } },
            staff: [],
            canManage: false,
          },
        },
      },
      "GET /auth/session": { body: { ok: true, data: { authenticated: false } } },
    });
    const prepared = await editMyPostTool.prepare({ postId: 100, threadId: 10, body: "直した本文" }, context());
    if ("ok" in prepared) throw new Error("カードにならなかった");
    expect(prepared.turnstile).toBe(false);
  });
});

describe("本文のバイト上限（M2）", () => {
  const boardData = {
    board: { id: 3, slug: "news", name: "ニュース", category: "話題", settings: { turnstile: "off" } },
    staff: [],
    canManage: false,
  };

  function routes() {
    return {
      "GET /threads/10": {
        body: { ok: true, data: { thread: { id: 10, title: "スレ題", boardSlug: "news" }, posts: [] } },
      },
      "GET /boards/news": { body: { ok: true, data: boardData } },
      "GET /auth/session": { body: { ok: true, data: { authenticated: false } } },
    };
  }

  it("ちょうど 4096 バイト（ASCII）は通る", async () => {
    installFetch(routes());
    const prepared = await createPostTool.prepare({ threadId: 10, body: "a".repeat(4096) }, context());
    expect("ok" in prepared).toBe(false);
  });

  it("4097 バイトは INVALID_ARGS（サーバーの 413 より先に断る）", async () => {
    installFetch(routes());
    const result = await createPostTool.prepare({ threadId: 10, body: "a".repeat(4097) }, context());
    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
      error: expect.stringContaining("4096 バイト"),
    });
  });

  it("日本語は 1 文字 3 バイトで数える（1365 文字 = 4095 バイトは通り、1366 文字 = 4098 バイトは断る）", async () => {
    installFetch(routes());
    const ok = await createPostTool.prepare({ threadId: 10, body: "あ".repeat(1365) }, context());
    expect("ok" in ok).toBe(false);
    const tooLong = await createPostTool.prepare({ threadId: 10, body: "あ".repeat(1366) }, context());
    expect(tooLong).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });
});

describe("add_my_plugin_version の版（M3）", () => {
  const manifest = {
    name: "my-plugin",
    version: "2.0.0",
    summary: "テスト用",
    scope: ["personal"],
    permissions: [],
    connectAllowlist: [],
    entry: "index.js",
    slots: [],
    hooks: [],
    threadState: [],
  };

  function detail(latestVersion: string, ownership: "account" | "device" = "account") {
    return {
      ok: true,
      data: {
        id: "p1",
        name: "my-plugin",
        summary: "テスト用",
        latestVersion,
        status: "published",
        visibility: "private",
        scopes: ["personal"],
        permissions: [],
        slots: [],
        connectAllowlist: [],
        hasRenderRules: false,
        installCount: 0,
        reportCount: 0,
        flagged: false,
        source: "local",
        sourceRef: null,
        owner: { id: "a", name: "利用者" },
        ownership,
        createdAt: 1,
        updatedAt: 1,
        publishedAt: 1,
        description: null,
        manifest,
        versions: [],
        viewer: { isOwner: true, isAdmin: false, canEdit: true, canReview: false },
        installs: [],
      },
    };
  }

  it("カードに出した版（現行の次のパッチ）をそのまま送る", async () => {
    const calls = installFetch({
      "GET /plugins/p1": { body: detail("1.2.3") },
      "POST /plugins/preview-check": { body: { ok: true, data: { checks: { allowed: true, reasons: [] }, warnings: [] } } },
      "POST /plugins/p1/versions": {
        body: { ok: true, data: { version: "1.2.4", checks: { allowed: true, reasons: [] }, warnings: [] } },
      },
    });
    const prepared = await addMyPluginVersionTool.prepare({ pluginId: "p1", code: "console.log(1)" }, context());
    if ("ok" in prepared) throw new Error("カードにならなかった");
    const versionRow = prepared.details.find((detailRow) => detailRow.label === "新しい版");
    expect(versionRow?.value).toContain("1.2.4");

    const result = await addMyPluginVersionTool.run({ pluginId: "p1", code: "console.log(1)" }, context(), {
      turnstileToken: null,
    });
    expect(result).toMatchObject({ ok: true, data: { version: "1.2.4" } });
    const posted = calls.find((call) => call.method === "POST" && call.url.startsWith("/plugins/p1/versions"));
    expect(posted?.body).toMatchObject({ version: "1.2.4" });
  });

  it("version を指定したらその版をカードと送信の両方に使う", async () => {
    const calls = installFetch({
      "GET /plugins/p1": { body: detail("1.2.3") },
      "POST /plugins/preview-check": { body: { ok: true, data: { checks: { allowed: true, reasons: [] }, warnings: [] } } },
      "POST /plugins/p1/versions": {
        body: { ok: true, data: { version: "2.0.0", checks: { allowed: true, reasons: [] }, warnings: [] } },
      },
    });
    const prepared = await addMyPluginVersionTool.prepare(
      { pluginId: "p1", code: "console.log(1)", version: "2.0.0" },
      context(),
    );
    if ("ok" in prepared) throw new Error("カードにならなかった");
    expect(prepared.details.find((row) => row.label === "新しい版")?.value).toBe("2.0.0");
    await addMyPluginVersionTool.run({ pluginId: "p1", code: "console.log(1)", version: "2.0.0" }, context(), {
      turnstileToken: null,
    });
    const posted = calls.find((call) => call.method === "POST" && call.url.startsWith("/plugins/p1/versions"));
    expect(posted?.body).toMatchObject({ version: "2.0.0" });
  });

  it("ログイン済みでも、端末が持つプラグインに 70KB の版は足せない（ALREADY ではない・64KB）", async () => {
    installFetch({
      "GET /plugins/p1": { body: detail("1.2.3", "device") },
      "POST /plugins/preview-check": { body: { ok: true, data: { checks: { allowed: true, reasons: [] }, warnings: [] } } },
      "GET /auth/session": { body: { ok: true, data: { account: { id: "a", name: "利用者", role: "user" } } } },
    });
    const result = await addMyPluginVersionTool.prepare(
      { pluginId: "p1", code: `// ${"a".repeat(70 * 1024)}` },
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
      error: expect.stringContaining("64KB"),
    });
  });

  it("アカウントが持つプラグインなら、ログインしていなくても 64KB を超える版をカードに出せる", async () => {
    installFetch({
      "GET /plugins/p1": { body: detail("1.2.3", "account") },
      "POST /plugins/preview-check": { body: { ok: true, data: { checks: { allowed: true, reasons: [] }, warnings: [] } } },
    });
    const prepared = await addMyPluginVersionTool.prepare(
      { pluginId: "p1", code: `// ${"a".repeat(70 * 1024)}` },
      context(),
    );
    expect("ok" in prepared).toBe(false);
  });
});

describe("untrusted の残り（m1・m2）", () => {
  it("search の post 系はスレタイも untrusted の中に入れる", async () => {
    installFetch({
      "GET /search": {
        body: {
          ok: true,
          data: {
            type: "full",
            items: [
              {
                type: "post",
                post: { id: 1, threadId: 10, num: 3, name: "名無しさん", body: "本文", createdAt: 1, idHash: "abcd" },
                thread: { id: 10, title: "他人のスレタイ", boardSlug: "news", boardName: "ニュース" },
              },
            ],
            nextCursor: null,
          },
        },
      },
    });
    const result = await searchTool.run({ q: "本文", type: "full" }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { items: Record<string, unknown>[] };
    const item = data.items[0];
    expect(item?.["untrusted"]).toBe(true);
    expect(item?.["threadTitle"]).toBe("他人のスレタイ");
  });

  it("list_installed_plugins の項目は untrusted で包む", async () => {
    installFetch({
      "GET /plugins/installed": {
        body: {
          ok: true,
          data: {
            items: [
              {
                id: "i1",
                pluginId: "p1",
                name: "他人が付けた名前",
                scope: "personal",
                scopeRef: "a",
                version: "1.0.0",
                pinned: false,
                enabled: true,
                pluginStatus: "published",
                manifest: { permissions: [], slots: [] },
                installedBy: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        },
      },
    });
    const result = await listInstalledPluginsTool.run({}, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { personal: Record<string, unknown>[] };
    expect(data.personal[0]?.["untrusted"]).toBe(true);
    expect(data.personal[0]?.["name"]).toBe("他人が付けた名前");
  });
});

describe("delete_my_post のカード（m6）", () => {
  it("自分の投稿と他人の投稿（スタッフ経路）の結果を分けて出す", async () => {
    const prepared = await deleteMyPostTool.prepare({ postId: 5 }, context());
    if ("ok" in prepared) throw new Error("カードにならなかった");
    const text = prepared.details.map((detail) => detail.value).join("\n");
    expect(text).toContain("投稿者により削除されました");
    expect(text).toContain("完全削除");
    expect(prepared.danger).toBe(true);
  });
});

describe("プラグインコードのバイト上限（m4）", () => {
  const manifest = {
    name: "big-plugin",
    version: "1.0.0",
    summary: "大きいコード",
    scope: ["personal"],
  };

  it("未ログイン（端末所有）は 64KB を超えるとカードを出さずに案内する", async () => {
    installFetch({
      "POST /plugins/preview-check": { body: { ok: true, data: { checks: { allowed: true, reasons: [] }, warnings: [] } } },
      "GET /auth/session": { body: { ok: true, data: { authenticated: false } } },
    });
    const code = `// ${"a".repeat(70 * 1024)}`;
    const result = await createMyPluginTool.prepare({ manifest, code }, context());
    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
      error: expect.stringContaining("64KB"),
    });
  });

  it("512KB を超えるコードは zod の検証で断る（通信しない）", async () => {
    const calls = installFetch({});
    const result = await createMyPluginTool.prepare(
      { manifest, code: `// ${"a".repeat(512 * 1024)}` },
      context(),
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(calls).toHaveLength(0);
  });
});