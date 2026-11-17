// プラグイン通報の閲覧・対応 API 統合テスト（設計 87 の受け入れ）。
// - 通報一覧（作者・サイト管理者）と通報者 ID の出し分け
// - 管理画面用の集計一覧（未対応のみ / 対応済みも含む）
// - 対応（対応済み・却下）の権限・状態遷移・監査ログ・flagged の解除
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hmacSha256Hex,
  sha256Hex,
  ulid,
  type PluginDetail,
  type PluginReportGroup,
  type PluginReportInfo,
  type PluginReportReason,
} from "shared";

const ORIGIN = "http://localhost:3000";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_net_log"),
    env.DB.prepare("DELETE FROM plugin_state"),
    env.DB.prepare("DELETE FROM plugin_reports"),
    env.DB.prepare("DELETE FROM plugin_reviews"),
    env.DB.prepare("DELETE FROM plugin_installs"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'plugin.report.%'"),
  ]);
});

// ─── ヘルパ ───────────────────────────────────────────────────────

interface Account {
  id: string;
  name: string;
  cookie: string;
}

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

function expectData<T>(result: CallResult): T {
  if (!result.json || result.json.ok !== true) {
    throw new Error(`API 呼び出しが失敗しました: ${JSON.stringify(result.json)}`);
  }
  return result.json.data as T;
}

async function seedAccount(role: "owner" | "special_admin" | "user", name = "tester"): Promise<Account> {
  const id = ulid();
  const token = `${ulid()}${ulid()}`;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const accountName = `${name}-${id.slice(-6)}`;
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, NULL, NULL, ?, 'active', ?)",
  )
    .bind(id, accountName, role, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, account_id, expires_at, created_at, touched_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(tokenHash, id, now + 86_400, now, now)
    .run();
  return { id, name: accountName, cookie: `oc_sess=${token}` };
}

/** 板スタッフ（モデレーター）を作る。通報の対応権限が無いことの検証用。 */
async function seedBoardStaff(account: Account): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const boardId = Math.floor(Math.random() * 1_000_000) + 1;
  await env.DB.prepare(
    "INSERT INTO boards (id, slug, name, category, created_at) VALUES (?, ?, ?, 'test', ?)",
  )
    .bind(boardId, `b-${boardId}`, `板${boardId}`, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO board_staff (board_id, account_id, level, created_at) VALUES (?, ?, 'moderator', ?)",
  )
    .bind(boardId, account.id, now)
    .run();
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  const response = await SELF.fetch(`http://worker.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = (await response.json().catch(() => null)) as Envelope | null;
  return { status: response.status, json };
}

const SAMPLE_CODE = "register({});";

async function createPublishedPlugin(cookie: string, name: string): Promise<string> {
  const created = await call("/v1/plugins", {
    method: "POST",
    cookie,
    body: {
      manifest: {
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
      },
      code: SAMPLE_CODE,
      visibility: "private",
    },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const { id } = expectData<{ id: string }>(created);

  const published = await call(`/v1/plugins/${id}/publish`, {
    method: "POST",
    cookie,
    body: { scopes: ["personal"], visibility: "public" },
  });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  return id;
}

async function report(
  pluginId: string,
  deviceId: string,
  reason: PluginReportReason,
  detail?: string,
): Promise<PluginReportInfo> {
  const result = await call(`/v1/plugins/${pluginId}/report`, {
    method: "POST",
    cookie: `oc_did=${deviceId}`,
    body: { reason, detail },
  });
  expect(result.status, JSON.stringify(result.json)).toBe(201);
  return expectData<PluginReportInfo>(result);
}

// ─── 権限 ─────────────────────────────────────────────────────────

describe("プラグイン通報 API の権限", () => {
  it("管理画面の一覧は未ログイン 401・一般/板スタッフ 403・サイト管理者 200", async () => {
    const user = await seedAccount("user");
    const staff = await seedAccount("user", "staff");
    await seedBoardStaff(staff);
    const owner = await seedAccount("special_admin", "admin");

    const anon = await call("/v1/admin/plugin-reports");
    expect(anon.status).toBe(401);
    const asUser = await call("/v1/admin/plugin-reports", { cookie: user.cookie });
    expect(asUser.status).toBe(403);
    const asStaff = await call("/v1/admin/plugin-reports", { cookie: staff.cookie });
    expect(asStaff.status).toBe(403);
    const asOwner = await call("/v1/admin/plugin-reports", { cookie: owner.cookie });
    expect(asOwner.status).toBe(200);
    expect(expectData<{ items: PluginReportGroup[] }>(asOwner).items).toEqual([]);
  });

  it("対応は未ログイン 401・作者/一般/板スタッフ 403・サイト管理者のみ通る", async () => {
    const author = await seedAccount("user", "author");
    const other = await seedAccount("user", "other");
    const staff = await seedAccount("user", "staff");
    await seedBoardStaff(staff);
    const admin = await seedAccount("special_admin", "admin");

    const pluginId = await createPublishedPlugin(author.cookie, `perm-${ulid().slice(-8).toLowerCase()}`);
    const created = await report(pluginId, "10000000000000000000000000000001", "broken");

    const handlePath = `/v1/plugins/reports/${created.id}/handle`;
    const anon = await call(handlePath, { method: "POST", body: { action: "resolve" } });
    expect(anon.status).toBe(401);

    for (const actor of [author, other, staff]) {
      const denied = await call(handlePath, {
        method: "POST",
        cookie: actor.cookie,
        body: { action: "resolve" },
      });
      expect(denied.status, `${actor.name} は 403`).toBe(403);
    }

    const allowed = await call(handlePath, {
      method: "POST",
      cookie: admin.cookie,
      body: { action: "resolve", note: "確認しました" },
    });
    expect(allowed.status).toBe(200);
    expect(expectData<{ status: string; openCount: number }>(allowed)).toEqual({
      id: created.id,
      status: "resolved",
      openCount: 0,
    });
  });

  it("通報の一覧は作者とサイト管理者だけ（一般・未ログインは 403）", async () => {
    const author = await seedAccount("user", "author");
    const other = await seedAccount("user", "other");
    const owner = await seedAccount("special_admin", "admin");
    const pluginId = await createPublishedPlugin(author.cookie, `view-${ulid().slice(-8).toLowerCase()}`);
    await report(pluginId, "20000000000000000000000000000001", "broken");

    const anon = await call(`/v1/plugins/${pluginId}/reports`);
    expect(anon.status).toBe(403);
    const asOther = await call(`/v1/plugins/${pluginId}/reports`, { cookie: other.cookie });
    expect(asOther.status).toBe(403);

    const asAuthor = await call(`/v1/plugins/${pluginId}/reports`, { cookie: author.cookie });
    expect(asAuthor.status).toBe(200);
    expect(expectData<{ items: PluginReportInfo[] }>(asAuthor).items).toHaveLength(1);

    const asOwner = await call(`/v1/plugins/${pluginId}/reports`, { cookie: owner.cookie });
    expect(asOwner.status).toBe(200);
  });
});

// ─── 一覧・対応・集計 ─────────────────────────────────────────────

describe("プラグイン通報の閲覧と対応", () => {
  it("作者には通報者 ID を出さず、サイト管理者には出す", async () => {
    const author = await seedAccount("user", "author");
    const owner = await seedAccount("special_admin", "admin");
    const pluginId = await createPublishedPlugin(author.cookie, `reporter-${ulid().slice(-8).toLowerCase()}`);

    const deviceId = "30000000000000000000000000000001";
    await report(pluginId, deviceId, "broken", "ボタンが出ません");
    const expectedDeviceHash = await hmacSha256Hex("test-salt", `device:${deviceId}`);

    const asAuthor = expectData<{ items: PluginReportInfo[] }>(
      await call(`/v1/plugins/${pluginId}/reports`, { cookie: author.cookie }),
    );
    expect(asAuthor.items).toHaveLength(1);
    expect(asAuthor.items[0]!.detail).toBe("ボタンが出ません");
    expect(asAuthor.items[0]!.status).toBe("open");
    expect(asAuthor.items[0]!.handledAt).toBeNull();
    expect(asAuthor.items[0]).not.toHaveProperty("reporterId");
    expect(asAuthor.items[0]).not.toHaveProperty("reporterKind");

    const asOwner = expectData<{ items: PluginReportInfo[] }>(
      await call(`/v1/plugins/${pluginId}/reports`, { cookie: owner.cookie }),
    );
    expect(asOwner.items[0]!.reporterKind).toBe("device");
    expect(asOwner.items[0]!.reporterId).toBe(expectedDeviceHash);
  });

  it("未対応の集計・対応済みの除外・flagged の解除・監査ログ", async () => {
    const author = await seedAccount("user", "author");
    const owner = await seedAccount("special_admin", "admin");
    const pluginId = await createPublishedPlugin(author.cookie, `flow-${ulid().slice(-8).toLowerCase()}`);

    const first = await report(pluginId, "40000000000000000000000000000001", "broken");
    const second = await report(pluginId, "40000000000000000000000000000002", "spam");
    const third = await report(pluginId, "40000000000000000000000000000003", "malicious");

    // 3 件で flagged（既存仕様）。
    const detailBefore = expectData<PluginDetail>(
      await call(`/v1/plugins/${pluginId}`, { cookie: author.cookie }),
    );
    expect(detailBefore.reportCount).toBe(3);
    expect(detailBefore.flagged).toBe(true);

    // 管理画面の一覧: 未対応 3 件・理由別内訳・作者名・最新日時。
    const listBefore = expectData<{ items: PluginReportGroup[] }>(
      await call("/v1/admin/plugin-reports", { cookie: owner.cookie }),
    );
    expect(listBefore.items).toHaveLength(1);
    const group = listBefore.items[0]!;
    expect(group.pluginId).toBe(pluginId);
    expect(group.ownerName).toBe(author.name);
    expect(group.ownership).toBe("account");
    expect(group.openCount).toBe(3);
    expect(group.totalCount).toBe(3);
    expect(group.byReason).toEqual({
      malicious: 1,
      spam: 1,
      broken: 1,
      inappropriate: 0,
      other: 0,
    });
    expect(group.latestOpenAt).not.toBeNull();
    expect(group.flagged).toBe(true);

    // 1 件目を却下 → 未対応 2 件のまま一覧に出る。
    const dismiss = await call(`/v1/plugins/reports/${first.id}/handle`, {
      method: "POST",
      cookie: owner.cookie,
      body: { action: "dismiss", note: "仕様どおり" },
    });
    expect(dismiss.status).toBe(200);
    expect(expectData<{ status: string; openCount: number }>(dismiss).status).toBe("dismissed");

    const listAfterDismiss = expectData<{ items: PluginReportGroup[] }>(
      await call("/v1/admin/plugin-reports", { cookie: owner.cookie }),
    );
    expect(listAfterDismiss.items[0]!.openCount).toBe(2);
    expect(listAfterDismiss.items[0]!.byReason.broken).toBe(0);

    // 残りを対応済みにすると既定の一覧から消え、「対応済みも表示」では残る。
    for (const item of [second, third]) {
      const done = await call(`/v1/plugins/reports/${item.id}/handle`, {
        method: "POST",
        cookie: owner.cookie,
        body: { action: "resolve", note: "" },
      });
      expect(done.status).toBe(200);
    }

    const listDefault = expectData<{ items: PluginReportGroup[] }>(
      await call("/v1/admin/plugin-reports", { cookie: owner.cookie }),
    );
    expect(listDefault.items).toEqual([]);

    const listAll = expectData<{ items: PluginReportGroup[] }>(
      await call("/v1/admin/plugin-reports?includeResolved=1", { cookie: owner.cookie }),
    );
    expect(listAll.items).toHaveLength(1);
    expect(listAll.items[0]!.openCount).toBe(0);
    expect(listAll.items[0]!.totalCount).toBe(3);
    expect(listAll.items[0]!.flagged).toBe(false);

    // 累計（report_count）は減らない。対応日時と状態が一覧に出る。
    const detailAfter = expectData<PluginDetail>(
      await call(`/v1/plugins/${pluginId}`, { cookie: author.cookie }),
    );
    expect(detailAfter.reportCount).toBe(3);
    expect(detailAfter.flagged).toBe(false);

    const items = expectData<{ items: PluginReportInfo[] }>(
      await call(`/v1/plugins/${pluginId}/reports`, { cookie: author.cookie }),
    ).items;
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.status === "open")).toHaveLength(0);
    expect(items.find((item) => item.id === first.id)!.status).toBe("dismissed");
    expect(items.find((item) => item.id === first.id)!.handledAt).not.toBeNull();

    // 監査ログ（メモ付き）。
    const audits = await env.DB.prepare(
      "SELECT action, actor_type, actor_id, target, detail FROM audit_log WHERE action LIKE 'plugin.report.%' ORDER BY rowid",
    ).all<{ action: string; actor_type: string; actor_id: string; target: string; detail: string }>();
    expect(audits.results.map((row) => row.action)).toEqual([
      "plugin.report.dismiss",
      "plugin.report.resolve",
      "plugin.report.resolve",
    ]);
    const dismissAudit = audits.results[0]!;
    expect(dismissAudit.actor_type).toBe("special_admin");
    expect(dismissAudit.actor_id).toBe(owner.id);
    expect(dismissAudit.target).toBe(first.id);
    expect(JSON.parse(dismissAudit.detail)).toMatchObject({ pluginId, note: "仕様どおり" });

    // 二重対応は 409。
    const again = await call(`/v1/plugins/reports/${first.id}/handle`, {
      method: "POST",
      cookie: owner.cookie,
      body: { action: "resolve" },
    });
    expect(again.status).toBe(409);
  });

  it("対応は他のプラグインに影響せず、累計（report_count）も変えない", async () => {
    const author = await seedAccount("user", "author");
    const owner = await seedAccount("special_admin", "admin");
    const reported = await createPublishedPlugin(author.cookie, `a-${ulid().slice(-8).toLowerCase()}`);
    const untouched = await createPublishedPlugin(author.cookie, `b-${ulid().slice(-8).toLowerCase()}`);

    const created = await report(reported, "50000000000000000000000000000001", "other");

    const before = await env.DB.prepare("SELECT id, report_count, flagged FROM plugins WHERE id = ?")
      .bind(untouched)
      .first<{ id: string; report_count: number; flagged: number }>();
    expect(before?.report_count).toBe(0);
    expect(before?.flagged).toBe(0);

    const done = await call(`/v1/plugins/reports/${created.id}/handle`, {
      method: "POST",
      cookie: owner.cookie,
      body: { action: "resolve" },
    });
    expect(done.status).toBe(200);

    const after = await env.DB.prepare("SELECT report_count FROM plugins WHERE id = ?")
      .bind(reported)
      .first<{ report_count: number }>();
    expect(after?.report_count).toBe(1);
  });
});