// 特別管理人就任と管理者権限の E2E。
// 所有者（seed の固定セッション）が一回限りの就任キーを発行し、就任フォーム（QR + TOTP + リカバリーコード）を
// ブラウザで完遂する。就任前は管理人として表示されず、所有者専用 API は叩けず、所有者の停止で操作が拒否される。

import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  ALLOWED_ORIGIN,
  WEB_BASE,
  apiUrl,
  readEnvelope,
  type ApiEnvelope,
  type ApiEnvelopeSuccess,
} from "../helpers/api";
import { fakeIp, unique } from "../helpers/ids";
import { stableTotpCode } from "./totp";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";
const OWNER_ACCOUNT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SEED_OWNER_STEP_UP =
  "seed 済み owner セッションに step-up がない（e2e/fixtures/seed.sql の session_stepup 行が必要）";

interface CallResult<T> {
  status: number;
  body: ApiEnvelope<T> | null;
}

async function callApi<T>(
  request: APIRequestContext,
  cookie: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<CallResult<T>> {
  const response = await request.fetch(apiUrl(path), {
    method,
    headers: {
      cookie,
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "x-real-ip": fakeIp(),
    },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), body: await readEnvelope<T>(response) };
}

function expectData<T>(result: CallResult<T>, label: string, status = 200): T {
  if (result.status !== status) {
    throw new Error(`${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  if (!result.body || !result.body.ok) {
    throw new Error(`${label}: envelope が成功ではありません ${JSON.stringify(result.body)}`);
  }
  return (result.body as ApiEnvelopeSuccess<T>).data;
}

test.describe("特別管理人就任フロー", () => {
  test("所有者が就任キー発行→就任（QR/TOTP/リカバリー）→専用ダッシュボード→所有者専用 API 拒否→停止→復旧", async ({
    browser,
    request,
  }, testInfo) => {
    const email = `${unique("special-admin").toLowerCase()}@example.com`;
    const password = "special-pass-1234";
    const ownerCall = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, data?: unknown) =>
      callApi<T>(request, OWNER_COOKIE, method, path, data);

    // --- 所有者の step-up（seed 行があれば不要。無ければ初回のみ TOTP を登録して続行） ---
    let ownerStepUpSecret: string | null = null;
    const ensureStepUp = async (): Promise<void> => {
      const probe = await ownerCall<{ id: string }>("POST", "/v1/admin/invites", {
        kind: "special_admin",
        note: "step-up probe",
      });
      if (probe.status === 201) {
        // probe で発行したキーは使わない。失効させる。
        const probeInvite = expectData(probe, "step-up probe", 201);
        await ownerCall("POST", `/v1/admin/invites/${probeInvite.id}/revoke`);
        return;
      }
      const code = probe.body && !probe.body.ok ? probe.body.code : null;
      if (probe.status !== 403 || code !== "STEP_UP_REQUIRED") {
        throw new Error(`招待発行の前提確認に失敗: HTTP ${probe.status} ${JSON.stringify(probe.body)}`);
      }
      if (testInfo.project.name !== "pc") {
        test.skip(true, `${SEED_OWNER_STEP_UP}。owner TOTP 登録は pc プロジェクトのみが行う`);
      }
      if (ownerStepUpSecret) {
        expectData(
          await ownerCall("POST", "/v1/auth/step-up", { code: await stableTotpCode(ownerStepUpSecret) }),
          "owner step-up",
        );
        return;
      }
      const setup = await ownerCall<{ secret: string }>("POST", "/v1/auth/totp/setup", {});
      if (setup.status === 409) {
        test.skip(true, `${SEED_OWNER_STEP_UP}（owner の TOTP は以前の実行で有効化済み）`);
      }
      const secret = expectData(setup, "owner TOTP setup").secret;
      expectData(await ownerCall("POST", "/v1/auth/totp/enable", { code: await stableTotpCode(secret) }), "owner TOTP enable");
      ownerStepUpSecret = secret;
      expectData(
        await ownerCall("POST", "/v1/auth/step-up", { code: await stableTotpCode(secret) }),
        "owner step-up",
      );
    };

    await ensureStepUp();

    // --- 就任キー発行（一回限り・ハッシュ保存） ---
    const invite = expectData(
      await ownerCall<{ id: string; key: string; acceptPath: string; expiresAt: number }>(
        "POST",
        "/v1/admin/invites",
        { kind: "special_admin", note: "E2E 特別管理人（DM 送付）" },
      ),
      "招待発行",
      201,
    );
    expect(invite.key).toMatch(/^oc_inv_/);
    expect(invite.acceptPath).toContain("/admin/invites/accept?key=");

    // 就任前はアカウントが作られず、管理人として一切表示されない
    const beforeAccept = expectData(
      await ownerCall<{ items: unknown[]; total: number }>(
        "GET",
        `/v1/admin/users?q=${encodeURIComponent(email)}`,
      ),
      "就任前ユーザー検索",
    );
    expect(beforeAccept.total).toBe(0);

    // --- 就任フォーム（未認証の新しいブラウザコンテキスト） ---
    const saContext = await browser.newContext({
      baseURL: WEB_BASE,
      extraHTTPHeaders: { "x-real-ip": fakeIp() },
    });
    const saPage = await saContext.newPage();
    await saPage.goto(invite.acceptPath);
    await expect(saPage.getByRole("heading", { name: "特別管理人 就任フォーム" })).toBeVisible();
    await expect(saPage.getByText("有効な就任キーです")).toBeVisible();

    await saPage.locator("#accept-name").fill(`特別管理人 E2E ${Date.now().toString(36)}`);
    await saPage.locator("#accept-email").fill(email);
    await saPage.locator("#accept-password").fill(password);
    await saPage.locator("#accept-password2").fill(password);

    await saPage.getByRole("button", { name: "TOTP の登録を開始（QR 表示）" }).click();
    await expect(saPage.getByAltText("TOTP 登録用 QR コード")).toBeVisible();
    const secretLocator = saPage.locator("code").filter({ hasText: /^[A-Z2-7]{16,64}$/ });
    await expect(secretLocator.first()).toBeVisible();
    const secret = (await secretLocator.first().textContent())?.trim() ?? "";
    expect(secret).toMatch(/^[A-Z2-7]{16,64}$/);

    await saPage.locator("#accept-totp").fill(await stableTotpCode(secret));
    await saPage.getByRole("button", { name: "就任する" }).click();

    await expect(saPage.getByText("就任が完了しました。")).toBeVisible();
    const recoveryCodes = saPage
      .locator("code")
      .filter({ hasText: /^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/ });
    await expect(recoveryCodes.first()).toBeVisible();
    expect(await recoveryCodes.count()).toBe(10);

    // --- 専用ダッシュボード（全板横断・AI 導線。所有者専用 nav は非表示） ---
    await saPage.getByRole("button", { name: "特別管理人ダッシュボードへ" }).click();
    await expect(saPage).toHaveURL(/\/admin$/);
    await expect(saPage.getByRole("heading", { name: "特別管理人ダッシュボード" })).toBeVisible();
    await expect(saPage.getByText("サイト設定の最終決定、特別管理人の任免")).toBeVisible();
    const navLinks = saPage.locator("nav[aria-label='管理メニュー'] a");
    await expect(navLinks.filter({ hasText: "AI 管理" }).first()).toBeVisible();
    await expect(navLinks.filter({ hasText: "AI 承認キュー" }).first()).toBeVisible();
    await expect(navLinks.filter({ hasText: "プラグイン管理" }).first()).toBeVisible();
    await expect(navLinks.filter({ hasText: "招待管理" })).toHaveCount(0);
    await expect(navLinks.filter({ hasText: "特別管理人" })).toHaveCount(0);

    // --- 所有者専用 API は 403（サーバ側で強制） ---
    const cookies = await saContext.cookies();
    const saSession = cookies.find((cookie) => cookie.name === "oc_sess")?.value;
    expect(saSession, "就任セッション Cookie がありません").toBeTruthy();
    const saCookie = `oc_sess=${saSession}`;
    const saCall = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, data?: unknown) =>
      callApi<T>(request, saCookie, method, path, data);

    expect((await saCall("GET", "/v1/admin/users")).status).toBe(200);
    expect((await saCall("GET", "/v1/admin/invites")).status).toBe(403);
    expect((await saCall("GET", "/v1/admin/special-admins")).status).toBe(403);
    expect((await saCall("GET", `/v1/admin/users/${OWNER_ACCOUNT_ID}`)).status).toBe(403);
    expect((await saCall("PUT", "/v1/admin/site-config", { "site.name": "乗っ取り" })).status).toBe(403);
    expect((await saCall("GET", "/v1/admin/secrets")).status).toBe(404);

    // --- 所有者による権限停止 → 操作拒否・セッション失効 ---
    const users = expectData(
      await ownerCall<{ items: { id: string }[] }>("GET", `/v1/admin/users?q=${encodeURIComponent(email)}`),
      "就任ユーザー検索",
    );
    const saId = users.items[0]?.id;
    expect(saId, "就任したアカウントが見つかりません").toBeTruthy();

    expectData(
      await ownerCall("POST", `/v1/admin/special-admins/${saId}/stop`, { reason: "E2E: 権限の一時停止" }),
      "特別管理人停止",
    );

    expect((await saCall("GET", "/v1/admin/users")).status).toBe(401);
    await saPage.goto("/admin");
    await expect(saPage).toHaveURL(/\/account\/login/);

    // --- 所有者による復旧 → 再ログインで管理操作が再開 ---
    expectData(await ownerCall("POST", `/v1/admin/special-admins/${saId}/restore`), "特別管理人復旧");

    await saPage.goto("/account/login");
    await saPage.locator("#login-email").fill(email);
    await saPage.locator("#login-password").fill(password);
    await saPage.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(saPage.locator("#login-totp")).toBeVisible();
    await saPage.locator("#login-totp").fill(await stableTotpCode(secret));
    await saPage.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(saPage).toHaveURL(/\/account$/);

    await saPage.goto("/admin");
    await expect(saPage.getByRole("heading", { name: "特別管理人ダッシュボード" })).toBeVisible();

    // 使用済みの就任キーは再利用できない（単回使用）
    const reuseContext = await browser.newContext({
      baseURL: WEB_BASE,
      extraHTTPHeaders: { "x-real-ip": fakeIp() },
    });
    const reusePage = await reuseContext.newPage();
    await reusePage.goto(invite.acceptPath);
    await expect(reusePage.getByText("このキーは既に使用済みです")).toBeVisible();
    await reuseContext.close();
    await saContext.close();
  });
});