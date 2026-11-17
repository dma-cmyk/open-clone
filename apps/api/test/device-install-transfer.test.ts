// ログイン時の個人導入の引き継ぎ（レビュー 63 M1）の単体テスト。
//
// 端末（device:<hash>）が入れた個人用導入は、所有者を問わずアカウントへ移す。
// - 他人の公開プラグインをログイン前に個人導入しても、ログイン後に見える
// - アカウント側に既に同じプラグインの個人導入があれば重複させない（アカウント側を優先）
// - 他端末の導入・帰属不明（installed_by 不一致）の導入は触らない
// - 端末所有プラグインの所有者と導入は従来どおり引き継ぐ

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { transferDeviceOwnedPlugins } from "../src/services/plugins/device-transfer";

const DEVICE_HASH = "aa".repeat(32);
const OTHER_DEVICE_HASH = "bb".repeat(32);
const DEVICE_REF = `device:${DEVICE_HASH}`;
const OTHER_DEVICE_REF = `device:${OTHER_DEVICE_HASH}`;
const ACCOUNT = "01TRANSFERACCOUNT0000000000A";
const OTHER_ACCOUNT = "01TRANSFERACCOUNT0000000000B";
const OWNER_ACCOUNT = "01PUBLICPLUGINOWNER000000000";

const MANIFEST = JSON.stringify({
  name: "public-dice",
  version: "1.0.0",
  summary: "公開サイコロ",
  scope: ["personal", "board", "site"],
  permissions: ["ui:slot"],
  connectAllowlist: [],
  entry: "plugin.js",
  slots: ["thread-post-footer"],
  hooks: [],
});

async function insertAccount(id: string, name: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, NULL, NULL, 'user', 'active', 0)",
  )
    .bind(id, name)
    .run();
}

async function insertPlugin(params: {
  id: string;
  name: string;
  ownerAccountId: string | null;
  ownerDeviceHash: string | null;
  status?: string;
  visibility?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO plugins (id, owner_account_id, owner_device_hash, name, summary, manifest_json, scopes, status, visibility, latest_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, 'personal,board,site', ?, ?, '1.0.0', 0, 0)`,
  )
    .bind(
      params.id,
      params.ownerAccountId,
      params.ownerDeviceHash,
      params.name,
      MANIFEST,
      params.status ?? "published",
      params.visibility ?? "public",
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO plugin_versions (plugin_id, version, code, code_hash, manifest_json, status, created_at)
     VALUES (?, '1.0.0', 'register({});', ?, ?, 'approved', 0)`,
  )
    .bind(params.id, "hash-" + params.id, MANIFEST)
    .run();
}

async function insertInstall(params: {
  id: string;
  pluginId: string;
  scopeRef: string;
  installedBy: string | null;
  version?: string;
  enabled?: number;
  config?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO plugin_installs (id, plugin_id, scope, scope_ref, version, pinned, enabled, config_json, installed_by, created_at, updated_at)
     VALUES (?, ?, 'personal', ?, ?, 0, ?, ?, ?, 0, 0)`,
  )
    .bind(
      params.id,
      params.pluginId,
      params.scopeRef,
      params.version ?? "1.0.0",
      params.enabled ?? 1,
      params.config ?? null,
      params.installedBy,
    )
    .run();
}

async function installRow(id: string) {
  return env.DB.prepare(
    "SELECT plugin_id, scope, scope_ref, version, enabled, config_json, installed_by FROM plugin_installs WHERE id = ?",
  )
    .bind(id)
    .first<{
      plugin_id: string;
      scope: string;
      scope_ref: string;
      version: string;
      enabled: number;
      config_json: string | null;
      installed_by: string | null;
    }>();
}

beforeEach(async () => {
  await insertAccount(ACCOUNT, "引き継ぎ先");
  await insertAccount(OTHER_ACCOUNT, "別端末の持ち主");
  await insertAccount(OWNER_ACCOUNT, "公開プラグインの作者");
});

describe("端末の個人導入の引き継ぎ（M1）", () => {
  it("他人の公開プラグインの端末導入もアカウントへ移り、版・設定・enabled を保つ", async () => {
    await insertPlugin({
      id: "01PUBLICPLUGIN0000000000001",
      name: "public-dice-1",
      ownerAccountId: OWNER_ACCOUNT,
      ownerDeviceHash: null,
    });
    await insertInstall({
      id: "01INSTALLDEVICE00000000001",
      pluginId: "01PUBLICPLUGIN0000000000001",
      scopeRef: DEVICE_REF,
      installedBy: DEVICE_REF,
      version: "1.0.0",
      enabled: 0,
      config: JSON.stringify({ sides: 8 }),
    });

    // 端末所有プラグインは無い → 所有権の移行件数は 0 だが、導入は移る。
    const transferred = await transferDeviceOwnedPlugins(env.DB, DEVICE_HASH, ACCOUNT);
    expect(transferred).toBe(0);

    const row = await installRow("01INSTALLDEVICE00000000001");
    expect(row?.scope_ref).toBe(ACCOUNT);
    expect(row?.installed_by).toBe(ACCOUNT);
    expect(row?.version).toBe("1.0.0");
    expect(row?.enabled).toBe(0);
    expect(row?.config_json).toBe(JSON.stringify({ sides: 8 }));
  });

  it("アカウント側に同じプラグインの個人導入があれば重複させない（アカウント側を優先）", async () => {
    await insertPlugin({
      id: "01PUBLICPLUGIN0000000000002",
      name: "public-dice-2",
      ownerAccountId: OWNER_ACCOUNT,
      ownerDeviceHash: null,
    });
    await insertInstall({
      id: "01INSTALLACCOUNT00000000002",
      pluginId: "01PUBLICPLUGIN0000000000002",
      scopeRef: ACCOUNT,
      installedBy: ACCOUNT,
      config: JSON.stringify({ keep: true }),
    });
    await insertInstall({
      id: "01INSTALLDEVICE00000000002",
      pluginId: "01PUBLICPLUGIN0000000000002",
      scopeRef: DEVICE_REF,
      installedBy: DEVICE_REF,
    });

    await transferDeviceOwnedPlugins(env.DB, DEVICE_HASH, ACCOUNT);

    const accountRow = await installRow("01INSTALLACCOUNT00000000002");
    expect(accountRow?.config_json).toBe(JSON.stringify({ keep: true }));
    // 端末側の行は残る（UNIQUE 衝突を作らない）。効果はアカウント側の導入が優先。
    const deviceRow = await installRow("01INSTALLDEVICE00000000002");
    expect(deviceRow?.scope_ref).toBe(DEVICE_REF);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal'",
    )
      .bind("01PUBLICPLUGIN0000000000002")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("他端末の導入と、installed_by が端末と一致しない導入は動かない", async () => {
    await insertPlugin({
      id: "01PUBLICPLUGIN0000000000003",
      name: "public-dice-3",
      ownerAccountId: OWNER_ACCOUNT,
      ownerDeviceHash: null,
    });
    await insertInstall({
      id: "01INSTALLDEVICE00000000003",
      pluginId: "01PUBLICPLUGIN0000000000003",
      scopeRef: DEVICE_REF,
      installedBy: DEVICE_REF,
    });
    await insertInstall({
      id: "01INSTALLOTHERDEVICE00000003",
      pluginId: "01PUBLICPLUGIN0000000000003",
      scopeRef: OTHER_DEVICE_REF,
      installedBy: OTHER_DEVICE_REF,
    });
    await insertInstall({
      id: "01INSTALLUNKNOWN0000000003",
      pluginId: "01PUBLICPLUGIN0000000000003",
      scopeRef: OTHER_ACCOUNT,
      installedBy: null,
    });

    await transferDeviceOwnedPlugins(env.DB, DEVICE_HASH, ACCOUNT);

    // 自端末の導入だけが移る。
    expect((await installRow("01INSTALLDEVICE00000000003"))?.scope_ref).toBe(ACCOUNT);
    expect((await installRow("01INSTALLOTHERDEVICE00000003"))?.scope_ref).toBe(OTHER_DEVICE_REF);
    expect((await installRow("01INSTALLUNKNOWN0000000003"))?.installed_by).toBeNull();
  });

  it("端末所有プラグインの所有者と導入は従来どおり引き継ぐ（回帰）", async () => {
    await insertPlugin({
      id: "01DEVICEOWNEDPLUGIN000000004",
      name: "my-dice-4",
      ownerAccountId: null,
      ownerDeviceHash: DEVICE_HASH,
      status: "draft",
      visibility: "private",
    });
    await insertInstall({
      id: "01INSTALLDEVICE00000000004",
      pluginId: "01DEVICEOWNEDPLUGIN000000004",
      scopeRef: DEVICE_REF,
      installedBy: DEVICE_REF,
    });

    const transferred = await transferDeviceOwnedPlugins(env.DB, DEVICE_HASH, ACCOUNT);
    expect(transferred).toBe(1);

    const plugin = await env.DB.prepare("SELECT owner_account_id, owner_device_hash FROM plugins WHERE id = ?")
      .bind("01DEVICEOWNEDPLUGIN000000004")
      .first<{ owner_account_id: string | null; owner_device_hash: string | null }>();
    expect(plugin?.owner_account_id).toBe(ACCOUNT);
    expect(plugin?.owner_device_hash).toBeNull();
    expect((await installRow("01INSTALLDEVICE00000000004"))?.scope_ref).toBe(ACCOUNT);
  });
});