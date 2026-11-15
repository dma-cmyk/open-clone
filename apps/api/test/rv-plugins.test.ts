// レビュー修正 B1〜B14 の統合テスト（おーぷんクローン実利用レビュー修正）。
// - B1: 板内スレタイ検索 × 全ソート（指定なし/speed/bump/posts/created）で一致集合が同じ
// - B2: スレ一覧プレビューの重複（Web 側。API 側は影響なし）
// - B4: DELETE /v1/plugins/:id が実削除になる（停止と別処理）
// - B5: 全体停止中のプラグインは /active の stopped + stoppedReason で理由を返す
// - B6: disable-install / enable-install が導入を残して enabled を切替
// - B14: 匿名（端末 Cookie のみ）で 閲覧→個人導入→無効化→有効化→アンインストール、
//        他人の導入や板/サイト導入には権限昇格が起きない
// - 0612 マイグレーション: seed の冪等性と同名既存プラグインへの非破壊性

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, ulid, type PluginActiveInstall, type PluginDetail, type PluginInstallInfo } from "shared";

const ORIGIN = "http://localhost:3000";
// seed マイグレーションが作る公式アカウントと同じ固定 ID を使う（test/apply-migrations は全マイグレーションを適用済み）
const OFFICIAL_ACCOUNT_ID = "01OFFICIALPLUGINSEED0000000000";

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

interface CallResult {
  status: number;
  json: Envelope | null;
}

async function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  const response = await SELF.fetch(`http://worker.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status >= 500) {
    console.log("DEBUG_500", path, response.status, await response.clone().text());
  }
  const parsed = (await response.json().catch(() => null)) as Envelope | null;
  return { status: response.status, json: parsed };
}

function expectData<T>(result: CallResult): T {
  if (!result.json || result.json.ok !== true) {
    throw new Error(`API 呼び出しが失敗しました: ${JSON.stringify(result.json)}`);
  }
  return result.json.data as T;
}

// ─── アカウント seed ─────────────────────────────────────────────

// owner は 1 アカウント制（migration 0603 の UNIQUE INDEX）。同一ファイル内の
// 複数テストが owner を必要とするため、1 件作ったらそれを使い回す。
const ownerAccountCache = new Map<string, { id: string; token: string; cookie: string }>();

async function seedAccount(
  role: "owner" | "special_admin" | "user",
  name = "tester",
): Promise<{ id: string; token: string; cookie: string }> {
  if (role === "owner") {
    const cached = ownerAccountCache.get("owner");
    if (cached) return cached;
    const created = await insertAccount("owner", name);
    ownerAccountCache.set("owner", created);
    return created;
  }
  return insertAccount(role, name);
}

async function insertAccount(
  role: "owner" | "special_admin" | "user",
  name: string,
): Promise<{ id: string; token: string; cookie: string }> {
  const id = ulid();
  const token = `${ulid()}${ulid()}`;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, NULL, NULL, ?, 'active', ?)",
  )
    .bind(id, `${name}-${id.slice(-6)}`, role, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, account_id, expires_at, created_at, touched_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(tokenHash, id, now + 86_400, now, now)
    .run();
  return { id, token, cookie: `oc_sess=${token}` };
}

const ANON_DEVICE_A = "oc_did=0123456789abcdef0123456789abcdef";
const ANON_DEVICE_B = "oc_did=ffffffffffffffffffffffffffffffff";

// ─── B1: 板内検索 × 全ソート ────────────────────────────────────

describe("B1: 板内スレタイ検索と並び替え", () => {
  beforeEach(async () => {
    for (const table of ["thread_tags", "tags", "posts", "threads", "boards"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  async function seedBoardWithThreads(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const boardRow = await env.DB.prepare(
      "INSERT INTO boards (slug, name, category, description, settings, design, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind("rv-search-b1", "B1検証板", "E2E", "", "{}", "{}", now)
      .first<{ id: number }>();
    if (!boardRow) throw new Error("board の作成に失敗");
    const boardId = boardRow.id;

    // 3 スレ: 2 件が「QA」を含むタイトル、1 件は含まない
    const threads = [
      { title: "QA動作確認スレ", replies: 2 },
      { title: "QA板内検索テスト", replies: 1 },
      { title: "雑談スレ", replies: 5 },
    ];
    for (const thread of threads) {
      const threadRow = await env.DB.prepare(
        "INSERT INTO threads (board_id, title, title_flags, owner_device_hash, owner_account_id, live, post_count, max_posts, last_post_at, bump_at, pinned, status, created_at) VALUES (?, ?, '{}', 'dev', NULL, 0, ?, 1000, ?, ?, 0, 'active', ?) RETURNING id",
      )
        .bind(boardId, thread.title, thread.replies + 1, now, now, now)
        .first<{ id: number }>();
      if (!threadRow) throw new Error("thread の作成に失敗");
      for (let num = 1; num <= thread.replies + 1; num++) {
        await env.DB.prepare(
          "INSERT INTO posts (thread_id, board_id, num, name, body, post_id_hash, device_hash, ip_hash, kind, created_at) VALUES (?, ?, ?, '名無しさん', ?, 'hash', 'dev', 'ip', 'post', ?)",
        )
          .bind(threadRow.id, boardId, num, `${thread.title} レス${num}`, now + num)
          .run();
      }
    }
    return "rv-search-b1";
  }

  it("検索語ありのとき全ソートで一致集合が同じ（speed で 0 件にならない）", async () => {
    const slug = await seedBoardWithThreads();
    const sorts = [undefined, "speed", "bump", "posts", "created"];

    for (const sort of sorts) {
      const query = new URLSearchParams({ q: "QA", limit: "100" });
      if (sort) query.set("sort", sort);
      const result = await call(`/v1/boards/${slug}/threads?${query.toString()}`);
      expect(result.status, `sort=${sort ?? "default"}`).toBe(200);
      const data = expectData<{ items: Array<{ title: string }> }>(result);
      expect(
        data.items.map((item) => item.title).sort(),
        `sort=${sort ?? "(指定なし)"} で QA に一致する 2 スレが返るべき`,
      ).toEqual(["QA動作確認スレ", "QA板内検索テスト"]);
    }
  });

  it("検索語なしの全ソートでも同じ 3 スレが返る（絞り込みがソートで増減しない）", async () => {
    const slug = await seedBoardWithThreads();
    for (const sort of [undefined, "speed", "bump", "posts", "created"]) {
      const query = new URLSearchParams({ limit: "100" });
      if (sort) query.set("sort", sort);
      const result = await call(`/v1/boards/${slug}/threads?${query.toString()}`);
      const data = expectData<{ items: unknown[] }>(result);
      expect(data.items, `sort=${sort ?? "(指定なし)"}`).toHaveLength(3);
    }
  });

  it("一致しない語では 0 件（板は空ではない）", async () => {
    const slug = await seedBoardWithThreads();
    const result = await call(`/v1/boards/${slug}/threads?q=zzz&sort=speed`);
    const data = expectData<{ items: unknown[] }>(result);
    expect(data.items).toHaveLength(0);
  });

  it("/v1/threads (boardId 指定) でも検索 × speed が同じ結果を返す", async () => {
    const slug = await seedBoardWithThreads();
    const boardRow = await env.DB.prepare("SELECT id FROM boards WHERE slug = ?").bind(slug).first<{ id: number }>();
    const result = await call(`/v1/threads?board=${boardRow!.id}&q=QA&sort=speed`);
    const data = expectData<{ items: unknown[] }>(result);
    expect(data.items).toHaveLength(2);
  });
});

// ─── プラグイン seed 用ヘルパ（複数 describe で使う） ────────────

const manifest = (name: string): Record<string, unknown> => ({
  name,
  version: "1.0.0",
  summary: `${name} のテストプラグイン`,
  description: "テスト用",
  scope: ["personal", "board", "site"],
  permissions: ["ui:slot"],
  connectAllowlist: [],
  entry: "plugin.js",
  slots: ["thread-post-inline"],
  hooks: [],
});

const SAMPLE_CODE = `register({
  slots: {
    "thread-post-inline": (ctx) => ({ html: "<b>" + ctx.post.body + "</b>" }),
  },
});`;

// ─── B4/B5/B6/B14: プラグイン導入の操作 ─────────────────────────

describe("B4/B5/B6/B14: 削除・停止・無効化・匿名導入", () => {
  beforeEach(async () => {
    for (const table of [
      "plugin_net_log",
      "plugin_state",
      "plugin_reports",
      "plugin_reviews",
      "plugin_installs",
      "plugin_versions",
      "plugins",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });


  async function createAndPublish(
    cookie: string,
    name: string,
  ): Promise<{ id: string; version: string }> {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie,
      body: { manifest: manifest(name), code: SAMPLE_CODE, visibility: "public" },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const data = expectData<{ id: string; version: string }>(created);

    await call(`/v1/plugins/${data.id}/publish`, {
      method: "POST",
      cookie,
      body: { scopes: ["personal", "board", "site"], visibility: "public" },
    });
    // site を含むので審査待ちになる。owner で承認する。
    const owner = await seedAccount("owner");
    const queue = await call("/v1/plugins/reviews?status=pending&scope=site", { cookie: owner.cookie });
    const items = expectData<{ items: Array<{ pluginId: string; id: string }> }>(queue).items;
    const review = items.find((item) => item.pluginId === data.id);
    if (review) {
      await call(`/v1/plugins/${data.id}/review`, {
        method: "POST",
        cookie: owner.cookie,
        body: { decision: "approve", scope: "site", note: "test" },
      });
    }
    return data;
  }

  it("B14: 匿名（端末 Cookie のみ）で閲覧→個人導入→無効化→有効化→アンインストールができる", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "anon-lifecycle");

    // 匿名でも詳細が見える（公開済み）
    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: ANON_DEVICE_A });
    expect(detail.status).toBe(200);
    expect(expectData<PluginDetail>(detail).viewer.isOwner).toBe(false);

    // 匿名で個人導入（scope_ref = device:<hash>）
    const install = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });
    expect(install.status, JSON.stringify(install.json)).toBe(201);
    const installData = expectData<{ install: PluginInstallInfo; created: boolean }>(install);
    expect(installData.install.scope).toBe("personal");
    expect(installData.install.scopeRef).toMatch(/^device:/);

    // /active に現れる（効果が出る）
    const activeAfterInstall = await call("/v1/plugins/active", { cookie: ANON_DEVICE_A });
    const items = expectData<{ items: PluginActiveInstall[] }>(activeAfterInstall).items;
    expect(items.some((item) => item.pluginId === plugin.id && item.scope === "personal")).toBe(true);

    // 無効化（導入を残す）→ /active から消える
    const disabled = await call(`/v1/plugins/${plugin.id}/disable-install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });
    expect(disabled.status, JSON.stringify(disabled.json)).toBe(200);
    expect(expectData<{ disabled: boolean }>(disabled).disabled).toBe(true);

    const activeAfterDisable = await call("/v1/plugins/active", { cookie: ANON_DEVICE_A });
    expect(
      expectData<{ items: PluginActiveInstall[] }>(activeAfterDisable).items.filter(
        (item) => item.scope === "personal",
      ),
    ).toHaveLength(0);

    // 詳細の導入状況には still ある（enabled=0）
    const detailDisabled = await call(`/v1/plugins/${plugin.id}`, { cookie: ANON_DEVICE_A });
    const installsAfter = expectData<PluginDetail>(detailDisabled).installs;
    const own = installsAfter.find((item) => item.scope === "personal");
    expect(own?.enabled).toBe(false);

    // 有効化 → /active に戻る
    const enabled = await call(`/v1/plugins/${plugin.id}/enable-install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });
    expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
    expect(expectData<{ enabled: boolean }>(enabled).enabled).toBe(true);

    const activeAfterEnable = await call("/v1/plugins/active", { cookie: ANON_DEVICE_A });
    expect(
      expectData<{ items: PluginActiveInstall[] }>(activeAfterEnable).items.some(
        (item) => item.pluginId === plugin.id && item.scope === "personal",
      ),
    ).toBe(true);

    // アンインストール → 導入行が消える
    const uninstalled = await call(`/v1/plugins/${plugin.id}/uninstall`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });
    expect(uninstalled.status).toBe(200);
    const detailAfter = await call(`/v1/plugins/${plugin.id}`, { cookie: ANON_DEVICE_A });
    expect(
      expectData<PluginDetail>(detailAfter).installs.filter((item) => item.scope === "personal"),
    ).toHaveLength(0);
  });

  it("B14: 権限昇格なし — 匿名は他人の端末導入・板導入・サイト導入を操作できない", async () => {
    const dev = await seedAccount("user");
    const owner = await seedAccount("owner");
    const plugin = await createAndPublish(dev.cookie, "privilege-escalation");

    // 端末 A が導入
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });

    // 端末 B（別の匿名端末）は A の導入を無効化できない（自分の device ref が無いので 404）
    const otherDisable = await call(`/v1/plugins/${plugin.id}/disable-install`, {
      method: "POST",
      cookie: ANON_DEVICE_B,
      body: { scope: "personal" },
    });
    expect(otherDisable.status).toBe(404);

    // 匿名は板導入できない（401）
    const anonBoard = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_B,
      body: { scope: "board", boardId: 1 },
    });
    expect(anonBoard.status).toBe(401);

    // 匿名はサイト導入できない（403）
    const anonSite = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_B,
      body: { scope: "site" },
    });
    expect(anonSite.status).toBe(403);

    // 匿名は作成できない（401）
    const anonCreate = await call("/v1/plugins", {
      method: "POST",
      cookie: ANON_DEVICE_B,
      body: { manifest: manifest("anon-create"), code: SAMPLE_CODE },
    });
    expect(anonCreate.status).toBe(401);

    // 匿名は他人のプラグインを停止・削除できない（403）
    const anonDisable = await call(`/v1/plugins/${plugin.id}/disable`, {
      method: "POST",
      cookie: ANON_DEVICE_B,
      body: { reason: "嫌がらせ" },
    });
    expect(anonDisable.status).toBe(403);
    const anonDelete = await call(`/v1/plugins/${plugin.id}`, {
      method: "DELETE",
      cookie: ANON_DEVICE_B,
    });
    expect(anonDelete.status).toBe(403);

    // 一般ログインユーザーでも他人の板導入は 403
    const other = await seedAccount("user");
    const otherBoard = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: other.cookie,
      body: { scope: "board", boardId: 1 },
    });
    expect(otherBoard.status).toBe(403);

    // owner は板導入・サイト導入が可能（承認済みなので）
    const ownerBoard = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 1 },
    });
    expect(ownerBoard.status, JSON.stringify(ownerBoard.json)).toBe(201);
    const ownerSite = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "site" },
    });
    expect(ownerSite.status, JSON.stringify(ownerSite.json)).toBe(201);
  });

  it("B5: 全体停止中のプラグインは個人導入が stopped + stoppedReason 付きで返る", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "stopped-reason");

    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });

    // 所有者が停止
    await call(`/v1/plugins/${plugin.id}/disable`, {
      method: "POST",
      cookie: dev.cookie,
      body: { reason: "メンテナンス" },
    });

    const active = await call("/v1/plugins/active", { cookie: ANON_DEVICE_A });
    const items = expectData<{ items: PluginActiveInstall[] }>(active).items;
    const entry = items.find((item) => item.pluginId === plugin.id);
    expect(entry).toBeTruthy();
    expect(entry?.stopped).toBe(true);
    expect(entry?.stoppedReason).toContain("停止");

    // 停止解除で理由が消える
    const owner = await seedAccount("owner");
    await call(`/v1/plugins/${plugin.id}/enable`, { method: "POST", cookie: owner.cookie });
    const activeAfter = await call("/v1/plugins/active", { cookie: ANON_DEVICE_A });
    const itemsAfter = expectData<{ items: PluginActiveInstall[] }>(activeAfter).items;
    const entryAfter = itemsAfter.find((item) => item.pluginId === plugin.id);
    expect(entryAfter?.stopped).toBe(false);
    expect(entryAfter?.stoppedReason).toBeNull();
  });

  it("B6: 無効化は導入を残し、アンインストールとは別の操作（板でも動く）", async () => {
    const dev = await seedAccount("user");
    const owner = await seedAccount("owner");
    const plugin = await createAndPublish(dev.cookie, "board-toggle");

    const board = await call("/v1/plugins", { method: "POST", cookie: owner.cookie, body: { manifest: manifest("x-nope"), code: SAMPLE_CODE } });
    expect(board.status, "owner は ownerBoardInstall と衝突しない").toBe(201);

    // owner は全板の管理人相当なので board 導入できる
    const installed = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 7 },
    });
    expect(installed.status, JSON.stringify(installed.json)).toBe(201);

    // 板導入の無効化・有効化
    const disabled = await call(`/v1/plugins/${plugin.id}/disable-install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 7 },
    });
    expect(disabled.status, JSON.stringify(disabled.json)).toBe(200);

    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: owner.cookie });
    const boardInstall = expectData<PluginDetail>(detail).installs.find((item) => item.scope === "board");
    expect(boardInstall?.enabled).toBe(false);

    const enabled = await call(`/v1/plugins/${plugin.id}/enable-install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 7 },
    });
    expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
    const enabledData = expectData<{ install: PluginInstallInfo; enabled: boolean }>(enabled);
    expect(enabledData.enabled).toBe(true);
    // M2: 応答の install は PluginInstallInfo 形（camelCase・boolean）であること
    expect(enabledData.install.pluginId).toBe(plugin.id);
    expect(enabledData.install.scope).toBe("board");
    expect(enabledData.install.scopeRef).toBe("7");
    expect(enabledData.install.enabled).toBe(true);
    expect(typeof enabledData.install.updatedAt).toBe("number");
    // 二重無効化は 409
    await call(`/v1/plugins/${plugin.id}/disable-install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 7 },
    });
    const second = await call(`/v1/plugins/${plugin.id}/disable-install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 7 },
    });
    expect(second.status).toBe(409);
  });

  it("B4/R1: 他者の導入がある場合は 409 で拒否され、導入・版は保持される", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "delete-guard-anon");

    // 他の匿名端末が導入（installed_by = device:... = 作者と一致しない）
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });

    const denied = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(denied.status, JSON.stringify(denied.json)).toBe(409);
    expect(denied.json?.code).toBe("CONFLICT");
    expect(denied.json?.message).toContain("作者以外の導入");

    // 導入・版・本体は保持される
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ?")
      .bind(plugin.id)
      .first<{ n: number }>();
    expect(installs?.n).toBe(1);
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_versions WHERE plugin_id = ?")
      .bind(plugin.id)
      .first<{ n: number }>();
    expect(versions?.n).toBeGreaterThan(0);
    const row = await env.DB.prepare("SELECT id FROM plugins WHERE id = ?").bind(plugin.id).first();
    expect(row).toBeTruthy();
    // 導入した匿名端末には影響がない（/active に残る）
    const active = await call("/v1/plugins/active", { cookie: ANON_DEVICE_A });
    expect(
      expectData<{ items: PluginActiveInstall[] }>(active).items.some((item) => item.pluginId === plugin.id),
    ).toBe(true);
  });

  it("B4/R1: 別アカウント・板用・サイト用・無効化済みの他者導入も 409", async () => {
    const dev = await seedAccount("user");
    const other = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "delete-guard-kinds");

    // 別アカウントの個人用導入
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: other.cookie,
      body: { scope: "personal" },
    });
    // 無効化済みの導入も保護対象
    await call(`/v1/plugins/${plugin.id}/disable-install`, {
      method: "POST",
      cookie: other.cookie,
      body: { scope: "personal" },
    });
    const deniedOther = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(deniedOther.status).toBe(409);
    // まだ導入が残っているので 409 のまま
    await call(`/v1/plugins/${plugin.id}/uninstall`, {
      method: "POST",
      cookie: other.cookie,
      body: { scope: "personal" },
    });

    // 板用導入（owner は全板の管理人相当）
    const owner = await seedAccount("owner");
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 55 },
    });
    const deniedBoard = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(deniedBoard.status).toBe(409);
    await call(`/v1/plugins/${plugin.id}/uninstall`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 55 },
    });

    // サイト用導入（承認済みなので owner が導入可）
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "site" },
    });
    const deniedSite = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(deniedSite.status).toBe(409);
    // 管理者操作でも保護は外れない
    const deniedAdmin = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: owner.cookie });
    expect(deniedAdmin.status).toBe(409);
  });

  it("B4/R1: 未導入と作者自身の導入だけなら削除できる（作者の導入も消える）", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "delete-own-only");

    // 作者自身の個人用導入（installed_by = 作者のアカウント ID）
    const own = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: dev.cookie,
      body: { scope: "personal" },
    });
    expect(own.status, JSON.stringify(own.json)).toBe(201);

    const deleted = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    expect(expectData<{ deleted: boolean }>(deleted).deleted).toBe(true);

    // 詳細は 404（見つからない = 一覧から消えた）
    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: dev.cookie });
    expect(detail.status).toBe(404);

    // 作者自身の導入も一緒に消える
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ?")
      .bind(plugin.id)
      .first<{ n: number }>();
    expect(installs?.n).toBe(0);
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_versions WHERE plugin_id = ?")
      .bind(plugin.id)
      .first<{ n: number }>();
    expect(versions?.n).toBe(0);
    const row = await env.DB.prepare("SELECT id FROM plugins WHERE id = ?").bind(plugin.id).first();
    expect(row).toBeNull();
  });

  it("B4/R1: 未導入なら削除できる", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "delete-noinstall");

    const deleted = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: dev.cookie });
    expect(detail.status).toBe(404);
  });

  it("B4/R1-N: owner=NULL（公式）への個人導入は削除保護される（管理者でも 409）", async () => {
    const admin = await seedAccount("special_admin");
    // 公式相当: owner_account_id = NULL のプラグインを直接作る
    const now = Math.floor(Date.now() / 1000);
    const pluginId = "01NULLOWNERTEST00000000000000";
    await env.DB.prepare(
      `INSERT INTO plugins (id, owner_account_id, name, summary, manifest_json, scopes, status, visibility,
         latest_version, source, install_count, report_count, flagged, kill_seq, created_at, updated_at)
       VALUES (?, NULL, 'null-owner-plugin', 'NULL 所有者のテスト', '{}', ',personal,', 'published', 'public',
         '1.0.0', 'local', 0, 0, 0, 0, ?, ?)`,
    )
      .bind(pluginId, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO plugin_versions (plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at)
       VALUES (?, '1.0.0', 'register({});', 'hash', '{}', NULL, 'approved', NULL, ?)`,
    )
      .bind(pluginId, now)
      .run();

    // 匿名端末が個人導入（installed_by = device:... = owner NULL と一致しない）
    await call(`/v1/plugins/${pluginId}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });

    // 管理者でも 409（NULL 同士を本人一致にしない）
    const denied = await call(`/v1/plugins/${pluginId}`, { method: "DELETE", cookie: admin.cookie });
    expect(denied.status, JSON.stringify(denied.json)).toBe(409);
    expect(denied.json?.message).toContain("作者以外の導入");

    // 導入・版・本体が全て保持される
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ?")
      .bind(pluginId)
      .first<{ n: number }>();
    expect(installs?.n).toBe(1);
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_versions WHERE plugin_id = ?")
      .bind(pluginId)
      .first<{ n: number }>();
    expect(versions?.n).toBe(1);
    const row = await env.DB.prepare("SELECT id FROM plugins WHERE id = ?").bind(pluginId).first();
    expect(row).toBeTruthy();
  });

  it("B4/R1-N: installed_by=NULL の帰属不明導入は保護される", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "installed-by-null");

    // 帰属不明（installed_by = NULL）の導入行を直接用意する
    // （通常の install API は NULL を発行しないが、スキーマ上許される既存データの保護を確認）
    await env.DB.prepare(
      `INSERT INTO plugin_installs (id, plugin_id, scope, scope_ref, version, pinned, enabled, config_json, installed_by, created_at, updated_at)
       VALUES ('01NULLINSTALLEDTEST00000000000', ?, 'personal', 'legacy', '1.0.0', 0, 1, NULL, NULL, 0, 0)`,
    )
      .bind(plugin.id)
      .run();

    const denied = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(denied.status, JSON.stringify(denied.json)).toBe(409);

    // 導入行が保持される
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ?")
      .bind(plugin.id)
      .first<{ n: number }>();
    expect(installs?.n).toBe(1);
    const row = await env.DB.prepare("SELECT id FROM plugins WHERE id = ?").bind(plugin.id).first();
    expect(row).toBeTruthy();
  });

  it("B4/R1-C: 件数確認と削除の間に他者の導入が挟まっても消えない（原子性）", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "interleave-guard");

    // 作者自身の導入だけの状態から始める（削除可能な状態）
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: dev.cookie,
      body: { scope: "personal" },
    });

    // countForeignInstalls は 0 を返す（作者の導入だけ）
    const foreignBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM plugin_installs
       WHERE plugin_id = ?
         AND NOT (scope = 'personal' AND installed_by IS NOT NULL AND ? IS NOT NULL AND installed_by = ?)`,
    )
      .bind(plugin.id, dev.id, dev.id)
      .first<{ n: number }>();
    expect(foreignBefore?.n).toBe(0);

    // count 確認後（削除前）に、別の匿名端末が実際に導入する
    const foreignInstall = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });
    expect(foreignInstall.status, JSON.stringify(foreignInstall.json)).toBe(201);

    // 他者導入がある状態で DELETE を実行 → 409 で、その導入も本体も残る
    const denied = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(denied.status, JSON.stringify(denied.json)).toBe(409);

    // 匿名端末の導入と本体が保持される
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ?")
      .bind(plugin.id)
      .first<{ n: number }>();
    expect(installs?.n).toBe(2); // 作者 + 匿名の 2 件
    const row = await env.DB.prepare("SELECT id FROM plugins WHERE id = ?").bind(plugin.id).first();
    expect(row).toBeTruthy();
  });

  it("B4/R1-C: 本体削除後に挟まった新規導入は FK により失敗する（削除済みを導けない）", async () => {
    const dev = await seedAccount("user");
    const plugin = await createAndPublish(dev.cookie, "fk-after-delete");

    // 削除する（他者の導入なし）
    const deleted = await call(`/v1/plugins/${plugin.id}`, { method: "DELETE", cookie: dev.cookie });
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);

    // 本体が消えた後の新規導入は FK 制約で失敗する（500 になる）
    const lateInstall = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });
    expect(lateInstall.status).not.toBe(201);
    expect(lateInstall.status).toBeGreaterThanOrEqual(400);

    // 導入行は作られていない
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ?")
      .bind(plugin.id)
      .first<{ n: number }>();
    expect(installs?.n).toBe(0);
  });
});

// ─── 0612 seed マイグレーション ──────────────────────────────────

describe("0612: 公式プラグイン seed の冪等性", () => {
  const migration = env.TEST_MIGRATIONS.find((item) => item.name.startsWith("0612_"));

  beforeEach(async () => {
    for (const table of [
      "plugin_net_log",
      "plugin_state",
      "plugin_reports",
      "plugin_reviews",
      "plugin_installs",
      "plugin_versions",
      "plugins",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    // （0612 は accounts 行を作らないため、削除不要）
  });

  function applyMigration(): Promise<void> {
    if (!migration) throw new Error("0612 の migration が見つかりません");
    return (async () => {
      for (const query of migration.queries) {
        await env.DB.prepare(query.trim()).run();
      }
    })();
  }

  it("空の DB に適用すると公式 4 プラグインが公開済み・承認済みで入る", async () => {
    expect(migration).toBeTruthy();
    await applyMigration();

    const plugins = await env.DB.prepare(
      "SELECT name, status, visibility, latest_version, owner_account_id FROM plugins ORDER BY name",
    ).all<{ name: string; status: string; visibility: string; latest_version: string; owner_account_id: string }>();
    const names = plugins.results.map((row) => row.name);
    expect(names).toEqual(["dice", "gallery", "gist-embed", "spoiler"]);
    for (const row of plugins.results) {
      expect(row.status).toBe("published");
      expect(row.visibility).toBe("public");
      expect(row.latest_version).toBe("1.0.0");
      expect(row.owner_account_id).toBeNull(); // 公式提供（owner なし）
    }

    // 版は approved で 1 つ
    const versions = await env.DB.prepare(
      "SELECT plugin_id, version, status FROM plugin_versions",
    ).all<{ plugin_id: string; version: string; status: string }>();
    expect(versions.results).toHaveLength(4);
    for (const row of versions.results) expect(row.status).toBe("approved");

    // site 審査の承認行がある（site 導入に必要）
    const reviews = await env.DB.prepare(
      "SELECT plugin_id, scope, status, reviewer_type FROM plugin_reviews",
    ).all<{ plugin_id: string; scope: string; status: string; reviewer_type: string }>();
    expect(reviews.results).toHaveLength(4);
    for (const row of reviews.results) {
      expect(row.scope).toBe("site");
      expect(row.status).toBe("approved");
      expect(row.reviewer_type).toBe("system");
    }

    // 匿名で一覧に出て、導入できる
    const list = await call("/v1/plugins?q=spoiler");
    const items = expectData<{ items: Array<{ id: string; name: string }> }>(list).items;
    const spoiler = items.find((item) => item.name === "spoiler");
    expect(spoiler).toBeTruthy();

    const install = await call(`/v1/plugins/${spoiler!.id}/install`, {
      method: "POST",
      cookie: ANON_DEVICE_A,
      body: { scope: "personal" },
    });
    expect(install.status, JSON.stringify(install.json)).toBe(201);
  });

  it("2 回適用しても重複しない（冪等）", async () => {
    await applyMigration();
    await applyMigration();

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugins").first<{ n: number }>();
    expect(count?.n).toBe(4);
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_versions").first<{ n: number }>();
    expect(versions?.n).toBe(4);
    const reviews = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_reviews").first<{ n: number }>();
    expect(reviews?.n).toBe(4);
    // accounts 行は作らない（FK 参照なし・他テーブルの cleanup を壊さない）
    const accounts = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE id = ?")
      .bind(OFFICIAL_ACCOUNT_ID)
      .first<{ n: number }>();
    expect(accounts?.n).toBe(0);
  });

  it("既存データありの DB に適用しても既存プラグインを壊さない", async () => {
    // 既存の同名プラグイン（ユーザー作成の spoiler）を作る
    const dev = await seedAccount("user");
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: dev.cookie,
      body: { manifest: manifest("spoiler"), code: "register({});", visibility: "private" },
    });
    expect(created.status).toBe(201);
    const existing = expectData<{ id: string }>(created);

    await applyMigration();

    // 既存の spoiler はそのまま（owner も visibility も変わらない）
    const row = await env.DB.prepare(
      "SELECT owner_account_id, visibility, status FROM plugins WHERE id = ?",
    )
      .bind(existing.id)
      .first<{ owner_account_id: string; visibility: string; status: string }>();
    expect(row?.owner_account_id).toBe(dev.id);
    expect(row?.visibility).toBe("private");
    expect(row?.status).toBe("draft");

    // seed 側の spoiler は作られない（name 衝突）
    const spoilers = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugins WHERE name = 'spoiler'",
    ).first<{ n: number }>();
    expect(spoilers?.n).toBe(1);

    // 他の 3 つは入る
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugins").first<{ n: number }>();
    expect(total?.n).toBe(4); // 既存 spoiler + dice + gallery + gist-embed
  });
});
