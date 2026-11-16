// 匿名でのプラグイン作成（報告 40 設計・報告 41 の続き）の API 統合テスト。
//
// カバー:
// - 匿名（端末 Cookie のみ）で作成 → 自分用導入 → 版追加 → 削除
// - 拒否: スコープ（board/site を含む）・visibility（非 private）・publish・禁止権限・
//   コード 64KB 超・11 個目・作成＋版追加の回数超過（429）
// - 別の端末からは 404（一覧・詳細・コード取得・導入・編集・削除）
// - 公式（両方 NULL）の削除保護が従来どおり効くこと
// - 板管理人（board_staff のアカウント）からは端末所有が 404
// - ログイン時の引き継ぎ（同期）: 引き継ぎ後はアカウント所有として公開申請できる
// - 0613 マイグレーション: 0612 までの適用済み DB への適用（audit_log の再作成はしない）
import { sha256Hex, ulid, type PluginActiveInstall, type PluginInstallInfo } from "shared";
import { transferDeviceOwnedPlugins } from "../src/services/plugins/device-transfer";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const ORIGIN = "http://localhost:3000";

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

// owner は 1 アカウント制（UNIQUE INDEX）のため、1 件作ったら使い回す
const ownerAccountCache = new Map<string, { id: string; token: string; cookie: string }>();

async function seedAccount(
  role: "owner" | "special_admin" | "user",
  name = "tester",
): Promise<{ id: string; token: string; cookie: string }> {
  if (role === "owner") {
    const cached = ownerAccountCache.get("owner");
    if (cached) return cached;
  }
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
  const account = { id, token, cookie: `oc_sess=${token}` };
  if (role === "owner") ownerAccountCache.set("owner", account);
  return account;
}

const DEVICE_A = "oc_did=0123456789abcdef0123456789abcdef";
const DEVICE_B = "oc_did=ffffffffffffffffffffffffffffffff";

function anonManifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    summary: `${name} の匿名テスト`,
    scope: ["personal"],
    permissions: [],
    connectAllowlist: [],
    entry: "plugin.js",
    slots: [],
    hooks: [],
    ...overrides,
  };
}

// 匿名レート制限（1 日 20 回）を回避するための IP 変更。テスト用に x-real-ip を差し替える。
function withIp(ip: string): Record<string, string> {
  return { "x-real-ip": ip };
}

beforeEach(async () => {
  for (const table of [
    "plugin_net_log",
    "plugin_state",
    "plugin_reports",
    "plugin_reviews",
    "plugin_installs",
    "plugin_versions",
    "plugins",
    "auth_attempts",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// ─── ライフサイクル ─────────────────────────────────────────────

describe("匿名作成のライフサイクル", () => {
  it("匿名で作成→自分用導入→版追加→削除ができる", async () => {
    // 1. 作成（端末 Cookie のみ）
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.1.0.1"),
      body: { manifest: anonManifest("anon-life"), code: "register({});", visibility: "private" },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const plugin = expectData<{ id: string; version: string }>(created);

    // 2. 自分用導入（作成端末の device:<hash> スコープ）
    const install = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.1.0.1"),
      body: { scope: "personal" },
    });
    expect(install.status, JSON.stringify(install.json)).toBe(201);
    expect(expectData<{ install: PluginInstallInfo }>(install).install.scope).toBe("personal");

    // /active に現れる（実スレで効果が出る）
    const active = await call("/v1/plugins/active", { cookie: DEVICE_A, headers: withIp("10.1.0.1") });
    expect(
      expectData<{ items: PluginActiveInstall[] }>(active).items.some((item) => item.pluginId === plugin.id),
    ).toBe(true);

    // 3. 版追加
    const version = await call(`/v1/plugins/${plugin.id}/versions`, {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.1.0.1"),
      body: { version: "1.1.0", code: "register({}); // v1.1.0" },
    });
    expect(version.status, JSON.stringify(version.json)).toBe(201);

    // 4. 削除（自分の端末）
    const deleted = await call(`/v1/plugins/${plugin.id}`, {
      method: "DELETE",
      cookie: DEVICE_A,
      headers: withIp("10.1.0.1"),
    });
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);

    // 詳細は 404
    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: DEVICE_A, headers: withIp("10.1.0.1") });
    expect(detail.status).toBe(404);
  });

  it("自分のプラグイン一覧（/mine と ?mine=true）に匿名の端末所有が出る", async () => {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.2.0.1"),
      body: { manifest: anonManifest("anon-mine"), code: "register({});", visibility: "private" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    const mine = await call("/v1/plugins/mine", { cookie: DEVICE_A, headers: withIp("10.2.0.1") });
    const mineItems = expectData<{ items: Array<{ id: string }> }>(mine).items;
    expect(mineItems.some((item) => item.id === plugin.id)).toBe(true);

    const listMine = await call("/v1/plugins?mine=true", { cookie: DEVICE_A, headers: withIp("10.2.0.1") });
    const listItems = expectData<{ items: Array<{ id: string }> }>(listMine).items;
    expect(listItems.some((item) => item.id === plugin.id)).toBe(true);

    // 公開一覧には出ない
    const list = await call("/v1/plugins", { cookie: DEVICE_A, headers: withIp("10.2.0.1") });
    const publicItems = expectData<{ items: Array<{ id: string }> }>(list).items;
    expect(publicItems.some((item) => item.id === plugin.id)).toBe(false);
  });
});

// ─── 拒否 ──────────────────────────────────────────────────────

describe("匿名作成の拒否", () => {
  it("スコープに board / site を含むと 403", async () => {
    for (const scope of [["board"], ["site"], ["personal", "board"]]) {
      const result = await call("/v1/plugins", {
        method: "POST",
        cookie: DEVICE_A,
        headers: withIp("10.3.0.1"),
        body: { manifest: anonManifest("anon-scope", { scope }), code: "register({});" },
      });
      expect(result.status, `scope=${scope.join(",")}`).toBe(403);
      expect(result.json?.message).toContain("個人用");
    }
  });

  it("visibility が private 以外だと 403", async () => {
    const result = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.3.0.2"),
      body: { manifest: anonManifest("anon-vis"), code: "register({});", visibility: "public" },
    });
    expect(result.status).toBe(403);
  });

  it("禁止権限（net:fetch など）を含むと 403", async () => {
    for (const permission of ["net:fetch", "ai:complete", "upload:start", "github:gist", "github:repo"]) {
      const result = await call("/v1/plugins", {
        method: "POST",
        cookie: DEVICE_A,
        headers: withIp("10.3.0.3"),
        body: {
          manifest: anonManifest(`anon-perm-${permission.replace(/[:]/g, "")}`, {
            permissions: [permission],
            // net:fetch は allowlist 必須のため schema バリデーションを先に通す
            ...(permission === "net:fetch" ? { connectAllowlist: ["https://api.example.com"] } : {}),
          }),
          code: "register({});",
        },
      });
      expect(result.status, permission).toBe(403);
      expect(result.json?.message).toContain("ログインせずに使えない権限");
    }
  });

  it("コード 64KB 超で 413", async () => {
    const bigCode = `register({});\n// ${"x".repeat(65 * 1024)}`;
    const result = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.3.0.4"),
      body: { manifest: anonManifest("anon-big"), code: bigCode },
    });
    expect(result.status).toBe(413);
    expect(result.json?.message).toContain("匿名作成の上限");
  });

  it("端末あたり 11 個目で 403", async () => {
    for (let index = 0; index < 10; index++) {
      const result = await call("/v1/plugins", {
        method: "POST",
        cookie: DEVICE_A,
        headers: withIp("10.3.1.100"),
        body: { manifest: anonManifest(`anon-ten-${index}`), code: "register({});" },
      });
      expect(result.status, `#${index}`).toBe(201);
    }
    const eleventh = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.3.2.100"),
      body: { manifest: anonManifest("anon-eleven"), code: "register({});" },
    });
    expect(eleventh.status).toBe(403);
    expect(eleventh.json?.message).toContain("10 個まで");
  });

  it("作成＋版追加の回数超過で 429（端末窓）", async () => {
    // 他のテストと端末窓を共有しない専用端末で検証する（DO の窓はテスト全体で共有される）
    const rateDevice = "oc_did=aaaaaaaarate0000aaaaaaaaaaaa";
    const rateIp = "10.9.0.1";
    let rateLimited: CallResult | null = null;
    for (let index = 0; index < 25; index++) {
      const result = await call("/v1/plugins", {
        method: "POST",
        cookie: rateDevice,
        headers: withIp(rateIp),
        body: { manifest: anonManifest(`anon-rate-${index}`), code: "register({});" },
      });
      if (result.status === 429) {
        rateLimited = result;
        break;
      }
      expect(result.status, `作成#${index}`).toBe(201);
      const plugin = expectData<{ id: string }>(result);
      // 保有数上限（10 個）に掛からないよう都度削除する
      await call(`/v1/plugins/${plugin.id}`, {
        method: "DELETE",
        cookie: rateDevice,
        headers: withIp(rateIp),
      });
    }
    expect(rateLimited?.status).toBe(429);
    expect(rateLimited?.json?.message).toContain("上限");
  });

  it("publish は 401（匿名）/ 404（所有者でないアカウントには見えない）", async () => {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.3.0.5"),
      body: { manifest: anonManifest("anon-pub"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // 匿名（端末 Cookie のみ）は publish にアカウントが必要なため 401
    const anonPublish = await call(`/v1/plugins/${plugin.id}/publish`, {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.3.0.5"),
      body: { scopes: ["personal"], visibility: "public" },
    });
    expect(anonPublish.status).toBe(401);

    // 別アカウント（所有者でない）は 403
    const other = await seedAccount("user");
    const otherPublish = await call(`/v1/plugins/${plugin.id}/publish`, {
      method: "POST",
      cookie: other.cookie,
      body: { scopes: ["personal"], visibility: "public" },
    });
    // 別アカウント（所有者でない）は端末所有が見えないため 404
    expect(otherPublish.status).toBe(404);
  });

  it("板用・サイト全体への導入は 403（端末所有）", async () => {
    const owner = await seedAccount("owner");
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.3.0.6"),
      body: { manifest: anonManifest("anon-board"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    const boardInstall = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 1 },
    });
    expect(boardInstall.status).toBe(403);

    const siteInstall = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "site" },
    });
    expect(siteInstall.status).toBe(403);
  });
});

// ─── 他人から見えない ──────────────────────────────────────────

describe("端末所有プラグインの隔離", () => {
  it("別の端末からは一覧・詳細・コード取得・導入・編集・削除が 404/不可", async () => {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.5.0.1"),
      body: { manifest: anonManifest("anon-hidden"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // 一覧に出ない
    const mineB = await call("/v1/plugins/mine", { cookie: DEVICE_B, headers: withIp("10.5.0.2") });
    expect(
      expectData<{ items: Array<{ id: string }> }>(mineB).items.some((item) => item.id === plugin.id),
    ).toBe(false);

    // 詳細 404
    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: DEVICE_B, headers: withIp("10.5.0.2") });
    expect(detail.status).toBe(404);

    // コード取得 404
    const code = await call(`/v1/plugins/${plugin.id}/code`, { cookie: DEVICE_B, headers: withIp("10.5.0.2") });
    expect(code.status).toBe(404);

    // 導入不可
    const install = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: DEVICE_B,
      headers: withIp("10.5.0.2"),
      body: { scope: "personal" },
    });
    expect(install.status).toBe(404);

    // 版追加不可
    const version = await call(`/v1/plugins/${plugin.id}/versions`, {
      method: "POST",
      cookie: DEVICE_B,
      headers: withIp("10.5.0.2"),
      body: { version: "2.0.0", code: "register({});" },
    });
    expect(version.status).toBe(404);

    // 削除不可
    const deleted = await call(`/v1/plugins/${plugin.id}`, {
      method: "DELETE",
      cookie: DEVICE_B,
      headers: withIp("10.5.0.2"),
    });
    expect(deleted.status).toBe(404);

    // 本体は残っている
    const stillThere = await call(`/v1/plugins/${plugin.id}`, { cookie: DEVICE_A, headers: withIp("10.5.0.1") });
    expect(stillThere.status).toBe(200);
  });

  it("サイト運営（owner）は見られる・停止できる", async () => {
    const owner = await seedAccount("owner");
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.5.1.1"),
      body: { manifest: anonManifest("anon-admin"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // 詳細が見える
    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: owner.cookie });
    expect(detail.status).toBe(200);

    // 停止できる
    const disabled = await call(`/v1/plugins/${plugin.id}/disable`, {
      method: "POST",
      cookie: owner.cookie,
      body: { reason: "管理確認" },
    });
    expect(disabled.status).toBe(200);
  });

  it("板管理人（board_staff のアカウント）からは 404", async () => {
    const boardAdmin = await seedAccount("user");
    // board_staff の FK 用に板を作る（slug は一意）
    const now2 = Math.floor(Date.now() / 1000);
    const boardRow = await env.DB.prepare(
      "INSERT INTO boards (slug, name, category, description, rules_md, design, settings, status, created_at) VALUES (?, '板管理人テスト', 'E2E', '', '', '{}', '{}', 'active', ?) RETURNING id",
    )
      .bind(`b-anon-${now2}`, now2)
      .first<{ id: number }>();
    const boardId = boardRow?.id ?? 1;
    await env.DB.prepare(
      "INSERT INTO board_staff (board_id, account_id, level, created_at) VALUES (?, ?, 'admin', 0)",
    )
      .bind(boardId, boardAdmin.id)
      .run();

    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.5.2.1"),
      body: { manifest: anonManifest("anon-boardadmin"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // 板管理人はサイト運営ではないため 404
    const detail = await call(`/v1/plugins/${plugin.id}`, { cookie: boardAdmin.cookie });
    expect(detail.status).toBe(404);

    // boardId 指定の停止も対象にならない（板に導入されていないため 404）
    const disabled = await call(`/v1/plugins/${plugin.id}/disable`, {
      method: "POST",
      cookie: boardAdmin.cookie,
      body: { reason: "板内停止", boardId },
    });
    expect(disabled.status).toBe(404);
  });
});

// ─── 公式の保護（従来どおり） ──────────────────────────────────

describe("公式（両方 NULL）の削除保護", () => {
  it("公式への導入があると管理者でも 409、導入と本体が保持される", async () => {
    const admin = await seedAccount("special_admin");
    const now = Math.floor(Date.now() / 1000);
    const pluginId = "01OFFICIALKEEP000000000000000";
    await env.DB.prepare(
      `INSERT INTO plugins (id, owner_account_id, owner_device_hash, name, summary, manifest_json, scopes, status, visibility,
         latest_version, source, install_count, report_count, flagged, kill_seq, created_at, updated_at)
       VALUES (?, NULL, NULL, 'official-keep', '公式相当', '{}', ',personal,', 'published', 'public',
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

    // 匿名が個人導入
    await call(`/v1/plugins/${pluginId}/install`, {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.6.0.1"),
      body: { scope: "personal" },
    });

    // 管理者でも 409
    const denied = await call(`/v1/plugins/${pluginId}`, { method: "DELETE", cookie: admin.cookie });
    expect(denied.status, JSON.stringify(denied.json)).toBe(409);

    // 導入と本体が保持
    const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ?")
      .bind(pluginId)
      .first<{ n: number }>();
    expect(installs?.n).toBe(1);
    const row = await env.DB.prepare("SELECT id FROM plugins WHERE id = ?").bind(pluginId).first();
    expect(row).toBeTruthy();
  });
});

// ─── 引き継ぎ ─────────────────────────────────────────────────

describe("ログイン時の引き継ぎ", () => {
  it("ログイン直後の応答までに引き継ぎが完了し、アカウント所有として公開申請できる", async () => {
    // 1. 匿名で作成・導入
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.7.0.1"),
      body: { manifest: anonManifest("anon-transfer"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.7.0.1"),
      body: { scope: "personal" },
    });

    // 2. 端末 A の device_hash を持つセッション（= ログイン直後の状態）を作る
    // login API の実呼び出しはパスワード/TOTP が必要なため、ここでは
    // transferDeviceOwnedPlugins をログインと同じ引数で直接呼び、
    // 同期待ち合わせ（auth.ts は await している）と同じ効果を検証する。
    // device_hash は requestContext が決めるため、DB から該当端末の導入経路で確認する。
    // ここでは簡易に: 導入行の scope_ref から device:<hash> を取り、それを使う。
    const installRow = await env.DB.prepare(
      "SELECT scope_ref FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal'",
    )
      .bind(plugin.id)
      .first<{ scope_ref: string }>();
    const deviceHash = installRow?.scope_ref?.replace(/^device:/, "") ?? "";
    expect(deviceHash).not.toBe("");

    // 引き継ぎ先アカウントを先に作る（plugins.owner_account_id の FK 用）
    const transferAccountId = "01TRANSFERACCOUNT00000000000";
    await env.DB.prepare(
      "INSERT OR IGNORE INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, '転送先', NULL, NULL, 'user', 'active', 0)",
    )
      .bind(transferAccountId)
      .run();

    const transferred = await transferDeviceOwnedPlugins(env.DB, deviceHash, transferAccountId);
    expect(transferred).toBe(1);

    // 3. 引き継ぎ後: アカウント所有になっている（owner_device_hash が消え owner_account_id が設定）
    const row = await env.DB.prepare(
      "SELECT owner_account_id, owner_device_hash FROM plugins WHERE id = ?",
    )
      .bind(plugin.id)
      .first<{ owner_account_id: string | null; owner_device_hash: string | null }>();
    expect(row?.owner_account_id).toBe("01TRANSFERACCOUNT00000000000");
    expect(row?.owner_device_hash).toBeNull();

    // 4. R42-04 修正後: 導入の scope_ref は account ID に移る（匿名 Cookie では /active に出ない）。
    // 移行後の導入行を DB で確認する（セッションを作って /active で見るのは register テストで検証）。
    const movedInstall = await env.DB.prepare(
      "SELECT scope_ref, installed_by FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal'",
    )
      .bind(plugin.id)
      .first<{ scope_ref: string; installed_by: string | null }>();
    expect(movedInstall?.scope_ref).toBe("01TRANSFERACCOUNT00000000000");
    expect(movedInstall?.installed_by).toBe("01TRANSFERACCOUNT00000000000");
  });

  it("register の実 API でも同期引き継ぎされる（応答後すぐ一覧に出る）", async () => {
    // 匿名で作成
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.7.1.1"),
      body: { manifest: anonManifest("anon-register"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // register API（Turnstile は既定で不要）を同じ端末 Cookie で呼ぶ
    const register = await call("/v1/auth/register", {
      method: "POST",
      cookie: DEVICE_A,
      headers: withIp("10.7.1.1"),
      body: { name: "引き継ぎ太郎", email: `transfer-${Date.now()}@example.com`, password: "p@ssw0rd123" },
    });
    expect(register.status, JSON.stringify(register.json)).toBe(201);
    const session = expectData<{ account: { id: string } }>(register);

    // 応答直後（同期待ち合わせ後）にアカウント所有へ移っている
    const row = await env.DB.prepare(
      "SELECT owner_account_id, owner_device_hash FROM plugins WHERE id = ?",
    )
      .bind(plugin.id)
      .first<{ owner_account_id: string | null; owner_device_hash: string | null }>();
    expect(row?.owner_account_id).toBe(session.account.id);
    expect(row?.owner_device_hash).toBeNull();
  });
});

// ─── 0613 マイグレーション ─────────────────────────────────────

describe("0613 マイグレーション（既存 DB への適用）", () => {
  it("適用済み DB の検証: owner_device_hash 列があり、audit_log は再作成されない", async () => {
    const migration0613 = env.TEST_MIGRATIONS.find((item) => item.name.startsWith("0613_"));
    expect(migration0613).toBeTruthy();
    // 0613 の SQL 文は ALTER TABLE ADD COLUMN と CREATE INDEX のみ（audit_log の再作成なし）。
    // テスト DB はマイグレーションを全適用済みのため、ここでは:
    // 1) ALTER 文が「列の追加のみ」であること（再作成を含まない）を構造検証する
    // 2) 適用後の DB で plugins に owner_device_hash があり audit_log の既存行・索引が保たれること
    const allQueries = migration0613!.queries.join("\n").toLowerCase();
    expect(allQueries).toContain("alter table plugins add column owner_device_hash");
    expect(allQueries).toContain("create index");
    // audit_log の再作成（DROP TABLE audit_log / RENAME TO audit_log）を含まない
    expect(allQueries).not.toContain("drop table audit_log");
    expect(allQueries).not.toContain("rename to audit_log");

    // 適用後の DB の検証
    // plugins に owner_device_hash が追加されている
    const columns = await env.DB.prepare("PRAGMA table_info(plugins)").all<{ name: string }>();
    expect(columns.results.some((column) => column.name === "owner_device_hash")).toBe(true);

    // audit_log に行を追加できる（actor_type の CHECK は従来のまま）
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO audit_log (id, actor_type, actor_id, action, target, detail, created_at) VALUES ('0613TESTAUDIT00000000000001', 'account', 'acct', 'test.action', 'tgt', '{}', ?)",
    )
      .bind(now)
      .run();
    const row = await env.DB.prepare(
      "SELECT id, actor_type, actor_id, action, target, detail, created_at FROM audit_log WHERE id = '0613TESTAUDIT00000000000001'",
    ).first<{ id: string; actor_type: string; actor_id: string; action: string; target: string; detail: string; created_at: number }>();
    expect(row?.actor_type).toBe("account");
    expect(row?.actor_id).toBe("acct");
    expect(row?.action).toBe("test.action");
    expect(row?.target).toBe("tgt");
    expect(row?.detail).toBe("{}");
    expect(row?.created_at).toBe(now);

    // 索引が存在する（0001 で作成済みのもの）
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log' ORDER BY name",
    ).all<{ name: string }>();
    const indexNames = indexes.results.map((item) => item.name);
    expect(indexNames).toContain("idx_audit_log_created");
    expect(indexNames).toContain("idx_audit_log_actor");
  });
});

// ─── R42-01: 同時作成で保有上限が破られない（差し戻し第1回） ────

describe("R42-01: 同時作成でも保有数上限 10 が保証される", () => {
  it("並行 19 件の作成で保有数は最大 10（INSERT 条件が原子的に止める）", async () => {
    const device = "oc_did=0123456789abcdef0123456789abcdea";
    const results = await Promise.all(
      Array.from({ length: 19 }, (_, index) =>
        call("/v1/plugins", {
          method: "POST",
          cookie: device,
          headers: withIp("10.42.0.1"),
          body: { manifest: anonManifest(`r4201-${index}`), code: "register({});" },
        }),
      ),
    );
    const created = results.filter((result) => result.status === 201);
    const rejected = results.filter((result) => result.status === 403);
    // 上限 10 のため、作成は最大 10・残りは 403
    expect(created.length).toBe(10);
    expect(rejected.length).toBe(9);
    // DB の保有数も 10
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugins WHERE owner_device_hash IS NOT NULL",
    ).first<{ n: number }>();
    expect(count?.n).toBe(10);
    // 孤立した版がない（作成されたプラグインのみが版を持つ）
    const versions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugin_versions WHERE plugin_id IN (SELECT id FROM plugins)",
    ).first<{ n: number }>();
    expect(versions?.n).toBe(10);
  });

  it("削除して再作成できる（上限後の再利用）", async () => {
    const device = "oc_did=0123456789abcdef0123456789abcdeb";
    for (let index = 0; index < 10; index++) {
      const result = await call("/v1/plugins", {
        method: "POST",
        cookie: device,
        headers: withIp("10.42.1.1"),
        body: { manifest: anonManifest(`r4201-re-${index}`), code: "register({});" },
      });
      expect(result.status).toBe(201);
    }
    // 11 個目は 403
    const eleventh = await call("/v1/plugins", {
      method: "POST",
      cookie: device,
      headers: withIp("10.42.1.2"),
      body: { manifest: anonManifest("r4201-re-eleven"), code: "register({});" },
    });
    expect(eleventh.status).toBe(403);

    // 1 つ削除して再作成
    const first = await env.DB.prepare(
      "SELECT id FROM plugins WHERE owner_device_hash IS NOT NULL ORDER BY id LIMIT 1",
    ).first<{ id: string }>();
    const deleted = await call(`/v1/plugins/${first!.id}`, {
      method: "DELETE",
      cookie: device,
      headers: withIp("10.42.1.3"),
    });
    expect(deleted.status).toBe(200);

    const recreated = await call("/v1/plugins", {
      method: "POST",
      cookie: device,
      headers: withIp("10.42.1.4"),
      body: { manifest: anonManifest("r4201-re-again"), code: "register({});" },
    });
    expect(recreated.status, JSON.stringify(recreated.json)).toBe(201);
  });
});

// ─── R42-02: 非公開コードのキャッシュ抑制 ──────────────────────

describe("R42-02: 端末所有・未公開コードは no-store で応答する", () => {
  it("端末所有の作成直後（draft）は no-store、公開済み（published）は public キャッシュ", async () => {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde2",
      headers: withIp("10.43.0.1"),
      body: { manifest: anonManifest("r4202-private"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // 端末所有の draft コードは no-store
    const privateCode = await call(`/v1/plugins/${plugin.id}/code`, {
      cookie: "oc_did=0123456789abcdef0123456789abcde2",
      headers: withIp("10.43.0.1"),
    });
    expect(privateCode.status).toBe(200);
    expect(privateCode.json).toBeNull(); // コードは text/javascript なので envelope は null
    // 応答ヘッダーの確認は call() では取れないため、SELF.fetch を直接使う
    const response = await SELF.fetch(`http://worker.test/v1/plugins/${plugin.id}/code`, {
      headers: { origin: ORIGIN, cookie: "oc_did=0123456789abcdef0123456789abcde2" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");

    // 公開済み（published・approved）は immutable キャッシュのまま。
    // beforeEach で公式 seed も消えるため、アカウント所有の公開プラグインを作って検証する。
    const user = await seedAccount("user");
    const published = await call("/v1/plugins", {
      method: "POST",
      cookie: user.cookie,
      headers: withIp("10.43.1.1"),
      body: {
        manifest: anonManifest("r4202-public", { scope: ["personal"] }),
        code: "register({});",
        visibility: "public",
      },
    });
    expect(published.status, JSON.stringify(published.json)).toBe(201);
    const pub = expectData<{ id: string }>(published);
    // 公開申請（personal のみなら即時公開）
    const publishResult = await call(`/v1/plugins/${pub.id}/publish`, {
      method: "POST",
      cookie: user.cookie,
      headers: withIp("10.43.1.1"),
      body: { scopes: ["personal"], visibility: "public" },
    });
    expect(publishResult.status).toBe(200);
    const official = await SELF.fetch(`http://worker.test/v1/plugins/${pub.id}/code?version=1.0.0`, {
      headers: { origin: ORIGIN },
    });
    expect(official.status).toBe(200);
    expect(official.headers.get("cache-control")).toContain("immutable");
  });
});

// ─── R42-03: state の POST/DELETE の閲覧ゲート ──────────────────

describe("R42-03: state の POST/DELETE も存在を漏らさない", () => {
  it("別端末の POST state は 404（403 ではない）", async () => {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde3",
      headers: withIp("10.44.0.1"),
      body: { manifest: anonManifest("r4203-state"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // 存在するプラグインへの別端末の POST は 404
    const existing = await call(`/v1/plugins/${plugin.id}/state`, {
      method: "POST",
      cookie: DEVICE_B,
      headers: withIp("10.44.0.2"),
      body: { scope: "personal", key: "test", value: "x" },
    });
    expect(existing.status).toBe(404);

    // 存在しないプラグインへの POST も 404（区別できない）
    const missing = await call("/v1/plugins/01MISSINGPLUGIN000000000000/state", {
      method: "POST",
      cookie: DEVICE_B,
      headers: withIp("10.44.0.2"),
      body: { scope: "personal", key: "test", value: "x" },
    });
    expect(missing.status).toBe(404);

    // DELETE も 404
    const deleteExisting = await call(`/v1/plugins/${plugin.id}/state?key=test`, {
      method: "DELETE",
      cookie: DEVICE_B,
      headers: withIp("10.44.0.2"),
    });
    expect(deleteExisting.status).toBe(404);

    // 所有端末は導入後に state を使える
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde3",
      headers: withIp("10.44.0.1"),
      body: { scope: "personal" },
    });
    const own = await call(`/v1/plugins/${plugin.id}/state`, {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde3",
      headers: withIp("10.44.0.1"),
      body: { scope: "personal", key: "test", value: "x" },
    });
    expect(own.status).toBe(200);
  });
});

// ─── R42-04: 引き継ぎ後の導入整合 ─────────────────────────────

describe("R42-04: 引き継ぎ後に元の導入が本人として扱われる", () => {
  it("作成→導入→登録→/active に出る・削除が 409 にならない", async () => {
    // 1. 匿名で作成・導入
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde4",
      headers: withIp("10.45.0.1"),
      body: { manifest: anonManifest("r4204-transfer"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);
    await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde4",
      headers: withIp("10.45.0.1"),
      body: { scope: "personal" },
    });

    // 2. 端末の device_hash を特定（導入行の scope_ref から）
    const installRow = await env.DB.prepare(
      "SELECT scope_ref FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal'",
    )
      .bind(plugin.id)
      .first<{ scope_ref: string }>();
    const deviceHash = installRow?.scope_ref?.replace(/^device:/, "") ?? "";
    expect(deviceHash).not.toBe("");

    // 3. register で同期引き継ぎ（auth.ts と同じ動作: 導入も移す）。
    // SELF.fetch を直接使い、Set-Cookie からセッションを取り出す。
    // device_hash は HMAC なので元に戻せない。作成に使った元の Cookie 値を使う。
    const deviceCookie = "oc_did=0123456789abcdef0123456789abcde4";
    const registerRaw = await SELF.fetch("http://worker.test/v1/auth/register", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-real-ip": "10.45.0.2",
        cookie: deviceCookie,
      },
      body: JSON.stringify({
        name: "R4204太郎",
        email: `r4204-${Date.now()}@example.com`,
        password: "p@ssw0rd123",
      }),
    });
    expect(registerRaw.status, await registerRaw.clone().text()).toBe(201);
    const registerJson = (await registerRaw.json()) as { ok?: boolean; data?: { account?: { id?: string } } };
    expect(registerJson?.ok).toBe(true);
    const accountId = registerJson?.data?.account?.id ?? "";
    expect(accountId).not.toBe("");
    const setCookies =
      typeof registerRaw.headers.getSetCookie === "function" ? registerRaw.headers.getSetCookie() : [];
    const sessionToken = setCookies
      .find((raw) => raw.startsWith("oc_sess="))
      ?.split(";")[0]
      ?.replace(/^oc_sess=/, "");
    expect(sessionToken).toBeTruthy();
    const sessionCookie = `oc_sess=${sessionToken}`;

    // 4. 引き継ぎ後: 導入が account スコープに移っている
    const movedInstall = await env.DB.prepare(
      "SELECT scope_ref, installed_by FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal'",
    )
      .bind(plugin.id)
      .first<{ scope_ref: string; installed_by: string | null }>();
    expect(movedInstall?.scope_ref).toBe(accountId);
    expect(movedInstall?.installed_by).toBe(accountId);

    // 5. /active に account 導入として現れる（ログインセッションで）
    const active = await call("/v1/plugins/active", {
      cookie: sessionCookie,
      headers: withIp("10.45.0.2"),
    });
    expect(
      expectData<{ items: PluginActiveInstall[] }>(active).items.some((item) => item.pluginId === plugin.id),
    ).toBe(true);

    // 6. 削除が 409 にならない（自分の導入だけのため）
    const deleteResponse = await call(`/v1/plugins/${plugin.id}`, {
      method: "DELETE",
      cookie: sessionCookie,
      headers: withIp("10.45.0.2"),
    });
    expect(deleteResponse.status, JSON.stringify(deleteResponse.json)).toBe(200);
  });
});

// ─── R42-06: 匿名所有者の新版が stopped にならない ─────────────

describe("R42-06: 端末所有者の新版は本人に stopped:false で返る", () => {
  it("匿名で版追加→新版導入→/active で stopped にならない", async () => {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde6",
      headers: withIp("10.46.0.1"),
      body: { manifest: anonManifest("r4206-newver"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    // 版追加（draft 状態）
    const version = await call(`/v1/plugins/${plugin.id}/versions`, {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde6",
      headers: withIp("10.46.0.1"),
      body: { version: "1.1.0", code: "register({}); // v1.1.0" },
    });
    expect(version.status, JSON.stringify(version.json)).toBe(201);

    // 新版を個人用に導入（install は upsert で版を更新）
    const install = await call(`/v1/plugins/${plugin.id}/install`, {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcde6",
      headers: withIp("10.46.0.1"),
      body: { scope: "personal", version: "1.1.0" },
    });
    // install は upsert: 新規作成時は 201、更新時は 200。初回なので 201 を期待するが
    // このテストでは version を指定した update のため 200 になることもある
    expect([200, 201]).toContain(install.status);

    // 所有端末の /active: 新版が stopped:false（本人プレビュー）
    const active = await call("/v1/plugins/active", { cookie: "oc_did=0123456789abcdef0123456789abcde6", headers: withIp("10.46.0.1") });
    const items = expectData<{ items: PluginActiveInstall[] }>(active).items;
    const entry = items.find((item) => item.pluginId === plugin.id);
    expect(entry).toBeTruthy();
    expect(entry?.stopped).toBe(false);
    expect(entry?.stoppedReason).toBeNull();

    // 別端末の /active: そもそも出ない（404 相当 = /active の一覧に含まれない）
    const activeB = await call("/v1/plugins/active", { cookie: DEVICE_B, headers: withIp("10.46.0.2") });
    const itemsB = expectData<{ items: PluginActiveInstall[] }>(activeB).items;
    expect(itemsB.some((item) => item.pluginId === plugin.id)).toBe(false);
  });
});

// ─── R44-01: 既存所有物との導入衝突（差し戻し第2回） ────────────

describe("R44-01: 既存アカウント所有物との導入衝突", () => {
  it("既存所有物 P を両方で導入済みでも、新規 Q の引き継ぎ後に /active・削除が成功する", async () => {
    const dev = await seedAccount("user");
    // 既存のアカウント所有物 P を作成・公開
    const pCreated = await call("/v1/plugins", {
      method: "POST",
      cookie: dev.cookie,
      headers: withIp("10.47.0.1"),
      body: { manifest: anonManifest("r4401-p", { scope: ["personal", "board", "site"] }), code: "register({});", visibility: "public" },
    });
    expect(pCreated.status, JSON.stringify(pCreated.json)).toBe(201);
    const p = expectData<{ id: string }>(pCreated);
    await call(`/v1/plugins/${p.id}/publish`, {
      method: "POST",
      cookie: dev.cookie,
      headers: withIp("10.47.0.1"),
      body: { scopes: ["personal"], visibility: "public" },
    });
    // アカウント側で P を導入
    await call(`/v1/plugins/${p.id}/install`, {
      method: "POST",
      cookie: dev.cookie,
      headers: withIp("10.47.0.1"),
      body: { scope: "personal" },
    });

    // 匿名端末で P を導入（device: 導入）
    const anonymousDevice = "oc_did=0123456789abcdef0123456789abcdf0";
    await call(`/v1/plugins/${p.id}/install`, {
      method: "POST",
      cookie: anonymousDevice,
      headers: withIp("10.47.0.2"),
      body: { scope: "personal" },
    });

    // 同じ匿名端末で新規 Q を作成・導入
    const qCreated = await call("/v1/plugins", {
      method: "POST",
      cookie: anonymousDevice,
      headers: withIp("10.47.0.2"),
      body: { manifest: anonManifest("r4401-q"), code: "register({});" },
    });
    expect(qCreated.status, JSON.stringify(qCreated.json)).toBe(201);
    const q = expectData<{ id: string }>(qCreated);
    await call(`/v1/plugins/${q.id}/install`, {
      method: "POST",
      cookie: anonymousDevice,
      headers: withIp("10.47.0.2"),
      body: { scope: "personal" },
    });

    // Q の device: 導入の scope_ref を取得
    const qInstallBefore = await env.DB.prepare(
      "SELECT scope_ref FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal'",
    ).bind(q.id).first<{ scope_ref: string }>();
    const qDeviceHash = qInstallBefore?.scope_ref?.replace(/^device:/, "") ?? "";
    expect(qDeviceHash).not.toBe("");

    // P の device: 導入の scope_ref（アカウント導入と衝突する状態にある）
    const pDeviceInstall = await env.DB.prepare(
      "SELECT id FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal' AND scope_ref = ?",
    ).bind(p.id, `device:${qDeviceHash}`).first<{ id: string }>();
    const pDeviceInstallId = pDeviceInstall?.id;
    expect(pDeviceInstallId).toBeTruthy(); // P に device: 導入がある

    // transferDeviceOwnedPlugins を呼ぶ（login/register と同じ引数）
    const transferred = await transferDeviceOwnedPlugins(env.DB, qDeviceHash, dev.id);
    expect(transferred).toBe(1); // Q だけが移る（P は既に account 所有）

    // Q の導入が account に移っている
    const qInstallAfter = await env.DB.prepare(
      "SELECT scope_ref, installed_by FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal'",
    ).bind(q.id).first<{ scope_ref: string; installed_by: string | null }>();
    expect(qInstallAfter?.scope_ref).toBe(dev.id);
    expect(qInstallAfter?.installed_by).toBe(dev.id);

    // P の device: 導入はそのまま残る（勝手に移されない）
    const pDeviceAfter = await env.DB.prepare(
      "SELECT scope_ref FROM plugin_installs WHERE id = ?",
    ).bind(pDeviceInstallId).first<{ scope_ref: string }>();
    expect(pDeviceAfter?.scope_ref).toBe(`device:${qDeviceHash}`);

    // Q の削除が 409 にならない
    const qDelete = await call(`/v1/plugins/${q.id}`, {
      method: "DELETE",
      cookie: dev.cookie,
      headers: withIp("10.47.0.3"),
    });
    expect(qDelete.status, JSON.stringify(qDelete.json)).toBe(200);
  });
});

// ─── R44-03: 本体と初期版の原子性 ─────────────────────────────

describe("R44-03: 本体と初期版が同じバッチで保存される", () => {
  it("端末所有の作成成功時、本体と版が両方存在する", async () => {
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: "oc_did=0123456789abcdef0123456789abcdf1",
      headers: withIp("10.48.0.1"),
      body: { manifest: anonManifest("r4403-atomic"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    const parent = await env.DB.prepare("SELECT id, latest_version FROM plugins WHERE id = ?")
      .bind(plugin.id)
      .first<{ id: string; latest_version: string | null }>();
    expect(parent).toBeTruthy();
    expect(parent?.latest_version).toBe("1.0.0");

    const version = await env.DB.prepare(
      "SELECT version, code_hash FROM plugin_versions WHERE plugin_id = ? AND version = '1.0.0'",
    ).bind(plugin.id).first<{ version: string; code_hash: string }>();
    expect(version).toBeTruthy();
  });

  it("アカウント所有の作成成功時、本体と版が両方存在する", async () => {
    const dev = await seedAccount("user");
    const created = await call("/v1/plugins", {
      method: "POST",
      cookie: dev.cookie,
      headers: withIp("10.48.1.1"),
      body: { manifest: anonManifest("r4403-account"), code: "register({});" },
    });
    expect(created.status).toBe(201);
    const plugin = expectData<{ id: string }>(created);

    const parent = await env.DB.prepare("SELECT id FROM plugins WHERE id = ?")
      .bind(plugin.id)
      .first<{ id: string }>();
    expect(parent).toBeTruthy();

    const version = await env.DB.prepare(
      "SELECT version FROM plugin_versions WHERE plugin_id = ?",
    ).bind(plugin.id).first<{ version: string }>();
    expect(version?.version).toBe("1.0.0");
  });

  it("上限超過時、本体も版も存在しない（FK 違反・500 なし）", async () => {
    const device = "oc_did=0123456789abcdef0123456789abcdf2";
    for (let index = 0; index < 10; index++) {
      await call("/v1/plugins", {
        method: "POST",
        cookie: device,
        headers: withIp("10.48.2.1"),
        body: { manifest: anonManifest(`r4403-limit-${index}`), code: "register({});" },
      });
    }
    // 11 個目は 403
    const eleventh = await call("/v1/plugins", {
      method: "POST",
      cookie: device,
      headers: withIp("10.48.2.2"),
      body: { manifest: anonManifest("r4403-over"), code: "register({});" },
    });
    expect(eleventh.status).toBe(403);
    expect(eleventh.json?.message).toContain("10 個まで");

    // 11 個目の本体も版も存在しない
    const orphan = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugins WHERE name = 'r4403-over'",
    ).first<{ n: number }>();
    expect(orphan?.n).toBe(0);
    const orphanVersions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugin_versions pv LEFT JOIN plugins p ON p.id = pv.plugin_id WHERE p.id IS NULL",
    ).first<{ n: number }>();
    expect(orphanVersions?.n).toBe(0); // 孤立した版がない
  });
});
