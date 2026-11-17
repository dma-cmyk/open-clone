// ログイン・新規登録時の端末の引き継ぎ（報告 40 設計・R42-04 / R44-01 / レビュー 63 M1）。
// 同じ端末（device_hash）でアカウント認証が成立したとき、次の 2 つをアカウントへ移す:
// 1. その端末が所有するプラグイン（owner_device_hash = 端末）の所有者
// 2. その端末が入れた個人用導入（scope=personal, scope_ref=device:<hash>）すべて
//
// 2 は所有者を問わない。他人の公開プラグインをログイン前に個人導入した場合も、
// ログイン後にアカウントの導入として見えるようにするため（レビュー 63 M1）。
//
// R44-01: 導入の移動対象を「今回引き継いだプラグイン ID」だけに限定する。
// 以前の実装は「owner_account_id = account AND owner_device_hash IS NULL」という
// 副問い合わせで絞っていたが、これはアカウントが最初から所有していた既存
// プラグインも含んでしまう。既存のプラグイン P がアカウントと匿名端末の両方で
// 導入済み（UNIQUE 制約で同じ (plugin, personal, account) は 1 行）の場合、
// P の device: 導入を account に書き換えようとして衝突し、新しく引き継いだ
// Q の導入も移せなくなる。
//
// 手順（1 つのバッチ = 1 トランザクションで実行する）:
// 1. 端末所有のプラグイン ID と、端末が入れた個人用導入のプラグイン ID を先に取得する
// 2. 端末所有プラグインの所有者を account へ移す
// 3. 対象プラグインの device: 個人用導入を account へ移す
//    - アカウント側に同じプラグインの個人導入が既にあれば移さない（アカウント側を優先）
//    - 端末所有のまま残っている（同時ログインに負けた）プラグインの導入も移さない
//    - version / config_json / enabled / pinned は変えない
//
// 公式（両方 NULL）のプラグインの所有権は対象外。owner_account_id が既にあるものも対象外。

import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "shared";

/** 引き継いだプラグインの件数（監査ログ用）。失敗しても認証は止めない。 */
export async function transferDeviceOwnedPlugins(
  db: D1Database,
  deviceHash: string,
  accountId: string,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const deviceRef = `device:${deviceHash}`;

  // R44-01: まず今回引き継ぐプラグイン ID を取得する。
  // owner_account_id IS NULL（まだ誰のものでもない）かつ owner_device_hash = 端末。
  const toTransfer = await db
    .prepare("SELECT id FROM plugins WHERE owner_device_hash = ? AND owner_account_id IS NULL")
    .bind(deviceHash)
    .all<{ id: string }>();
  const ownedIds = (toTransfer.results ?? []).map((row) => row.id);

  // M1: 所有者を問わず、この端末が入れた個人用導入も引き継ぐ。
  // installed_by が端末と一致する行だけ（帰属不明の NULL や他者の導入は触らない。R46-02）。
  const deviceInstalls = await db
    .prepare(
      "SELECT plugin_id FROM plugin_installs WHERE scope = 'personal' AND scope_ref = ? AND installed_by = ?",
    )
    .bind(deviceRef, deviceRef)
    .all<{ plugin_id: string }>();
  const installPluginIds = [...new Set((deviceInstalls.results ?? []).map((row) => row.plugin_id))];

  const transferred = ownedIds.length;
  if (transferred === 0 && installPluginIds.length === 0) return 0;

  // 所有者と導入の移動を 1 つのバッチ（= 1 トランザクション）で実行する。
  // R46-01: 上の SELECT はバッチの外なので、その後に同じ端末の別ログインが先に引き継いでいる
  // ことがある。所有者の UPDATE で「まだ端末所有で、アカウント所有でない」を再確認し、
  // 導入の UPDATE は「この時点で端末所有でない」プラグインだけに限る。
  // これで後発の引き継ぎは何も変えず、所有者と導入記録が食い違わない。
  const statements: D1PreparedStatement[] = [];
  if (ownedIds.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE plugins
           SET owner_account_id = ?, owner_device_hash = NULL, updated_at = ?
           WHERE id IN (${ownedIds.map(() => "?").join(",")})
             AND owner_device_hash = ?
             AND owner_account_id IS NULL`,
        )
        .bind(accountId, now, ...ownedIds, deviceHash),
    );
  }

  for (const pluginId of installPluginIds) {
    // 各プラグインの、この端末自身が入れた個人用導入だけを account へ移す。
    // R46-02: installed_by が端末と一致しない導入（帰属不明の NULL や他者）は書き換えない。
    // scope_ref の書き換えは UNIQUE (plugin_id, 'personal', account) との衝突を
    // 回避するため、既存の account 導入が無い場合だけ行う（NOT EXISTS）。
    // 端末所有のまま残っているプラグイン（同時ログインで先を越された）は移さない。
    statements.push(
      db
        .prepare(
          `UPDATE plugin_installs
           SET scope_ref = ?, installed_by = ?, updated_at = ?
           WHERE plugin_id = ?
             AND scope = 'personal'
             AND scope_ref = ?
             AND installed_by = ?
             AND NOT EXISTS (SELECT 1 FROM plugins WHERE id = ? AND owner_device_hash = ?)
             AND NOT EXISTS (
               SELECT 1 FROM plugin_installs
               WHERE plugin_id = ? AND scope = 'personal' AND scope_ref = ?
             )`,
        )
        .bind(accountId, accountId, now, pluginId, deviceRef, deviceRef, pluginId, deviceHash, pluginId, accountId),
    );
  }

  // audit_log の記録も同バッチに含める（途中で失敗すれば全体がロールバックされる）。
  // 実際に移った件数はバッチ後にしか分からないため、ここでは候補の件数を記録する。
  statements.push(
    db
      .prepare(
        "INSERT INTO audit_log (id, actor_type, actor_id, action, target, detail, created_at) VALUES (?, 'account', ?, 'plugin.device.transfer', ?, ?, ?)",
      )
      .bind(
        ulid(),
        accountId,
        "device-own-plugins",
        JSON.stringify({ candidates: transferred, installs: installPluginIds.length, deviceHash }),
        now,
      ),
  );

  const results = await db.batch(statements);
  // 先頭は所有権の UPDATE（無い場合は導入の UPDATE）。従来どおり所有者の移行件数を返す。
  return ownedIds.length > 0 ? (results[0]?.meta.changes ?? 0) : 0;
}
