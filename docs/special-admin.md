# 特別管理人（矢野さとる専用）招待・就任手順

サイト所有者（owner）が発行する**一回限りの就任キー**で、特別管理人（`special_admin`）を迎え入れる手順です。
本人確認と DM 送付は**運営者の手動運用**で、システムはキー発行と就任フォームのみを提供します（DESIGN §5.3）。

- 実装: `apps/api/src/routes/invites.ts` / `services/account/invite.ts` / `services/account/special-admin.ts`
- スキーマ: `packages/shared/src/schemas/admin.ts` / `auth.ts`
- 画面: `/admin/invites`（owner）、`/admin/invites/accept?key=...`（本人）

> **前提**: owner アカウントが作成済みであること。初回は `OWNER_BOOTSTRAP_KEY` を使った
> `POST /v1/admin/owner/setup`（一度だけ）で作成します。owner は TOTP を登録済みである必要があります。

## 1. 全体フロー

```text
owner: 招待キー発行（TOTP step-up 必須）
  → 生キーを一度だけ受領（DB には SHA-256 ハッシュのみ保存）
  → 運営者が本人確認・DM でキーを送付（システム外）
本人: /admin/invites/accept?key=... を開く
  → キー確認（inspect）
  → TOTP secret 発行（prepare-totp）→ QR を認証アプリで読み取り
  → 表示名・メール・パスワード・TOTP コードを送信（accept）
  → アカウント作成 + role=special_admin + リカバリーコード 10 個
  → 専用ダッシュボードへ
```

- 就任完了まで `accounts` に `special_admin` は作られません。**管理人一覧・ダッシュボードに一切表示されません**
- キーは既定 **72 時間**有効（`INVITE_TTL_HOURS`、最大 720 時間）、**1 回使用**
- 発行・失効・就任・停止・復旧はすべて `audit_log` に記録されます

## 2. owner: 招待キーを発行する

高リスク操作のため、直前 5 分以内の TOTP 再認証（step-up）が必要です。

### 2.1 step-up

```sh
curl -X POST https://<api-domain>/v1/auth/step-up \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -b 'oc_sess=<owner-session>' \
  -d '{"code":"123456"}'
```

成功すると `verifiedUntil`（Unix 秒）が返り、5 分間だけ高リスク操作が可能になります。
TOTP を忘れた場合はリカバリーコードを `code` に指定できます（単回使用）。

### 2.2 発行

```sh
curl -X POST https://<api-domain>/v1/admin/invites \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -b 'oc_sess=<owner-session>' \
  -d '{
    "kind": "special_admin",
    "expiresInHours": 72,
    "note": "特別管理人（本人確認済み・DM 送付）"
  }'
```

レスポンス（`201`）:

```json
{
  "ok": true,
  "data": {
    "id": "01J...",
    "key": "oc_inv_...",
    "kind": "special_admin",
    "expiresAt": 1760000000,
    "acceptPath": "/admin/invites/accept?key=oc_inv_..."
  }
}
```

- **`key` はこのレスポンスでしか表示されません**。安全な経路で本人へ送付してください
- `note` は運営メモ（本人には表示されません）
- 既存アカウントの復旧（TOTP リセット後など）は `accountId` を指定して再招待します

### 2.3 一覧・失効

```sh
# 一覧（pending / used / expired / revoked）
curl https://<api-domain>/v1/admin/invites -b 'oc_sess=<owner-session>'

# 失効
curl -X POST https://<api-domain>/v1/admin/invites/<id>/revoke \
  -H 'Origin: https://<web-domain>' -b 'oc_sess=<owner-session>'
```

## 3. 本人: 就任フォーム

### 3.1 キーの確認（未認証で可）

```sh
curl 'https://<api-domain>/v1/admin/invites/inspect?key=oc_inv_...'
```

`valid: true` なら続行。`reason` に使用済み・失効・期限切れの理由が入ります。
再招待の場合は `accountName` / `email` がプリフィル用に返ります。

### 3.2 TOTP secret の発行

```sh
curl -X POST https://<api-domain>/v1/admin/invites/prepare-totp \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -d '{"key":"oc_inv_..."}'
```

レスポンス:

```json
{
  "ok": true,
  "data": {
    "secret": "JBSWY3DPEHPK3PXP...",
    "otpauthUri": "otpauth://totp/OpenClone:...?secret=...&period=30&digits=6&issuer=OpenClone"
  }
}
```

- `otpauthUri` を QR コードにして認証アプリで読み取ります
- secret はこの時点では DB に保存されません（accept 時に検証して暗号化保存）

### 3.3 就任（accept）

```sh
curl -X POST https://<api-domain>/v1/admin/invites/accept \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -d '{
    "key": "oc_inv_...",
    "name": "表示名",
    "email": "person@example.com",
    "password": "十分に長いパスワード",
    "totpSecret": "JBSWY3DPEHPK3PXP...",
    "totpCode": "123456"
  }'
```

成功（`201`）:

```json
{
  "ok": true,
  "data": {
    "account": { "id": "01J...", "name": "表示名", "role": "special_admin", "status": "active" },
    "expiresAt": 1760000000,
    "recoveryCodes": ["ABCD12-EFGH34-...", "..."],
    "boardAssignment": null
  }
}
```

- **リカバリーコード 10 個はこのレスポンスでしか表示されません**。印刷・安全な保管を案内してください
- パスワードは PBKDF2-SHA256 100,000 iter で保存
- TOTP は RFC 6238（6 桁 / 30 秒 / SHA-1、±1 窓）。5 回失敗で 15 分ロック
- セッション Cookie `oc_sess` が発行され、そのままログイン状態になります

## 4. 就任後の権限

特別管理人は**全板横断**で以下を行えます（DESIGN §5.4）。

- 板の管理・規制・板スタッフ任免
- プラグインのサイト公開審査・停止
- AI 管理者の承認・停止、high 操作の承認
- 監査ログの閲覧
- サイト設定の一部（提案・条件付き）

**できないこと（owner の最終権限）**:

- 特別管理人招待キーの発行（owner のみ）
- owner の停止・権限変更
- サイト設定の最終決定（owner のみ）
- インフラ秘密情報の閲覧（Wrangler secrets / Cloudflare ダッシュボードは UI 外）

## 5. 復旧・停止

| 状況 | 手順 |
|---|---|
| TOTP を失った | リカバリーコードでログイン / step-up。残数は `/v1/auth/session` の `totp.recoveryRemaining` |
| リカバリーコード枯渇 | owner が `accountId` 指定で再招待 → 本人が TOTP を再登録 |
| アカウント侵害の疑い | owner が `POST /v1/admin/special-admins/:id/stop`（step-up 必須）→ 全管理 API を拒否 |
| 復旧 | owner が `POST /v1/admin/special-admins/:id/restore` |
| TOTP リセット | owner が `POST /v1/admin/special-admins/:id/totp-reset` → 再招待で再登録 |

- 停止・復旧・リセットはすべて監査ログに記録されます
- 停止中も一般ユーザーとしての閲覧・投稿は可能です（管理権限のみ停止）

## 6. セキュリティ上の注意

1. 招待キーは**一度きり**。発行後は画面を閉じると再表示できません
2. キーは DM 等の安全な経路で送付し、公開チャンネルに貼らない
3. 本人確認は運営者が手動で行う（システムは本人確認を代替しない）
4. リカバリーコードは単回使用。使用後は残数を確認し、必要なら再生成
5. owner の `OWNER_BOOTSTRAP_KEY` は初回セットアップ後はローテーションする
6. 特別管理人にもサーバ秘密情報・インフラ管理権限は渡さない（設計上の保証）

## 7. トラブルシューティング

| エラー | 意味 / 対処 |
|---|---|
| `403 STEP_UP_REQUIRED` | TOTP 再認証が必要。`/v1/auth/step-up` を実行 |
| `400 INVITE_INVALID` | キーが無効・使用済み・期限切れ・失効 |
| `400 TOTP_INVALID` | TOTP コード不一致。時刻ずれ・コード再利用を確認 |
| `429 TOTP_LOCKED` | 5 回失敗で 15 分ロック。待機またはリカバリーコード |
| `409 CONFLICT` | メールアドレスが既に登録済み。復旧は owner の再招待 |
| `403 FORBIDDEN` | owner 以外が招待 API を呼んだ |