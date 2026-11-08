// WP3 プラグイン API 統合テスト（DESIGN §7 のライフサイクル全体）。
// 作成→版追加→公開→審査→検索→インストール(3スコープ)→更新→通報→停止 を SELF.fetch で検証する。

import { SELF, env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hmacSha256Hex,
  sha256Hex,
  ulid,
  type PluginActiveInstall,
  type PluginDetail,
  type PluginInstallInfo,
  type PluginNetFetchResult,
  type PluginReportInfo,
  type PluginReviewInfo,
  type PluginStaticCheckResult,
} from "shared";
import { network } from "./network";

const ORIGIN = "http://localhost:3000";

// 同一ファイル内のテストは D1 を共有するため、プラグイン関連テーブルを毎回初期化する
// （他のテストのテーブル・アカウントは触らない）。
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_net_log"),
    env.DB.prepare("DELETE FROM plugin_state"),
    env.DB.prepare("DELETE FROM plugin_reports"),
    env.DB.prepare("DELETE FROM plugin_reviews"),
    env.DB.prepare("DELETE FROM plugin_installs"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
  ]);
});

// ─── テストヘルパ ─────────────────────────────────────────────────

interface Account {
  id: string;
  token: string;
  cookie: string;
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

/** 応答 envelope の境界検証（外部入力 = HTTP 応答なので zod で parse する）。 */
const envelopeSchema = z.looseObject({
  ok: z.boolean().optional(),
  data: z.unknown().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

interface CallResult {
  status: number;
  json: Envelope | null;
  response: Response;
}

/**
 * 成功応答の data を取り出す。形状はサーバ契約（shared の型）で固定されているため、
 * テスト側が検証対象の型 T を指定する（この 1 箇所だけが型の受け渡し点）。
 */
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
  const parsed = envelopeSchema.safeParse(await response.json().catch(() => null));
  return { status: response.status, json: parsed.success ? parsed.data : null, response };
}

function manifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

const SAMPLE_CODE = `// plugin
register({
  slots: {
    "thread-post-inline": (ctx) => ({ html: "<b>" + ctx.post.body + "</b>" }),
  },
});`;

interface CreatedPlugin {
  id: string;
  version: string;
}

async function createPlugin(
  cookie: string,
  overrides: {
    name: string;
    code?: string;
    manifest?: Record<string, unknown>;
    visibility?: string;
  },
): Promise<CreatedPlugin> {
  const result = await call("/v1/plugins", {
    method: "POST",
    cookie,
    body: {
      manifest: overrides.manifest ?? manifest(overrides.name),
      code: overrides.code ?? SAMPLE_CODE,
      visibility: overrides.visibility ?? "private",
    },
  });
  expect(result.status, JSON.stringify(result.json)).toBe(201);
  return expectData<CreatedPlugin>(result);
}

interface PublishResult {
  status: string;
  needsReview: boolean;
  reviewId: string | null;
}

async function publish(
  cookie: string,
  id: string,
  scopes: string[],
  visibility = "public",
): Promise<CallResult & { data: PublishResult }> {
  const result = await call(`/v1/plugins/${id}/publish`, {
    method: "POST",
    cookie,
    body: { scopes, visibility },
  });
  return { ...result, data: expectData<PublishResult>(result) };
}

// ─── ライフサイクル ───────────────────────────────────────────────

describe("プラグインのライフサイクル（GitHub なしで完結）", () => {
  it("作成→版追加→公開申請→審査承認→検索→導入→更新", async () => {
    const dev = await seedAccount("user");
    const admin = await seedAccount("special_admin");

    const created = await createPlugin(dev.cookie, { name: "lifecycle-demo" });

    // 版追加（1.1.0）
    const versionResult = await call(`/v1/plugins/${created.id}/versions`, {
      method: "POST",
      cookie: dev.cookie,
      body: {
        version: "1.1.0",
        code: `${SAMPLE_CODE}\n// v1.1.0`,
        changelog: "改善",
        manifest: manifest("lifecycle-demo", { version: "1.1.0" }),
      },
    });
    expect(versionResult.status).toBe(201);
    expect(expectData<{ version: string }>(versionResult).version).toBe("1.1.0");

    // サイト公開申請 → pending（検索に出ない）
    const publishResult = await publish(dev.cookie, created.id, ["personal", "board", "site"]);
    expect(publishResult.status).toBe(200);
    expect(publishResult.data.status).toBe("pending");
    expect(publishResult.data.needsReview).toBe(true);

    const beforeSearch = await call("/v1/plugins?q=lifecycle-demo");
    expect(expectData<{ items: unknown[] }>(beforeSearch).items).toHaveLength(0);

    const detailPending = await call(`/v1/plugins/${created.id}`, { cookie: dev.cookie });
    expect(expectData<PluginDetail>(detailPending).status).toBe("pending");

    // 審査キュー（管理者）
    const queue = await call("/v1/plugins/reviews?status=pending&scope=site", { cookie: admin.cookie });
    expect(queue.status).toBe(200);
    const review = expectData<{ items: PluginReviewInfo[] }>(queue).items.find(
      (item) => item.pluginId === created.id,
    );
    expect(review).toBeTruthy();
    expect(review?.version).toBe("1.1.0");
    expect(review?.staticResult?.allowed).toBe(true);

    // 承認
    const approve = await call(`/v1/plugins/${created.id}/review`, {
      method: "POST",
      cookie: admin.cookie,
      body: { decision: "approve", scope: "site", note: "OK" },
    });
    expect(approve.status).toBe(200);
    expect(expectData<{ pluginStatus: string }>(approve).pluginStatus).toBe("published");

    // 検索に出る
    const search = await call("/v1/plugins?q=lifecycle-demo");
    expect(search.status).toBe(200);
    const found = expectData<{ items: Array<{ name: string; latestVersion: string | null }> }>(search).items;
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("lifecycle-demo");
    expect(found[0]?.latestVersion).toBe("1.1.0");

    // 個人導入（匿名端末でも可能）
    const deviceCookie = "oc_did=0123456789abcdef0123456789abcdef";
    const personal = await call(`/v1/plugins/${created.id}/install`, {
      method: "POST",
      cookie: deviceCookie,
      body: { scope: "personal" },
    });
    expect(personal.status, JSON.stringify(personal.json)).toBe(201);
    const personalInstall = expectData<{ install: PluginInstallInfo; created: boolean }>(personal);
    expect(personalInstall.install.scope).toBe("personal");
    expect(personalInstall.install.version).toBe("1.1.0");

    // 板導入（owner は全板の管理人相当）
    const owner = await seedAccount("owner");
    const board = await call(`/v1/plugins/${created.id}/install`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope: "board", boardId: 42 },
    });
    expect(board.status, JSON.stringify(board.json)).toBe(201);
    const boardInstall = expectData<{ install: PluginInstallInfo }>(board).install;
    expect(boardInstall.scopeRef).toBe("42");

    // サイト導入（承認済みなので可）
    const site = await call(`/v1/plugins/${created.id}/install`, {
      method: "POST",
      cookie: admin.cookie,
      body: { scope: "site" },
    });
    expect(site.status, JSON.stringify(site.json)).toBe(201);
    const siteInstallId = expectData<{ install: PluginInstallInfo }>(site).install.id;

    // /active がスコープを解決する
    const active = await call("/v1/plugins/active?boardId=42", { cookie: deviceCookie });
    expect(active.status).toBe(200);
    const activeItems = expectData<{ items: PluginActiveInstall[] }>(active).items;
    expect(activeItems.map((item) => item.installId)).toContain(siteInstallId);

    const activeBoard = await call("/v1/plugins/active?boardId=42", { cookie: owner.cookie });
    const boardItems = expectData<{ items: PluginActiveInstall[] }>(activeBoard).items;
    expect(boardItems.some((item) => item.scope === "board" && item.scopeRef === "42")).toBe(true);

    // 版 1.2.0 を公開してインストールを更新
    const v12 = await call(`/v1/plugins/${created.id}/versions`, {
      method: "POST",
      cookie: dev.cookie,
      body: {
        version: "1.2.0",
        code: `${SAMPLE_CODE}\n// v1.2.0`,
        manifest: manifest("lifecycle-demo", { version: "1.2.0" }),
      },
    });
    expect(v12.status).toBe(201);
    const republish = await publish(dev.cookie, created.id, ["personal", "board", "site"]);
    expect(republish.data.status).toBe("pending");
    const approveAgain = await call(`/v1/plugins/${created.id}/review`, {
      method: "POST",
      cookie: admin.cookie,
      body: { decision: "approve", scope: "site" },
    });
    expect(approveAgain.status).toBe(200);

    const updated = await call(`/v1/plugins/${created.id}/update`, {
      method: "POST",
      cookie: deviceCookie,
      body: { scope: "personal" },
    });
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);
    const updatedBody = expectData<{ install: PluginInstallInfo; updated: boolean }>(updated);
    expect(updatedBody.updated).toBe(true);
    expect(updatedBody.install.version).toBe("1.2.0");

    // アンインストール
    const removed = await call(`/v1/plugins/${created.id}/uninstall`, {
      method: "POST",
      cookie: deviceCookie,
      body: { scope: "personal" },
    });
    expect(removed.status).toBe(200);
    expect(expectData<{ uninstalled: boolean }>(removed).uninstalled).toBe(true);

    const afterRemove = await call("/v1/plugins/active", { cookie: deviceCookie });
    // 個人用は消えるが、サイト全体インストールは全閲覧者に適用されるため残る
    const remaining = expectData<{ items: PluginActiveInstall[] }>(afterRemove).items;
    expect(remaining.filter((item) => item.scope === "personal")).toHaveLength(0);
    expect(remaining.some((item) => item.scope === "site")).toBe(true);
  });

  it("site 審査前はサイト導入を拒否する", async () => {
    const dev = await seedAccount("user");
    const admin = await seedAccount("special_admin");
    const created = await createPlugin(dev.cookie, { name: "site-gate" });

    // personal のみ公開（審査不要）→ published
    const publishResult = await publish(dev.cookie, created.id, ["personal"], "public");
    expect(publishResult.data.status).toBe("published");

    const install = await call(`/v1/plugins/${created.id}/install`, {
      method: "POST",
      cookie: admin.cookie,
      body: { scope: "site" },
    });
    expect(install.status, JSON.stringify(install.json)).toBe(403);
    expect(install.json?.code).toBe("FORBIDDEN");
  });

  it("板導入は板管理人以上のみ（一般ユーザーは 403）", async () => {
    const dev = await seedAccount("user");
    const other = await seedAccount("user");
    const created = await createPlugin(dev.cookie, { name: "board-gate" });
    await publish(dev.cookie, created.id, ["personal"]);

    const denied = await call(`/v1/plugins/${created.id}/install`, {
      method: "POST",
      cookie: other.cookie,
      body: { scope: "board", boardId: 7 },
    });
    expect(denied.status).toBe(403);
  });

  it("別々の板への導入は別々の review 行になり、上書きしない（M-3）", async () => {
    const dev = await seedAccount("user");
    const admin = await seedAccount("special_admin");
    const created = await createPlugin(dev.cookie, { name: "board-review-sep" });
    await publish(dev.cookie, created.id, ["personal", "board"]);

    for (const boardId of [101, 102]) {
      const install = await call(`/v1/plugins/${created.id}/install`, {
        method: "POST",
        cookie: admin.cookie,
        body: { scope: "board", boardId },
      });
      expect(install.status, JSON.stringify(install.json)).toBe(201);
    }

    const rows = await env.DB.prepare(
      "SELECT id, scope, scope_ref, status FROM plugin_reviews WHERE plugin_id = ? AND scope = 'board' ORDER BY scope_ref",
    )
      .bind(created.id)
      .all<{ id: string; scope: string; scope_ref: string; status: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map((row) => row.scope_ref)).toEqual(["board:101", "board:102"]);
    expect(new Set(rows.results.map((row) => row.id)).size).toBe(2);
  });
});

// ─── 権限・認証 ───────────────────────────────────────────────────

describe("プラグイン API の権限", () => {
  it("未ログインでは作成できない", async () => {
    const result = await call("/v1/plugins", {
      method: "POST",
      body: { manifest: manifest("anon-create"), code: SAMPLE_CODE },
    });
    expect(result.status).toBe(401);
  });

  it("他人のプラグインは編集・公開できない", async () => {
    const owner = await seedAccount("user");
    const stranger = await seedAccount("user");
    const created = await createPlugin(owner.cookie, { name: "ownership" });

    const versionResult = await call(`/v1/plugins/${created.id}/versions`, {
      method: "POST",
      cookie: stranger.cookie,
      body: { version: "2.0.0", code: SAMPLE_CODE },
    });
    expect(versionResult.status).toBe(403);

    const publishResult = await call(`/v1/plugins/${created.id}/publish`, {
      method: "POST",
      cookie: stranger.cookie,
      body: { scopes: ["personal"], visibility: "public" },
    });
    expect(publishResult.status).toBe(403);

    const disable = await call(`/v1/plugins/${created.id}/disable`, {
      method: "POST",
      cookie: stranger.cookie,
      body: { reason: "嫌がらせ" },
    });
    expect(disable.status).toBe(403);
  });

  it("審査キューは管理者のみ", async () => {
    const dev = await seedAccount("user");
    const result = await call("/v1/plugins/reviews", { cookie: dev.cookie });
    expect(result.status).toBe(403);
  });

  it("マニフェストの権限宣言が不正なら 400（net:fetch に allowlist なし）", async () => {
    const dev = await seedAccount("user");
    const result = await call("/v1/plugins", {
      method: "POST",
      cookie: dev.cookie,
      body: {
        manifest: manifest("bad-manifest", { permissions: ["net:fetch"], connectAllowlist: [] }),
        code: SAMPLE_CODE,
      },
    });
    expect(result.status).toBe(400);
    expect(result.json?.code).toBe("VALIDATION");
  });
});

// ─── 静的検査 ─────────────────────────────────────────────────────

describe("静的検査（runStaticChecks）", () => {
  it("危険パターンを検出する", async () => {
    const dev = await seedAccount("user");
    const result = await call("/v1/plugins/preview-check", {
      method: "POST",
      cookie: dev.cookie,
      body: {
        code: "document.cookie = 'x'; localStorage.setItem('a','b'); while(true){}",
        manifest: manifest("check-demo"),
      },
    });
    expect(result.status).toBe(200);
    const body = expectData<{ checks: PluginStaticCheckResult; warnings: string[] }>(result);
    expect(body.checks.allowed).toBe(false);
    expect(body.checks.reasons.join("\n")).toContain("document.cookie");
  });

  it("安全なコードは許可され、未宣言権限の利用を警告する", async () => {
    const dev = await seedAccount("user");
    const result = await call("/v1/plugins/preview-check", {
      method: "POST",
      cookie: dev.cookie,
      body: {
        code: 'plugin.on("invoke", () => plugin.net.fetch({ url: "https://api.example.com" }));',
        manifest: manifest("check-ok"),
      },
    });
    const body = expectData<{ checks: PluginStaticCheckResult; warnings: string[] }>(result);
    expect(body.checks.allowed).toBe(true);
    expect(body.warnings.join("\n")).toContain("net:fetch");
  });

  it("静的検査に落ちるコードは公開できない", async () => {
    const dev = await seedAccount("user");
    const created = await createPlugin(dev.cookie, {
      name: "bad-code",
      code: "document.cookie = 'steal';",
    });
    const result = await call(`/v1/plugins/${created.id}/publish`, {
      method: "POST",
      cookie: dev.cookie,
      body: { scopes: ["personal"], visibility: "public" },
    });
    expect(result.status).toBe(400);
    expect(result.json?.code).toBe("VALIDATION");
  });
});

// ─── 通報・停止（キルスイッチ） ───────────────────────────────────

describe("通報と停止", () => {
  it("3 件の通報で flagged になり、停止でコード配信が 410 になる", async () => {
    const dev = await seedAccount("user");
    const admin = await seedAccount("special_admin");
    const created = await createPlugin(dev.cookie, { name: "report-target" });
    await publish(dev.cookie, created.id, ["personal"]);

    const reasons = ["malicious", "spam", "inappropriate"];
    for (let i = 0; i < reasons.length; i++) {
      const cookie = `oc_did=${String(i + 1).padStart(32, "0")}`;
      const report = await call(`/v1/plugins/${created.id}/report`, {
        method: "POST",
        cookie,
        body: { reason: reasons[i] },
      });
      expect(report.status, JSON.stringify(report.json)).toBe(201);
      expect(expectData<PluginReportInfo>(report).reason).toBe(reasons[i]);
    }

    // 同一端末からの重複通報は 409
    const duplicate = await call(`/v1/plugins/${created.id}/report`, {
      method: "POST",
      cookie: "oc_did=00000000000000000000000000000001",
      body: { reason: "spam" },
    });
    expect(duplicate.status).toBe(409);

    const detail = await call(`/v1/plugins/${created.id}`, { cookie: dev.cookie });
    const detailBody = expectData<PluginDetail>(detail);
    expect(detailBody.reportCount).toBe(3);
    expect(detailBody.flagged).toBe(true);

    // 停止前のインストール（停止後は新規導入できない）
    const deviceCookie = "oc_did=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const installBeforeStop = await call(`/v1/plugins/${created.id}/install`, {
      method: "POST",
      cookie: deviceCookie,
      body: { scope: "personal", version: "1.0.0" },
    });
    expect(installBeforeStop.status, JSON.stringify(installBeforeStop.json)).toBe(201);

    // 停止（キルスイッチ）
    const disable = await call(`/v1/plugins/${created.id}/disable`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "運営判断" },
    });
    expect(disable.status).toBe(200);
    expect(expectData<{ status: string }>(disable).status).toBe("disabled");

    const code = await call(`/v1/plugins/${created.id}/code`, {
      cookie: "oc_did=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(code.status).toBe(410);

    // 既存インストールは stopped=true で返る（ホストが kill を送る）
    const active = await call("/v1/plugins/active", { cookie: deviceCookie });
    const entry = expectData<{ items: PluginActiveInstall[] }>(active).items.find(
      (item) => item.pluginId === created.id,
    );
    expect(entry).toBeTruthy();
    expect(entry?.stopped).toBe(true);

    // 解除
    const enable = await call(`/v1/plugins/${created.id}/enable`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(enable.status).toBe(200);
    const codeAfter = await call(`/v1/plugins/${created.id}/code`, { cookie: deviceCookie });
    expect(codeAfter.status).toBe(200);
  });
});

// ─── コード配信キャッシュ ─────────────────────────────────────────

describe("コード配信", () => {
  it("バージョン固定 URL は不変キャッシュ・ETag 304", async () => {
    const dev = await seedAccount("user");
    const created = await createPlugin(dev.cookie, { name: "cache-demo" });
    await publish(dev.cookie, created.id, ["personal"]);

    const first = await call(`/v1/plugins/${created.id}/code?version=1.0.0`);
    expect(first.status).toBe(200);
    expect(first.response.headers.get("cache-control")).toContain("immutable");
    expect(first.response.headers.get("content-type")).toContain("javascript");
    const etag = first.response.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await call(`/v1/plugins/${created.id}/code?version=1.0.0`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(second.status).toBe(304);
  });

  it("未公開バージョンは第三者に配信しない", async () => {
    const dev = await seedAccount("user");
    const stranger = await seedAccount("user");
    const created = await createPlugin(dev.cookie, { name: "hidden-code" });
    // draft のまま
    const denied = await call(`/v1/plugins/${created.id}/code`, { cookie: stranger.cookie });
    expect(denied.status).toBe(404);
    const ownerView = await call(`/v1/plugins/${created.id}/code`, { cookie: dev.cookie });
    expect(ownerView.status).toBe(200);
  });
});

// ─── net:fetch プロキシ ──────────────────────────────────────────

describe("plugin-net プロキシ", () => {
  const NET_CODE = `plugin.net.fetch({ url: "https://api.example.com/data" });`;

  async function setupNetPlugin(): Promise<{ id: string; owner: Account }> {
    const owner = await seedAccount("user");
    const created = await createPlugin(owner.cookie, {
      name: "net-demo",
      code: NET_CODE,
      manifest: manifest("net-demo", {
        permissions: ["ui:slot", "net:fetch"],
        connectAllowlist: ["https://api.example.com"],
      }),
    });
    await publish(owner.cookie, created.id, ["personal"]);
    return { id: created.id, owner };
  }

  it("許可ドメインへの fetch は成功し、監査ログに残る", async () => {
    network.use(
      http.get("https://api.example.com/data", () => HttpResponse.json({ hello: "plugin", value: 42 })),
    );

    const { id, owner } = await setupNetPlugin();
    const deviceCookie = "oc_did=cccccccccccccccccccccccccccccccc";
    await call(`/v1/plugins/${id}/install`, {
      method: "POST",
      cookie: deviceCookie,
      body: { scope: "personal" },
    });

    const result = await call("/v1/plugin-net/fetch", {
      method: "POST",
      cookie: deviceCookie,
      body: { pluginId: id, scope: "personal", url: "https://api.example.com/data", method: "GET" },
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    const payload = expectData<PluginNetFetchResult>(result);
    expect(payload.status).toBe(200);
    expect(payload.body).toContain("plugin");

    const admin = await seedAccount("special_admin");
    const log = await call(`/v1/plugin-net/log?pluginId=${id}`, { cookie: admin.cookie });
    expect(log.status).toBe(200);
    const logItems = expectData<{ items: Array<{ allowed: boolean; host: string }> }>(log).items;
    expect(logItems.length).toBeGreaterThanOrEqual(1);
    expect(logItems[0]?.allowed).toBe(true);
    expect(logItems[0]?.host).toBe("api.example.com");

    // 監査ログは管理者のみ
    const denied = await call("/v1/plugin-net/log", { cookie: owner.cookie });
    expect(denied.status).toBe(403);
  });

  it("allowlist 外のオリジン・内部アドレス・http は拒否する", async () => {
    const { id } = await setupNetPlugin();
    const deviceCookie = "oc_did=dddddddddddddddddddddddddddddddd";
    await call(`/v1/plugins/${id}/install`, {
      method: "POST",
      cookie: deviceCookie,
      body: { scope: "personal" },
    });

    const cases = ["https://evil.example.com/steal", "https://127.0.0.1:8443/admin", "http://api.example.com/data"];
    for (const url of cases) {
      const result = await call("/v1/plugin-net/fetch", {
        method: "POST",
        cookie: deviceCookie,
        body: { pluginId: id, scope: "personal", url },
      });
      expect([400, 403], `${url} は拒否されるべき`).toContain(result.status);
    }

    const admin = await seedAccount("special_admin");
    const log = await call(`/v1/plugin-net/log?pluginId=${id}&allowed=0`, { cookie: admin.cookie });
    expect(expectData<{ items: unknown[] }>(log).items.length).toBeGreaterThanOrEqual(3);
  });

  it("net:fetch 権限がないプラグインは拒否する", async () => {
    const owner = await seedAccount("user");
    const created = await createPlugin(owner.cookie, { name: "no-net" });
    await publish(owner.cookie, created.id, ["personal"]);

    const result = await call("/v1/plugin-net/fetch", {
      method: "POST",
      cookie: owner.cookie,
      body: { pluginId: created.id, scope: "personal", url: "https://api.example.com/data" },
    });
    expect(result.status).toBe(403);
    expect(result.json?.message ?? "").toContain("net:fetch");
  });

  it("導入されていない端末からのプロキシ利用は拒否する", async () => {
    const { id } = await setupNetPlugin();
    const result = await call("/v1/plugin-net/fetch", {
      method: "POST",
      cookie: "oc_did=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      body: { pluginId: id, scope: "personal", url: "https://api.example.com/data" },
    });
    expect(result.status).toBe(403);
  });
});

// ─── GitHub / Gist ───────────────────────────────────────────────

describe("GitHub / Gist 連携", () => {
  it("公開 Gist からプラグインを取り込める", async () => {
    network.use(
      http.get("https://api.github.com/gists/abc123", () =>
        HttpResponse.json({
          id: "abc123",
          html_url: "https://gist.github.com/u/abc123",
          description: "gist plugin",
          files: {
            "manifest.json": {
              filename: "manifest.json",
              content: JSON.stringify(manifest("gist-imported", { summary: "Gist から取り込んだプラグイン" })),
            },
            "plugin.js": { filename: "plugin.js", content: "register({});" },
          },
        }),
      ),
    );

    const dev = await seedAccount("user");
    const result = await call("/v1/plugins/import/gist", {
      method: "POST",
      cookie: dev.cookie,
      body: { gist: "https://gist.github.com/u/abc123" },
    });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    const imported = expectData<{ id: string; name: string; source: string }>(result);
    expect(imported.name).toBe("gist-imported");
    expect(imported.source).toBe("gist");

    const detail = await call(`/v1/plugins/${imported.id}`, { cookie: dev.cookie });
    const detailBody = expectData<PluginDetail>(detail);
    expect(detailBody.source).toBe("gist");
    expect(detailBody.sourceRef).toContain("abc123");
    expect(detailBody.status).toBe("draft");
  });

  it("Gist の manifest が不正なら 400", async () => {
    network.use(
      http.get("https://api.github.com/gists/bad123", () =>
        HttpResponse.json({
          id: "bad123",
          files: { "manifest.json": { filename: "manifest.json", content: "not json" } },
        }),
      ),
    );
    const dev = await seedAccount("user");
    const result = await call("/v1/plugins/import/gist", {
      method: "POST",
      cookie: dev.cookie,
      body: { gist: "bad123" },
    });
    expect(result.status).toBe(400);
  });

  it("webhook は署名検証し、一致するプラグインの更新を検知する", async () => {
    // 署名なし → 401
    const unsigned = await SELF.fetch("http://worker.test/v1/plugins/hooks/github", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ repository: { full_name: "o/r" } }),
    });
    expect(unsigned.status).toBe(401);

    const payload = JSON.stringify({
      repository: { full_name: "o/r" },
      ref: "refs/heads/main",
      commits: [{ id: "abc" }],
    });
    // ID_SALT での署名は受け付けない（役割分離 / M-5）
    const idSaltSignature = `sha256=${await hmacSha256Hex("test-salt", payload)}`;
    const idSaltSigned = await SELF.fetch("http://worker.test/v1/plugins/hooks/github", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-hub-signature-256": idSaltSignature,
      },
      body: payload,
    });
    expect(idSaltSigned.status).toBe(401);

    // 専用 secret（テストでは GITHUB_WEBHOOK_SECRET）での署名は通る
    const signature = `sha256=${await hmacSha256Hex("test-github-webhook-secret", payload)}`;
    const signed = await SELF.fetch("http://worker.test/v1/plugins/hooks/github", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
    expect(signed.status).toBe(200);
    const body = envelopeSchema.parse(await signed.json());
    expect(body.ok).toBe(true);
    const updated = z
      .looseObject({ updated: z.array(z.unknown()) })
      .safeParse(body.data);
    expect(updated.success).toBe(true);
  });

  it("GitHub 未連携でもサイト内レジストリは完結する（発行は連携エラー）", async () => {
    const dev = await seedAccount("user");
    const created = await createPlugin(dev.cookie, { name: "no-github" });
    await publish(dev.cookie, created.id, ["personal"]);

    // 検索・導入は GitHub なしで動く
    const search = await call("/v1/plugins?q=no-github");
    expect(expectData<{ items: unknown[] }>(search).items).toHaveLength(1);

    // Gist 発行は WP4 の連携状態に依存するため、成功しない場合は 4xx/5xx を返す
    const exportResult = await call(`/v1/plugins/${created.id}/export/gist`, {
      method: "POST",
      cookie: dev.cookie,
      body: { public: true },
    });
    expect([401, 403, 501, 502, 503]).toContain(exportResult.status);
  });
});